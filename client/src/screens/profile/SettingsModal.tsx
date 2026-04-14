import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { workouts, strava, promo as promoApi } from '../../api/api';
import './SettingsModal.css';

const LANGUAGES = [
  { code: 'ru', label: '🇷🇺 Русский' },
  { code: 'uk', label: '🇺🇦 Українська' },
  { code: 'en', label: '🇬🇧 English' },
];

interface SettingsModalProps {
  show: boolean;
  syncStatus: any;
  premiumStatus: { isPremium: boolean; isLifetime: boolean; premiumUntil: string | null } | null;
  setPremiumStatus: React.Dispatch<React.SetStateAction<{ isPremium: boolean; isLifetime: boolean; premiumUntil: string | null } | null>>;
  onClose: () => void;
  onLogout: () => void;
}

const SettingsModal: React.FC<SettingsModalProps> = ({ show, syncStatus, premiumStatus, setPremiumStatus, onClose, onLogout }) => {
  const { t } = useTranslation();
  const [closing, setClosing] = useState(false);
  const [promoCode, setPromoCode] = useState('');
  const [promoLoading, setPromoLoading] = useState(false);
  const [promoMessage, setPromoMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [apiUsage, setApiUsage] = useState<{ count: number; limit: number } | null>(null);

  useEffect(() => {
    if (show) {
      strava.rateLimit().then(setApiUsage).catch(() => {});
    }
  }, [show]);

  const closeModal = () => {
    setClosing(true);
    setTimeout(() => {
      setClosing(false);
      onClose();
    }, 1000);
  };

  const handleLanguageChange = (code: string) => {
    i18n.changeLanguage(code);
    localStorage.setItem('runwise_language', code);
  };

  const handleActivatePromo = async () => {
    if (!promoCode.trim()) return;
    setPromoLoading(true);
    setPromoMessage(null);
    try {
      const res = await promoApi.activate(promoCode.trim());
      if (res.is_lifetime) {
        setPromoMessage({ type: 'success', text: t('profile.promoSuccessLifetime') });
      } else {
        setPromoMessage({ type: 'success', text: t('profile.promoSuccess', { days: res.duration_days }) });
      }
      setPremiumStatus({
        isPremium: true,
        isLifetime: res.is_lifetime,
        premiumUntil: res.premium_until || null
      });
      setPromoCode('');
    } catch (err: any) {
      const code = err.message;
      if (code === 'ALREADY_USED') {
        setPromoMessage({ type: 'error', text: t('profile.promoAlreadyUsed') });
      } else if (code === 'USED_UP') {
        setPromoMessage({ type: 'error', text: t('profile.promoUsedUp') });
      } else {
        setPromoMessage({ type: 'error', text: t('profile.promoInvalid') });
      }
    } finally {
      setPromoLoading(false);
    }
  };

  const handleLogout = () => {
    if (window.confirm(t('profile.logoutConfirm'))) {
      closeModal();
      setTimeout(() => onLogout(), 1000);
    }
  };

  if (!show) return null;

  return ReactDOM.createPortal(
    <div className={`modal-overlay${closing ? ' modal-closing' : ''}`} onClick={closeModal}>
      <div className={`modal-content${closing ? ' modal-content-closing' : ''}`} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">{t('profile.settings')}</h3>
          <button className="modal-close-btn" onClick={closeModal}>✕</button>
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

          {apiUsage && (
            <div className="settings-item">
              <div className="settings-item-icon">📡</div>
              <div className="settings-item-info">
                <span className="settings-item-label">{t('profile.stravaApiUsage')}</span>
                <span className="settings-item-status" style={{
                  color: apiUsage.count > apiUsage.limit * 0.8 ? '#ff4444' :
                         apiUsage.count > apiUsage.limit * 0.5 ? '#ffaa00' : 'inherit'
                }}>
                  {apiUsage.count} / {apiUsage.limit}
                </span>
              </div>
            </div>
          )}

          <button
            className="btn btn-secondary btn-full"
            style={{ marginTop: 8 }}
            onClick={async (e) => {
              const btn = e.currentTarget;
              btn.disabled = true;
              btn.textContent = t('profile.syncing');
              try {
                const res = await strava.sync();
                btn.textContent = `${t('profile.syncDone')}: +${res.imported}`;
              } catch {
                btn.textContent = t('profile.syncError');
              }
              setTimeout(() => { btn.disabled = false; btn.textContent = `🔄 ${t('profile.syncButton')}`; }, 3000);
            }}
          >
            🔄 {t('profile.syncButton')}
          </button>

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

        <div className="settings-section">
          <div className="settings-section-title">⭐ {t('profile.promoCode')}</div>

          {premiumStatus?.isPremium && (
            <div className="promo-status">
              {premiumStatus.isLifetime
                ? t('profile.promoLifetime')
                : t('profile.promoActive', { date: new Date(premiumStatus.premiumUntil!).toLocaleDateString() })
              }
            </div>
          )}

          <div className="promo-input-row">
            <input
              type="text"
              className="promo-input"
              placeholder={t('profile.promoPlaceholder')}
              value={promoCode}
              onChange={(e) => setPromoCode(e.target.value.toUpperCase())}
              disabled={promoLoading}
            />
            <button
              className="btn btn-accent promo-btn"
              onClick={handleActivatePromo}
              disabled={promoLoading || !promoCode.trim()}
            >
              {promoLoading ? '...' : t('profile.applyPromo')}
            </button>
          </div>

          {promoMessage && (
            <div className={`promo-message promo-message-${promoMessage.type}`}>
              {promoMessage.text}
            </div>
          )}
        </div>

        <button className="btn btn-danger btn-full" onClick={handleLogout}>
          🚪 {t('profile.logout')}
        </button>
      </div>
    </div>,
    document.body
  );
};

export default SettingsModal;
