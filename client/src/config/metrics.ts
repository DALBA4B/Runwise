import { Stats } from '../hooks/useWorkouts';
import { formatDistance, formatPace, formatTime } from '../utils';
import i18n from '../i18n';

export interface MetricConfig {
  id: string;
  labelKey: string;
  icon: string;
  getValue: (stats: Stats) => string;
  subKey?: string;
}

export const ALL_METRICS: MetricConfig[] = [
  {
    id: 'distance',
    labelKey: 'metrics.distance',
    icon: '📏',
    getValue: (s) => formatDistance(s.totalDistance),
  },
  {
    id: 'avg_pace',
    labelKey: 'metrics.avgPace',
    icon: '⏱️',
    getValue: (s) => formatPace(s.avgPace),
    subKey: 'units.minKm',
  },
  {
    id: 'avg_hr',
    labelKey: 'metrics.avgHr',
    icon: '❤️',
    getValue: (s) => s.avgHeartrate ? `${s.avgHeartrate}` : '—',
    subKey: 'units.bpm',
  },
  {
    id: 'workouts',
    labelKey: 'metrics.workouts',
    icon: '🏋️',
    getValue: (s) => `${s.workoutCount}`,
  },
  {
    id: 'total_time',
    labelKey: 'metrics.totalTime',
    icon: '🕐',
    getValue: (s) => formatTime(s.totalTime),
  },
  {
    id: 'best_pace',
    labelKey: 'metrics.bestPace',
    icon: '🚀',
    getValue: (s) => formatPace(s.bestPace),
    subKey: 'units.minKm',
  },
  {
    id: 'elevation',
    labelKey: 'metrics.elevation',
    icon: '⛰️',
    getValue: (s) => s.totalElevation ? `${s.totalElevation} ${i18n.t('units.m')}` : `0 ${i18n.t('units.m')}`,
  },
];

const STORAGE_KEY = 'runwise_dashboard_widgets';
const DEFAULT_WIDGETS = ['distance', 'avg_pace', 'avg_hr', 'workouts'];

const HISTORY_STORAGE_KEY = 'runwise_history_widgets';
const HISTORY_DEFAULT_WIDGETS = ['distance', 'workouts', 'best_pace'];

export function getSelectedWidgets(): string[] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.filter((id: string) => ALL_METRICS.some(m => m.id === id));
      }
    }
  } catch {}
  return DEFAULT_WIDGETS;
}

export function saveSelectedWidgets(ids: string[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
}

const PROFILE_STORAGE_KEY = 'runwise_profile_widgets';
const PROFILE_DEFAULT_WIDGETS = ['distance', 'workouts', 'best_pace', 'avg_pace'];

export function getProfileWidgets(): string[] {
  try {
    const saved = localStorage.getItem(PROFILE_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.filter((id: string) => ALL_METRICS.some(m => m.id === id));
      }
    }
  } catch {}
  return PROFILE_DEFAULT_WIDGETS;
}

export function saveProfileWidgets(ids: string[]): void {
  localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(ids));
}

export function getHistoryWidgets(): string[] {
  try {
    const saved = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.filter((id: string) => ALL_METRICS.some(m => m.id === id));
      }
    }
  } catch {}
  return HISTORY_DEFAULT_WIDGETS;
}

export function saveHistoryWidgets(ids: string[]): void {
  localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(ids));
}
