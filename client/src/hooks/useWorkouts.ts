import { useState, useEffect, useCallback } from 'react';
import { workouts } from '../api/api';

export interface Workout {
  id: string;
  strava_id: string;
  name: string;
  distance: number;
  moving_time: number;
  average_pace: number;
  average_heartrate: number | null;
  max_heartrate: number | null;
  date: string;
  type: string;
  splits: string | null;
}

export interface Stats {
  totalDistance: number;
  totalTime: number;
  avgPace: number;
  avgHeartrate: number;
  bestPace: number;
  totalElevation: number;
  workoutCount: number;
}

export interface WeekDay {
  date: string;
  day: string;
  km: number;
}

// Cache helpers
function readCache<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function writeCache(key: string, data: any) {
  try { localStorage.setItem(key, JSON.stringify(data)); } catch {}
}

function calcStats(data: Workout[]): Stats {
  const totalDistance = data.reduce((sum, w) => sum + (w.distance || 0), 0);
  const totalTime = data.reduce((sum, w) => sum + (w.moving_time || 0), 0);
  const paces = data.filter(w => w.average_pace > 0).map(w => w.average_pace);
  const avgPace = paces.length > 0 ? Math.round(paces.reduce((a, b) => a + b, 0) / paces.length) : 0;
  const bestPace = paces.length > 0 ? Math.min(...paces) : 0;
  const hrs = data.filter(w => w.average_heartrate).map(w => w.average_heartrate!);
  const avgHr = hrs.length > 0 ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : 0;
  return { totalDistance, totalTime, avgPace, avgHeartrate: avgHr, bestPace, totalElevation: 0, workoutCount: data.length };
}

export function useWorkouts() {
  const cached = readCache<{ recent: Workout[]; weekly: WeekDay[]; stats: Stats }>('rw_home_cache');
  const [recentWorkouts, setRecentWorkouts] = useState<Workout[]>(cached?.recent || []);
  const [weeklyData, setWeeklyData] = useState<WeekDay[]>(cached?.weekly || []);
  const [weekStats, setWeekStats] = useState<Stats | null>(cached?.stats || null);
  const [loading, setLoading] = useState(!cached);

  const fetchDashboard = useCallback(async () => {
    try {
      const [recent, weekly, stats] = await Promise.all([
        workouts.list({ limit: 5 }),
        workouts.weekly(),
        workouts.stats('week')
      ]);
      setRecentWorkouts(recent);
      setWeeklyData(weekly);
      setWeekStats(stats);
      writeCache('rw_home_cache', { recent, weekly, stats });
    } catch (err) {
      console.error('Dashboard fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  return {
    recentWorkouts,
    weeklyData,
    weekStats,
    loading,
    hadCache: !!cached,
    refresh: fetchDashboard
  };
}

export function useWorkoutHistory() {
  const [selectedMonth, setSelectedMonth] = useState(new Date().getMonth() + 1);
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());

  const cacheKey = `rw_history_${selectedYear}_${selectedMonth}`;
  const cached = readCache<{ workouts: Workout[]; stats: Stats }>(cacheKey);
  const [allWorkouts, setAllWorkouts] = useState<Workout[]>(cached?.workouts || []);
  const [monthStats, setMonthStats] = useState<Stats | null>(cached?.stats || null);
  const [loading, setLoading] = useState(!cached);

  const fetchHistory = useCallback(async () => {
    const key = `rw_history_${selectedYear}_${selectedMonth}`;
    // Restore cache for new month if available
    const monthCache = readCache<{ workouts: Workout[]; stats: Stats }>(key);
    if (monthCache) {
      setAllWorkouts(monthCache.workouts);
      setMonthStats(monthCache.stats);
      setLoading(false);
    } else {
      setLoading(true);
    }

    try {
      const data = await workouts.list({ month: selectedMonth, year: selectedYear });
      setAllWorkouts(data);
      const stats = calcStats(data);
      setMonthStats(stats);
      writeCache(key, { workouts: data, stats });
    } catch (err) {
      console.error('History fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, [selectedMonth, selectedYear]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  return {
    allWorkouts,
    monthStats,
    loading,
    selectedMonth,
    selectedYear,
    setSelectedMonth,
    setSelectedYear,
    refresh: fetchHistory
  };
}
