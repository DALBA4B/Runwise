import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import './MacroPlanTimeline.css';

interface MacroPlanWeek {
  week_number: number;
  start_date: string;
  phase: 'base' | 'build' | 'peak' | 'taper';
  target_volume_km: number;
  key_sessions_count: number;
  key_session_types: string[];
  notes: string;
  actual_volume_km?: number | null;
  actual_sessions?: number | null;
  compliance_pct?: number | null;
}

interface MacroPlan {
  id: string;
  goal_type: string;
  goal_target_value: number;
  race_date: string | null;
  total_weeks: number;
  current_week: number;
  status: string;
  weeks: MacroPlanWeek[];
}

interface MacroPlanTimelineProps {
  macroPlan: MacroPlan;
}

const LOCALE_MAP: Record<string, string> = { ru: 'ru-RU', uk: 'uk-UA', en: 'en-US' };

const GOAL_NAMES: Record<string, Record<string, string>> = {
  ru: { pb_5k: '5 km', pb_10k: '10 km', pb_21k: 'Полумарафон', pb_42k: 'Марафон', monthly_distance: 'Месячный объём', weekly_distance: 'Недельный объём' },
  uk: { pb_5k: '5 km', pb_10k: '10 km', pb_21k: 'Півмарафон', pb_42k: 'Марафон', monthly_distance: "Місячний об'єм", weekly_distance: "Тижневий об'єм" },
  en: { pb_5k: '5K', pb_10k: '10K', pb_21k: 'Half Marathon', pb_42k: 'Marathon', monthly_distance: 'Monthly volume', weekly_distance: 'Weekly volume' }
};

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  return h > 0
    ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
    : `${m}:${s.toString().padStart(2, '0')}`;
}

