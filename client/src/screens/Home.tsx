import React, { useState, useEffect } from 'react';
import MetricCard from '../components/MetricCard';
import WeekChart from '../components/WeekChart';
import WorkoutRow from '../components/WorkoutRow';
import PeriodComparison from '../components/PeriodComparison';
import GoalProgressMini from '../components/GoalProgressMini';
import { useWorkouts } from '../hooks/useWorkouts';
import { ai, workouts as workoutsApi } from '../api/api';
import { ALL_METRICS, getSelectedWidgets, saveSelectedWidgets } from '../config/metrics';

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

  const [selectedWidgets, setSelectedWidgets] = useState<string[]>(getSelectedWidgets);
  const [showSettings, setShowSettings] = useState(false);
  const [tempWidgets, setTempWidgets] = useState<string[]>([]);

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

  const openSettings = () => {
    setTempWidgets([...selectedWidgets]);
    setShowSettings(true);
  };

  const toggleMetric = (id: string) => {
    setTempWidgets(prev =>
      prev.includes(id) ? prev.filter(w => w !== id) : [...prev, id]
    );
  };

  const moveMetric = (id: string, direction: -1 | 1) => {
    setTempWidgets(prev => {
      const idx = prev.indexOf(id);
      if (idx < 0) return prev;
      const newIdx = idx + direction;
      if (newIdx < 0 || newIdx >= prev.length) return prev;
      const arr = [...prev];
      [arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]];
      return arr;
    });
  };

  const saveSettings = () => {
    if (tempWidgets.length === 0) return;
    setSelectedWidgets(tempWidgets);
    saveSelectedWidgets(tempWidgets);
    setShowSettings(false);
  };

  const activeMetrics = selectedWidgets
    .map(id => ALL_METRICS.find(m => m.id === id))
    .filter(Boolean) as typeof ALL_METRICS;

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
      <div className="home-header">
        <h2 className="screen-title">🏠 Главная</h2>
        <button className="btn-icon" onClick={openSettings} title="Настроить виджеты">
          ⚙️
        </button>
      </div>

      <div className="metrics-grid">
        {activeMetrics.map(metric => (
          <MetricCard
            key={metric.id}
            icon={metric.icon}
            label={metric.label}
            value={weekStats ? metric.getValue(weekStats) : '—'}
            sub={metric.sub}
          />
        ))}
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

      {showSettings && (
        <div className="widget-settings-overlay" onClick={() => setShowSettings(false)}>
          <div className="widget-settings-modal" onClick={e => e.stopPropagation()}>
            <div className="widget-settings-header">
              <h3>Настройка виджетов</h3>
              <button className="btn-icon" onClick={() => setShowSettings(false)}>✕</button>
            </div>

            <div className="widget-settings-list">
              {ALL_METRICS.map(metric => {
                const isSelected = tempWidgets.includes(metric.id);
                const idx = tempWidgets.indexOf(metric.id);
                return (
                  <div
                    key={metric.id}
                    className={`widget-settings-item ${isSelected ? 'active' : ''}`}
                  >
                    <label className="widget-settings-toggle">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleMetric(metric.id)}
                      />
                      <span className="widget-settings-icon">{metric.icon}</span>
                      <span className="widget-settings-label">{metric.label}</span>
                    </label>
                    {isSelected && (
                      <div className="widget-settings-order">
                        <button
                          className="btn-order"
                          disabled={idx === 0}
                          onClick={() => moveMetric(metric.id, -1)}
                        >↑</button>
                        <button
                          className="btn-order"
                          disabled={idx === tempWidgets.length - 1}
                          onClick={() => moveMetric(metric.id, 1)}
                        >↓</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <button
              className="btn btn-accent widget-settings-save"
              onClick={saveSettings}
              disabled={tempWidgets.length === 0}
            >
              Сохранить ({tempWidgets.length})
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default Home;
