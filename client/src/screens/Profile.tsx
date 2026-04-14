import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import { useTranslation } from 'react-i18next';
import './Profile.css';
import MetricCard from '../components/MetricCard';
import { workouts, strava, profile as profileApi, promo as promoApi } from '../api/api';
import { formatPace, formatDistance } from '../utils';
import { ALL_METRICS, getProfileWidgets, saveProfileWidgets } from '../config/metrics';
import GoalsSection from './profile/GoalsSection';
import RecordsSection from './profile/RecordsSection';
import PaceZonesSection from './profile/PaceZonesSection';
import SettingsModal from './profile/SettingsModal';

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
  onWorkoutClick?: (id: string) => void;
  isActive?: boolean;
}

function readCache<T>(key: string): T | null {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function writeCache(key: string, data: any) {
  try { localStorage.setItem(key, JSON.stringify(data)); } catch {}
}

const Profile: React.FC<ProfileProps> = ({ onLogout, onWorkoutClick, isActive }) => {
  const { t } = useTranslation();
  const cached = readCache<{ stats: any; goals: Goal[]; predictions: any[]; syncStatus: any; profile: any; records: PersonalRecord[] }>('rw_profile_cache');
  const [allTimeStats, setAllTimeStats] = useState<any>(cached?.stats || null);
  const [goals, setGoals] = useState<Goal[]>(cached?.goals || []);
  const [loading, setLoading] = useState(!cached);
  const [syncStatus, setSyncStatus] = useState<any>(cached?.syncStatus || null);
  const [predictions, setPredictions] = useState<any[]>(cached?.predictions || []);
  const [records, setRecords] = useState<PersonalRecord[]>(cached?.records || []);

  // Physical params state
  const [gender, setGender] = useState<string | null>(cached?.profile?.gender || null);
  const [age, setAge] = useState(cached?.profile?.age?.toString() || '');
  const [height, setHeight] = useState(cached?.profile?.height_cm?.toString() || '');
  const [weight, setWeight] = useState(cached?.profile?.weight_kg?.toString() || '');
  const [savingProfile, setSavingProfile] = useState(false);
  const [showParamsModal, setShowParamsModal] = useState(false);
  const [paramsModalClosing, setParamsModalClosing] = useState(false);

  // Settings modal
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [premiumStatus, setPremiumStatus] = useState<{ isPremium: boolean; isLifetime: boolean; premiumUntil: string | null } | null>(null);

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
      const [statsData, goalsData, syncData, predsData, profileData, recordsData, promoData] = await Promise.allSettled([
        workouts.stats('all'),
        workouts.getGoals(),
        strava.syncStatus(),
        workouts.goalPredictions(),
        profileApi.get(),
        profileApi.getRecords(),
        promoApi.status()
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
      if (promoData.status === 'fulfilled') {
        setPremiumStatus(promoData.value);
      }
      writeCache('rw_profile_cache', cacheObj);
    } catch (err) {
      console.error('Failed to load profile:', err);
    } finally {
      setLoading(false);
    }
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

  const closeParamsModal = () => {
    setParamsModalClosing(true);
    setTimeout(() => {
      setShowParamsModal(false);
      setParamsModalClosing(false);
    }, 1000);
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
        <button className="btn btn-accent btn-full" onClick={() => setShowParamsModal(true)}>
          ✏️ {(age || height || weight) ? t('common.edit') : t('profile.setParams')}
        </button>
      </div>

      <PaceZonesSection onWorkoutClick={onWorkoutClick} />

      <RecordsSection records={records} setRecords={setRecords} />

      <GoalsSection goals={goals} setGoals={setGoals} predictions={predictions} setPredictions={setPredictions} />

      <div className="profile-footer">
        <p>{t('profile.version')}</p>
      </div>

      <SettingsModal
        show={showSettingsModal}
        syncStatus={syncStatus}
        premiumStatus={premiumStatus}
        setPremiumStatus={setPremiumStatus}
        onClose={() => setShowSettingsModal(false)}
        onLogout={onLogout}
      />

      {showParamsModal && ReactDOM.createPortal(
        <div className={`modal-overlay${paramsModalClosing ? ' modal-closing' : ''}`} onClick={closeParamsModal}>
          <div className={`modal-content${paramsModalClosing ? ' modal-content-closing' : ''}`} onClick={e => e.stopPropagation()}>
            <h3 className="modal-title">{t('profile.physicalParams')}</h3>

            <div className="modal-field">
              <label className="param-label">{t('profile.gender')}</label>
              <div className="gender-selector">
                <button className={`gender-btn${gender === 'male' ? ' active' : ''}`} onClick={() => setGender(gender === 'male' ? null : 'male')}>
                  ♂ {t('profile.gender_male')}
                </button>
                <button className={`gender-btn${gender === 'female' ? ' active' : ''}`} onClick={() => setGender(gender === 'female' ? null : 'female')}>
                  ♀ {t('profile.gender_female')}
                </button>
              </div>
            </div>

            <div className="modal-field">
              <label className="param-label">{t('profile.age')}</label>
              <div className="param-input-wrap">
                <input type="number" className="input-field" placeholder="25" value={age} onChange={e => setAge(e.target.value)} min="10" max="99" />
                <span className="param-unit">{t('units.years')}</span>
              </div>
            </div>

            <div className="modal-field">
              <label className="param-label">{t('profile.height')}</label>
              <div className="param-input-wrap">
                <input type="number" className="input-field" placeholder="175" value={height} onChange={e => setHeight(e.target.value)} min="100" max="250" />
                <span className="param-unit">{t('units.cm')}</span>
              </div>
            </div>

            <div className="modal-field">
              <label className="param-label">{t('profile.weight')}</label>
              <div className="param-input-wrap">
                <input type="number" className="input-field" placeholder="70" value={weight} onChange={e => setWeight(e.target.value)} min="30" max="250" step="0.1" />
                <span className="param-unit">{t('units.kg')}</span>
              </div>
            </div>

            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={closeParamsModal}>{t('common.cancel')}</button>
              <button className="btn btn-accent" onClick={handleSaveProfile} disabled={savingProfile}>
                {savingProfile ? `⏳ ${t('common.saving')}` : `💾 ${t('common.save')}`}
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
                  <div key={metric.id} className={`widget-settings-item ${isSelected ? 'active' : ''}`}>
                    <label className="widget-settings-toggle">
                      <input type="checkbox" checked={isSelected} onChange={() => toggleWidgetMetric(metric.id)} />
                      <span className="widget-settings-icon">{metric.icon}</span>
                      <span className="widget-settings-label">{t(metric.labelKey)}</span>
                    </label>
                  </div>
                );
              })}
            </div>

            <button className="btn btn-accent widget-settings-save" onClick={saveWidgetSettings} disabled={tempWidgets.length === 0}>
              {t('home.saveCount', { count: tempWidgets.length })}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default Profile;
