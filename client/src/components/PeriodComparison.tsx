import React from 'react';
import { useTranslation } from 'react-i18next';
import { formatDistance, formatPace } from '../utils';
import i18n from '../i18n';

interface PeriodStats {
  distance: number;
  workoutCount: number;
  avgPace: number;
}

interface PeriodComparisonProps {
  data: { current: PeriodStats; previous: PeriodStats; changes: PeriodStats; dayOfMonth?: number } | null;
  loading: boolean;
}

const LOCALE_MAP: Record<string, string> = { ru: 'ru-RU', uk: 'uk-UA', en: 'en-US' };

const PeriodComparison: React.FC<PeriodComparisonProps> = ({ data, loading }) => {
  const { t } = useTranslation();

  if (loading) {
    return (
      <div className="period-comparison">
        <div className="period-comparison-title">{t('comparison.title')}</div>
        <div className="period-comparison-loading">{t('comparison.loading')}</div>
      </div>
    );
  }

  if (!data) return null;

  const locale = LOCALE_MAP[i18n.language] || 'ru-RU';
  const now = new Date();
  const curMonth = now.toLocaleDateString(locale, { month: 'long' });
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1).toLocaleDateString(locale, { month: 'long' });
  const day = data.dayOfMonth || now.getDate();

  // Capitalize first letter
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  const title = `${cap(curMonth)} vs ${cap(prevMonth)} · ${t('comparison.byDay', { day })}`;

  const metrics = [
    {
      label: t('comparison.distance'),
      value: formatDistance(data.current.distance),
      change: data.changes.distance,
      improved: data.changes.distance > 0
    },
    {
      label: t('comparison.workouts'),
      value: `${data.current.workoutCount}`,
      change: data.changes.workoutCount,
      improved: data.changes.workoutCount > 0
    },
    {
      label: t('comparison.avgPace'),
      value: formatPace(data.current.avgPace),
      change: data.changes.avgPace,
      improved: data.changes.avgPace < 0 // negative pace change = faster = better
    }
  ];

  return (
    <div className="period-comparison">
      <div className="period-comparison-title">{title}</div>
      <div className="period-comparison-row">
        {metrics.map((m, i) => (
          <div className="period-comparison-item" key={i}>
            <div className="period-comparison-label">{m.label}</div>
            <div className="period-comparison-value">{m.value}</div>
            <div className={`period-comparison-change ${m.improved ? 'improved' : m.change === 0 ? '' : 'worsened'}`}>
              {m.change === 0 ? '—' : (
                <>
                  <span>{m.improved ? '▲' : '▼'}</span>
                  {' '}{Math.abs(m.change).toFixed(1)}%
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default PeriodComparison;
