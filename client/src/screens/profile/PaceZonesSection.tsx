import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ai } from '../../api/api';

interface ZoneRange {
  from: string;
  to: string;
}

interface SourceWorkout {
  id?: string;
  name: string;
  date: string;
  vdot?: number;
  distance?: number;
  movingTime?: number;
  type?: string;
  // decay fields
  originalVdot?: number;
  decayedVdot?: number;
  ageDays?: number;
}

interface PaceZonesData {
  vdot: number | null;
  level: string;
  zones: {
    easy: ZoneRange;
    marathon: ZoneRange;
    threshold: ZoneRange;
    interval: ZoneRange;
    repetition: ZoneRange;
  } | null;
  details: {
    source: 'records' | 'workouts' | 'decay' | null;
    weeklyKm: number;
    workoutsCount: number;
    avgPace: string | null;
    bestPace: string | null;
    recordsBreakdown: Array<{
      distance: string;
      time_seconds: number;
      date: string | null;
      vdot: number;
    }>;
    sourceWorkout: SourceWorkout | null;
    otherGoodWorkouts: SourceWorkout[];
  };
}

interface PaceZonesProps {
  onWorkoutClick?: (id: string) => void;
}

const PaceZonesSection: React.FC<PaceZonesProps> = ({ onWorkoutClick }) => {
  const { t } = useTranslation();
  const [data, setData] = useState<PaceZonesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [modalClosing, setModalClosing] = useState(false);

  useEffect(() => {
    ai.getPaceZones()
      .then((res: PaceZonesData) => setData(res))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  const closeModal = () => {
    setModalClosing(true);
    setTimeout(() => { setShowModal(false); setModalClosing(false); }, 300);
  };

  if (loading || !data?.vdot || !data?.zones) return null;

  const levelLabels: Record<string, string> = {
    beginner: t('paceZones.beginner'),
    intermediate: t('paceZones.intermediate'),
    advanced: t('paceZones.advanced')
  };

  const zoneColors: Record<string, string> = {
    easy: '#4CAF50',
    marathon: '#2196F3',
    threshold: '#FF9800',
    interval: '#f44336',
    repetition: '#9C27B0'
  };

  const zoneKeys = ['easy', 'marathon', 'threshold', 'interval', 'repetition'] as const;

  const zones = zoneKeys.map(key => ({
    key,
    label: t(`paceZones.${key}`),
    from: data.zones![key].from,
    to: data.zones![key].to,
    color: zoneColors[key]
  }));

  const formatTime = (sec: number) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return h > 0
      ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
      : `${m}:${s.toString().padStart(2, '0')}`;
  };

  const formatDistance = (meters: number) => {
    if (meters >= 1000) {
      const km = meters / 1000;
      return km % 1 === 0 ? `${km} км` : `${km.toFixed(1)} км`;
    }
    return `${meters} м`;
  };

  const sw = data.details?.sourceWorkout;
  const isDecay = data.details?.source === 'decay';

  return (
    <div className="profile-section">
      <h3 className="section-title">{t('paceZones.title')}</h3>

      {/* Compact summary */}
      <div className="pace-zones-summary">
        <div className="pace-zones-summary-item">
          <span className="pace-zones-summary-label">VDOT</span>
          <span className="pace-zones-summary-value accent">{data.vdot}</span>
        </div>
        <div className="pace-zones-summary-item">
          <span className="pace-zones-summary-label">{t('paceZones.levelLabel')}</span>
          <span className="pace-zones-summary-value">{levelLabels[data.level]}</span>
        </div>
        <div className="pace-zones-summary-item">
          <span className="pace-zones-summary-label">{t('paceZones.easy')}</span>
          <span className="pace-zones-summary-value">{data.zones.easy.to}</span>
        </div>
        <div className="pace-zones-summary-item">
          <span className="pace-zones-summary-label">{t('paceZones.threshold')}</span>
          <span className="pace-zones-summary-value">{data.zones.threshold.to}</span>
        </div>
      </div>

      <button className="btn btn-accent btn-full" onClick={() => setShowModal(true)}>
        {t('paceZones.details')}
      </button>

      {/* Details modal */}
      {showModal && ReactDOM.createPortal(
        <div className={`modal-overlay${modalClosing ? ' modal-closing' : ''}`} onClick={closeModal}>
          <div className={`modal-content${modalClosing ? ' modal-content-closing' : ''}`} onClick={e => e.stopPropagation()}>
            <h3>{t('paceZones.title')} — VDOT {data.vdot}</h3>

            {/* All zones */}
            <div className="pace-zones-list">
              {zones.map(z => (
                <div key={z.key} className="pace-zone-row">
                  <div className="pace-zone-indicator" style={{ backgroundColor: z.color }} />
                  <span className="pace-zone-label">{z.label}</span>
                  <span className="pace-zone-value">{z.from} – {z.to}</span>
                </div>
              ))}
            </div>

            {/* Source workout info */}
            {sw && (
              <div className="pace-zones-details">
                <h4>{t('paceZones.sourceWorkoutTitle')}</h4>

                <div className="pace-zones-source-card">
                  {sw.id && onWorkoutClick ? (
                    <button className="workout-link-chip" onClick={() => { closeModal(); onWorkoutClick(sw.id!); }}>
                      <span className="workout-link-icon">{'\u{1F3C3}'}</span>
                      <span className="workout-link-text">{sw.name || '—'}</span>
                      <span className="workout-link-arrow">{'\u203A'}</span>
                    </button>
                  ) : (
                    <div className="pace-zones-source-name">{sw.name || '—'}</div>
                  )}
                  {sw.date && <div className="pace-zones-source-date">{new Date(sw.date).toLocaleDateString()}</div>}

                  <div className="pace-zones-source-stats">
                    {sw.distance && (
                      <div className="pace-zones-detail-row">
                        <span>{t('paceZones.workoutDistance')}</span>
                        <span className="detail-value">{formatDistance(sw.distance)}</span>
                      </div>
                    )}
                    {sw.movingTime && (
                      <div className="pace-zones-detail-row">
                        <span>{t('paceZones.workoutTime')}</span>
                        <span className="detail-value">{formatTime(sw.movingTime)}</span>
                      </div>
                    )}
                  </div>

                  {/* Status badge */}
                  <div className={`pace-zones-source-badge ${isDecay ? 'badge-decay' : 'badge-recent'}`}>
                    {isDecay ? t('paceZones.sourceDecay') : t('paceZones.sourceRecent')}
                  </div>

                  {/* Decay details */}
                  {isDecay && sw.originalVdot && sw.decayedVdot && sw.ageDays && (
                    <div className="pace-zones-decay-info">
                      {t('paceZones.decayInfo', { days: sw.ageDays, original: sw.originalVdot, current: sw.decayedVdot })}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Other good workouts */}
            {data.details?.otherGoodWorkouts?.length > 0 && (
              <div className="pace-zones-details">
                <h4>{t('paceZones.otherGoodWorkouts')}</h4>
                {data.details.otherGoodWorkouts.map((w, i) => (
                  <div key={i} className="pace-zones-other-workout">
                    <div className="pace-zones-other-workout-header">
                      {w.id && onWorkoutClick ? (
                        <button className="workout-link-chip" onClick={() => { closeModal(); onWorkoutClick(w.id!); }}>
                          <span className="workout-link-icon">{'\u{1F3C3}'}</span>
                          <span className="workout-link-text">{w.name || '—'}</span>
                          <span className="workout-link-arrow">{'\u203A'}</span>
                        </button>
                      ) : (
                        <span className="pace-zones-other-workout-name">{w.name || '—'}</span>
                      )}
                      <span className="pace-zones-other-workout-vdot">VDOT {w.vdot}</span>
                    </div>
                    <div className="pace-zones-other-workout-meta">
                      {w.distance && <span>{formatDistance(w.distance)}</span>}
                      {w.movingTime && <span> · {formatTime(w.movingTime)}</span>}
                      {w.date && <span> · {new Date(w.date).toLocaleDateString()}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Stats */}
            {data.details && (
              <div className="pace-zones-details">
                <div className="pace-zones-detail-row">
                  <span>{t('paceZones.weeklyVolume')}</span>
                  <span className="detail-value">{data.details.weeklyKm} {t('units.km')}/{t('paceZones.week')}</span>
                </div>
                <div className="pace-zones-detail-row">
                  <span>{t('paceZones.workoutsAnalyzed')}</span>
                  <span className="detail-value">{data.details.workoutsCount}</span>
                </div>
              </div>
            )}

            {/* Per-record VDOT breakdown */}
            {data.details?.recordsBreakdown.length > 0 && (
              <div className="pace-zones-details">
                <h4>{t('paceZones.recordsVdot')}</h4>
                {data.details.recordsBreakdown.map((r, i) => (
                  <div key={i} className="pace-zones-detail-row">
                    <span>
                      {r.distance} — {formatTime(r.time_seconds)}
                      {r.date && <span className="detail-date"> ({r.date})</span>}
                    </span>
                    <span className="detail-value">VDOT {r.vdot}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Formula explanation */}
            <div className="pace-zones-formula">
              {t('paceZones.formulaExplanation')}
            </div>

            <button className="btn btn-full" onClick={closeModal} style={{ marginTop: 16 }}>
              {t('common.done')}
            </button>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

export default PaceZonesSection;
