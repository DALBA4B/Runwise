import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from './hooks/useAuth';
import Login from './screens/Login';
import ConsentScreen from './screens/ConsentScreen';
import PrivacyPolicy from './screens/PrivacyPolicy';
import Home from './screens/Home';
import History from './screens/History';
import Plan from './screens/Plan';
import AIChat from './screens/AIChat';
import Profile from './screens/Profile';
import WorkoutDetail from './screens/WorkoutDetail';
import MacroPlanView from './components/MacroPlanView';
import AdminPanel from './screens/AdminPanel';
import Diagnostics from './screens/Diagnostics';
import './App.css';

type Screen = 'home' | 'history' | 'plan' | 'ai' | 'profile' | 'workout-detail' | 'macro-plan';

const SCREEN_ORDER: Record<string, number> = {
  home: 0,
  history: 1,
  plan: 2,
  ai: 3,
  profile: 4,
  'workout-detail': 5,
  'macro-plan': 2.5
};

const App: React.FC = () => {
  const { t } = useTranslation();
  const { isAuthenticated, loading, loginWithStrava, handleCallback, logout } = useAuth();
  const [currentScreen, setCurrentScreen] = useState<Screen>('home');
  const [showConsent, setShowConsent] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [selectedWorkoutId, setSelectedWorkoutId] = useState<string | null>(null);
  const [screenBeforeDetail, setScreenBeforeDetail] = useState<Screen>('history');
  const [lastPlanScreen, setLastPlanScreen] = useState<Screen>('plan');
  const [returnToVdotModal, setReturnToVdotModal] = useState(false);
  const cameFromVdotRef = useRef(false);
  const [animating, setAnimating] = useState(false);
  const [animClass, setAnimClass] = useState('screen-enter');
  const prevScreenRef = useRef<Screen>('home');
  const appContainerRef = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef<Record<string, number>>({});

  const [macroPlan, setMacroPlan] = useState<any>(() => {
    try { const raw = localStorage.getItem('rw_macro_plan_cache'); return raw ? JSON.parse(raw) : null; } catch { return null; }
  });
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

  // Admin panel — accessible via /admin path, no auth required
  if (window.location.pathname === '/admin') {
    return <AdminPanel />;
  }

  // Diagnostics panel — accessible via /diagnostics path (requires auth)
  if (window.location.pathname === '/diagnostics') {
    if (!isAuthenticated) {
      return (
        <div className="screen" style={{ textAlign: 'center', paddingTop: 60 }}>
          <p>Login required</p>
        </div>
      );
    }
    return <Diagnostics />;
  }

  if (loading) {
    return (
      <div className="app-loading">
        <div className="loader"></div>
        <p>{t('common.loading')}</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    if (showPrivacy) {
      return <PrivacyPolicy onBack={() => setShowPrivacy(false)} />;
    }
    if (showConsent) {
      return (
        <ConsentScreen
          onAccept={() => {
            setShowConsent(false);
            loginWithStrava();
          }}
          onCancel={() => setShowConsent(false)}
          onPrivacyPolicy={() => setShowPrivacy(true)}
        />
      );
    }
    return <Login onLogin={() => setShowConsent(true)} />;
  }

  const handleWorkoutClick = (id: string) => {
    setScreenBeforeDetail(currentScreen);
    cameFromVdotRef.current = false;
    setSelectedWorkoutId(id);
    navigateTo('workout-detail');
  };

  const handleVdotWorkoutClick = (id: string) => {
    setScreenBeforeDetail('profile');
    cameFromVdotRef.current = true;
    setSelectedWorkoutId(id);
    navigateTo('workout-detail');
  };

  const navigateTo = (screen: Screen) => {
    if (screen === currentScreen) return;

    const prevOrder = SCREEN_ORDER[currentScreen] ?? 0;
    const nextOrder = SCREEN_ORDER[screen] ?? 0;
    const direction = nextOrder > prevOrder ? 'slide-left' : 'slide-right';

    // Save scroll position of current screen
    if (appContainerRef.current) {
      scrollPositions.current[currentScreen] = appContainerRef.current.scrollTop;
    }

    setAnimClass(`screen-exit-${direction}`);
    setAnimating(true);

    setTimeout(() => {
      prevScreenRef.current = currentScreen;
      setCurrentScreen(screen);
      if (screen === 'plan' || screen === 'macro-plan') {
        setLastPlanScreen(screen);
      }
      setAnimClass(`screen-enter-${direction}`);

      // Restore scroll position of target screen
      requestAnimationFrame(() => {
        if (appContainerRef.current) {
          appContainerRef.current.scrollTop = scrollPositions.current[screen] || 0;
        }
      });

      setTimeout(() => {
        setAnimClass('');
        setAnimating(false);
      }, 250);
    }, 150);
  };

  const handleNavigate = (screen: any) => {
    if (screen === 'macro-plan') {
      // Refresh macroPlan from cache before navigating
      try {
        const raw = localStorage.getItem('rw_macro_plan_cache');
        if (raw) setMacroPlan(JSON.parse(raw));
      } catch {}
    }
    navigateTo(screen as Screen);
  };

  const handleBackFromDetail = () => {
    setSelectedWorkoutId(null);
    if (cameFromVdotRef.current) {
      setReturnToVdotModal(true);
      cameFromVdotRef.current = false;
    }
    navigateTo(screenBeforeDetail);
  };

  return (
    <div className="app">
      <div className={`app-container ${animClass}`} ref={appContainerRef}>
        <div style={{ display: currentScreen === 'home' ? 'block' : 'none', width: '100%', maxWidth: 420 }}>
          <Home onWorkoutClick={handleWorkoutClick} onNavigate={handleNavigate} isActive={currentScreen === 'home'} />
        </div>
        <div style={{ display: currentScreen === 'history' ? 'block' : 'none', width: '100%', maxWidth: 420 }}>
          <History onWorkoutClick={handleWorkoutClick} isActive={currentScreen === 'history'} />
        </div>
        <div style={{ display: currentScreen === 'plan' ? 'block' : 'none', width: '100%', maxWidth: 420 }}>
          <Plan isActive={currentScreen === 'plan'} onNavigate={handleNavigate} />
        </div>
        <div style={{ display: currentScreen === 'ai' ? 'block' : 'none', width: '100%', maxWidth: 420 }}>
          <AIChat onWorkoutClick={handleWorkoutClick} isActive={currentScreen === 'ai'} />
        </div>
        <div style={{ display: currentScreen === 'profile' ? 'block' : 'none', width: '100%', maxWidth: 420 }}>
          <Profile onLogout={logout} onWorkoutClick={handleWorkoutClick} onVdotWorkoutClick={handleVdotWorkoutClick} isActive={currentScreen === 'profile'} openVdotModal={returnToVdotModal} onVdotModalOpened={() => setReturnToVdotModal(false)} />
        </div>
        {macroPlan && (
          <div style={{ display: currentScreen === 'macro-plan' ? 'block' : 'none', width: '100%', maxWidth: 420 }}>
            <MacroPlanView macroPlan={macroPlan} onBack={() => navigateTo('plan')} />
          </div>
        )}
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
          className={`nav-item ${currentScreen === 'plan' || currentScreen === 'macro-plan' ? 'active' : ''}`}
          onClick={() => handleNavigate(lastPlanScreen)}
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
