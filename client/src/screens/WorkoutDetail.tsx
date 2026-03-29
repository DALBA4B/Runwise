import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { workouts, ai, strava } from '../api/api';
import { formatPace, formatDistance, formatTime, formatDateFull, getTypeLabel, getTypeBadge } from '../utils';

// Helper: localize suspicious reason code
function localizeReason(reason: string, t: any): string {
  const [type, ...params] = reason.split(':');
  if (type === 'split_too_fast') {
    const km = params[0];
    const pace = parseInt(params[1]);
    const min = Math.floor(pace / 60);
    const sec = pace % 60;
    return t('workout.splitTooFast', { km, pace: `${min}:${sec.toString().padStart(2, '0')}` });
  }
  if (type === 'split_too_slow') {
    const km = params[0];
    const pace = parseInt(params[1]);
    const min = Math.floor(pace / 60);
    const sec = pace % 60;
    return t('workout.splitTooSlow', { km, pace: `${min}:${sec.toString().padStart(2, '0')}` });
  }
  if (type === 'avg_median_drift') {
    return t('workout.avgMedianDrift', { percent: params[0] });
  }
  return reason;
}

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
  const { t } = useTranslation();
  const [workout, setWorkout] = useState<any>(null);
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [splitMode, setSplitMode] = useState<'1km' | '500m'>('1km');
  const [splits500m, setSplits500m] = useState<Split[] | null>(null);
  const [splits500mLoading, setSplits500mLoading] = useState(false);
  const [splits500mError, setSplits500mError] = useState<string | null>(null);

  // GPS anomaly states
  const [showExplainModal, setShowExplainModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editDistance, setEditDistance] = useState('');
  const [editMinutes, setEditMinutes] = useState('');
  const [editSeconds, setEditSeconds] = useState('');
  const [saving, setSaving] = useState(false);

  const isSuspicious = workout?.is_suspicious && !workout?.user_verified;
  const isVerified = workout?.is_suspicious && workout?.user_verified;

  const handleVerify = useCallback(async () => {
    if (!workout) return;
    setSaving(true);
    try {
      const updated = await workouts.update(workout.id, { action: 'verify' });
      setWorkout(updated);
      setShowExplainModal(false);
    } catch (err) {
      console.error('Verify failed:', err);
    } finally {
      setSaving(false);
    }
  }, [workout]);

  const handleSaveEdit = useCallback(async () => {
    if (!workout) return;
    const distMeters = Math.round(parseFloat(editDistance) * 1000);
    const timeSec = parseInt(editMinutes) * 60 + parseInt(editSeconds);
    if (isNaN(distMeters) || isNaN(timeSec) || distMeters <= 0 || timeSec <= 0) return;

    setSaving(true);
    try {
      const updated = await workouts.update(workout.id, {
        action: 'edit',
        manual_distance: distMeters,
        manual_moving_time: timeSec
      });
      setWorkout(updated);
      setShowEditModal(false);
      setShowExplainModal(false);
    } catch (err) {
      console.error('Edit failed:', err);
    } finally {
      setSaving(false);
    }
  }, [workout, editDistance, editMinutes, editSeconds]);

  const openEditModal = useCallback(() => {
    if (!workout) return;
    const dist = workout.manual_distance || workout.distance;
    const time = workout.manual_moving_time || workout.moving_time;
    setEditDistance((dist / 1000).toFixed(2));
    setEditMinutes(Math.floor(time / 60).toString());
    setEditSeconds((time % 60).toString());
    setShowEditModal(true);
  }, [workout]);

  // Computed live pace for edit modal
  const editLivePace = (() => {
    const d = parseFloat(editDistance);
    const t = parseInt(editMinutes) * 60 + parseInt(editSeconds);
    if (!d || !t || d <= 0 || t <= 0) return '';
    const pace = t / d; // sec per km
    const m = Math.floor(pace / 60);
    const s = Math.round(pace % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  })();

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
      setAnalysis(t('workout.analysisError'));
    } finally {
      setAnalysisLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="screen-loading">
        <div className="loader"></div>
        <p>{t('profile.loadingWorkout')}</p>
      </div>
    );
  }

  if (!workout) {
    return (
      <div className="screen">
        <button className="btn-back" onClick={onBack}>← {t('common.back')}</button>
        <p className="empty-text">{t('workout.notFound')}</p>
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
        setSplits500mError(t('workout.noGps'));
      } else if (msg.includes('rate limit')) {
        setSplits500mError(t('workout.rateLimit'));
      } else {
        setSplits500mError(t('workout.splits500mError'));
      }
    } finally {
      setSplits500mLoading(false);
    }
  };

  const splits500mData = splits500m ? parseSplitsData(splits500m, 500) : [];

  return (
    <div className="screen workout-detail-screen">
      <button className="btn-back" onClick={onBack}>← {t('common.back')}</button>

      <div className="workout-detail-header">
        <span className="workout-detail-badge">{getTypeBadge(workout.type)}</span>
        <h2 className="workout-detail-name">
          {workout.name}
          {isVerified && <span className="workout-verified-badge" style={{ marginLeft: 8 }}>✅</span>}
        </h2>
        <span className="workout-detail-date">{formatDateFull(workout.date)}</span>
        <span className="workout-detail-type">{getTypeLabel(workout.type)}</span>
      </div>

      {isSuspicious && (
        <div className="workout-warning-banner" onClick={() => setShowExplainModal(true)}>
          <span>⚠️ {t('workout.suspiciousWarning')}</span>
          <span className="workout-warning-arrow">›</span>
        </div>
      )}

      <div className="metrics-grid">
        {(() => {
          const effectiveDistance = workout.manual_distance || workout.distance;
          const effectiveTime = workout.manual_moving_time || workout.moving_time;
          const effectivePace = effectiveDistance > 0 ? Math.round(effectiveTime / (effectiveDistance / 1000)) : workout.average_pace;
          const hasManual = !!(workout.manual_distance || workout.manual_moving_time);
          return (<>
        <div className="metric-card">
          <div className="metric-icon">📏</div>
          <div className="metric-info">
            <span className="metric-value">{formatDistance(effectiveDistance)}</span>
            <span className="metric-label">{t('workout.distance')}{hasManual ? ' ✎' : ''}</span>
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-icon">⏱️</div>
          <div className="metric-info">
            <span className="metric-value">{formatPace(effectivePace)}</span>
            <span className="metric-label">{t('workout.pace')}{hasManual ? ' ✎' : ''}</span>
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-icon">⏳</div>
          <div className="metric-info">
            <span className="metric-value">{formatTime(effectiveTime)}</span>
            <span className="metric-label">{t('workout.time')}{hasManual ? ' ✎' : ''}</span>
          </div>
        </div>
          </>);
        })()}
        <div className="metric-card">
          <div className="metric-icon">❤️</div>
          <div className="metric-info">
            <span className="metric-value">{workout.average_heartrate ? Math.round(workout.average_heartrate) : '—'}</span>
            <span className="metric-label">{t('workout.heartrate')}</span>
            {workout.max_heartrate && <span className="metric-sub">{t('workout.maxHr', { value: Math.round(workout.max_heartrate) })}</span>}
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
              <span>{t('workout.slowest')}: {formatPace(maxPace)}</span>
              <span>{t('workout.average')}: {formatPace(workout.average_pace)}</span>
              <span>{t('workout.fastest')}: {formatPace(minPace)}</span>
            </div>
          </>
        );

        return (
          <div className="splits-section">
            <div className="splits-header">
              <h3 className="section-title">{t('workout.paceByKm')}</h3>
              <div className="splits-tabs">
                <button
                  className={`splits-tab ${splitMode === '1km' ? 'splits-tab-active' : ''}`}
                  onClick={() => setSplitMode('1km')}
                >
                  1 {t('units.km')}
                </button>
                <button
                  className={`splits-tab ${splitMode === '500m' ? 'splits-tab-active' : ''}`}
                  onClick={handleLoad500m}
                >
                  500 {t('units.m')}
                </button>
              </div>
            </div>

            {splitMode === '1km' && renderSplitBars(splitsData)}

            {splitMode === '500m' && splits500mLoading && (
              <div className="splits-loading">
                <div className="loader"></div>
                <span>{t('workout.loading500m')}</span>
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
          <span>🤖 {t('workout.aiAnalysis')}</span>
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
            {analysisLoading ? t('home.analyzing') : `🔍 ${t('workout.getAnalysis')}`}
          </button>
        )}
      </div>

      {/* Explain modal */}
      {showExplainModal && (
        <div className="modal-overlay" onClick={() => setShowExplainModal(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <h3>⚠️ {t('workout.suspiciousExplain')}</h3>
            <ul className="suspicious-reasons-list">
              {(() => {
                const reasons: string[] = workout.suspicious_reasons
                  ? (typeof workout.suspicious_reasons === 'string'
                    ? JSON.parse(workout.suspicious_reasons)
                    : workout.suspicious_reasons)
                  : [];
                return reasons.map((r: string, i: number) => (
                  <li key={i}>{localizeReason(r, t)}</li>
                ));
              })()}
            </ul>
            <div className="modal-actions">
              <button
                className="btn btn-accent"
                onClick={handleVerify}
                disabled={saving}
              >
                {saving ? t('common.saving') : t('workout.allCorrect')}
              </button>
              <button
                className="btn btn-secondary"
                onClick={openEditModal}
              >
                {t('workout.editWorkout')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit modal */}
      {showEditModal && (
        <div className="modal-overlay" onClick={() => setShowEditModal(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <h3>{t('workout.editWorkout')}</h3>
            <div className="form-group">
              <label>{t('workout.editDistance')} ({t('units.km')})</label>
              <input
                type="number"
                step="0.01"
                value={editDistance}
                onChange={e => setEditDistance(e.target.value)}
                className="form-input"
              />
            </div>
            <div className="form-group">
              <label>{t('workout.editTime')}</label>
              <div className="time-inputs">
                <input
                  type="number"
                  value={editMinutes}
                  onChange={e => setEditMinutes(e.target.value)}
                  className="form-input time-input"
                  placeholder={t('units.min')}
                />
                <span className="time-separator">:</span>
                <input
                  type="number"
                  value={editSeconds}
                  onChange={e => setEditSeconds(e.target.value)}
                  className="form-input time-input"
                  placeholder={t('units.sec')}
                />
              </div>
            </div>
            {editLivePace && (
              <div className="edit-live-pace">
                {t('workout.calculatedPace')}: <strong>{editLivePace}</strong> {t('units.minKm')}
              </div>
            )}
            <div className="modal-actions">
              <button
                className="btn btn-accent"
                onClick={handleSaveEdit}
                disabled={saving}
              >
                {saving ? t('workout.savingCorrection') : t('common.save')}
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => setShowEditModal(false)}
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default WorkoutDetail;
