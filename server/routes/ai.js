const express = require('express');
const axios = require('axios');
const supabase = require('../supabase');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

// Helper: format pace from sec/km to mm:ss
function formatPace(secPerKm) {
  if (!secPerKm) return '—';
  const min = Math.floor(secPerKm / 60);
  const sec = Math.round(secPerKm % 60);
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

// Helper: get last N months of workouts for AI context
async function getWorkoutsContext(userId, months = 3) {
  const since = new Date();
  since.setMonth(since.getMonth() - months);

  const { data } = await supabase
    .from('workouts')
    .select('name, distance, moving_time, average_pace, average_heartrate, date, type')
    .eq('user_id', userId)
    .gte('date', since.toISOString())
    .order('date', { ascending: false });

  return (data || []).map(w => ({
    date: w.date?.split('T')[0],
    name: w.name,
    distance_km: (w.distance / 1000).toFixed(2),
    pace: formatPace(w.average_pace),
    heartrate: w.average_heartrate || '—',
    type: w.type
  }));
}

// Goal type labels
const GOAL_LABELS = {
  monthly_distance: 'Месячный объём бега',
  weekly_distance: 'Недельный объём бега',
  pb_5k: 'Личный рекорд на 5 км',
  pb_10k: 'Личный рекорд на 10 км',
  pb_21k: 'Личный рекорд на полумарафоне',
  pb_42k: 'Личный рекорд на марафоне',
  monthly_runs: 'Количество пробежек за месяц'
};

function formatGoalValue(type, value) {
  if (['pb_5k', 'pb_10k', 'pb_21k', 'pb_42k'].includes(type)) {
    const h = Math.floor(value / 3600);
    const m = Math.floor((value % 3600) / 60);
    const s = Math.round(value % 60);
    return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}` : `${m}:${s.toString().padStart(2, '0')}`;
  }
  if (['monthly_distance', 'weekly_distance'].includes(type)) {
    return value >= 1000 ? `${(value / 1000).toFixed(1)} км` : `${value} м`;
  }
  return value.toString();
}

// Helper: get user goals
async function getUserGoals(userId) {
  const { data } = await supabase
    .from('goals')
    .select('type, target_value, current_value, created_at, deadline')
    .eq('user_id', userId);

  return data || [];
}

// Helper: format goals for AI context
function formatGoalsForAI(goals) {
  if (!goals.length) return 'Цели не установлены. Составь план для общего улучшения формы.';

  return goals.map(g => {
    const label = GOAL_LABELS[g.type] || g.type;
    const target = formatGoalValue(g.type, g.target_value);
    const current = formatGoalValue(g.type, g.current_value);
    const progress = g.target_value > 0 ? Math.round((g.current_value / g.target_value) * 100) : 0;
    let deadlineInfo = '';
    if (g.deadline) {
      const daysLeft = Math.ceil((new Date(g.deadline).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      deadlineInfo = `, дедлайн: ${g.deadline} (осталось ${daysLeft} дней)`;
    }
    return `- ${label}: цель ${target}, текущий прогресс ${current} (${progress}%)${deadlineInfo}`;
  }).join('\n');
}

// Helper: get current plan
async function getCurrentPlan(userId) {
  const { data } = await supabase
    .from('plans')
    .select('*')
    .eq('user_id', userId)
    .order('week_start', { ascending: false })
    .limit(1)
    .single();

  return data || null;
}

// Helper: format plan for AI context
function formatPlanForAI(plan) {
  if (!plan) return 'План на неделю пока не создан.';

  let workoutsList;
  try {
    workoutsList = typeof plan.workouts === 'string' ? JSON.parse(plan.workouts) : plan.workouts;
  } catch {
    return 'План есть но не удалось прочитать.';
  }

  // Calculate real dates for each day based on week_start
  const weekStart = new Date(plan.week_start + 'T00:00:00');
  const header = `Текущий план на неделю (пн ${plan.week_start}):`;
  const days = workoutsList.map((d, i) => {
    const dayDate = new Date(weekStart);
    dayDate.setDate(dayDate.getDate() + i);
    const dateStr = dayDate.toISOString().split('T')[0];
    return `- ${d.day} (${dateStr}): ${d.type === 'rest' ? 'Отдых' : `${d.type}, ${d.distance_km} км — ${d.description}`}`;
  }).join('\n');

  return `${header}\n${days}`;
}

// Helper: save updated plan to DB
async function savePlanUpdate(userId, planId, newWorkouts) {
  const { data, error } = await supabase
    .from('plans')
    .update({ workouts: JSON.stringify(newWorkouts) })
    .eq('id', planId)
    .eq('user_id', userId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

// Helper: call DeepSeek API
async function callDeepSeek(systemPrompt, userMessage, maxTokens = 1500, chatHistory = []) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...chatHistory,
    { role: 'user', content: userMessage }
  ];

  const response = await axios.post(DEEPSEEK_URL, {
    model: 'deepseek-chat',
    messages,
    temperature: 0.7,
    max_tokens: maxTokens
  }, {
    headers: {
      'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });

  return response.data.choices[0].message.content;
}

// Helper: call DeepSeek API with streaming
async function callDeepSeekStream(systemPrompt, userMessage, maxTokens = 2500, chatHistory = []) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...chatHistory,
    { role: 'user', content: userMessage }
  ];

  const response = await axios.post(DEEPSEEK_URL, {
    model: 'deepseek-chat',
    messages,
    temperature: 0.7,
    max_tokens: maxTokens,
    stream: true
  }, {
    headers: {
      'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json'
    },
    responseType: 'stream'
  });

  return response.data;
}

// Helper: get user personal records
async function getUserRecords(userId) {
  const { data } = await supabase
    .from('personal_records')
    .select('distance_type, time_seconds, record_date')
    .eq('user_id', userId);

  return data || [];
}

// Helper: format personal records for AI context
function formatRecordsForAI(records) {
  if (!records.length) return 'Личные рекорды не указаны.';

  const DISTANCE_LABELS = {
    '1km': '1 км',
    '3km': '3 км',
    '5km': '5 км',
    '10km': '10 км',
    '21km': 'Полумарафон (21.1 км)',
    '42km': 'Марафон (42.2 км)'
  };

  return records.map(r => {
    const label = DISTANCE_LABELS[r.distance_type] || r.distance_type;
    const h = Math.floor(r.time_seconds / 3600);
    const m = Math.floor((r.time_seconds % 3600) / 60);
    const s = r.time_seconds % 60;
    const time = h > 0
      ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
      : `${m}:${s.toString().padStart(2, '0')}`;
    const date = r.record_date
      ? ` (${new Date(r.record_date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })})`
      : '';
    return `- ${label}: ${time}${date}`;
  }).join('\n');
}

// Helper: get user physical params
async function getUserProfile(userId) {
  const { data } = await supabase
    .from('users')
    .select('age, height_cm, weight_kg')
    .eq('id', userId)
    .single();
  return data || {};
}

// Helper: format profile for AI
function formatProfileForAI(profile) {
  const parts = [];
  if (profile.age) parts.push(`Возраст: ${profile.age} лет`);
  if (profile.height_cm) parts.push(`Рост: ${profile.height_cm} см`);
  if (profile.weight_kg) parts.push(`Вес: ${profile.weight_kg} кг`);
  if (parts.length === 0) return 'Физические параметры не указаны.';
  return parts.join(', ');
}

// Helper: build chat system prompt
function buildChatSystemPrompt(workoutsData, goals, currentPlan, userProfile, records) {
  const today = new Date();
  const dayNames = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
  const todayStr = `${today.toISOString().split('T')[0]} (${dayNames[today.getDay()]})`;

  return `Ты — Runwise, персональный AI тренер по бегу и настоящий бро пользователя. Отвечай на русском.

СЕГОДНЯ: ${todayStr}.

КТО ТЫ:
Ты не бездушный бот, а дружелюбный тренер с характером. Ты искренне болеешь за успехи пользователя, радуешься его прогрессу и поддерживаешь когда тяжело. Ты общаешься как близкий друг, который разбирается в беге — с юмором, энергией и заботой. Можешь подколоть по-доброму, но всегда поддержишь. Используй имя/обращение на "ты".

ДАННЫЕ ПОЛЬЗОВАТЕЛЯ:
Физические параметры: ${formatProfileForAI(userProfile || {})}
${userProfile?.age ? `Учитывай возраст при рекомендациях по пульсовым зонам и восстановлению.` : ''}
${userProfile?.weight_kg ? `Учитывай вес при рекомендациях по нагрузке и темпу.` : ''}

История тренировок за последние 3 месяца:
${JSON.stringify(workoutsData, null, 2)}

Цели:
${formatGoalsForAI(goals)}

Личные рекорды:
${formatRecordsForAI(records || [])}
Используй рекорды для расчёта тренировочных темпов и зон.

${formatPlanForAI(currentPlan)}

Общая статистика: ${workoutsData.length} тренировок за 3 месяца.

ВОЗМОЖНОСТЬ ИЗМЕНЕНИЯ ПЛАНА:
Если пользователь просит изменить план, уменьшить/увеличить нагрузку, поменять тренировки и т.п., ты МОЖЕШЬ изменить текущий план.
Для этого в конце своего ответа добавь блок:
===PLAN_UPDATE===
[JSON массив из 7 дней в том же формате что и текущий план]
===END_PLAN_UPDATE===

Формат каждого дня:
{"day": "Понедельник", "type": "easy|tempo|long|interval|rest", "distance_km": число, "description": "описание", "badge": "🏃|⚡|🏔️|💨|😴"}

ПРАВИЛА:
- Изменяй план ТОЛЬКО если пользователь явно просит это сделать или соглашается на твоё предложение.
- При изменении плана сначала объясни коротко что и почему ты меняешь, а потом добавь блок PLAN_UPDATE.
- Если пользователь просто спрашивает о плане — расскажи СВОИМИ СЛОВАМИ кратко: какой общий объём, что за ключевые тренировки, сколько дней отдыха. НЕ копируй план таблицей или списком.
- Если пользователь говорит что ему тяжело — посочувствуй, предложи изменения и спроси подтверждение.
- Математическая точность: дистанция × темп = время. Всегда проверяй цифры.
- НЕ выдумывай даты — если не уверен в дате, не упоминай её.

СТИЛЬ ОТВЕТОВ:
- Отвечай КРАТКО — 3-6 предложений. Не растягивай.
- Будь живым и эмоциональным — радуйся успехам ("ого, красавчик!"), поддерживай ("бывает, не парься"), мотивируй ("давай, ты можешь!").
- Говори простым разговорным языком, как друг в чате. Можно сленг в меру.
- Персонализируй ответы — ссылайся на конкретные тренировки, цифры, прогресс пользователя.
- Не повторяй данные которые пользователь и так видит в приложении.
- Используй 1-3 эмодзи.
- НЕ используй таблицы, списки или markdown.`;
}

// Helper: process plan update from AI reply
async function processPlanUpdate(reply, userId, currentPlan) {
  let textReply = reply;
  let planUpdated = false;

  if (reply.includes('===PLAN_UPDATE===') && reply.includes('===END_PLAN_UPDATE===') && currentPlan) {
    const planMatch = reply.match(/===PLAN_UPDATE===\s*([\s\S]*?)\s*===END_PLAN_UPDATE===/);
    if (planMatch) {
      try {
        let planJson = planMatch[1].trim();
        const jsonArrayMatch = planJson.match(/\[[\s\S]*\]/);
        if (jsonArrayMatch) {
          planJson = jsonArrayMatch[0];
        }
        const newPlan = JSON.parse(planJson);

        if (Array.isArray(newPlan) && newPlan.length === 7) {
          await savePlanUpdate(userId, currentPlan.id, newPlan);
          planUpdated = true;
        }
      } catch (parseErr) {
        console.error('Failed to parse plan update:', parseErr.message);
      }

      textReply = reply.replace(/===PLAN_UPDATE===[\s\S]*?===END_PLAN_UPDATE===/, '').trim();
    }
  }

  return { textReply, planUpdated };
}

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
async function loadChatContext(userId) {
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

  const [workoutsData, goals, currentPlan, userProfile, records] = await Promise.all([
    getWorkoutsContext(userId),
    getUserGoals(userId),
    getCurrentPlan(userId),
    getUserProfile(userId),
    getUserRecords(userId)
  ]);

  const systemPrompt = buildChatSystemPrompt(workoutsData, goals, currentPlan, userProfile, records);

  return { chatHistory, systemPrompt, currentPlan };
}

// POST /api/ai/chat — AI chat with plan awareness
router.post('/chat', authMiddleware, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const { chatHistory, systemPrompt, currentPlan } = await loadChatContext(req.user.id);
    const reply = await callDeepSeek(systemPrompt, message, 2500, chatHistory);
    const { textReply, planUpdated } = await processPlanUpdate(reply, req.user.id, currentPlan);

    await supabase.from('chat_messages').insert([
      { user_id: req.user.id, role: 'user', content: message },
      { user_id: req.user.id, role: 'ai', content: textReply }
    ]);

    res.json({ reply: textReply, planUpdated });
  } catch (err) {
    console.error('AI chat error:', err.response?.data || err.message);
    res.status(500).json({ error: 'AI request failed' });
  }
});

// POST /api/ai/chat/stream — SSE streaming AI chat
router.post('/chat/stream', authMiddleware, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const { chatHistory, systemPrompt, currentPlan } = await loadChatContext(req.user.id);

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const stream = await callDeepSeekStream(systemPrompt, message, 2500, chatHistory);

    let fullReply = '';
    let buffer = '';

    stream.on('data', (chunk) => {
      buffer += chunk.toString();

      // Process complete lines
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') {
          if (trimmed === 'data: [DONE]') {
            // Don't forward [DONE] yet — we send our own after processing
          } else {
            // Forward empty lines for SSE format
            res.write('\n');
          }
          continue;
        }

        if (trimmed.startsWith('data: ')) {
          try {
            const json = JSON.parse(trimmed.slice(6));
            const content = json.choices?.[0]?.delta?.content;
            if (content) {
              fullReply += content;
            }
          } catch {
            // Not JSON, ignore
          }
          // Forward the chunk as-is
          res.write(trimmed + '\n\n');
        }
      }
    });

    stream.on('end', async () => {
      try {
        const { textReply, planUpdated } = await processPlanUpdate(fullReply, req.user.id, currentPlan);

        // Save messages to history
        await supabase.from('chat_messages').insert([
          { user_id: req.user.id, role: 'user', content: message },
          { user_id: req.user.id, role: 'ai', content: textReply }
        ]);

        // Send meta event and close
        res.write(`data: [DONE]\n\n`);
        res.write(`data: ${JSON.stringify({ meta: { planUpdated } })}\n\n`);
        res.end();
      } catch (err) {
        console.error('Stream end processing error:', err.message);
        res.write(`data: [DONE]\n\n`);
        res.write(`data: ${JSON.stringify({ meta: { planUpdated: false } })}\n\n`);
        res.end();
      }
    });

    stream.on('error', (err) => {
      console.error('DeepSeek stream error:', err.message);
      res.write(`data: ${JSON.stringify({ error: 'Stream failed' })}\n\n`);
      res.end();
    });

    // Handle client disconnect
    req.on('close', () => {
      stream.destroy();
    });
  } catch (err) {
    console.error('AI chat stream error:', err.response?.data || err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'AI request failed' });
    } else {
      res.end();
    }
  }
});

// POST /api/ai/analyze-workout — AI comment for a specific workout
router.post('/analyze-workout', authMiddleware, async (req, res) => {
  try {
    const { workoutId } = req.body;

    const { data: workout } = await supabase
      .from('workouts')
      .select('*')
      .eq('id', workoutId)
      .eq('user_id', req.user.id)
      .single();

    if (!workout) {
      return res.status(404).json({ error: 'Workout not found' });
    }

    const recentWorkouts = await getWorkoutsContext(req.user.id, 1);

    const systemPrompt = `Ты персональный AI тренер по бегу. Проанализируй конкретную тренировку и дай краткий комментарий (3-5 предложений). Отвечай на русском.

Контекст — последние тренировки юзера:
${JSON.stringify(recentWorkouts.slice(0, 10), null, 2)}`;

    const workoutInfo = `Проанализируй эту тренировку:
- Название: ${workout.name}
- Дата: ${workout.date}
- Дистанция: ${(workout.distance / 1000).toFixed(2)} км
- Время: ${Math.floor(workout.moving_time / 60)} мин
- Темп: ${formatPace(workout.average_pace)} мин/км
- Пульс: ${workout.average_heartrate || 'нет данных'} (макс: ${workout.max_heartrate || 'нет данных'})
- Тип: ${workout.type}
${workout.splits ? `- Сплиты по км: ${workout.splits}` : ''}
${workout.splits_500m ? `- Сплиты по 500м: ${workout.splits_500m}` : ''}`;

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
    // Get last 4 weeks of workouts
    const fourWeeksAgo = new Date();
    fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);

    const { data: recentWorkouts } = await supabase
      .from('workouts')
      .select('name, distance, moving_time, average_pace, average_heartrate, date, type')
      .eq('user_id', req.user.id)
      .gte('date', fourWeeksAgo.toISOString())
      .order('date', { ascending: false });

    const [goals, records] = await Promise.all([
      getUserGoals(req.user.id),
      getUserRecords(req.user.id)
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
      const totalKm = weekWorkouts.reduce((s, wr) => s + (wr.distance || 0) / 1000, 0);
      weeklyDistances.push(Math.round(totalKm * 10) / 10);
    }
    const avgWeeklyKm = weeklyDistances.length > 0
      ? Math.round(weeklyDistances.reduce((a, b) => a + b, 0) / weeklyDistances.length * 10) / 10
      : 0;

    const systemPrompt = `Ты персональный AI тренер по бегу. Сгенерируй план тренировок на следующую неделю (7 дней, начиная с понедельника).

ЦЕЛИ ПОЛЬЗОВАТЕЛЯ:
${formatGoalsForAI(goals)}

ЛИЧНЫЕ РЕКОРДЫ ПОЛЬЗОВАТЕЛЯ:
${formatRecordsForAI(records)}
Используй рекорды для расчёта тренировочных темпов и зон.

ПРАВИЛА ГЕНЕРАЦИИ ПЛАНА:
1. План должен быть направлен на достижение целей пользователя.
2. Если цель — личный рекорд (pb_5k, pb_10k и т.д.), включай соответствующие скоростные и темповые работы.
3. Если цель — объём (monthly_distance, weekly_distance), фокусируйся на набеге километража.
4. Учитывай прогресс к цели: если прогресс низкий а времени мало — увеличивай интенсивность; если прогресс хороший — поддерживай текущий уровень.
5. Средний недельный объём за последние 4 недели: ${avgWeeklyKm} км. Не увеличивай объём более чем на 10-15% за неделю.

КРИТИЧЕСКИ ВАЖНО — МАТЕМАТИЧЕСКАЯ ТОЧНОСТЬ:
- Если пишешь темп (мин/км) и время — проверь что дистанция = время / темп. Например: 20 мин в темпе 5:00/км = 4 км, НЕ 9 км.
- Если пишешь дистанцию и темп — рассчитай ожидаемое время и укажи его.
- distance_km должна точно соответствовать описанию. Если в описании "5 км легко + 3 км темпом", то distance_km = 8.
- Всегда перепроверяй: дистанция × темп = время.

ВАЖНО: Ответ должен быть ТОЛЬКО валидным JSON массивом из 7 объектов, без markdown, без пояснений, без текста до или после JSON.

Формат каждого дня:
{
  "day": "Понедельник",
  "type": "easy|tempo|long|interval|rest",
  "distance_km": число или 0 для отдыха,
  "description": "краткое описание тренировки с ТОЧНЫМИ цифрами (темп, время, дистанция — всё должно быть математически согласовано)",
  "badge": "🏃|⚡|🏔️|💨|😴"
}`;

    const context = `Тренировки за последние 4 недели:
${JSON.stringify((recentWorkouts || []).map(w => ({
  date: w.date?.split('T')[0],
  distance_km: (w.distance / 1000).toFixed(1),
  pace: formatPace(w.average_pace),
  type: w.type,
  heartrate: w.average_heartrate
})), null, 2)}

Недельные объёмы (последние 4 недели): ${weeklyDistances.join(', ')} км

Сгенерируй план на следующую неделю, ориентируясь на цели пользователя.`;

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
        week_start: targetMonday.toISOString().split('T')[0],
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
          week_start: targetMonday.toISOString().split('T')[0],
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
    // Get workouts for current Mon-Sun week
    const now = new Date();
    const dayOfWeek = now.getDay();
    const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const monday = new Date(now);
    monday.setDate(monday.getDate() - daysFromMonday);
    monday.setHours(0, 0, 0, 0);

    const { data: weekData } = await supabase
      .from('workouts')
      .select('name, distance, moving_time, average_pace, average_heartrate, date, type')
      .eq('user_id', req.user.id)
      .gte('date', monday.toISOString())
      .order('date', { ascending: false });

    const weekWorkouts = (weekData || []).map(w => ({
      date: w.date?.split('T')[0],
      name: w.name,
      distance_km: (w.distance / 1000).toFixed(2),
      pace: formatPace(w.average_pace),
      heartrate: w.average_heartrate || '—',
      type: w.type
    }));

    if (weekWorkouts.length === 0) {
      return res.json({ analysis: 'Пока нет тренировок для анализа. Начни бегать и я помогу тебе стать лучше! 🏃' });
    }

    const systemPrompt = `Ты персональный AI тренер по бегу. Дай краткий анализ тренировочной недели (3-4 предложения). Отвечай на русском. Будь конкретным, опирайся на данные.`;

    const message = `Проанализируй мою неделю тренировок:\n${JSON.stringify(weekWorkouts, null, 2)}`;

    const reply = await callDeepSeek(systemPrompt, message);
    res.json({ analysis: reply });
  } catch (err) {
    console.error('Weekly analysis error:', err.message);
    res.status(500).json({ error: 'Analysis failed' });
  }
});

module.exports = router;
