import React from 'react';
import { useTranslation } from 'react-i18next';
import { getTypeLabel } from '../utils';

interface PlanDay {
  day: string;
  type: string;
  distance_km: number;
  description: string;
  badge: string;
}

interface PlanRowProps {
  plan: PlanDay;
  isToday?: boolean;
  dayLabel?: string;
}

const PlanRow: React.FC<PlanRowProps> = ({ plan, isToday, dayLabel }) => {
  const { t } = useTranslation();

  const displayDay = dayLabel || plan.day;

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
        <div className="plan-day-distance">{plan.distance_km} {t('units.km')}</div>
      )}
      <div className="plan-day-description">{plan.description}</div>
    </div>
  );
};

export default PlanRow;
