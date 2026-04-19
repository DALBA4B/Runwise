import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import './MacroPlanView.css';

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

interface MacroPlanViewProps {
  macroPlan: MacroPlan;
  onBack: () => void;
}

interface PhaseGroup {
  phase: string;
  weeks: MacroPlanWeek[];
  totalKm: number;
  avgKm: number;
}

const LOCALE_MAP: Record<string, string> = { ru: 'ru-RU', uk: 'uk-UA', en: 'en-US' };

const GOAL_NAMES: Record<string, Record<string, string>> = {
  ru: { pb_5k: '5 км', pb_10k: '10 км', pb_21k: 'Полумарафон', pb_42k: 'Марафон', monthly_distance: 'Месячный объём', weekly_distance: 'Недельный объём' },
  uk: { pb_5k: '5 km', pb_10k: '10 km', pb_21k: 'Півмарафон', pb_42k: 'Марафон', monthly_distance: "Місячний об'єм", weekly_distance: "Тижневий об'єм" },
  en: { pb_5k: '5K', pb_10k: '10K', pb_21k: 'Half Marathon', pb_42k: 'Marathon', monthly_distance: 'Monthly volume', weekly_distance: 'Weekly volume' }
};

const PHASE_LABELS: Record<string, Record<string, string>> = {
  ru: { base: 'Базовый блок', build: 'Развитие', peak: 'Пик', taper: 'Подводка', race: 'Старт' },
  uk: { base: 'Базовий блок', build: 'Розвиток', peak: 'Пік', taper: 'Підведення', race: 'Старт' },
  en: { base: 'Base', build: 'Build', peak: 'Peak', taper: 'Taper', race: 'Race' }
};

const MONTH_SHORT: Record<string, string[]> = {
  ru: ['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'],
  uk: ['Січ','Лют','Бер','Кві','Тра','Чер','Лип','Сер','Вер','Жов','Лис','Гру'],
  en: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
};

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  return h > 0
    ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
    : `${m}:${s.toString().padStart(2, '0')}`;
}

