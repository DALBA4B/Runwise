// ============================================================
// VDOT Calculator — Daniels-Gilbert Running Formula
// Расчёт VDOT и тренировочных темповых зон
// ============================================================

const { formatPace, effectivePace, effectiveDistance, effectiveMovingTime } = require('./context');

// ---------- Формулы Дэниелса-Гилберта ----------

// Расчёт потребления O2 по скорости (м/мин)
function velocityToVO2(velocity) {
  return -4.60 + 0.182258 * velocity + 0.000104 * velocity * velocity;
}

// Процент VO2max по времени бега (минуты)
function timeToPctVO2max(timeMinutes) {
  return 0.8
    + 0.1894393 * Math.exp(-0.012778 * timeMinutes)
    + 0.2989558 * Math.exp(-0.1932605 * timeMinutes);
}

// Скорость (м/мин) из целевого VO2
function vo2ToVelocity(vo2) {
  // Квадратное уравнение: 0.000104*v^2 + 0.182258*v + (-4.60 - vo2) = 0
  const a = 0.000104;
  const b = 0.182258;
  const c = -4.60 - vo2;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;
  return (-b + Math.sqrt(discriminant)) / (2 * a);
}

// ---------- Основные функции ----------

/**
 * Рассчитать VDOT по результату забега
 * @param {number} timeSeconds — время в секундах
 * @param {number} distanceMeters — дистанция в метрах
 * @returns {number|null} VDOT или null если данные некорректны
 */
function calculateVDOT(timeSeconds, distanceMeters) {
  if (!timeSeconds || !distanceMeters || timeSeconds <= 0 || distanceMeters <= 0) return null;

  const timeMinutes = timeSeconds / 60;
  const velocity = distanceMeters / timeMinutes; // м/мин

  // Формула работает для дистанций ~800м - 42км (3.5 - 240 мин)
  if (timeMinutes < 3.5 || timeMinutes > 240) return null;

  const vo2 = velocityToVO2(velocity);
  const pctMax = timeToPctVO2max(timeMinutes);

  if (pctMax <= 0) return null;

  const vdot = vo2 / pctMax;
  return Math.round(vdot * 10) / 10; // округление до 0.1
}

/**
 * Получить VDOT из личных рекордов (берём лучший)
 * @param {Array} records — [{distance_type: '5km', time_seconds: 1200, record_date: '...'}]
 * @returns {number|null}
 */
function getVDOTFromRecords(records) {
  if (!records || !records.length) return null;

  const distanceMap = {
    '1km': 1000,
    '3km': 3000,
    '5km': 5000,
    '10km': 10000,
    '21km': 21097,
    '42km': 42195
  };

  let bestVDOT = null;

  for (const rec of records) {
    const dist = distanceMap[rec.distance_type];
    if (!dist || !rec.time_seconds) continue;

    const vdot = calculateVDOT(rec.time_seconds, dist);
    if (vdot && (!bestVDOT || vdot > bestVDOT)) {
      bestVDOT = vdot;
    }
  }

  return bestVDOT;
}

// Типы тренировок, показательные для VDOT (≈ max effort)
// long включён т.к. classifyWorkout ставит long для ≥15 км, включая забеги на результат
const QUALITY_TYPES = ['race', 'tempo', 'interval', 'fartlek', 'long'];

/**
 * Основной расчёт VDOT пользователя.
 *
 * Алгоритм:
 * 1. Ищем quality-тренировки (race/tempo/interval/fartlek/long) за 12 недель
 *    → лучший VDOT (как замер VO2max — показываешь лучший результат)
 *
 * 2. Если за 12 недель нет quality, но есть за всё время:
 *    - Человек продолжал бегать (есть any runs за 12 нед) → берём старый VDOT с decay
 *      VO2max деградирует ~6% за 4 нед без интенсива, ~15% за 3 мес
 *    - Человек не бегал 12 недель вообще → null (зон нет)
 *
 * 3. Рекорды — не используются (отдельная функция getVDOTFromRecords для UI)
 *
 * @param {Array} recentWorkouts — тренировки за 12 недель (должны содержать поле date)
 * @param {Array} allWorkouts — все тренировки пользователя (для fallback поиска последней quality)
 * @returns {{ vdot: number|null, source: 'recent'|'decay'|null, sourceWorkout: object|null }}
 */
