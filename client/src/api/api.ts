// API URL: uses env variable in production, localhost for dev
const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001';

function getToken(): string | null {
  return localStorage.getItem('runwise_token');
}

async function request(endpoint: string, options: RequestInit = {}): Promise<any> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {})
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers
  });

  if (response.status === 401) {
    localStorage.removeItem('runwise_token');
    window.location.href = '/';
    throw new Error('Unauthorized');
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }

  return response.json();
}

// ============ AUTH ============

export const auth = {
  getStravaUrl: () => request('/api/auth/strava'),
  callback: (code: string) => request('/api/auth/callback', {
    method: 'POST',
    body: JSON.stringify({ code })
  }),
  me: () => request('/api/auth/me')
};

// ============ STRAVA ============

export const strava = {
  sync: () => request('/api/strava/sync', { method: 'POST' }),
  syncAll: () => request('/api/strava/sync-all', { method: 'POST' }),
  syncSplits500: (workoutId: string) => request(`/api/strava/sync-splits-500/${workoutId}`, { method: 'POST' }),
  syncStatus: () => request('/api/strava/sync-status')
};

// ============ WORKOUTS ============

export const workouts = {
  list: (params?: { month?: number; year?: number; limit?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.month) searchParams.set('month', params.month.toString());
    if (params?.year) searchParams.set('year', params.year.toString());
    if (params?.limit) searchParams.set('limit', params.limit.toString());
    const qs = searchParams.toString();
    return request(`/api/workouts${qs ? `?${qs}` : ''}`);
  },
  get: (id: string) => request(`/api/workouts/${id}`),
  stats: (period: 'week' | 'month' | 'all') => request(`/api/workouts/stats?period=${period}`),
  weekly: () => {
    const tz = -(new Date().getTimezoneOffset() / 60);
    return request(`/api/workouts/weekly?tz=${tz}`);
  },
  getGoals: () => request('/api/workouts/goals/list'),
  createGoal: (type: string, targetValue: number, deadline?: string) => request('/api/workouts/goals', {
    method: 'POST',
    body: JSON.stringify({ type, target_value: targetValue, deadline: deadline || null })
  }),
  updateGoal: (id: string, targetValue: number, deadline?: string) => request(`/api/workouts/goals/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ target_value: targetValue, deadline: deadline || null })
  }),
  deleteGoal: (id: string) => request(`/api/workouts/goals/${id}`, { method: 'DELETE' }),
  goalPredictions: () => request('/api/workouts/goals/predictions'),
  comparison: () => request('/api/workouts/comparison')
};

// ============ PROFILE ============

export const profile = {
  get: () => request('/api/profile'),
  update: (data: { age?: number | null; height_cm?: number | null; weight_kg?: number | null }) =>
    request('/api/profile', { method: 'PUT', body: JSON.stringify(data) }),
  getRecords: () => request('/api/profile/records'),
  updateRecord: (data: { distance_type: string; time_seconds: number; record_date?: string }) =>
    request('/api/profile/records', { method: 'PUT', body: JSON.stringify(data) }),
  deleteRecord: (type: string) =>
    request(`/api/profile/records/${type}`, { method: 'DELETE' }),
};

// ============ AI ============

export const ai = {
  chat: (message: string) => request('/api/ai/chat', {
    method: 'POST',
    body: JSON.stringify({ message })
  }),
  chatStream: async (
    message: string,
    onChunk: (text: string) => void,
    onDone: (meta: { planUpdated: boolean }) => void
  ): Promise<void> => {
    const token = getToken();
    const response = await fetch(`${API_URL}/api/ai/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ message })
    });

    if (response.status === 401) {
      localStorage.removeItem('runwise_token');
      window.location.href = '/';
      throw new Error('Unauthorized');
    }

    if (!response.ok) {
      throw new Error('Stream request failed');
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let done = false;

    while (!done) {
      const { value, done: readerDone } = await reader.read();
      done = readerDone;

      if (value) {
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const payload = trimmed.slice(6);
          if (payload === '[DONE]') continue;

          try {
            const json = JSON.parse(payload);
            if (json.meta) {
              onDone(json.meta);
              continue;
            }
            const content = json.choices?.[0]?.delta?.content;
            if (content) {
              onChunk(content);
            }
          } catch {
            // Not valid JSON, skip
          }
        }
      }
    }
  },
  chatHistory: () => request('/api/ai/chat/history'),
  clearChatHistory: () => request('/api/ai/chat/history', { method: 'DELETE' }),
  analyzeWorkout: (workoutId: string) => request('/api/ai/analyze-workout', {
    method: 'POST',
    body: JSON.stringify({ workoutId })
  }),
  generatePlan: () => request('/api/ai/generate-plan', { method: 'POST' }),
  getPlan: () => request('/api/ai/plan'),
  weeklyAnalysis: () => request('/api/ai/weekly-analysis', { method: 'POST' })
};
