import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { promo } from '../api/api';

interface PromoCode {
  id: string;
  code: string;
  duration_days: number | null;
  max_uses: number;
  uses_count: number;
  is_active: boolean;
  created_at: string;
}

interface Activation {
  id: string;
  activated_at: string;
  expires_at: string | null;
  user_id: string;
  users: { strava_id: string } | null;
  promo_codes: { code: string; duration_days: number | null } | null;
}

const AdminPanel: React.FC = () => {
  const { t } = useTranslation();
  const [secret, setSecret] = useState(localStorage.getItem('rw_admin_secret') || '');
  const [authenticated, setAuthenticated] = useState(false);
  const [codes, setCodes] = useState<PromoCode[]>([]);
  const [activations, setActivations] = useState<Activation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Create form
  const [newCode, setNewCode] = useState('');
  const [newDays, setNewDays] = useState('');
  const [newMaxUses, setNewMaxUses] = useState('1');
  const [creating, setCreating] = useState(false);

  const [activeTab, setActiveTab] = useState<'codes' | 'activations'>('codes');

  const loadData = async (s: string) => {
    setLoading(true);
    setError('');
    try {
      const [codesData, activationsData] = await Promise.all([
        promo.adminList(s),
        promo.adminActivations(s)
      ]);
      setCodes(codesData);
      setActivations(activationsData);
      setAuthenticated(true);
      localStorage.setItem('rw_admin_secret', s);
    } catch {
      if (!authenticated) {
        setError('Invalid admin secret');
        localStorage.removeItem('rw_admin_secret');
      } else {
        setError('Failed to load data');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async () => {
    if (!secret.trim()) return;
    loadData(secret.trim());
  };

  useEffect(() => {
    const saved = localStorage.getItem('rw_admin_secret');
    if (saved) {
      setSecret(saved);
      loadData(saved);
    }
  }, []);

  const handleCreate = async () => {
    if (!newCode.trim()) return;
    setCreating(true);
    try {
      await promo.adminCreate(secret, {
        code: newCode.trim(),
        duration_days: newDays === '' ? null : Number(newDays),
        max_uses: Number(newMaxUses) || 1
      });
      setNewCode('');
      setNewDays('');
      setNewMaxUses('1');
      loadData(secret);
    } catch (err: any) {
      setError(err.message || 'Failed to create');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Delete this promo code?')) return;
    try {
      await promo.adminDelete(secret, id);
      loadData(secret);
    } catch {
      setError('Failed to delete');
    }
  };

  if (!authenticated) {
    return (
      <div className="admin-panel">
        <div className="admin-login">
          <h2>Admin Panel</h2>
          <input
            type="password"
            className="admin-input"
            placeholder="Admin secret"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
          />
          <button className="btn btn-accent" onClick={handleLogin} disabled={loading}>
            {loading ? '...' : 'Login'}
          </button>
          {error && <div className="admin-error">{error}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="admin-panel">
      <h2>Admin Panel — Promo Codes</h2>

      <div className="admin-tabs">
        <button
          className={`admin-tab ${activeTab === 'codes' ? 'active' : ''}`}
          onClick={() => setActiveTab('codes')}
        >
          Codes ({codes.length})
        </button>
        <button
          className={`admin-tab ${activeTab === 'activations' ? 'active' : ''}`}
          onClick={() => setActiveTab('activations')}
        >
          Activations ({activations.length})
        </button>
      </div>

      {activeTab === 'codes' && (
        <>
          <div className="admin-create-form">
            <h3>Create New Code</h3>
            <div className="admin-form-row">
              <input
                type="text"
                className="admin-input"
                placeholder="Code (e.g. RUNWISE2026)"
                value={newCode}
                onChange={(e) => setNewCode(e.target.value.toUpperCase())}
              />
            </div>
            <div className="admin-form-row">
              <input
                type="number"
                className="admin-input"
                placeholder="Days (empty = lifetime)"
                value={newDays}
                onChange={(e) => setNewDays(e.target.value)}
                min="1"
                max="360"
              />
              <input
                type="number"
                className="admin-input"
                placeholder="Max uses"
                value={newMaxUses}
                onChange={(e) => setNewMaxUses(e.target.value)}
                min="1"
              />
            </div>
            <button className="btn btn-accent" onClick={handleCreate} disabled={creating || !newCode.trim()}>
              {creating ? 'Creating...' : 'Create'}
            </button>
          </div>

          <div className="admin-codes-list">
            {codes.map((c) => (
              <div key={c.id} className="admin-code-item">
                <div className="admin-code-header">
                  <span className="admin-code-text">{c.code}</span>
                  <span className={`admin-code-badge ${c.is_active && c.uses_count < c.max_uses ? 'active' : 'inactive'}`}>
                    {c.is_active && c.uses_count < c.max_uses ? 'Active' : 'Used up'}
                  </span>
                </div>
                <div className="admin-code-details">
                  <span>{c.duration_days === null ? 'Lifetime' : `${c.duration_days} days`}</span>
                  <span>{c.uses_count}/{c.max_uses} uses</span>
                  <span>{new Date(c.created_at).toLocaleDateString()}</span>
                </div>
                <button className="btn btn-danger btn-sm" onClick={() => handleDelete(c.id)}>
                  Delete
                </button>
              </div>
            ))}
            {codes.length === 0 && !loading && (
              <div className="admin-empty">No promo codes yet</div>
            )}
          </div>
        </>
      )}

      {activeTab === 'activations' && (
        <div className="admin-activations-list">
          {activations.map((a) => (
            <div key={a.id} className="admin-activation-item">
              <div className="admin-activation-user">
                User: {a.users?.strava_id || a.user_id.slice(0, 8)}
              </div>
              <div className="admin-activation-details">
                <span>Code: {a.promo_codes?.code || '—'}</span>
                <span>{new Date(a.activated_at).toLocaleString()}</span>
                <span>
                  {a.expires_at
                    ? `Expires: ${new Date(a.expires_at).toLocaleDateString()}`
                    : 'Lifetime'}
                </span>
              </div>
            </div>
          ))}
          {activations.length === 0 && !loading && (
            <div className="admin-empty">No activations yet</div>
          )}
        </div>
      )}

      {error && <div className="admin-error">{error}</div>}
      {loading && <div className="admin-loading">Loading...</div>}
    </div>
  );
};

export default AdminPanel;
