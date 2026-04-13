const express = require('express');
const supabase = require('../../supabase');
const authMiddleware = require('../../middleware/authMiddleware');

const {
  toLocalDateStr,
  formatPace,
  effectiveDistance,
  effectiveMovingTime,
  effectivePace,
  checkPremium,
  getDailyMessageCount,
  getWorkoutsContext,
  getMonthlySummaryContext,
  getUserGoals,
  getCurrentPlan,
  savePlanUpdate,
  getUserRecords,
  getUserProfile,
  getWeeklyVolumes,
  getRiegelPredictions,
  getRecentPaceStats
} = require('./context');

const {
  calculateVDOT,
  getVDOTFromRecords,
  getVDOTFromRecentWorkouts,
  estimateVDOT,
  QUALITY_TYPES,
  calculatePaceZones,
  getRunnerLevel,
  ensurePaceField,
  formatZonesForPrompt
} = require('./vdot');

const {
  getLangInstruction,
  formatGoalsForAI,
  formatRecordsForAI,
  formatProfileForAI,
  getAiPrefs,
  buildPersonalityBlock,
  buildChatSystemPrompt,
  processPlanUpdate
} = require('./prompts');

const {
  callDeepSeek,
  callDeepSeekWithTools,
  callDeepSeekStreamWithTools
} = require('./deepseek');

const router = express.Router();

const DAILY_MESSAGE_LIMIT = 15;

// GET /api/ai/chat/limit — check daily message limit
router.get('/chat/limit', authMiddleware, async (req, res) => {
  try {
    const isPremium = await checkPremium(req.user.id);
    if (isPremium) {
      return res.json({ limit: DAILY_MESSAGE_LIMIT, used: 0, remaining: DAILY_MESSAGE_LIMIT, isPremium: true });
    }
    const used = await getDailyMessageCount(req.user.id);
    res.json({ limit: DAILY_MESSAGE_LIMIT, used, remaining: Math.max(0, DAILY_MESSAGE_LIMIT - used), isPremium: false });
  } catch (err) {
    console.error('Limit check error:', err.message);
    res.status(500).json({ error: 'Failed to check limit' });
  }
});

// GET /api/ai/chat/history — get chat history
router.get('/chat/history', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('chat_messages')
      .select('id, role, content, created_at')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: true })
      .limit(100);

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch chat history' });
  }
});

// DELETE /api/ai/chat/history — clear chat history
router.delete('/chat/history', authMiddleware, async (req, res) => {
  try {
    await supabase
      .from('chat_messages')
      .delete()
      .eq('user_id', req.user.id);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear history' });
  }
});

// Helper: load chat context (history + workouts + goals + plan)
async function loadChatContext(userId, lang = 'ru') {
  const { data: chatHistoryData } = await supabase
    .from('chat_messages')
    .select('role, content')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .limit(20);

  const chatHistory = (chatHistoryData || []).map(m => ({
    role: m.role === 'ai' ? 'assistant' : 'user',
    content: m.content
  }));

  const [monthlySummary, goals, currentPlan, userProfile, records, weeklyVolumes, predictions] = await Promise.all([
    getMonthlySummaryContext(userId),
    getUserGoals(userId),
    getCurrentPlan(userId),
    getUserProfile(userId),
    getUserRecords(userId),
    getWeeklyVolumes(userId),
    getRiegelPredictions(userId)
  ]);

  // Calculate VDOT and pace zones for chat context (12-week window + decay fallback)
  const twelveWeeksAgo = new Date();
  twelveWeeksAgo.setDate(twelveWeeksAgo.getDate() - 84);
  const { data: recentWorkouts } = await supabase
    .from('workouts')
    .select('name, distance, moving_time, average_pace, date, type, manual_distance, manual_moving_time, is_suspicious')
    .eq('user_id', userId)
    .gte('date', twelveWeeksAgo.toISOString())
    .order('date', { ascending: false });

  const { data: allWorkouts } = await supabase
    .from('workouts')
    .select('name, distance, moving_time, average_pace, date, type, manual_distance, manual_moving_time, is_suspicious')
    .eq('user_id', userId)
    .order('date', { ascending: false });

  const estimate = estimateVDOT(recentWorkouts, allWorkouts);
  const currentVDOT = estimate.vdot;
  const paceZones = currentVDOT ? calculatePaceZones(currentVDOT) : null;

  let vdotSource = null;
  if (estimate.source === 'recent') vdotSource = 'workouts';
  else if (estimate.source === 'decay') vdotSource = 'decay';

  const paceZonesData = currentVDOT ? { vdot: currentVDOT, source: vdotSource, zones: paceZones } : null;

  const aiPrefs = getAiPrefs(userProfile);
  const systemPrompt = buildChatSystemPrompt(monthlySummary, goals, currentPlan, userProfile, records, lang, aiPrefs, weeklyVolumes, predictions, paceZonesData);

  return { chatHistory, systemPrompt, currentPlan };
}

