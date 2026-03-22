import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import MetricCard from '../components/MetricCard';
import { workouts, strava, profile as profileApi } from '../api/api';
import { formatPace, formatDistance } from '../utils';
import { ALL_METRICS, getProfileWidgets, saveProfileWidgets } from '../config/metrics';

interface PersonalRecord {
  id: string;
  distance_type: string;
  time_seconds: number;
  record_date: string | null;
  source: string;
}

const RECORD_TYPES = [
  { key: '1km', label: '1 км' },
  { key: '3km', label: '3 км' },
  { key: '5km', label: '5 км' },
  { key: '10km', label: '10 км' },
  { key: '21km', label: 'Полумарафон' },
  { key: '42km', label: 'Марафон' },
];

interface Goal {
  id: string;
  type: string;
  target_value: number;
  current_value: number;
  deadline: string | null;
}

interface ProfileProps {
  onLogout: () => void;
}

const Profile: React.FC<ProfileProps> = ({ onLogout }) => {
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
  const [showGoalModal, setShowGoalModal] = useState(false);
  const [goalModalClosing, setGoalModalClosing] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [settingsModalClosing, setSettingsModalClosing] = useState(false);
  const [age, setAge] = useState('');
  const [height, setHeight] = useState('');
  const [weight, setWeight] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [showParamsModal, setShowParamsModal] = useState(false);
  const [paramsModalClosing, setParamsModalClosing] = useState(false);
  const [records, setRecords] = useState<PersonalRecord[]>([]);
  const [showRecordModal, setShowRecordModal] = useState(false);
  const [recordModalClosing, setRecordModalClosing] = useState(false);
  const [newRecordType, setNewRecordType] = useState<string | null>(null);
  const [recordType, setRecordType] = useState('5km');
  const [recordHours, setRecordHours] = useState('');
  const [recordMinutes, setRecordMinutes] = useState('');
  const [recordSeconds, setRecordSeconds] = useState('');
  const [recordDate, setRecordDate] = useState('');
  const [savingRecord, setSavingRecord] = useState(false);
  const [removingRecord, setRemovingRecord] = useState<string | null>(null);

  // Widget edit state
  const [selectedWidgets, setSelectedWidgets] = useState<string[]>(getProfileWidgets);
  const [widgetEditMode, setWidgetEditMode] = useState(false);
  const [showWidgetSettings, setShowWidgetSettings] = useState(false);
  const [tempWidgets, setTempWidgets] = useState<string[]>([]);
  const dragItem = useRef<number | null>(null);
  const dragOverItem = useRef<number | null>(null);
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const touchClone = useRef<HTMLElement | null>(null);

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

  // Widget edit helpers
  const openWidgetSettings = () => {
    setTempWidgets([...selectedWidgets]);
    setShowWidgetSettings(true);
  };

  const toggleWidgetMetric = (id: string) => {
    setTempWidgets(prev =>
      prev.includes(id) ? prev.filter(w => w !== id) : [...prev, id]
    );
  };

  const saveWidgetSettings = () => {
    if (tempWidgets.length === 0) return;
    setSelectedWidgets(tempWidgets);
    saveProfileWidgets(tempWidgets);
    setShowWidgetSettings(false);
  };

  const handleDragStart = (idx: number) => {
    dragItem.current = idx;
    setDraggingIdx(idx);
  };

  const handleDragEnter = (idx: number) => {
    dragOverItem.current = idx;
  };

  const handleDragEnd = () => {
    if (dragItem.current !== null && dragOverItem.current !== null && dragItem.current !== dragOverItem.current) {
      const arr = [...selectedWidgets];
      const [removed] = arr.splice(dragItem.current, 1);
      arr.splice(dragOverItem.current, 0, removed);
      setSelectedWidgets(arr);
      saveProfileWidgets(arr);
    }
    dragItem.current = null;
    dragOverItem.current = null;
    setDraggingIdx(null);
  };

  const handleTouchStart = (e: React.TouchEvent, idx: number) => {
    if (!widgetEditMode) return;
    const touch = e.touches[0];
    dragItem.current = idx;
    setDraggingIdx(idx);

    const target = e.currentTarget as HTMLElement;
    const clone = target.cloneNode(true) as HTMLElement;
    clone.classList.add('metric-card-drag-clone');
    clone.style.width = target.offsetWidth + 'px';
    clone.style.position = 'fixed';
    clone.style.left = touch.clientX - target.offsetWidth / 2 + 'px';
    clone.style.top = touch.clientY - target.offsetHeight / 2 + 'px';
    clone.style.zIndex = '9999';
    clone.style.pointerEvents = 'none';
    document.body.appendChild(clone);
    touchClone.current = clone;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!widgetEditMode || dragItem.current === null) return;
    const touch = e.touches[0];

    if (touchClone.current) {
      const target = e.currentTarget as HTMLElement;
      touchClone.current.style.left = touch.clientX - target.offsetWidth / 2 + 'px';
      touchClone.current.style.top = touch.clientY - target.offsetHeight / 2 + 'px';
    }

    if (gridRef.current) {
      const cards = gridRef.current.querySelectorAll('.metric-card-wrapper');
      cards.forEach((card, i) => {
        const rect = card.getBoundingClientRect();
        if (
          touch.clientX >= rect.left && touch.clientX <= rect.right &&
          touch.clientY >= rect.top && touch.clientY <= rect.bottom
        ) {
          dragOverItem.current = i;
        }
      });
    }
  };

  const handleTouchEnd = () => {
    if (touchClone.current) {
      document.body.removeChild(touchClone.current);
      touchClone.current = null;
    }
    handleDragEnd();
  };

  const activeProfileMetrics = selectedWidgets
    .map(id => ALL_METRICS.find(m => m.id === id))
    .filter(Boolean) as typeof ALL_METRICS;

  useEffect(() => {
    loadProfileData();
  }, []);

  const loadProfileData = async () => {
    setLoading(true);
    try {
      const [statsData, goalsData, syncData, predsData, profileData, recordsData] = await Promise.allSettled([
        workouts.stats('all'),
        workouts.getGoals(),
        strava.syncStatus(),
        workouts.goalPredictions(),
        profileApi.get(),
        profileApi.getRecords()
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
      if (recordsData.status === 'fulfilled') {
        setRecords(recordsData.value);
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
      setGoalModalClosing(true);
      setTimeout(async () => {
        setShowGoalModal(false);
        setGoalModalClosing(false);
        await loadProfileData();
      }, 1000);
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
      closeParamsModal();
    } catch (err) {
      console.error('Failed to save profile:', err);
    } finally {
      setSavingProfile(false);
    }
  };

  const closeRecordModal = () => {
    setRecordModalClosing(true);
    setTimeout(() => {
      setShowRecordModal(false);
      setRecordModalClosing(false);
    }, 1000);
  };

  const closeSettingsModal = () => {
    setSettingsModalClosing(true);
    setTimeout(() => {
      setShowSettingsModal(false);
      setSettingsModalClosing(false);
    }, 1000);
  };

  const closeGoalModal = () => {
    setGoalModalClosing(true);
    setTimeout(() => {
      setShowGoalModal(false);
      setGoalModalClosing(false);
    }, 1000);
  };

  const closeParamsModal = () => {
    setParamsModalClosing(true);
    setTimeout(() => {
      setShowParamsModal(false);
      setParamsModalClosing(false);
    }, 1000);
  };

  const formatRecordTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return h > 0
      ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
      : `${m}:${s.toString().padStart(2, '0')}`;
  };

  const handleAddRecord = async () => {
    const h = parseInt(recordHours) || 0;
    const m = parseInt(recordMinutes) || 0;
    const s = parseInt(recordSeconds) || 0;
    const totalSeconds = h * 3600 + m * 60 + s;
    if (totalSeconds <= 0) return;

    setSavingRecord(true);
    try {
      const saved = await profileApi.updateRecord({
        distance_type: recordType,
        time_seconds: totalSeconds,
        record_date: recordDate || undefined
      });
      // 1. Animate modal closing
      setRecordModalClosing(true);
      setRecordHours('');
      setRecordMinutes('');
      setRecordSeconds('');
      setRecordDate('');
      // 2. After modal is gone, update list
      setTimeout(() => {
        setShowRecordModal(false);
        setRecordModalClosing(false);
        setNewRecordType(saved.distance_type);
        setRecords(prev => {
          const exists = prev.findIndex(r => r.distance_type === saved.distance_type);
          if (exists >= 0) {
            const updated = [...prev];
            updated[exists] = saved;
            return updated;
          }
          return [...prev, saved];
        });
        // 3. Remove "new" class after animation ends
        setTimeout(() => setNewRecordType(null), 1000);
      }, 1050);
    } catch (err) {
      console.error('Failed to save record:', err);
    } finally {
      setSavingRecord(false);
    }
  };

  const handleDeleteRecord = async (type: string) => {
    if (!window.confirm('Удалить этот рекорд?')) return;
    try {
      await profileApi.deleteRecord(type);
      setRemovingRecord(type);
      setTimeout(() => {
        setRecords(prev => prev.filter(r => r.distance_type !== type));
        setRemovingRecord(null);
      }, 450);
    } catch (err) {
      console.error('Failed to delete record:', err);
    }
  };

  const handleLogout = () => {
    if (window.confirm('Ты уверен? Это разлогинит тебя.')) {
      onLogout();
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
      <div className="profile-header">
        <h2 className="screen-title">👤 Профиль</h2>
        <button className="settings-btn" onClick={() => setShowSettingsModal(true)} title="Настройки">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>
      </div>

      {allTimeStats && (
        <div className="profile-section">
          <div className="home-header" style={{ marginBottom: 'var(--spacing-sm)' }}>
            <h3 className="section-title" style={{ margin: 0 }}>📊 Статистика за всё время</h3>
            <div className="home-header-actions">
              {widgetEditMode && (
                <button className="btn-icon" onClick={openWidgetSettings} title="Добавить/убрать виджеты">
                  ➕
                </button>
              )}
              <button
                className={`btn-icon ${widgetEditMode ? 'btn-icon-active' : ''}`}
                onClick={() => setWidgetEditMode(!widgetEditMode)}
                title={widgetEditMode ? 'Готово' : 'Настроить виджеты'}
              >
                {widgetEditMode ? '✓' : '⚙️'}
              </button>
            </div>
          </div>
          <div className={`metrics-grid ${widgetEditMode ? 'metrics-grid-edit' : ''}`} ref={gridRef}>
            {activeProfileMetrics.map((metric, idx) => (
              <div
                key={metric.id}
                className={`metric-card-wrapper ${widgetEditMode ? 'editable' : ''} ${draggingIdx === idx ? 'dragging' : ''}`}
                draggable={widgetEditMode}
                onDragStart={() => handleDragStart(idx)}
                onDragEnter={() => handleDragEnter(idx)}
                onDragEnd={handleDragEnd}
                onDragOver={(e) => e.preventDefault()}
                onTouchStart={(e) => handleTouchStart(e, idx)}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
              >
                <MetricCard
                  icon={metric.icon}
                  label={metric.label}
                  value={metric.getValue(allTimeStats)}
                  sub={metric.sub}
                />
                {widgetEditMode && (
                  <button
                    className="metric-card-remove"
                    onClick={() => {
                      const updated = selectedWidgets.filter(id => id !== metric.id);
                      setSelectedWidgets(updated);
                      saveProfileWidgets(updated);
                    }}
                  >✕</button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="profile-section">
        <h3 className="section-title">📏 Физические параметры</h3>
        {(age || height || weight) ? (
          <div className="params-summary">
            {age && <div className="params-summary-item"><span className="params-summary-label">Возраст</span><span className="params-summary-value">{age} лет</span></div>}
            {height && <div className="params-summary-item"><span className="params-summary-label">Рост</span><span className="params-summary-value">{height} см</span></div>}
            {weight && <div className="params-summary-item"><span className="params-summary-label">Вес</span><span className="params-summary-value">{weight} кг</span></div>}
          </div>
        ) : (
          <p className="empty-text">Параметры не указаны</p>
        )}
        <button
          className="btn btn-accent btn-full"
          onClick={() => setShowParamsModal(true)}
        >
          ✏️ {(age || height || weight) ? 'Изменить' : 'Указать параметры'}
        </button>
      </div>

      <div className="profile-section">
        <h3 className="section-title">🏆 Мои рекорды</h3>

        {records.length > 0 ? (
          <div className="records-list">
            {records.map(record => {
              const typeInfo = RECORD_TYPES.find(t => t.key === record.distance_type);
              return (
                <div key={record.id} className={`record-item${removingRecord === record.distance_type ? ' record-removing' : ''}${newRecordType === record.distance_type ? ' record-new' : ''}`}>
                  <div className="record-header">
                    <span className="record-distance">{typeInfo?.label || record.distance_type}</span>
                    <button
                      className="goal-delete-btn"
                      onClick={() => handleDeleteRecord(record.distance_type)}
                      title="Удалить рекорд"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="record-time">{formatRecordTime(record.time_seconds)}</div>
                  {record.record_date && (
                    <div className="record-date">
                      {new Date(record.record_date).toLocaleDateString('ru-RU')}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="empty-text records-empty">Рекордов пока нет. Добавь свой первый!</p>
        )}

        <button
          className="btn btn-outline btn-full"
          onClick={() => setShowRecordModal(true)}
        >
          ➕ Добавить рекорд
        </button>
      </div>


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

        <button
          className="btn btn-outline btn-full"
          onClick={() => setShowGoalModal(true)}
        >
          ➕ Добавить цель
        </button>
      </div>

      <div className="profile-footer">
        <p>Runwise v1.0</p>
      </div>

      {showSettingsModal && ReactDOM.createPortal(
        <div className={`modal-overlay${settingsModalClosing ? ' modal-closing' : ''}`} onClick={closeSettingsModal}>
          <div className={`modal-content${settingsModalClosing ? ' modal-content-closing' : ''}`} onClick={e => e.stopPropagation()}>
            <h3 className="modal-title">Настройки</h3>

            <div className="settings-section">
              <div className="settings-item">
                <div className="settings-item-icon">🟠</div>
                <div className="settings-item-info">
                  <span className="settings-item-label">Strava</span>
                  <span className="settings-item-status">Подключена</span>
                </div>
              </div>

              {syncStatus?.total_imported && (
                <div className="settings-item">
                  <div className="settings-item-icon">📊</div>
                  <div className="settings-item-info">
                    <span className="settings-item-label">Тренировок загружено</span>
                    <span className="settings-item-status">{syncStatus.total_imported}</span>
                  </div>
                </div>
              )}

            </div>

            <button
              className="btn btn-danger btn-full"
              onClick={() => {
                closeSettingsModal();
                setTimeout(() => handleLogout(), 1000);
              }}
            >
              🚪 Выйти из аккаунта
            </button>
          </div>
        </div>,
        document.body
      )}

      {showParamsModal && ReactDOM.createPortal(
        <div className={`modal-overlay${paramsModalClosing ? ' modal-closing' : ''}`} onClick={closeParamsModal}>
          <div className={`modal-content${paramsModalClosing ? ' modal-content-closing' : ''}`} onClick={e => e.stopPropagation()}>
            <h3 className="modal-title">Физические параметры</h3>

            <div className="modal-field">
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

            <div className="modal-field">
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

            <div className="modal-field">
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

            <div className="modal-actions">
              <button
                className="btn btn-secondary"
                onClick={closeParamsModal}
              >
                Отмена
              </button>
              <button
                className="btn btn-accent"
                onClick={handleSaveProfile}
                disabled={savingProfile}
              >
                {savingProfile ? '⏳ Сохраняю...' : '💾 Сохранить'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {showGoalModal && ReactDOM.createPortal(
        <div className={`modal-overlay${goalModalClosing ? ' modal-closing' : ''}`} onClick={closeGoalModal}>
          <div className={`modal-content${goalModalClosing ? ' modal-content-closing' : ''}`} onClick={e => e.stopPropagation()}>
            <h3 className="modal-title">Добавить цель</h3>

            <div className="modal-field">
              <label className="param-label">Тип цели</label>
              <select
                className="input-field"
                value={newGoalType}
                onChange={e => setNewGoalType(e.target.value)}
              >
                {GOAL_TYPES.map(gt => (
                  <option key={gt.value} value={gt.value}>{gt.label}</option>
                ))}
              </select>
            </div>

            {currentGoalConfig?.inputType === 'distance' && (
              <div className="modal-field">
                <label className="param-label">Значение</label>
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
              </div>
            )}

            {currentGoalConfig?.inputType === 'time' && (
              <div className="modal-field">
                <label className="param-label">Время</label>
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
              </div>
            )}

            {currentGoalConfig?.inputType === 'number' && (
              <div className="modal-field">
                <label className="param-label">Количество</label>
                <input
                  type="number"
                  className="input-field"
                  placeholder="Количество"
                  value={newGoalTarget}
                  onChange={e => setNewGoalTarget(e.target.value)}
                />
              </div>
            )}

            <div className="modal-field">
              <label className="param-label">Дедлайн (необязательно)</label>
              <input
                type="date"
                className="input-field"
                value={newGoalDeadline}
                onChange={e => setNewGoalDeadline(e.target.value)}
                min={new Date().toISOString().split('T')[0]}
              />
            </div>

            <div className="modal-actions">
              <button
                className="btn btn-secondary"
                onClick={closeGoalModal}
              >
                Отмена
              </button>
              <button
                className="btn btn-accent"
                onClick={handleAddGoal}
                disabled={creatingGoal}
              >
                {creatingGoal ? '⏳ Создаю...' : '💾 Сохранить'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {showRecordModal && ReactDOM.createPortal(
        <div className={`modal-overlay${recordModalClosing ? ' modal-closing' : ''}`} onClick={closeRecordModal}>
          <div className={`modal-content${recordModalClosing ? ' modal-content-closing' : ''}`} onClick={e => e.stopPropagation()}>
            <h3 className="modal-title">Добавить рекорд</h3>

            <div className="modal-field">
              <label className="param-label">Дистанция</label>
              <select
                className="input-field"
                value={recordType}
                onChange={e => setRecordType(e.target.value)}
              >
                {RECORD_TYPES.map(t => (
                  <option key={t.key} value={t.key}>{t.label}</option>
                ))}
              </select>
            </div>

            <div className="modal-field">
              <label className="param-label">Время</label>
              <div className="time-input-row">
                <input
                  type="number"
                  className="input-field time-input"
                  placeholder="ч"
                  min="0"
                  max="23"
                  value={recordHours}
                  onChange={e => setRecordHours(e.target.value)}
                />
                <span className="time-separator">:</span>
                <input
                  type="number"
                  className="input-field time-input"
                  placeholder="мин"
                  min="0"
                  max="59"
                  value={recordMinutes}
                  onChange={e => setRecordMinutes(e.target.value)}
                />
                <span className="time-separator">:</span>
                <input
                  type="number"
                  className="input-field time-input"
                  placeholder="сек"
                  min="0"
                  max="59"
                  value={recordSeconds}
                  onChange={e => setRecordSeconds(e.target.value)}
                />
              </div>
            </div>

            <div className="modal-field">
              <label className="param-label">Дата (необязательно)</label>
              <input
                type="date"
                className="input-field"
                value={recordDate}
                onChange={e => setRecordDate(e.target.value)}
                max={new Date().toISOString().split('T')[0]}
              />
            </div>

            <div className="modal-actions">
              <button
                className="btn btn-secondary"
                onClick={closeRecordModal}
              >
                Отмена
              </button>
              <button
                className="btn btn-accent"
                onClick={handleAddRecord}
                disabled={savingRecord}
              >
                {savingRecord ? '⏳ Сохраняю...' : '💾 Сохранить'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
      {showWidgetSettings && (
        <div className="widget-settings-overlay" onClick={() => setShowWidgetSettings(false)}>
          <div className="widget-settings-modal" onClick={e => e.stopPropagation()}>
            <div className="widget-settings-header">
              <h3>Настройка виджетов</h3>
              <button className="btn-icon" onClick={() => setShowWidgetSettings(false)}>✕</button>
            </div>

            <div className="widget-settings-list">
              {ALL_METRICS.map(metric => {
                const isSelected = tempWidgets.includes(metric.id);
                return (
                  <div
                    key={metric.id}
                    className={`widget-settings-item ${isSelected ? 'active' : ''}`}
                  >
                    <label className="widget-settings-toggle">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleWidgetMetric(metric.id)}
                      />
                      <span className="widget-settings-icon">{metric.icon}</span>
                      <span className="widget-settings-label">{metric.label}</span>
                    </label>
                  </div>
                );
              })}
            </div>

            <button
              className="btn btn-accent widget-settings-save"
              onClick={saveWidgetSettings}
              disabled={tempWidgets.length === 0}
            >
              Сохранить ({tempWidgets.length})
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default Profile;
