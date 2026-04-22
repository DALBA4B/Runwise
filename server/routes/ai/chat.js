const express = require('express');
const supabase = require('../../supabase');
const authMiddleware = require('../../middleware/authMiddleware');

const {
  checkPremium,
  getDailyMessageCount,
  incrementDailyMessageCount,
  getMonthlySummaryContext,
  getUserGoals,
  getCurrentPlan,
  savePlanUpdate,
  getUserRecords,
  getUserProfile,
  getWeeklyVolumes,
  getRiegelPredictions,
  getActiveMacroPlan,
  computeMacroPlanWithActuals,
  analyzeTrainingStability,
  assessMarathonGoalRealism,
  analyzeRecentCompliance,
  getHRTrendContext,
  getRecentDecouplingData,
  getWeeklyTRIMP
} = require('./context');

const {
  estimateVDOT,
  calculatePaceZones
} = require('./vdot');

const {
  getAiPrefs,
  buildChatSystemPrompt,
  processPlanUpdate,
  processMacroPlanUpdate
} = require('./prompts');

const {
  callDeepSeekWithTools,
  callDeepSeekStreamWithTools
} = require('./deepseek');

const router = express.Router();

const DAILY_MESSAGE_LIMIT = 15;

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

  const [monthlySummary, goals, currentPlan, userProfile, records, weeklyVolumes, predictions, rawMacroPlan, hrTrend, decouplingData, trimpData] = await Promise.all([
    getMonthlySummaryContext(userId),
    getUserGoals(userId),
    getCurrentPlan(userId),
    getUserProfile(userId),
    getUserRecords(userId),
    getWeeklyVolumes(userId),
    getRiegelPredictions(userId),
    getActiveMacroPlan(userId),
    getHRTrendContext(userId),
    getRecentDecouplingData(userId),
    getWeeklyTRIMP(userId)
  ]);

  // Compute actuals for macro plan if it exists
  const macroPlan = rawMacroPlan ? await computeMacroPlanWithActuals(userId, rawMacroPlan) : null;

  // Calculate VDOT and pace zones for chat context (12-week window + decay fallback)
  const twelveWeeksAgo = new Date();
  twelveWeeksAgo.setDate(twelveWeeksAgo.getDate() - 84);
  const { data: recentWorkouts } = await supabase
    .from('workouts')
    .select('name, distance, moving_time, average_pace, date, type, manual_distance, manual_moving_time, is_suspicious')
    .eq('user_id', userId)
    .gte('date', twelveWeeksAgo.toISOString())
    .order('date', { ascending: false });

  const { data: allWorkouts } = await supabase
    .from('workouts')
    .select('name, distance, moving_time, average_pace, date, type, manual_distance, manual_moving_time, is_suspicious')
    .eq('user_id', userId)
    .order('date', { ascending: false });

  const estimate = estimateVDOT(recentWorkouts, allWorkouts);
  const currentVDOT = estimate.vdot;
  const paceZones = currentVDOT ? calculatePaceZones(currentVDOT) : null;

  let vdotSource = null;
  if (estimate.source === 'recent') vdotSource = 'workouts';
  else if (estimate.source === 'decay') vdotSource = 'decay';

  const paceZonesData = currentVDOT ? { vdot: currentVDOT, source: vdotSource, zones: paceZones } : null;

  // Analyze training stability (last 12 weeks)
  const stabilityData = await analyzeTrainingStability(userId, 12);

  // Assess marathon goal realism if user has marathon goal
  let goalRealism = null;
  const marathonGoal = goals.find(g => g.type === 'pb_42k');
  if (marathonGoal && currentVDOT && marathonGoal.deadline) {
    const weeksUntilRace = Math.ceil((new Date(marathonGoal.deadline) - new Date()) / (1000 * 60 * 60 * 24 * 7));
    if (weeksUntilRace > 0) {
      goalRealism = assessMarathonGoalRealism(currentVDOT, marathonGoal.target_value, weeksUntilRace);
    }
  }

  // Analyze macro plan compliance trends
  const complianceData = macroPlan ? analyzeRecentCompliance(macroPlan) : null;

  const aiPrefs = getAiPrefs(userProfile);
  const systemPrompt = buildChatSystemPrompt(
    monthlySummary,
    goals,
    currentPlan,
    userProfile,
    records,
    lang,
    aiPrefs,
    weeklyVolumes,
    predictions,
    paceZonesData,
    macroPlan,
    stabilityData,
    goalRealism,
    complianceData,
    hrTrend,
    decouplingData,
    trimpData
  );

  return { chatHistory, systemPrompt, currentPlan };
}

// Helper: trim chat history to max 100 messages per user
async function trimChatHistory(userId) {
  const { count } = await supabase
    .from('chat_messages')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);

  if (count && count > 100) {
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
    const { textReply: afterPlan, planUpdated } = await processPlanUpdate(reply, req.user.id, currentPlan, savePlanUpdate);
    const { textReply, macroPlanUpdated, macroPlanAction } = await processMacroPlanUpdate(afterPlan, req.user.id);

    await supabase.from('chat_messages').insert([
      { user_id: req.user.id, role: 'user', content: message },
      { user_id: req.user.id, role: 'ai', content: textReply }
    ]);
    await incrementDailyMessageCount(req.user.id);

    // Trim history to max 100 messages
    await trimChatHistory(req.user.id);

    res.json({ reply: textReply, planUpdated, macroPlanUpdated: macroPlanUpdated || false, macroPlanAction });
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
    const { textReply: afterPlan, planUpdated } = await processPlanUpdate(fullReply, req.user.id, currentPlan, savePlanUpdate);
    const { textReply, macroPlanUpdated, macroPlanAction } = await processMacroPlanUpdate(afterPlan, req.user.id);

    // Save clean messages (without PLAN_UPDATE / MACRO_PLAN_UPDATE blocks) to history
    await supabase.from('chat_messages').insert([
      { user_id: req.user.id, role: 'user', content: message },
      { user_id: req.user.id, role: 'ai', content: textReply }
    ]);
    await incrementDailyMessageCount(req.user.id);

    // Trim history to max 100 messages
    await trimChatHistory(req.user.id);

    // Send meta event and close
    res.write(`data: [DONE]\n\n`);
    res.write(`data: ${JSON.stringify({ meta: { planUpdated, macroPlanUpdated: macroPlanUpdated || false, macroPlanAction } })}\n\n`);
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

module.exports = router;
