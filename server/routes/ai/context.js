const supabase = require('../../supabase');

// Helper: format date as YYYY-MM-DD in local timezone (avoids UTC shift from toISOString)
function toLocalDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Helper: format pace from sec/km to mm:ss
function formatPace(secPerKm) {
  if (!secPerKm) return '—';
  const min = Math.floor(secPerKm / 60);
  const sec = Math.round(secPerKm % 60);
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

// Helpers: use manual (user-corrected) values if available
function effectiveDistance(w) {
  return w.manual_distance || w.distance || 0;
}
function effectiveMovingTime(w) {
  return w.manual_moving_time || w.moving_time || 0;
}
function effectivePace(w) {
  const dist = effectiveDistance(w);
  const time = effectiveMovingTime(w);
  if (w.manual_distance || w.manual_moving_time) {
    // Recalculate pace from corrected data
    return dist > 0 ? time / (dist / 1000) : null;
  }
  return w.average_pace;
}

// Helper: check if user has active premium
async function checkPremium(userId) {
  const { data: user } = await supabase
    .from('users')
    .select('premium_until, is_lifetime_premium')
    .eq('id', userId)
    .single();

  if (!user) return false;
  if (user.is_lifetime_premium) return true;
  if (user.premium_until && new Date(user.premium_until) > new Date()) return true;
  return false;
}

// Helper: count user messages sent today (from daily_usage table, not affected by chat clearing)
async function getDailyMessageCount(userId) {
  const today = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'

  const { data, error } = await supabase
    .from('daily_usage')
    .select('message_count')
    .eq('user_id', userId)
    .eq('date', today)
    .maybeSingle();

  if (error) throw error;
  return data?.message_count || 0;
}

// Helper: increment daily message counter (upsert into daily_usage)
async function incrementDailyMessageCount(userId) {
  const today = new Date().toISOString().slice(0, 10);

  const current = await getDailyMessageCount(userId);
  const { error } = await supabase
    .from('daily_usage')
    .upsert(
      { user_id: userId, date: today, message_count: current + 1 },
      { onConflict: 'user_id,date' }
    );

  if (error) throw error;
}

// Helper: get last N months of workouts for AI context
async function getWorkoutsContext(userId, months = 3) {
  const since = new Date();
  since.setMonth(since.getMonth() - months);

  const { data } = await supabase
    .from('workouts')
    .select('name, distance, moving_time, average_pace, average_heartrate, date, type, manual_distance, manual_moving_time')
    .eq('user_id', userId)
    .gte('date', since.toISOString())
    .order('date', { ascending: false });

  return (data || []).map(w => ({
    date: w.date?.split('T')[0],
    name: w.name,
    distance_km: (effectiveDistance(w) / 1000).toFixed(2),
    pace: formatPace(effectivePace(w)),
    heartrate: w.average_heartrate || '—',
    type: w.type
  }));
}

// Helper: get compact monthly summary for AI context (replaces raw 3-month dump)
async function getMonthlySummaryContext(userId) {
  const since = new Date();
  since.setDate(since.getDate() - 30);

  const { data } = await supabase
    .from('workouts')
    .select('id, name, distance, moving_time, average_pace, average_heartrate, date, type, total_elevation_gain, manual_distance, manual_moving_time')
    .eq('user_id', userId)
    .gte('date', since.toISOString())
    .order('date', { ascending: false });

  const workouts = data || [];
  if (workouts.length === 0) {
    return {
      period: '30 days',
      workouts_count: 0,
      total_km: 0,
      total_time_min: 0,
      avg_pace: null,
      avg_heartrate: null,
      total_elevation: 0
    };
  }

  const totalDist = workouts.reduce((s, w) => s + effectiveDistance(w), 0);
  const totalTime = workouts.reduce((s, w) => s + effectiveMovingTime(w), 0);
  const totalElev = workouts.reduce((s, w) => s + (w.total_elevation_gain || 0), 0);
  const paces = workouts.map(w => effectivePace(w)).filter(Boolean);
  const hrs = workouts.filter(w => w.average_heartrate).map(w => w.average_heartrate);

  // Type breakdown: count per type
  const types = {};
  workouts.forEach(w => {
    types[w.type || 'other'] = (types[w.type || 'other'] || 0) + 1;
  });

  return {
    period: '30 days',
    workouts_count: workouts.length,
    total_km: +(totalDist / 1000).toFixed(2),
    total_time_min: Math.round(totalTime / 60),
    avg_pace: paces.length ? formatPace(paces.reduce((s, p) => s + p, 0) / paces.length) : null,
    avg_heartrate: hrs.length ? Math.round(hrs.reduce((s, h) => s + h, 0) / hrs.length) : null,
    total_elevation: Math.round(totalElev),
    type_breakdown: types
  };
}

// Helper: get user goals
async function getUserGoals(userId) {
  const { data } = await supabase
    .from('goals')
    .select('type, target_value, current_value, created_at, deadline')
    .eq('user_id', userId);

  return data || [];
}

// Helper: get current plan
async function getCurrentPlan(userId) {
  const { data } = await supabase
    .from('plans')
    .select('*')
    .eq('user_id', userId)
    .order('week_start', { ascending: false })
    .limit(1)
    .single();

  return data || null;
}

// Helper: save updated plan to DB
async function savePlanUpdate(userId, planId, newWorkouts) {
  const { data, error } = await supabase
    .from('plans')
    .update({ workouts: JSON.stringify(newWorkouts) })
    .eq('id', planId)
    .eq('user_id', userId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

// Helper: get user personal records
async function getUserRecords(userId) {
  const { data } = await supabase
    .from('personal_records')
    .select('distance_type, time_seconds, record_date')
    .eq('user_id', userId);

  return data || [];
}

// Helper: get weekly volume breakdown — find last month with activity, take 4 calendar weeks
async function getWeeklyVolumes(userId) {
  // Find last workout date
  const { data: lastWorkout } = await supabase
    .from('workouts')
    .select('date')
    .eq('user_id', userId)
    .order('date', { ascending: false })
    .limit(1);

  if (!lastWorkout || lastWorkout.length === 0) {
    return { weeks: [0, 0, 0, 0], avg: 0 };
  }

  // Find Monday of the week AFTER last workout (anchor point)
  const lastDate = new Date(lastWorkout[0].date);
  const dow = lastDate.getDay();
  const daysUntilNextMonday = dow === 0 ? 1 : 8 - dow;
  const anchor = new Date(lastDate);
  anchor.setHours(0, 0, 0, 0);
  anchor.setDate(anchor.getDate() + daysUntilNextMonday);

  // Load 4 weeks of workouts before anchor
  const since = new Date(anchor);
  since.setDate(since.getDate() - 28);

  const { data } = await supabase
    .from('workouts')
    .select('date, distance, manual_distance')
    .eq('user_id', userId)
    .gte('date', since.toISOString())
    .lt('date', anchor.toISOString())
    .order('date', { ascending: false });

  const workouts = data || [];

  const weeks = [];
  for (let w = 0; w < 4; w++) {
    const weekEnd = new Date(anchor);
    weekEnd.setDate(weekEnd.getDate() - w * 7);
    const weekStart = new Date(weekEnd);
    weekStart.setDate(weekStart.getDate() - 7);

    const totalKm = workouts
      .filter(wr => { const d = new Date(wr.date); return d >= weekStart && d < weekEnd; })
      .reduce((s, wr) => s + effectiveDistance(wr) / 1000, 0);
    weeks.push(Math.round(totalKm * 10) / 10);
  }

  const avg = weeks.length > 0
    ? Math.round(weeks.reduce((a, b) => a + b, 0) / weeks.length * 10) / 10
    : 0;
  return { weeks, avg };
}

// Helper: get user physical params + gender + ai preferences + HR settings
async function getUserProfile(userId) {
  const { data } = await supabase
    .from('users')
    .select('age, height_cm, weight_kg, gender, ai_preferences, max_heartrate_user, resting_heartrate')
    .eq('id', userId)
    .single();
  return data || {};
}

// Helper: read stored Riegel predictions from goals table (saved by /goals/predictions endpoint)
async function getRiegelPredictions(userId) {
  const { data: goals } = await supabase
    .from('goals')
    .select('type, target_value, predicted_time')
    .eq('user_id', userId)
    .in('type', ['pb_5k', 'pb_10k', 'pb_21k', 'pb_42k']);

  if (!goals || goals.length === 0) return [];

  const nameMap = { pb_5k: '5K', pb_10k: '10K', pb_21k: 'Полумарафон', pb_42k: 'Марафон' };
  const fmtTime = (s) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.round(s % 60);
    return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}` : `${m}:${sec.toString().padStart(2, '0')}`;
  };

  return goals
    .filter(g => g.predicted_time)
    .map(g => ({
      type: g.type,
      name: nameMap[g.type],
      targetTime: g.target_value,
      targetTimeFormatted: fmtTime(g.target_value),
      predictedTime: g.predicted_time,
      predictedTimeFormatted: fmtTime(g.predicted_time),
      gap: g.predicted_time - g.target_value,
    }));
}

/**
 * Статистика темпа за последние тренировки
 * @param {Array} workouts — массив тренировок из БД
 * @returns {object} { avgPace, avgEasyPace, bestPace, count }
 */
function getRecentPaceStats(workouts) {
  if (!workouts || !workouts.length) return { avgPace: null, avgEasyPace: null, bestPace: null, count: 0 };

  const runWorkouts = workouts.filter(w => {
    const dist = effectiveDistance(w);
    return dist >= 2000; // минимум 2 км
  });

  const paces = runWorkouts
    .map(w => effectivePace(w))
    .filter(p => p && p > 0);

  if (!paces.length) return { avgPace: null, avgEasyPace: null, bestPace: null, count: 0 };

  const avgPace = Math.round(paces.reduce((a, b) => a + b, 0) / paces.length);
  const bestPace = Math.min(...paces);

  // Easy-тренировки: темп медленнее среднего (верхние 60% по темпу = более медленные)
  const sorted = [...paces].sort((a, b) => a - b);
  const easyThreshold = Math.ceil(sorted.length * 0.4);
  const easyPaces = sorted.slice(easyThreshold); // медленная часть
  const avgEasyPace = easyPaces.length
    ? Math.round(easyPaces.reduce((a, b) => a + b, 0) / easyPaces.length)
    : avgPace;

  return { avgPace, avgEasyPace, bestPace, count: paces.length };
}

// Helper: get active macro plan for user
async function getActiveMacroPlan(userId) {
  const { data } = await supabase
    .from('macro_plans')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'active')
    .limit(1)
    .single();

  return data || null;
}

// Helper: compute plan-vs-fact actuals for past weeks of a macro plan
async function computeMacroPlanWithActuals(userId, macroPlan) {
  if (!macroPlan || !macroPlan.weeks || macroPlan.weeks.length === 0) {
    return { ...macroPlan, current_week: 1 };
  }

  const weeks = typeof macroPlan.weeks === 'string'
    ? JSON.parse(macroPlan.weeks)
    : macroPlan.weeks;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const firstStart = new Date(weeks[0].start_date);
  const diffDays = Math.floor((today - firstStart) / (1000 * 60 * 60 * 24));
  const currentWeek = Math.max(1, Math.min(Math.floor(diffDays / 7) + 1, weeks.length));

  // Find range of past weeks to query workouts
  const pastWeeks = weeks.filter(w => {
    const weekEnd = new Date(w.start_date);
    weekEnd.setDate(weekEnd.getDate() + 7);
    return weekEnd <= today;
  });

  if (pastWeeks.length === 0) {
    return { ...macroPlan, weeks, current_week: currentWeek };
  }

  // Single query for all past weeks' workouts
  const planStart = pastWeeks[0].start_date;
  const lastPastWeekEnd = new Date(pastWeeks[pastWeeks.length - 1].start_date);
  lastPastWeekEnd.setDate(lastPastWeekEnd.getDate() + 7);

  const { data: workouts } = await supabase
    .from('workouts')
    .select('distance, moving_time, date, manual_distance, manual_moving_time')
    .eq('user_id', userId)
    .gte('date', planStart)
    .lt('date', lastPastWeekEnd.toISOString())
    .order('date', { ascending: true });

  const allWorkouts = workouts || [];

  // Bucket workouts by week
  const enrichedWeeks = weeks.map(w => {
    const weekStart = new Date(w.start_date);
    const weekEnd = new Date(w.start_date);
    weekEnd.setDate(weekEnd.getDate() + 7);

    if (weekEnd > today) {
      // Future or current week — no actuals
      return { ...w };
    }

    const weekWorkouts = allWorkouts.filter(wr => {
      const d = new Date(wr.date);
      return d >= weekStart && d < weekEnd;
    });

    const actualKm = weekWorkouts.reduce((s, wr) => s + effectiveDistance(wr) / 1000, 0);
    const actualSessions = weekWorkouts.length;
    const compliance = w.target_volume_km > 0
      ? Math.min(Math.round((actualKm / w.target_volume_km) * 100), 200)
      : 100;

    return {
      ...w,
      actual_volume_km: Math.round(actualKm * 10) / 10,
      actual_sessions: actualSessions,
      compliance_pct: compliance
    };
  });

  return {
    ...macroPlan,
    weeks: enrichedWeeks,
    current_week: currentWeek
  };
}

/**
 * Анализ стабильности тренировок за последние N недель
 * @param {string} userId
 * @param {number} weeksCount - количество недель для анализа (по умолчанию 12)
 * @returns {object} { isStable, avgVolume, volumeStdDev, gapWeeks, consistency }
 */
async function analyzeTrainingStability(userId, weeksCount = 12) {
  const since = new Date();
  since.setDate(since.getDate() - weeksCount * 7);

  const { data: workouts } = await supabase
    .from('workouts')
    .select('date, distance, manual_distance')
    .eq('user_id', userId)
    .gte('date', since.toISOString())
    .order('date', { ascending: true });

  if (!workouts || workouts.length === 0) {
    return {
      isStable: false,
      avgVolume: 0,
      volumeStdDev: 0,
      gapWeeks: weeksCount,
      consistency: 0,
      weeklyVolumes: []
    };
  }

  // Разбить на недели
  const weeklyVolumes = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let w = 0; w < weeksCount; w++) {
    const weekEnd = new Date(today);
    weekEnd.setDate(weekEnd.getDate() - w * 7);
    const weekStart = new Date(weekEnd);
    weekStart.setDate(weekStart.getDate() - 7);

    const weekWorkouts = workouts.filter(wr => {
      const d = new Date(wr.date);
      return d >= weekStart && d < weekEnd;
    });

    const totalKm = weekWorkouts.reduce((s, wr) => s + effectiveDistance(wr) / 1000, 0);
    weeklyVolumes.push(Math.round(totalKm * 10) / 10);
  }

  weeklyVolumes.reverse(); // от старой к новой

  // Средний объём
  const avgVolume = weeklyVolumes.reduce((a, b) => a + b, 0) / weeklyVolumes.length;

  // Стандартное отклонение
  const variance = weeklyVolumes.reduce((sum, v) => sum + Math.pow(v - avgVolume, 2), 0) / weeklyVolumes.length;
  const volumeStdDev = Math.sqrt(variance);

  // Количество недель с нулевым объёмом (пропуски)
  const gapWeeks = weeklyVolumes.filter(v => v === 0).length;

  // Коэффициент вариации (CV) — мера стабильности
  // CV < 0.3 = стабильно, 0.3-0.5 = умеренно, >0.5 = нестабильно
  const cv = avgVolume > 0 ? volumeStdDev / avgVolume : 1;

  // Consistency score (0-100): учитывает CV и пропуски
  const gapPenalty = (gapWeeks / weeksCount) * 50; // до 50% штрафа за пропуски
  const cvScore = Math.max(0, 100 - cv * 100); // чем меньше CV, тем выше балл
  const consistency = Math.max(0, Math.round(cvScore - gapPenalty));

  // Стабильность: consistency > 60 и пропусков < 25%
  const isStable = consistency > 60 && gapWeeks < weeksCount * 0.25;

  return {
    isStable,
    avgVolume: Math.round(avgVolume * 10) / 10,
    volumeStdDev: Math.round(volumeStdDev * 10) / 10,
    gapWeeks,
    consistency,
    weeklyVolumes,
    coefficientOfVariation: Math.round(cv * 100) / 100
  };
}

/**
 * Оценка реалистичности цели марафона
 * @param {number} currentVDOT - текущий VDOT пользователя
 * @param {number} targetTimeSeconds - целевое время марафона в секундах
 * @param {number} weeksAvailable - количество недель до забега
 * @returns {object} { isRealistic, currentPrediction, requiredImprovement, recommendedTime }
 */
function assessMarathonGoalRealism(currentVDOT, targetTimeSeconds, weeksAvailable) {
  if (!currentVDOT || !targetTimeSeconds || !weeksAvailable) {
    return { isRealistic: null, currentPrediction: null, requiredImprovement: null, recommendedTime: null };
  }

  // Формула Дэниелса для предсказания времени марафона по VDOT
  // Упрощённая версия: marathon pace (sec/km) ≈ функция от VDOT
  // Используем обратную формулу из vdot.js
  const { calculatePaceZones } = require('./vdot');
  const zones = calculatePaceZones(currentVDOT);
  
  if (!zones || !zones.marathon) {
    return { isRealistic: null, currentPrediction: null, requiredImprovement: null, recommendedTime: null };
  }

  // Текущее предсказание времени марафона (42.195 км)
  const currentMarathonPace = zones.marathon; // сек/км
  const currentPrediction = Math.round(currentMarathonPace * 42.195);

  // Целевой темп
  const targetPace = targetTimeSeconds / 42.195;

  // Требуемое улучшение темпа (сек/км)
  const paceImprovement = currentMarathonPace - targetPace;

  // Требуемое улучшение VDOT
  // Примерно: 1 единица VDOT ≈ 3-5 сек/км улучшения марафонского темпа
  const requiredVDOTImprovement = paceImprovement / 4; // грубая оценка

  // Реалистичное улучшение VDOT за доступное время
  // Средний прогресс: 1-3% в месяц, возьмём 2% как среднее
  const monthsAvailable = weeksAvailable / 4.33;
  const realisticVDOTGain = currentVDOT * 0.02 * monthsAvailable;

  // Рекомендуемый VDOT через N месяцев
  const recommendedVDOT = currentVDOT + realisticVDOTGain;
  const recommendedZones = calculatePaceZones(recommendedVDOT);
  const recommendedTime = recommendedZones ? Math.round(recommendedZones.marathon * 42.195) : null;

  // Требуемый месячный прогресс
  const requiredMonthlyImprovement = (requiredVDOTImprovement / currentVDOT) / monthsAvailable;

  // Реалистично если требуется <5% улучшения в месяц
  const isRealistic = requiredMonthlyImprovement < 0.05;

  return {
    isRealistic,
    currentPrediction,
    targetTime: targetTimeSeconds,
    requiredImprovement: Math.round(requiredMonthlyImprovement * 100 * 10) / 10, // % в месяц
    recommendedTime,
    currentVDOT: Math.round(currentVDOT * 10) / 10,
    recommendedVDOT: Math.round(recommendedVDOT * 10) / 10,
    weeksAvailable,
    paceImprovementNeeded: Math.round(paceImprovement)
  };
}

// Analyze macro plan compliance trends
function analyzeRecentCompliance(macroPlan) {
  if (!macroPlan?.weeks) return null;

  const completedWeeks = macroPlan.weeks.filter(w => w.compliance_pct !== undefined);
  if (completedWeeks.length === 0) return null;

  const recent = completedWeeks.slice(-4);
  const avgCompliance = Math.round(recent.reduce((s, w) => s + w.compliance_pct, 0) / recent.length);

  // Trend: is compliance improving or declining
  const trend = recent.length >= 2
    ? recent[recent.length - 1].compliance_pct - recent[0].compliance_pct
    : 0;

  // Count consecutive low/high compliance weeks (from the end)
  let consecutiveLow = 0;
  for (let i = completedWeeks.length - 1; i >= 0; i--) {
    if (completedWeeks[i].compliance_pct < 80) consecutiveLow++;
    else break;
  }

  let consecutiveHigh = 0;
  for (let i = completedWeeks.length - 1; i >= 0; i--) {
    if (completedWeeks[i].compliance_pct > 115) consecutiveHigh++;
    else break;
  }

  return {
    avgCompliance,
    trend,
    consecutiveLow,
    consecutiveHigh,
    needsAdjustment: consecutiveLow >= 2 || consecutiveHigh >= 2,
    weeksCompleted: completedWeeks.length,
    totalWeeks: macroPlan.weeks.length
  };
}

// Helper: get HR trend over last 4 weeks (avg HR, avg pace, cardiac efficiency per week)
async function getHRTrendContext(userId) {
  const since = new Date();
  since.setDate(since.getDate() - 28);

  const { data } = await supabase
    .from('workouts')
    .select('distance, moving_time, average_pace, average_heartrate, max_heartrate, date, manual_distance, manual_moving_time')
    .eq('user_id', userId)
    .gte('date', since.toISOString())
    .not('average_heartrate', 'is', null)
    .order('date', { ascending: true });

  const workouts = data || [];
  if (workouts.length < 2) return null;

  // Group by week (Mon-Sun)
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weeks = [];

  for (let w = 0; w < 4; w++) {
    const weekEnd = new Date(today);
    weekEnd.setDate(weekEnd.getDate() - w * 7);
    const weekStart = new Date(weekEnd);
    weekStart.setDate(weekStart.getDate() - 7);

    const weekWorkouts = workouts.filter(wr => {
      const d = new Date(wr.date);
      return d >= weekStart && d < weekEnd;
    });

    if (weekWorkouts.length === 0) continue;

    const avgHR = Math.round(weekWorkouts.reduce((s, wr) => s + wr.average_heartrate, 0) / weekWorkouts.length);
    const maxHRPeak = Math.max(...weekWorkouts.filter(wr => wr.max_heartrate).map(wr => wr.max_heartrate));
    const paces = weekWorkouts.map(wr => effectivePace(wr)).filter(Boolean);
    const avgPace = paces.length ? Math.round(paces.reduce((s, p) => s + p, 0) / paces.length) : null;
    const ce = avgPace && avgHR ? Math.round((avgPace / avgHR) * 100) / 100 : null;

    weeks.push({
      weekAgo: w,
      workouts: weekWorkouts.length,
      avgHR,
      maxHRPeak: maxHRPeak > 0 ? maxHRPeak : null,
      avgPace: avgPace ? formatPace(avgPace) : null,
      cardiacEfficiency: ce
    });
  }

  if (weeks.length < 2) return null;
  return weeks.reverse(); // oldest first
}

// Helper: get aerobic decoupling data for recent long runs
async function getRecentDecouplingData(userId) {
  const since = new Date();
  since.setDate(since.getDate() - 30);

  const { data } = await supabase
    .from('workouts')
    .select('name, distance, date, splits_500m, manual_distance')
    .eq('user_id', userId)
    .gte('date', since.toISOString())
    .gte('distance', 10000)
    .order('date', { ascending: false })
    .limit(5);

  if (!data || data.length === 0) return null;

  const results = [];
  for (const w of data) {
    const splits = typeof w.splits_500m === 'string' ? JSON.parse(w.splits_500m) : w.splits_500m;
    if (!splits || splits.length < 4) continue;

    const splitsWithHR = splits.filter(s => s.heartrate && s.heartrate > 0);
    if (splitsWithHR.length < 4) continue;

    const mid = Math.floor(splitsWithHR.length / 2);
    const avgHR1 = splitsWithHR.slice(0, mid).reduce((s, sp) => s + sp.heartrate, 0) / mid;
    const avgHR2 = splitsWithHR.slice(mid).reduce((s, sp) => s + sp.heartrate, 0) / (splitsWithHR.length - mid);

    if (avgHR1 === 0) continue;

    const drift = Math.round(((avgHR2 - avgHR1) / avgHR1) * 1000) / 10;
    results.push({
      name: w.name,
      date: w.date?.split('T')[0],
      distance_km: +(effectiveDistance(w) / 1000).toFixed(1),
      drift,
      avgHR1: Math.round(avgHR1),
      avgHR2: Math.round(avgHR2)
    });
  }

  return results.length > 0 ? results : null;
}

// Helper: calculate TRIMP for a single workout
function calcTRIMP(durationMin, avgHR, restingHR, maxHR, gender) {
  if (!durationMin || !avgHR || durationMin <= 0 || avgHR <= 0) return null;

  // Full Banister TRIMP when resting + max HR known
  if (restingHR && maxHR && maxHR > restingHR) {
    const hrr = (avgHR - restingHR) / (maxHR - restingHR);
    const clampedHRR = Math.max(0, Math.min(1, hrr));
    const genderFactor = gender === 'female' ? 1.67 : 1.92;
    return Math.round(durationMin * clampedHRR * 0.64 * Math.exp(genderFactor * clampedHRR));
  }

  // Simplified TRIMP: duration * (HR / 180)
  return Math.round(durationMin * (avgHR / 180));
}

// Helper: get weekly TRIMP load for last 4 weeks
async function getWeeklyTRIMP(userId) {
  const { data: profile } = await supabase
    .from('users')
    .select('max_heartrate_user, resting_heartrate, gender, age')
    .eq('id', userId)
    .single();

  const maxHR = profile?.max_heartrate_user || (profile?.age ? 220 - profile.age : null);
  const restingHR = profile?.resting_heartrate || null;
  const gender = profile?.gender || null;

  const since = new Date();
  since.setDate(since.getDate() - 28);

  const { data } = await supabase
    .from('workouts')
    .select('moving_time, average_heartrate, date, manual_moving_time')
    .eq('user_id', userId)
    .gte('date', since.toISOString())
    .order('date', { ascending: true });

  const workouts = data || [];
  if (workouts.length === 0) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weeks = [];

  for (let w = 0; w < 4; w++) {
    const weekEnd = new Date(today);
    weekEnd.setDate(weekEnd.getDate() - w * 7);
    const weekStart = new Date(weekEnd);
    weekStart.setDate(weekStart.getDate() - 7);

    const weekWorkouts = workouts.filter(wr => {
      const d = new Date(wr.date);
      return d >= weekStart && d < weekEnd;
    });

    let trimp = 0;
    let withHR = 0;
    for (const wr of weekWorkouts) {
      const dur = effectiveMovingTime(wr) / 60;
      if (wr.average_heartrate) {
        trimp += calcTRIMP(dur, wr.average_heartrate, restingHR, maxHR, gender) || 0;
        withHR++;
      }
    }

    weeks.push({
      weekAgo: w,
      trimp,
      totalWorkouts: weekWorkouts.length,
      workoutsWithHR: withHR
    });
  }

  // Determine trend
  const trimps = weeks.map(w => w.trimp).reverse();
  let trend = 'stable';
  if (trimps.length >= 2) {
    const first = trimps.slice(0, 2).reduce((a, b) => a + b, 0) / 2;
    const last = trimps.slice(-2).reduce((a, b) => a + b, 0) / 2;
    if (first > 0) {
      const change = (last - first) / first;
      if (change > 0.15) trend = 'increasing';
      else if (change < -0.15) trend = 'decreasing';
    }
  }

  return { weeks: weeks.reverse(), trend };
}

module.exports = {
  toLocalDateStr,
  formatPace,
  effectiveDistance,
  effectiveMovingTime,
  effectivePace,
  checkPremium,
  getDailyMessageCount,
  incrementDailyMessageCount,
  getWorkoutsContext,
  getMonthlySummaryContext,
  getUserGoals,
  getCurrentPlan,
  savePlanUpdate,
  getUserRecords,
  getUserProfile,
  getWeeklyVolumes,
  getRiegelPredictions,
  getRecentPaceStats,
  getActiveMacroPlan,
  computeMacroPlanWithActuals,
  analyzeTrainingStability,
  assessMarathonGoalRealism,
  analyzeRecentCompliance,
  getHRTrendContext,
  getRecentDecouplingData,
  getWeeklyTRIMP,
  calcTRIMP
};
