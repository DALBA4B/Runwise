import React, { useState } from 'react';
import ReactDOM from 'react-dom';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { profile as profileApi } from '../../api/api';
import './RecordsSection.css';

interface PersonalRecord {
  id: string;
  distance_type: string;
  time_seconds: number;
  record_date: string | null;
  source: string;
}

const LOCALE_MAP: Record<string, string> = { ru: 'ru-RU', uk: 'uk-UA', en: 'en-US' };

interface RecordsSectionProps {
  records: PersonalRecord[];
  setRecords: React.Dispatch<React.SetStateAction<PersonalRecord[]>>;
}

const RecordsSection: React.FC<RecordsSectionProps> = ({ records, setRecords }) => {
  const { t } = useTranslation();

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

  const RECORD_TYPES = [
    { key: '1km', label: t('recordTypes.1km') },
    { key: '3km', label: t('recordTypes.3km') },
    { key: '5km', label: t('recordTypes.5km') },
    { key: '10km', label: t('recordTypes.10km') },
    { key: '21km', label: t('recordTypes.21km') },
    { key: '42km', label: t('recordTypes.42km') },
  ];

  const formatRecordTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return h > 0
      ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
      : `${m}:${s.toString().padStart(2, '0')}`;
  };

  const closeRecordModal = () => {
    setRecordModalClosing(true);
    setTimeout(() => {
      setShowRecordModal(false);
      setRecordModalClosing(false);
      setEditingRecord(null);
    }, 1000);
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
      setRecordModalClosing(true);
      setRecordHours('');
      setRecordMinutes('');
      setRecordSeconds('');
      setRecordDate('');
      setEditingRecord(null);
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

  return (
    <>
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
                      <button className="goal-edit-btn" onClick={() => openEditRecord(record)} title={t('profile.editRecord')}>✏️</button>
                      <button className="goal-delete-btn" onClick={() => handleDeleteRecord(record.distance_type)} title={t('common.delete')}>✕</button>
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

        <button className="btn btn-outline btn-full" onClick={() => setShowRecordModal(true)}>
          ➕ {t('profile.addRecord')}
        </button>
      </div>

      {showRecordModal && ReactDOM.createPortal(
        <div className={`modal-overlay${recordModalClosing ? ' modal-closing' : ''}`} onClick={closeRecordModal}>
          <div className={`modal-content${recordModalClosing ? ' modal-content-closing' : ''}`} onClick={e => e.stopPropagation()}>
            <h3 className="modal-title">{editingRecord ? t('profile.editRecord') : t('profile.addRecord')}</h3>

            <div className="modal-field">
              <label className="param-label">{t('modals.distanceLabel')}</label>
              <select className="input-field" value={recordType} onChange={e => setRecordType(e.target.value)} disabled={!!editingRecord} style={editingRecord ? { opacity: 0.6 } : undefined}>
                {RECORD_TYPES.map(rt => (<option key={rt.key} value={rt.key}>{rt.label}</option>))}
              </select>
            </div>

            <div className="modal-field">
              <label className="param-label">{t('modals.timePlaceholder')}</label>
              <div className="time-input-row">
                <input type="number" className="input-field time-input" placeholder={t('units.h')} min="0" max="23" value={recordHours} onChange={e => setRecordHours(e.target.value)} />
                <span className="time-separator">:</span>
                <input type="number" className="input-field time-input" placeholder={t('units.min')} min="0" max="59" value={recordMinutes} onChange={e => setRecordMinutes(e.target.value)} />
                <span className="time-separator">:</span>
                <input type="number" className="input-field time-input" placeholder={t('units.sec')} min="0" max="59" value={recordSeconds} onChange={e => setRecordSeconds(e.target.value)} />
              </div>
            </div>

            <div className="modal-field">
              <label className="param-label">{t('modals.dateOptional')}</label>
              <input type="date" className="input-field" value={recordDate} onChange={e => setRecordDate(e.target.value)} max={new Date().toISOString().split('T')[0]} />
            </div>

            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={closeRecordModal}>{t('common.cancel')}</button>
              <button className="btn btn-accent" onClick={handleAddRecord} disabled={savingRecord}>
                {savingRecord ? `⏳ ${t('common.saving')}` : `💾 ${t('common.save')}`}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
};

export default RecordsSection;
