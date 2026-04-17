import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import './Plan.css';
import PlanRow from '../components/PlanRow';
import MacroPlanTimeline from '../components/MacroPlanTimeline';
import { ai } from '../api/api';
import i18n from '../i18n';

const LOCALE_MAP: Record<string, string> = { ru: 'ru-RU', uk: 'uk-UA', en: 'en-US' };

interface PlanDay {
  day: string;
  type: string;
  distance_km: number;
  description: string;
  badge: string;
}

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

function readCache<T>(key: string): T | null {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function writeCache(key: string, data: any) {
  try { localStorage.setItem(key, JSON.stringify(data)); } catch {}
}

interface PlanProps {
  isActive?: boolean;
}

const Plan: React.FC<PlanProps> = ({ isActive }) => {
  const { t } = useTranslation();
  const cached = readCache<{ plan: PlanDay[]; weekStart: string }>('rw_plan_cache');
  const [plan, setPlan] = useState<PlanDay[] | null>(cached?.plan || null);
  const [weekStart, setWeekStart] = useState<string>(cached?.weekStart || '');
  const [loading, setLoading] = useState(!cached);
  const [generating, setGenerating] = useState(false);

  const macroCached = readCache<any>('rw_macro_plan_cache');
  const [macroPlan, setMacroPlan] = useState<any>(macroCached || null);

  const mountedRef = useRef(true);

  const fetchMacroPlan = async () => {
    try {
      const data = await ai.getMacroPlan();
      if (data.macroPlan) {
        setMacroPlan(data.macroPlan);
        writeCache('rw_macro_plan_cache', data.macroPlan);
      } else {
        setMacroPlan(null);
        localStorage.removeItem('rw_macro_plan_cache');
      }
    } catch (err) {
      console.error('Failed to fetch macro plan:', err);
    }
  };

  useEffect(() => {
    fetchPlan();
    fetchMacroPlan();
  }, []);

  useEffect(() => {
    if (!mountedRef.current && isActive) {
      fetchPlan();
      fetchMacroPlan();
    }
    mountedRef.current = false;
  }, [isActive]);

  const fetchPlan = async () => {
    try {
      const data = await ai.getPlan();
      if (data.plan) {
        const workouts = typeof data.plan.workouts === 'string'
          ? JSON.parse(data.plan.workouts)
          : data.plan.workouts;
        setPlan(workouts);
        setWeekStart(data.plan.week_start);
        writeCache('rw_plan_cache', { plan: workouts, weekStart: data.plan.week_start });
      }
    } catch (err) {
      console.error('Failed to fetch plan:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const data = await ai.generatePlan();
      if (data.plan) {
        const workouts = typeof data.plan.workouts === 'string'
          ? JSON.parse(data.plan.workouts)
          : data.plan.workouts;
        setPlan(workouts);
        setWeekStart(data.plan.week_start);
        writeCache('rw_plan_cache', { plan: workouts, weekStart: data.plan.week_start });
      }
    } catch (err) {
      console.error('Failed to generate plan:', err);
    } finally {
      setGenerating(false);
    }
  };

  const todayIndex = new Date().getDay();
  // Convert JS day (0=Sun) to our index (0=Mon)
  const todayPlanIndex = todayIndex === 0 ? 6 : todayIndex - 1;

  // Slavic plural: 1 → one, 2-4 → few, 0/5+ → many
  const plural = (n: number, key: string) => {
    if (n === 1) return t(`plan.${key}_one`);
    if (n >= 2 && n <= 4) return t(`plan.${key}_few`);
    return t(`plan.${key}_many`);
  };

  const totalPlannedKm = plan
    ? plan.reduce((sum, d) => sum + (d.distance_km || 0), 0)
    : 0;

  const trainingDays = plan
    ? plan.filter(d => d.type !== 'rest').length
    : 0;

  return (
    <div className="screen plan-screen">
      <h2 className="screen-title">📋 {t('plan.title')}</h2>

      {macroPlan && <MacroPlanTimeline macroPlan={macroPlan} />}

      {plan ? (
        <>
          <div className="plan-summary">
            <div className="plan-summary-item">
              <span className="plan-summary-value">{totalPlannedKm.toFixed(1)}</span>
              <span className="plan-summary-label">{t('plan.kmPerWeek')}</span>
            </div>
            <div className="plan-summary-item">
              <span className="plan-summary-value">{trainingDays}</span>
              <span className="plan-summary-label">{plural(trainingDays, 'workouts')}</span>
            </div>
            <div className="plan-summary-item">
              <span className="plan-summary-value">{7 - trainingDays}</span>
              <span className="plan-summary-label">{plural(7 - trainingDays, 'restDays')}</span>
            </div>
          </div>

          <div className="plan-list">
            {plan.map((day, index) => (
              <PlanRow
                key={index}
                plan={day}
                isToday={index === todayPlanIndex}
                dayLabel={t(`days.${DAY_KEYS[index]}`)}
              />
            ))}
          </div>

        </>
      ) : (
        <div className="plan-empty">
          <p className="empty-text">{t('plan.empty')}</p>
          <p className="empty-sub">{t('plan.emptySub')}</p>
          <button
            className="btn btn-accent btn-full"
            onClick={handleGenerate}
            disabled={generating}
          >
            {generating ? `🔄 ${t('plan.generating')}` : `✨ ${t('plan.generate')}`}
          </button>
        </div>
      )}
    </div>
  );
};

export default Plan;