// Helper: trim chat history to max 100 messages per user
async function trimChatHistory(userId) {
  const { count } = await supabase
    .from('chat_messages')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);

  if (count && count > 100) {
    // Get IDs of oldest messages to delete
    const toDelete = count - 100;
    const { data: oldMessages } = await supabase
      .from('chat_messages')
      .select('id')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .limit(toDelete);

    if (oldMessages && oldMessages.length > 0) {
      const ids = oldMessages.map(m => m.id);
      await supabase
        .from('chat_messages')
        .delete()
        .in('id', ids);
    }
  }
}

// POST /api/ai/chat — AI chat with tool use support
router.post('/chat', authMiddleware, async (req, res) => {
  try {
    const { message, lang } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Check daily limit (skip for premium users)
    const isPremium = await checkPremium(req.user.id);
    if (!isPremium) {
      const used = await getDailyMessageCount(req.user.id);
      if (used >= DAILY_MESSAGE_LIMIT) {
        return res.status(429).json({ error: 'Daily message limit reached', limit: DAILY_MESSAGE_LIMIT, used, remaining: 0 });
      }
    }

    const { chatHistory, systemPrompt, currentPlan } = await loadChatContext(req.user.id, lang || 'ru');
    const reply = await callDeepSeekWithTools(systemPrompt, message, req.user.id, 4000, chatHistory);
    const { textReply, planUpdated } = await processPlanUpdate(reply, req.user.id, currentPlan, savePlanUpdate);

    await supabase.from('chat_messages').insert([
      { user_id: req.user.id, role: 'user', content: message },
      { user_id: req.user.id, role: 'ai', content: textReply }
    ]);

    // Trim history to max 100 messages
    await trimChatHistory(req.user.id);

    res.json({ reply: textReply, planUpdated });
  } catch (err) {
    console.error('AI chat error:', err.response?.data || err.message);
    res.status(500).json({ error: 'AI request failed' });
  }
});

// POST /api/ai/chat/stream — SSE streaming AI chat with tool use
router.post('/chat/stream', authMiddleware, async (req, res) => {
  try {
    const { message, lang } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Check daily limit (skip for premium users)
    const isPremiumUser = await checkPremium(req.user.id);
    if (!isPremiumUser) {
      const used = await getDailyMessageCount(req.user.id);
      if (used >= DAILY_MESSAGE_LIMIT) {
        return res.status(429).json({ error: 'Daily message limit reached', limit: DAILY_MESSAGE_LIMIT, used, remaining: 0 });
      }
    }

    const { chatHistory, systemPrompt, currentPlan } = await loadChatContext(req.user.id, lang || 'ru');

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Use tool-aware streaming: tool call rounds are buffered, final response is streamed in real time
    const fullReply = await callDeepSeekStreamWithTools(systemPrompt, message, req.user.id, res, 4000, chatHistory);

    // Process plan updates (fullReply already streamed to client, client strips PLAN_UPDATE blocks)
    const { textReply, planUpdated } = await processPlanUpdate(fullReply, req.user.id, currentPlan, savePlanUpdate);

    // Save clean messages (without PLAN_UPDATE block) to history
    await supabase.from('chat_messages').insert([
      { user_id: req.user.id, role: 'user', content: message },
      { user_id: req.user.id, role: 'ai', content: textReply }
    ]);

    // Trim history to max 100 messages
    await trimChatHistory(req.user.id);

    // Send meta event and close
    res.write(`data: [DONE]\n\n`);
    res.write(`data: ${JSON.stringify({ meta: { planUpdated } })}\n\n`);
    res.end();
  } catch (err) {
    console.error('AI chat stream error:', err.response?.data || err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'AI request failed' });
    } else {
      res.write(`data: [DONE]\n\n`);
      res.write(`data: ${JSON.stringify({ meta: { planUpdated: false } })}\n\n`);
      res.end();
    }
  }
});

