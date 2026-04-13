import React from 'react';
import { useTranslation } from 'react-i18next';
import { getTypeLabel } from '../utils';

interface PlanDay {
  day: string;
  type: string;
  distance_km: number;
  pace?: string;
  description: string;
  badge: string;
}

interface PlanRowProps {
  plan: PlanDay;
  isToday?: boolean;
  dayLabel?: string;
}

// Extract pace from description for old plans without pace field
function extractPace(description: string): string | null {
  if (!description) return null;
  const patterns = [
    /(\d{1,2}:\d{2})\s*\/\s*(?:км|km)/i,
    /(?:темп[еі]?|pace|at)\s+(\d{1,2}:\d{2})/i,
    /(\d{1,2}:\d{2})\s*(?:мін\/км|мин\/км|min\/km)/i,
    /\((\d{1,2}:\d{2})\/км\)/i,
  ];
  for (const p of patterns) {
    const m = description.match(p);
    if (m) return m[1];
  }
  return null;
}

const PlanRow: React.FC<PlanRowProps> = ({ plan, isToday, dayLabel }) => {
  const { t } = useTranslation();
  const displayDay = dayLabel || plan.day;
  const pace = plan.pace || extractPace(plan.description);

  return (
    <div className={`plan-row ${isToday ? 'today' : ''} ${plan.type === 'rest' ? 'rest' : ''}`}>
      <div className="plan-day-header">
        <div>
          <div className="plan-day-name">{displayDay}{isToday ? ` (${t('plan.today')})` : ''}</div>
          <div className="plan-day-badge">{plan.badge}</div>
        </div>
        <div>
          <div className="plan-day-type">{getTypeLabel(plan.type)}</div>
        </div>
      </div>
      {plan.distance_km > 0 && (
        <div className="plan-day-stats">
          <div className="plan-day-stat">
            <span className="plan-day-stat-value">{plan.distance_km}</span>
            <span className="plan-day-stat-label">{t('units.km')}</span>
          </div>
          {pace && (
            <div className="plan-day-stat">
              <span className="plan-day-stat-value">{pace}</span>
              <span className="plan-day-stat-label">{t('units.minKm')}</span>
            </div>
          )}
        </div>
      )}
      <div className="plan-day-description">{plan.description}</div>
    </div>
  );
};

export default PlanRow;
