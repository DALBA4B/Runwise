const express = require('express');
const axios = require('axios');
const supabase = require('../supabase');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

// Helper: load full user with Strava tokens from DB
async function loadUserWithTokens(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('id, strava_id, strava_access_token, strava_refresh_token, strava_token_expires_at')
    .eq('id', userId)
    .single();
  if (error || !data) throw new Error('User not found');
  return data;
}

// Helper: refresh Strava token if expired
async function getValidToken(user) {
  const now = Math.floor(Date.now() / 1000);
  if (user.strava_token_expires_at > now + 60) {
    return user.strava_access_token;
  }

  const response = await axios.post('https://www.strava.com/oauth/token', {
    client_id: process.env.STRAVA_CLIENT_ID,
    client_secret: process.env.STRAVA_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: user.strava_refresh_token
  });

  const { access_token, refresh_token, expires_at } = response.data;

  await supabase
    .from('users')
    .update({
      strava_access_token: access_token,
      strava_refresh_token: refresh_token,
      strava_token_expires_at: expires_at
    })
    .eq('id', user.id);

  return access_token;
}

// Helper: classify workout type based on pace and distance
function classifyWorkout(activity) {
  const paceSecPerKm = activity.moving_time / (activity.distance / 1000);
  const distanceKm = activity.distance / 1000;

  if (distanceKm >= 15) return 'long';
  if (activity.workout_type === 3 || (activity.name && activity.name.toLowerCase().includes('interval'))) return 'interval';
  if (paceSecPerKm < 300) return 'tempo';
  if (paceSecPerKm >= 360) return 'easy';
  return 'other';
}

// Helper: parse Strava activity to our format
function parseActivity(activity, userId) {
  const distanceM = activity.distance || 0;
  const movingTime = activity.moving_time || 0;
  const paceSecPerKm = distanceM > 0 ? movingTime / (distanceM / 1000) : 0;

  return {
    user_id: userId,
    strava_id: activity.id.toString(),
    name: activity.name || 'Untitled',
    distance: Math.round(distanceM),
    moving_time: movingTime,
    average_pace: Math.round(paceSecPerKm),
    average_heartrate: activity.average_heartrate || null,
    max_heartrate: activity.max_heartrate || null,
    date: activity.start_date_local || activity.start_date,
    type: classifyWorkout(activity),
    splits: activity.splits_metric ? JSON.stringify(activity.splits_metric.map((s, i) => ({
      km: i + 1,
      time: s.moving_time,
      pace: s.moving_time / (s.distance / 1000),
      distance: s.distance,
      heartrate: s.average_heartrate || null,
      elevation: s.elevation_difference || 0
    }))) : null,
    total_elevation_gain: activity.total_elevation_gain || 0,
    description: activity.description || null,
    raw_data: JSON.stringify(activity)
  };
}

// Helper: bulk upsert workouts — avoids N+1 queries
async function bulkUpsertWorkouts(workoutsToSave, userId) {
  if (workoutsToSave.length === 0) return 0;

  // 1. Get all existing strava_ids for this user in ONE query
  const stravaIds = workoutsToSave.map(w => w.strava_id);
  const { data: existingRows } = await supabase
    .from('workouts')
    .select('strava_id')
    .eq('user_id', userId)
    .in('strava_id', stravaIds);

  const existingSet = new Set((existingRows || []).map(r => r.strava_id));

  // 2. Filter out already-existing workouts
  const newWorkouts = workoutsToSave.filter(w => !existingSet.has(w.strava_id));

  if (newWorkouts.length === 0) return 0;

  // 3. Insert all new workouts in ONE batch insert
  const { error } = await supabase.from('workouts').insert(newWorkouts);
  if (error) {
    console.error('Bulk insert error:', error.message);
    throw error;
  }

  return newWorkouts.length;
}

// POST /api/strava/sync — initial sync of 50 workouts
router.post('/sync', authMiddleware, async (req, res) => {
  try {
    const fullUser = await loadUserWithTokens(req.user.id);
    const token = await getValidToken(fullUser);

    const response = await axios.get('https://www.strava.com/api/v3/athlete/activities', {
      headers: { Authorization: `Bearer ${token}` },
      params: { per_page: 50, page: 1 }
    });

    const activities = response.data.filter(a => a.type === 'Run');
    const parsed = activities.map(a => parseActivity(a, req.user.id));
    const imported = await bulkUpsertWorkouts(parsed, req.user.id);

    res.json({ imported, total: activities.length });
  } catch (err) {
    console.error('Sync error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Sync failed' });
  }
});

