const express = require('express');
const supabase = require('../../supabase');
const authMiddleware = require('../../middleware/authMiddleware');

const {
  formatPace,
  effectiveDistance,
  effectivePace,
  getUserRecords,
  getUserProfile
} = require('./context');

const {
  calculateVDOT,
  estimateVDOT,
  calculatePaceZones,
  getRunnerLevel,
  getRecentPaceStats
} = require('./vdot');

const {
  getLangInstruction,
  getAiPrefs,
  buildPersonalityBlock
} = require('./prompts');

const { callDeepSeek } = require('./deepseek');

const router = express.Router();

// GET /api/ai/pace-zones — calculate VDOT and pace zones for user
router.get('/pace-zones', authMiddleware, async (req, res) => {
  try {
    const records = await getUserRecords(req.user.id);

    // Get last 12 weeks of workouts (for estimateVDOT primary window)
    const twelveWeeksAgo = new Date();
    twelveWeeksAgo.setDate(twelveWeeksAgo.getDate() - 84);
    const { data: recentWorkouts } = await supabase
      .from('workouts')
      .select('id, name, distance, moving_time, average_pace, date, type, manual_distance, manual_moving_time, is_suspicious')
      .eq('user_id', req.user.id)
      .gte('date', twelveWeeksAgo.toISOString())
      .order('date', { ascending: false });

    // All workouts for fallback (last quality workout with decay)
    const { data: allWorkouts } = await supabase
      .from('workouts')
      .select('id, name, distance, moving_time, average_pace, date, type, manual_distance, manual_moving_time, is_suspicious')
      .eq('user_id', req.user.id)
      .order('date', { ascending: false });

    // Calculate weeklyKm by active weeks (weeks that had at least 1 workout)
    const activeWeeks = new Set();
    for (const w of (recentWorkouts || [])) {
      if (w.date) {
        const d = new Date(w.date);
        const jan1 = new Date(d.getFullYear(), 0, 1);
        const weekNum = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
        activeWeeks.add(`${d.getFullYear()}-W${weekNum}`);
      }
    }
    const totalKm12w = (recentWorkouts || []).reduce((s, w) => s + effectiveDistance(w) / 1000, 0);
    const weeklyKm = activeWeeks.size > 0 ? totalKm12w / activeWeeks.size : 0;

    // VDOT from records (for breakdown display)
    const distanceMap = { '1km': 1000, '3km': 3000, '5km': 5000, '10km': 10000, '21km': 21097, '42km': 42195 };
    const recordsBreakdown = (records || [])
      .filter(r => distanceMap[r.distance_type] && r.time_seconds)
      .map(r => {
        const vdot = calculateVDOT(r.time_seconds, distanceMap[r.distance_type]);
        return {
          distance: r.distance_type,
          time_seconds: r.time_seconds,
          date: r.record_date,
          vdot
        };
      })
      .filter(r => r.vdot);

    // Main VDOT estimation
    const estimate = estimateVDOT(recentWorkouts, allWorkouts);
    const currentVDOT = estimate.vdot;

    // Source label for UI
    let vdotSource = null;
    if (estimate.source === 'recent') vdotSource = 'workouts';
    else if (estimate.source === 'decay') vdotSource = 'decay';

    if (!currentVDOT) {
      return res.json({ vdot: null, zones: null, level: getRunnerLevel(weeklyKm) });
    }

    const zones = calculatePaceZones(currentVDOT);
    const level = getRunnerLevel(weeklyKm);
    const paceStats = getRecentPaceStats(recentWorkouts);

    const fmt = (sec) => {
      if (!sec) return null;
      const m = Math.floor(sec / 60);
      const s = Math.round(sec % 60);
      return `${m}:${s.toString().padStart(2, '0')}`;
    };

    res.json({
      vdot: currentVDOT,
      level,
      zones: {
        easy:       { from: fmt(zones.easyMin), to: fmt(zones.easyMax) },
        marathon:   { from: fmt(zones.easyMax), to: fmt(zones.marathon) },
        threshold:  { from: fmt(zones.marathon), to: fmt(zones.threshold) },
        interval:   { from: fmt(zones.threshold), to: fmt(zones.interval) },
        repetition: { from: fmt(zones.interval),  to: fmt(zones.repetition) }
      },
      details: {
        source: vdotSource,
        weeklyKm: Math.round(weeklyKm * 10) / 10,
        workoutsCount: (recentWorkouts || []).length,
        avgPace: fmt(paceStats.avgPace),
        bestPace: fmt(paceStats.bestPace),
        recordsBreakdown,
        sourceWorkout: estimate.sourceWorkout || null,
        otherGoodWorkouts: estimate.otherGoodWorkouts || []
      }
    });
  } catch (err) {
    console.error('Pace zones error:', err.message);
    res.status(500).json({ error: 'Failed to calculate pace zones' });
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
      .select('name, distance, moving_time, average_pace, average_heartrate, date, type, manual_distance, manual_moving_time, is_suspicious')
      .eq('user_id', req.user.id)
      .gte('date', monday.toISOString())
      .order('date', { ascending: false });

    const weekWorkouts = (weekData || []).map(w => ({
      date: w.date?.split('T')[0],
      name: w.name,
      distance_km: (effectiveDistance(w) / 1000).toFixed(2),
      pace: formatPace(effectivePace(w)),
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
