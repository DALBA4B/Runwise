const express = require('express');
const supabase = require('../supabase');
const authMiddleware = require('../middleware/authMiddleware');
const { detectAnomalies } = require('./strava');

const router = express.Router();

// GET /api/workouts — all workouts for user
const WORKOUTS_BASE_FIELDS = 'id, strava_id, name, distance, moving_time, average_pace, average_heartrate, max_heartrate, date, type, splits';
const WORKOUTS_ANOMALY_FIELDS = ', is_suspicious, user_verified, manual_distance, manual_moving_time';
let hasAnomalyColumns = true; // optimistic, fallback if missing

router.get('/', authMiddleware, async (req, res) => {
  try {
    const { month, year, limit } = req.query;

    const buildQuery = (fields) => {
      let q = supabase
        .from('workouts')
        .select(fields)
        .eq('user_id', req.user.id)
        .order('date', { ascending: false });
      if (month && year) {
        const startDate = new Date(year, month - 1, 1).toISOString();
        const endDate = new Date(year, month, 0, 23, 59, 59).toISOString();
        q = q.gte('date', startDate).lte('date', endDate);
      }
      if (limit) q = q.limit(parseInt(limit));
      return q;
    };

    let { data, error } = await buildQuery(WORKOUTS_BASE_FIELDS + (hasAnomalyColumns ? WORKOUTS_ANOMALY_FIELDS : ''));

    // Fallback: if anomaly columns don't exist yet
    if (error && error.message && (error.message.includes('is_suspicious') || error.message.includes('user_verified') || error.message.includes('manual_'))) {
      hasAnomalyColumns = false;
      const fallback = await buildQuery(WORKOUTS_BASE_FIELDS);
      if (fallback.error) throw fallback.error;
      data = fallback.data;
    } else if (error) {
      throw error;
    }

    res.json(data);
  } catch (err) {
    console.error('Get workouts error:', err.message);
    res.status(500).json({ error: 'Failed to fetch workouts' });
  }
});

