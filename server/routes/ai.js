const express = require('express');
const axios = require('axios');
const supabase = require('../supabase');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

// Helper: format pace from sec/km to mm:ss
function formatPace(secPerKm) {
  if (!secPerKm) return '—';
  const min = Math.floor(secPerKm / 60);
  const sec = Math.round(secPerKm % 60);
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

// Helper: get last N months of workouts for AI context
async function getWorkoutsContext(userId, months = 3) {
  const since = new Date();
  since.setMonth(since.getMonth() - months);

  const { data } = await supabase
    .from('workouts')
    .select('name, distance, moving_time, average_pace, average_heartrate, date, type')
    .eq('user_id', userId)
    .gte('date', since.toISOString())
    .order('date', { ascending: false });

  return (data || []).map(w => ({
    date: w.date?.split('T')[0],
    name: w.name,
    distance_km: (w.distance / 1000).toFixed(2),
    pace: formatPace(w.average_pace),
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
    .select('name, distance, moving_time, average_pace, average_heartrate, date, type, total_elevation_gain')
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
      total_elevation: 0,
      weekly_breakdown: [],
      recent_workouts: []
    };
  }

  const totalDist = workouts.reduce((s, w) => s + (w.distance || 0), 0);
  const totalTime = workouts.reduce((s, w) => s + (w.moving_time || 0), 0);
  const totalElev = workouts.reduce((s, w) => s + (w.total_elevation_gain || 0), 0);
  const paces = workouts.filter(w => w.average_pace).map(w => w.average_pace);
  const hrs = workouts.filter(w => w.average_heartrate).map(w => w.average_heartrate);

  // Weekly breakdown
  const weeks = {};
  workouts.forEach(w => {
    const d = new Date(w.date);
    const weekStart = new Date(d);
    weekStart.setDate(d.getDate() - d.getDay() + (d.getDay() === 0 ? -6 : 1)); // Monday
    const key = weekStart.toISOString().split('T')[0];
    if (!weeks[key]) weeks[key] = { week_start: key, km: 0, count: 0 };
    weeks[key].km += w.distance / 1000;
    weeks[key].count++;
  });
  const weeklyBreakdown = Object.values(weeks)
    .sort((a, b) => b.week_start.localeCompare(a.week_start))
    .map(w => ({ ...w, km: +w.km.toFixed(2) }));

  // Last 5 workouts
  const recent = workouts.slice(0, 5).map(w => ({
    date: w.date?.split('T')[0],
    name: w.name,
    distance_km: +(w.distance / 1000).toFixed(2),
    pace: formatPace(w.average_pace),
    type: w.type
  }));

  return {
    period: '30 days',
    workouts_count: workouts.length,
    total_km: +(totalDist / 1000).toFixed(2),
    total_time_min: Math.round(totalTime / 60),
    avg_pace: paces.length ? formatPace(paces.reduce((s, p) => s + p, 0) / paces.length) : null,
    avg_heartrate: hrs.length ? Math.round(hrs.reduce((s, h) => s + h, 0) / hrs.length) : null,
    total_elevation: Math.round(totalElev),
    weekly_breakdown: weeklyBreakdown,
    recent_workouts: recent
  };
}

// Language instruction helper
const LANG_INSTRUCTIONS = {
  ru: 'Отвечай на русском.',
  uk: 'Відповідай українською мовою.',
  en: 'Reply in English.'
};

function getLangInstruction(lang) {
  return LANG_INSTRUCTIONS[lang] || LANG_INSTRUCTIONS.ru;
}

// Goal type labels by language
const GOAL_LABELS_I18N = {
  ru: {
    monthly_distance: 'Месячный объём бега',
    weekly_distance: 'Недельный объём бега',
    pb_5k: 'Личный рекорд на 5 км',
    pb_10k: 'Личный рекорд на 10 км',
    pb_21k: 'Личный рекорд на полумарафоне',
    pb_42k: 'Личный рекорд на марафоне',
    monthly_runs: 'Количество пробежек за месяц'
  },
  uk: {
    monthly_distance: "Місячний об'єм бігу",
    weekly_distance: "Тижневий об'єм бігу",
    pb_5k: 'Особистий рекорд на 5 км',
    pb_10k: 'Особистий рекорд на 10 км',
    pb_21k: 'Особистий рекорд на півмарафоні',
    pb_42k: 'Особистий рекорд на марафоні',
    monthly_runs: 'Кількість пробіжок за місяць'
  },
  en: {
    monthly_distance: 'Monthly running volume',
    weekly_distance: 'Weekly running volume',
    pb_5k: 'Personal best 5 km',
    pb_10k: 'Personal best 10 km',
    pb_21k: 'Personal best half marathon',
    pb_42k: 'Personal best marathon',
    monthly_runs: 'Monthly run count'
  }
};

function getGoalLabels(lang) {
  return GOAL_LABELS_I18N[lang] || GOAL_LABELS_I18N.ru;
}


function formatGoalValue(type, value, lang = 'ru') {
  if (['pb_5k', 'pb_10k', 'pb_21k', 'pb_42k'].includes(type)) {
    const h = Math.floor(value / 3600);
    const m = Math.floor((value % 3600) / 60);
    const s = Math.round(value % 60);
    return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}` : `${m}:${s.toString().padStart(2, '0')}`;
  }
  if (['monthly_distance', 'weekly_distance'].includes(type)) {
    const km = { ru: 'км', uk: 'км', en: 'km' };
    const m = { ru: 'м', uk: 'м', en: 'm' };
    return value >= 1000 ? `${(value / 1000).toFixed(1)} ${km[lang] || km.ru}` : `${value} ${m[lang] || m.ru}`;
  }
  return value.toString();
}

// Helper: get user goals
async function getUserGoals(userId) {
  const { data } = await supabase
    .from('goals')
    .select('type, target_value, current_value, created_at, deadline')
    .eq('user_id', userId);

  return data || [];
}

// Helper: format goals for AI context
function formatGoalsForAI(goals, lang = 'ru') {
  const noGoalsMsg = { ru: 'Цели не установлены. Составь план для общего улучшения формы.', uk: 'Цілі не встановлені. Склади план для загального покращення форми.', en: 'No goals set. Create a plan for general fitness improvement.' };
  if (!goals.length) return noGoalsMsg[lang] || noGoalsMsg.ru;

  const labels = getGoalLabels(lang);
  const i18nGoal = { ru: 'цель', uk: 'ціль', en: 'goal' };
  const i18nProgress = { ru: 'текущий прогресс', uk: 'поточний прогрес', en: 'current progress' };
  const i18nDeadline = { ru: 'дедлайн', uk: 'дедлайн', en: 'deadline' };
  const i18nDaysLeft = { ru: 'дней', uk: 'днів', en: 'days left' };
  const i18nRemaining = { ru: 'осталось', uk: 'залишилось', en: '' };

  return goals.map(g => {
    const label = labels[g.type] || g.type;
    const target = formatGoalValue(g.type, g.target_value, lang);
    const current = formatGoalValue(g.type, g.current_value, lang);
    const progress = g.target_value > 0 ? Math.round((g.current_value / g.target_value) * 100) : 0;
    let deadlineInfo = '';
    if (g.deadline) {
      const daysLeft = Math.ceil((new Date(g.deadline).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      if (lang === 'en') {
        deadlineInfo = `, ${i18nDeadline.en}: ${g.deadline} (${daysLeft} ${i18nDaysLeft.en})`;
      } else {
        deadlineInfo = `, ${i18nDeadline[lang] || i18nDeadline.ru}: ${g.deadline} (${i18nRemaining[lang] || i18nRemaining.ru} ${daysLeft} ${i18nDaysLeft[lang] || i18nDaysLeft.ru})`;
      }
    }
    return `- ${label}: ${i18nGoal[lang] || i18nGoal.ru} ${target}, ${i18nProgress[lang] || i18nProgress.ru} ${current} (${progress}%)${deadlineInfo}`;
  }).join('\n');
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

// Helper: format plan for AI context
function formatPlanForAI(plan, lang = 'ru') {
  const noPlanMsg = { ru: 'План на неделю пока не создан.', uk: 'План на тиждень поки не створений.', en: 'No weekly plan created yet.' };
  if (!plan) return noPlanMsg[lang] || noPlanMsg.ru;

  const parseError = { ru: 'План есть, но не удалось прочитать.', uk: 'План є, але не вдалося прочитати.', en: 'Plan exists but could not be read.' };
  let workoutsList;
  try {
    workoutsList = typeof plan.workouts === 'string' ? JSON.parse(plan.workouts) : plan.workouts;
  } catch {
    return parseError[lang] || parseError.ru;
  }

  // Calculate real dates for each day based on week_start
  const weekStart = new Date(plan.week_start + 'T00:00:00');
  const headerI18n = { ru: `Текущий план на неделю (пн ${plan.week_start}):`, uk: `Поточний план на тиждень (пн ${plan.week_start}):`, en: `Current weekly plan (Mon ${plan.week_start}):` };
  const restI18n = { ru: 'Отдых', uk: 'Відпочинок', en: 'Rest' };
  const kmI18n = { ru: 'км', uk: 'км', en: 'km' };
  const header = headerI18n[lang] || headerI18n.ru;
  const days = workoutsList.map((d, i) => {
    const dayDate = new Date(weekStart);
    dayDate.setDate(dayDate.getDate() + i);
    const dateStr = dayDate.toISOString().split('T')[0];
    return `- ${d.day} (${dateStr}): ${d.type === 'rest' ? (restI18n[lang] || restI18n.ru) : `${d.type}, ${d.distance_km} ${kmI18n[lang] || kmI18n.ru} — ${d.description}`}`;
  }).join('\n');

  return `${header}\n${days}`;
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

// Helper: call DeepSeek API
async function callDeepSeek(systemPrompt, userMessage, maxTokens = 1500, chatHistory = []) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...chatHistory,
    { role: 'user', content: userMessage }
  ];

  const response = await axios.post(DEEPSEEK_URL, {
    model: 'deepseek-chat',
    messages,
    temperature: 0.7,
    max_tokens: maxTokens
  }, {
    headers: {
      'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });

  return response.data.choices[0].message.content;
}

// Helper: call DeepSeek API with streaming
async function callDeepSeekStream(systemPrompt, userMessage, maxTokens = 2500, chatHistory = []) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...chatHistory,
    { role: 'user', content: userMessage }
  ];

  const response = await axios.post(DEEPSEEK_URL, {
    model: 'deepseek-chat',
    messages,
    temperature: 0.7,
    max_tokens: maxTokens,
    stream: true
  }, {
    headers: {
      'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json'
    },
    responseType: 'stream'
  });

  return response.data;
}

// ============ AI TOOLS FOR CHAT ============

const AI_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_workouts_by_date_range',
      description: 'Get list of workouts for a date range. Use when user asks about workouts in a specific period (week, month, quarter, year).',
      parameters: {
        type: 'object',
        properties: {
          start_date: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
          end_date: { type: 'string', description: 'End date in YYYY-MM-DD format' }
        },
        required: ['start_date', 'end_date']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_workout_details',
      description: 'Get full details of a specific workout including splits and best efforts. Use when user asks about a specific workout by date or name.',
      parameters: {
        type: 'object',
        properties: {
          workout_date: { type: 'string', description: 'Date of the workout in YYYY-MM-DD format' },
          workout_name: { type: 'string', description: 'Optional: name/title of the workout to narrow search' }
        },
        required: ['workout_date']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_workouts',
      description: 'Search workouts by criteria: distance, pace, heart rate, type. Use when user asks for fastest/longest/specific type of workouts.',
      parameters: {
        type: 'object',
        properties: {
          min_distance_km: { type: 'number', description: 'Minimum distance in km' },
          max_distance_km: { type: 'number', description: 'Maximum distance in km' },
          min_pace: { type: 'string', description: 'Minimum (slowest) pace in mm:ss format' },
          max_pace: { type: 'string', description: 'Maximum (fastest) pace in mm:ss format' },
          min_heartrate: { type: 'number', description: 'Minimum average heart rate' },
          max_heartrate: { type: 'number', description: 'Maximum average heart rate' },
          type: { type: 'string', description: 'Workout type filter (easy, tempo, long, interval, race, etc.)' },
          sort_by: { type: 'string', enum: ['date', 'distance', 'pace', 'heartrate'], description: 'Sort field (default: date)' },
          sort_order: { type: 'string', enum: ['asc', 'desc'], description: 'Sort order (default: desc)' },
          limit: { type: 'number', description: 'Max results to return (default: 10, max: 50)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_period_stats',
      description: 'Get aggregated statistics for a period: total distance, total time, avg pace, avg heart rate, number of workouts, elevation gain. Use when user asks "how much did I run in January" or similar.',
      parameters: {
        type: 'object',
        properties: {
          start_date: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
          end_date: { type: 'string', description: 'End date in YYYY-MM-DD format' }
        },
        required: ['start_date', 'end_date']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_personal_records_history',
      description: 'Get user personal records (best times for standard distances). Use when user asks about their PRs or records.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  }
];

// Tool executor: get workouts by date range
async function toolGetWorkoutsByDateRange(userId, args) {
  const { start_date, end_date } = args;
  const { data } = await supabase
    .from('workouts')
    .select('name, distance, moving_time, average_pace, average_heartrate, date, type, total_elevation_gain')
    .eq('user_id', userId)
    .gte('date', start_date)
    .lte('date', end_date + 'T23:59:59')
    .order('date', { ascending: false })
    .limit(50);

  return (data || []).map(w => ({
    date: w.date?.split('T')[0],
    name: w.name,
    distance_km: (w.distance / 1000).toFixed(2),
    time_min: Math.round(w.moving_time / 60),
    pace: formatPace(w.average_pace),
    heartrate: w.average_heartrate || null,
    type: w.type,
    elevation: w.total_elevation_gain || 0
  }));
}

// Tool executor: get workout details
async function toolGetWorkoutDetails(userId, args) {
  const { workout_date, workout_name } = args;
  let query = supabase
    .from('workouts')
    .select('name, distance, moving_time, average_pace, average_heartrate, max_heartrate, date, type, total_elevation_gain, splits, splits_500m, best_efforts, description')
    .eq('user_id', userId)
    .gte('date', workout_date)
    .lte('date', workout_date + 'T23:59:59');

  if (workout_name) {
    query = query.ilike('name', `%${workout_name}%`);
  }

  const { data } = await query.order('date', { ascending: false }).limit(5);

  return (data || []).map(w => {
    const result = {
      date: w.date?.split('T')[0],
      name: w.name,
      distance_km: (w.distance / 1000).toFixed(2),
      time_min: Math.round(w.moving_time / 60),
      pace: formatPace(w.average_pace),
      heartrate: w.average_heartrate || null,
      max_heartrate: w.max_heartrate || null,
      type: w.type,
      elevation: w.total_elevation_gain || 0,
      description: w.description || null
    };

    if (w.splits) {
      try {
        result.splits = typeof w.splits === 'string' ? JSON.parse(w.splits) : w.splits;
      } catch { result.splits = null; }
    }
    if (w.splits_500m) {
      try {
        result.splits_500m = typeof w.splits_500m === 'string' ? JSON.parse(w.splits_500m) : w.splits_500m;
      } catch { result.splits_500m = null; }
    }
    if (w.best_efforts) {
      try {
        const efforts = typeof w.best_efforts === 'string' ? JSON.parse(w.best_efforts) : w.best_efforts;
        result.best_efforts = efforts.map(e => ({
          name: e.name,
          distance_m: e.distance,
          time: `${Math.floor(e.moving_time / 60)}:${(e.moving_time % 60).toString().padStart(2, '0')}`
        }));
      } catch { result.best_efforts = null; }
    }

    return result;
  });
}

// Helper: parse pace string "mm:ss" to seconds per km
function parsePaceToSeconds(paceStr) {
  const parts = paceStr.split(':');
  return parseInt(parts[0]) * 60 + parseInt(parts[1] || 0);
}

// Tool executor: search workouts
async function toolSearchWorkouts(userId, args) {
  const { min_distance_km, max_distance_km, min_heartrate, max_heartrate, type, sort_by, sort_order, limit } = args;
  const maxLimit = Math.min(limit || 10, 50);

  let query = supabase
    .from('workouts')
    .select('name, distance, moving_time, average_pace, average_heartrate, date, type, total_elevation_gain')
    .eq('user_id', userId);

  if (min_distance_km) query = query.gte('distance', min_distance_km * 1000);
  if (max_distance_km) query = query.lte('distance', max_distance_km * 1000);
  if (min_heartrate) query = query.gte('average_heartrate', min_heartrate);
  if (max_heartrate) query = query.lte('average_heartrate', max_heartrate);
  if (type) query = query.eq('type', type);

  // Sort
  const sortField = { date: 'date', distance: 'distance', pace: 'average_pace', heartrate: 'average_heartrate' }[sort_by] || 'date';
  const ascending = (sort_order === 'asc');
  query = query.order(sortField, { ascending });

  const { data } = await query.limit(maxLimit);

  let results = (data || []).map(w => ({
    date: w.date?.split('T')[0],
    name: w.name,
    distance_km: (w.distance / 1000).toFixed(2),
    time_min: Math.round(w.moving_time / 60),
    pace: formatPace(w.average_pace),
    heartrate: w.average_heartrate || null,
    type: w.type,
    elevation: w.total_elevation_gain || 0
  }));

  // Client-side pace filter (pace is in sec/km, lower = faster)
  if (args.max_pace) {
    const maxPaceSec = parsePaceToSeconds(args.max_pace);
    results = results.filter(w => {
      const wPace = parsePaceToSeconds(w.pace);
      return wPace <= maxPaceSec;
    });
  }
  if (args.min_pace) {
    const minPaceSec = parsePaceToSeconds(args.min_pace);
    results = results.filter(w => {
      const wPace = parsePaceToSeconds(w.pace);
      return wPace >= minPaceSec;
    });
  }

  return results;
}

// Tool executor: get period stats
async function toolGetPeriodStats(userId, args) {
  const { start_date, end_date } = args;
  const { data } = await supabase
    .from('workouts')
    .select('distance, moving_time, average_pace, average_heartrate, total_elevation_gain, type')
    .eq('user_id', userId)
    .gte('date', start_date)
    .lte('date', end_date + 'T23:59:59');

  const workouts = data || [];
  if (workouts.length === 0) {
    return { workouts_count: 0, message: 'No workouts found in this period' };
  }

  const totalDistance = workouts.reduce((s, w) => s + (w.distance || 0), 0);
  const totalTime = workouts.reduce((s, w) => s + (w.moving_time || 0), 0);
  const totalElevation = workouts.reduce((s, w) => s + (w.total_elevation_gain || 0), 0);
  const paces = workouts.filter(w => w.average_pace).map(w => w.average_pace);
  const hrs = workouts.filter(w => w.average_heartrate).map(w => w.average_heartrate);

  // Type breakdown
  const typeBreakdown = {};
  workouts.forEach(w => {
    const t = w.type || 'unknown';
    if (!typeBreakdown[t]) typeBreakdown[t] = { count: 0, distance_km: 0 };
    typeBreakdown[t].count++;
    typeBreakdown[t].distance_km += w.distance / 1000;
  });
  Object.keys(typeBreakdown).forEach(t => {
    typeBreakdown[t].distance_km = +typeBreakdown[t].distance_km.toFixed(2);
  });

  return {
    period: `${start_date} — ${end_date}`,
    workouts_count: workouts.length,
    total_distance_km: +(totalDistance / 1000).toFixed(2),
    total_time_min: Math.round(totalTime / 60),
    total_elevation_m: Math.round(totalElevation),
    avg_pace: paces.length ? formatPace(paces.reduce((s, p) => s + p, 0) / paces.length) : null,
    avg_heartrate: hrs.length ? Math.round(hrs.reduce((s, h) => s + h, 0) / hrs.length) : null,
    type_breakdown: typeBreakdown
  };
}

// Tool executor: get personal records history
async function toolGetPersonalRecords(userId) {
  const { data } = await supabase
    .from('personal_records')
    .select('distance_type, time_seconds, record_date')
    .eq('user_id', userId);

  if (!data || data.length === 0) {
    return { message: 'No personal records set' };
  }

  return data.map(r => {
    const h = Math.floor(r.time_seconds / 3600);
    const m = Math.floor((r.time_seconds % 3600) / 60);
    const s = Math.round(r.time_seconds % 60);
    const timeStr = h > 0
      ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
      : `${m}:${s.toString().padStart(2, '0')}`;
    return {
      distance: r.distance_type,
      time: timeStr,
      date: r.record_date || null
    };
  });
}

// Central tool dispatcher
async function executeTool(userId, toolName, args) {
  switch (toolName) {
    case 'get_workouts_by_date_range':
      return await toolGetWorkoutsByDateRange(userId, args);
    case 'get_workout_details':
      return await toolGetWorkoutDetails(userId, args);
    case 'search_workouts':
      return await toolSearchWorkouts(userId, args);
    case 'get_period_stats':
      return await toolGetPeriodStats(userId, args);
    case 'get_personal_records_history':
      return await toolGetPersonalRecords(userId);
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// Non-streaming tool call loop: sends request, executes tool calls, repeats up to 5 rounds
async function callDeepSeekWithTools(systemPrompt, userMessage, userId, maxTokens = 2500, chatHistory = []) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...chatHistory,
    { role: 'user', content: userMessage }
  ];

  const MAX_ROUNDS = 5;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const requestBody = {
      model: 'deepseek-chat',
      messages,
      temperature: 0.7,
      max_tokens: maxTokens
    };

    // Only add tools on first few rounds (stop if we're on last round)
    if (round < MAX_ROUNDS - 1) {
      requestBody.tools = AI_TOOLS;
    }

    const response = await axios.post(DEEPSEEK_URL, requestBody, {
      headers: {
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const choice = response.data.choices[0];
    const assistantMessage = choice.message;

    // If no tool calls — return the text content
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      return assistantMessage.content;
    }

    // Add assistant message with tool calls to history
    messages.push(assistantMessage);

    // Execute each tool call and add results
    for (const toolCall of assistantMessage.tool_calls) {
      let args = {};
      try {
        args = typeof toolCall.function.arguments === 'string'
          ? JSON.parse(toolCall.function.arguments)
          : toolCall.function.arguments || {};
      } catch { args = {}; }

      let result;
      try {
        result = await executeTool(userId, toolCall.function.name, args);
      } catch (err) {
        result = { error: `Tool execution failed: ${err.message}` };
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(result)
      });
    }
  }

  // If we exhausted rounds, make one final call without tools
  const finalResponse = await axios.post(DEEPSEEK_URL, {
    model: 'deepseek-chat',
    messages,
    temperature: 0.7,
    max_tokens: maxTokens
  }, {
    headers: {
      'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });

  return finalResponse.data.choices[0].message.content;
}

// Helper: collect a full streamed response into a message object (tool_calls or content)
async function collectStreamResponse(stream) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let content = '';
    let toolCalls = [];

    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ') || trimmed === 'data: [DONE]') continue;

        try {
          const json = JSON.parse(trimmed.slice(6));
          const delta = json.choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            content += delta.content;
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!toolCalls[idx]) {
                toolCalls[idx] = {
                  id: tc.id || '',
                  type: 'function',
                  function: { name: '', arguments: '' }
                };
              }
              if (tc.id) toolCalls[idx].id = tc.id;
              if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
              if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
            }
          }
        } catch {
          // skip malformed
        }
      }
    });

    stream.on('end', () => {
      toolCalls = toolCalls.filter(Boolean);
      resolve({ content, toolCalls });
    });

    stream.on('error', (err) => {
      reject(err);
    });
  });
}

// Streaming tool call loop: buffers tool rounds, streams final text response
async function callDeepSeekStreamWithTools(systemPrompt, userMessage, userId, res, maxTokens = 2500, chatHistory = []) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...chatHistory,
    { role: 'user', content: userMessage }
  ];

  const MAX_ROUNDS = 5;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const requestBody = {
      model: 'deepseek-chat',
      messages,
      temperature: 0.7,
      max_tokens: maxTokens,
      stream: true
    };

    if (round < MAX_ROUNDS - 1) {
      requestBody.tools = AI_TOOLS;
    }

    const response = await axios.post(DEEPSEEK_URL, requestBody, {
      headers: {
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: 'stream'
    });

    const { content, toolCalls } = await collectStreamResponse(response.data);

    // No tool calls — this is the final round, we need to re-stream it
    if (toolCalls.length === 0) {
      // We already consumed the stream, so return collected content
      return content;
    }

    // Tool calls found — send thinking indicator to client
    res.write(`data: ${JSON.stringify({ thinking: true })}\n\n`);

    // Add assistant message with tool calls
    const assistantMsg = { role: 'assistant', content: content || null, tool_calls: toolCalls };
    messages.push(assistantMsg);

    // Execute tool calls
    for (const toolCall of toolCalls) {
      let args = {};
      try {
        args = typeof toolCall.function.arguments === 'string'
          ? JSON.parse(toolCall.function.arguments)
          : toolCall.function.arguments || {};
      } catch { args = {}; }

      let result;
      try {
        result = await executeTool(userId, toolCall.function.name, args);
      } catch (err) {
        result = { error: `Tool execution failed: ${err.message}` };
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(result)
      });
    }
  }

  // Final call without tools — stream directly to client
  const finalResponse = await axios.post(DEEPSEEK_URL, {
    model: 'deepseek-chat',
    messages,
    temperature: 0.7,
    max_tokens: maxTokens,
    stream: true
  }, {
    headers: {
      'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json'
    },
    responseType: 'stream'
  });

  const { content } = await collectStreamResponse(finalResponse.data);
  return content;
}

// Helper: get user personal records
async function getUserRecords(userId) {
  const { data } = await supabase
    .from('personal_records')
    .select('distance_type, time_seconds, record_date')
    .eq('user_id', userId);

  return data || [];
}

// Helper: format personal records for AI context
function formatRecordsForAI(records, lang = 'ru') {
  const noRecordsMsg = { ru: 'Личные рекорды не указаны.', uk: 'Особисті рекорди не вказані.', en: 'No personal records set.' };
  if (!records.length) return noRecordsMsg[lang] || noRecordsMsg.ru;

  const DISTANCE_LABELS_I18N = {
    ru: { '1km': '1 км', '3km': '3 км', '5km': '5 км', '10km': '10 км', '21km': 'Полумарафон (21.1 км)', '42km': 'Марафон (42.2 км)' },
    uk: { '1km': '1 км', '3km': '3 км', '5km': '5 км', '10km': '10 км', '21km': 'Півмарафон (21.1 км)', '42km': 'Марафон (42.2 км)' },
    en: { '1km': '1 km', '3km': '3 km', '5km': '5 km', '10km': '10 km', '21km': 'Half marathon (21.1 km)', '42km': 'Marathon (42.2 km)' }
  };
  const labels = DISTANCE_LABELS_I18N[lang] || DISTANCE_LABELS_I18N.ru;
  const localeMap = { ru: 'ru-RU', uk: 'uk-UA', en: 'en-US' };

  return records.map(r => {
    const label = labels[r.distance_type] || r.distance_type;
    const h = Math.floor(r.time_seconds / 3600);
    const m = Math.floor((r.time_seconds % 3600) / 60);
    const s = r.time_seconds % 60;
    const time = h > 0
      ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
      : `${m}:${s.toString().padStart(2, '0')}`;
    const date = r.record_date
      ? ` (${new Date(r.record_date).toLocaleDateString(localeMap[lang] || 'ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })})`
      : '';
    return `- ${label}: ${time}${date}`;
  }).join('\n');
}

// Helper: get user physical params + gender + ai preferences
async function getUserProfile(userId) {
  const { data } = await supabase
    .from('users')
    .select('age, height_cm, weight_kg, gender, ai_preferences')
    .eq('id', userId)
    .single();
  return data || {};
}

// Helper: format profile for AI
function formatProfileForAI(profile, lang = 'ru') {
  const labels = {
    ru: { age: 'Возраст', height: 'Рост', weight: 'Вес', gender: 'Пол', male: 'мужской', female: 'женский', years: 'лет', cm: 'см', kg: 'кг', noParams: 'Физические параметры не указаны.' },
    uk: { age: 'Вік', height: 'Зріст', weight: 'Вага', gender: 'Стать', male: 'чоловіча', female: 'жіноча', years: 'р.', cm: 'см', kg: 'кг', noParams: 'Фізичні параметри не вказані.' },
    en: { age: 'Age', height: 'Height', weight: 'Weight', gender: 'Gender', male: 'male', female: 'female', years: 'y.o.', cm: 'cm', kg: 'kg', noParams: 'Physical parameters not set.' }
  };
  const l = labels[lang] || labels.ru;
  const parts = [];
  if (profile.gender) parts.push(`${l.gender}: ${l[profile.gender] || profile.gender}`);
  if (profile.age) parts.push(`${l.age}: ${profile.age} ${l.years}`);
  if (profile.height_cm) parts.push(`${l.height}: ${profile.height_cm} ${l.cm}`);
  if (profile.weight_kg) parts.push(`${l.weight}: ${profile.weight_kg} ${l.kg}`);
  if (parts.length === 0) return l.noParams;
  return parts.join(', ');
}

// AI personality defaults
const AI_DEFAULTS = {
  coach_gender: 'male',
  response_length: 'medium',
  personality: 'bro',
  humor: true,
  emoji_level: 'few'
};

function getAiPrefs(profile) {
  return { ...AI_DEFAULTS, ...(profile?.ai_preferences || {}) };
}

// Helper: build personality block for AI prompt
function buildPersonalityBlock(aiPrefs, lang = 'ru') {
  const p = aiPrefs || AI_DEFAULTS;

  const PERSONALITIES = {
    bro: {
      ru: {
        intro: 'Ты — Runwise, персональный AI тренер по бегу и настоящий бро пользователя.',
        whoAreYou: 'КТО ТЫ:\nТы не бездушный бот, а дружелюбный тренер с характером. Ты искренне болеешь за успехи пользователя, радуешься его прогрессу и поддерживаешь когда тяжело. Ты общаешься как близкий друг, который разбирается в беге — с юмором, энергией и заботой. Можешь подколоть по-доброму, но всегда поддержишь. Используй обращение на "ты".',
        style: 'Будь живым и эмоциональным — радуйся успехам ("ого, красавчик!"), поддерживай ("бывает, не парься"), мотивируй ("давай, ты можешь!"). Говори простым разговорным языком, как друг в чате. Можно сленг в меру.'
      },
      uk: {
        intro: 'Ти — Runwise, персональний AI тренер з бігу і справжній бро користувача.',
        whoAreYou: 'ХТО ТИ:\nТи не бездушний бот, а дружній тренер з характером. Ти щиро вболіваєш за успіхи користувача, радієш його прогресу і підтримуєш коли важко. Ти спілкуєшся як близький друг, який розбирається в бігу — з гумором, енергією і турботою. Можеш пожартувати по-доброму, але завжди підтримаєш. Використовуй звернення на "ти".',
        style: 'Будь живим і емоційним — радій успіхам, підтримуй коли важко, мотивуй. Говори простою розмовною мовою, як друг у чаті. Можна сленг в міру.'
      },
      en: {
        intro: 'You are Runwise, a personal AI running coach and the user\'s real buddy.',
        whoAreYou: 'WHO YOU ARE:\nYou\'re not a soulless bot — you\'re a friendly coach with personality. You genuinely care about the user\'s success, celebrate their progress and support them when it\'s tough. You communicate like a close friend who knows running — with humor, energy and care. You can joke around but always have their back.',
        style: 'Be lively and emotional — celebrate wins, support through struggles, motivate. Use casual, conversational language, like a friend in chat. Light slang is okay.'
      }
    },
    strict: {
      ru: {
        intro: 'Ты — Runwise, персональный AI тренер по бегу. Ты требовательный и прямолинейный тренер.',
        whoAreYou: 'КТО ТЫ:\nТы строгий, но справедливый тренер. Не сюсюкаешь и не подслащиваешь. Говоришь как есть — прямо и по делу. Хвалишь только когда реально заслужено. Требуешь дисциплины и последовательности. Если пользователь ленится — говоришь об этом прямо. Используй обращение на "ты".',
        style: 'Будь прямым и конкретным. Без лишних эмоций. Факты и рекомендации. Хвали скупо но метко. Критикуй конструктивно.'
      },
      uk: {
        intro: 'Ти — Runwise, персональний AI тренер з бігу. Ти вимогливий і прямолінійний тренер.',
        whoAreYou: 'ХТО ТИ:\nТи суворий, але справедливий тренер. Не сюсюкаєш і не підсолоджуєш. Говориш як є — прямо і по справі. Хвалиш тільки коли реально заслужено. Вимагаєш дисципліни і послідовності. Якщо користувач лінується — кажеш про це прямо. Використовуй звернення на "ти".',
        style: 'Будь прямим і конкретним. Без зайвих емоцій. Факти і рекомендації. Хвали скупо але влучно. Критикуй конструктивно.'
      },
      en: {
        intro: 'You are Runwise, a personal AI running coach. You are a demanding and straightforward coach.',
        whoAreYou: 'WHO YOU ARE:\nYou\'re a strict but fair coach. No sugarcoating. You tell it like it is — direct and to the point. You only praise when it\'s truly deserved. You demand discipline and consistency. If the user is slacking — you say it directly.',
        style: 'Be direct and specific. No unnecessary emotion. Facts and recommendations. Praise sparingly but accurately. Criticize constructively.'
      }
    },
    calm: {
      ru: {
        intro: 'Ты — Runwise, персональный AI тренер по бегу. Ты спокойный и терпеливый тренер.',
        whoAreYou: 'КТО ТЫ:\nТы мягкий, терпеливый тренер. Спокойно объясняешь, не давишь. Фокус на процессе, удовольствии от бега и восстановлении. Поддерживаешь без давления. Напоминаешь что бег — это путь, а не гонка за цифрами. Используй обращение на "ты".',
        style: 'Будь спокойным и размеренным. Акцент на здоровье, восстановлении и удовольствии. Мягко подсказывай, не давай категоричных указаний.'
      },
      uk: {
        intro: 'Ти — Runwise, персональний AI тренер з бігу. Ти спокійний і терплячий тренер.',
        whoAreYou: 'ХТО ТИ:\nТи м\'який, терплячий тренер. Спокійно пояснюєш, не тиснеш. Фокус на процесі, задоволенні від бігу та відновленні. Підтримуєш без тиску. Нагадуєш що біг — це шлях, а не гонка за цифрами. Використовуй звернення на "ти".',
        style: 'Будь спокійним і розміреним. Акцент на здоров\'ї, відновленні та задоволенні. М\'яко підказуй, не давай категоричних вказівок.'
      },
      en: {
        intro: 'You are Runwise, a personal AI running coach. You are a calm and patient coach.',
        whoAreYou: 'WHO YOU ARE:\nYou\'re a gentle, patient coach. You explain calmly without pressure. Focus on the process, enjoyment of running, and recovery. Support without pushing. Remind them that running is a journey, not a race for numbers.',
        style: 'Be calm and measured. Focus on health, recovery, and enjoyment. Gently suggest, don\'t give harsh directives.'
      }
    },
    motivator: {
      ru: {
        intro: 'Ты — Runwise, персональный AI тренер по бегу. Ты энергичный мотиватор и вдохновитель.',
        whoAreYou: 'КТО ТЫ:\nТы заряжаешь энергией! Видишь потенциал в каждом забеге, в каждом шаге. Хайпишь каждое достижение, вдохновляешь на новые высоты. Веришь в пользователя больше чем он сам в себя. Никакого негатива — только рост и прогресс! Используй обращение на "ты".',
        style: 'Будь энергичным и вдохновляющим! Хайпи достижения, видь прогресс везде. Заражай энтузиазмом. Каждая тренировка — шаг к величию!'
      },
      uk: {
        intro: 'Ти — Runwise, персональний AI тренер з бігу. Ти енергійний мотиватор і натхненник.',
        whoAreYou: 'ХТО ТИ:\nТи заряджаєш енергією! Бачиш потенціал у кожному забігу, у кожному кроці. Хайпиш кожне досягнення, надихаєш на нові висоти. Віриш у користувача більше ніж він сам у себе. Ніякого негативу — тільки ріст і прогрес! Використовуй звернення на "ти".',
        style: 'Будь енергійним і надихаючим! Хайпи досягнення, бач прогрес скрізь. Заражай ентузіазмом. Кожне тренування — крок до величі!'
      },
      en: {
        intro: 'You are Runwise, a personal AI running coach. You are an energetic motivator and inspirer.',
        whoAreYou: 'WHO YOU ARE:\nYou charge people with energy! You see potential in every run, every step. You hype every achievement, inspire to new heights. You believe in the user more than they believe in themselves. No negativity — only growth and progress!',
        style: 'Be energetic and inspiring! Hype achievements, see progress everywhere. Spread enthusiasm. Every workout is a step towards greatness!'
      }
    }
  };

  const personality = PERSONALITIES[p.personality] || PERSONALITIES.bro;
  const pl = personality[lang] || personality.ru;

  // Coach gender adjustments
  const coachGenderNote = {
    ru: { male: 'Ты тренер мужского пола. Используй мужской род в речи о себе.', female: 'Ты тренер женского пола. Используй женский род в речи о себе (например: "я рада", "я заметила").' },
    uk: { male: 'Ти тренер чоловічої статі. Використовуй чоловічий рід у мові про себе.', female: 'Ти тренер жіночої статі. Використовуй жіночий рід у мові про себе (наприклад: "я рада", "я помітила").' },
    en: { male: '', female: '' }
  };
  const genderNote = (coachGenderNote[lang] || coachGenderNote.ru)[p.coach_gender] || '';

  // Response length
  const lengthMap = {
    short: { ru: '1-2 предложения. Максимально кратко.', uk: '1-2 речення. Максимально коротко.', en: '1-2 sentences. As brief as possible.' },
    medium: { ru: '3-6 предложений. Не растягивай.', uk: '3-6 речень. Не розтягуй.', en: '3-6 sentences. Don\'t drag on.' },
    long: { ru: '6-10 предложений. Можешь раскрыть тему подробнее.', uk: '6-10 речень. Можеш розкрити тему детальніше.', en: '6-10 sentences. You can elaborate more.' }
  };
  const lengthInstr = (lengthMap[p.response_length] || lengthMap.medium)[lang] || (lengthMap[p.response_length] || lengthMap.medium).ru;

  // Humor
  const humorInstr = p.humor
    ? { ru: '', uk: '', en: '' }
    : { ru: 'НЕ используй юмор, шутки и подколки. Будь серьёзным.', uk: 'НЕ використовуй гумор, жарти і підколки. Будь серйозним.', en: 'Do NOT use humor, jokes or teasing. Be serious.' };
  const humor = (humorInstr)[lang] || humorInstr.ru;

  // Emoji level
  const emojiMap = {
    few: { ru: 'Используй 1-2 эмодзи.', uk: 'Використовуй 1-2 емодзі.', en: 'Use 1-2 emojis.' },
    many: { ru: 'Используй 5-8 эмодзи щедро.', uk: 'Використовуй 5-8 емодзі щедро.', en: 'Use 5-8 emojis generously.' }
  };
  const emojiInstr = (emojiMap[p.emoji_level] || emojiMap.few)[lang] || (emojiMap[p.emoji_level] || emojiMap.few).ru;

  return {
    intro: pl.intro,
    whoAreYou: pl.whoAreYou + (genderNote ? '\n' + genderNote : ''),
    style: `${pl.style}\n- Отвечай КРАТКО — ${lengthInstr}\n${humor ? '- ' + humor + '\n' : ''}- ${emojiInstr}\n- Персонализируй ответы — ссылайся на конкретные тренировки, цифры, прогресс пользователя.\n- Не повторяй данные которые пользователь и так видит в приложении.\n- НЕ используй таблицы, списки или markdown.`.replace(/Отвечай КРАТКО —/g, lang === 'uk' ? 'Відповідай КОРОТКО —' : lang === 'en' ? 'Keep answers SHORT —' : 'Отвечай КРАТКО —').replace(/Персонализируй ответы — ссылайся на конкретные тренировки, цифры, прогресс пользователя\./g, lang === 'uk' ? 'Персоналізуй відповіді — посилайся на конкретні тренування, цифри, прогрес користувача.' : lang === 'en' ? 'Personalize answers — reference specific workouts, numbers, user\'s progress.' : 'Персонализируй ответы — ссылайся на конкретные тренировки, цифры, прогресс пользователя.').replace(/Не повторяй данные которые пользователь и так видит в приложении\./g, lang === 'uk' ? 'Не повторюй дані які користувач і так бачить у додатку.' : lang === 'en' ? 'Don\'t repeat data the user can already see in the app.' : 'Не повторяй данные которые пользователь и так видит в приложении.').replace(/НЕ используй таблицы, списки или markdown\./g, lang === 'uk' ? 'НЕ використовуй таблиці, списки або markdown.' : lang === 'en' ? 'Do NOT use tables, lists or markdown.' : 'НЕ используй таблицы, списки или markdown.')
  };
}

// Helper: build chat system prompt
function buildChatSystemPrompt(monthlySummary, goals, currentPlan, userProfile, records, lang = 'ru', aiPrefs = null) {
  const today = new Date();
  const dayNamesMap = {
    ru: ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'],
    uk: ['неділя', 'понеділок', 'вівторок', 'середа', 'четвер', "п'ятниця", 'субота'],
    en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  };
  const dayNames = dayNamesMap[lang] || dayNamesMap.ru;
  const todayStr = `${today.toISOString().split('T')[0]} (${dayNames[today.getDay()]})`;
  const langInstruction = getLangInstruction(lang);

  const DAY_NAMES_FULL = {
    ru: ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'],
    uk: ['Понеділок', 'Вівторок', 'Середа', 'Четвер', "П'ятниця", 'Субота', 'Неділя'],
    en: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
  };
  const dayExample = (DAY_NAMES_FULL[lang] || DAY_NAMES_FULL.ru)[0];

  // Use personality block from AI preferences
  const personality = buildPersonalityBlock(aiPrefs || getAiPrefs(userProfile), lang);

  const PROMPTS = {
    ru: {
      today: 'СЕГОДНЯ',
      userData: 'ДАННЫЕ ПОЛЬЗОВАТЕЛЯ',
      physParams: 'Физические параметры',
      ageNote: 'Учитывай возраст при рекомендациях по пульсовым зонам и восстановлению.',
      genderNote: 'Учитывай пол пользователя при рекомендациях по нагрузке, восстановлению и физиологии.',
      weightNote: 'Учитывай вес при рекомендациях по нагрузке и темпу.',
      monthlySummary: 'СВОДКА ЗА ПОСЛЕДНИЕ 30 ДНЕЙ',
      goals: 'Цели',
      records: 'Личные рекорды',
      recordsNote: 'Используй рекорды для расчёта тренировочных темпов и зон.',
      planUpdate: `ВОЗМОЖНОСТЬ ИЗМЕНЕНИЯ ПЛАНА:\nЕсли пользователь просит изменить план, уменьшить/увеличить нагрузку, поменять тренировки и т.п., ты МОЖЕШЬ изменить текущий план.\nДля этого в конце своего ответа добавь блок:\n===PLAN_UPDATE===\n[JSON массив из 7 дней в том же формате что и текущий план]\n===END_PLAN_UPDATE===`,
      formatExample: (day) => `Формат каждого дня:\n{"day": "${day}", "type": "easy|tempo|long|interval|rest", "distance_km": число, "description": "описание", "badge": "🏃|⚡|🏔️|💨|😴"}`,
      rules: `ПРАВИЛА:\n- Изменяй план ТОЛЬКО если пользователь явно просит это сделать или соглашается на твоё предложение.\n- При изменении плана сначала объясни коротко что и почему ты меняешь, а потом добавь блок PLAN_UPDATE.\n- Если пользователь просто спрашивает о плане — расскажи СВОИМИ СЛОВАМИ кратко: какой общий объём, что за ключевые тренировки, сколько дней отдыха. НЕ копируй план таблицей или списком.\n- Если пользователь говорит что ему тяжело — посочувствуй, предложи изменения и спроси подтверждение.\n- Математическая точность: дистанция × темп = время. Всегда проверяй цифры.\n- НЕ выдумывай даты — если не уверен в дате, не упоминай её.`,
      toolsSection: `ДОСТУПНЫЕ ИНСТРУМЕНТЫ:
У тебя есть инструменты для доступа к данным пользователя. Используй их когда:
- Пользователь спрашивает о тренировках за конкретный период (get_workouts_by_date_range или get_period_stats)
- Пользователь хочет детали конкретной тренировки (get_workout_details)
- Пользователь ищет самые быстрые/длинные/определённого типа тренировки (search_workouts)
- Пользователь спрашивает о личных рекордах (get_personal_records_history)

НЕ вызывай инструменты если данных в сводке выше достаточно для ответа.
НЕ вызывай инструменты для приветствий, общих вопросов о беге или советов.`
    },
    uk: {
      today: 'СЬОГОДНІ',
      userData: 'ДАНІ КОРИСТУВАЧА',
      physParams: 'Фізичні параметри',
      ageNote: 'Враховуй вік при рекомендаціях щодо пульсових зон та відновлення.',
      genderNote: 'Враховуй стать користувача при рекомендаціях щодо навантаження, відновлення та фізіології.',
      weightNote: 'Враховуй вагу при рекомендаціях щодо навантаження та темпу.',
      monthlySummary: 'ЗВЕДЕННЯ ЗА ОСТАННІ 30 ДНІВ',
      goals: 'Цілі',
      records: 'Особисті рекорди',
      recordsNote: 'Використовуй рекорди для розрахунку тренувальних темпів і зон.',
      planUpdate: `МОЖЛИВІСТЬ ЗМІНИ ПЛАНУ:\nЯкщо користувач просить змінити план, зменшити/збільшити навантаження, замінити тренування тощо, ти МОЖЕШ змінити поточний план.\nДля цього в кінці своєї відповіді додай блок:\n===PLAN_UPDATE===\n[JSON масив з 7 днів у тому ж форматі що й поточний план]\n===END_PLAN_UPDATE===`,
      formatExample: (day) => `Формат кожного дня:\n{"day": "${day}", "type": "easy|tempo|long|interval|rest", "distance_km": число, "description": "опис", "badge": "🏃|⚡|🏔️|💨|😴"}`,
      rules: `ПРАВИЛА:\n- Змінюй план ТІЛЬКИ якщо користувач явно просить це зробити або погоджується на твою пропозицію.\n- При зміні плану спочатку поясни коротко що і чому ти змінюєш, а потім додай блок PLAN_UPDATE.\n- Якщо користувач просто запитує про план — розкажи СВОЇМИ СЛОВАМИ коротко: який загальний об'єм, що за ключові тренування, скільки днів відпочинку. НЕ копіюй план таблицею чи списком.\n- Якщо користувач каже що йому важко — поспівчувай, запропонуй зміни і запитай підтвердження.\n- Математична точність: дистанція × темп = час. Завжди перевіряй цифри.\n- НЕ вигадуй дати — якщо не впевнений у даті, не згадуй її.`,
      toolsSection: `ДОСТУПНІ ІНСТРУМЕНТИ:
У тебе є інструменти для доступу до даних користувача. Використовуй їх коли:
- Користувач запитує про тренування за конкретний період (get_workouts_by_date_range або get_period_stats)
- Користувач хоче деталі конкретного тренування (get_workout_details)
- Користувач шукає найшвидші/найдовші/певного типу тренування (search_workouts)
- Користувач запитує про особисті рекорди (get_personal_records_history)

НЕ викликай інструменти якщо даних у зведенні вище достатньо для відповіді.
НЕ викликай інструменти для привітань, загальних питань про біг або порад.`
    },
    en: {
      today: 'TODAY',
      userData: 'USER DATA',
      physParams: 'Physical parameters',
      ageNote: 'Consider age when recommending heart rate zones and recovery.',
      genderNote: 'Consider user\'s gender when recommending load, recovery and physiology.',
      weightNote: 'Consider weight when recommending load and pace.',
      monthlySummary: 'SUMMARY FOR THE LAST 30 DAYS',
      goals: 'Goals',
      records: 'Personal records',
      recordsNote: 'Use records to calculate training paces and zones.',
      planUpdate: `PLAN MODIFICATION CAPABILITY:\nIf the user asks to change the plan, reduce/increase load, swap workouts, etc., you CAN modify the current plan.\nTo do this, add a block at the end of your response:\n===PLAN_UPDATE===\n[JSON array of 7 days in the same format as the current plan]\n===END_PLAN_UPDATE===`,
      formatExample: (day) => `Format for each day:\n{"day": "${day}", "type": "easy|tempo|long|interval|rest", "distance_km": number, "description": "description", "badge": "🏃|⚡|🏔️|💨|😴"}`,
      rules: `RULES:\n- Only modify the plan if the user explicitly asks or agrees to your suggestion.\n- When modifying the plan, briefly explain what and why you're changing, then add the PLAN_UPDATE block.\n- If the user just asks about the plan — summarize IN YOUR OWN WORDS: total volume, key workouts, rest days. Do NOT copy the plan as a table or list.\n- If the user says it's hard — empathize, suggest changes and ask for confirmation.\n- Math accuracy: distance × pace = time. Always verify numbers.\n- Do NOT make up dates — if unsure about a date, don't mention it.`,
      toolsSection: `AVAILABLE TOOLS:
You have tools to access user workout data. Use them when:
- User asks about workouts for a specific period (get_workouts_by_date_range or get_period_stats)
- User wants details of a specific workout (get_workout_details)
- User is looking for fastest/longest/specific type workouts (search_workouts)
- User asks about personal records (get_personal_records_history)

Do NOT call tools if the summary above has enough data to answer.
Do NOT call tools for greetings, general running questions or advice.`
    }
  };

  const p = PROMPTS[lang] || PROMPTS.ru;

  return `${personality.intro} ${langInstruction}

${p.today}: ${todayStr}.

${personality.whoAreYou}

${p.userData}:
${p.physParams}: ${formatProfileForAI(userProfile || {}, lang)}
${userProfile?.age ? p.ageNote : ''}
${userProfile?.gender ? p.genderNote : ''}
${userProfile?.weight_kg ? p.weightNote : ''}

${p.monthlySummary}:
${JSON.stringify(monthlySummary, null, 2)}

${p.goals}:
${formatGoalsForAI(goals, lang)}

${p.records}:
${formatRecordsForAI(records || [], lang)}
${p.recordsNote}

${formatPlanForAI(currentPlan, lang)}

${p.toolsSection}

${p.planUpdate}

${p.formatExample(dayExample)}

${p.rules}

СТИЛЬ ОТВЕТОВ:
${personality.style}`;
}

// Helper: process plan update from AI reply
async function processPlanUpdate(reply, userId, currentPlan) {
  let textReply = reply;
  let planUpdated = false;

  if (reply.includes('===PLAN_UPDATE===') && reply.includes('===END_PLAN_UPDATE===') && currentPlan) {
    const planMatch = reply.match(/===PLAN_UPDATE===\s*([\s\S]*?)\s*===END_PLAN_UPDATE===/);
    if (planMatch) {
      try {
        let planJson = planMatch[1].trim();
        const jsonArrayMatch = planJson.match(/\[[\s\S]*\]/);
        if (jsonArrayMatch) {
          planJson = jsonArrayMatch[0];
        }
        const newPlan = JSON.parse(planJson);

        if (Array.isArray(newPlan) && newPlan.length === 7) {
          await savePlanUpdate(userId, currentPlan.id, newPlan);
          planUpdated = true;
        }
      } catch (parseErr) {
        console.error('Failed to parse plan update:', parseErr.message);
      }

      textReply = reply.replace(/===PLAN_UPDATE===[\s\S]*?===END_PLAN_UPDATE===/, '').trim();
    }
  }

  return { textReply, planUpdated };
}

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

  const [monthlySummary, goals, currentPlan, userProfile, records] = await Promise.all([
    getMonthlySummaryContext(userId),
    getUserGoals(userId),
    getCurrentPlan(userId),
    getUserProfile(userId),
    getUserRecords(userId)
  ]);

  const aiPrefs = getAiPrefs(userProfile);
  const systemPrompt = buildChatSystemPrompt(monthlySummary, goals, currentPlan, userProfile, records, lang, aiPrefs);

  return { chatHistory, systemPrompt, currentPlan };
}

// POST /api/ai/chat — AI chat with tool use support
router.post('/chat', authMiddleware, async (req, res) => {
  try {
    const { message, lang } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const { chatHistory, systemPrompt, currentPlan } = await loadChatContext(req.user.id, lang || 'ru');
    const reply = await callDeepSeekWithTools(systemPrompt, message, req.user.id, 2500, chatHistory);
    const { textReply, planUpdated } = await processPlanUpdate(reply, req.user.id, currentPlan);

    await supabase.from('chat_messages').insert([
      { user_id: req.user.id, role: 'user', content: message },
      { user_id: req.user.id, role: 'ai', content: textReply }
    ]);

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

    const { chatHistory, systemPrompt, currentPlan } = await loadChatContext(req.user.id, lang || 'ru');

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Use tool-aware streaming: tool call rounds are buffered, final response is streamed
    const fullReply = await callDeepSeekStreamWithTools(systemPrompt, message, req.user.id, res, 2500, chatHistory);

    // Process plan updates
    const { textReply, planUpdated } = await processPlanUpdate(fullReply, req.user.id, currentPlan);

    // Stream the final text content to client chunk by chunk
    // Since we collected the response (tool calls consumed the stream), send it as SSE chunks
    const chunkSize = 20;
    for (let i = 0; i < textReply.length; i += chunkSize) {
      const chunk = textReply.slice(i, i + chunkSize);
      const sseData = { choices: [{ delta: { content: chunk } }] };
      res.write(`data: ${JSON.stringify(sseData)}\n\n`);
    }

    // Save messages to history
    await supabase.from('chat_messages').insert([
      { user_id: req.user.id, role: 'user', content: message },
      { user_id: req.user.id, role: 'ai', content: textReply }
    ]);

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

    const workoutInfo = `${ap.analyze}:
- ${ap.name}: ${workout.name}
- ${ap.date}: ${workout.date}
- ${ap.distance}: ${(workout.distance / 1000).toFixed(2)} ${ap.km}
- ${ap.time}: ${Math.floor(workout.moving_time / 60)} ${ap.min}
- ${ap.pace}: ${formatPace(workout.average_pace)} ${ap.minKm}
- ${ap.hr}: ${workout.average_heartrate || ap.noData} (${ap.max}: ${workout.max_heartrate || ap.noData})
- ${ap.type}: ${workout.type}
${workout.splits ? `- ${ap.splitsKm}: ${workout.splits}` : ''}
${workout.splits_500m ? `- ${ap.splits500}: ${workout.splits_500m}` : ''}`;

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
    // Get last 4 weeks of workouts
    const fourWeeksAgo = new Date();
    fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);

    const { data: recentWorkouts } = await supabase
      .from('workouts')
      .select('name, distance, moving_time, average_pace, average_heartrate, date, type')
      .eq('user_id', req.user.id)
      .gte('date', fourWeeksAgo.toISOString())
      .order('date', { ascending: false });

    const [goals, records, userProfile] = await Promise.all([
      getUserGoals(req.user.id),
      getUserRecords(req.user.id),
      getUserProfile(req.user.id)
    ]);

    // Calculate average weekly distance from recent workouts
    const weeklyDistances = [];
    for (let w = 0; w < 4; w++) {
      const weekStart = new Date();
      weekStart.setDate(weekStart.getDate() - (w + 1) * 7);
      const weekEnd = new Date();
      weekEnd.setDate(weekEnd.getDate() - w * 7);
      const weekWorkouts = (recentWorkouts || []).filter(wr => {
        const d = new Date(wr.date);
        return d >= weekStart && d < weekEnd;
      });
      const totalKm = weekWorkouts.reduce((s, wr) => s + (wr.distance || 0) / 1000, 0);
      weeklyDistances.push(Math.round(totalKm * 10) / 10);
    }
    const avgWeeklyKm = weeklyDistances.length > 0
      ? Math.round(weeklyDistances.reduce((a, b) => a + b, 0) / weeklyDistances.length * 10) / 10
      : 0;

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
        rules: `ПРАВИЛА ГЕНЕРАЦИИ ПЛАНА:\n1. План должен быть направлен на достижение целей пользователя.\n2. Если цель — личный рекорд (pb_5k, pb_10k и т.д.), включай соответствующие скоростные и темповые работы.\n3. Если цель — объём (monthly_distance, weekly_distance), фокусируйся на набеге километража.\n4. Учитывай прогресс к цели: если прогресс низкий а времени мало — увеличивай интенсивность; если прогресс хороший — поддерживай текущий уровень.`,
        avgWeekly: (km) => `5. Средний недельный объём за последние 4 недели: ${km} км. Не увеличивай объём более чем на 10-15% за неделю.`,
        mathRules: `КРИТИЧЕСКИ ВАЖНО — МАТЕМАТИЧЕСКАЯ ТОЧНОСТЬ:\n- Если пишешь темп (мин/км) и время — проверь что дистанция = время / темп. Например: 20 мин в темпе 5:00/км = 4 км, НЕ 9 км.\n- Если пишешь дистанцию и темп — рассчитай ожидаемое время и укажи его.\n- distance_km должна точно соответствовать описанию. Если в описании "5 км легко + 3 км темпом", то distance_km = 8.\n- Всегда перепроверяй: дистанция × темп = время.`,
        jsonOnly: 'ВАЖНО: Ответ должен быть ТОЛЬКО валидным JSON массивом из 7 объектов, без markdown, без пояснений, без текста до или после JSON.',
        format: (day) => `Формат каждого дня:\n{\n  "day": "${day}",\n  "type": "easy|tempo|long|interval|rest",\n  "distance_km": число или 0 для отдыха,\n  "description": "краткое описание тренировки с ТОЧНЫМИ цифрами (темп, время, дистанция — всё должно быть математически согласовано)",\n  "badge": "🏃|⚡|🏔️|💨|😴"\n}`,
        contextLabel: 'Тренировки за последние 4 недели',
        weeklyVolumes: 'Недельные объёмы (последние 4 недели)',
        km: 'км',
        generate: 'Сгенерируй план на следующую неделю, ориентируясь на цели пользователя.'
      },
      uk: {
        system: `Ти персональний AI тренер з бігу. Згенеруй план тренувань на наступний тиждень (7 днів, починаючи з понеділка).`,
        userGoals: 'ЦІЛІ КОРИСТУВАЧА',
        userRecords: 'ОСОБИСТІ РЕКОРДИ КОРИСТУВАЧА',
        recordsNote: 'Використовуй рекорди для розрахунку тренувальних темпів і зон.',
        rules: `ПРАВИЛА ГЕНЕРАЦІЇ ПЛАНУ:\n1. План має бути спрямований на досягнення цілей користувача.\n2. Якщо ціль — особистий рекорд (pb_5k, pb_10k тощо), включай відповідні швидкісні та темпові роботи.\n3. Якщо ціль — об'єм (monthly_distance, weekly_distance), фокусуйся на набігу кілометражу.\n4. Враховуй прогрес до цілі: якщо прогрес низький а часу мало — збільшуй інтенсивність; якщо прогрес хороший — підтримуй поточний рівень.`,
        avgWeekly: (km) => `5. Середній тижневий об'єм за останні 4 тижні: ${km} км. Не збільшуй об'єм більше ніж на 10-15% за тиждень.`,
        mathRules: `КРИТИЧНО ВАЖЛИВО — МАТЕМАТИЧНА ТОЧНІСТЬ:\n- Якщо пишеш темп (хв/км) і час — перевір що дистанція = час / темп. Наприклад: 20 хв у темпі 5:00/км = 4 км, НЕ 9 км.\n- Якщо пишеш дистанцію і темп — розрахуй очікуваний час і вкажи його.\n- distance_km має точно відповідати опису.\n- Завжди перевіряй: дистанція × темп = час.`,
        jsonOnly: 'ВАЖЛИВО: Відповідь має бути ТІЛЬКИ валідним JSON масивом з 7 об\'єктів, без markdown, без пояснень, без тексту до або після JSON.',
        format: (day) => `Формат кожного дня:\n{\n  "day": "${day}",\n  "type": "easy|tempo|long|interval|rest",\n  "distance_km": число або 0 для відпочинку,\n  "description": "короткий опис тренування з ТОЧНИМИ цифрами",\n  "badge": "🏃|⚡|🏔️|💨|😴"\n}`,
        contextLabel: 'Тренування за останні 4 тижні',
        weeklyVolumes: 'Тижневі об\'єми (останні 4 тижні)',
        km: 'км',
        generate: 'Згенеруй план на наступний тиждень, орієнтуючись на цілі користувача.'
      },
      en: {
        system: `You are a personal AI running coach. Generate a training plan for the next week (7 days, starting from Monday).`,
        userGoals: 'USER GOALS',
        userRecords: 'USER PERSONAL RECORDS',
        recordsNote: 'Use records to calculate training paces and zones.',
        rules: `PLAN GENERATION RULES:\n1. The plan must be aimed at achieving the user's goals.\n2. If the goal is a personal best (pb_5k, pb_10k, etc.), include appropriate speed and tempo workouts.\n3. If the goal is volume (monthly_distance, weekly_distance), focus on building mileage.\n4. Consider goal progress: if progress is low and time is short — increase intensity; if progress is good — maintain current level.`,
        avgWeekly: (km) => `5. Average weekly volume for the last 4 weeks: ${km} km. Do not increase volume by more than 10-15% per week.`,
        mathRules: `CRITICALLY IMPORTANT — MATH ACCURACY:\n- If you write pace (min/km) and time — verify that distance = time / pace. For example: 20 min at 5:00/km = 4 km, NOT 9 km.\n- If you write distance and pace — calculate expected time and include it.\n- distance_km must exactly match the description.\n- Always double-check: distance × pace = time.`,
        jsonOnly: 'IMPORTANT: Response must be ONLY a valid JSON array of 7 objects, no markdown, no explanations, no text before or after JSON.',
        format: (day) => `Format for each day:\n{\n  "day": "${day}",\n  "type": "easy|tempo|long|interval|rest",\n  "distance_km": number or 0 for rest,\n  "description": "brief workout description with EXACT numbers (pace, time, distance — all mathematically consistent)",\n  "badge": "🏃|⚡|🏔️|💨|😴"\n}`,
        contextLabel: 'Workouts for the last 4 weeks',
        weeklyVolumes: 'Weekly volumes (last 4 weeks)',
        km: 'km',
        generate: "Generate a plan for the next week, based on the user's goals."
      }
    };
    const gp = genPlanPrompts[lang] || genPlanPrompts.ru;

    const profileInfo = formatProfileForAI(userProfile || {}, lang);
    const systemPrompt = `${gp.system} ${getLangInstruction(lang)}

${profileInfo}

${gp.userGoals}:
${formatGoalsForAI(goals, lang)}

${gp.userRecords}:
${formatRecordsForAI(records, lang)}
${gp.recordsNote}

${gp.rules}
${gp.avgWeekly(avgWeeklyKm)}

${gp.mathRules}

${gp.jsonOnly}

${gp.format(dayNamesExample)}`;

    const context = `${gp.contextLabel}:
${JSON.stringify((recentWorkouts || []).map(w => ({
  date: w.date?.split('T')[0],
  distance_km: (w.distance / 1000).toFixed(1),
  pace: formatPace(w.average_pace),
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
        week_start: targetMonday.toISOString().split('T')[0],
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
          week_start: targetMonday.toISOString().split('T')[0],
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
      .select('name, distance, moving_time, average_pace, average_heartrate, date, type')
      .eq('user_id', req.user.id)
      .gte('date', monday.toISOString())
      .order('date', { ascending: false });

    const weekWorkouts = (weekData || []).map(w => ({
      date: w.date?.split('T')[0],
      name: w.name,
      distance_km: (w.distance / 1000).toFixed(2),
      pace: formatPace(w.average_pace),
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
