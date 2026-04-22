const express = require('express');
const supabase = require('../supabase');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

// GET /api/profile — get user profile data
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('age, height_cm, weight_kg, gender, ai_preferences, max_heartrate_user, resting_heartrate')
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
    const { age, height_cm, weight_kg, gender, ai_preferences, max_heartrate_user, resting_heartrate } = req.body;

    const updateFields = {};
    if (age !== undefined) updateFields.age = age;
    if (height_cm !== undefined) updateFields.height_cm = height_cm;
    if (weight_kg !== undefined) updateFields.weight_kg = weight_kg;
    if (gender !== undefined) updateFields.gender = gender;
    if (ai_preferences !== undefined) updateFields.ai_preferences = ai_preferences;
    if (max_heartrate_user !== undefined) updateFields.max_heartrate_user = max_heartrate_user;
    if (resting_heartrate !== undefined) updateFields.resting_heartrate = resting_heartrate;

    const { data, error } = await supabase
      .from('users')
      .update(updateFields)
      .eq('id', req.user.id)
      .select('age, height_cm, weight_kg, gender, ai_preferences, max_heartrate_user, resting_heartrate')
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// GET /api/profile/records — get all personal records
router.get('/records', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('personal_records')
      .select('*')
      .eq('user_id', req.user.id)
      .order('distance_type');

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch records' });
  }
});

// PUT /api/profile/records — create or update a personal record (upsert)
router.put('/records', authMiddleware, async (req, res) => {
  try {
    const { distance_type, time_seconds, record_date } = req.body;

    if (!distance_type || !time_seconds) {
      return res.status(400).json({ error: 'distance_type and time_seconds are required' });
    }

    const { data, error } = await supabase
      .from('personal_records')
      .upsert({
        user_id: req.user.id,
        distance_type,
        time_seconds,
        record_date: record_date || null,
        source: 'manual'
      }, {
        onConflict: 'user_id,distance_type'
      })
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to save record' });
  }
});

// DELETE /api/profile/records/:type — delete a personal record by distance type
router.delete('/records/:type', authMiddleware, async (req, res) => {
  try {
    const { error } = await supabase
      .from('personal_records')
      .delete()
      .eq('user_id', req.user.id)
      .eq('distance_type', req.params.type);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete record' });
  }
});

module.exports = router;
