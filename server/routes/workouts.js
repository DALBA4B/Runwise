const express = require('express');
const supabase = require('../supabase');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

// GET /api/workouts — all workouts for user
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { month, year, limit } = req.query;
    let query = supabase
      .from('workouts')
      .select('id, strava_id, name, distance, moving_time, average_pace, average_heartrate, max_heartrate, date, type, splits')
      .eq('user_id', req.user.id)
      .order('date', { ascending: false });

    if (month && year) {
      const startDate = new Date(year, month - 1, 1).toISOString();
      const endDate = new Date(year, month, 0, 23, 59, 59).toISOString();
      query = query.gte('date', startDate).lte('date', endDate);
    }

    if (limit) {
      query = query.limit(parseInt(limit));
    }

    const { data, error } = await query;
    if (error) throw error;

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

    // Try with elevation column, fallback without if column doesn't exist yet
    let query = supabase
      .from('workouts')
      .select('distance, moving_time, average_pace, average_heartrate, total_elevation_gain, date')
      .eq('user_id', req.user.id);

    if (dateFilter) {
      query = query.gte('date', dateFilter);
    }

    let { data, error } = await query;

    // Fallback: if total_elevation_gain column doesn't exist yet
    if (error && error.message && error.message.includes('total_elevation_gain')) {
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

    const totalDistance = data.reduce((sum, w) => sum + (w.distance || 0), 0);
    const totalTime = data.reduce((sum, w) => sum + (w.moving_time || 0), 0);
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

    const { data, error } = await supabase
      .from('workouts')
      .select('distance, date')
      .eq('user_id', req.user.id)
      .gte('date', mondayStr)
      .lte('date', sundayStr + 'T23:59:59')
      .order('date', { ascending: true });

    if (error) throw error;

    // Group by day (Mon-Sun)
    const dayNames = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setUTCDate(d.getUTCDate() + i);
      const dayStr = d.toISOString().split('T')[0];
      const dayWorkouts = data.filter(w => w.date && w.date.startsWith(dayStr));
      const totalKm = dayWorkouts.reduce((sum, w) => sum + (w.distance || 0), 0) / 1000;

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

// GET /api/workouts/comparison — current vs previous month
router.get('/comparison', authMiddleware, async (req, res) => {
  try {
    const now = new Date();
    const curStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const curEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).toISOString();
    const prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
    const prevEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59).toISOString();

    const [curRes, prevRes] = await Promise.all([
      supabase.from('workouts').select('distance, moving_time, average_pace').eq('user_id', req.user.id).gte('date', curStart).lte('date', curEnd),
      supabase.from('workouts').select('distance, moving_time, average_pace').eq('user_id', req.user.id).gte('date', prevStart).lte('date', prevEnd)
    ]);

    if (curRes.error) throw curRes.error;
    if (prevRes.error) throw prevRes.error;

    const calcStats = (data) => {
      const distance = data.reduce((s, w) => s + (w.distance || 0), 0);
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

    res.json({ current, previous, changes });
  } catch (err) {
    console.error('Comparison error:', err.message);
    res.status(500).json({ error: 'Failed to fetch comparison' });
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

    // Get last 8 weeks of workouts for trend analysis
    const eightWeeksAgo = new Date();
    eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 56);

    const { data: recentWorkouts } = await supabase
      .from('workouts')
      .select('distance, moving_time, average_pace, date')
      .eq('user_id', req.user.id)
      .gte('date', eightWeeksAgo.toISOString())
      .order('date', { ascending: true });

    const workoutsArr = recentWorkouts || [];

    const predictions = goals.map(goal => {
      const prediction = { goalId: goal.id, type: goal.type };

      if (['monthly_distance', 'weekly_distance'].includes(goal.type)) {
        // Calculate weekly volume trend
        const weeks = [];
        for (let w = 0; w < 8; w++) {
          const start = new Date();
          start.setDate(start.getDate() - (w + 1) * 7);
          const end = new Date();
          end.setDate(end.getDate() - w * 7);
          const weekKm = workoutsArr
            .filter(wr => { const d = new Date(wr.date); return d >= start && d < end; })
            .reduce((s, wr) => s + (wr.distance || 0), 0) / 1000;
          weeks.unshift(weekKm);
        }

        const recentWeeks = weeks.slice(-4);
        const avgWeeklyKm = recentWeeks.reduce((a, b) => a + b, 0) / recentWeeks.length;
        const targetKm = goal.target_value / 1000;

        if (goal.type === 'weekly_distance') {
          prediction.currentRate = Math.round(avgWeeklyKm * 10) / 10;
          prediction.targetRate = Math.round(targetKm * 10) / 10;
          prediction.onTrack = avgWeeklyKm >= targetKm * 0.9;
          prediction.percent = Math.min(100, Math.round((avgWeeklyKm / targetKm) * 100));
          prediction.message = avgWeeklyKm >= targetKm
            ? `В среднем ${prediction.currentRate} км/нед — цель достигнута!`
            : `В среднем ${prediction.currentRate} км/нед, нужно ${prediction.targetRate} км/нед`;
        } else {
          const avgMonthlyKm = avgWeeklyKm * 4.33;
          prediction.currentRate = Math.round(avgMonthlyKm * 10) / 10;
          prediction.targetRate = Math.round(targetKm * 10) / 10;
          prediction.onTrack = avgMonthlyKm >= targetKm * 0.9;
          prediction.percent = Math.min(100, Math.round((avgMonthlyKm / targetKm) * 100));
          prediction.message = avgMonthlyKm >= targetKm
            ? `В среднем ${prediction.currentRate} км/мес — цель достигнута!`
            : `В среднем ${prediction.currentRate} км/мес, нужно ${prediction.targetRate} км/мес`;
        }

      } else if (['pb_5k', 'pb_10k', 'pb_21k', 'pb_42k'].includes(goal.type)) {
        // Pace-based goals — estimate from recent pace improvement
        const distMap = { pb_5k: 5, pb_10k: 10, pb_21k: 21.1, pb_42k: 42.2 };
        const targetDist = distMap[goal.type];
        const targetTimeSec = goal.target_value; // seconds

        // Find workouts close to this distance (within 20%)
        const relevantWorkouts = workoutsArr.filter(w => {
          const km = w.distance / 1000;
          return km >= targetDist * 0.8 && km <= targetDist * 1.2;
        });

        // Get best pace from all recent workouts
        const paces = workoutsArr
          .filter(w => w.average_pace > 0)
          .map(w => w.average_pace);

        if (paces.length > 0) {
          const bestPace = Math.min(...paces);
          const estimatedTime = Math.round(bestPace * targetDist);

          prediction.estimatedTime = estimatedTime;
          prediction.targetTime = targetTimeSec;
          prediction.gap = estimatedTime - targetTimeSec;
          prediction.percent = Math.min(100, Math.round((targetTimeSec / estimatedTime) * 100));
          prediction.onTrack = estimatedTime <= targetTimeSec * 1.05;

          // Format times
          const fmtTime = (s) => {
            const h = Math.floor(s / 3600);
            const m = Math.floor((s % 3600) / 60);
            const sec = Math.round(s % 60);
            return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}` : `${m}:${sec.toString().padStart(2, '0')}`;
          };

          prediction.message = `Прогноз ~${fmtTime(estimatedTime)}`;

          // Trend from pace improvement
          const recentPaces = workoutsArr.slice(-5).filter(w => w.average_pace > 0).map(w => w.average_pace);
          const olderPaces = workoutsArr.slice(0, 5).filter(w => w.average_pace > 0).map(w => w.average_pace);
          if (recentPaces.length > 0 && olderPaces.length > 0) {
            const avgRecent = recentPaces.reduce((a, b) => a + b, 0) / recentPaces.length;
            const avgOlder = olderPaces.reduce((a, b) => a + b, 0) / olderPaces.length;
            prediction.trend = Math.round(((avgOlder - avgRecent) / avgOlder) * 100);
          }
        } else {
          prediction.message = 'Недостаточно данных для прогноза';
          prediction.percent = 0;
        }
      } else {
        prediction.message = '';
        prediction.percent = 0;
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
