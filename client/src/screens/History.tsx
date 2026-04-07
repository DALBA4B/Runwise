import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import MetricCard from '../components/MetricCard';
import WorkoutRow from '../components/WorkoutRow';
import { useWorkoutHistory } from '../hooks/useWorkouts';
import { getMonthName } from '../utils';
import { ALL_METRICS, getHistoryWidgets, saveHistoryWidgets } from '../config/metrics';

interface HistoryProps {
  onWorkoutClick: (id: string) => void;
  isActive?: boolean;
}

const History: React.FC<HistoryProps> = ({ onWorkoutClick, isActive }) => {
  const { t } = useTranslation();
  const {
    allWorkouts,
    monthStats,
    loading,
    selectedMonth,
    selectedYear,
    setSelectedMonth,
    setSelectedYear,
    refresh
  } = useWorkoutHistory();

  const mountedRef = useRef(true);

  useEffect(() => {
    if (!mountedRef.current && isActive) {
      refresh();
    }
    mountedRef.current = false;
  }, [isActive]);

  const [selectedWidgets, setSelectedWidgets] = useState<string[]>(getHistoryWidgets);
  const [editMode, setEditMode] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [tempWidgets, setTempWidgets] = useState<string[]>([]);

  // Drag state
  const dragItem = useRef<number | null>(null);
  const dragOverItem = useRef<number | null>(null);
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // Touch drag
  const touchClone = useRef<HTMLElement | null>(null);

  const handlePrevMonth = () => {
    if (selectedMonth === 1) {
      setSelectedMonth(12);
      setSelectedYear(selectedYear - 1);
    } else {
      setSelectedMonth(selectedMonth - 1);
    }
  };

  const handleNextMonth = () => {
    if (selectedMonth === 12) {
      setSelectedMonth(1);
      setSelectedYear(selectedYear + 1);
    } else {
      setSelectedMonth(selectedMonth + 1);
    }
  };

  // Settings modal
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
    saveHistoryWidgets(tempWidgets);
    setShowSettings(false);
  };

  // Drag to reorder
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
      saveHistoryWidgets(arr);
    }
    dragItem.current = null;
    dragOverItem.current = null;
    setDraggingIdx(null);
  };

  const handleTouchStart = (e: React.TouchEvent, idx: number) => {
    if (!editMode) return;
    const touch = e.touches[0];
    dragItem.current = idx;
    setDraggingIdx(idx);

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

  const activeMetrics = selectedWidgets
    .map(id => ALL_METRICS.find(m => m.id === id))
    .filter(Boolean) as typeof ALL_METRICS;

  return (
    <div className="screen history-screen">
      <div className="home-header">
        <h2 className="screen-title">📅 {t('history.title')}</h2>
        <div className="home-header-actions">
          {editMode && (
            <button className="btn-icon" onClick={openSettings} title={t('home.addRemoveWidgets')}>
              ➕
            </button>
          )}
          <button
            className={`btn-icon ${editMode ? 'btn-icon-active' : ''}`}
            onClick={() => setEditMode(!editMode)}
            title={editMode ? t('common.done') : t('home.configureWidgets')}
          >
            {editMode ? '✓' : '⚙️'}
          </button>
        </div>
      </div>

      <div className="month-selector">
        <button className="month-btn" onClick={handlePrevMonth}>←</button>
        <span className="month-label">
          {getMonthName(selectedMonth)} {selectedYear}
        </span>
        <button className="month-btn" onClick={handleNextMonth}>→</button>
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
              label={t(metric.labelKey)}
              value={monthStats ? metric.getValue(monthStats) : '—'}
              sub={metric.subKey ? t(metric.subKey) : undefined}
            />
            {editMode && (
              <button
                className="metric-card-remove"
                onClick={() => {
                  const updated = selectedWidgets.filter(id => id !== metric.id);
                  setSelectedWidgets(updated);
                  saveHistoryWidgets(updated);
                }}
              >✕</button>
            )}
          </div>
        ))}
      </div>

      {!loading && allWorkouts.length === 0 ? (
        <p className="empty-text">{t('history.noWorkouts')}</p>
      ) : (
        <div className="workouts-list">
          {allWorkouts.map(w => (
            <WorkoutRow key={w.id} workout={w} onClick={onWorkoutClick} />
          ))}
        </div>
      )}

      {showSettings && (
        <div className="widget-settings-overlay" onClick={() => setShowSettings(false)}>
          <div className="widget-settings-modal" onClick={e => e.stopPropagation()}>
            <div className="widget-settings-header">
              <h3>{t('home.widgetSettings')}</h3>
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
                      <span className="widget-settings-label">{t(metric.labelKey)}</span>
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
              {t('home.saveCount', { count: tempWidgets.length })}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default History;
