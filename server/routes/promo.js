const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const authMiddleware = require('../middleware/authMiddleware');

// Admin auth middleware — checks X-Admin-Secret header
function adminAuth(req, res, next) {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// ============ USER ENDPOINTS ============

// POST /api/promo/activate — activate a promo code
router.post('/activate', authMiddleware, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code || !code.trim()) {
      return res.status(400).json({ error: 'Code is required' });
    }

    // Find promo code
    const { data: promo, error: promoErr } = await supabase
      .from('promo_codes')
      .select('*')
      .eq('code', code.trim().toUpperCase())
      .single();

    if (promoErr || !promo) {
      return res.status(404).json({ error: 'INVALID' });
    }

    if (!promo.is_active) {
      return res.status(400).json({ error: 'INVALID' });
    }

    if (promo.uses_count >= promo.max_uses) {
      return res.status(400).json({ error: 'USED_UP' });
    }

    // Check if user already activated this code
    const { data: existing } = await supabase
      .from('promo_activations')
      .select('id')
      .eq('user_id', req.user.id)
      .eq('promo_code_id', promo.id)
      .single();

    if (existing) {
      return res.status(400).json({ error: 'ALREADY_USED' });
    }

    // Get current user premium status
    const { data: user } = await supabase
      .from('users')
      .select('premium_until, is_lifetime_premium')
      .eq('id', req.user.id)
      .single();

    // Calculate new premium_until
    let newPremiumUntil = null;
    let isLifetime = user?.is_lifetime_premium || false;

    if (promo.duration_days === null) {
      // Lifetime premium
      isLifetime = true;
    } else {
      // Calculate expiration: stack on top of existing premium
      const now = new Date();
      const currentEnd = user?.premium_until && new Date(user.premium_until) > now
        ? new Date(user.premium_until)
        : now;
      newPremiumUntil = new Date(currentEnd.getTime() + promo.duration_days * 24 * 60 * 60 * 1000);
    }

    // Calculate activation expires_at
    const expiresAt = promo.duration_days === null
      ? null
      : newPremiumUntil.toISOString();

    // Create activation record
    const { error: activationErr } = await supabase
      .from('promo_activations')
      .insert({
        user_id: req.user.id,
        promo_code_id: promo.id,
        expires_at: expiresAt
      });

    if (activationErr) {
      return res.status(500).json({ error: 'Activation failed' });
    }

    // Increment uses_count
    await supabase
      .from('promo_codes')
      .update({ uses_count: promo.uses_count + 1 })
      .eq('id', promo.id);

    // Update user premium status
    const updateData = {};
    if (isLifetime) {
      updateData.is_lifetime_premium = true;
    }
    if (newPremiumUntil) {
      updateData.premium_until = newPremiumUntil.toISOString();
    }

    if (Object.keys(updateData).length > 0) {
      await supabase
        .from('users')
        .update(updateData)
        .eq('id', req.user.id);
    }

    res.json({
      success: true,
      premium_until: isLifetime ? null : newPremiumUntil?.toISOString(),
      is_lifetime: isLifetime,
      duration_days: promo.duration_days
    });
  } catch (err) {
    console.error('Promo activate error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/promo/status — current premium status
router.get('/status', authMiddleware, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users')
      .select('premium_until, is_lifetime_premium')
      .eq('id', req.user.id)
      .single();

    const now = new Date();
    const premiumUntil = user?.premium_until ? new Date(user.premium_until) : null;
    const isPremium = user?.is_lifetime_premium || (premiumUntil && premiumUntil > now);

    res.json({
      isPremium: !!isPremium,
      isLifetime: !!user?.is_lifetime_premium,
      premiumUntil: user?.premium_until || null
    });
  } catch (err) {
    console.error('Promo status error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ ADMIN ENDPOINTS ============

// GET /api/promo/admin/codes — list all codes
router.get('/admin/codes', adminAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('promo_codes')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Admin list codes error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/promo/admin/codes — create a new code
router.post('/admin/codes', adminAuth, async (req, res) => {
  try {
    const { code, duration_days, max_uses } = req.body;

    if (!code || !code.trim()) {
      return res.status(400).json({ error: 'Code is required' });
    }

    const { data, error } = await supabase
      .from('promo_codes')
      .insert({
        code: code.trim().toUpperCase(),
        duration_days: duration_days === '' || duration_days === undefined ? null : Number(duration_days),
        max_uses: max_uses ? Number(max_uses) : 1
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(400).json({ error: 'Code already exists' });
      }
      throw error;
    }

    res.json(data);
  } catch (err) {
    console.error('Admin create code error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/promo/admin/codes/:id — delete a code
router.delete('/admin/codes/:id', adminAuth, async (req, res) => {
  try {
    const { error } = await supabase
      .from('promo_codes')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('Admin delete code error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/promo/admin/activations — activation history
router.get('/admin/activations', adminAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('promo_activations')
      .select(`
        id,
        activated_at,
        expires_at,
        user_id,
        promo_code_id,
        users ( strava_id ),
        promo_codes ( code, duration_days )
      `)
      .order('activated_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Admin activations error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
