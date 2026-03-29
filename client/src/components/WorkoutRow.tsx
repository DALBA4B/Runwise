import React from 'react';
import { Workout } from '../hooks/useWorkouts';
import { formatPace, formatDistance, formatDate, getTypeBadge } from '../utils';

interface WorkoutRowProps {
  workout: Workout;
  onClick: (id: string) => void;
}

const WorkoutRow: React.FC<WorkoutRowProps> = ({ workout, onClick }) => {
  const isSuspicious = workout.is_suspicious && !workout.user_verified;
  const isVerified = workout.is_suspicious && workout.user_verified;

  return (
    <div className="workout-row" onClick={() => onClick(workout.id)}>
      <div className="workout-row-badge">{getTypeBadge(workout.type)}</div>
      <div className="workout-row-info">
        <div className="workout-row-name">
          {workout.name}
          {isSuspicious && <span className="workout-warning-badge" title="GPS anomaly">⚠️</span>}
          {isVerified && <span className="workout-verified-badge" title="Verified">✅</span>}
        </div>
        <div className="workout-row-meta">
          <span>{formatDate(workout.date)}</span>
          <span>{formatDistance(workout.manual_distance || workout.distance)}</span>
          <span>{formatPace(
            (workout.manual_distance || workout.manual_moving_time)
              ? Math.round((workout.manual_moving_time || workout.moving_time) / ((workout.manual_distance || workout.distance) / 1000))
              : workout.average_pace
          )}</span>
        </div>
      </div>
    </div>
  );
};

export default WorkoutRow;
