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
    best_efforts: activity.best_efforts
      ? JSON.stringify(activity.best_efforts.map(e => ({
          name: e.name,
          distance: e.distance,
          moving_time: e.moving_time
        })))
      : null,
    raw_data: JSON.stringify(activity)
  };
}

// Helper: calculate 500m splits from GPS streams (distance, time, heartrate arrays)
function calculate500mSplits(distArr, timeArr, hrArr) {
  const SPLIT_DISTANCE = 500; // meters
  const splits = [];
  let splitStart = 0; // index of current split start

  const totalDist = distArr[distArr.length - 1];
  const numFullSplits = Math.floor(totalDist / SPLIT_DISTANCE);

  for (let s = 0; s <= numFullSplits; s++) {
    const targetDist = (s + 1) * SPLIT_DISTANCE;
    const startDist = s * SPLIT_DISTANCE;

    // Last partial split
    if (targetDist > totalDist && startDist >= totalDist) break;

    const isPartial = targetDist > totalDist;
    const endDist = isPartial ? totalDist : targetDist;
    const splitDist = endDist - startDist;

    if (splitDist < 1) break; // skip trivially short

    // Find interpolated start time
    let startTime;
    if (s === 0) {
      startTime = timeArr[0];
    } else {
      // Interpolate at startDist
      for (let i = 1; i < distArr.length; i++) {
        if (distArr[i] >= startDist) {
          const ratio = (startDist - distArr[i - 1]) / (distArr[i] - distArr[i - 1] || 1);
          startTime = timeArr[i - 1] + ratio * (timeArr[i] - timeArr[i - 1]);
          splitStart = i - 1;
          break;
        }
      }
    }

    // Find interpolated end time
    let endTime;
    let splitEnd = splitStart;
    for (let i = splitStart + 1; i < distArr.length; i++) {
      if (distArr[i] >= endDist) {
        const ratio = (endDist - distArr[i - 1]) / (distArr[i] - distArr[i - 1] || 1);
        endTime = timeArr[i - 1] + ratio * (timeArr[i] - timeArr[i - 1]);
        splitEnd = i;
        break;
      }
    }

    // If we couldn't find end point, use last point
    if (endTime === undefined) {
      endTime = timeArr[timeArr.length - 1];
      splitEnd = distArr.length - 1;
    }
    if (startTime === undefined) {
      startTime = timeArr[0];
    }

    const time = endTime - startTime;
    const pace = splitDist > 0 ? (time / (splitDist / 1000)) : 0; // sec per km

    // Average heartrate for this split range
    let heartrate = null;
    if (hrArr && hrArr.length > 0) {
      let hrSum = 0;
      let hrCount = 0;
      for (let i = splitStart; i <= Math.min(splitEnd, hrArr.length - 1); i++) {
        if (hrArr[i]) {
          hrSum += hrArr[i];
          hrCount++;
        }
      }
      if (hrCount > 0) heartrate = Math.round(hrSum / hrCount);
    }

    splits.push({
      km: (s + 1) * 0.5,
      time: Math.round(time),
      pace: Math.round(pace),
      distance: Math.round(splitDist),
      heartrate
    });

    splitStart = splitEnd;
  }

  return splits;
}

// Columns that may not exist in DB yet — detected at runtime
let missingColumns = new Set();

