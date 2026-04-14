const express = require('express');
const supabase = require('../../supabase');
const authMiddleware = require('../../middleware/authMiddleware');

const {
  toLocalDateStr,
  formatPace,
  effectiveDistance,
  effectivePace,
  getUserGoals,
  getUserRecords,
  getUserProfile
} = require('./context');

const {
  estimateVDOT,
  calculatePaceZones,
  getRunnerLevel,
  getRecentPaceStats,
  ensurePaceField,
  formatZonesForPrompt
} = require('./vdot');

const {
  getLangInstruction,
  formatGoalsForAI,
  formatRecordsForAI,
  formatProfileForAI,
  getAiPrefs
} = require('./prompts');

const { callDeepSeek } = require('./deepseek');

const router = express.Router();

// POST /api/ai/generate-plan — generate weekly training plan
router.post('/generate-plan', authMiddleware, async (req, res) => {
  try {
    const lang = req.body?.lang || 'ru';
    // Find last workout to anchor the 4-week window
    const { data: lastWorkoutRow } = await supabase
      .from('workouts')
      .select('date')
      .eq('user_id', req.user.id)
      .order('date', { ascending: false })
      .limit(1);

    // Anchor = Monday after last workout (so last workout's week is fully included)
    let anchor;
    if (lastWorkoutRow && lastWorkoutRow.length > 0) {
      const lastDate = new Date(lastWorkoutRow[0].date);
      const dow = lastDate.getDay();
      const daysUntilNextMonday = dow === 0 ? 1 : 8 - dow;
      anchor = new Date(lastDate);
      anchor.setHours(0, 0, 0, 0);
      anchor.setDate(anchor.getDate() + daysUntilNextMonday);
    } else {
      anchor = new Date();
      anchor.setHours(0, 0, 0, 0);
    }

    const fourWeeksBeforeAnchor = new Date(anchor);
    fourWeeksBeforeAnchor.setDate(fourWeeksBeforeAnchor.getDate() - 28);

    const { data: recentWorkouts } = await supabase
      .from('workouts')
      .select('name, distance, moving_time, average_pace, average_heartrate, date, type, manual_distance, manual_moving_time, is_suspicious')
      .eq('user_id', req.user.id)
      .gte('date', fourWeeksBeforeAnchor.toISOString())
      .lt('date', anchor.toISOString())
      .order('date', { ascending: false });

    // All workouts for VDOT fallback (last quality workout with decay)
    const { data: allWorkouts } = await supabase
      .from('workouts')
      .select('name, distance, moving_time, average_pace, date, type, manual_distance, manual_moving_time, is_suspicious')
      .eq('user_id', req.user.id)
      .order('date', { ascending: false });

    // 12-week window for VDOT estimation
    const twelveWeeksBeforeAnchor = new Date(anchor);
    twelveWeeksBeforeAnchor.setDate(twelveWeeksBeforeAnchor.getDate() - 84);
    const recentWorkouts12w = (allWorkouts || []).filter(w => {
      const d = new Date(w.date);
      return d >= twelveWeeksBeforeAnchor && d < anchor;
    });

    const [goals, records, userProfile] = await Promise.all([
      getUserGoals(req.user.id),
      getUserRecords(req.user.id),
      getUserProfile(req.user.id)
    ]);

    // Calculate weekly distances from 4 calendar weeks (Mon-Sun) before anchor
    const weeklyDistances = [];
    for (let w = 0; w < 4; w++) {
      const weekEnd = new Date(anchor);
      weekEnd.setDate(weekEnd.getDate() - w * 7);
      const weekStart = new Date(weekEnd);
      weekStart.setDate(weekStart.getDate() - 7);
      const weekWorkouts = (recentWorkouts || []).filter(wr => {
        const d = new Date(wr.date);
        return d >= weekStart && d < weekEnd;
      });
      const totalKm = weekWorkouts.reduce((s, wr) => s + effectiveDistance(wr) / 1000, 0);
      weeklyDistances.push(Math.round(totalKm * 10) / 10);
    }
    const avgWeeklyKm = weeklyDistances.length > 0
      ? Math.round(weeklyDistances.reduce((a, b) => a + b, 0) / weeklyDistances.length * 10) / 10
      : 0;

    // Calculate VDOT and pace zones (12-week window + decay fallback)
    const estimate = estimateVDOT(recentWorkouts12w, allWorkouts);
    const currentVDOT = estimate.vdot;
    const paceZones = currentVDOT ? calculatePaceZones(currentVDOT) : null;
    const paceStats = getRecentPaceStats(recentWorkouts);
    const runnerLevel = getRunnerLevel(avgWeeklyKm);

    if (currentVDOT) {
      console.log(`[VDOT] User ${req.user.id}: VDOT=${currentVDOT} (${estimate.source}), level=${runnerLevel}, zones:`, paceZones);
    }

    const DAY_NAMES_I18N = {
      ru: ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'],
      uk: ['Понеділок', 'Вівторок', 'Середа', 'Четвер', "П'ятниця", 'Субота', 'Неділя'],
      en: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
    };
    const dayNamesList = DAY_NAMES_I18N[lang] || DAY_NAMES_I18N.ru;
    const dayNamesExample = dayNamesList[0];

    const genPlanPrompts = {
      ru: {
        system: `Ты персональный AI тренер по бегу. Сгенерируй план тренировок на следующую неделю (7 дней, начиная с понедельника).`,
        userGoals: 'ЦЕЛИ ПОЛЬЗОВАТЕЛЯ',
        userRecords: 'ЛИЧНЫЕ РЕКОРДЫ ПОЛЬЗОВАТЕЛЯ',
        recordsNote: 'Используй рекорды для расчёта тренировочных темпов и зон.',
        rules: `ПРАВИЛА ГЕНЕРАЦИИ ПЛАНА:\n1. Строй план ДЛЯ ТЕКУЩЕГО УРОВНЯ бегуна. Каждая неделя должна делать его чуть сильнее: немного больше объём, немного быстрее темп, немного длиннее длительная.\n2. ЦЕЛЬ — это МАЯК, направление движения, а НЕ задание на эту неделю. Цель влияет на ТИП тренировок (скоростные для PB, объёмные для дистанционных целей), но НЕ на потолок объёма или интенсивности.\n3. НЕ пытайся приблизить бегуна к цели за одну неделю. Прогресс должен быть плавным и безопасным.\n4. Если текущий уровень далёк от цели — это нормально. Просто строй грамотный план для текущей формы с правильным вектором развития.`,
        avgWeekly: (km, weeks) => {
          const lastWeek = weeks[0];
          const prevNonZero = weeks.find(w => w > 0) || 0;
          const base = lastWeek > 0 && lastWeek >= km * 0.3 ? lastWeek : Math.round(prevNonZero * 0.6 * 10) / 10;
          const maxPlan = Math.round(base * 1.15);
          const note = lastWeek === 0 || lastWeek < km * 0.3
            ? `\n⚠️ Последняя неделя была очень низкой (${lastWeek} км) — пропуск/отдых/болезнь. База для плана: 60% от последней нормальной недели = ${base} км. Мягкое возвращение.`
            : '';
          return `\nТЕКУЩИЙ УРОВЕНЬ БЕГУНА (ГЛАВНЫЙ ОРИЕНТИР ДЛЯ ПЛАНА):\nНедельные объёмы (от свежей к старой): ${weeks.join(', ')} км\nСредний: ${km} км, последняя неделя: ${lastWeek} км${note}\n\nЖЁСТКОЕ ПРАВИЛО ОБЪЁМА: суммарный километраж плана = база (${base} км) + максимум 10-15%. Это значит план НЕ БОЛЕЕ ${maxPlan} км.\nДаже если раньше были недели больше — ориентируйся на базу. Провалы в объёме (болезнь, отдых) сбрасывают форму.\nНИКОГДА не прыгай к объёму прошлых недель сразу — возвращайся постепенно.\n`;
        },
        methodology: `МЕТОДОЛОГИЯ ТРЕНИРОВОК (Seiler, Daniels, Pfitzinger, Lydiard):

ПОЛЯРИЗОВАННАЯ МОДЕЛЬ (80/20):
- ~80% недельного объёма в лёгких зонах (easy, recovery, long в Z2)
- ~20% в высокой интенсивности (interval, tempo, fartlek)
- Это доказанный принцип элитных бегунов (Кипчоге, Ингебригтсен, кенийская школа)

ТИПЫ ТРЕНИРОВОК:
- recovery: Восстановительный бег, очень лёгкий (Z1, <70% HRmax), короткий (3-6 км). Цель — активное восстановление.
- easy: Лёгкий бег (Z2, 65-75% HRmax), разговорный темп. Аэробная база — основа всего.
- long: Длительный бег (Z2 основа, допустимы вставки Z3 в конце). 25-30% недельного объёма, но не более. Обычно в выходные.
- tempo: Темповый бег (Z3-Z4, ~85-90% HRmax, лактатный порог). 20-40 минут непрерывно или 2-3 × 10-15 мин.
- interval: Интервалы (Z4-Z5, МПК). Развитие VO2max. Отрезки 400м-1600м, восстановление 50-90% от работы.
- fartlek: Переменный бег (Z2-Z4). "Игра со скоростью" — менее структурировано чем интервалы. Нейромышечная адаптация.
- strength: Силовая/ОФП (не беговая). Укрепление мышц, профилактика травм. НЕ ставить в день тяжёлой беговой.
- race: Контрольный старт / тест. Не чаще 1 раза в 2-3 недели. За день — rest или recovery. После — recovery.
- rest: Полный отдых. Минимум 1 день в неделю.

ПРАВИЛО ЧЕРЕДОВАНИЯ НАГРУЗКИ (Daniels):
- После тяжёлой тренировки (interval, tempo, race, fartlek) — ОБЯЗАТЕЛЬНО recovery или rest на следующий день.
- НИКОГДА 2 тяжёлые тренировки подряд.
- Ключевых тренировок (из interval, tempo, long, fartlek, race) — максимум 2-3 в неделю.

АДАПТАЦИЯ ПО УРОВНЮ БЕГУНА (определи по данным из Strava):
- Новичок (<20 км/нед): 3-4 тренировки, max 1 ключевая, 2-3 дня отдыха. Фокус на аэробной базе.
- Средний (20-50 км/нед): 4-5 тренировок, max 2 ключевых, 1-2 дня отдыха.
- Продвинутый (50+ км/нед): 5-6 тренировок, 2-3 ключевых, 1 день отдыха.

ОПРЕДЕЛЕНИЕ ФАЗЫ ПОДГОТОВКИ (по целям и данным):
- Base (нет ближних целей / начало подготовки): больше easy/long, минимум интенсива
- Build (4-8 недель до цели): добавляем tempo, interval
- Peak (2-4 недели до цели): максимум качества, снижение объёма
- Taper (последняя неделя перед стартом): -30-50% объёма, сохраняем интенсивность коротко
- Recovery (после соревнования): лёгкие, короткие

ОПРЕДЕЛЕНИЕ ТЕКУЩЕЙ ФОРМЫ (КРИТИЧЕСКИ ВАЖНО):
- Личные рекорды — это ИСТОРИЧЕСКИЕ данные, НЕ показатель текущей формы. Рекорд мог быть поставлен на пике формы месяцы/годы назад.
- ТЕКУЩУЮ форму определяй ТОЛЬКО по свежим тренировкам за последние 2-4 недели: средний темп, недельный объём, пульс.
- Если рекорд старый, а свежие тренировки показывают темп значительно медленнее — бери за основу СВЕЖИЕ данные, не рекорд.
- НИКОГДА не говори "ты бежал X в прошлом году, значит сейчас легко побьёшь Y". Опирайся на цифры и факты последних недель.
- Рекорды используй как ориентир потенциала, но НЕ как текущий уровень.

РАСЧЁТ ТЕМПОВ (VDOT-система Дэниелса):
${paceZones ? `РАССЧИТАННЫЕ ТЕМПОВЫЕ ЗОНЫ (VDOT = ${currentVDOT}):
- ${formatZonesForPrompt(paceZones)}
Используй эти зоны как основу для назначения темпов. Они рассчитаны по формуле Дэниелса-Гилберта на основе данных бегуна.` : `- Easy/Recovery: на 60-90 сек/км медленнее текущего среднего темпа на 5км
- Tempo: на 10-20 сек/км быстрее среднего темпа последних лёгких тренировок
- Interval (VO2max): темп 3км-5км или чуть быстрее
- Long run: как easy, допускается финиш в темповой зоне`}

ОЦЕНКА РЕАЛИСТИЧНОСТИ ЦЕЛЕЙ (КРИТИЧЕСКИ ВАЖНО):
- Тренированный бегун улучшается на ~1-3% в месяц при правильной подготовке.
- Новичок может прогрессировать быстрее (~3-5%) в первые месяцы.
- Сравни текущий рекорд пользователя с целевым временем и дедлайном.
- Если разрыв между текущим уровнем и целью >5% за оставшееся время — цель НЕРЕАЛИСТИЧНА.
- Примеры: с 1:39 до 1:30 полумарафон за 40 дней (~9% улучшение) — на грани/нереалистично; с 1:45 до 1:25 за 40 дней (~19%) — ТОЧНО нереалистично.
- При нереалистичной цели: СТРОЙ ПЛАН ПОД РЕАЛИСТИЧНУЮ промежуточную цель. НЕ увеличивай объём/интенсивность до опасного уровня ради невозможной цели.
- Формула безопасного недельного объёма: текущий средний + максимум 10-15%. НИКОГДА не прыгай с 30 км/нед на 70 км/нед ради цели — это путь к травме.
- Если цель на время (pb), рассчитай необходимый целевой темп и сравни с текущими возможностями. Если разрыв >10 сек/км — нужно больше времени.`,
        mathRules: `КРИТИЧЕСКИ ВАЖНО — МАТЕМАТИЧЕСКАЯ ТОЧНОСТЬ:\n- Если пишешь темп (мин/км) и время — проверь что дистанция = время / темп. Например: 20 мин в темпе 5:00/км = 4 км, НЕ 9 км.\n- Если пишешь дистанцию и темп — рассчитай ожидаемое время и укажи его.\n- distance_km должна точно соответствовать описанию. Если в описании "5 км легко + 3 км темпом", то distance_km = 8.\n- Всегда перепроверяй: дистанция × темп = время.`,
        jsonOnly: 'ВАЖНО: Ответ должен быть ТОЛЬКО валидным JSON массивом из 7 объектов, без markdown, без пояснений, без текста до или после JSON.',
        format: (day) => `Формат каждого дня:\n{\n  "day": "${day}",\n  "type": "recovery|easy|long|tempo|interval|fartlek|strength|race|rest",\n  "distance_km": число или 0 для отдыха/силовой,\n  "pace": "темп в формате m:ss (например 5:30) или null для отдыха/силовой",\n  "description": "краткое описание тренировки с ТОЧНЫМИ цифрами (темп, время, дистанция — всё должно быть математически согласовано)",\n  "badge": "🧘|🏃|🏔️|⚡|💨|🎯|💪|🏁|😴"\n}`,
        contextLabel: 'Тренировки за последние 4 недели',
        weeklyVolumes: 'Недельные объёмы (последние 4 недели)',
        km: 'км',
        generate: 'Сгенерируй план на следующую неделю, ориентируясь на цели пользователя и методологию выше.'
      },
      uk: {
        system: `Ти персональний AI тренер з бігу. Згенеруй план тренувань на наступний тиждень (7 днів, починаючи з понеділка).`,
        userGoals: 'ЦІЛІ КОРИСТУВАЧА',
        userRecords: 'ОСОБИСТІ РЕКОРДИ КОРИСТУВАЧА',
        recordsNote: 'Використовуй рекорди для розрахунку тренувальних темпів і зон.',
        rules: `ПРАВИЛА ГЕНЕРАЦІЇ ПЛАНУ:\n1. Будуй план ДЛЯ ПОТОЧНОГО РІВНЯ бігуна. Кожен тиждень має робити його трохи сильнішим: трохи більше об'єм, трохи швидший темп, трохи довша тривала.\n2. ЦІЛЬ — це МАЯК, напрямок руху, а НЕ завдання на цей тиждень. Ціль впливає на ТИП тренувань (швидкісні для PB, об'ємні для дистанційних цілей), але НЕ на стелю об'єму чи інтенсивності.\n3. НЕ намагайся наблизити бігуна до цілі за один тиждень. Прогрес має бути плавним і безпечним.\n4. Якщо поточний рівень далекий від цілі — це нормально. Просто будуй грамотний план для поточної форми з правильним вектором розвитку.`,
        avgWeekly: (km, weeks) => {
          const lastWeek = weeks[0];
          const prevNonZero = weeks.find(w => w > 0) || 0;
          const base = lastWeek > 0 && lastWeek >= km * 0.3 ? lastWeek : Math.round(prevNonZero * 0.6 * 10) / 10;
          const maxPlan = Math.round(base * 1.15);
          const note = lastWeek === 0 || lastWeek < km * 0.3
            ? `\n⚠️ Останній тиждень був дуже низьким (${lastWeek} км) — пропуск/відпочинок/хвороба. База для плану: 60% від останнього нормального тижня = ${base} км. М'яке повернення.`
            : '';
          return `\nПОТОЧНИЙ РІВЕНЬ БІГУНА (ГОЛОВНИЙ ОРІЄНТИР ДЛЯ ПЛАНУ):\nТижневі об'єми (від свіжого до старого): ${weeks.join(', ')} км\nСереднє: ${km} км, останній тиждень: ${lastWeek} км${note}\n\nЖОРСТКЕ ПРАВИЛО ОБ'ЄМУ: сумарний кілометраж плану = база (${base} км) + максимум 10-15%. Це означає план НЕ БІЛЬШЕ ${maxPlan} км.\nНавіть якщо раніше були тижні більше — орієнтуйся на базу. Провали в об'ємі (хвороба, відпочинок) скидають форму.\nНІКОЛИ не стрибай до об'єму минулих тижнів відразу — повертайся поступово.\n`;
        },
        methodology: `МЕТОДОЛОГІЯ ТРЕНУВАНЬ (Seiler, Daniels, Pfitzinger, Lydiard):

ПОЛЯРИЗОВАНА МОДЕЛЬ (80/20):
- ~80% тижневого об'єму в легких зонах (easy, recovery, long в Z2)
- ~20% у високій інтенсивності (interval, tempo, fartlek)
- Це доведений принцип елітних бігунів

ТИПИ ТРЕНУВАНЬ:
- recovery: Відновлювальний біг, дуже легкий (Z1, <70% HRmax), короткий (3-6 км).
- easy: Легкий біг (Z2, 65-75% HRmax), розмовний темп. Аеробна база.
- long: Тривалий біг (Z2 основа). 25-30% тижневого об'єму. Зазвичай у вихідні.
- tempo: Темповий біг (Z3-Z4, ~85-90% HRmax, лактатний поріг). 20-40 хв безперервно.
- interval: Інтервали (Z4-Z5, МПК). Розвиток VO2max. Відрізки 400м-1600м.
- fartlek: Змінний біг (Z2-Z4). "Гра зі швидкістю".
- strength: Силова/ЗФП (не бігова). Зміцнення м'язів, профілактика травм.
- race: Контрольний старт / тест. Не частіше 1 разу на 2-3 тижні.
- rest: Повний відпочинок. Мінімум 1 день на тиждень.

ПРАВИЛО ЧЕРГУВАННЯ НАВАНТАЖЕННЯ:
- Після важкого тренування (interval, tempo, race, fartlek) — ОБОВ'ЯЗКОВО recovery або rest наступного дня.
- НІКОЛИ 2 важкі тренування поспіль.
- Ключових тренувань (interval, tempo, long, fartlek, race) — максимум 2-3 на тиждень.

АДАПТАЦІЯ ЗА РІВНЕМ БІГУНА:
- Новачок (<20 км/тиж): 3-4 тренування, max 1 ключова, 2-3 дні відпочинку.
- Середній (20-50 км/тиж): 4-5 тренувань, max 2 ключових, 1-2 дні відпочинку.
- Просунутий (50+ км/тиж): 5-6 тренувань, 2-3 ключових, 1 день відпочинку.

ВИЗНАЧЕННЯ ФАЗИ ПІДГОТОВКИ:
- Base: більше easy/long, мінімум інтенсиву
- Build (4-8 тижнів до цілі): додаємо tempo, interval
- Peak (2-4 тижні до цілі): максимум якості, зниження об'єму
- Taper (останній тиждень перед стартом): -30-50% об'єму
- Recovery (після змагання): легкі, короткі

ВИЗНАЧЕННЯ ПОТОЧНОЇ ФОРМИ (КРИТИЧНО ВАЖЛИВО):
- Особисті рекорди — це ІСТОРИЧНІ дані, НЕ показник поточної форми. Рекорд міг бути поставлений на піку форми місяці/роки тому.
- ПОТОЧНУ форму визначай ТІЛЬКИ за свіжими тренуваннями за останні 2-4 тижні: середній темп, тижневий об'єм, пульс.
- Якщо рекорд старий, а свіжі тренування показують темп значно повільніший — бери за основу СВІЖІ дані, не рекорд.
- Рекорди використовуй як орієнтир потенціалу, але НЕ як поточний рівень.

РОЗРАХУНОК ТЕМПІВ (VDOT-система Деніелса):
${paceZones ? `РОЗРАХОВАНІ ТЕМПОВІ ЗОНИ (VDOT = ${currentVDOT}):
- ${formatZonesForPrompt(paceZones)}
Використовуй ці зони як основу для призначення темпів. Вони розраховані за формулою Деніелса-Гілберта на основі даних бігуна.` : `- Easy/Recovery: на 60-90 сек/км повільніше поточного середнього темпу на 5км
- Tempo: на 10-20 сек/км швидше середнього темпу останніх легких тренувань
- Interval (VO2max): темп 3км-5км або трохи швидше
- Long run: як easy`}

ОЦІНКА РЕАЛІСТИЧНОСТІ ЦІЛЕЙ (КРИТИЧНО ВАЖЛИВО):
- Тренований бігун покращується на ~1-3% на місяць при правильній підготовці.
- Новачок може прогресувати швидше (~3-5%) перші місяці.
- Порівняй поточний рекорд з цільовим часом та дедлайном.
- Якщо розрив між поточним рівнем і ціллю >5% за час що залишився — ціль НЕРЕАЛІСТИЧНА.
- При нереалістичній цілі: БУДУЙ ПЛАН ПІД РЕАЛІСТИЧНУ проміжну ціль. НЕ збільшуй об'єм/інтенсивність до небезпечного рівня заради неможливої цілі.
- Безпечний тижневий об'єм: поточний середній + максимум 10-15%. НІКОЛИ не стрибай з 30 км/тиж на 70 км/тиж — це шлях до травми.`,
        mathRules: `КРИТИЧНО ВАЖЛИВО — МАТЕМАТИЧНА ТОЧНІСТЬ:\n- Якщо пишеш темп (хв/км) і час — перевір що дистанція = час / темп. Наприклад: 20 хв у темпі 5:00/км = 4 км, НЕ 9 км.\n- Якщо пишеш дистанцію і темп — розрахуй очікуваний час і вкажи його.\n- distance_km має точно відповідати опису.\n- Завжди перевіряй: дистанція × темп = час.`,
        jsonOnly: 'ВАЖЛИВО: Відповідь має бути ТІЛЬКИ валідним JSON масивом з 7 об\'єктів, без markdown, без пояснень, без тексту до або після JSON.',
        format: (day) => `Формат кожного дня:\n{\n  "day": "${day}",\n  "type": "recovery|easy|long|tempo|interval|fartlek|strength|race|rest",\n  "distance_km": число або 0 для відпочинку/силової,\n  "pace": "темп у форматі m:ss (наприклад 5:30) або null для відпочинку/силової",\n  "description": "короткий опис тренування з ТОЧНИМИ цифрами",\n  "badge": "🧘|🏃|🏔️|⚡|💨|🎯|💪|🏁|😴"\n}`,
        contextLabel: 'Тренування за останні 4 тижні',
        weeklyVolumes: 'Тижневі об\'єми (останні 4 тижні)',
        km: 'км',
        generate: 'Згенеруй план на наступний тиждень, орієнтуючись на цілі користувача та методологію вище.'
      },
      en: {
        system: `You are a personal AI running coach. Generate a training plan for the next week (7 days, starting from Monday).`,
        userGoals: 'USER GOALS',
        userRecords: 'USER PERSONAL RECORDS',
        recordsNote: 'Use records to calculate training paces and zones.',
        rules: `PLAN GENERATION RULES:\n1. Build the plan FOR THE CURRENT LEVEL of the runner. Each week should make them slightly stronger: a bit more volume, a bit faster tempo, a bit longer long run.\n2. The GOAL is a BEACON, a direction of movement, NOT a task for this week. The goal influences the TYPE of workouts (speed work for PB goals, volume work for distance goals), but NOT the ceiling of volume or intensity.\n3. Do NOT try to bring the runner closer to the goal in one week. Progress must be smooth and safe.\n4. If the current level is far from the goal — that's fine. Just build a smart plan for current fitness with the right development direction.`,
        avgWeekly: (km, weeks) => {
          const lastWeek = weeks[0];
          const prevNonZero = weeks.find(w => w > 0) || 0;
          const base = lastWeek > 0 && lastWeek >= km * 0.3 ? lastWeek : Math.round(prevNonZero * 0.6 * 10) / 10;
          const maxPlan = Math.round(base * 1.15);
          const note = lastWeek === 0 || lastWeek < km * 0.3
            ? `\n⚠️ Last week was very low (${lastWeek} km) — skip/rest/illness. Plan base: 60% of last normal week = ${base} km. Soft return.`
            : '';
          return `\nCURRENT RUNNER LEVEL (PRIMARY REFERENCE FOR PLAN):\nWeekly volumes (newest to oldest): ${weeks.join(', ')} km\nAverage: ${km} km, last week: ${lastWeek} km${note}\n\nHARD VOLUME RULE: total plan mileage = base (${base} km) + max 10-15%. This means the plan must be NO MORE than ${maxPlan} km.\nEven if previous weeks had more volume — use the base as current fitness. Drops in volume (illness, rest) reset fitness.\nNEVER jump back to previous weeks' volume immediately — return gradually.\n`;
        },
        methodology: `TRAINING METHODOLOGY (Seiler, Daniels, Pfitzinger, Lydiard):

POLARIZED MODEL (80/20):
- ~80% of weekly volume in easy zones (easy, recovery, long in Z2)
- ~20% in high intensity (interval, tempo, fartlek)
- This is a proven principle used by elite runners (Kipchoge, Ingebrigtsen, Kenyan school)

WORKOUT TYPES:
- recovery: Recovery run, very easy (Z1, <70% HRmax), short (3-6 km). Active recovery.
- easy: Easy run (Z2, 65-75% HRmax), conversational pace. Aerobic base — foundation of everything.
- long: Long run (Z2 base, Z3 inserts allowed at end). 25-30% of weekly volume, max. Usually weekends.
- tempo: Tempo run (Z3-Z4, ~85-90% HRmax, lactate threshold). 20-40 min continuous or 2-3 × 10-15 min.
- interval: Intervals (Z4-Z5, VO2max). VO2max development. 400m-1600m reps, recovery 50-90% of work.
- fartlek: Variable pace run (Z2-Z4). "Speed play" — less structured than intervals. Neuromuscular adaptation.
- strength: Strength/GPP (non-running). Muscle strengthening, injury prevention. NOT on hard running days.
- race: Race / time trial. No more than once every 2-3 weeks. Day before — rest or recovery. After — recovery.
- rest: Complete rest. Minimum 1 day per week.

HARD/EASY ALTERNATION RULE (Daniels):
- After a hard workout (interval, tempo, race, fartlek) — MUST have recovery or rest the next day.
- NEVER 2 hard workouts back to back.
- Key workouts (from interval, tempo, long, fartlek, race) — maximum 2-3 per week.

ADAPTATION BY RUNNER LEVEL (determine from Strava data):
- Beginner (<20 km/week): 3-4 workouts, max 1 key, 2-3 rest days. Focus on aerobic base.
- Intermediate (20-50 km/week): 4-5 workouts, max 2 key, 1-2 rest days.
- Advanced (50+ km/week): 5-6 workouts, 2-3 key, 1 rest day.

TRAINING PHASE DETECTION (from goals and data):
- Base (no near goals / start of prep): more easy/long, minimal intensity
- Build (4-8 weeks to goal): add tempo, interval
- Peak (2-4 weeks to goal): max quality, reduce volume
- Taper (last week before race): -30-50% volume, keep short intensity
- Recovery (after competition): easy, short

CURRENT FITNESS ASSESSMENT (CRITICALLY IMPORTANT):
- Personal records are HISTORICAL data, NOT an indicator of current fitness. A record could have been set at peak form months/years ago.
- Assess CURRENT fitness ONLY from recent workouts over the last 2-4 weeks: average pace, weekly volume, heart rate.
- If record is old but recent workouts show significantly slower pace — use RECENT data as the basis, not the record.
- NEVER say "you ran X last year so you can easily run Y now". Base everything on recent numbers and facts.
- Use records as a guide to potential, NOT as current level.

PACE CALCULATION (Daniels VDOT system):
${paceZones ? `CALCULATED PACE ZONES (VDOT = ${currentVDOT}):
- ${formatZonesForPrompt(paceZones)}
Use these zones as the basis for assigning paces. They are calculated using the Daniels-Gilbert formula based on the runner's data.` : `- Easy/Recovery: 60-90 sec/km slower than current average 5k pace
- Tempo: 10-20 sec/km faster than recent easy run average pace
- Interval (VO2max): 3k-5k pace or slightly faster
- Long run: same as easy, finishing in tempo zone allowed`}

GOAL REALISM ASSESSMENT (CRITICALLY IMPORTANT):
- A trained runner improves ~1-3% per month with proper training.
- Beginners may progress faster (~3-5%) in the first months.
- Compare current PR with target time and deadline.
- If the gap between current level and goal is >5% for the remaining time — goal is UNREALISTIC.
- Examples: 1:39 to 1:30 half marathon in 40 days (~9% improvement) — borderline/unrealistic; 1:45 to 1:25 in 40 days (~19%) — DEFINITELY unrealistic.
- For unrealistic goals: BUILD THE PLAN FOR A REALISTIC intermediate goal. Do NOT increase volume/intensity to dangerous levels chasing an impossible goal.
- Safe weekly volume formula: current average + max 10-15%. NEVER jump from 30 km/week to 70 km/week for a goal — that's a path to injury.
- If goal is time-based (pb), calculate required target pace and compare with current ability. If gap >10 sec/km — more time is needed.`,
        mathRules: `CRITICALLY IMPORTANT — MATH ACCURACY:\n- If you write pace (min/km) and time — verify that distance = time / pace. For example: 20 min at 5:00/km = 4 km, NOT 9 km.\n- If you write distance and pace — calculate expected time and include it.\n- distance_km must exactly match the description.\n- Always double-check: distance × pace = time.`,
        jsonOnly: 'IMPORTANT: Response must be ONLY a valid JSON array of 7 objects, no markdown, no explanations, no text before or after JSON.',
        format: (day) => `Format for each day:\n{\n  "day": "${day}",\n  "type": "recovery|easy|long|tempo|interval|fartlek|strength|race|rest",\n  "distance_km": number or 0 for rest/strength,\n  "pace": "pace in m:ss format (e.g. 5:30) or null for rest/strength",\n  "description": "brief workout description with EXACT numbers (pace, time, distance — all mathematically consistent)",\n  "badge": "🧘|🏃|🏔️|⚡|💨|🎯|💪|🏁|😴"\n}`,
        contextLabel: 'Workouts for the last 4 weeks',
        weeklyVolumes: 'Weekly volumes (last 4 weeks)',
        km: 'km',
        generate: "Generate a plan for the next week, based on the user's goals and the methodology above."
      }
    };
    const gp = genPlanPrompts[lang] || genPlanPrompts.ru;

    const profileInfo = formatProfileForAI(userProfile || {}, lang);
    const systemPrompt = `${gp.system} ${getLangInstruction(lang)}

${profileInfo}

${gp.avgWeekly(avgWeeklyKm, weeklyDistances)}

${gp.methodology}

${gp.userGoals}:
${formatGoalsForAI(goals, lang)}

${gp.userRecords}:
${formatRecordsForAI(records, lang)}
${gp.recordsNote}

${gp.rules}

${gp.mathRules}

${gp.jsonOnly}

${gp.format(dayNamesExample)}`;

    const context = `${gp.contextLabel}:
${JSON.stringify((recentWorkouts || []).map(w => ({
  date: w.date?.split('T')[0],
  distance_km: (effectiveDistance(w) / 1000).toFixed(1),
  pace: formatPace(effectivePace(w)),
  type: w.type,
  heartrate: w.average_heartrate
})), null, 2)}

${gp.weeklyVolumes}: ${weeklyDistances.join(', ')} ${gp.km}

${gp.generate}`;

    const reply = await callDeepSeek(systemPrompt, context);

    // Try to parse JSON from response
    let plan;
    try {
      plan = JSON.parse(reply);
    } catch {
      const jsonMatch = reply.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        plan = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('Failed to parse plan JSON');
      }
    }

    // Ensure every day has a pace field (extract from description or use zone default)
    if (paceZones) {
      plan = ensurePaceField(plan, paceZones);
    }

    // Calculate week start (current Monday if today is Mon, otherwise next Monday)
    const now = new Date();
    const dayOfWeek = now.getDay();
    let daysUntilMonday;
    if (dayOfWeek === 1) {
      daysUntilMonday = 0;
    } else if (dayOfWeek === 0) {
      daysUntilMonday = 1;
    } else {
      daysUntilMonday = 8 - dayOfWeek;
    }
    const targetMonday = new Date(now);
    targetMonday.setDate(now.getDate() + daysUntilMonday);
    targetMonday.setHours(0, 0, 0, 0);

    // Save plan
    const { data: savedPlan, error } = await supabase
      .from('plans')
      .upsert({
        user_id: req.user.id,
        week_start: toLocalDateStr(targetMonday),
        workouts: JSON.stringify(plan)
      }, {
        onConflict: 'user_id,week_start'
      })
      .select()
      .single();

    if (error) {
      const { data: insertedPlan, error: insertError } = await supabase
        .from('plans')
        .insert({
          user_id: req.user.id,
          week_start: toLocalDateStr(targetMonday),
          workouts: JSON.stringify(plan)
        })
        .select()
        .single();

      if (insertError) throw insertError;
      return res.json({ plan: insertedPlan });
    }

    res.json({ plan: savedPlan });
  } catch (err) {
    console.error('Generate plan error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to generate plan' });
  }
});

// GET /api/ai/plan — get current plan
router.get('/plan', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('plans')
      .select('*')
      .eq('user_id', req.user.id)
      .order('week_start', { ascending: false })
      .limit(1)
      .single();

    if (error || !data) {
      return res.json({ plan: null });
    }

    res.json({ plan: data });
  } catch (err) {
    res.json({ plan: null });
  }
});

module.exports = router;