// POST /api/strava/sync-all — background full history sync
router.post('/sync-all', authMiddleware, async (req, res) => {
  // Respond immediately, sync in background
  res.json({ status: 'started' });

  try {
    const fullUser = await loadUserWithTokens(req.user.id);
    const token = await getValidToken(fullUser);
    let page = 1;
    let hasMore = true;
    let totalImported = 0;

    while (hasMore) {
      const response = await axios.get('https://www.strava.com/api/v3/athlete/activities', {
        headers: { Authorization: `Bearer ${token}` },
        params: { per_page: 100, page }
      });

      if (response.data.length === 0) {
        hasMore = false;
        break;
      }

      const activities = response.data.filter(a => a.type === 'Run');
      const parsed = activities.map(a => parseActivity(a, req.user.id));
      const batchImported = await bulkUpsertWorkouts(parsed, req.user.id);
      totalImported += batchImported;

      page++;

      // Rate limiting — Strava allows 100 requests per 15 min
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    console.log(`Full sync complete for user ${req.user.id}: ${totalImported} new workouts`);
    // Save sync result to user record
    await supabase.from('users').update({ last_sync_status: 'done', last_sync_count: totalImported }).eq('id', req.user.id);
  } catch (err) {
    console.error('Full sync error:', err.response?.data || err.message);
    // Save error to user record
    await supabase.from('users').update({ last_sync_status: 'error' }).eq('id', req.user.id).catch(() => {});
  }
});

// Track active splits syncs to prevent duplicates
const activeSplitsSyncs = new Set();

// POST /api/strava/sync-splits — fetch detailed splits for all workouts missing them
router.post('/sync-splits', authMiddleware, async (req, res) => {
  if (activeSplitsSyncs.has(req.user.id)) {
    return res.json({ status: 'already_running' });
  }
  activeSplitsSyncs.add(req.user.id);
  res.json({ status: 'started' });

  try {
    const fullUser = await loadUserWithTokens(req.user.id);
    const token = await getValidToken(fullUser);

    // Find workouts without splits
    const { data: workoutsWithoutSplits } = await supabase
      .from('workouts')
      .select('id, strava_id')
      .eq('user_id', req.user.id)
      .is('splits', null)
      .order('date', { ascending: false });

    if (!workoutsWithoutSplits || workoutsWithoutSplits.length === 0) {
      console.log(`Splits sync: all workouts already have splits for user ${req.user.id}`);
      return;
    }

    console.log(`Splits sync: fetching details for ${workoutsWithoutSplits.length} workouts`);
    let updated = 0;

    for (const workout of workoutsWithoutSplits) {
      try {
        const detail = await axios.get(`https://www.strava.com/api/v3/activities/${workout.strava_id}`, {
          headers: { Authorization: `Bearer ${token}` }
        });

        const splits = detail.data.splits_metric;
        const updateData = {};

        if (splits && splits.length > 0) {
          updateData.splits = JSON.stringify(splits.map((s, i) => ({
            km: i + 1,
            time: s.moving_time,
            pace: s.moving_time / (s.distance / 1000),
            distance: s.distance,
            heartrate: s.average_heartrate || null,
            elevation: s.elevation_difference || 0
          })));
        }

        if (detail.data.description) {
          updateData.description = detail.data.description;
        }

        if (Object.keys(updateData).length > 0) {
          await supabase
            .from('workouts')
            .update(updateData)
            .eq('id', workout.id);

          updated++;
        }

        // Rate limiting — 100 req per 15 min = ~9 sec between requests to be safe
        await new Promise(resolve => setTimeout(resolve, 10000));
      } catch (err) {
        if (err.response?.status === 429) {
          console.log(`Rate limited, waiting 60s...`);
          await new Promise(resolve => setTimeout(resolve, 60000));
        }
      }
    }

    console.log(`Splits sync complete for user ${req.user.id}: ${updated} workouts updated`);
  } catch (err) {
    console.error('Splits sync error:', err.message);
  } finally {
    activeSplitsSyncs.delete(req.user.id);
  }
});

// GET /api/strava/sync-status — check how many workouts loaded
router.get('/sync-status', authMiddleware, async (req, res) => {
  try {
    const { count } = await supabase
      .from('workouts')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.user.id);

    // Also fetch sync status from user record
    const { data: userData } = await supabase
      .from('users')
      .select('last_sync_status, last_sync_count')
      .eq('id', req.user.id)
      .single();

    res.json({
      count: count || 0,
      syncStatus: userData?.last_sync_status || null,
      syncCount: userData?.last_sync_count || null
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get sync status' });
  }
});

// Strava Webhook verification (GET)
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.STRAVA_WEBHOOK_VERIFY_TOKEN) {
    res.json({ 'hub.challenge': challenge });
  } else {
    res.status(403).json({ error: 'Verification failed' });
  }
});

// Strava Webhook event (POST)
router.post('/webhook', async (req, res) => {
  res.status(200).send('OK');

  try {
    const { object_type, aspect_type, object_id, owner_id } = req.body;

    if (object_type !== 'activity' || aspect_type !== 'create') return;

    // Find user by strava_id
    const { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('strava_id', owner_id.toString())
      .single();

    if (!user) return;

    const token = await getValidToken(user);

    // Fetch the activity
    const response = await axios.get(`https://www.strava.com/api/v3/activities/${object_id}`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const activity = response.data;
    if (activity.type !== 'Run') return;

    const parsed = parseActivity(activity, user.id);

    // Check if already exists
    const { data: existing } = await supabase
      .from('workouts')
      .select('id')
      .eq('strava_id', parsed.strava_id)
      .eq('user_id', user.id)
      .single();

    if (!existing) {
      await supabase.from('workouts').insert(parsed);
      console.log(`Webhook: new workout saved for user ${user.id}`);
    }
  } catch (err) {
    console.error('Webhook processing error:', err.message);
  }
});

module.exports = router;