// GET /api/workouts/stats — aggregated stats
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const { period } = req.query; // 'week', 'month', 'all'

    let dateFilter = null;
    const now = new Date();

    if (period === 'week') {
      // Monday of current week
      const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon...
      const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      const monday = new Date(now);
      monday.setDate(monday.getDate() - daysFromMonday);
      monday.setHours(0, 0, 0, 0);
      dateFilter = monday.toISOString();
    } else if (period === 'month') {
      const monthAgo = new Date(now);
      monthAgo.setMonth(monthAgo.getMonth() - 1);
      dateFilter = monthAgo.toISOString();
    }

    // Try with elevation + anomaly columns, fallback without if columns don't exist yet
    const anomalyFields = hasAnomalyColumns ? ', is_suspicious, user_verified, manual_distance, manual_moving_time' : '';
    let query = supabase
      .from('workouts')
      .select('distance, moving_time, average_pace, average_heartrate, total_elevation_gain, date' + anomalyFields)
      .eq('user_id', req.user.id);

    if (dateFilter) {
      query = query.gte('date', dateFilter);
    }

    let { data, error } = await query;

    // Fallback: if total_elevation_gain or anomaly columns don't exist yet
    if (error && error.message && (error.message.includes('total_elevation_gain') || error.message.includes('is_suspicious') || error.message.includes('manual_'))) {
      hasAnomalyColumns = false;
      let fallbackQuery = supabase
        .from('workouts')
        .select('distance, moving_time, average_pace, average_heartrate, date')
        .eq('user_id', req.user.id);
      if (dateFilter) {
        fallbackQuery = fallbackQuery.gte('date', dateFilter);
      }
      const fallback = await fallbackQuery;
      if (fallback.error) throw fallback.error;
      data = fallback.data;
    } else if (error) {
      throw error;
    }

    // Use manual overrides if user corrected anomaly data
    const getEffectiveDist = (w) => (hasAnomalyColumns && w.manual_distance) ? w.manual_distance : (w.distance || 0);
    const getEffectiveTime = (w) => (hasAnomalyColumns && w.manual_moving_time) ? w.manual_moving_time : (w.moving_time || 0);

    const totalDistance = data.reduce((sum, w) => sum + getEffectiveDist(w), 0);
    const totalTime = data.reduce((sum, w) => sum + getEffectiveTime(w), 0);
    const avgPace = data.length > 0
      ? Math.round(data.reduce((sum, w) => sum + (w.average_pace || 0), 0) / data.length)
      : 0;
    const avgHr = data.filter(w => w.average_heartrate).length > 0
      ? Math.round(data.filter(w => w.average_heartrate).reduce((sum, w) => sum + w.average_heartrate, 0) / data.filter(w => w.average_heartrate).length)
      : 0;
    const bestPace = data.length > 0
      ? Math.min(...data.filter(w => w.average_pace > 0).map(w => w.average_pace))
      : 0;
    const totalElevation = data.reduce((sum, w) => sum + (w.total_elevation_gain || 0), 0);

    res.json({
      totalDistance,
      totalTime,
      avgPace,
      avgHeartrate: avgHr,
      bestPace: bestPace === Infinity ? 0 : bestPace,
      totalElevation: Math.round(totalElevation),
      workoutCount: data.length
    });
  } catch (err) {
    console.error('Stats error:', err.message);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// GET /api/workouts/weekly — daily km for last 7 days
router.get('/weekly', authMiddleware, async (req, res) => {
  try {
    // Use timezone offset from client, default to Moscow (UTC+3)
    const tzOffset = parseInt(req.query.tz) || 3;

    // Get current date in user's timezone
    const nowUtc = new Date();
    const nowLocal = new Date(nowUtc.getTime() + tzOffset * 60 * 60 * 1000);
    const todayStr = nowLocal.toISOString().split('T')[0];

    // Find Monday of current week
    const dayOfWeek = nowLocal.getUTCDay(); // 0=Sun, 1=Mon...
    const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const monday = new Date(nowLocal);
    monday.setUTCDate(monday.getUTCDate() - daysFromMonday);
    monday.setUTCHours(0, 0, 0, 0);

    const mondayStr = monday.toISOString().split('T')[0];

    // Sunday of this week
    const sunday = new Date(monday);
    sunday.setUTCDate(sunday.getUTCDate() + 6);
    const sundayStr = sunday.toISOString().split('T')[0];

    const anomalyFields = hasAnomalyColumns ? ', is_suspicious, user_verified, manual_distance' : '';
    let { data, error } = await supabase
      .from('workouts')
      .select('distance, date' + anomalyFields)
      .eq('user_id', req.user.id)
      .gte('date', mondayStr)
      .lte('date', sundayStr + 'T23:59:59')
      .order('date', { ascending: true });

    // Fallback if anomaly columns missing
    if (error && error.message && (error.message.includes('is_suspicious') || error.message.includes('manual_'))) {
      hasAnomalyColumns = false;
      const fb = await supabase
        .from('workouts')
        .select('distance, date')
        .eq('user_id', req.user.id)
        .gte('date', mondayStr)
        .lte('date', sundayStr + 'T23:59:59')
        .order('date', { ascending: true });
      if (fb.error) throw fb.error;
      data = fb.data;
    } else if (error) {
      throw error;
    }

    const getEffectiveDist = (w) => (hasAnomalyColumns && w.manual_distance) ? w.manual_distance : (w.distance || 0);

    // Group by day (Mon-Sun), use manual distance if corrected
    const dayNames = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setUTCDate(d.getUTCDate() + i);
      const dayStr = d.toISOString().split('T')[0];
      const dayWorkouts = data.filter(w => w.date && w.date.startsWith(dayStr));
      const totalKm = dayWorkouts.reduce((sum, w) => sum + getEffectiveDist(w), 0) / 1000;

      days.push({
        date: dayStr,
        day: dayNames[i],
        km: Math.round(totalKm * 100) / 100
      });
    }

    res.json(days);
  } catch (err) {
    console.error('Weekly error:', err.message);
    res.status(500).json({ error: 'Failed to fetch weekly data' });
  }
});

