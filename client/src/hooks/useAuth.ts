import { useState, useEffect, useCallback } from 'react';
import { auth, strava } from '../api/api';

interface User {
  id: string;
  strava_id: string;
  created_at: string;
}

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  const checkAuth = useCallback(async () => {
    const token = localStorage.getItem('runwise_token');
    if (!token) {
      setLoading(false);
      return;
    }

    try {
      const data = await auth.me();
      setUser(data.user);
      setIsAuthenticated(true);
    } catch {
      localStorage.removeItem('runwise_token');
      setIsAuthenticated(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  const loginWithStrava = async () => {
    try {
      const data = await auth.getStravaUrl();
      window.location.href = data.url;
    } catch (err) {
      console.error('Failed to get Strava URL:', err);
    }
  };

  const handleCallback = async (code: string): Promise<boolean> => {
    try {
      const data = await auth.callback(code);
      localStorage.setItem('runwise_token', data.token);
      setUser(data.user);
      setIsAuthenticated(true);

      // Initial sync
      if (data.isNewUser) {
        try {
          await strava.sync();
          strava.syncAll(); // background, don't await
        } catch (e) {
          console.error('Initial sync error:', e);
        }
      }

      return true;
    } catch (err) {
      console.error('Callback error:', err);
      return false;
    }
  };

  const logout = () => {
    localStorage.removeItem('runwise_token');
    setUser(null);
    setIsAuthenticated(false);
  };

  return {
    user,
    loading,
    isAuthenticated,
    loginWithStrava,
    handleCallback,
    logout
  };
}
