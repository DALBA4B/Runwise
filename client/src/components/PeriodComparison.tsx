import React from 'react';
import { useTranslation } from 'react-i18next';
import './PeriodComparison.css';
import { formatDistance, formatPace } from '../utils';
import i18n from '../i18n';

interface PeriodStats {
  distance: number;
  workoutCount: number;
  avgPace: number;
  avgCE?: number | null;
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

  if (!data || !data.current || !data.previous) return null;

  const locale = LOCALE_MAP[i18n.language] || 'ru-RU';
  const now = new Date();
  const curMonth = now.toLocaleDateString(locale, { month: 'long' });
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1).toLocaleDateString(locale, { month: 'long' });
  const day = data.dayOfMonth || now.getDate();

  // Capitalize first letter
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  const title = `${cap(curMonth)} vs ${cap(prevMonth)} · ${t('comparison.byDay', { day })}`;

  // Absolute differences instead of percents — much clearer for users
  const distDiff = data.current.distance - data.previous.distance; // meters
  const workoutDiff = data.current.workoutCount - data.previous.workoutCount;
  const paceDiff = (data.current.avgPace > 0 && data.previous.avgPace > 0)
    ? data.current.avgPace - data.previous.avgPace
    : 0;

  // Cardiac efficiency comparison (only when both months have CE data)
  const hasCE = data.current.avgCE && data.previous.avgCE;
  const ceDiff = hasCE ? Math.round((data.current.avgCE! - data.previous.avgCE!) * 100) / 100 : 0;

  const metrics: Array<{ label: string; value: string; change: number; improved: boolean; format: (v: number) => string }> = [
    {
      label: t('comparison.distance'),
      value: formatDistance(data.current.distance),
      change: distDiff,
      improved: distDiff > 0,
      format: (v: number) => {
        const km = Math.abs(v) / 1000;
        return km >= 1 ? `${km.toFixed(1)} ${t('units.km')}` : `${Math.round(Math.abs(v))} ${t('units.m')}`;
      }
    },
    {
      label: t('comparison.workouts'),
      value: `${data.current.workoutCount}`,
      change: workoutDiff,
      improved: workoutDiff > 0,
      format: (v: number) => `${Math.abs(v)}`
    },
    {
      label: t('comparison.avgPace'),
      value: formatPace(data.current.avgPace),
      change: paceDiff,
      improved: paceDiff < 0, // negative = faster = better
      format: (v: number) => {
        const secs = Math.abs(Math.round(v));
        const m = Math.floor(secs / 60);
        const s = secs % 60;
        return m > 0 ? `${m}:${s.toString().padStart(2, '0')}` : `${s} ${t('comparison.sec')}`;
      }
    }
  ];

  if (hasCE) {
    metrics.push({
      label: t('comparison.cardiacEfficiency'),
      value: data.current.avgCE!.toFixed(2),
      change: ceDiff,
      improved: ceDiff < 0, // lower CE = faster pace per heartbeat = better
      format: (v: number) => Math.abs(v).toFixed(2)
    });
  }

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
                  {' '}{m.format(m.change)}
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
