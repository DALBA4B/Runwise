import React from 'react';
import { useTranslation } from 'react-i18next';

interface Goal {
  id: string;
  type: string;
  target_value: number;
  current_value: number;
  _predPercent?: number;
}

interface GoalProgressMiniProps {
  goals: Goal[];
  onNavigate: (screen: string) => void;
}

const GoalProgressMini: React.FC<GoalProgressMiniProps> = ({ goals, onNavigate }) => {
  const { t } = useTranslation();

  if (!goals || goals.length === 0) return null;

  const displayed = goals.slice(0, 3);

  return (
    <div className="goal-mini">
      <div className="goal-mini-title">{t('goalsMini.title')}</div>
      {displayed.map(goal => {
        const pct = goal._predPercent != null
          ? Math.min(100, goal._predPercent)
          : goal.target_value > 0
            ? Math.min(100, Math.round((goal.current_value / goal.target_value) * 100))
            : 0;
        return (
          <div className="goal-mini-item" key={goal.id}>
            <div className="goal-mini-info">
              <span className="goal-mini-name">{t(`goalTypesMini.${goal.type}`, { defaultValue: goal.type })}</span>
              <span className="goal-mini-pct">{pct}%</span>
            </div>
            <div className="goal-mini-bar">
              <div
                className="goal-mini-bar-fill"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
      {goals.length > 3 && (
        <button className="btn-link goal-mini-link" onClick={() => onNavigate('profile')}>
          {t('goalsMini.allGoals')}
        </button>
      )}
    </div>
  );
};

export default GoalProgressMini;
