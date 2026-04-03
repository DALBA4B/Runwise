import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

interface ConsentScreenProps {
  onAccept: () => void;
  onCancel: () => void;
  onPrivacyPolicy: () => void;
}

const ConsentScreen: React.FC<ConsentScreenProps> = ({ onAccept, onCancel, onPrivacyPolicy }) => {
  const { t } = useTranslation();
  const [agreed, setAgreed] = useState(false);

  return (
    <div className="consent-screen">
      <div className="consent-content">
        <h1 className="consent-title">{t('consent.title')}</h1>

        <div className="consent-sections">
          <div className="consent-section">
            <div className="consent-section-icon">📊</div>
            <div className="consent-section-body">
              <h3>{t('consent.section1Title')}</h3>
              <p>{t('consent.section1Text')}</p>
            </div>
          </div>

          <div className="consent-section">
            <div className="consent-section-icon">🤖</div>
            <div className="consent-section-body">
              <h3>{t('consent.section2Title')}</h3>
              <p>{t('consent.section2Text')}</p>
            </div>
          </div>

          <div className="consent-section">
            <div className="consent-section-icon">🗄️</div>
            <div className="consent-section-body">
              <h3>{t('consent.section3Title')}</h3>
              <p>{t('consent.section3Text')}</p>
            </div>
          </div>
        </div>

        <label className="consent-checkbox-label">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            className="consent-checkbox"
          />
          <span className="consent-checkbox-custom" />
          <span className="consent-checkbox-text">{t('consent.checkbox')}</span>
        </label>

        <button className="consent-privacy-link" onClick={onPrivacyPolicy}>
          {t('consent.privacyLink')}
        </button>

        <div className="consent-buttons">
          <button
            className="consent-btn-next"
            disabled={!agreed}
            onClick={onAccept}
          >
            {t('consent.next')}
          </button>
          <button
            className="consent-btn-cancel"
            onClick={onCancel}
          >
            {t('consent.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConsentScreen;
