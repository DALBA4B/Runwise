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
    const fetchFrom = monthStart < eightWeeksAgo ? monthStart : eightWeeksAgo;

    const { data: recentWorkouts } = await supabase
      .from('workouts')
      .select('distance, moving_time, average_pace, date, best_efforts')
      .eq('user_id', req.user.id)
      .gte('date', fetchFrom.toISOString())
      .order('date', { ascending: true });

    const workoutsArr = recentWorkouts || [];

    // Pre-filter workouts for current month and current week
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
        const computedCurrentValue = monthWorkouts.reduce((s, w) => s + (w.distance || 0), 0);
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
        const computedCurrentValue = weekWorkouts.reduce((s, w) => s + (w.distance || 0), 0);
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

        // Strava best_efforts name mapping
        const bestEffortNameMap = { pb_5k: '5K', pb_10k: '10K', pb_21k: 'Half-Marathon', pb_42k: 'Marathon' };
        const targetBEName = bestEffortNameMap[goal.type];

        // --- Priority 1: Strava best_efforts ---
        let bestEffortTime = null;
        for (const w of workoutsArr) {
          if (!w.best_efforts) continue;
          const efforts = typeof w.best_efforts === 'string' ? JSON.parse(w.best_efforts) : w.best_efforts;
          for (const e of efforts) {
            if (e.name === targetBEName && e.moving_time > 0) {
              if (bestEffortTime === null || e.moving_time < bestEffortTime) {
                bestEffortTime = e.moving_time;
              }
            }
          }
        }

        if (bestEffortTime !== null) {
          prediction.computedCurrentValue = bestEffortTime;
          prediction.estimatedTime = bestEffortTime;
          prediction.targetTime = targetTimeSec;
          prediction.gap = bestEffortTime - targetTimeSec;
          prediction.percent = Math.min(100, Math.round((targetTimeSec / bestEffortTime) * 100));
          prediction.onTrack = bestEffortTime <= targetTimeSec * 1.05;
          prediction.source = 'best_effort';

          prediction.message = bestEffortTime <= targetTimeSec
            ? `Цель достигнута! Лучший результат ${fmtTime(bestEffortTime)}`
            : `Лучший результат ${fmtTime(bestEffortTime)}, цель ${fmtTime(targetTimeSec)}`;
        } else {
          // --- Priority 2: Riegel formula from relevant workouts (±30% distance) ---
          const relevantWorkouts = workoutsArr.filter(w => {
            const km = w.distance / 1000;
            return km >= targetDist * 0.5 && km <= targetDist * 1.5 && w.moving_time > 0 && w.distance > 0;
          });

          if (relevantWorkouts.length > 0) {
            // Riegel: T2 = T1 * (D2 / D1) ^ 1.06
            let bestRiegelTime = Infinity;
            for (const w of relevantWorkouts) {
              const riegelTime = w.moving_time * Math.pow(targetDistM / w.distance, 1.06);
              if (riegelTime < bestRiegelTime) {
                bestRiegelTime = riegelTime;
              }
            }
            bestRiegelTime = Math.round(bestRiegelTime);

            // computedCurrentValue = best moving_time from workouts close to target distance (±20%)
            const closeWorkouts = relevantWorkouts.filter(w => {
              const km = w.distance / 1000;
              return km >= targetDist * 0.8 && km <= targetDist * 1.2;
            });
            const closeTimes = closeWorkouts.filter(w => w.moving_time > 0).map(w => w.moving_time);
            prediction.computedCurrentValue = closeTimes.length > 0 ? Math.min(...closeTimes) : 0;

            prediction.estimatedTime = bestRiegelTime;
            prediction.targetTime = targetTimeSec;
            prediction.gap = bestRiegelTime - targetTimeSec;
            prediction.percent = Math.min(100, Math.round((targetTimeSec / bestRiegelTime) * 100));
            prediction.onTrack = bestRiegelTime <= targetTimeSec * 1.05;
            prediction.source = 'riegel';

            prediction.message = bestRiegelTime <= targetTimeSec
              ? `Цель достигнута! Прогноз ~${fmtTime(bestRiegelTime)}`
              : `Прогноз ~${fmtTime(bestRiegelTime)}, цель ${fmtTime(targetTimeSec)}`;

            // Trend from pace improvement
            const recentPaces = relevantWorkouts.slice(-5).filter(w => w.average_pace > 0).map(w => w.average_pace);
            const olderPaces = relevantWorkouts.slice(0, 5).filter(w => w.average_pace > 0).map(w => w.average_pace);
            if (recentPaces.length > 0 && olderPaces.length > 0) {
              const avgRecent = recentPaces.reduce((a, b) => a + b, 0) / recentPaces.length;
              const avgOlder = olderPaces.reduce((a, b) => a + b, 0) / olderPaces.length;
              prediction.trend = Math.round(((avgOlder - avgRecent) / avgOlder) * 100);
            }
          } else {
            // --- No data at all ---
            prediction.message = `Нет тренировок на подходящей дистанции (~${targetDist} км)`;
            prediction.percent = 0;
            prediction.computedCurrentValue = 0;
          }
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
