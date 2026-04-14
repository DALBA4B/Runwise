const express = require('express');
const supabase = require('../../supabase');
const authMiddleware = require('../../middleware/authMiddleware');
const state = require('./state');

const router = express.Router();

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
      .select('distance, moving_time, average_pace, date, best_efforts' + (state.hasAnomalyColumns ? ', is_suspicious, user_verified, manual_distance, manual_moving_time' : ''))
      .eq('user_id', req.user.id)
      .gte('date', fetchFrom.toISOString())
      .order('date', { ascending: true });

    // Fallback if anomaly columns missing
    if (recentError && recentError.message && (recentError.message.includes('is_suspicious') || recentError.message.includes('user_verified') || recentError.message.includes('manual_'))) {
      state.hasAnomalyColumns = false;
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
    const getEffectiveDistance = (w) => (state.hasAnomalyColumns && w.manual_distance) ? w.manual_distance : (w.distance || 0);
    // Helper: check if workout is suspicious and unverified (should be excluded from PB calcs)
    const isSuspiciousUnverified = (w) => state.hasAnomalyColumns && w.is_suspicious && !w.user_verified;

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
          riegelWorkouts: [],
          bestEffort: null,
          discardedBE: null,
          chosen: null,
        };

        // --- Step 1: Riegel baseline from last 4 weeks ---
        const recentWorkoutsFiltered = workoutsArr.filter(w => new Date(w.date) >= fourWeeksAgo);

        // Adaptive Riegel exponent
        const getEffDist = (w) => (state.hasAnomalyColumns && w.manual_distance) ? w.manual_distance : (w.distance || 0);
        const getEffTime = (w) => (state.hasAnomalyColumns && w.manual_moving_time) ? w.manual_moving_time : (w.moving_time || 0);
        const paceSamples = recentWorkoutsFiltered.filter(w => getEffDist(w) > 0 && getEffTime(w) > 0 && !isSuspiciousUnverified(w));
        const avgPace = paceSamples.length > 0
          ? paceSamples.reduce((s, w) => s + getEffTime(w) / (getEffDist(w) / 1000), 0) / paceSamples.length / 60
          : 6;
        const riegelExp = avgPace < 4.5 ? 1.06 : avgPace < 5.5 ? 1.08 : avgPace < 6.5 ? 1.10 : 1.12;

        // Freshness weight
        const calcFreshness = (dateStr) => {
          const daysAgo = (now - new Date(dateStr)) / (1000 * 60 * 60 * 24);
          return Math.max(0.5, 1 - daysAgo / 28 * 0.3);
        };

        // Step 1a: Riegel from best_efforts (clean splits)
        const bestEffortDistances = {
          '1K': 1000, '1 Mile': 1609, '2 Mile': 3219, '5K': 5000,
          '10K': 10000, 'Half-Marathon': 21097, 'Marathon': 42195
        };
        const allRiegelResults = [];
        for (const w of recentWorkoutsFiltered) {
          if (!w.best_efforts || (state.hasAnomalyColumns && w.is_suspicious)) continue;
          const efforts = typeof w.best_efforts === 'string' ? JSON.parse(w.best_efforts) : w.best_efforts;
          for (const e of efforts) {
            const eDist = bestEffortDistances[e.name];
            if (eDist && eDist >= 1000 && eDist < targetDistM * 0.95 && e.moving_time > 0) {
              const rTime = e.moving_time * Math.pow(targetDistM / eDist, riegelExp);
              allRiegelResults.push({
                time: rTime,
                timeFormatted: fmtTime(Math.round(rTime)),
                distKm: Math.round(eDist / 100) / 10,
                effortName: e.name,
                date: w.date,
                dateFormatted: fmtDate(w.date),
                movingTime: e.moving_time,
                movingTimeFormatted: fmtTime(e.moving_time),
                source: 'best_effort_riegel',
                freshness: calcFreshness(w.date),
              });
            }
          }
        }

        // Sort by freshness-weighted time
        allRiegelResults.sort((a, b) => (a.time * (2 - a.freshness)) - (b.time * (2 - b.freshness)));

        breakdown.riegelWorkouts = allRiegelResults.map(r => ({
          date: r.dateFormatted,
          dist: (r.effortName || r.distKm + ' км'),
          actualTime: r.movingTimeFormatted,
          riegelTime: r.timeFormatted,
        }));
        breakdown.riegelExponent = riegelExp;
        breakdown.avgPace = Math.floor(avgPace) + ':' + String(Math.round((avgPace % 1) * 60)).padStart(2, '0') + '/км';

        // Weighted median of top-3 Riegel estimates
        let riegelEstimate = null;
        let riegelBasis = null;
        if (allRiegelResults.length > 0) {
          const top3 = allRiegelResults.slice(0, Math.min(3, allRiegelResults.length));
          const totalWeight = top3.reduce((s, r) => s + r.freshness, 0);
          riegelEstimate = Math.round(top3.reduce((s, r) => s + r.time * r.freshness, 0) / totalWeight);
          riegelBasis = top3[0];
        }

        // --- Step 2: Best efforts from Strava with sanity check ---
        let bestEffort = null;
        for (const w of recentWorkoutsFiltered) {
          if (!w.best_efforts) continue;
          if (state.hasAnomalyColumns && w.is_suspicious) continue;
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

          // Save predicted_time to goals table for AI context reuse
          supabase.from('goals').update({ predicted_time: finalTime }).eq('id', goal.id).then(() => {});
        } else {
          prediction.message = `Нет тренировок за 4 недели (~${targetDist} км)`;
          prediction.percent = 0;
          prediction.computedCurrentValue = 0;
          // Clear stale prediction
          supabase.from('goals').update({ predicted_time: null }).eq('id', goal.id).then(() => {});
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