// GET /api/workouts/comparison — current vs previous month (same day cutoff)
router.get('/comparison', authMiddleware, async (req, res) => {
  try {
    const now = new Date();
    const dayOfMonth = now.getDate();

    // Current month: 1st to today
    const curStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const curEnd = new Date(now.getFullYear(), now.getMonth(), dayOfMonth, 23, 59, 59).toISOString();

    // Previous month: 1st to same day number (clamped to last day of prev month)
    const lastDayPrevMonth = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
    const prevDay = Math.min(dayOfMonth, lastDayPrevMonth);
    const prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
    const prevEnd = new Date(now.getFullYear(), now.getMonth() - 1, prevDay, 23, 59, 59).toISOString();

    const anomalyFields = hasAnomalyColumns ? ', is_suspicious, user_verified, manual_distance, manual_moving_time' : '';
    const selectFields = 'distance, moving_time, average_pace' + anomalyFields;

    let [curRes, prevRes] = await Promise.all([
      supabase.from('workouts').select(selectFields).eq('user_id', req.user.id).gte('date', curStart).lte('date', curEnd),
      supabase.from('workouts').select(selectFields).eq('user_id', req.user.id).gte('date', prevStart).lte('date', prevEnd)
    ]);

    // Fallback if anomaly columns missing
    const hasColError = (e) => e && e.message && (e.message.includes('is_suspicious') || e.message.includes('manual_'));
    if (hasColError(curRes.error) || hasColError(prevRes.error)) {
      hasAnomalyColumns = false;
      [curRes, prevRes] = await Promise.all([
        supabase.from('workouts').select('distance, moving_time, average_pace').eq('user_id', req.user.id).gte('date', curStart).lte('date', curEnd),
        supabase.from('workouts').select('distance, moving_time, average_pace').eq('user_id', req.user.id).gte('date', prevStart).lte('date', prevEnd)
      ]);
    }

    if (curRes.error) throw curRes.error;
    if (prevRes.error) throw prevRes.error;

    const getEffectiveDist = (w) => (hasAnomalyColumns && w.manual_distance) ? w.manual_distance : (w.distance || 0);

    const calcStats = (data) => {
      const distance = data.reduce((s, w) => s + getEffectiveDist(w), 0);
      const workoutCount = data.length;
      const paces = data.filter(w => w.average_pace > 0).map(w => w.average_pace);
      const avgPace = paces.length > 0 ? Math.round(paces.reduce((a, b) => a + b, 0) / paces.length) : 0;
      return { distance, workoutCount, avgPace };
    };

    const current = calcStats(curRes.data || []);
    const previous = calcStats(prevRes.data || []);

    const pctChange = (cur, prev) => prev === 0 ? (cur > 0 ? 100 : 0) : Math.round(((cur - prev) / prev) * 1000) / 10;

    const changes = {
      distance: pctChange(current.distance, previous.distance),
      workoutCount: pctChange(current.workoutCount, previous.workoutCount),
      avgPace: previous.avgPace === 0 ? 0 : Math.round(((current.avgPace - previous.avgPace) / previous.avgPace) * 1000) / 10
    };

    res.json({ current, previous, changes, dayOfMonth });
  } catch (err) {
    console.error('Comparison error:', err.message);
    res.status(500).json({ error: 'Failed to fetch comparison' });
  }
});

