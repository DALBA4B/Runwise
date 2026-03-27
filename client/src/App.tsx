import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from './hooks/useAuth';
import Login from './screens/Login';
import Home from './screens/Home';
import History from './screens/History';
import Plan from './screens/Plan';
import AIChat from './screens/AIChat';
import Profile from './screens/Profile';
import WorkoutDetail from './screens/WorkoutDetail';
import './App.css';

type Screen = 'home' | 'history' | 'plan' | 'ai' | 'profile' | 'workout-detail';

const SCREEN_ORDER: Record<string, number> = {
  home: 0,
  history: 1,
  plan: 2,
  ai: 3,
  profile: 4,
  'workout-detail': 5
};

const App: React.FC = () => {
  const { t } = useTranslation();
  const { isAuthenticated, loading, loginWithStrava, handleCallback, logout } = useAuth();
  const [currentScreen, setCurrentScreen] = useState<Screen>('home');
  const [selectedWorkoutId, setSelectedWorkoutId] = useState<string | null>(null);
  const [animating, setAnimating] = useState(false);
  const [animClass, setAnimClass] = useState('screen-enter');
  const prevScreenRef = useRef<Screen>('home');

  const callbackCalledRef = useRef(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const error = params.get('error');

    if (code && !callbackCalledRef.current) {
      callbackCalledRef.current = true;
      window.history.replaceState({}, document.title, window.location.pathname);
      handleCallback(code).then(success => {
        if (success) {
          setCurrentScreen('home');
        }
      });
    } else if (error) {
      console.error('OAuth error:', error);
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, [handleCallback]);

  if (loading) {
    return (
      <div className="app-loading">
        <div className="loader"></div>
        <p>{t('common.loading')}</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Login onLogin={loginWithStrava} />;
  }

  const handleWorkoutClick = (id: string) => {
    setSelectedWorkoutId(id);
    navigateTo('workout-detail');
  };

  const navigateTo = (screen: Screen) => {
    if (screen === currentScreen) return;

    const prevOrder = SCREEN_ORDER[currentScreen] ?? 0;
    const nextOrder = SCREEN_ORDER[screen] ?? 0;
    const direction = nextOrder > prevOrder ? 'slide-left' : 'slide-right';

    setAnimClass(`screen-exit-${direction}`);
    setAnimating(true);

    setTimeout(() => {
      prevScreenRef.current = currentScreen;
      setCurrentScreen(screen);
      setAnimClass(`screen-enter-${direction}`);

      setTimeout(() => {
        setAnimClass('');
        setAnimating(false);
      }, 250);
    }, 150);
  };

  const handleNavigate = (screen: any) => {
    navigateTo(screen as Screen);
  };

  const handleBackFromDetail = () => {
    setSelectedWorkoutId(null);
    navigateTo('history');
  };

  return (
    <div className="app">
      <div className={`app-container ${animClass}`}>
        {currentScreen === 'home' && (
          <Home onWorkoutClick={handleWorkoutClick} onNavigate={handleNavigate} />
        )}
        {currentScreen === 'history' && (
          <History onWorkoutClick={handleWorkoutClick} />
        )}
        {currentScreen === 'plan' && <Plan />}
        {/* AIChat stays mounted so streaming continues when switching tabs */}
        <div style={{ display: currentScreen === 'ai' ? 'contents' : 'none' }}>
          <AIChat />
        </div>
        {currentScreen === 'profile' && <Profile onLogout={logout} />}
        {currentScreen === 'workout-detail' && selectedWorkoutId && (
          <WorkoutDetail workoutId={selectedWorkoutId} onBack={handleBackFromDetail} />
        )}
      </div>

      <nav className="bottom-nav">
        <button
          className={`nav-item ${currentScreen === 'home' ? 'active' : ''}`}
          onClick={() => navigateTo('home')}
        >
          <span className="nav-icon">🏠</span>
          <span className="nav-label">{t('nav.home')}</span>
        </button>
        <button
          className={`nav-item ${currentScreen === 'history' ? 'active' : ''}`}
          onClick={() => navigateTo('history')}
        >
          <span className="nav-icon">📅</span>
          <span className="nav-label">{t('nav.history')}</span>
        </button>
        <button
          className={`nav-item ${currentScreen === 'plan' ? 'active' : ''}`}
          onClick={() => navigateTo('plan')}
        >
          <span className="nav-icon">📋</span>
          <span className="nav-label">{t('nav.plan')}</span>
        </button>
        <button
          className={`nav-item ${currentScreen === 'ai' ? 'active' : ''}`}
          onClick={() => navigateTo('ai')}
        >
          <span className="nav-icon">🤖</span>
          <span className="nav-label">{t('nav.ai')}</span>
        </button>
        <button
          className={`nav-item ${currentScreen === 'profile' ? 'active' : ''}`}
          onClick={() => navigateTo('profile')}
        >
          <span className="nav-icon">👤</span>
          <span className="nav-label">{t('nav.profile')}</span>
        </button>
      </nav>
    </div>
  );
};

export default App;