function stripMissingColumns(rows) {
  if (missingColumns.size === 0) return rows;
  return rows.map(row => {
    const clean = { ...row };
    for (const col of missingColumns) delete clean[col];
    return clean;
  });
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
  let toInsert = stripMissingColumns(newWorkouts);
  const { error } = await supabase.from('workouts').insert(toInsert);
  if (error) {
    // If a column doesn't exist in DB, detect it and retry without that column
    const colMatch = error.message.match(/Could not find the '(\w+)' column/);
    if (colMatch) {
      missingColumns.add(colMatch[1]);
      console.warn(`Column '${colMatch[1]}' missing in DB, retrying without it`);
      toInsert = stripMissingColumns(newWorkouts);
      const { error: retryError } = await supabase.from('workouts').insert(toInsert);
      if (retryError) {
        // Could be another missing column — try once more
        const colMatch2 = retryError.message.match(/Could not find the '(\w+)' column/);
        if (colMatch2) {
          missingColumns.add(colMatch2[1]);
          console.warn(`Column '${colMatch2[1]}' also missing, retrying`);
          toInsert = stripMissingColumns(newWorkouts);
          const { error: finalError } = await supabase.from('workouts').insert(toInsert);
          if (finalError) { console.error('Bulk insert error:', finalError.message); throw finalError; }
        } else {
          console.error('Bulk insert error:', retryError.message); throw retryError;
        }
      }
    } else {
      console.error('Bulk insert error:', error.message);
      throw error;
    }
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

    // Fire-and-forget: auto-load splits for workouts missing them
    runSplitsSync(req.user.id).catch(() => {});

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
    // Fire-and-forget: auto-load splits for workouts missing them
    runSplitsSync(req.user.id).catch(() => {});
  } catch (err) {
    console.error('Full sync error:', err.response?.data || err.message);
    // Save error to user record
    await supabase.from('users').update({ last_sync_status: 'error' }).eq('id', req.user.id).catch(() => {});
  }
});

// Track active splits syncs to prevent duplicates
const activeSplitsSyncs = new Set();

