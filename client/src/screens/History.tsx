import React from 'react';
import MetricCard from '../components/MetricCard';
import WorkoutRow from '../components/WorkoutRow';
import { useWorkoutHistory } from '../hooks/useWorkouts';
import { formatPace, formatDistance, getMonthName } from '../utils';

interface HistoryProps {
  onWorkoutClick: (id: string) => void;
}

const History: React.FC<HistoryProps> = ({ onWorkoutClick }) => {
  const {
    allWorkouts,
    monthStats,
    loading,
    selectedMonth,
    selectedYear,
    setSelectedMonth,
    setSelectedYear
  } = useWorkoutHistory();

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

  return (
    <div className="screen history-screen">
      <h2 className="screen-title">📅 История</h2>

      <div className="month-selector">
        <button className="month-btn" onClick={handlePrevMonth}>←</button>
        <span className="month-label">
          {getMonthName(selectedMonth)} {selectedYear}
        </span>
        <button className="month-btn" onClick={handleNextMonth}>→</button>
      </div>

      {monthStats && (
        <div className="metrics-grid">
          <MetricCard
            icon="📏"
            label="Километры"
            value={formatDistance(monthStats.totalDistance)}
          />
          <MetricCard
            icon="🏃"
            label="Пробежки"
            value={`${monthStats.workoutCount}`}
          />
          <MetricCard
            icon="⚡"
            label="Лучший темп"
            value={formatPace(monthStats.bestPace)}
            sub="мин/км"
          />
        </div>
      )}

      {loading ? (
        <div className="screen-loading">
          <div className="loader"></div>
        </div>
      ) : allWorkouts.length === 0 ? (
        <p className="empty-text">Нет тренировок за этот месяц</p>
      ) : (
        <div className="workouts-list">
          {allWorkouts.map(w => (
            <WorkoutRow key={w.id} workout={w} onClick={onWorkoutClick} />
          ))}
        </div>
      )}
    </div>
  );
};

export default History;
