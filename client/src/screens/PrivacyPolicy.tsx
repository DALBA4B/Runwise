import React from 'react';
import { useTranslation } from 'react-i18next';
import './ConsentScreen.css';

interface PrivacyPolicyProps {
  onBack: () => void;
}

const PrivacyPolicy: React.FC<PrivacyPolicyProps> = ({ onBack }) => {
  const { t } = useTranslation();

  return (
    <div className="privacy-screen">
      <div className="privacy-header">
        <button className="privacy-back-btn" onClick={onBack}>
          ← {t('common.back')}
        </button>
        <h1 className="privacy-title">{t('privacy.title')}</h1>
      </div>

      <div className="privacy-content">
        <p className="privacy-updated">{t('privacy.lastUpdated')}</p>

        <section className="privacy-section">
          <h2>{t('privacy.s1Title')}</h2>
          <p>{t('privacy.s1Text')}</p>
        </section>

        <section className="privacy-section">
          <h2>{t('privacy.s2Title')}</h2>
          <p>{t('privacy.s2Text')}</p>
          <ul>
            <li>{t('privacy.s2Item1')}</li>
            <li>{t('privacy.s2Item2')}</li>
            <li>{t('privacy.s2Item3')}</li>
            <li>{t('privacy.s2Item4')}</li>
            <li>{t('privacy.s2Item5')}</li>
          </ul>
        </section>

        <section className="privacy-section">
          <h2>{t('privacy.s3Title')}</h2>
          <p>{t('privacy.s3Text')}</p>
          <ul>
            <li>{t('privacy.s3Item1')}</li>
            <li>{t('privacy.s3Item2')}</li>
            <li>{t('privacy.s3Item3')}</li>
          </ul>
        </section>

        <section className="privacy-section">
          <h2>{t('privacy.s4Title')}</h2>
          <p>{t('privacy.s4Text')}</p>
        </section>

        <section className="privacy-section">
          <h2>{t('privacy.s5Title')}</h2>
          <p>{t('privacy.s5Text')}</p>
        </section>

        <section className="privacy-section">
          <h2>{t('privacy.s6Title')}</h2>
          <p>{t('privacy.s6Text')}</p>
        </section>

        <section className="privacy-section">
          <h2>{t('privacy.s7Title')}</h2>
          <p>{t('privacy.s7Text')}</p>
        </section>
      </div>
    </div>
  );
};

export default PrivacyPolicy;
