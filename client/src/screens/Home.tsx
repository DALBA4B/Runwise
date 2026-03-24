import React, { useState, useEffect, useRef } from 'react';
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
  const [editMode, setEditMode] = useState(false);

  // Drag state for reordering cards on the grid
  const dragItem = useRef<number | null>(null);
  const dragOverItem = useRef<number | null>(null);
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);

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

  // --- Settings modal ---
  const openSettings = () => {
    setTempWidgets([...selectedWidgets]);
    setShowSettings(true);
  };

  const toggleMetric = (id: string) => {
    setTempWidgets(prev =>
      prev.includes(id) ? prev.filter(w => w !== id) : [...prev, id]
    );
  };

  const saveSettings = () => {
    if (tempWidgets.length === 0) return;
    setSelectedWidgets(tempWidgets);
    saveSelectedWidgets(tempWidgets);
    setShowSettings(false);
  };

  // --- Drag to reorder on main grid ---
  const handleDragStart = (idx: number) => {
    dragItem.current = idx;
    setDraggingIdx(idx);
  };

  const handleDragEnter = (idx: number) => {
    dragOverItem.current = idx;
  };

  const handleDragEnd = () => {
    if (dragItem.current !== null && dragOverItem.current !== null && dragItem.current !== dragOverItem.current) {
      const arr = [...selectedWidgets];
      const [removed] = arr.splice(dragItem.current, 1);
      arr.splice(dragOverItem.current, 0, removed);
      setSelectedWidgets(arr);
      saveSelectedWidgets(arr);
    }
    dragItem.current = null;
    dragOverItem.current = null;
    setDraggingIdx(null);
  };

  // Touch drag support
  const touchStartPos = useRef<{ x: number; y: number } | null>(null);
  const touchClone = useRef<HTMLElement | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const handleTouchStart = (e: React.TouchEvent, idx: number) => {
    if (!editMode) return;
    const touch = e.touches[0];
    touchStartPos.current = { x: touch.clientX, y: touch.clientY };
    dragItem.current = idx;
    setDraggingIdx(idx);

    // Create a floating clone
    const target = e.currentTarget as HTMLElement;
    const clone = target.cloneNode(true) as HTMLElement;
    clone.classList.add('metric-card-drag-clone');
    clone.style.width = target.offsetWidth + 'px';
    clone.style.position = 'fixed';
    clone.style.left = touch.clientX - target.offsetWidth / 2 + 'px';
    clone.style.top = touch.clientY - target.offsetHeight / 2 + 'px';
    clone.style.zIndex = '9999';
    clone.style.pointerEvents = 'none';
    document.body.appendChild(clone);
    touchClone.current = clone;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!editMode || dragItem.current === null) return;
    const touch = e.touches[0];

    if (touchClone.current) {
      const target = e.currentTarget as HTMLElement;
      touchClone.current.style.left = touch.clientX - target.offsetWidth / 2 + 'px';
      touchClone.current.style.top = touch.clientY - target.offsetHeight / 2 + 'px';
    }

    // Find which card we're over
    if (gridRef.current) {
      const cards = gridRef.current.querySelectorAll('.metric-card-wrapper');
      cards.forEach((card, i) => {
        const rect = card.getBoundingClientRect();
        if (
          touch.clientX >= rect.left && touch.clientX <= rect.right &&
          touch.clientY >= rect.top && touch.clientY <= rect.bottom
        ) {
          dragOverItem.current = i;
        }
      });
    }
  };

  const handleTouchEnd = () => {
    if (touchClone.current) {
      document.body.removeChild(touchClone.current);
      touchClone.current = null;
    }
    handleDragEnd();
  };

  const toggleEditMode = () => {
    if (editMode) {
      setEditMode(false);
    } else {
      setEditMode(true);
    }
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
        <div className="home-header-actions">
          {editMode && (
            <button className="btn-icon" onClick={openSettings} title="Добавить/убрать виджеты">
              ➕
            </button>
          )}
          <button
            className={`btn-icon ${editMode ? 'btn-icon-active' : ''}`}
            onClick={toggleEditMode}
            title={editMode ? 'Готово' : 'Настроить виджеты'}
          >
            {editMode ? '✓' : '⚙️'}
          </button>
        </div>
      </div>

      <div className={`metrics-grid ${editMode ? 'metrics-grid-edit' : ''}`} ref={gridRef}>
        {activeMetrics.map((metric, idx) => (
          <div
            key={metric.id}
            className={`metric-card-wrapper ${editMode ? 'editable' : ''} ${draggingIdx === idx ? 'dragging' : ''}`}
            draggable={editMode}
            onDragStart={() => handleDragStart(idx)}
            onDragEnter={() => handleDragEnter(idx)}
            onDragEnd={handleDragEnd}
            onDragOver={(e) => e.preventDefault()}
            onTouchStart={(e) => handleTouchStart(e, idx)}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          >
            <MetricCard
              icon={metric.icon}
              label={metric.label}
              value={weekStats ? metric.getValue(weekStats) : '—'}
              sub={metric.id === 'workouts' ? 'пн — вс' : metric.sub}
            />
            {editMode && (
              <button
                className="metric-card-remove"
                onClick={() => {
                  const updated = selectedWidgets.filter(id => id !== metric.id);
                  setSelectedWidgets(updated);
                  saveSelectedWidgets(updated);
                }}
              >✕</button>
            )}
          </div>
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
          <div className="workouts-list">
            {recentWorkouts.map(w => (
              <WorkoutRow key={w.id} workout={w} onClick={onWorkoutClick} />
            ))}
          </div>
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
