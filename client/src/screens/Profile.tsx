import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import { useTranslation } from 'react-i18next';
import MetricCard from '../components/MetricCard';
import { workouts, strava, profile as profileApi } from '../api/api';
import { formatPace, formatDistance } from '../utils';
import { ALL_METRICS, getProfileWidgets, saveProfileWidgets } from '../config/metrics';
import i18n from '../i18n';

interface PersonalRecord {
  id: string;
  distance_type: string;
  time_seconds: number;
  record_date: string | null;
  source: string;
}

interface Goal {
  id: string;
  type: string;
  target_value: number;
  current_value: number;
  deadline: string | null;
}

interface ProfileProps {
  onLogout: () => void;
  isActive?: boolean;
}

const LOCALE_MAP: Record<string, string> = { ru: 'ru-RU', uk: 'uk-UA', en: 'en-US' };

const LANGUAGES = [
  { code: 'ru', label: '🇷🇺 Русский' },
  { code: 'uk', label: '🇺🇦 Українська' },
  { code: 'en', label: '🇬🇧 English' },
];

function readCache<T>(key: string): T | null {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function writeCache(key: string, data: any) {
  try { localStorage.setItem(key, JSON.stringify(data)); } catch {}
}

const Profile: React.FC<ProfileProps> = ({ onLogout, isActive }) => {
  const { t } = useTranslation();
  const cached = readCache<{ stats: any; goals: Goal[]; predictions: any[]; syncStatus: any; profile: any; records: PersonalRecord[] }>('rw_profile_cache');
  const [allTimeStats, setAllTimeStats] = useState<any>(cached?.stats || null);
  const [goals, setGoals] = useState<Goal[]>(cached?.goals || []);
  const [loading, setLoading] = useState(!cached);
  const [syncStatus, setSyncStatus] = useState<any>(cached?.syncStatus || null);
  const [predictions, setPredictions] = useState<any[]>(cached?.predictions || []);
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
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [settingsModalClosing, setSettingsModalClosing] = useState(false);
  const [gender, setGender] = useState<string | null>(cached?.profile?.gender || null);
  const [age, setAge] = useState(cached?.profile?.age?.toString() || '');
  const [height, setHeight] = useState(cached?.profile?.height_cm?.toString() || '');
  const [weight, setWeight] = useState(cached?.profile?.weight_kg?.toString() || '');
  const [savingProfile, setSavingProfile] = useState(false);
  const [showParamsModal, setShowParamsModal] = useState(false);
  const [paramsModalClosing, setParamsModalClosing] = useState(false);
  const [records, setRecords] = useState<PersonalRecord[]>(cached?.records || []);
  const [showRecordModal, setShowRecordModal] = useState(false);
  const [editingRecord, setEditingRecord] = useState<PersonalRecord | null>(null);
  const [recordModalClosing, setRecordModalClosing] = useState(false);
  const [newRecordType, setNewRecordType] = useState<string | null>(null);
  const [recordType, setRecordType] = useState('5km');
  const [recordHours, setRecordHours] = useState('');
  const [recordMinutes, setRecordMinutes] = useState('');
  const [recordSeconds, setRecordSeconds] = useState('');
  const [recordDate, setRecordDate] = useState('');
  const [savingRecord, setSavingRecord] = useState(false);
  const [removingRecord, setRemovingRecord] = useState<string | null>(null);
  const [breakdownData, setBreakdownData] = useState<any>(null);
  const [breakdownClosing, setBreakdownClosing] = useState(false);

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

  const RECORD_TYPES = [
    { key: '1km', label: t('recordTypes.1km') },
    { key: '3km', label: t('recordTypes.3km') },
    { key: '5km', label: t('recordTypes.5km') },
    { key: '10km', label: t('recordTypes.10km') },
    { key: '21km', label: t('recordTypes.21km') },
    { key: '42km', label: t('recordTypes.42km') },
  ];

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

  const mountedRef = useRef(true);

  useEffect(() => {
    loadProfileData();
  }, []);

  useEffect(() => {
    if (!mountedRef.current && isActive) {
      loadProfileData();
    }
    mountedRef.current = false;
  }, [isActive]);

  const loadProfileData = async () => {
    try {
      const [statsData, goalsData, syncData, predsData, profileData, recordsData] = await Promise.allSettled([
        workouts.stats('all'),
        workouts.getGoals(),
        strava.syncStatus(),
        workouts.goalPredictions(),
        profileApi.get(),
        profileApi.getRecords()
      ]);

      const cacheObj: any = {};
      if (statsData.status === 'fulfilled') {
        setAllTimeStats(statsData.value);
        cacheObj.stats = statsData.value;
      }
      if (goalsData.status === 'fulfilled') {
        setGoals(goalsData.value);
        cacheObj.goals = goalsData.value;
      }
      if (syncData.status === 'fulfilled') {
        setSyncStatus(syncData.value);
        cacheObj.syncStatus = syncData.value;
      }
      if (predsData.status === 'fulfilled') {
        setPredictions(predsData.value);
        cacheObj.predictions = predsData.value;
      }
      if (profileData.status === 'fulfilled' && profileData.value) {
        if (profileData.value.gender) setGender(profileData.value.gender);
        if (profileData.value.age) setAge(profileData.value.age.toString());
        if (profileData.value.height_cm) setHeight(profileData.value.height_cm.toString());
        if (profileData.value.weight_kg) setWeight(profileData.value.weight_kg.toString());
        cacheObj.profile = profileData.value;
      }
      if (recordsData.status === 'fulfilled') {
        setRecords(recordsData.value);
        cacheObj.records = recordsData.value;
      }
      writeCache('rw_profile_cache', cacheObj);
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
      // Update goals locally without full reload
      if (editingGoal) {
        setGoals(prev => prev.map(g => g.id === savedGoal.id ? savedGoal : g));
      } else {
        setGoals(prev => [savedGoal, ...prev]);
      }
      setNewGoalId(savedGoal.id);
      setTimeout(() => setNewGoalId(null), 800);
      // Refresh predictions in background (lightweight)
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

  const openEditRecord = (record: PersonalRecord) => {
    setRecordType(record.distance_type);
    const h = Math.floor(record.time_seconds / 3600);
    const m = Math.floor((record.time_seconds % 3600) / 60);
    const s = record.time_seconds % 60;
    setRecordHours(h > 0 ? h.toString() : '');
    setRecordMinutes(m > 0 ? m.toString() : '');
    setRecordSeconds(s > 0 ? s.toString() : '');
    setRecordDate(record.record_date ? record.record_date.split('T')[0] : '');
    setEditingRecord(record);
    setShowRecordModal(true);
  };

  const handleSaveProfile = async () => {
    setSavingProfile(true);
    try {
      await profileApi.update({
        gender: gender || null,
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
      setEditingRecord(null);
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
      setEditingGoal(null);
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
      setEditingRecord(null);
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
    if (!window.confirm(t('profile.deleteRecordConfirm'))) return;
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
    if (window.confirm(t('profile.logoutConfirm'))) {
      onLogout();
    }
  };

  const handleLanguageChange = (code: string) => {
    i18n.changeLanguage(code);
    localStorage.setItem('runwise_language', code);
  };

  return (
    <div className="screen profile-screen">
      <div className="profile-header">
        <h2 className="screen-title">👤 {t('profile.title')}</h2>
        <button className="settings-btn" onClick={() => setShowSettingsModal(true)} title={t('profile.settings')}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>
      </div>

      {allTimeStats && (
        <div className="profile-section">
          <div className="home-header" style={{ marginBottom: 'var(--spacing-sm)' }}>
            <h3 className="section-title" style={{ margin: 0 }}>📊 {t('profile.allTimeStats')}</h3>
            <div className="home-header-actions">
              {widgetEditMode && (
                <button className="btn-icon" onClick={openWidgetSettings} title={t('home.addRemoveWidgets')}>
                  ➕
                </button>
              )}
              <button
                className={`btn-icon ${widgetEditMode ? 'btn-icon-active' : ''}`}
                onClick={() => setWidgetEditMode(!widgetEditMode)}
                title={widgetEditMode ? t('common.done') : t('home.configureWidgets')}
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
                  label={t(metric.labelKey)}
                  value={metric.getValue(allTimeStats)}
                  sub={metric.subKey ? t(metric.subKey) : undefined}
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
        <h3 className="section-title">📏 {t('profile.physicalParams')}</h3>
        {(age || height || weight) ? (
          <div className="params-summary">
            {age && <div className="params-summary-item"><span className="params-summary-label">{t('profile.age')}</span><span className="params-summary-value">{age} {t('units.years')}</span></div>}
            {height && <div className="params-summary-item"><span className="params-summary-label">{t('profile.height')}</span><span className="params-summary-value">{height} {t('units.cm')}</span></div>}
            {weight && <div className="params-summary-item"><span className="params-summary-label">{t('profile.weight')}</span><span className="params-summary-value">{weight} {t('units.kg')}</span></div>}
          </div>
        ) : (
          <p className="empty-text">{t('profile.noParams')}</p>
        )}
        <button
          className="btn btn-accent btn-full"
          onClick={() => setShowParamsModal(true)}
        >
          ✏️ {(age || height || weight) ? t('common.edit') : t('profile.setParams')}
        </button>
      </div>

      <div className="profile-section">
        <h3 className="section-title">🏆 {t('profile.records')}</h3>

        {records.length > 0 ? (
          <div className="records-list">
            {records.map(record => {
              const typeInfo = RECORD_TYPES.find(rt => rt.key === record.distance_type);
              return (
                <div key={record.id} className={`record-item${removingRecord === record.distance_type ? ' record-removing' : ''}${newRecordType === record.distance_type ? ' record-new' : ''}`}>
                  <div className="record-header">
                    <span className="record-distance">{typeInfo?.label || record.distance_type}</span>
                    <div className="goal-actions">
                      <button
                        className="goal-edit-btn"
                        onClick={() => openEditRecord(record)}
                        title={t('profile.editRecord')}
                      >
                        ✏️
                      </button>
                      <button
                        className="goal-delete-btn"
                        onClick={() => handleDeleteRecord(record.distance_type)}
                        title={t('common.delete')}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                  <div className="record-time">{formatRecordTime(record.time_seconds)}</div>
                  {record.record_date && (
                    <div className="record-date">
                      {new Date(record.record_date).toLocaleDateString(LOCALE_MAP[i18n.language] || 'ru-RU')}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="empty-text records-empty">{t('profile.noRecords')}</p>
        )}

        <button
          className="btn btn-outline btn-full"
          onClick={() => setShowRecordModal(true)}
        >
          ➕ {t('profile.addRecord')}
        </button>
      </div>


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
                    <button
                      className="goal-edit-btn"
                      onClick={() => openEditGoal(goal)}
                      title={t('profile.editGoal')}
                    >
                      ✏️
                    </button>
                    <button
                      className="goal-delete-btn"
                      onClick={() => handleDeleteGoal(goal.id)}
                      title={t('common.delete')}
                    >
                      ✕
                    </button>
                  </div>
                </div>

                {pred?.breakdown ? (
                  /* PB goal — special card layout */
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
                        <button
                          className="pb-info-btn"
                          onClick={() => setBreakdownData(pred.breakdown)}
                          title={t('profile.details')}
                        >{t('profile.details')}</button>
                      </div>
                    </div>
                  </>
                ) : (
                  /* Non-PB goals — standard layout */
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

        <button
          className="btn btn-outline btn-full"
          onClick={() => setShowGoalModal(true)}
        >
          ➕ {t('profile.addGoal')}
        </button>
      </div>

      <div className="profile-footer">
        <p>{t('profile.version')}</p>
      </div>

      {showSettingsModal && ReactDOM.createPortal(
        <div className={`modal-overlay${settingsModalClosing ? ' modal-closing' : ''}`} onClick={closeSettingsModal}>
          <div className={`modal-content${settingsModalClosing ? ' modal-content-closing' : ''}`} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">{t('profile.settings')}</h3>
              <button className="modal-close-btn" onClick={closeSettingsModal}>✕</button>
            </div>

            <div className="settings-section">
              <div className="settings-section-title">🌐 {t('profile.language')}</div>
              <div className="language-list">
                {LANGUAGES.map(lang => (
                  <button
                    key={lang.code}
                    className={`language-item${i18n.language === lang.code ? ' active' : ''}`}
                    onClick={() => handleLanguageChange(lang.code)}
                  >
                    <span>{lang.label}</span>
                    {i18n.language === lang.code && <span className="language-check">✓</span>}
                  </button>
                ))}
              </div>
            </div>

            <div className="settings-section">
              <div className="settings-item">
                <div className="settings-item-icon">🟠</div>
                <div className="settings-item-info">
                  <span className="settings-item-label">{t('profile.strava')}</span>
                  <span className="settings-item-status">{t('profile.stravaConnected')}</span>
                </div>
              </div>

              {syncStatus?.total_imported && (
                <div className="settings-item">
                  <div className="settings-item-icon">📊</div>
                  <div className="settings-item-info">
                    <span className="settings-item-label">{t('profile.workoutsImported')}</span>
                    <span className="settings-item-status">{syncStatus.total_imported}</span>
                  </div>
                </div>
              )}

              <button
                className="btn btn-secondary btn-full"
                style={{ marginTop: 8 }}
                onClick={async (e) => {
                  const btn = e.currentTarget;
                  btn.disabled = true;
                  btn.textContent = '⏳ Анализирую...';
                  try {
                    const res = await workouts.reanalyze();
                    btn.textContent = `✅ Готово: ${res.updated} из ${res.total} обновлено`;
                  } catch {
                    btn.textContent = '❌ Ошибка';
                  }
                  setTimeout(() => { btn.disabled = false; btn.textContent = '🔍 Перепроверить GPS-аномалии'; }, 3000);
                }}
              >
                🔍 Перепроверить GPS-аномалии
              </button>

            </div>

            <button
              className="btn btn-danger btn-full"
              onClick={() => {
                closeSettingsModal();
                setTimeout(() => handleLogout(), 1000);
              }}
            >
              🚪 {t('profile.logout')}
            </button>
          </div>
        </div>,
        document.body
      )}

      {showParamsModal && ReactDOM.createPortal(
        <div className={`modal-overlay${paramsModalClosing ? ' modal-closing' : ''}`} onClick={closeParamsModal}>
          <div className={`modal-content${paramsModalClosing ? ' modal-content-closing' : ''}`} onClick={e => e.stopPropagation()}>
            <h3 className="modal-title">{t('profile.physicalParams')}</h3>

            <div className="modal-field">
              <label className="param-label">{t('profile.gender')}</label>
              <div className="gender-selector">
                <button
                  className={`gender-btn${gender === 'male' ? ' active' : ''}`}
                  onClick={() => setGender(gender === 'male' ? null : 'male')}
                >
                  ♂ {t('profile.gender_male')}
                </button>
                <button
                  className={`gender-btn${gender === 'female' ? ' active' : ''}`}
                  onClick={() => setGender(gender === 'female' ? null : 'female')}
                >
                  ♀ {t('profile.gender_female')}
                </button>
              </div>
            </div>

            <div className="modal-field">
              <label className="param-label">{t('profile.age')}</label>
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
                <span className="param-unit">{t('units.years')}</span>
              </div>
            </div>

            <div className="modal-field">
              <label className="param-label">{t('profile.height')}</label>
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
                <span className="param-unit">{t('units.cm')}</span>
              </div>
            </div>

            <div className="modal-field">
              <label className="param-label">{t('profile.weight')}</label>
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
                <span className="param-unit">{t('units.kg')}</span>
              </div>
            </div>

            <div className="modal-actions">
              <button
                className="btn btn-secondary"
                onClick={closeParamsModal}
              >
                {t('common.cancel')}
              </button>
              <button
                className="btn btn-accent"
                onClick={handleSaveProfile}
                disabled={savingProfile}
              >
                {savingProfile ? `⏳ ${t('common.saving')}` : `💾 ${t('common.save')}`}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {showGoalModal && ReactDOM.createPortal(
        <div className={`modal-overlay${goalModalClosing ? ' modal-closing' : ''}`} onClick={closeGoalModal}>
          <div className={`modal-content${goalModalClosing ? ' modal-content-closing' : ''}`} onClick={e => e.stopPropagation()}>
            <h3 className="modal-title">{editingGoal ? t('profile.editGoal') : t('profile.addGoal')}</h3>

            <div className="modal-field">
              <label className="param-label">{t('modals.goalType')}</label>
              <select
                className="input-field"
                value={newGoalType}
                onChange={e => setNewGoalType(e.target.value)}
                disabled={!!editingGoal}
                style={editingGoal ? { opacity: 0.6 } : undefined}
              >
                {GOAL_TYPES.map(gt => (
                  <option key={gt.value} value={gt.value}>{gt.label}</option>
                ))}
              </select>
            </div>

            {currentGoalConfig?.inputType === 'distance' && (
              <div className="modal-field">
                <label className="param-label">{t('modals.value')}</label>
                <div className="distance-input-row">
                  <input
                    type="number"
                    className="input-field"
                    placeholder={t('modals.value')}
                    value={newGoalTarget}
                    onChange={e => setNewGoalTarget(e.target.value)}
                  />
                  <select
                    className="input-field unit-select"
                    value={newGoalUnit}
                    onChange={e => setNewGoalUnit(e.target.value as 'km' | 'm')}
                  >
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
                  <input
                    type="number"
                    className="input-field time-input"
                    placeholder={t('units.h')}
                    min="0"
                    max="23"
                    value={timeHours}
                    onChange={e => setTimeHours(e.target.value)}
                  />
                  <span className="time-separator">:</span>
                  <input
                    type="number"
                    className="input-field time-input"
                    placeholder={t('units.min')}
                    min="0"
                    max="59"
                    value={timeMinutes}
                    onChange={e => setTimeMinutes(e.target.value)}
                  />
                  <span className="time-separator">:</span>
                  <input
                    type="number"
                    className="input-field time-input"
                    placeholder={t('units.sec')}
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
                <label className="param-label">{t('modals.quantity')}</label>
                <input
                  type="number"
                  className="input-field"
                  placeholder={t('modals.quantity')}
                  value={newGoalTarget}
                  onChange={e => setNewGoalTarget(e.target.value)}
                />
              </div>
            )}

            <div className={`deadline-field${['monthly_distance', 'weekly_distance', 'monthly_runs'].includes(newGoalType) ? ' deadline-hidden' : ''}`}>
              <div className="modal-field">
                <label className="param-label">{t('modals.deadlineOptional')}</label>
                <input
                  type="date"
                  className="input-field"
                  value={newGoalDeadline}
                  onChange={e => setNewGoalDeadline(e.target.value)}
                  min={new Date().toISOString().split('T')[0]}
                />
              </div>
            </div>

            <div className="modal-actions">
              <button
                className="btn btn-secondary"
                onClick={closeGoalModal}
              >
                {t('common.cancel')}
              </button>
              <button
                className="btn btn-accent"
                onClick={handleAddGoal}
                disabled={creatingGoal}
              >
                {creatingGoal ? `⏳ ${t('common.saving')}` : `💾 ${t('common.save')}`}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {showRecordModal && ReactDOM.createPortal(
        <div className={`modal-overlay${recordModalClosing ? ' modal-closing' : ''}`} onClick={closeRecordModal}>
          <div className={`modal-content${recordModalClosing ? ' modal-content-closing' : ''}`} onClick={e => e.stopPropagation()}>
            <h3 className="modal-title">{editingRecord ? t('profile.editRecord') : t('profile.addRecord')}</h3>

            <div className="modal-field">
              <label className="param-label">{t('modals.distanceLabel')}</label>
              <select
                className="input-field"
                value={recordType}
                onChange={e => setRecordType(e.target.value)}
                disabled={!!editingRecord}
                style={editingRecord ? { opacity: 0.6 } : undefined}
              >
                {RECORD_TYPES.map(rt => (
                  <option key={rt.key} value={rt.key}>{rt.label}</option>
                ))}
              </select>
            </div>

            <div className="modal-field">
              <label className="param-label">{t('modals.timePlaceholder')}</label>
              <div className="time-input-row">
                <input
                  type="number"
                  className="input-field time-input"
                  placeholder={t('units.h')}
                  min="0"
                  max="23"
                  value={recordHours}
                  onChange={e => setRecordHours(e.target.value)}
                />
                <span className="time-separator">:</span>
                <input
                  type="number"
                  className="input-field time-input"
                  placeholder={t('units.min')}
                  min="0"
                  max="59"
                  value={recordMinutes}
                  onChange={e => setRecordMinutes(e.target.value)}
                />
                <span className="time-separator">:</span>
                <input
                  type="number"
                  className="input-field time-input"
                  placeholder={t('units.sec')}
                  min="0"
                  max="59"
                  value={recordSeconds}
                  onChange={e => setRecordSeconds(e.target.value)}
                />
              </div>
            </div>

            <div className="modal-field">
              <label className="param-label">{t('modals.dateOptional')}</label>
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
                {t('common.cancel')}
              </button>
              <button
                className="btn btn-accent"
                onClick={handleAddRecord}
                disabled={savingRecord}
              >
                {savingRecord ? `⏳ ${t('common.saving')}` : `💾 ${t('common.save')}`}
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
              <h3>{t('home.widgetSettings')}</h3>
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
                      <span className="widget-settings-label">{t(metric.labelKey)}</span>
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
              {t('home.saveCount', { count: tempWidgets.length })}
            </button>
          </div>
        </div>
      )}

      {breakdownData && ReactDOM.createPortal(
        <div
          className={`modal-overlay${breakdownClosing ? ' modal-closing' : ''}`}
          onClick={() => {
            setBreakdownClosing(true);
            setTimeout(() => { setBreakdownData(null); setBreakdownClosing(false); }, 300);
          }}
        >
          <div
            className={`modal-content breakdown-modal${breakdownClosing ? ' modal-content-closing' : ''}`}
            onClick={e => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3>{t('profile.breakdownTitle')}</h3>
              <button className="btn-icon" onClick={() => {
                setBreakdownClosing(true);
                setTimeout(() => { setBreakdownData(null); setBreakdownClosing(false); }, 300);
              }}>✕</button>
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
                <div className="breakdown-section-title">
                  {t('profile.breakdownRiegel', { period: breakdownData.period })}
                </div>
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
                <div className="breakdown-note">
                  {t('profile.breakdownTop3')}
                </div>
              </div>
            )}

            {!breakdownData.riegelWorkouts?.length && !breakdownData.bestEffort && (
              <div className="breakdown-section">
                <p>{t('profile.breakdownNoData')}</p>
              </div>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

export default Profile;