// Core logic: fetch detailed splits for all workouts missing them
async function runSplitsSync(userId) {
  if (activeSplitsSyncs.has(userId)) return;
  activeSplitsSyncs.add(userId);

  try {
    const fullUser = await loadUserWithTokens(userId);
    const token = await getValidToken(fullUser);

    // Find workouts without splits OR without best_efforts
    const { data: workoutsNeedingDetail } = await supabase
      .from('workouts')
      .select('id, strava_id, splits, best_efforts')
      .eq('user_id', userId)
      .or('splits.is.null,best_efforts.is.null')
      .order('date', { ascending: false });

    if (!workoutsNeedingDetail || workoutsNeedingDetail.length === 0) {
      console.log(`Splits sync: all workouts already have splits & best_efforts for user ${userId}`);
      return;
    }

    console.log(`Splits sync: fetching details for ${workoutsNeedingDetail.length} workouts`);
    let updated = 0;

    for (const workout of workoutsNeedingDetail) {
      try {
        const detail = await axios.get(`https://www.strava.com/api/v3/activities/${workout.strava_id}`, {
          headers: { Authorization: `Bearer ${token}` }
        });

        const splits = detail.data.splits_metric;
        const updateData = {};

        if (!workout.splits && splits && splits.length > 0) {
          updateData.splits = JSON.stringify(splits.map((s, i) => ({
            km: i + 1,
            time: s.moving_time,
            pace: s.moving_time / (s.distance / 1000),
            distance: s.distance,
            heartrate: s.average_heartrate || null,
            elevation: s.elevation_difference || 0
          })));
        }

        if (!workout.best_efforts && detail.data.best_efforts && detail.data.best_efforts.length > 0) {
          updateData.best_efforts = JSON.stringify(detail.data.best_efforts.map(e => ({
            name: e.name,
            distance: e.distance,
            moving_time: e.moving_time
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

    console.log(`Splits sync complete for user ${userId}: ${updated} workouts updated`);
  } catch (err) {
    console.error('Splits sync error:', err.message);
  } finally {
    activeSplitsSyncs.delete(userId);
  }
}


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

// POST /api/strava/sync-splits-500/:workoutId — fetch streams and compute 500m splits
router.post('/sync-splits-500/:workoutId', authMiddleware, async (req, res) => {
  try {
    const { workoutId } = req.params;

    // 1. Get workout from DB
    const { data: workout, error: wErr } = await supabase
      .from('workouts')
      .select('id, strava_id, splits_500m, user_id')
      .eq('id', workoutId)
      .eq('user_id', req.user.id)
      .single();

    if (wErr || !workout) {
      return res.status(404).json({ error: 'Workout not found' });
    }

    // 2. Return cached if available
    if (workout.splits_500m) {
      const cached = typeof workout.splits_500m === 'string'
        ? JSON.parse(workout.splits_500m) : workout.splits_500m;
      return res.json({ splits_500m: cached, cached: true });
    }

    // 3. Fetch streams from Strava
    const fullUser = await loadUserWithTokens(req.user.id);
    const token = await getValidToken(fullUser);

    let streamsData;
    try {
      const streamsResp = await axios.get(
        `https://www.strava.com/api/v3/activities/${workout.strava_id}/streams`,
        {
          headers: { Authorization: `Bearer ${token}` },
          params: { keys: 'distance,time,heartrate', key_type: 'value' }
        }
      );
      streamsData = streamsResp.data;
    } catch (streamErr) {
      if (streamErr.response?.status === 429) {
        return res.status(429).json({ error: 'Strava rate limit, try again later' });
      }
      if (streamErr.response?.status === 404) {
        return res.status(404).json({ error: 'GPS data not available for this workout' });
      }
      throw streamErr;
    }

    // 4. Parse streams
    const distStream = streamsData.find(s => s.type === 'distance');
    const timeStream = streamsData.find(s => s.type === 'time');
    const hrStream = streamsData.find(s => s.type === 'heartrate');

    if (!distStream || !timeStream) {
      return res.status(404).json({ error: 'GPS data not available for this workout' });
    }

    // 5. Calculate 500m splits
    const splits500m = calculate500mSplits(
      distStream.data,
      timeStream.data,
      hrStream ? hrStream.data : null
    );

    // 6. Cache in DB
    await supabase
      .from('workouts')
      .update({ splits_500m: JSON.stringify(splits500m) })
      .eq('id', workoutId);

    res.json({ splits_500m: splits500m, cached: false });
  } catch (err) {
    console.error('500m splits error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to compute 500m splits' });
  }
});

// Helper: fire-and-forget 500m splits calculation for a workout
async function fetchAndSave500mSplits(workoutId, stravaId, userId) {
  try {
    const fullUser = await loadUserWithTokens(userId);
    const token = await getValidToken(fullUser);

    const streamsResp = await axios.get(
      `https://www.strava.com/api/v3/activities/${stravaId}/streams`,
      {
        headers: { Authorization: `Bearer ${token}` },
        params: { keys: 'distance,time,heartrate', key_type: 'value' }
      }
    );

    const distStream = streamsResp.data.find(s => s.type === 'distance');
    const timeStream = streamsResp.data.find(s => s.type === 'time');
    const hrStream = streamsResp.data.find(s => s.type === 'heartrate');

    if (!distStream || !timeStream) return;

    const splits500m = calculate500mSplits(
      distStream.data,
      timeStream.data,
      hrStream ? hrStream.data : null
    );

    await supabase
      .from('workouts')
      .update({ splits_500m: JSON.stringify(splits500m) })
      .eq('id', workoutId);

    console.log(`500m splits saved for workout ${workoutId}`);
  } catch (err) {
    // Silently fail — will be computed on-demand later
    console.error(`Failed to pre-compute 500m splits for ${workoutId}:`, err.message);
  }
}

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
      const toInsert = stripMissingColumns([parsed])[0];
      const { data: inserted, error } = await supabase.from('workouts').insert(toInsert).select('id').single();
      if (error) {
        const colMatch = error.message.match(/Could not find the '(\w+)' column/);
        if (colMatch) {
          missingColumns.add(colMatch[1]);
          const cleaned = stripMissingColumns([parsed])[0];
          const { data: inserted2 } = await supabase.from('workouts').insert(cleaned).select('id').single();
          if (inserted2) {
            fetchAndSave500mSplits(inserted2.id, parsed.strava_id, user.id).catch(() => {});
          }
        } else {
          throw error;
        }
      } else if (inserted) {
        // Fire-and-forget: pre-compute 500m splits
        fetchAndSave500mSplits(inserted.id, parsed.strava_id, user.id).catch(() => {});
      }
      console.log(`Webhook: new workout saved for user ${user.id}`);
    }
  } catch (err) {
    console.error('Webhook processing error:', err.message);
  }
});

module.exports = router;
