import React from 'react';
import { useTranslation } from 'react-i18next';

interface LoginProps {
  onLogin: () => void;
}

const Login: React.FC<LoginProps> = ({ onLogin }) => {
  const { t } = useTranslation();

  return (
    <div className="login-screen">
      <div className="login-content">
        <div className="login-logo">
          <span className="login-icon">🏃‍♂️</span>
          <h1 className="login-title">Runwise</h1>
          <p className="login-subtitle">{t('login.subtitle')}</p>
        </div>

        <div className="login-features">
          <div className="login-feature">
            <span>📊</span>
            <span>{t('login.featureAnalysis')}</span>
          </div>
          <div className="login-feature">
            <span>🤖</span>
            <span>{t('login.featureAI')}</span>
          </div>
          <div className="login-feature">
            <span>📋</span>
            <span>{t('login.featurePlans')}</span>
          </div>
        </div>

        <button className="strava-btn" onClick={onLogin}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
            <path d="M15.387 17.944l-2.089-4.116h-3.065L15.387 24l5.15-10.172h-3.066m-7.008-5.599l2.836 5.598h4.172L10.463 0l-7 13.828h4.169" />
          </svg>
          {t('login.stravaLogin')}
        </button>

        <p className="login-note">
          {t('login.note')}
        </p>
      </div>
    </div>
  );
};

export default Login;
