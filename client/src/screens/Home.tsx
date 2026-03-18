import React, { useState, useEffect } from 'react';
import MetricCard from '../components/MetricCard';
import WeekChart from '../components/WeekChart';
import WorkoutRow from '../components/WorkoutRow';
import PeriodComparison from '../components/PeriodComparison';
import GoalProgressMini from '../components/GoalProgressMini';
import { useWorkouts } from '../hooks/useWorkouts';
import { formatPace, formatDistance } from '../utils';
import { ai, workouts as workoutsApi } from '../api/api';

interface HomeProps {
  onWorkoutClick: (id: string) => void;
  onNavigate: (screen: any) => void;
}

const Home: React.FC<HomeProps> = ({ onWorkoutClick, onNavigate }) => {
  const { recentWorkouts, weeklyData, weekStats, loading } = useWorkouts();
  const [weekAnalysis, setWeekAnalysis] = useState<string | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [comparison, setComparison] = useState<any>(null);
  const [comparisonLoading, setComparisonLoading] = useState(true);
  const [goals, setGoals] = useState<any[]>([]);

  useEffect(() => {
    workoutsApi.comparison()
      .then(data => setComparison(data))
      .catch(() => {})
      .finally(() => setComparisonLoading(false));
    workoutsApi.getGoals()
      .then(data => setGoals(data || []))
      .catch(() => {});
  }, []);

  const handleWeeklyAnalysis = async () => {
    setAnalysisLoading(true);
    try {
      const data = await ai.weeklyAnalysis();
      setWeekAnalysis(data.analysis);
    } catch (err) {
      setWeekAnalysis('Не удалось получить анализ. Попробуйте позже.');
    } finally {
      setAnalysisLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="screen-loading">
        <div className="loader"></div>
        <p>Загрузка данных...</p>
      </div>
    );
  }

  return (
    <div className="screen home-screen">
      <h2 className="screen-title">🏠 Главная</h2>

      <div className="metrics-grid">
        <MetricCard
          icon="📏"
          label="Километры"
          value={weekStats ? formatDistance(weekStats.totalDistance) : '0 км'}
        />
        <MetricCard
          icon="⏱️"
          label="Ср. темп"
          value={weekStats ? formatPace(weekStats.avgPace) : '—'}
          sub="мин/км"
        />
        <MetricCard
          icon="❤️"
          label="Ср. пульс"
          value={weekStats?.avgHeartrate ? `${weekStats.avgHeartrate}` : '—'}
          sub="уд/мин"
        />
        <MetricCard
          icon="🏋️"
          label="Тренировки"
          value={weekStats ? `${weekStats.workoutCount}` : '0'}
          sub="пн — вс"
        />
      </div>

      <GoalProgressMini goals={goals} onNavigate={onNavigate} />

      <WeekChart data={weeklyData} />

      <PeriodComparison data={comparison} loading={comparisonLoading} />

      <div className="ai-block">
        <div className="ai-block-header">
          <span>🤖 AI Анализ недели</span>
        </div>
        {weekAnalysis ? (
          <div className="ai-block-content">
            <p>{weekAnalysis}</p>
          </div>
        ) : (
          <div className="ai-block-actions">
            <button
              className="btn btn-accent"
              onClick={handleWeeklyAnalysis}
              disabled={analysisLoading}
            >
              {analysisLoading ? 'Анализирую...' : '🔍 Спросить AI'}
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => onNavigate('plan')}
            >
              📋 Мой план
            </button>
          </div>
        )}
      </div>

      <div className="section">
        <div className="section-header">
          <h3 className="section-title">Последние тренировки</h3>
          <button className="btn-link" onClick={() => onNavigate('history')}>
            Все →
          </button>
        </div>
        {recentWorkouts.length === 0 ? (
          <p className="empty-text">Тренировок пока нет. Синхронизируй Strava!</p>
        ) : (
          recentWorkouts.map(w => (
            <WorkoutRow key={w.id} workout={w} onClick={onWorkoutClick} />
          ))
        )}
      </div>
    </div>
  );
};

export default Home;
