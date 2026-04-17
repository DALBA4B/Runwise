const express = require('express');
const authMiddleware = require('../../middleware/authMiddleware');
const { getActiveMacroPlan, computeMacroPlanWithActuals } = require('./context');
const supabase = require('../../supabase');

const router = express.Router();

// GET /api/ai/macro-plan — get active macro plan with plan-vs-fact
router.get('/macro-plan', authMiddleware, async (req, res) => {
  try {
    const macroPlan = await getActiveMacroPlan(req.user.id);
    if (!macroPlan) {
      return res.json({ macroPlan: null });
    }

    const enriched = await computeMacroPlanWithActuals(req.user.id, macroPlan);
    res.json({ macroPlan: enriched });
  } catch (err) {
    console.error('Failed to fetch macro plan:', err.message);
    res.status(500).json({ error: 'Failed to fetch macro plan' });
  }
});

// DELETE /api/ai/macro-plan — cancel active macro plan
router.delete('/macro-plan', authMiddleware, async (req, res) => {
  try {
    const { error } = await supabase
      .from('macro_plans')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('user_id', req.user.id)
      .eq('status', 'active');

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to cancel macro plan:', err.message);
    res.status(500).json({ error: 'Failed to cancel macro plan' });
  }
});

module.exports = router;
