import React, { useState } from 'react';
import ReactDOM from 'react-dom';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { workouts } from '../../api/api';

interface Goal {
  id: string;
  type: string;
  target_value: number;
  current_value: number;
  deadline: string | null;
}

const LOCALE_MAP: Record<string, string> = { ru: 'ru-RU', uk: 'uk-UA', en: 'en-US' };

interface GoalsSectionProps {
  goals: Goal[];
  setGoals: React.Dispatch<React.SetStateAction<Goal[]>>;
  predictions: any[];
  setPredictions: React.Dispatch<React.SetStateAction<any[]>>;
}

const GoalsSection: React.FC<GoalsSectionProps> = ({ goals, setGoals, predictions, setPredictions }) => {
  const { t } = useTranslation();

  const [newGoalType, setNewGoalType] = useState('monthly_distance');
  const [newGoalTarget, setNewGoalTarget] = useState('');
  const [newGoalUnit, setNewGoalUnit] = useState<'km' | 'm'>('km');
  const [timeHours, setTimeHours] = useState('');
  const [timeMinutes, setTimeMinutes] = useState('');
  const [timeSeconds, setTimeSeconds] = useState('');
  const [newGoalDeadline, setNewGoalDeadline] = useState('');
  const [creatingGoal, setCreatingGoal] = useState(false);
  const [showGoalModal, setShowGoalModal] = useState(false);
  const [editingGoal, setEditingGoal] = useState<Goal | null>(null);
  const [goalModalClosing, setGoalModalClosing] = useState(false);
  const [newGoalId, setNewGoalId] = useState<string | null>(null);
  const [removingGoalId, setRemovingGoalId] = useState<string | null>(null);
  const [breakdownData, setBreakdownData] = useState<any>(null);
  const [breakdownClosing, setBreakdownClosing] = useState(false);

  const GOAL_TYPES = [
    { value: 'monthly_distance', label: t('goalTypes.monthly_distance'), inputType: 'distance' as const },
    { value: 'weekly_distance', label: t('goalTypes.weekly_distance'), inputType: 'distance' as const },
    { value: 'pb_5k', label: t('goalTypes.pb_5k'), inputType: 'time' as const },
    { value: 'pb_10k', label: t('goalTypes.pb_10k'), inputType: 'time' as const },
    { value: 'pb_21k', label: t('goalTypes.pb_21k'), inputType: 'time' as const },
    { value: 'pb_42k', label: t('goalTypes.pb_42k'), inputType: 'time' as const },
    { value: 'monthly_runs', label: t('goalTypes.monthly_runs'), inputType: 'number' as const },
  ];

  const currentGoalConfig = GOAL_TYPES.find(g => g.value === newGoalType);

  const getGoalLabel = (type: string) => {
    return GOAL_TYPES.find(g => g.value === type)?.label || type;
  };

  const formatGoalValue = (type: string, value: number) => {
    const config = GOAL_TYPES.find(g => g.value === type);
    if (config?.inputType === 'time') {
      const h = Math.floor(value / 3600);
      const m = Math.floor((value % 3600) / 60);
      const s = Math.round(value % 60);
      return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}` : `${m}:${s.toString().padStart(2, '0')}`;
    }
    if (config?.inputType === 'distance') {
      return value >= 1000 ? `${(value / 1000).toFixed(1)} ${t('units.km')}` : `${value} ${t('units.m')}`;
    }
    return value.toString();
  };

  const closeGoalModal = () => {
    setGoalModalClosing(true);
    setTimeout(() => {
      setShowGoalModal(false);
      setGoalModalClosing(false);
      setEditingGoal(null);
    }, 1000);
  };

  const handleAddGoal = async () => {
    if (!newGoalType) return;

    let targetValue = 0;
    if (currentGoalConfig?.inputType === 'distance') {
      const num = parseFloat(newGoalTarget);
      if (!num || num <= 0) return;
      targetValue = newGoalUnit === 'km' ? num * 1000 : num;
    } else if (currentGoalConfig?.inputType === 'time') {
      const h = parseInt(timeHours) || 0;
      const m = parseInt(timeMinutes) || 0;
      const s = parseInt(timeSeconds) || 0;
      targetValue = h * 3600 + m * 60 + s;
      if (targetValue <= 0) return;
    } else {
      targetValue = parseFloat(newGoalTarget);
      if (!targetValue || targetValue <= 0) return;
    }

    setCreatingGoal(true);
    try {
      let savedGoal: Goal;
      if (editingGoal) {
        savedGoal = await workouts.updateGoal(editingGoal.id, targetValue, newGoalDeadline || undefined);
      } else {
        savedGoal = await workouts.createGoal(newGoalType, targetValue, newGoalDeadline || undefined);
      }
      setNewGoalTarget('');
      setTimeHours('');
      setTimeMinutes('');
      setTimeSeconds('');
      setNewGoalDeadline('');
      setEditingGoal(null);
      setGoalModalClosing(true);
      setTimeout(() => {
        setShowGoalModal(false);
        setGoalModalClosing(false);
      }, 1000);
      if (editingGoal) {
        setGoals(prev => prev.map(g => g.id === savedGoal.id ? savedGoal : g));
      } else {
        setGoals(prev => [savedGoal, ...prev]);
      }
      setNewGoalId(savedGoal.id);
      setTimeout(() => setNewGoalId(null), 800);
      workouts.goalPredictions().then(setPredictions).catch(() => {});
    } catch (err) {
      console.error('Failed to save goal:', err);
    } finally {
      setCreatingGoal(false);
    }
  };

  const handleDeleteGoal = async (goalId: string) => {
    if (!window.confirm(t('profile.deleteGoalConfirm'))) return;
    try {
      await workouts.deleteGoal(goalId);
      setRemovingGoalId(goalId);
      setTimeout(() => {
        setGoals(prev => prev.filter(g => g.id !== goalId));
        setPredictions(prev => prev.filter((p: any) => p.goalId !== goalId));
        setRemovingGoalId(null);
      }, 450);
    } catch (err) {
      console.error('Failed to delete goal:', err);
    }
  };

  const openEditGoal = (goal: Goal) => {
    const config = GOAL_TYPES.find(g => g.value === goal.type);
    setNewGoalType(goal.type);
    if (config?.inputType === 'distance') {
      const km = goal.target_value / 1000;
      setNewGoalTarget(km.toString());
      setNewGoalUnit('km');
    } else if (config?.inputType === 'time') {
      const h = Math.floor(goal.target_value / 3600);
      const m = Math.floor((goal.target_value % 3600) / 60);
      const s = Math.round(goal.target_value % 60);
      setTimeHours(h > 0 ? h.toString() : '');
      setTimeMinutes(m > 0 ? m.toString() : '');
      setTimeSeconds(s > 0 ? s.toString() : '');
    } else {
      setNewGoalTarget(goal.target_value.toString());
    }
    setNewGoalDeadline(goal.deadline || '');
    setEditingGoal(goal);
    setShowGoalModal(true);
  };

  return (
    <>
      <div className="profile-section">
        <h3 className="section-title">🎯 {t('profile.goals')}</h3>

        {goals.length > 0 ? (
          <div className="goals-list">
            {goals.map(goal => {
              const pred = predictions.find((p: any) => p.goalId === goal.id);
              const currentValue = pred?.computedCurrentValue ?? goal.current_value;
              return (
              <div key={goal.id} className={`goal-item${removingGoalId === goal.id ? ' goal-removing' : ''}${newGoalId === goal.id ? ' goal-new' : ''}`}>
                <div className="goal-header">
                  <span className="goal-type">{getGoalLabel(goal.type)}</span>
                  <div className="goal-actions">
                    <button className="goal-edit-btn" onClick={() => openEditGoal(goal)} title={t('profile.editGoal')}>✏️</button>
                    <button className="goal-delete-btn" onClick={() => handleDeleteGoal(goal.id)} title={t('common.delete')}>✕</button>
                  </div>
                </div>

                {pred?.breakdown ? (
                  <>
                    <div className="pb-card">
                      <div className="pb-times">
                        <div className="pb-current">
                          <span className="pb-current-time">{formatGoalValue(goal.type, currentValue)}</span>
                          <span className="pb-label">{t('profile.forecast')}</span>
                        </div>
                        <span className="pb-arrow">→</span>
                        <div className="pb-target">
                          <span className="pb-target-time">{formatGoalValue(goal.type, goal.target_value)}</span>
                          <span className="pb-label">{t('profile.target')}</span>
                        </div>
                      </div>
                      <div className="pb-status-row">
                        <button className="pb-info-btn" onClick={() => setBreakdownData(pred.breakdown)} title={t('profile.details')}>{t('profile.details')}</button>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="goal-values">
                      <span>{formatGoalValue(goal.type, currentValue)}</span>
                      <span> / </span>
                      <span>{formatGoalValue(goal.type, goal.target_value)}</span>
                    </div>
                    {(() => {
                      if (!pred || !pred.message) return null;
                      return (
                        <div className={`goal-prediction ${pred.onTrack ? 'prediction-good' : 'prediction-warn'}`}>
                          <span className="prediction-icon">{pred.onTrack ? '🟢' : '🟡'}</span>
                          <span className="prediction-text">{pred.message}</span>
                        </div>
                      );
                    })()}
                    {goal.deadline && (
                      <div className="goal-deadline">
                        {(() => {
                          const daysLeft = Math.ceil((new Date(goal.deadline).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
                          if (daysLeft < 0) return <span className="deadline-passed">{t('profile.deadlinePassed')}</span>;
                          if (daysLeft <= 7) return <span className="deadline-soon">{t('profile.deadlineSoon', { days: daysLeft })}</span>;
                          return <span className="deadline-ok">{t('profile.deadlineOk', { date: new Date(goal.deadline).toLocaleDateString(LOCALE_MAP[i18n.language] || 'ru-RU'), days: daysLeft })}</span>;
                        })()}
                      </div>
                    )}
                    <div className="goal-progress">
                      <div className="progress-bar">
                        <div
                          className="progress-fill"
                          style={{
                            width: `${pred?.percent != null
                              ? Math.min(pred.percent, 100)
                              : Math.min((currentValue / goal.target_value) * 100, 100)}%`
                          }}
                        ></div>
                      </div>
                    </div>
                  </>
                )}
              </div>
              );
            })}
          </div>
        ) : (
          <p className="empty-text">{t('profile.noGoals')}</p>
        )}

        <button className="btn btn-outline btn-full" onClick={() => setShowGoalModal(true)}>
          ➕ {t('profile.addGoal')}
        </button>
      </div>

      {showGoalModal && ReactDOM.createPortal(
        <div className={`modal-overlay${goalModalClosing ? ' modal-closing' : ''}`} onClick={closeGoalModal}>
          <div className={`modal-content${goalModalClosing ? ' modal-content-closing' : ''}`} onClick={e => e.stopPropagation()}>
            <h3 className="modal-title">{editingGoal ? t('profile.editGoal') : t('profile.addGoal')}</h3>

            <div className="modal-field">
              <label className="param-label">{t('modals.goalType')}</label>
              <select className="input-field" value={newGoalType} onChange={e => setNewGoalType(e.target.value)} disabled={!!editingGoal} style={editingGoal ? { opacity: 0.6 } : undefined}>
                {GOAL_TYPES.map(gt => (<option key={gt.value} value={gt.value}>{gt.label}</option>))}
              </select>
            </div>

            {currentGoalConfig?.inputType === 'distance' && (
              <div className="modal-field">
                <label className="param-label">{t('modals.value')}</label>
                <div className="distance-input-row">
                  <input type="number" className="input-field" placeholder={t('modals.value')} value={newGoalTarget} onChange={e => setNewGoalTarget(e.target.value)} />
                  <select className="input-field unit-select" value={newGoalUnit} onChange={e => setNewGoalUnit(e.target.value as 'km' | 'm')}>
                    <option value="km">{t('units.km')}</option>
                    <option value="m">{t('units.m')}</option>
                  </select>
                </div>
              </div>
            )}

            {currentGoalConfig?.inputType === 'time' && (
              <div className="modal-field">
                <label className="param-label">{t('modals.timePlaceholder')}</label>
                <div className="time-input-row">
                  <input type="number" className="input-field time-input" placeholder={t('units.h')} min="0" max="23" value={timeHours} onChange={e => setTimeHours(e.target.value)} />
                  <span className="time-separator">:</span>
                  <input type="number" className="input-field time-input" placeholder={t('units.min')} min="0" max="59" value={timeMinutes} onChange={e => setTimeMinutes(e.target.value)} />
                  <span className="time-separator">:</span>
                  <input type="number" className="input-field time-input" placeholder={t('units.sec')} min="0" max="59" value={timeSeconds} onChange={e => setTimeSeconds(e.target.value)} />
                </div>
              </div>
            )}

            {currentGoalConfig?.inputType === 'number' && (
              <div className="modal-field">
                <label className="param-label">{t('modals.quantity')}</label>
                <input type="number" className="input-field" placeholder={t('modals.quantity')} value={newGoalTarget} onChange={e => setNewGoalTarget(e.target.value)} />
              </div>
            )}

            <div className={`deadline-field${['monthly_distance', 'weekly_distance', 'monthly_runs'].includes(newGoalType) ? ' deadline-hidden' : ''}`}>
              <div className="modal-field">
                <label className="param-label">{t('modals.deadlineOptional')}</label>
                <input type="date" className="input-field" value={newGoalDeadline} onChange={e => setNewGoalDeadline(e.target.value)} min={new Date().toISOString().split('T')[0]} />
              </div>
            </div>

            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={closeGoalModal}>{t('common.cancel')}</button>
              <button className="btn btn-accent" onClick={handleAddGoal} disabled={creatingGoal}>
                {creatingGoal ? `⏳ ${t('common.saving')}` : `💾 ${t('common.save')}`}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {breakdownData && ReactDOM.createPortal(
        <div
          className={`modal-overlay${breakdownClosing ? ' modal-closing' : ''}`}
          onClick={() => { setBreakdownClosing(true); setTimeout(() => { setBreakdownData(null); setBreakdownClosing(false); }, 300); }}
        >
          <div className={`modal-content breakdown-modal${breakdownClosing ? ' modal-content-closing' : ''}`} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{t('profile.breakdownTitle')}</h3>
              <button className="btn-icon" onClick={() => { setBreakdownClosing(true); setTimeout(() => { setBreakdownData(null); setBreakdownClosing(false); }, 300); }}>✕</button>
            </div>

            {breakdownData.chosen && (
              <div className="breakdown-result">
                <div className="breakdown-result-label">{t('profile.breakdownResult')}</div>
                <div className="breakdown-result-source">{breakdownData.chosen.source}</div>
                <div className="breakdown-result-reason">{breakdownData.chosen.reason}</div>
              </div>
            )}

            {breakdownData.bestEffort && (
              <div className="breakdown-section">
                <div className="breakdown-section-title">{t('profile.breakdownStravaSplit', { dist: breakdownData.targetDist })}</div>
                <div className="breakdown-row">
                  <span>{breakdownData.bestEffort.date}</span>
                  <span className="breakdown-time">{breakdownData.bestEffort.time}</span>
                </div>
              </div>
            )}

            {breakdownData.discardedBE && (
              <div className="breakdown-section breakdown-discarded">
                <div className="breakdown-section-title">{t('profile.breakdownDiscarded')}</div>
                <div className="breakdown-row">
                  <span>{breakdownData.discardedBE.date} — {breakdownData.discardedBE.time}</span>
                </div>
                <div className="breakdown-reason">{breakdownData.discardedBE.reason}</div>
              </div>
            )}

            {breakdownData.riegelWorkouts && breakdownData.riegelWorkouts.length > 0 && (
              <div className="breakdown-section">
                <div className="breakdown-section-title">{t('profile.breakdownRiegel', { period: breakdownData.period })}</div>
                <div className="breakdown-table">
                  <div className="breakdown-table-header">
                    <span>{t('modals.dateOptional').split(' ')[0]}</span>
                    <span>{t('modals.distanceLabel')}</span>
                    <span>{t('modals.timePlaceholder')}</span>
                    <span>→ {breakdownData.targetDist} {t('units.km')}</span>
                  </div>
                  {breakdownData.riegelWorkouts.map((r: any, i: number) => (
                    <div key={i} className={`breakdown-table-row${i < 3 ? ' breakdown-top3' : ''}`}>
                      <span>{r.date}</span>
                      <span>{r.dist}</span>
                      <span>{r.actualTime}</span>
                      <span className="breakdown-time">{r.riegelTime}</span>
                    </div>
                  ))}
                </div>
                <div className="breakdown-note">{t('profile.breakdownTop3')}</div>
              </div>
            )}

            {!breakdownData.riegelWorkouts?.length && !breakdownData.bestEffort && (
              <div className="breakdown-section"><p>{t('profile.breakdownNoData')}</p></div>
            )}
          </div>
        </div>,
        document.body
      )}
    </>
  );
};

export default GoalsSection;
