import React from 'react';
import { formatDistance, formatPace } from '../utils';

interface PeriodStats {
  distance: number;
  workoutCount: number;
  avgPace: number;
}

interface PeriodComparisonProps {
  data: { current: PeriodStats; previous: PeriodStats; changes: PeriodStats } | null;
  loading: boolean;
}

const PeriodComparison: React.FC<PeriodComparisonProps> = ({ data, loading }) => {
  if (loading) {
    return (
      <div className="period-comparison">
        <div className="period-comparison-title">Этот месяц vs прошлый</div>
        <div className="period-comparison-loading">Загрузка...</div>
      </div>
    );
  }

  if (!data) return null;

  const metrics = [
    {
      label: 'Дистанция',
      value: formatDistance(data.current.distance),
      change: data.changes.distance,
      improved: data.changes.distance > 0
    },
    {
      label: 'Тренировки',
      value: `${data.current.workoutCount}`,
      change: data.changes.workoutCount,
      improved: data.changes.workoutCount > 0
    },
    {
      label: 'Ср. темп',
      value: formatPace(data.current.avgPace),
      change: data.changes.avgPace,
      improved: data.changes.avgPace < 0 // negative pace change = faster = better
    }
  ];

  return (
    <div className="period-comparison">
      <div className="period-comparison-title">Этот месяц vs прошлый</div>
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
