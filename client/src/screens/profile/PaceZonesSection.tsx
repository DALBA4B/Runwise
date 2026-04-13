import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ai } from '../../api/api';

interface ZoneRange {
  from: string;
  to: string;
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
  };
}

const PaceZonesSection: React.FC = () => {
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

            {/* All zones as continuous ranges */}
            <div className="pace-zones-list">
              {zones.map(z => (
                <div key={z.key} className="pace-zone-row">
                  <div className="pace-zone-indicator" style={{ backgroundColor: z.color }} />
                  <span className="pace-zone-label">{z.label}</span>
                  <span className="pace-zone-value">{z.from} – {z.to}</span>
                </div>
              ))}
            </div>

            {/* Calculation details */}
            {data.details && (
              <div className="pace-zones-details">
                <h4>{t('paceZones.calculationTitle')}</h4>

                <div className="pace-zones-detail-row">
                  <span>{t('paceZones.source')}</span>
                  <span className="detail-value">
                    {data.details.source === 'records' ? t('paceZones.fromRecords') : data.details.source === 'decay' ? t('paceZones.fromDecay') : t('paceZones.fromWorkouts')}
                  </span>
                </div>

                <div className="pace-zones-detail-row">
                  <span>{t('paceZones.weeklyVolume')}</span>
                  <span className="detail-value">{data.details.weeklyKm} {t('units.km')}/{t('paceZones.week')}</span>
                </div>

                <div className="pace-zones-detail-row">
                  <span>{t('paceZones.workoutsAnalyzed')}</span>
                  <span className="detail-value">{data.details.workoutsCount}</span>
                </div>

                {data.details.avgPace && (
                  <div className="pace-zones-detail-row">
                    <span>{t('paceZones.avgPace')}</span>
                    <span className="detail-value">{data.details.avgPace} /{t('units.km')}</span>
                  </div>
                )}

                {data.details.bestPace && (
                  <div className="pace-zones-detail-row">
                    <span>{t('paceZones.bestPace')}</span>
                    <span className="detail-value">{data.details.bestPace} /{t('units.km')}</span>
                  </div>
                )}

                {/* Per-record VDOT breakdown */}
                {data.details.recordsBreakdown.length > 0 && (
                  <>
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
                  </>
                )}
              </div>
            )}

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