// POST /api/workouts/reanalyze — re-run anomaly detection on all existing workouts
router.post('/reanalyze', authMiddleware, async (req, res) => {
  try {
    // First try with anomaly columns
    let allWorkouts, fetchError;
    if (hasAnomalyColumns) {
      const result = await supabase
        .from('workouts')
        .select('id, distance, moving_time, average_pace, splits, is_suspicious, user_verified')
        .eq('user_id', req.user.id);
      allWorkouts = result.data;
      fetchError = result.error;

      if (fetchError && fetchError.message && (fetchError.message.includes('is_suspicious') || fetchError.message.includes('user_verified'))) {
        hasAnomalyColumns = false;
        return res.status(400).json({ error: 'Anomaly columns not in DB yet. Run the SQL migration first.' });
      }
    } else {
      return res.status(400).json({ error: 'Anomaly columns not in DB yet. Run the SQL migration first.' });
    }

    if (fetchError) throw fetchError;
    if (!allWorkouts || allWorkouts.length === 0) {
      return res.json({ updated: 0, total: 0 });
    }

    let updated = 0;
    for (const w of allWorkouts) {
      if (w.user_verified) continue;

      const result = detectAnomalies({
        splits: w.splits,
        average_pace: w.average_pace
      });

      const wasSuspicious = !!w.is_suspicious;
      const nowSuspicious = !!result.is_suspicious;

      if (wasSuspicious !== nowSuspicious || (nowSuspicious && JSON.stringify(w.suspicious_reasons) !== result.suspicious_reasons)) {
        await supabase
          .from('workouts')
          .update({
            is_suspicious: result.is_suspicious,
            suspicious_reasons: result.suspicious_reasons
          })
          .eq('id', w.id);
        updated++;
      }
    }

    res.json({ updated, total: allWorkouts.length });
  } catch (err) {
    console.error('Reanalyze error:', err.message);
    res.status(500).json({ error: 'Failed to reanalyze workouts' });
  }
});

// GET /api/workouts/:id — single workout detail
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('workouts')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Workout not found' });
    }

    res.json(data);
  } catch (err) {
    console.error('Get workout error:', err.message);
    res.status(500).json({ error: 'Failed to fetch workout' });
  }
});

// PATCH /api/workouts/:id — verify or edit a workout (GPS anomaly correction)
router.patch('/:id', authMiddleware, async (req, res) => {
  try {
    if (!hasAnomalyColumns) {
      return res.status(400).json({ error: 'Anomaly columns not in DB yet. Run the SQL migration first.' });
    }

    const { action, manual_distance, manual_moving_time } = req.body;

    if (!action || !['verify', 'edit'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action. Use "verify" or "edit".' });
    }

    const updates = { user_verified: true };

    if (action === 'edit') {
      if (manual_distance == null || manual_moving_time == null) {
        return res.status(400).json({ error: 'manual_distance and manual_moving_time required for edit' });
      }
      updates.manual_distance = Math.round(manual_distance);
      updates.manual_moving_time = Math.round(manual_moving_time);
    }

    const { data, error } = await supabase
      .from('workouts')
      .update(updates)
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Workout not found' });

    res.json(data);
  } catch (err) {
    console.error('Patch workout error:', err.message);
    res.status(500).json({ error: 'Failed to update workout' });
  }
});

// Goals endpoints
// GET /api/workouts/goals/list
router.get('/goals/list', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('goals')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch goals' });
  }
});

// POST /api/workouts/goals
router.post('/goals', authMiddleware, async (req, res) => {
  try {
    const { type, target_value, deadline } = req.body;
    const goalData = {
      user_id: req.user.id,
      type,
      target_value,
      current_value: 0
    };
    if (deadline) goalData.deadline = deadline;
    const { data, error } = await supabase
      .from('goals')
      .insert(goalData)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create goal' });
  }
});

// PUT /api/workouts/goals/:id — update target_value and/or deadline
router.put('/goals/:id', authMiddleware, async (req, res) => {
  try {
    const { target_value, deadline } = req.body;
    const updates = {};
    if (target_value !== undefined) updates.target_value = target_value;
    if (deadline !== undefined) updates.deadline = deadline;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    const { data, error } = await supabase
      .from('goals')
      .update(updates)
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Update goal error:', err.message);
    res.status(500).json({ error: 'Failed to update goal' });
  }
});

