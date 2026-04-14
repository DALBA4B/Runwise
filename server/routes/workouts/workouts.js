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

// GET /api/workouts/weekly — daily km for last 7 days
router.get('/weekly', authMiddleware, async (req, res) => {
  try {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const monday = new Date(now);
    monday.setDate(monday.getDate() - daysFromMonday);
    monday.setHours(0, 0, 0, 0);

    const anomalyFields = state.hasAnomalyColumns ? ', is_suspicious, manual_distance' : '';
    let { data, error } = await supabase
      .from('workouts')
      .select('distance, date' + anomalyFields)
      .eq('user_id', req.user.id)
      .gte('date', monday.toISOString())
      .order('date', { ascending: true });

    if (error && error.message && (error.message.includes('is_suspicious') || error.message.includes('manual_'))) {
      state.hasAnomalyColumns = false;
      const fb = await supabase
        .from('workouts')
        .select('distance, date')
        .eq('user_id', req.user.id)
        .gte('date', monday.toISOString())
        .order('date', { ascending: true });
      if (fb.error) throw fb.error;
      data = fb.data;
    } else if (error) {
      throw error;
    }

    const days = [];
    const dayLabels = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setDate(d.getDate() + i);
      const dateStr = d.toISOString().split('T')[0];
      const dayWorkouts = (data || []).filter(w => w.date && w.date.startsWith(dateStr));
      const km = dayWorkouts.reduce((s, w) => {
        const dist = (state.hasAnomalyColumns && w.manual_distance) ? w.manual_distance : (w.distance || 0);
        return s + dist / 1000;
      }, 0);
      days.push({ day: dayLabels[i], km: Math.round(km * 100) / 100 });
    }

    res.json(days);
  } catch (err) {
    console.error('Weekly error:', err.message);
    res.status(500).json({ error: 'Failed to fetch weekly data' });
  }
});

// GET /api/workouts/comparison — compare current week vs previous
router.get('/comparison', authMiddleware, async (req, res) => {
  try {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

    const thisMonday = new Date(now);
    thisMonday.setDate(thisMonday.getDate() - daysFromMonday);
    thisMonday.setHours(0, 0, 0, 0);

    const prevMonday = new Date(thisMonday);
    prevMonday.setDate(prevMonday.getDate() - 7);

    const anomalyFields = state.hasAnomalyColumns ? ', is_suspicious, manual_distance, manual_moving_time' : '';
    let { data, error } = await supabase
      .from('workouts')
      .select('distance, moving_time, average_pace, date' + anomalyFields)
      .eq('user_id', req.user.id)
      .gte('date', prevMonday.toISOString())
      .order('date', { ascending: true });

    if (error && error.message && (error.message.includes('is_suspicious') || error.message.includes('manual_'))) {
      state.hasAnomalyColumns = false;
      const fb = await supabase
        .from('workouts')
        .select('distance, moving_time, average_pace, date')
        .eq('user_id', req.user.id)
        .gte('date', prevMonday.toISOString())
        .order('date', { ascending: true });
      if (fb.error) throw fb.error;
      data = fb.data;
    } else if (error) {
      throw error;
    }

    const getEffDist = (w) => (state.hasAnomalyColumns && w.manual_distance) ? w.manual_distance : (w.distance || 0);
    const getEffTime = (w) => (state.hasAnomalyColumns && w.manual_moving_time) ? w.manual_moving_time : (w.moving_time || 0);

    const thisWeek = (data || []).filter(w => new Date(w.date) >= thisMonday);
    const prevWeek = (data || []).filter(w => new Date(w.date) >= prevMonday && new Date(w.date) < thisMonday);

    const calcStats = (workouts) => ({
      distance: workouts.reduce((s, w) => s + getEffDist(w), 0),
      time: workouts.reduce((s, w) => s + getEffTime(w), 0),
      runs: workouts.length,
      avgPace: workouts.length > 0
        ? Math.round(workouts.reduce((s, w) => s + (w.average_pace || 0), 0) / workouts.length)
        : 0
    });

    res.json({
      thisWeek: calcStats(thisWeek),
      prevWeek: calcStats(prevWeek)
    });
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

// PATCH /api/workouts/:id — update workout (manual corrections)
router.patch('/:id', authMiddleware, async (req, res) => {
  try {
    const allowedFields = ['manual_distance', 'manual_moving_time', 'user_verified', 'is_suspicious'];
    const updates = {};
    for (const key of allowedFields) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    const { data, error } = await supabase
      .from('workouts')
      .update(updates)
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Patch workout error:', err.message);
    res.status(500).json({ error: 'Failed to update workout' });
  }
});

module.exports = router;
