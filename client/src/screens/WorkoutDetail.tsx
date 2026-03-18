import React, { useState, useEffect } from 'react';
import { workouts, ai } from '../api/api';
import { formatPace, formatDistance, formatTime, formatDateFull, getTypeLabel, getTypeBadge } from '../utils';

interface WorkoutDetailProps {
  workoutId: string;
  onBack: () => void;
}

interface Split {
  // New format (from sync-splits)
  km?: number;
  time?: number;
  pace?: number;
  distance?: number;
  heartrate?: number | null;
  elevation?: number;
  // Old Strava format
  split?: number;
  average_speed?: number;
  elapsed_time?: number;
  moving_time?: number;
}

const WorkoutDetail: React.FC<WorkoutDetailProps> = ({ workoutId, onBack }) => {
  const [workout, setWorkout] = useState<any>(null);
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchWorkout = async () => {
      try {
        const data = await workouts.get(workoutId);
        setWorkout(data);
      } catch (err) {
        console.error('Failed to fetch workout:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchWorkout();
  }, [workoutId]);

  const handleAnalyze = async () => {
    setAnalysisLoading(true);
    try {
      const data = await ai.analyzeWorkout(workoutId);
      setAnalysis(data.analysis);
    } catch (err) {
      setAnalysis('Не удалось получить анализ.');
    } finally {
      setAnalysisLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="screen-loading">
        <div className="loader"></div>
        <p>Загрузка тренировки...</p>
      </div>
    );
  }

  if (!workout) {
    return (
      <div className="screen">
        <button className="btn-back" onClick={onBack}>← Назад</button>
        <p className="empty-text">Тренировка не найдена</p>
      </div>
    );
  }

  // Parse splits
  let splits: Split[] = [];
  try {
    if (workout.splits) {
      splits = typeof workout.splits === 'string' ? JSON.parse(workout.splits) : workout.splits;
    }
  } catch {}

  const splitsData = splits.map((s: Split, i: number) => {
    let pace = 0;
    if (s.pace) {
      // New format: pace is already sec/km
      pace = Math.round(s.pace);
    } else if (s.moving_time && s.distance) {
      // Old Strava format
      pace = Math.round(s.moving_time / (s.distance / 1000));
    } else if (s.time && s.distance) {
      pace = Math.round(s.time / (s.distance / 1000));
    }
    return {
      km: `${i + 1}`,
      pace,
      heartrate: s.heartrate || null
    };
  });

  return (
    <div className="screen workout-detail-screen">
      <button className="btn-back" onClick={onBack}>← Назад</button>

      <div className="workout-detail-header">
        <span className="workout-detail-badge">{getTypeBadge(workout.type)}</span>
        <h2 className="workout-detail-name">{workout.name}</h2>
        <span className="workout-detail-date">{formatDateFull(workout.date)}</span>
        <span className="workout-detail-type">{getTypeLabel(workout.type)}</span>
      </div>

      <div className="metrics-grid">
        <div className="metric-card">
          <div className="metric-icon">📏</div>
          <div className="metric-info">
            <span className="metric-value">{formatDistance(workout.distance)}</span>
            <span className="metric-label">Дистанция</span>
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-icon">⏱️</div>
          <div className="metric-info">
            <span className="metric-value">{formatPace(workout.average_pace)}</span>
            <span className="metric-label">Темп</span>
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-icon">⏳</div>
          <div className="metric-info">
            <span className="metric-value">{formatTime(workout.moving_time)}</span>
            <span className="metric-label">Время</span>
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-icon">❤️</div>
          <div className="metric-info">
            <span className="metric-value">{workout.average_heartrate ? Math.round(workout.average_heartrate) : '—'}</span>
            <span className="metric-label">Пульс</span>
            {workout.max_heartrate && <span className="metric-sub">макс {Math.round(workout.max_heartrate)}</span>}
          </div>
        </div>
      </div>

      {workout.description && (
        <div className="workout-description">
          <p>{workout.description}</p>
        </div>
      )}

      {splitsData.length > 0 && (() => {
        const paces = splitsData.map(s => s.pace).filter(p => p > 0);
        const minPace = Math.min(...paces);
        const maxPace = Math.max(...paces);
        const avgPace = paces.reduce((a, b) => a + b, 0) / paces.length;
        const range = maxPace - minPace || 1;

        return (
          <div className="splits-section">
            <h3 className="section-title">Разбивка по километрам</h3>
            <div className="splits-list">
              {splitsData.map((s, i) => {
                const barWidth = s.pace > 0 ? Math.max(20, 100 - ((s.pace - minPace) / range) * 60) : 0;
                const isFastest = s.pace === minPace && paces.length > 1;
                const isSlowest = s.pace === maxPace && paces.length > 1;

                return (
                  <div key={i} className="split-row">
                    <span className="split-km">{s.km}</span>
                    <div className="split-bar-container">
                      <div
                        className={`split-bar ${isFastest ? 'split-fastest' : isSlowest ? 'split-slowest' : ''}`}
                        style={{ width: `${barWidth}%` }}
                      />
                    </div>
                    <span className={`split-pace ${isFastest ? 'pace-fastest' : isSlowest ? 'pace-slowest' : ''}`}>
                      {formatPace(s.pace)}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="splits-summary">
              <span>Медленный: {formatPace(maxPace)}</span>
              <span>Средний: {formatPace(workout.average_pace)}</span>
              <span>Быстрый: {formatPace(minPace)}</span>
            </div>
          </div>
        );
      })()}

      <div className="ai-block">
        <div className="ai-block-header">
          <span>🤖 AI Анализ тренировки</span>
        </div>
        {analysis ? (
          <div className="ai-block-content">
            <p>{analysis}</p>
          </div>
        ) : (
          <button
            className="btn btn-accent btn-full"
            onClick={handleAnalyze}
            disabled={analysisLoading}
          >
            {analysisLoading ? 'Анализирую...' : '🔍 Получить AI анализ'}
          </button>
        )}
      </div>
    </div>
  );
};

export default WorkoutDetail;
