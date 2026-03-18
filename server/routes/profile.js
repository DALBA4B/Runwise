const express = require('express');
const supabase = require('../supabase');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

// GET /api/profile — get user profile data
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('age, height_cm, weight_kg')
      .eq('id', req.user.id)
      .single();

    if (error) throw error;
    res.json(data || {});
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// PUT /api/profile — update user profile data
router.put('/', authMiddleware, async (req, res) => {
  try {
    const { age, height_cm, weight_kg } = req.body;

    const { data, error } = await supabase
      .from('users')
      .update({ age, height_cm, weight_kg })
      .eq('id', req.user.id)
      .select('age, height_cm, weight_kg')
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

module.exports = router;
