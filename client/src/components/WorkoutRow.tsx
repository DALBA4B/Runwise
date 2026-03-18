import React from 'react';
import { Workout } from '../hooks/useWorkouts';
import { formatPace, formatDistance, formatDate, getTypeBadge } from '../utils';

interface WorkoutRowProps {
  workout: Workout;
  onClick: (id: string) => void;
}

const WorkoutRow: React.FC<WorkoutRowProps> = ({ workout, onClick }) => {
  return (
    <div className="workout-row" onClick={() => onClick(workout.id)}>
      <div className="workout-row-badge">{getTypeBadge(workout.type)}</div>
      <div className="workout-row-info">
        <div className="workout-row-name">{workout.name}</div>
        <div className="workout-row-meta">
          <span>{formatDate(workout.date)}</span>
          <span>{formatDistance(workout.distance)}</span>
          <span>{formatPace(workout.average_pace)}</span>
        </div>
      </div>
    </div>
  );
};

export default WorkoutRow;
