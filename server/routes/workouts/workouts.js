const express = require('express');
const supabase = require('../../supabase');
const authMiddleware = require('../../middleware/authMiddleware');
const { detectAnomalies } = require('../strava');
const state = require('./state');

const router = express.Router();

const WORKOUTS_BASE_FIELDS = 'id, strava_id, name, distance, moving_time, average_pace, average_heartrate, max_heartrate, date, type, splits';
const WORKOUTS_ANOMALY_FIELDS = ', is_suspicious, user_verified, manual_distance, manual_moving_time';

// GET /api/workouts — all workouts for user
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

    let { data, error } = await buildQuery(WORKOUTS_BASE_FIELDS + (state.hasAnomalyColumns ? WORKOUTS_ANOMALY_FIELDS : ''));

    // Fallback: if anomaly columns don't exist yet
    if (error && error.message && (error.message.includes('is_suspicious') || error.message.includes('user_verified') || error.message.includes('manual_'))) {
      state.hasAnomalyColumns = false;
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
      const dayOfWeek = now.getDay();
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

    const anomalyFields = state.hasAnomalyColumns ? ', is_suspicious, user_verified, manual_distance, manual_moving_time' : '';
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
      state.hasAnomalyColumns = false;
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

    const getEffectiveDist = (w) => (state.hasAnomalyColumns && w.manual_distance) ? w.manual_distance : (w.distance || 0);
    const getEffectiveTime = (w) => (state.hasAnomalyColumns && w.manual_moving_time) ? w.manual_moving_time : (w.moving_time || 0);

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

// GET /api/workouts/weekly — daily km for current week (timezone-aware)
router.get('/weekly', authMiddleware, async (req, res) => {
  try {
    // Use timezone offset from client, default to Moscow (UTC+3)
    const tzOffset = parseInt(req.query.tz) || 3;

    // Get current date in user's timezone
    const nowUtc = new Date();
    const nowLocal = new Date(nowUtc.getTime() + tzOffset * 60 * 60 * 1000);

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

    const anomalyFields = state.hasAnomalyColumns ? ', is_suspicious, user_verified, manual_distance' : '';
    let { data, error } = await supabase
      .from('workouts')
      .select('distance, date' + anomalyFields)
      .eq('user_id', req.user.id)
      .gte('date', mondayStr)
      .lte('date', sundayStr + 'T23:59:59')
      .order('date', { ascending: true });

    // Fallback if anomaly columns missing
    if (error && error.message && (error.message.includes('is_suspicious') || error.message.includes('manual_'))) {
      state.hasAnomalyColumns = false;
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

    const getEffectiveDist = (w) => (state.hasAnomalyColumns && w.manual_distance) ? w.manual_distance : (w.distance || 0);

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

    const anomalyFields = state.hasAnomalyColumns ? ', is_suspicious, user_verified, manual_distance, manual_moving_time' : '';
    const selectFields = 'distance, moving_time, average_pace, average_heartrate' + anomalyFields;

    let [curRes, prevRes] = await Promise.all([
      supabase.from('workouts').select(selectFields).eq('user_id', req.user.id).gte('date', curStart).lte('date', curEnd),
      supabase.from('workouts').select(selectFields).eq('user_id', req.user.id).gte('date', prevStart).lte('date', prevEnd)
    ]);

    // Fallback if anomaly columns missing
    const hasColError = (e) => e && e.message && (e.message.includes('is_suspicious') || e.message.includes('manual_'));
    if (hasColError(curRes.error) || hasColError(prevRes.error)) {
      state.hasAnomalyColumns = false;
      [curRes, prevRes] = await Promise.all([
        supabase.from('workouts').select('distance, moving_time, average_pace').eq('user_id', req.user.id).gte('date', curStart).lte('date', curEnd),
        supabase.from('workouts').select('distance, moving_time, average_pace').eq('user_id', req.user.id).gte('date', prevStart).lte('date', prevEnd)
      ]);
    }

    if (curRes.error) throw curRes.error;
    if (prevRes.error) throw prevRes.error;

    const getEffectiveDist = (w) => (state.hasAnomalyColumns && w.manual_distance) ? w.manual_distance : (w.distance || 0);

    const calcStats = (data) => {
      const distance = data.reduce((s, w) => s + getEffectiveDist(w), 0);
      const workoutCount = data.length;
      const paces = data.filter(w => w.average_pace > 0).map(w => w.average_pace);
      const avgPace = paces.length > 0 ? Math.round(paces.reduce((a, b) => a + b, 0) / paces.length) : 0;
      // Cardiac Efficiency: avg(pace / HR) for workouts with both
      const ceWorkouts = data.filter(w => w.average_pace > 0 && w.average_heartrate > 0);
      const avgCE = ceWorkouts.length > 0
        ? Math.round(ceWorkouts.reduce((s, w) => s + w.average_pace / w.average_heartrate, 0) / ceWorkouts.length * 100) / 100
        : null;
      return { distance, workoutCount, avgPace, avgCE };
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
    let allWorkouts, fetchError;
    if (state.hasAnomalyColumns) {
      const result = await supabase
        .from('workouts')
        .select('id, distance, moving_time, average_pace, splits, is_suspicious, user_verified')
        .eq('user_id', req.user.id);
      allWorkouts = result.data;
      fetchError = result.error;

      if (fetchError && fetchError.message && (fetchError.message.includes('is_suspicious') || fetchError.message.includes('user_verified'))) {
        state.hasAnomalyColumns = false;
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

// PATCH /api/workouts/:id — verify or edit workout (manual corrections)
router.patch('/:id', authMiddleware, async (req, res) => {
  try {
    if (!state.hasAnomalyColumns) {
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

module.exports = router;