const MacroPlanView: React.FC<MacroPlanViewProps> = ({ macroPlan, onBack }) => {
  const { t } = useTranslation();
  const lang = i18n.language || 'ru';
  const weeks = macroPlan.weeks;
  const currentWeek = macroPlan.current_week;

  // Goal info
  const goalNames = GOAL_NAMES[lang] || GOAL_NAMES.ru;
  const goalName = goalNames[macroPlan.goal_type] || macroPlan.goal_type;
  const isPB = ['pb_5k', 'pb_10k', 'pb_21k', 'pb_42k'].includes(macroPlan.goal_type);
  const targetStr = isPB ? formatTime(macroPlan.goal_target_value) : `${(macroPlan.goal_target_value / 1000).toFixed(0)} ${t('macroPlan.km')}`;

  // Date range
  const firstDate = weeks.length > 0 ? new Date(weeks[0].start_date) : null;
  const lastDate = weeks.length > 0 ? new Date(weeks[weeks.length - 1].start_date) : null;
  const monthShort = MONTH_SHORT[lang] || MONTH_SHORT.ru;
  const dateRange = firstDate && lastDate
    ? `${monthShort[firstDate.getMonth()]} – ${monthShort[lastDate.getMonth()]} ${lastDate.getFullYear()}`
    : '';

  // Weeks left
  const weeksLeft = macroPlan.total_weeks - currentWeek;

  // Current phase
  const currentWeekData = weeks.find(w => w.week_number === currentWeek);
  const currentPhase = currentWeekData?.phase || 'base';

  // Unique phases for legend
  const phases = Array.from(new Set(weeks.map(w => w.phase)));

  // Group weeks by phase (consecutive groups — same phase stays together)
  const phaseGroups: PhaseGroup[] = useMemo(() => {
    const groups: PhaseGroup[] = [];
    let current: PhaseGroup | null = null;

    weeks.forEach(w => {
      if (!current || current.phase !== w.phase) {
        if (current) groups.push(current);
        current = { phase: w.phase, weeks: [w], totalKm: w.target_volume_km, avgKm: 0 };
      } else {
        current.weeks.push(w);
        current.totalKm += w.target_volume_km;
      }
    });
    if (current) groups.push(current);

    groups.forEach(g => {
      g.avgKm = Math.round(g.totalKm / g.weeks.length);
    });

    return groups;
  }, [weeks]);

  // Find which phase group the current week belongs to
  const currentPhaseIdx = useMemo(() => {
    return phaseGroups.findIndex(g => g.weeks.some(w => w.week_number === currentWeek));
  }, [phaseGroups, currentWeek]);

  const [activePhaseIdx, setActivePhaseIdx] = useState(Math.max(0, currentPhaseIdx));

  const canPrev = activePhaseIdx > 0;
  const canNext = activePhaseIdx < phaseGroups.length - 1;

  const go = (dir: number) => {
    const newIdx = activePhaseIdx + dir;
    if (newIdx >= 0 && newIdx < phaseGroups.length) {
      setActivePhaseIdx(newIdx);
    }
  };

  const activeGroup = phaseGroups[activePhaseIdx];
  const phaseLabels = PHASE_LABELS[lang] || PHASE_LABELS.ru;

  if (!activeGroup) return null;

  // Phase stats
  const phaseTotalKm = activeGroup.totalKm;
  const phaseAvgKm = activeGroup.avgKm;
  const phaseWeeksCount = activeGroup.weeks.length;
  const phaseTrainDays = activeGroup.weeks.reduce((s, w) => s + (w.key_sessions_count || 0), 0);

  // Cumulative km within phase
  const cumulativeKm = (weekNum: number): number => {
    return activeGroup.weeks
      .filter(w => w.week_number <= weekNum)
      .reduce((s, w) => s + w.target_volume_km, 0);
  };

  // Track opened workout sections
  const [openWorkouts, setOpenWorkouts] = useState<Set<number>>(new Set());
  const toggleWorkouts = (weekNum: number) => {
    setOpenWorkouts(prev => {
      const next = new Set(prev);
      if (next.has(weekNum)) next.delete(weekNum);
      else next.add(weekNum);
      return next;
    });
  };

  // Format date range for a week
  const formatWeekDate = (w: MacroPlanWeek): string => {
    const start = new Date(w.start_date);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const dStart = start.getDate();
    const dEnd = end.getDate();
    const mStart = monthShort[start.getMonth()];
    const mEnd = monthShort[end.getMonth()];
    if (start.getMonth() === end.getMonth()) {
      return `${dStart} – ${dEnd} ${mStart}`;
    }
    return `${dStart} ${mStart} – ${dEnd} ${mEnd}`;
  };

  // Determine week status
  const getWeekStatus = (w: MacroPlanWeek): 'past' | 'now' | 'next' | 'future' => {
    if (w.week_number < currentWeek) return 'past';
    if (w.week_number === currentWeek) return 'now';
    if (w.week_number === currentWeek + 1) return 'next';
    return 'future';
  };

  // Check if week has workout details
  const hasWorkoutDetails = (w: MacroPlanWeek): boolean => {
    return w.key_session_types && w.key_session_types.length > 0;
  };

  // Detect month boundaries within this phase for month labels
  const getMonthLabel = (w: MacroPlanWeek, prevWeek: MacroPlanWeek | null): string | null => {
    const wMonth = new Date(w.start_date).getMonth();
    const prevMonth = prevWeek ? new Date(prevWeek.start_date).getMonth() : -1;
    if (wMonth !== prevMonth) {
      const wYear = new Date(w.start_date).getFullYear();
      return `${monthShort[wMonth]} ${wYear}`;
    }
    return null;
  };

  // Phase date range string
  const phaseFirstDate = new Date(activeGroup.weeks[0].start_date);
  const phaseLastDate = new Date(activeGroup.weeks[activeGroup.weeks.length - 1].start_date);
  const phaseDateStr = `${monthShort[phaseFirstDate.getMonth()]} – ${monthShort[phaseLastDate.getMonth()]}`;

  return (
    <div className="mpv">
      {/* Top bar */}
      <div className="mpv-top">
        <div className="mpv-top-title">{t('macroPlan.title')}</div>
        <button className="mpv-top-back" onClick={onBack}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          {t('macroPlanView.backToWeek')}
        </button>
      </div>

      {/* Goal card */}
      <div className="mpv-goal">
        <div className="mpv-goal-row1">
          <div>
            <div className="mpv-goal-name">{goalName}</div>
            <div className="mpv-goal-meta">{dateRange}</div>
          </div>
          <div>
            <div className="mpv-goal-time">{targetStr}</div>
            <div className="mpv-goal-until">{t('macroPlan.weeksLeft', { n: weeksLeft })}</div>
          </div>
        </div>
        <div className="mpv-goal-row2">
          <div className={`mpv-phase-tag phase-${currentPhase}`}>
            {t(`macroPlan.phase_${currentPhase}`)}
          </div>
          <div className="mpv-goal-wn">
            {t('macroPlan.weekOf', { current: currentWeek, total: macroPlan.total_weeks })}
          </div>
        </div>

        {/* Phase track */}
        <div className="mpv-track">
          {weeks.map(w => {
            const status = w.week_number < currentWeek ? 'is-done'
              : w.week_number === currentWeek ? 'is-now'
              : 'is-future';
            return (
              <div key={w.week_number} className={`mpv-seg phase-${w.phase} ${status}`} />
            );
          })}
        </div>
        <div className="mpv-track-ends">
          <span>{firstDate ? `${monthShort[firstDate.getMonth()]} ${firstDate.getFullYear()}` : ''}</span>
          <span>{lastDate ? `${monthShort[lastDate.getMonth()]} ${lastDate.getFullYear()}` : ''}</span>
        </div>
        <div className="mpv-track-legend">
          {phases.map(p => (
            <div key={p} className="mpv-legend-item">
              <div className={`mpv-legend-dot phase-${p}`} />
              {t(`macroPlan.phase_${p}`)}
            </div>
          ))}
        </div>
      </div>

      {/* Phase stats (replaces month stats) */}
      <div className="mpv-mstats">
        <div className="mpv-ms-item">
          <div className="mpv-ms-val">{phaseTotalKm}<span className="mpv-ms-unit">{t('macroPlan.km')}</span></div>
          <div className="mpv-ms-lbl">{t('macroPlanView.phaseTotal')}</div>
        </div>
        <div className="mpv-ms-item">
          <div className="mpv-ms-val">~{phaseAvgKm}<span className="mpv-ms-unit">{t('macroPlan.km')}</span></div>
          <div className="mpv-ms-lbl">{t('macroPlanView.perWeekAvg')}</div>
        </div>
        <div className="mpv-ms-item">
          <div className="mpv-ms-val">{phaseWeeksCount}<span className="mpv-ms-unit"> {t('macroPlanView.weeksUnit')}</span></div>
          <div className="mpv-ms-lbl">{phaseDateStr}</div>
        </div>
      </div>

      {/* Phase nav (replaces month nav) */}
      <div className="mpv-mnav">
        <button className="mpv-mnav-btn" disabled={!canPrev} onClick={() => go(-1)}>&#8249;</button>
        <div className="mpv-mnav-title">
          <span className={`mpv-mnav-phase-dot phase-${activeGroup.phase}`} />
          {phaseLabels[activeGroup.phase] || activeGroup.phase}
        </div>
        <button className="mpv-mnav-btn" disabled={!canNext} onClick={() => go(1)}>&#8250;</button>
      </div>

      {/* Week cards */}
      <div className="mpv-weeks">
        {activeGroup.weeks.map((w, i) => {
          const status = getWeekStatus(w);
          const cumKm = cumulativeKm(w.week_number);
          const cumPct = phaseTotalKm > 0 ? Math.round(cumKm / phaseTotalKm * 100) : 0;
          const volPct = phaseTotalKm > 0 ? Math.round(w.target_volume_km / phaseTotalKm * 100) : 0;

          const prevWeek = i > 0 ? activeGroup.weeks[i - 1] : null;
          const monthLabel = getMonthLabel(w, prevWeek);

          const isOpen = openWorkouts.has(w.week_number);
          const showWo = (status === 'now' || status === 'next') && hasWorkoutDetails(w);

          return (
            <React.Fragment key={w.week_number}>
              {/* Month label when month changes */}
              {monthLabel && (
                <div className="mpv-month-label">
                  <div className="mpv-month-label-line" />
                  <span className="mpv-month-label-text">{monthLabel}</span>
                  <div className="mpv-month-label-line" />
                </div>
              )}

              <div
                className={`mpv-wk${status === 'past' ? ' is-past' : ''}${status === 'now' ? ' is-now' : ''}${status === 'next' ? ' is-next' : ''}`}
                style={{ animationDelay: `${i * 0.045}s` }}
              >
                <div className="mpv-wk-strip" />
                <div className="mpv-wk-nbg">{w.week_number}</div>
                <div className="mpv-wk-body">
                  <div className="mpv-wk-head">
                    <div>
                      <div className="mpv-wk-id">
                        {t('macroPlanView.weekN', { n: w.week_number })}
                        {status === 'now' && (
                          <span className="mpv-badge-now">
                            <span className="mpv-badge-pulse" />
                            {t('macroPlanView.now')}
                          </span>
                        )}
                        {status === 'next' && (
                          <span className="mpv-badge-next">{t('macroPlanView.next')}</span>
                        )}
                      </div>
                      <div className="mpv-wk-date">{formatWeekDate(w)}</div>
                    </div>
                    <div className="mpv-wk-km">
                      <div className="mpv-wk-km-val">
                        {w.target_volume_km}<span className="mpv-wk-km-unit"> {t('macroPlan.km')}</span>
                      </div>
                      <div className="mpv-wk-month-pct">{volPct}% {t('macroPlanView.ofPhase')}</div>
                    </div>
                  </div>

                  <div className="mpv-month-bar-wrap">
                    <div className="mpv-month-bar-track">
                      <div className="mpv-month-bar-fill" style={{ width: `${cumPct}%` }} />
                    </div>
                    <div className="mpv-month-bar-label">
                      {cumKm} {t('macroPlanView.outOf')} {phaseTotalKm} {t('macroPlan.km')}
                    </div>
                  </div>

                  {w.notes && (
                    <div className="mpv-wk-comment">{w.notes}</div>
                  )}

                  {showWo && (
                    <>
                      <button
                        className={`mpv-wo-toggle${isOpen ? ' open' : ''}`}
                        onClick={() => toggleWorkouts(w.week_number)}
                      >
                        {t('macroPlanView.weekWorkouts')}
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M6 9l6 6 6-6" />
                        </svg>
                      </button>
                      <div className={`mpv-wo-wrap${isOpen ? ' open' : ''}`}>
                        <div className="mpv-wo-list">
                          {w.key_session_types.map((session, si) => (
                            <div key={si} className="mpv-wo-row">
                              <div className="mpv-wo-day">{si + 1}</div>
                              <div className="mpv-wo-info">
                                <div className="mpv-wo-name">{session}</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};

export default MacroPlanView;