// DELETE /api/workouts/goals/:id
router.delete('/goals/:id', authMiddleware, async (req, res) => {
  try {
    const { error } = await supabase
      .from('goals')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete goal' });
  }
});

// GET /api/workouts/goals/predictions
router.get('/goals/predictions', authMiddleware, async (req, res) => {
  try {
    const { data: goals } = await supabase
      .from('goals')
      .select('*')
      .eq('user_id', req.user.id);

    if (!goals || goals.length === 0) {
      return res.json([]);
    }

    // Helper dates
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const dayOfMonth = now.getDate();
    const daysRemainingInMonth = daysInMonth - dayOfMonth;

    // Week start = Monday
    const weekStart = new Date(now);
    const dow = now.getDay(); // 0=Sun
    const dayOfWeek = dow === 0 ? 7 : dow; // 1=Mon..7=Sun
    weekStart.setDate(now.getDate() - (dayOfWeek - 1));
    weekStart.setHours(0, 0, 0, 0);
    const daysRemainingInWeek = 7 - dayOfWeek;

    // Fetch workouts: max(8 weeks ago, monthStart)
    const eightWeeksAgo = new Date();
    eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 56);
    const fourWeeksAgo = new Date();
    fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);
    const fetchFrom = monthStart < eightWeeksAgo ? monthStart : eightWeeksAgo;

    let { data: recentWorkouts, error: recentError } = await supabase
      .from('workouts')
      .select('distance, moving_time, average_pace, date, best_efforts' + (hasAnomalyColumns ? ', is_suspicious, user_verified, manual_distance, manual_moving_time' : ''))
      .eq('user_id', req.user.id)
      .gte('date', fetchFrom.toISOString())
      .order('date', { ascending: true });

    // Fallback if anomaly columns missing
    if (recentError && recentError.message && (recentError.message.includes('is_suspicious') || recentError.message.includes('user_verified') || recentError.message.includes('manual_'))) {
      hasAnomalyColumns = false;
      const fb = await supabase
        .from('workouts')
        .select('distance, moving_time, average_pace, date, best_efforts')
        .eq('user_id', req.user.id)
        .gte('date', fetchFrom.toISOString())
        .order('date', { ascending: true });
      if (fb.error) throw fb.error;
      recentWorkouts = fb.data;
    } else if (recentError) {
      throw recentError;
    }

    const workoutsArr = recentWorkouts || [];

    // Helper: get effective distance (manual override or original)
    const getEffectiveDistance = (w) => (hasAnomalyColumns && w.manual_distance) ? w.manual_distance : (w.distance || 0);
    // Helper: check if workout is suspicious and unverified (should be excluded from PB calcs)
    const isSuspiciousUnverified = (w) => hasAnomalyColumns && w.is_suspicious && !w.user_verified;

    // Pre-filter workouts for current month and current week
    // All workouts shown as-is, but use manual_distance if user corrected anomaly
    // Only PB/Riegel calculations exclude unverified anomalies
    const monthWorkouts = workoutsArr.filter(w => new Date(w.date) >= monthStart);
    const weekWorkouts = workoutsArr.filter(w => new Date(w.date) >= weekStart);

    const fmtTime = (s) => {
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = Math.round(s % 60);
      return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}` : `${m}:${sec.toString().padStart(2, '0')}`;
    };

    const predictions = goals.map(goal => {
      const prediction = { goalId: goal.id, type: goal.type };

      if (goal.type === 'monthly_distance') {
        const targetKm = goal.target_value / 1000;
        const computedCurrentValue = monthWorkouts.reduce((s, w) => s + getEffectiveDistance(w), 0);
        const currentKm = Math.round((computedCurrentValue / 1000) * 10) / 10;

        prediction.computedCurrentValue = computedCurrentValue;

        if (currentKm >= targetKm) {
          prediction.percent = 100;
          prediction.onTrack = true;
          prediction.message = `Цель достигнута! Пробежал ${currentKm} из ${targetKm} км`;
        } else if (monthWorkouts.length === 0) {
          prediction.percent = 0;
          prediction.onTrack = false;
          prediction.message = 'Пока нет пробежек в этом месяце';
        } else {
          const projection = dayOfMonth > 0 ? (currentKm / dayOfMonth) * daysInMonth : 0;
          const remaining = Math.round((targetKm - currentKm) * 10) / 10;

          if (daysRemainingInMonth === 0) {
            prediction.percent = Math.min(100, Math.round((currentKm / targetKm) * 100));
            prediction.onTrack = currentKm >= targetKm * 0.9;
            prediction.message = `Сегодня последний день! Пробежал ${currentKm} из ${targetKm} км`;
          } else {
            const dailyNeeded = Math.round((remaining / daysRemainingInMonth) * 10) / 10;
            prediction.percent = Math.min(100, Math.round((currentKm / targetKm) * 100));
            prediction.onTrack = projection >= targetKm * 0.9;
            prediction.message = `Пробежал ${currentKm} из ${targetKm} км, осталось ${daysRemainingInMonth} дн. — нужно ещё ${dailyNeeded} км/день`;
          }
        }

      } else if (goal.type === 'weekly_distance') {
        const targetKm = goal.target_value / 1000;
        const computedCurrentValue = weekWorkouts.reduce((s, w) => s + getEffectiveDistance(w), 0);
        const currentKm = Math.round((computedCurrentValue / 1000) * 10) / 10;

        prediction.computedCurrentValue = computedCurrentValue;

        if (currentKm >= targetKm) {
          prediction.percent = 100;
          prediction.onTrack = true;
          prediction.message = `Цель достигнута! Пробежал ${currentKm} из ${targetKm} км на этой неделе`;
        } else if (weekWorkouts.length === 0) {
          prediction.percent = 0;
          prediction.onTrack = false;
          prediction.message = 'Пока нет пробежек на этой неделе';
        } else {
          const remaining = Math.round((targetKm - currentKm) * 10) / 10;
          const projection = dayOfWeek > 0 ? (currentKm / dayOfWeek) * 7 : 0;

          if (daysRemainingInWeek === 0) {
            prediction.percent = Math.min(100, Math.round((currentKm / targetKm) * 100));
            prediction.onTrack = currentKm >= targetKm * 0.9;
            prediction.message = `Сегодня воскресенье! Пробежал ${currentKm} из ${targetKm} км`;
          } else {
            const dailyNeeded = Math.round((remaining / daysRemainingInWeek) * 10) / 10;
            prediction.percent = Math.min(100, Math.round((currentKm / targetKm) * 100));
            prediction.onTrack = projection >= targetKm * 0.9;
            prediction.message = `Пробежал ${currentKm} из ${targetKm} км на этой неделе, нужно ещё ${dailyNeeded} км/день`;
          }
        }

      } else if (['pb_5k', 'pb_10k', 'pb_21k', 'pb_42k'].includes(goal.type)) {
        const distMap = { pb_5k: 5, pb_10k: 10, pb_21k: 21.1, pb_42k: 42.2 };
        const targetDist = distMap[goal.type]; // km
        const targetDistM = targetDist * 1000; // meters
        const targetTimeSec = goal.target_value;

        const bestEffortNameMap = { pb_5k: '5K', pb_10k: '10K', pb_21k: 'Half-Marathon', pb_42k: 'Marathon' };
        const targetBEName = bestEffortNameMap[goal.type];

        const fmtDate = (d) => new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });

        // Breakdown — full details for the info modal
        const breakdown = {
          period: '4 недели',
          targetDist,
          riegelWorkouts: [],   // all Riegel calculations
          bestEffort: null,     // Strava clean split
          discardedBE: null,    // GPS glitch that was rejected
          chosen: null,         // final decision explanation
        };

        // --- Step 1: Riegel baseline from last 4 weeks ---
        // Exclude suspicious unverified workouts from Riegel calculations
        const recentWorkouts = workoutsArr.filter(w => new Date(w.date) >= fourWeeksAgo);
        const relevantForRiegel = recentWorkouts.filter(w => {
          if (isSuspiciousUnverified(w)) return false;
          const km = w.distance / 1000;
          return km >= targetDist * 0.3 && km <= targetDist * 2.0 && w.moving_time > 0 && w.distance > 0;
        });

        // Calculate Riegel for each workout, keep source info
        const riegelResults = relevantForRiegel.map(w => {
          const rTime = w.moving_time * Math.pow(targetDistM / w.distance, 1.06);
          return {
            time: rTime,
            timeFormatted: fmtTime(Math.round(rTime)),
            distKm: Math.round(w.distance / 100) / 10,
            date: w.date,
            dateFormatted: fmtDate(w.date),
            movingTime: w.moving_time,
            movingTimeFormatted: fmtTime(w.moving_time),
          };
        }).sort((a, b) => a.time - b.time);

        breakdown.riegelWorkouts = riegelResults.map(r => ({
          date: r.dateFormatted,
          dist: r.distKm + ' км',
          actualTime: r.movingTimeFormatted,
          riegelTime: r.timeFormatted,
        }));

        // Median of top-3 Riegel estimates
        let riegelEstimate = null;
        let riegelBasis = null;
        if (riegelResults.length > 0) {
          const top3 = riegelResults.slice(0, Math.min(3, riegelResults.length));
          const medianIdx = Math.floor(top3.length / 2);
          riegelEstimate = Math.round(
            top3.length % 2 === 1 ? top3[medianIdx].time : (top3[medianIdx - 1].time + top3[medianIdx].time) / 2
          );
          riegelBasis = top3[medianIdx];
        }

        // --- Step 2: Best efforts from Strava (clean split) with sanity check ---
        // Exclude suspicious unverified workouts from best efforts too
        let bestEffort = null;
        for (const w of recentWorkouts) {
          if (!w.best_efforts) continue;
          if (isSuspiciousUnverified(w)) continue;
          const efforts = typeof w.best_efforts === 'string' ? JSON.parse(w.best_efforts) : w.best_efforts;
          for (const e of efforts) {
            if (e.name === targetBEName && e.moving_time > 0) {
              if (!bestEffort || e.moving_time < bestEffort.time) {
                bestEffort = { time: e.moving_time, date: w.date };
              }
            }
          }
        }

        if (bestEffort) {
          breakdown.bestEffort = {
            time: fmtTime(Math.round(bestEffort.time)),
            date: fmtDate(bestEffort.date),
          };
        }

        // Sanity check: if best_effort is >15% faster than Riegel median — GPS glitch, discard
        let bestEffortDiscarded = false;
        if (bestEffort && riegelEstimate) {
          if (bestEffort.time < riegelEstimate * 0.85) {
            breakdown.discardedBE = {
              time: fmtTime(Math.round(bestEffort.time)),
              date: fmtDate(bestEffort.date),
              reason: `На ${Math.round((1 - bestEffort.time / riegelEstimate) * 100)}% быстрее расчёта — вероятно GPS-глюк`,
            };
            bestEffort = null;
            bestEffortDiscarded = true;
          }
        }

        // --- Step 3: Pick best source ---
        let finalTime = null;
        let source = null;

        if (bestEffort && riegelEstimate) {
          if (bestEffort.time <= riegelEstimate) {
            finalTime = Math.round(bestEffort.time);
            source = 'best_effort';
            breakdown.chosen = {
              source: 'Strava-сплит',
              reason: `${targetBEName}-сплит (${fmtTime(finalTime)}) быстрее расчёта Ригеля (${fmtTime(riegelEstimate)})`,
            };
          } else {
            finalTime = riegelEstimate;
            source = 'riegel';
            breakdown.chosen = {
              source: 'Формула Ригеля',
              reason: `Расчёт по тренировке ${riegelBasis.distKm} км от ${riegelBasis.dateFormatted} (${fmtTime(riegelEstimate)}) быстрее сплита (${fmtTime(Math.round(bestEffort.time))})`,
            };
          }
        } else if (bestEffort) {
          finalTime = Math.round(bestEffort.time);
          source = 'best_effort';
          breakdown.chosen = {
            source: 'Strava-сплит',
            reason: `Нет подходящих тренировок для Ригеля, используется ${targetBEName}-сплит`,
          };
        } else if (riegelEstimate) {
          finalTime = riegelEstimate;
          source = 'riegel';
          const beNote = bestEffortDiscarded ? ', Strava-сплит отсечён как GPS-глюк' : ', Strava-сплит не найден';
          breakdown.chosen = {
            source: 'Формула Ригеля',
            reason: `Медиана топ-3 по тренировке ${riegelBasis.distKm} км от ${riegelBasis.dateFormatted}${beNote}`,
          };
        }

        if (finalTime) {
          prediction.computedCurrentValue = finalTime;
          prediction.estimatedTime = finalTime;
          prediction.targetTime = targetTimeSec;
          prediction.gap = finalTime - targetTimeSec;
          prediction.percent = Math.min(100, Math.round((targetTimeSec / finalTime) * 100));
          prediction.onTrack = finalTime <= targetTimeSec * 1.05;
          prediction.source = source;
          prediction.breakdown = breakdown;

          if (finalTime <= targetTimeSec) {
            prediction.message = `Цель достижима! ~${fmtTime(finalTime)}`;
          } else {
            prediction.message = `~${fmtTime(finalTime)} → цель ${fmtTime(targetTimeSec)}`;
          }
        } else {
          prediction.message = `Нет тренировок за 4 недели (~${targetDist} км)`;
          prediction.percent = 0;
          prediction.computedCurrentValue = 0;
        }

      } else if (goal.type === 'monthly_runs') {
        const currentRuns = monthWorkouts.length;
        const target = goal.target_value;

        prediction.computedCurrentValue = currentRuns;

        if (currentRuns >= target) {
          prediction.percent = 100;
          prediction.onTrack = true;
          prediction.message = `Цель достигнута! ${currentRuns} из ${target} пробежек`;
        } else if (currentRuns === 0) {
          prediction.percent = 0;
          prediction.onTrack = false;
          prediction.message = 'Пока нет пробежек в этом месяце';
        } else {
          const remaining = target - currentRuns;

          if (daysRemainingInMonth === 0) {
            prediction.percent = Math.min(100, Math.round((currentRuns / target) * 100));
            prediction.onTrack = currentRuns >= target * 0.9;
            prediction.message = `Сегодня последний день! ${currentRuns} из ${target} пробежек`;
          } else {
            const projection = (currentRuns / dayOfMonth) * daysInMonth;
            const runsPerDay = Math.round((remaining / daysRemainingInMonth) * 10) / 10;
            prediction.percent = Math.min(100, Math.round((currentRuns / target) * 100));
            prediction.onTrack = projection >= target * 0.9;
            prediction.message = `${currentRuns} из ${target} пробежек в этом месяце, нужно ещё ${remaining} (${runsPerDay}/день)`;
          }
        }

      } else {
        prediction.message = '';
        prediction.percent = 0;
        prediction.computedCurrentValue = 0;
      }

      return prediction;
    });

    res.json(predictions);
  } catch (err) {
    console.error('Predictions error:', err.message);
    res.status(500).json({ error: 'Failed to calculate predictions' });
  }
});

module.exports = router;
