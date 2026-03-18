import React from 'react';
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
}

const PlanRow: React.FC<PlanRowProps> = ({ plan, isToday }) => {
  return (
    <div className={`plan-row ${isToday ? 'today' : ''} ${plan.type === 'rest' ? 'rest' : ''}`}>
      <div className="plan-day-header">
        <div>
          <div className="plan-day-name">{plan.day}{isToday ? ' (сегодня)' : ''}</div>
          <div className="plan-day-badge">{plan.badge}</div>
        </div>
        <div>
          <div className="plan-day-type">{getTypeLabel(plan.type)}</div>
        </div>
      </div>
      {plan.distance_km > 0 && (
        <div className="plan-day-distance">{plan.distance_km} км</div>
      )}
      <div className="plan-day-description">{plan.description}</div>
    </div>
  );
};

export default PlanRow;
