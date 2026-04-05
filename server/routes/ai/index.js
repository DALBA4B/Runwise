const express = require('express');
const supabase = require('../../supabase');
const authMiddleware = require('../../middleware/authMiddleware');

const {
  toLocalDateStr,
  formatPace,
  effectiveDistance,
  effectiveMovingTime,
  effectivePace,
  checkPremium,
  getDailyMessageCount,
  getWorkoutsContext,
  getMonthlySummaryContext,
  getUserGoals,
  getCurrentPlan,
  savePlanUpdate,
  getUserRecords,
  getUserProfile
} = require('./context');

const {
  getLangInstruction,
  formatGoalsForAI,
  formatRecordsForAI,
  formatProfileForAI,
  getAiPrefs,
  buildPersonalityBlock,
  buildChatSystemPrompt,
  processPlanUpdate
} = require('./prompts');

const {
  callDeepSeek,
  callDeepSeekWithTools,
  callDeepSeekStreamWithTools
} = require('./deepseek');

const router = express.Router();

const DAILY_MESSAGE_LIMIT = 15;

// GET /api/ai/chat/limit — check daily message limit
router.get('/chat/limit', authMiddleware, async (req, res) => {
  try {
    const isPremium = await checkPremium(req.user.id);
    if (isPremium) {
      return res.json({ limit: DAILY_MESSAGE_LIMIT, used: 0, remaining: DAILY_MESSAGE_LIMIT, isPremium: true });
    }
    const used = await getDailyMessageCount(req.user.id);
    res.json({ limit: DAILY_MESSAGE_LIMIT, used, remaining: Math.max(0, DAILY_MESSAGE_LIMIT - used), isPremium: false });
  } catch (err) {
    console.error('Limit check error:', err.message);
    res.status(500).json({ error: 'Failed to check limit' });
  }
});

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

// Helper: trim chat history to max 100 messages per user
async function trimChatHistory(userId) {
  const { count } = await supabase
    .from('chat_messages')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);

  if (count && count > 100) {
    // Get IDs of oldest messages to delete
    const toDelete = count - 100;
    const { data: oldMessages } = await supabase
      .from('chat_messages')
      .select('id')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .limit(toDelete);

    if (oldMessages && oldMessages.length > 0) {
      const ids = oldMessages.map(m => m.id);
      await supabase
        .from('chat_messages')
        .delete()
        .in('id', ids);
    }
  }
}

// POST /api/ai/chat — AI chat with tool use support
router.post('/chat', authMiddleware, async (req, res) => {
  try {
    const { message, lang } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Check daily limit (skip for premium users)
    const isPremium = await checkPremium(req.user.id);
    if (!isPremium) {
      const used = await getDailyMessageCount(req.user.id);
      if (used >= DAILY_MESSAGE_LIMIT) {
        return res.status(429).json({ error: 'Daily message limit reached', limit: DAILY_MESSAGE_LIMIT, used, remaining: 0 });
      }
    }

    const { chatHistory, systemPrompt, currentPlan } = await loadChatContext(req.user.id, lang || 'ru');
    const reply = await callDeepSeekWithTools(systemPrompt, message, req.user.id, 4000, chatHistory);
    const { textReply, planUpdated } = await processPlanUpdate(reply, req.user.id, currentPlan, savePlanUpdate);

    await supabase.from('chat_messages').insert([
      { user_id: req.user.id, role: 'user', content: message },
      { user_id: req.user.id, role: 'ai', content: textReply }
    ]);

    // Trim history to max 100 messages
    await trimChatHistory(req.user.id);

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

    // Check daily limit (skip for premium users)
    const isPremiumUser = await checkPremium(req.user.id);
    if (!isPremiumUser) {
      const used = await getDailyMessageCount(req.user.id);
      if (used >= DAILY_MESSAGE_LIMIT) {
        return res.status(429).json({ error: 'Daily message limit reached', limit: DAILY_MESSAGE_LIMIT, used, remaining: 0 });
      }
    }

    const { chatHistory, systemPrompt, currentPlan } = await loadChatContext(req.user.id, lang || 'ru');

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Use tool-aware streaming: tool call rounds are buffered, final response is streamed in real time
    const fullReply = await callDeepSeekStreamWithTools(systemPrompt, message, req.user.id, res, 4000, chatHistory);

    // Process plan updates (fullReply already streamed to client, client strips PLAN_UPDATE blocks)
    const { textReply, planUpdated } = await processPlanUpdate(fullReply, req.user.id, currentPlan, savePlanUpdate);

    // Save clean messages (without PLAN_UPDATE block) to history
    await supabase.from('chat_messages').insert([
      { user_id: req.user.id, role: 'user', content: message },
      { user_id: req.user.id, role: 'ai', content: textReply }
    ]);

    // Trim history to max 100 messages
    await trimChatHistory(req.user.id);

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

// POST /api/ai/generate-plan — generate weekly training plan
router.post('/generate-plan', authMiddleware, async (req, res) => {
  try {
    const lang = req.body?.lang || 'ru';
    // Get last 4 weeks of workouts
    const fourWeeksAgo = new Date();
    fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);

    const { data: recentWorkouts } = await supabase
      .from('workouts')
      .select('name, distance, moving_time, average_pace, average_heartrate, date, type, manual_distance, manual_moving_time')
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
      const totalKm = weekWorkouts.reduce((s, wr) => s + effectiveDistance(wr) / 1000, 0);
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
  distance_km: (effectiveDistance(w) / 1000).toFixed(1),
  pace: formatPace(effectivePace(w)),
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
        week_start: toLocalDateStr(targetMonday),
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
          week_start: toLocalDateStr(targetMonday),
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
      .select('name, distance, moving_time, average_pace, average_heartrate, date, type, manual_distance, manual_moving_time')
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
