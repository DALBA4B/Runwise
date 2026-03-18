import React, { useState, useEffect } from 'react';
import MetricCard from '../components/MetricCard';
import { workouts, strava, profile as profileApi } from '../api/api';
import { useAuth } from '../hooks/useAuth';
import { formatPace, formatDistance } from '../utils';

interface Goal {
  id: string;
  type: string;
  target_value: number;
  current_value: number;
  deadline: string | null;
}

const Profile: React.FC = () => {
  const { logout } = useAuth();
  const [allTimeStats, setAllTimeStats] = useState<any>(null);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncStatus, setSyncStatus] = useState<any>(null);
  const [predictions, setPredictions] = useState<any[]>([]);
  const [newGoalType, setNewGoalType] = useState('monthly_distance');
  const [newGoalTarget, setNewGoalTarget] = useState('');
  const [newGoalUnit, setNewGoalUnit] = useState<'km' | 'm'>('km');
  const [timeHours, setTimeHours] = useState('');
  const [timeMinutes, setTimeMinutes] = useState('');
  const [timeSeconds, setTimeSeconds] = useState('');
  const [newGoalDeadline, setNewGoalDeadline] = useState('');
  const [creatingGoal, setCreatingGoal] = useState(false);
  const [age, setAge] = useState('');
  const [height, setHeight] = useState('');
  const [weight, setWeight] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);

  const GOAL_TYPES = [
    { value: 'monthly_distance', label: 'Месячный объём', inputType: 'distance' as const },
    { value: 'weekly_distance', label: 'Недельный объём', inputType: 'distance' as const },
    { value: 'pb_5k', label: 'Личный рекорд 5 км', inputType: 'time' as const },
    { value: 'pb_10k', label: 'Личный рекорд 10 км', inputType: 'time' as const },
    { value: 'pb_21k', label: 'Личный рекорд полумарафон', inputType: 'time' as const },
    { value: 'pb_42k', label: 'Личный рекорд марафон', inputType: 'time' as const },
    { value: 'monthly_runs', label: 'Кол-во пробежек за месяц', inputType: 'number' as const },
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
      return value >= 1000 ? `${(value / 1000).toFixed(1)} км` : `${value} м`;
    }
    return value.toString();
  };

  useEffect(() => {
    loadProfileData();
  }, []);

  const loadProfileData = async () => {
    setLoading(true);
    try {
      const [statsData, goalsData, syncData, predsData, profileData] = await Promise.allSettled([
        workouts.stats('all'),
        workouts.getGoals(),
        strava.syncStatus(),
        workouts.goalPredictions(),
        profileApi.get()
      ]);

      if (statsData.status === 'fulfilled') {
        setAllTimeStats(statsData.value);
      }
      if (goalsData.status === 'fulfilled') {
        setGoals(goalsData.value);
      }
      if (syncData.status === 'fulfilled') {
        setSyncStatus(syncData.value);
      }
      if (predsData.status === 'fulfilled') {
        setPredictions(predsData.value);
      }
      if (profileData.status === 'fulfilled' && profileData.value) {
        if (profileData.value.age) setAge(profileData.value.age.toString());
        if (profileData.value.height_cm) setHeight(profileData.value.height_cm.toString());
        if (profileData.value.weight_kg) setWeight(profileData.value.weight_kg.toString());
      }
    } catch (err) {
      console.error('Failed to load profile:', err);
    } finally {
      setLoading(false);
    }
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
      await workouts.createGoal(newGoalType, targetValue, newGoalDeadline || undefined);
      setNewGoalTarget('');
      setTimeHours('');
      setTimeMinutes('');
      setTimeSeconds('');
      setNewGoalDeadline('');
      await loadProfileData();
    } catch (err) {
      console.error('Failed to create goal:', err);
    } finally {
      setCreatingGoal(false);
    }
  };

  const handleDeleteGoal = async (goalId: string) => {
    if (!window.confirm('Удалить эту цель?')) return;
    try {
      await workouts.deleteGoal(goalId);
      await loadProfileData();
    } catch (err) {
      console.error('Failed to delete goal:', err);
    }
  };

  const handleSaveProfile = async () => {
    setSavingProfile(true);
    try {
      await profileApi.update({
        age: age ? parseInt(age) : null,
        height_cm: height ? parseFloat(height) : null,
        weight_kg: weight ? parseFloat(weight) : null
      });
    } catch (err) {
      console.error('Failed to save profile:', err);
    } finally {
      setSavingProfile(false);
    }
  };

  const handleLogout = () => {
    if (window.confirm('Ты уверен? Это разлогинит тебя.')) {
      logout();
    }
  };

  if (loading) {
    return (
      <div className="screen-loading">
        <div className="loader"></div>
        <p>Загрузка профиля...</p>
      </div>
    );
  }

  return (
    <div className="screen profile-screen">
      <h2 className="screen-title">👤 Профиль</h2>

      <div className="profile-section">
        <h3 className="section-title">📏 Физические параметры</h3>
        <div className="physical-params-form">
          <div className="param-row">
            <label className="param-label">Возраст</label>
            <div className="param-input-wrap">
              <input
                type="number"
                className="input-field"
                placeholder="25"
                value={age}
                onChange={e => setAge(e.target.value)}
                min="10"
                max="99"
              />
              <span className="param-unit">лет</span>
            </div>
          </div>
          <div className="param-row">
            <label className="param-label">Рост</label>
            <div className="param-input-wrap">
              <input
                type="number"
                className="input-field"
                placeholder="175"
                value={height}
                onChange={e => setHeight(e.target.value)}
                min="100"
                max="250"
              />
              <span className="param-unit">см</span>
            </div>
          </div>
          <div className="param-row">
            <label className="param-label">Вес</label>
            <div className="param-input-wrap">
              <input
                type="number"
                className="input-field"
                placeholder="70"
                value={weight}
                onChange={e => setWeight(e.target.value)}
                min="30"
                max="250"
                step="0.1"
              />
              <span className="param-unit">кг</span>
            </div>
          </div>
          <button
            className="btn btn-accent btn-full"
            onClick={handleSaveProfile}
            disabled={savingProfile}
          >
            {savingProfile ? '⏳ Сохраняю...' : '💾 Сохранить'}
          </button>
        </div>
      </div>

      {allTimeStats && (
        <>
          <div className="profile-section">
            <h3 className="section-title">📊 Статистика за всё время</h3>
            <div className="metrics-grid">
              <MetricCard
                icon="📏"
                label="Суммарный км"
                value={formatDistance(allTimeStats.totalDistance)}
              />
              <MetricCard
                icon="🏃"
                label="Всего пробежек"
                value={allTimeStats.workoutCount.toString()}
              />
              <MetricCard
                icon="⚡"
                label="Лучший темп"
                value={formatPace(allTimeStats.bestPace)}
                sub="мин/км"
              />
              <MetricCard
                icon="⏱️"
                label="Среднее время"
                value={allTimeStats.avgPace ? formatPace(allTimeStats.avgPace) : '—'}
                sub="мин/км"
              />
            </div>
          </div>

          {syncStatus && (
            <div className="profile-section">
              <h3 className="section-title">🔄 Синхронизация Strava</h3>
              <div className="sync-status">
                <p className="sync-status-text">
                  ✅ Подключена к Strava
                </p>
                {syncStatus.total_imported && (
                  <p className="sync-details">
                    Загружено {syncStatus.total_imported} тренировок
                  </p>
                )}
                {syncStatus.is_syncing && (
                  <div className="sync-progress">
                    <div className="progress-bar">
                      <div
                        className="progress-fill"
                        style={{
                          width: `${
                            syncStatus.total_workouts > 0
                              ? (syncStatus.total_imported / syncStatus.total_workouts) * 100
                              : 0
                          }%`
                        }}
                      ></div>
                    </div>
                    <p className="progress-text">
                      Загружаем историю: {syncStatus.total_imported}/{syncStatus.total_workouts} тренировок
                    </p>
                  </div>
                )}
              </div>
              <button
                className="btn btn-secondary"
                style={{ marginTop: '8px', fontSize: '13px' }}
                onClick={async () => {
                  try {
                    await strava.syncSplits();
                    alert('Загрузка сплитов запущена в фоне!');
                  } catch (err) {
                    console.error(err);
                  }
                }}
              >
                📊 Загрузить сплиты по км
              </button>
            </div>
          )}
        </>
      )}

      <div className="profile-section">
        <h3 className="section-title">🎯 Твои цели</h3>

        {goals.length > 0 ? (
          <div className="goals-list">
            {goals.map(goal => (
              <div key={goal.id} className="goal-item">
                <div className="goal-header">
                  <span className="goal-type">{getGoalLabel(goal.type)}</span>
                  <button
                    className="goal-delete-btn"
                    onClick={() => handleDeleteGoal(goal.id)}
                    title="Удалить цель"
                  >
                    ✕
                  </button>
                </div>
                <div className="goal-values">
                  <span>{formatGoalValue(goal.type, goal.current_value)}</span>
                  <span> / </span>
                  <span>{formatGoalValue(goal.type, goal.target_value)}</span>
                </div>
                {(() => {
                  const pred = predictions.find((p: any) => p.goalId === goal.id);
                  if (!pred || !pred.message) return null;
                  return (
                    <div className={`goal-prediction ${pred.onTrack ? 'prediction-good' : 'prediction-warn'}`}>
                      <span className="prediction-icon">{pred.onTrack ? '🟢' : '🟡'}</span>
                      <span className="prediction-text">{pred.message}</span>
                      {pred.trend !== undefined && pred.trend !== 0 && (
                        <span className={`prediction-trend ${pred.trend > 0 ? 'trend-up' : 'trend-down'}`}>
                          {pred.trend > 0 ? '↑' : '↓'}{Math.abs(pred.trend)}%
                        </span>
                      )}
                    </div>
                  );
                })()}
                {goal.deadline && (
                  <div className="goal-deadline">
                    {(() => {
                      const daysLeft = Math.ceil((new Date(goal.deadline).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
                      if (daysLeft < 0) return <span className="deadline-passed">Дедлайн прошёл</span>;
                      if (daysLeft <= 7) return <span className="deadline-soon">Осталось {daysLeft} дн.</span>;
                      return <span className="deadline-ok">До {new Date(goal.deadline).toLocaleDateString('ru-RU')} ({daysLeft} дн.)</span>;
                    })()}
                  </div>
                )}
                <div className="goal-progress">
                  <div className="progress-bar">
                    <div
                      className="progress-fill"
                      style={{
                        width: `${Math.min((goal.current_value / goal.target_value) * 100, 100)}%`
                      }}
                    ></div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="empty-text">Целей пока нет. Создай первую!</p>
        )}

        <div className="add-goal-form">
          <select
            className="input-field"
            value={newGoalType}
            onChange={e => setNewGoalType(e.target.value)}
          >
            {GOAL_TYPES.map(gt => (
              <option key={gt.value} value={gt.value}>{gt.label}</option>
            ))}
          </select>

          {currentGoalConfig?.inputType === 'distance' && (
            <div className="distance-input-row">
              <input
                type="number"
                className="input-field"
                placeholder="Значение"
                value={newGoalTarget}
                onChange={e => setNewGoalTarget(e.target.value)}
              />
              <select
                className="input-field unit-select"
                value={newGoalUnit}
                onChange={e => setNewGoalUnit(e.target.value as 'km' | 'm')}
              >
                <option value="km">км</option>
                <option value="m">м</option>
              </select>
            </div>
          )}

          {currentGoalConfig?.inputType === 'time' && (
            <div className="time-input-row">
              <input
                type="number"
                className="input-field time-input"
                placeholder="ч"
                min="0"
                max="23"
                value={timeHours}
                onChange={e => setTimeHours(e.target.value)}
              />
              <span className="time-separator">:</span>
              <input
                type="number"
                className="input-field time-input"
                placeholder="мин"
                min="0"
                max="59"
                value={timeMinutes}
                onChange={e => setTimeMinutes(e.target.value)}
              />
              <span className="time-separator">:</span>
              <input
                type="number"
                className="input-field time-input"
                placeholder="сек"
                min="0"
                max="59"
                value={timeSeconds}
                onChange={e => setTimeSeconds(e.target.value)}
              />
            </div>
          )}

          {currentGoalConfig?.inputType === 'number' && (
            <input
              type="number"
              className="input-field"
              placeholder="Количество"
              value={newGoalTarget}
              onChange={e => setNewGoalTarget(e.target.value)}
            />
          )}

          <div className="deadline-input-row">
            <label className="deadline-label">Дедлайн (необязательно):</label>
            <input
              type="date"
              className="input-field"
              value={newGoalDeadline}
              onChange={e => setNewGoalDeadline(e.target.value)}
              min={new Date().toISOString().split('T')[0]}
            />
          </div>

          <button
            className="btn btn-accent btn-full"
            onClick={handleAddGoal}
            disabled={creatingGoal}
          >
            {creatingGoal ? '⏳ Создаю...' : '➕ Добавить цель'}
          </button>
        </div>
      </div>

      <div className="profile-section">
        <button
          className="btn btn-secondary btn-full"
          onClick={handleLogout}
        >
          🚪 Выход
        </button>
      </div>

      <div className="profile-footer">
        <p>Runwise v1.0</p>
      </div>
    </div>
  );
};

export default Profile;
