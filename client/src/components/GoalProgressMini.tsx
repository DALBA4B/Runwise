import React from 'react';

interface Goal {
  id: string;
  type: string;
  target_value: number;
  current_value: number;
}

interface GoalProgressMiniProps {
  goals: Goal[];
  onNavigate: (screen: string) => void;
}

const goalTypeLabels: Record<string, string> = {
  monthly_distance: 'Месячный объём',
  weekly_distance: 'Недельный объём',
  pb_5k: 'ЛР 5 км',
  pb_10k: 'ЛР 10 км',
  pb_21k: 'ЛР полумарафон',
  pb_42k: 'ЛР марафон',
  monthly_runs: 'Пробежки/мес'
};

const GoalProgressMini: React.FC<GoalProgressMiniProps> = ({ goals, onNavigate }) => {
  if (!goals || goals.length === 0) return null;

  const displayed = goals.slice(0, 3);

  return (
    <div className="goal-mini">
      <div className="goal-mini-title">Цели</div>
      {displayed.map(goal => {
        const pct = goal.target_value > 0
          ? Math.min(100, Math.round((goal.current_value / goal.target_value) * 100))
          : 0;
        return (
          <div className="goal-mini-item" key={goal.id}>
            <div className="goal-mini-info">
              <span className="goal-mini-name">{goalTypeLabels[goal.type] || goal.type}</span>
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
          Все цели →
        </button>
      )}
    </div>
  );
};

export default GoalProgressMini;
