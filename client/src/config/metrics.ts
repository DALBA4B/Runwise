import { Stats } from '../hooks/useWorkouts';
import { formatDistance, formatPace, formatTime } from '../utils';

export interface MetricConfig {
  id: string;
  label: string;
  icon: string;
  getValue: (stats: Stats) => string;
  sub?: string;
}

export const ALL_METRICS: MetricConfig[] = [
  {
    id: 'distance',
    label: 'Километры',
    icon: '📏',
    getValue: (s) => formatDistance(s.totalDistance),
  },
  {
    id: 'avg_pace',
    label: 'Ср. темп',
    icon: '⏱️',
    getValue: (s) => formatPace(s.avgPace),
    sub: 'мин/км',
  },
  {
    id: 'avg_hr',
    label: 'Ср. пульс',
    icon: '❤️',
    getValue: (s) => s.avgHeartrate ? `${s.avgHeartrate}` : '—',
    sub: 'уд/мин',
  },
  {
    id: 'workouts',
    label: 'Тренировки',
    icon: '🏋️',
    getValue: (s) => `${s.workoutCount}`,
    sub: 'пн — вс',
  },
  {
    id: 'total_time',
    label: 'Общее время',
    icon: '🕐',
    getValue: (s) => formatTime(s.totalTime),
  },
  {
    id: 'best_pace',
    label: 'Лучший темп',
    icon: '🚀',
    getValue: (s) => formatPace(s.bestPace),
    sub: 'мин/км',
  },
  {
    id: 'elevation',
    label: 'Набор высоты',
    icon: '⛰️',
    getValue: (s) => s.totalElevation ? `${s.totalElevation} м` : '0 м',
  },
];

const STORAGE_KEY = 'runwise_dashboard_widgets';
const DEFAULT_WIDGETS = ['distance', 'avg_pace', 'avg_hr', 'workouts'];

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