function estimateVDOT(recentWorkouts, allWorkouts) {
  // Исключаем GPS-аномалии из расчёта VDOT
  const recent = (recentWorkouts || []).filter(w => !w.is_suspicious);
  const all = (allWorkouts || []).filter(w => !w.is_suspicious);

  // --- Шаг 1: quality-тренировки за 12 недель → лучший VDOT ---
  const recentQuality = recent.filter(w => {
    const type = (w.type || '').toLowerCase();
    return QUALITY_TYPES.includes(type) && effectiveDistance(w) >= 2000;
  });

  const recentVdots = recentQuality
    .map(w => ({
      id: w.id,
      vdot: calculateVDOT(effectiveMovingTime(w), effectiveDistance(w)),
      distance: effectiveDistance(w),
      movingTime: effectiveMovingTime(w),
      date: w.date,
      name: w.name,
      type: w.type
    }))
    .filter(v => v.vdot !== null)
    .sort((a, b) => b.vdot - a.vdot); // лучший первый

  if (recentVdots.length > 0) {
    const best = recentVdots[0];

    // Other good workouts (besides the best) — up to 5
    const otherGood = recentVdots.slice(1, 6).map(w => ({
      id: w.id,
      name: w.name,
      date: w.date,
      vdot: Math.round(w.vdot * 10) / 10,
      distance: Math.round(w.distance),
      movingTime: w.movingTime,
      type: w.type
    }));

    return {
      vdot: Math.round(best.vdot * 10) / 10,
      source: 'recent',
      sourceWorkout: {
        id: best.id,
        name: best.name,
        date: best.date,
        vdot: Math.round(best.vdot * 10) / 10,
        distance: Math.round(best.distance),
        movingTime: best.movingTime,
        type: best.type
      },
      otherGoodWorkouts: otherGood
    };
  }

  // --- Шаг 2: нет quality за 12 недель ---
  // Проверяем бегал ли человек вообще за 12 недель
  const hasRecentRuns = recent.some(w => effectiveDistance(w) >= 1000);

  if (!hasRecentRuns) {
    // Не бегал 12 недель — зон нет
    return { vdot: null, source: null, sourceWorkout: null };
  }

  // Бегал, но только easy — ищем последнюю quality за всё время
  const allQuality = all.filter(w => {
    const type = (w.type || '').toLowerCase();
    return QUALITY_TYPES.includes(type) && effectiveDistance(w) >= 2000;
  });

  const allVdots = allQuality
    .map(w => ({
      id: w.id,
      vdot: calculateVDOT(effectiveMovingTime(w), effectiveDistance(w)),
      distance: effectiveDistance(w),
      movingTime: effectiveMovingTime(w),
      date: w.date,
      name: w.name,
      type: w.type
    }))
    .filter(v => v.vdot !== null)
    .sort((a, b) => b.vdot - a.vdot); // лучший первый

  if (!allVdots.length) {
    return { vdot: null, source: null, sourceWorkout: null };
  }

  // Decay: ~6% за 4 недели без интенсива ≈ 1.5%/нед ≈ 0.21%/день
  const best = allVdots[0];
  const ageMs = Date.now() - new Date(best.date).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const decayRate = 0.0021; // 0.21% в день ≈ 6% за 4 нед
  const decayFactor = Math.max(0.5, 1 - decayRate * ageDays); // не ниже 50%

  const decayedVdot = Math.round(best.vdot * decayFactor * 10) / 10;

  return {
    vdot: decayedVdot,
    source: 'decay',
    sourceWorkout: {
      id: best.id,
      name: best.name,
      date: best.date,
      originalVdot: Math.round(best.vdot * 10) / 10,
      decayedVdot,
      ageDays: Math.round(ageDays),
      distance: Math.round(best.distance),
      movingTime: best.movingTime,
      type: best.type
    }
  };
}

/**
 * Обратная совместимость — простая обёртка для мест где нужен только число.
 * DEPRECATED: используй estimateVDOT для нового кода.
 */
function getVDOTFromRecentWorkouts(workouts) {
  const result = estimateVDOT(workouts, workouts);
  return result.vdot;
}

/**
 * Рассчитать темповые зоны по VDOT
 * Возвращает темпы в сек/км для каждой зоны
 * @param {number} vdot
 * @returns {object} { easyMin, easyMax, marathon, threshold, interval, repetition }
 */
function calculatePaceZones(vdot) {
  if (!vdot || vdot <= 0) return null;

  // Проценты VO2max для каждой зоны (Daniels)
  const zones = {
    easyMin:    0.59, // нижняя граница Easy (самый медленный)
    easyMax:    0.74, // верхняя граница Easy
    marathon:   0.80, // Marathon pace
    threshold:  0.86, // Threshold (T) pace
    interval:   0.98, // Interval (I) pace
    repetition: 1.05  // Repetition (R) pace
  };

  const result = {};

  for (const [zone, pct] of Object.entries(zones)) {
    const targetVO2 = vdot * pct;
    const velocity = vo2ToVelocity(targetVO2); // м/мин
    if (!velocity || velocity <= 0) {
      result[zone] = null;
      continue;
    }
    // Конвертация: м/мин → сек/км
    result[zone] = Math.round((1000 / velocity) * 60);
  }

  return result;
}

