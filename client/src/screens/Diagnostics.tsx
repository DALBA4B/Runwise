import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import './Diagnostics.css';
import { ai } from '../api/api';

interface DiagStep {
  title: string;
  detail: string;
  formula?: string;
  status: 'ok' | 'warning' | 'error' | 'info';
}

interface DiagSection {
  id: string;
  title: string;
  result: string;
  status: 'ok' | 'warning' | 'error' | 'info';
  steps: DiagStep[];
}

interface DiagData {
  sections: DiagSection[];
  generatedAt: string;
}

const Diagnostics: React.FC = () => {
  const { t } = useTranslation();
  const [data, setData] = useState<DiagData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openSections, setOpenSections] = useState<Set<string>>(new Set());

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await ai.getDiagnostics();
      setData(result);
      // Auto-open sections with errors/warnings
      const autoOpen = new Set<string>();
      for (const s of result.sections) {
        if (s.status === 'error' || s.status === 'warning') {
          autoOpen.add(s.id);
        }
      }
      setOpenSections(autoOpen);
    } catch (err: any) {
      setError(err.message || 'Failed to load diagnostics');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  const toggleSection = (id: string) => {
    setOpenSections(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (loading && !data) {
    return (
      <div className="screen diagnostics-screen">
        <div className="screen-loading">
          <div className="loader"></div>
          <p>{t('common.loading')}</p>
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="screen diagnostics-screen">
        <p className="empty-text">{error}</p>
        <button className="btn btn-accent" onClick={loadData}>{t('common.retry') || 'Retry'}</button>
      </div>
    );
  }

  return (
    <div className="screen diagnostics-screen">
      <div className="diagnostics-header">
        <h2>{t('diagnostics.title')}</h2>
      </div>

      {data?.generatedAt && (
        <div className="diagnostics-timestamp">
          {t('diagnostics.generatedAt')}: {new Date(data.generatedAt).toLocaleString()}
        </div>
      )}

      <button className="diag-refresh" onClick={loadData} disabled={loading}>
        {loading ? t('common.loading') : t('diagnostics.refresh')}
      </button>

      {data?.sections.map(section => {
        const isOpen = openSections.has(section.id);
        return (
          <div key={section.id} className={`diag-section ${isOpen ? 'open' : ''}`}>
            <div className="diag-section-header" onClick={() => toggleSection(section.id)}>
              <div className={`diag-section-status diag-status-${section.status}`} />
              <span className="diag-section-title">{section.title}</span>
              <span className="diag-section-result">{section.result}</span>
              <span className="diag-section-chevron">›</span>
            </div>

            {isOpen && (
              <div className="diag-steps">
                {section.steps.map((step, i) => (
                  <div key={i} className="diag-step">
                    <div className="diag-step-timeline">
                      <div className={`diag-step-dot diag-status-${step.status}`} />
                      <div className="diag-step-line" />
                    </div>
                    <div className="diag-step-content">
                      <div className="diag-step-title">{step.title}</div>
                      <div className="diag-step-detail">{step.detail}</div>
                      {step.formula && (
                        <span className="diag-step-formula">{step.formula}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default Diagnostics;