// POST /api/ai/analyze-workout — AI comment for a specific workout
router.post('/analyze-workout', authMiddleware, async (req, res) => {
  try {
    const { workoutId, lang } = req.body;

    const { data: workout } = await supabase
      .from('workouts')
      .select('*')
      .eq('id', workoutId)
      .eq('user_id', req.user.id)
      .single();

    if (!workout) {
      return res.status(404).json({ error: 'Workout not found' });
    }

    const [recentWorkouts, userProfile] = await Promise.all([
      getWorkoutsContext(req.user.id, 1),
      getUserProfile(req.user.id)
    ]);

    const useLang = lang || 'ru';
    const aiPrefs = getAiPrefs(userProfile);
    const personality = buildPersonalityBlock(aiPrefs, useLang);
    const analyzePrompts = {
      ru: {
        system: `${personality.intro} Проанализируй конкретную тренировку и дай краткий комментарий.`,
        context: 'Контекст — последние тренировки юзера',
        analyze: 'Проанализируй эту тренировку',
        name: 'Название', date: 'Дата', distance: 'Дистанция', time: 'Время', pace: 'Темп', hr: 'Пульс', type: 'Тип',
        km: 'км', min: 'мин', minKm: 'мин/км', max: 'макс', noData: 'нет данных',
        splitsKm: 'Сплиты по км', splits500: 'Сплиты по 500м'
      },
      uk: {
        system: `${personality.intro} Проаналізуй конкретне тренування і дай короткий коментар.`,
        context: 'Контекст — останні тренування юзера',
        analyze: 'Проаналізуй це тренування',
        name: 'Назва', date: 'Дата', distance: 'Дистанція', time: 'Час', pace: 'Темп', hr: 'Пульс', type: 'Тип',
        km: 'км', min: 'хв', minKm: 'хв/км', max: 'макс', noData: 'немає даних',
        splitsKm: 'Спліти по км', splits500: 'Спліти по 500м'
      },
      en: {
        system: `${personality.intro} Analyze this specific workout and give a brief comment.`,
        context: "Context — user's recent workouts",
        analyze: 'Analyze this workout',
        name: 'Name', date: 'Date', distance: 'Distance', time: 'Time', pace: 'Pace', hr: 'Heart rate', type: 'Type',
        km: 'km', min: 'min', minKm: 'min/km', max: 'max', noData: 'no data',
        splitsKm: 'Splits per km', splits500: '500m splits'
      }
    };
    const ap = analyzePrompts[useLang] || analyzePrompts.ru;

    const systemPrompt = `${ap.system} ${getLangInstruction(useLang)}

${ap.context}:
${JSON.stringify(recentWorkouts.slice(0, 10), null, 2)}`;

    const gpsAnomaly = !!workout.is_suspicious;
    const gpsNote = { ru: '⚠️ GPS-аномалия: сплиты ненадёжны, не анализируй их. Дистанция и время исправлены вручную.', uk: '⚠️ GPS-аномалія: спліти ненадійні, не аналізуй їх. Дистанцію та час виправлено вручну.', en: '⚠️ GPS anomaly: splits are unreliable, do not analyze them. Distance and time were manually corrected.' };

    const workoutInfo = `${ap.analyze}:
- ${ap.name}: ${workout.name}
- ${ap.date}: ${workout.date}
- ${ap.distance}: ${(effectiveDistance(workout) / 1000).toFixed(2)} ${ap.km}
- ${ap.time}: ${Math.floor(effectiveMovingTime(workout) / 60)} ${ap.min}
- ${ap.pace}: ${formatPace(effectivePace(workout))} ${ap.minKm}
- ${ap.hr}: ${workout.average_heartrate || ap.noData} (${ap.max}: ${workout.max_heartrate || ap.noData})
- ${ap.type}: ${workout.type}
${gpsAnomaly ? (gpsNote[useLang] || gpsNote.ru) : ''}
${!gpsAnomaly && workout.splits ? `- ${ap.splitsKm}: ${workout.splits}` : ''}
${!gpsAnomaly && workout.splits_500m ? `- ${ap.splits500}: ${workout.splits_500m}` : ''}`;

    const reply = await callDeepSeek(systemPrompt, workoutInfo);
    res.json({ analysis: reply });
  } catch (err) {
    console.error('Analyze workout error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Analysis failed' });
  }
});

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
    const dayNamesExample = dayNamesList[0]; // e.g. "Monday" or "Понедельник"

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
      // Try direct parse first
      plan = JSON.parse(reply);
    } catch {
      // Try to extract JSON from markdown code block
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
    const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, ...
    let daysUntilMonday;
    if (dayOfWeek === 1) {
      daysUntilMonday = 0; // today is Monday — plan for this week
    } else if (dayOfWeek === 0) {
      daysUntilMonday = 1; // Sunday — next Monday
    } else {
      daysUntilMonday = 8 - dayOfWeek; // Tue-Sat — next Monday
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
      // If upsert fails, try insert
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

// GET /api/ai/pace-zones — calculate VDOT and pace zones for user
router.get('/pace-zones', authMiddleware, async (req, res) => {
  try {
    const records = await getUserRecords(req.user.id);

    // Get last 12 weeks of workouts (for estimateVDOT primary window)
    const twelveWeeksAgo = new Date();
    twelveWeeksAgo.setDate(twelveWeeksAgo.getDate() - 84);
    const { data: recentWorkouts } = await supabase
      .from('workouts')
      .select('name, distance, moving_time, average_pace, date, type, manual_distance, manual_moving_time, is_suspicious')
      .eq('user_id', req.user.id)
      .gte('date', twelveWeeksAgo.toISOString())
      .order('date', { ascending: false });

    // All workouts for fallback (last quality workout with decay)
    const { data: allWorkouts } = await supabase
      .from('workouts')
      .select('name, distance, moving_time, average_pace, date, type, manual_distance, manual_moving_time, is_suspicious')
      .eq('user_id', req.user.id)
      .order('date', { ascending: false });

    // Calculate weeklyKm by active weeks (weeks that had at least 1 workout)
    const activeWeeks = new Set();
    for (const w of (recentWorkouts || [])) {
      if (w.date) {
        const d = new Date(w.date);
        // ISO week identifier: year + week number
        const jan1 = new Date(d.getFullYear(), 0, 1);
        const weekNum = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
        activeWeeks.add(`${d.getFullYear()}-W${weekNum}`);
      }
    }
    const totalKm12w = (recentWorkouts || []).reduce((s, w) => s + effectiveDistance(w) / 1000, 0);
    const weeklyKm = activeWeeks.size > 0 ? totalKm12w / activeWeeks.size : 0;

    // VDOT from records (for breakdown display)
    const distanceMap = { '1km': 1000, '3km': 3000, '5km': 5000, '10km': 10000, '21km': 21097, '42km': 42195 };
    const recordsBreakdown = (records || [])
      .filter(r => distanceMap[r.distance_type] && r.time_seconds)
      .map(r => {
        const vdot = calculateVDOT(r.time_seconds, distanceMap[r.distance_type]);
        return {
          distance: r.distance_type,
          time_seconds: r.time_seconds,
          date: r.record_date,
          vdot
        };
      })
      .filter(r => r.vdot);

    // Main VDOT estimation
    const estimate = estimateVDOT(recentWorkouts, allWorkouts);
    const currentVDOT = estimate.vdot;

    // Source label for UI
    let vdotSource = null;
    if (estimate.source === 'recent') vdotSource = 'workouts';
    else if (estimate.source === 'decay') vdotSource = 'decay';

    if (!currentVDOT) {
      return res.json({ vdot: null, zones: null, level: getRunnerLevel(weeklyKm) });
    }

    const zones = calculatePaceZones(currentVDOT);
    const level = getRunnerLevel(weeklyKm);
    const paceStats = getRecentPaceStats(recentWorkouts);

    const fmt = (sec) => {
      if (!sec) return null;
      const m = Math.floor(sec / 60);
      const s = Math.round(sec % 60);
      return `${m}:${s.toString().padStart(2, '0')}`;
    };

    res.json({
      vdot: currentVDOT,
      level,
      zones: {
        easy:       { from: fmt(zones.easyMin), to: fmt(zones.easyMax) },
        marathon:   { from: fmt(zones.easyMax), to: fmt(zones.marathon) },
        threshold:  { from: fmt(zones.marathon), to: fmt(zones.threshold) },
        interval:   { from: fmt(zones.threshold), to: fmt(zones.interval) },
        repetition: { from: fmt(zones.interval),  to: fmt(zones.repetition) }
      },
      details: {
        source: vdotSource,
        weeklyKm: Math.round(weeklyKm * 10) / 10,
        workoutsCount: (recentWorkouts || []).length,
        avgPace: fmt(paceStats.avgPace),
        bestPace: fmt(paceStats.bestPace),
        recordsBreakdown,
        sourceWorkout: estimate.sourceWorkout || null
      }
    });
  } catch (err) {
    console.error('Pace zones error:', err.message);
    res.status(500).json({ error: 'Failed to calculate pace zones' });
  }
});

// POST /api/ai/weekly-analysis — AI analysis of current week
router.post('/weekly-analysis', authMiddleware, async (req, res) => {
  try {
    const lang = req.body?.lang || 'ru';
    // Get workouts for current Mon-Sun week
    const now = new Date();
    const dayOfWeek = now.getDay();
    const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const monday = new Date(now);
    monday.setDate(monday.getDate() - daysFromMonday);
    monday.setHours(0, 0, 0, 0);

    const { data: weekData } = await supabase
      .from('workouts')
      .select('name, distance, moving_time, average_pace, average_heartrate, date, type, manual_distance, manual_moving_time, is_suspicious')
      .eq('user_id', req.user.id)
      .gte('date', monday.toISOString())
      .order('date', { ascending: false });

    const weekWorkouts = (weekData || []).map(w => ({
      date: w.date?.split('T')[0],
      name: w.name,
      distance_km: (effectiveDistance(w) / 1000).toFixed(2),
      pace: formatPace(effectivePace(w)),
      heartrate: w.average_heartrate || '—',
      type: w.type
    }));

    if (weekWorkouts.length === 0) {
      const emptyMsg = { ru: 'Пока нет тренировок для анализа. Начни бегать и я помогу тебе стать лучше! 🏃', uk: 'Поки немає тренувань для аналізу. Почни бігати і я допоможу тобі стати кращим! 🏃', en: 'No workouts to analyze yet. Start running and I\'ll help you get better! 🏃' };
      return res.json({ analysis: emptyMsg[lang] || emptyMsg.ru });
    }

    const userProfile = await getUserProfile(req.user.id);
    const aiPrefs = getAiPrefs(userProfile);
    const personality = buildPersonalityBlock(aiPrefs, lang);

    const weeklyPrompts = {
      ru: { system: `${personality.intro} Дай краткий анализ тренировочной недели. Будь конкретным, опирайся на данные.`, msg: 'Проанализируй мою неделю тренировок' },
      uk: { system: `${personality.intro} Дай короткий аналіз тренувального тижня. Будь конкретним, спирайся на дані.`, msg: 'Проаналізуй мій тиждень тренувань' },
      en: { system: `${personality.intro} Give a brief analysis of the training week. Be specific, use the data.`, msg: 'Analyze my training week' }
    };
    const wp = weeklyPrompts[lang] || weeklyPrompts.ru;

    const systemPrompt = `${wp.system} ${getLangInstruction(lang)}`;

    const message = `${wp.msg}:\n${JSON.stringify(weekWorkouts, null, 2)}`;

    const reply = await callDeepSeek(systemPrompt, message);
    res.json({ analysis: reply });
  } catch (err) {
    console.error('Weekly analysis error:', err.message);
    res.status(500).json({ error: 'Analysis failed' });
  }
});

module.exports = router;
