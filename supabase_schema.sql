-- Runwise Supabase Schema
-- Run this SQL in your Supabase SQL Editor

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  strava_id TEXT UNIQUE NOT NULL,
  strava_access_token TEXT,
  strava_refresh_token TEXT,
  strava_token_expires_at BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add physical params to users (run if columns don't exist yet)
ALTER TABLE users ADD COLUMN IF NOT EXISTS age INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS height_cm REAL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS weight_kg REAL;

-- Workouts table
CREATE TABLE IF NOT EXISTS workouts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  strava_id TEXT NOT NULL,
  name TEXT,
  distance INTEGER DEFAULT 0,
  moving_time INTEGER DEFAULT 0,
  average_pace INTEGER DEFAULT 0,
  average_heartrate REAL,
  max_heartrate REAL,
  date TIMESTAMPTZ,
  type TEXT DEFAULT 'other',
  splits JSONB,
  raw_data JSONB,
  UNIQUE(user_id, strava_id)
);

-- Plans table
CREATE TABLE IF NOT EXISTS plans (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  week_start DATE NOT NULL,
  workouts JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, week_start)
);

-- Goals table
CREATE TABLE IF NOT EXISTS goals (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  target_value REAL,
  current_value REAL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add extra columns to workouts (run if columns don't exist yet)
ALTER TABLE workouts ADD COLUMN IF NOT EXISTS total_elevation_gain REAL DEFAULT 0;
ALTER TABLE workouts ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE workouts ADD COLUMN IF NOT EXISTS splits_500m JSONB;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_workouts_user_id ON workouts(user_id);
CREATE INDEX IF NOT EXISTS idx_workouts_date ON workouts(date);
CREATE INDEX IF NOT EXISTS idx_workouts_user_date ON workouts(user_id, date);
CREATE INDEX IF NOT EXISTS idx_plans_user_id ON plans(user_id);
CREATE INDEX IF NOT EXISTS idx_goals_user_id ON goals(user_id);

-- Personal records table
CREATE TABLE IF NOT EXISTS personal_records (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  distance_type TEXT NOT NULL,  -- '1km', '3km', '5km', '10km', '21km', '42km'
  time_seconds INTEGER NOT NULL,
  record_date DATE,
  source TEXT DEFAULT 'manual', -- 'manual' | 'strava'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, distance_type)
);
CREATE INDEX IF NOT EXISTS idx_personal_records_user ON personal_records(user_id);

-- Enable Row Level Security (optional, since we use service key on backend)
-- ALTER TABLE users ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE workouts ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE goals ENABLE ROW LEVEL SECURITY;