/**
 * Определить уровень бегуна
 * @param {number} weeklyKm — средний километраж в неделю
 * @returns {'beginner'|'intermediate'|'advanced'}
 */
function getRunnerLevel(weeklyKm) {
  if (weeklyKm < 20) return 'beginner';
  if (weeklyKm < 50) return 'intermediate';
  return 'advanced';
}

/**
 * Максимальное улучшение темпа за 4 недели (сек/км)
 * @param {'beginner'|'intermediate'|'advanced'} level
 * @returns {{min: number, max: number}}
 */
function getMaxPaceImprovement(level) {
  switch (level) {
    case 'beginner':     return { min: 5, max: 8 };
    case 'intermediate': return { min: 3, max: 5 };
    case 'advanced':     return { min: 1, max: 3 };
    default:             return { min: 3, max: 5 };
  }
}

/**
 * Извлечь темп из строки description
 * Ищет паттерны вроде "5:30/км", "в темпе 5:30", "pace 5:30"
 * @param {string} description
 * @returns {string|null} темп в формате "m:ss" или null
 */
function extractPaceFromDescription(description) {
  if (!description) return null;

  // Паттерны: "5:30/км", "5:30 /км", "темп 5:30", "pace 5:30", "at 5:30"
  const patterns = [
    /(\d{1,2}:\d{2})\s*\/\s*(?:км|km)/i,
    /(?:темп|pace|at)\s+(\d{1,2}:\d{2})/i,
    /(\d{1,2}:\d{2})\s*(?:мин\/км|min\/km)/i,
  ];

  for (const pattern of patterns) {
    const match = description.match(pattern);
    if (match) return match[1];
  }

  return null;
}

/**
 * Гарантировать наличие поля pace в каждом дне плана
 * НЕ корректирует темпы AI — только добавляет поле если отсутствует
 * @param {Array} plan — массив из 7 дней
 * @param {object} paceZones — результат calculatePaceZones
 * @returns {Array} план с полем pace
 */
function ensurePaceField(plan, paceZones) {
  if (!Array.isArray(plan)) return plan;

  const typeToZone = {
    recovery: 'easyMax',
    easy:     'easyMax',
    long:     'easyMax',
    tempo:    'threshold',
    interval: 'interval',
    fartlek:  'threshold',
    race:     'interval',
    strength: null,
    rest:     null
  };

  return plan.map(day => {
    if (day.pace) return day; // AI уже вернул pace — не трогаем

    // Пробуем извлечь из description
    const extracted = extractPaceFromDescription(day.description);
    if (extracted) return { ...day, pace: extracted };

    // Если тип не беговой — pace не нужен
    const zoneKey = typeToZone[day.type];
    if (!zoneKey || !paceZones || !paceZones[zoneKey]) return day;

    // Подставляем дефолт из зоны
    const secPerKm = paceZones[zoneKey];
    const min = Math.floor(secPerKm / 60);
    const sec = Math.round(secPerKm % 60);
    return { ...day, pace: `${min}:${sec.toString().padStart(2, '0')}` };
  });
}

/**
 * Форматировать зоны для вывода в промпт AI
 * @param {object} zones — результат calculatePaceZones
 * @returns {string}
 */
function formatZonesForPrompt(zones) {
  if (!zones) return '';

  const fmt = (sec) => {
    if (!sec) return '—';
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return [
    `Easy/Recovery: ${fmt(zones.easyMin)} - ${fmt(zones.easyMax)} /км`,
    `Marathon: ${fmt(zones.marathon)} /км`,
    `Tempo/Threshold: ${fmt(zones.threshold)} /км`,
    `Interval: ${fmt(zones.interval)} /км`,
    `Repetition: ${fmt(zones.repetition)} /км`
  ].join('\n- ');
}

module.exports = {
  calculateVDOT,
  getVDOTFromRecords,
  getVDOTFromRecentWorkouts,
  estimateVDOT,
  QUALITY_TYPES,
  calculatePaceZones,
  getRunnerLevel,
  getMaxPaceImprovement,
  ensurePaceField,
  formatZonesForPrompt,
  extractPaceFromDescription
};