const MacroPlanTimeline: React.FC<MacroPlanTimelineProps> = ({ macroPlan }) => {
  const { t } = useTranslation();
  const [selectedWeek, setSelectedWeek] = useState<number | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const currentWeekRef = useRef<HTMLDivElement>(null);

  const lang = i18n.language || 'ru';
  const locale = LOCALE_MAP[lang] || 'ru-RU';
  const weeks = macroPlan.weeks;
  const currentWeek = macroPlan.current_week;

  // Scroll to current week on mount
  useEffect(() => {
    if (currentWeekRef.current && timelineRef.current) {
      const container = timelineRef.current;
      const el = currentWeekRef.current;
      const scrollLeft = el.offsetLeft - container.clientWidth / 2 + el.clientWidth / 2;
      container.scrollTo({ left: Math.max(0, scrollLeft), behavior: 'smooth' });
    }
  }, [currentWeek]);

  // Goal display
  const goalNames = GOAL_NAMES[lang] || GOAL_NAMES.ru;
  const goalName = goalNames[macroPlan.goal_type] || macroPlan.goal_type;
  const isPB = ['pb_5k', 'pb_10k', 'pb_21k', 'pb_42k'].includes(macroPlan.goal_type);
  const targetStr = isPB ? formatTime(macroPlan.goal_target_value) : `${(macroPlan.goal_target_value / 1000).toFixed(0)} ${t('macroPlan.km')}`;

  // Race date
  const raceDateStr = macroPlan.race_date
    ? new Date(macroPlan.race_date).toLocaleDateString(locale, { day: 'numeric', month: 'short' })
    : null;

  // Weeks left
  const weeksLeft = macroPlan.total_weeks - currentWeek;

  // Current phase
  const currentWeekData = weeks[currentWeek - 1];
  const currentPhase = currentWeekData?.phase || 'base';

  // Group weeks by month for labels
  const monthGroups: { label: string; count: number }[] = [];
  let prevMonth = '';
  weeks.forEach(w => {
    const d = new Date(w.start_date);
    const monthLabel = d.toLocaleDateString(locale, { month: 'short' });
    if (monthLabel !== prevMonth) {
      monthGroups.push({ label: monthLabel, count: 1 });
      prevMonth = monthLabel;
    } else {
      monthGroups[monthGroups.length - 1].count++;
    }
  });

  // Get week status
  const getWeekStatus = (w: MacroPlanWeek): 'past' | 'current' | 'future' => {
    if (w.week_number < currentWeek) return 'past';
    if (w.week_number === currentWeek) return 'current';
    return 'future';
  };

  const getComplianceClass = (pct: number | null | undefined): string => {
    if (pct == null) return '';
    if (pct >= 90) return 'compliance-high';
    if (pct >= 70) return 'compliance-mid';
    return 'compliance-low';
  };

  const selectedWeekData = selectedWeek != null ? weeks.find(w => w.week_number === selectedWeek) : null;

  // Unique phases in the plan
  const phases = Array.from(new Set(weeks.map(w => w.phase)));

  return (
    <div className="macro-plan">
      {/* Header */}
      <div className="macro-plan-header">
        <div className="macro-plan-goal">
          <span className="macro-plan-goal-name">{goalName}</span>
          <span className="macro-plan-goal-target">{targetStr}</span>
        </div>
        <div className="macro-plan-meta">
          <span>
            <span className={`macro-plan-phase-current phase-${currentPhase}`}>
              {t(`macroPlan.phase_${currentPhase}`)}
            </span>
            {' '}
            {t('macroPlan.weekOf', { current: currentWeek, total: macroPlan.total_weeks })}
          </span>
          {raceDateStr && (
            <span>{raceDateStr} ({t('macroPlan.weeksLeft', { n: weeksLeft })})</span>
          )}
        </div>
      </div>

      {/* Timeline */}
      <div className="macro-plan-timeline-wrap" ref={timelineRef}>
        {/* Month labels */}
        <div className="macro-plan-months">
          {monthGroups.map((mg, i) => (
            <div
              key={i}
              className="macro-month-label"
              style={{ width: mg.count * 35 }}
            >
              {mg.label}
            </div>
          ))}
        </div>

        {/* Week blocks */}
        <div className="macro-plan-timeline">
          {weeks.map(w => {
            const status = getWeekStatus(w);
            const compClass = status === 'past' ? getComplianceClass(w.compliance_pct) : '';
            const isSelected = selectedWeek === w.week_number;

            return (
              <div
                key={w.week_number}
                className="macro-week"
                ref={status === 'current' ? currentWeekRef : undefined}
                onClick={() => setSelectedWeek(isSelected ? null : w.week_number)}
              >
                <div className={`macro-week-block phase-${w.phase} ${status} ${compClass}`}>
                  <span className="macro-week-num">{w.week_number}</span>
                  <span className="macro-week-km">
                    {status === 'past' && w.compliance_pct != null
                      ? `${w.compliance_pct}%`
                      : `${w.target_volume_km}`
                    }
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Legend */}
        <div className="macro-plan-legend">
          {phases.map(p => (
            <div key={p} className="macro-plan-legend-item">
              <div className={`macro-plan-legend-dot phase-${p}`} />
              <span>{t(`macroPlan.phase_${p}`)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Selected week detail */}
      {selectedWeekData && (
        <div className="macro-week-detail">
          <div className="macro-week-detail-header">
            <span className="macro-week-detail-title">
              {t('macroPlan.weekLabel', { n: selectedWeekData.week_number })}
            </span>
            <span className={`macro-week-detail-phase phase-${selectedWeekData.phase}`}>
              {t(`macroPlan.phase_${selectedWeekData.phase}`)}
            </span>
          </div>

          <div className="macro-week-detail-stats">
            <div className="macro-week-detail-stat">
              <div className="macro-week-detail-stat-value">
                {selectedWeekData.target_volume_km}
              </div>
              <div className="macro-week-detail-stat-label">{t('macroPlan.targetVolume')}, {t('macroPlan.km')}</div>
            </div>

            {selectedWeekData.actual_volume_km != null ? (
              <div className="macro-week-detail-stat">
                <div className={`macro-week-detail-stat-value ${
                  (selectedWeekData.compliance_pct || 0) >= 90 ? 'good' :
                  (selectedWeekData.compliance_pct || 0) >= 70 ? 'warn' : 'bad'
                }`}>
                  {selectedWeekData.actual_volume_km}
                </div>
                <div className="macro-week-detail-stat-label">{t('macroPlan.actualVolume')}, {t('macroPlan.km')}</div>
              </div>
            ) : (
              <div className="macro-week-detail-stat">
                <div className="macro-week-detail-stat-value" style={{ opacity: 0.4 }}>—</div>
                <div className="macro-week-detail-stat-label">{t('macroPlan.actualVolume')}</div>
              </div>
            )}

            <div className="macro-week-detail-stat">
              <div className={`macro-week-detail-stat-value ${
                selectedWeekData.compliance_pct != null
                  ? (selectedWeekData.compliance_pct >= 90 ? 'good' : selectedWeekData.compliance_pct >= 70 ? 'warn' : 'bad')
                  : ''
              }`}>
                {selectedWeekData.compliance_pct != null ? `${selectedWeekData.compliance_pct}%` : '—'}
              </div>
              <div className="macro-week-detail-stat-label">{t('macroPlan.compliance')}</div>
            </div>
          </div>

          {selectedWeekData.key_session_types && selectedWeekData.key_session_types.length > 0 && (
            <div className="macro-week-detail-sessions">
              {selectedWeekData.key_session_types.map((s, i) => (
                <span key={i} className="macro-session-tag">{s}</span>
              ))}
            </div>
          )}

          {selectedWeekData.notes && (
            <div className="macro-week-detail-notes">{selectedWeekData.notes}</div>
          )}
        </div>
      )}
    </div>
  );
};

export default MacroPlanTimeline;
