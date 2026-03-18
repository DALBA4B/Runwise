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
  workoutCount: number;
}

export interface WeekDay {
  date: string;
  day: string;
  km: number;
}

export function useWorkouts() {
  const [recentWorkouts, setRecentWorkouts] = useState<Workout[]>([]);
  const [weeklyData, setWeeklyData] = useState<WeekDay[]>([]);
  const [weekStats, setWeekStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchDashboard = useCallback(async () => {
    setLoading(true);
    try {
      const [recent, weekly, stats] = await Promise.all([
        workouts.list({ limit: 5 }),
        workouts.weekly(),
        workouts.stats('week')
      ]);
      setRecentWorkouts(recent);
      setWeeklyData(weekly);
      setWeekStats(stats);
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
    refresh: fetchDashboard
  };
}

export function useWorkoutHistory() {
  const [allWorkouts, setAllWorkouts] = useState<Workout[]>([]);
  const [monthStats, setMonthStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedMonth, setSelectedMonth] = useState(new Date().getMonth() + 1);
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    try {
      const data = await workouts.list({ month: selectedMonth, year: selectedYear });
      setAllWorkouts(data);

      // Calculate month stats from data
      const totalDistance = data.reduce((sum: number, w: Workout) => sum + (w.distance || 0), 0);
      const totalTime = data.reduce((sum: number, w: Workout) => sum + (w.moving_time || 0), 0);
      const paces = data.filter((w: Workout) => w.average_pace > 0).map((w: Workout) => w.average_pace);
      const avgPace = paces.length > 0 ? Math.round(paces.reduce((a: number, b: number) => a + b, 0) / paces.length) : 0;
      const bestPace = paces.length > 0 ? Math.min(...paces) : 0;
      const hrs = data.filter((w: Workout) => w.average_heartrate).map((w: Workout) => w.average_heartrate!);
      const avgHr = hrs.length > 0 ? Math.round(hrs.reduce((a: number, b: number) => a + b, 0) / hrs.length) : 0;

      setMonthStats({
        totalDistance,
        totalTime,
        avgPace,
        avgHeartrate: avgHr,
        bestPace,
        workoutCount: data.length
      });
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
    setSelectedYear
  };
}
