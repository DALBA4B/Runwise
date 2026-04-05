const supabase = require('../../supabase');
const { formatPace, effectiveDistance, effectiveMovingTime, effectivePace } = require('./context');

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

// Helper: parse pace string "mm:ss" to seconds per km
function parsePaceToSeconds(paceStr) {
  const parts = paceStr.split(':');
  return parseInt(parts[0]) * 60 + parseInt(parts[1] || 0);
}

// Tool executor: get workouts by date range
async function toolGetWorkoutsByDateRange(userId, args) {
  const { start_date, end_date } = args;
  const { data } = await supabase
    .from('workouts')
    .select('name, distance, moving_time, average_pace, average_heartrate, date, type, total_elevation_gain, manual_distance, manual_moving_time')
    .eq('user_id', userId)
    .gte('date', start_date)
    .lte('date', end_date + 'T23:59:59')
    .order('date', { ascending: false })
    .limit(50);

  return (data || []).map(w => ({
    date: w.date?.split('T')[0],
    name: w.name,
    distance_km: (effectiveDistance(w) / 1000).toFixed(2),
    time_min: Math.round(effectiveMovingTime(w) / 60),
    pace: formatPace(effectivePace(w)),
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
    .select('name, distance, moving_time, average_pace, average_heartrate, max_heartrate, date, type, total_elevation_gain, splits, splits_500m, best_efforts, description, manual_distance, manual_moving_time, is_suspicious')
    .eq('user_id', userId)
    .gte('date', workout_date)
    .lte('date', workout_date + 'T23:59:59');

  if (workout_name) {
    query = query.ilike('name', `%${workout_name}%`);
  }

  const { data } = await query.order('date', { ascending: false }).limit(5);

  return (data || []).map(w => {
    const gpsAnomaly = !!w.is_suspicious;
    const result = {
      date: w.date?.split('T')[0],
      name: w.name,
      distance_km: (effectiveDistance(w) / 1000).toFixed(2),
      time_min: Math.round(effectiveMovingTime(w) / 60),
      pace: formatPace(effectivePace(w)),
      heartrate: w.average_heartrate || null,
      max_heartrate: w.max_heartrate || null,
      type: w.type,
      elevation: w.total_elevation_gain || 0,
      description: w.description || null
    };

    if (gpsAnomaly) {
      result.gps_anomaly = true;
      result.note = 'GPS anomaly detected — splits and best efforts are unreliable and excluded. Distance and time were manually corrected by the user.';
    }

    if (!gpsAnomaly && w.splits) {
      try {
        result.splits = typeof w.splits === 'string' ? JSON.parse(w.splits) : w.splits;
      } catch { result.splits = null; }
    }
    if (!gpsAnomaly && w.splits_500m) {
      try {
        result.splits_500m = typeof w.splits_500m === 'string' ? JSON.parse(w.splits_500m) : w.splits_500m;
      } catch { result.splits_500m = null; }
    }
    if (!gpsAnomaly && w.best_efforts) {
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

// Tool executor: search workouts
async function toolSearchWorkouts(userId, args) {
  const { min_distance_km, max_distance_km, min_heartrate, max_heartrate, type, sort_by, sort_order, limit } = args;
  const maxLimit = Math.min(limit || 10, 50);

  let query = supabase
    .from('workouts')
    .select('name, distance, moving_time, average_pace, average_heartrate, date, type, total_elevation_gain, manual_distance, manual_moving_time')
    .eq('user_id', userId);

  if (min_heartrate) query = query.gte('average_heartrate', min_heartrate);
  if (max_heartrate) query = query.lte('average_heartrate', max_heartrate);
  if (type) query = query.eq('type', type);

  // Sort
  const sortField = { date: 'date', distance: 'distance', pace: 'average_pace', heartrate: 'average_heartrate' }[sort_by] || 'date';
  const ascending = (sort_order === 'asc');
  query = query.order(sortField, { ascending });

  // Fetch more to account for client-side filtering by effective distance
  const { data } = await query.limit(maxLimit * 3);

  let results = (data || []).map(w => ({
    date: w.date?.split('T')[0],
    name: w.name,
    distance_km: +(effectiveDistance(w) / 1000).toFixed(2),
    time_min: Math.round(effectiveMovingTime(w) / 60),
    pace: formatPace(effectivePace(w)),
    heartrate: w.average_heartrate || null,
    type: w.type,
    elevation: w.total_elevation_gain || 0
  }));

  // Client-side distance filter (uses effective distance which may differ from DB column)
  if (min_distance_km) {
    results = results.filter(w => w.distance_km >= min_distance_km);
  }
  if (max_distance_km) {
    results = results.filter(w => w.distance_km <= max_distance_km);
  }

  results = results.slice(0, maxLimit);

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
    .select('distance, moving_time, average_pace, average_heartrate, total_elevation_gain, type, manual_distance, manual_moving_time')
    .eq('user_id', userId)
    .gte('date', start_date)
    .lte('date', end_date + 'T23:59:59');

  const workouts = data || [];
  if (workouts.length === 0) {
    return { workouts_count: 0, message: 'No workouts found in this period' };
  }

  const totalDistance = workouts.reduce((s, w) => s + effectiveDistance(w), 0);
  const totalTime = workouts.reduce((s, w) => s + effectiveMovingTime(w), 0);
  const totalElevation = workouts.reduce((s, w) => s + (w.total_elevation_gain || 0), 0);
  const paces = workouts.map(w => effectivePace(w)).filter(Boolean);
  const hrs = workouts.filter(w => w.average_heartrate).map(w => w.average_heartrate);

  // Type breakdown
  const typeBreakdown = {};
  workouts.forEach(w => {
    const t = w.type || 'unknown';
    if (!typeBreakdown[t]) typeBreakdown[t] = { count: 0, distance_km: 0 };
    typeBreakdown[t].count++;
    typeBreakdown[t].distance_km += effectiveDistance(w) / 1000;
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

module.exports = {
  AI_TOOLS,
  executeTool
};
