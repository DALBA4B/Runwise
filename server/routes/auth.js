const express = require('express');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const supabase = require('../supabase');

const router = express.Router();

// GET /api/auth/strava — redirect to Strava OAuth
router.get('/strava', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID,
    redirect_uri: process.env.STRAVA_REDIRECT_URI,
    response_type: 'code',
    scope: 'read,activity:read_all',
    approval_prompt: 'auto'
  });
  res.json({ url: `https://www.strava.com/oauth/authorize?${params.toString()}` });
});

// POST /api/auth/callback — exchange code for token
router.post('/callback', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) {
      return res.status(400).json({ error: 'Code is required' });
    }

    // Exchange code for tokens
    const tokenResponse = await axios.post('https://www.strava.com/oauth/token', {
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code'
    });

    const {
      access_token,
      refresh_token,
      expires_at,
      athlete
    } = tokenResponse.data;

    const stravaId = athlete.id.toString();

    // Check if user exists
    let { data: existingUser } = await supabase
      .from('users')
      .select('*')
      .eq('strava_id', stravaId)
      .single();

    let user;
    if (existingUser) {
      // Update tokens
      const { data, error } = await supabase
        .from('users')
        .update({
          strava_access_token: access_token,
          strava_refresh_token: refresh_token,
          strava_token_expires_at: expires_at
        })
        .eq('id', existingUser.id)
        .select()
        .single();

      if (error) throw error;
      user = data;
    } else {
      // Create new user
      const { data, error } = await supabase
        .from('users')
        .insert({
          strava_id: stravaId,
          strava_access_token: access_token,
          strava_refresh_token: refresh_token,
          strava_token_expires_at: expires_at
        })
        .select()
        .single();

      if (error) throw error;
      user = data;
    }

    // Generate JWT
    const jwtToken = jwt.sign(
      { userId: user.id, stravaId: user.strava_id },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      token: jwtToken,
      user: {
        id: user.id,
        strava_id: user.strava_id,
        created_at: user.created_at
      },
      isNewUser: !existingUser
    });
  } catch (err) {
    console.error('Auth callback error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// GET /api/auth/me — get current user
router.get('/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const { data: user, error } = await supabase
      .from('users')
      .select('id, strava_id, created_at, has_pending_sync')
      .eq('id', decoded.userId)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Track last active time + clear pending flag (fire-and-forget)
    supabase.from('users').update({ last_active: new Date().toISOString(), has_pending_sync: false }).eq('id', user.id).then(() => {}).catch(() => {});

    res.json({ user, hasPendingSync: !!user.has_pending_sync });
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

module.exports = router;
