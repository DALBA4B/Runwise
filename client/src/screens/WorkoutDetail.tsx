import React, { useState, useEffect } from 'react';
import { workouts, ai, strava } from '../api/api';
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
  const [splitMode, setSplitMode] = useState<'1km' | '500m'>('1km');
  const [splits500m, setSplits500m] = useState<Split[] | null>(null);
  const [splits500mLoading, setSplits500mLoading] = useState(false);
  const [splits500mError, setSplits500mError] = useState<string | null>(null);

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

  // Parse 1km splits
  let splits: Split[] = [];
  try {
    if (workout.splits) {
      splits = typeof workout.splits === 'string' ? JSON.parse(workout.splits) : workout.splits;
    }
  } catch {}

  const parseSplitsData = (rawSplits: Split[], splitDistM: number) => {
    return rawSplits.map((s: Split, i: number) => {
      let pace = 0;
      if (s.pace) {
        pace = Math.round(s.pace);
      } else if (s.moving_time && s.distance) {
        pace = Math.round(s.moving_time / (s.distance / 1000));
      } else if (s.time && s.distance) {
        pace = Math.round(s.time / (s.distance / 1000));
      }

      const isLast = i === rawSplits.length - 1;
      const distMeters = s.distance || splitDistM;
      const isPartial = isLast && Math.abs(distMeters - splitDistM) > 10;

      let km: string;
      if (splitDistM === 500) {
        km = isPartial ? `${(distMeters / 1000).toFixed(2)}` : `${((i + 1) * 0.5).toFixed(1)}`;
      } else {
        km = isPartial ? `${(distMeters / 1000).toFixed(2)}` : `${i + 1}`;
      }

      return { km, pace, heartrate: s.heartrate || null };
    });
  };

  const splitsData = parseSplitsData(splits, 1000);

  // Load 500m splits on-demand
  const handleLoad500m = async () => {
    if (splits500m) {
      setSplitMode('500m');
      return;
    }
    // Check if workout already has cached 500m splits
    if (workout.splits_500m) {
      const cached = typeof workout.splits_500m === 'string'
        ? JSON.parse(workout.splits_500m) : workout.splits_500m;
      setSplits500m(cached);
      setSplitMode('500m');
      return;
    }
    setSplitMode('500m');
    setSplits500mLoading(true);
    setSplits500mError(null);
    try {
      const data = await strava.syncSplits500(workoutId);
      setSplits500m(data.splits_500m);
    } catch (err: any) {
      const msg = err.message || '';
      if (msg.includes('GPS') || msg.includes('not available')) {
        setSplits500mError('GPS-данные недоступны для этой тренировки');
      } else if (msg.includes('rate limit')) {
        setSplits500mError('Лимит запросов Strava, попробуйте позже');
      } else {
        setSplits500mError('Не удалось загрузить 500м сплиты');
      }
    } finally {
      setSplits500mLoading(false);
    }
  };

  const splits500mData = splits500m ? parseSplitsData(splits500m, 500) : [];

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

      {(splitsData.length > 0 || splitMode === '500m') && (() => {
        const activeSplits = splitMode === '1km' ? splitsData : splits500mData;
        const paces = activeSplits.map(s => s.pace).filter(p => p > 0);
        const minPace = paces.length > 0 ? Math.min(...paces) : 0;
        const maxPace = paces.length > 0 ? Math.max(...paces) : 0;
        const range = maxPace - minPace || 1;

        const renderSplitBars = (data: typeof splitsData) => (
          <>
            <div className="splits-list">
              {data.map((s, i) => {
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
          </>
        );

        return (
          <div className="splits-section">
            <div className="splits-header">
              <h3 className="section-title">Темп по километрам</h3>
              <div className="splits-tabs">
                <button
                  className={`splits-tab ${splitMode === '1km' ? 'splits-tab-active' : ''}`}
                  onClick={() => setSplitMode('1km')}
                >
                  1 км
                </button>
                <button
                  className={`splits-tab ${splitMode === '500m' ? 'splits-tab-active' : ''}`}
                  onClick={handleLoad500m}
                >
                  500 м
                </button>
              </div>
            </div>

            {splitMode === '1km' && renderSplitBars(splitsData)}

            {splitMode === '500m' && splits500mLoading && (
              <div className="splits-loading">
                <div className="loader"></div>
                <span>Загрузка 500м сплитов...</span>
              </div>
            )}

            {splitMode === '500m' && splits500mError && (
              <div className="splits-error">{splits500mError}</div>
            )}

            {splitMode === '500m' && !splits500mLoading && !splits500mError && splits500mData.length > 0 && renderSplitBars(splits500mData)}
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
