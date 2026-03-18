import React, { useState, useEffect } from 'react';
import PlanRow from '../components/PlanRow';
import { ai } from '../api/api';

interface PlanDay {
  day: string;
  type: string;
  distance_km: number;
  description: string;
  badge: string;
}

const DAYS_RU = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];

const Plan: React.FC = () => {
  const [plan, setPlan] = useState<PlanDay[] | null>(null);
  const [weekStart, setWeekStart] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    fetchPlan();
  }, []);

  const fetchPlan = async () => {
    setLoading(true);
    try {
      const data = await ai.getPlan();
      if (data.plan) {
        const workouts = typeof data.plan.workouts === 'string'
          ? JSON.parse(data.plan.workouts)
          : data.plan.workouts;
        setPlan(workouts);
        setWeekStart(data.plan.week_start);
      }
    } catch (err) {
      console.error('Failed to fetch plan:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const data = await ai.generatePlan();
      if (data.plan) {
        const workouts = typeof data.plan.workouts === 'string'
          ? JSON.parse(data.plan.workouts)
          : data.plan.workouts;
        setPlan(workouts);
        setWeekStart(data.plan.week_start);
      }
    } catch (err) {
      console.error('Failed to generate plan:', err);
    } finally {
      setGenerating(false);
    }
  };

  const todayIndex = new Date().getDay();
  // Convert JS day (0=Sun) to our index (0=Mon)
  const todayPlanIndex = todayIndex === 0 ? 6 : todayIndex - 1;

  const totalPlannedKm = plan
    ? plan.reduce((sum, d) => sum + (d.distance_km || 0), 0)
    : 0;

  const trainingDays = plan
    ? plan.filter(d => d.type !== 'rest').length
    : 0;

  if (loading) {
    return (
      <div className="screen-loading">
        <div className="loader"></div>
        <p>Загрузка плана...</p>
      </div>
    );
  }

  return (
    <div className="screen plan-screen">
      <h2 className="screen-title">📋 План тренировок</h2>

      {plan ? (
        <>
          <div className="plan-summary">
            <div className="plan-summary-item">
              <span className="plan-summary-value">{totalPlannedKm.toFixed(1)}</span>
              <span className="plan-summary-label">км за неделю</span>
            </div>
            <div className="plan-summary-item">
              <span className="plan-summary-value">{trainingDays}</span>
              <span className="plan-summary-label">тренировок</span>
            </div>
            <div className="plan-summary-item">
              <span className="plan-summary-value">{7 - trainingDays}</span>
              <span className="plan-summary-label">дней отдыха</span>
            </div>
          </div>

          {weekStart && (
            <p className="plan-week-label">
              Неделя с {new Date(weekStart).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}
            </p>
          )}

          <div className="plan-list">
            {plan.map((day, index) => (
              <PlanRow
                key={index}
                plan={day}
                isToday={index === todayPlanIndex}
              />
            ))}
          </div>

          <button
            className="btn btn-secondary btn-full"
            onClick={handleGenerate}
            disabled={generating}
            style={{ marginTop: '16px' }}
          >
            {generating ? '🔄 Генерирую...' : '🔄 Пересоздать план'}
          </button>
        </>
      ) : (
        <div className="plan-empty">
          <p className="empty-text">У тебя пока нет плана тренировок</p>
          <p className="empty-sub">AI создаст персональный план на основе твоих последних тренировок</p>
          <button
            className="btn btn-accent btn-full"
            onClick={handleGenerate}
            disabled={generating}
          >
            {generating ? '🔄 Генерирую план...' : '✨ Создать план на неделю'}
          </button>
        </div>
      )}
    </div>
  );
};

export default Plan;
