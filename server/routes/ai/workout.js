const express = require('express');
const supabase = require('../../supabase');
const authMiddleware = require('../../middleware/authMiddleware');

const {
  formatPace,
  effectiveDistance,
  effectiveMovingTime,
  effectivePace,
  getWorkoutsContext,
  getUserProfile
} = require('./context');

const {
  getLangInstruction,
  getAiPrefs,
  buildPersonalityBlock
} = require('./prompts');

const { callDeepSeek } = require('./deepseek');

const router = express.Router();

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

    const gpsAnomaly = !!workout.is_suspicious;
    const gpsNote = { ru: '⚠️ GPS-аномалия: сплиты ненадёжны, не анализируй их. Дистанция и время исправлены вручную.', uk: '⚠️ GPS-аномалія: спліти ненадійні, не аналізуй їх. Дистанцію та час виправлено вручну.', en: '⚠️ GPS anomaly: splits are unreliable, do not analyze them. Distance and time were manually corrected.' };

    const workoutInfo = `${ap.analyze}:
- ${ap.name}: ${workout.name}
- ${ap.date}: ${workout.date}
- ${ap.distance}: ${(effectiveDistance(workout) / 1000).toFixed(2)} ${ap.km}
- ${ap.time}: ${Math.floor(effectiveMovingTime(workout) / 60)} ${ap.min}
- ${ap.pace}: ${formatPace(effectivePace(workout))} ${ap.minKm}
- ${ap.hr}: ${workout.average_heartrate || ap.noData} (${ap.max}: ${workout.max_heartrate || ap.noData})
- ${ap.type}: ${workout.type}
${gpsAnomaly ? (gpsNote[useLang] || gpsNote.ru) : ''}
${!gpsAnomaly && workout.splits ? `- ${ap.splitsKm}: ${workout.splits}` : ''}
${!gpsAnomaly && workout.splits_500m ? `- ${ap.splits500}: ${workout.splits_500m}` : ''}`;

    const reply = await callDeepSeek(systemPrompt, workoutInfo);
    res.json({ analysis: reply });
  } catch (err) {
    console.error('Analyze workout error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Analysis failed' });
  }
});

module.exports = router;
