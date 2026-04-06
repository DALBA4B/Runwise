import React, { useState, useRef, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { useTranslation } from 'react-i18next';
import ChatMessage from '../components/ChatMessage';
import { ai, profile as profileApi } from '../api/api';
import type { AiPreferences } from '../api/api';

interface Message {
  id: string;
  role: 'user' | 'ai' | 'system';
  content: string;
  timestamp: Date;
}

interface AIChatProps {
  onWorkoutClick?: (id: string) => void;
}

const AIChat: React.FC<AIChatProps> = ({ onWorkoutClick }) => {
  const { t } = useTranslation();

  const QUICK_QUESTIONS = [
    t('chat.q1'),
    t('chat.q2'),
    t('chat.q3'),
    t('chat.q4'),
    t('chat.q5'),
    t('chat.q6'),
  ];

  const WELCOME_MESSAGE: Message = {
    id: '1',
    role: 'ai',
    content: t('chat.welcome'),
    timestamp: new Date()
  };

  const AI_DEFAULTS: AiPreferences = {
    coach_gender: 'male',
    response_length: 'medium',
    personality: 'bro',
    humor: true,
    emoji_level: 'few'
  };

  const [messages, setMessages] = useState<Message[]>([WELCOME_MESSAGE]);
  const [inputValue, setInputValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [updatingPlan, setUpdatingPlan] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [showAiSettings, setShowAiSettings] = useState(false);
  const [aiSettingsClosing, setAiSettingsClosing] = useState(false);
  const [aiPrefs, setAiPrefs] = useState<AiPreferences>(AI_DEFAULTS);
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [messageLimit, setMessageLimit] = useState<{ limit: number; used: number; remaining: number } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);

  const scrollRestoredRef = useRef(false);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Only auto-scroll if user hasn't scrolled up
  useEffect(() => {
    if (!userScrolledUp.current && scrollRestoredRef.current) {
      scrollToBottom();
    }
  }, [messages]);

  // Detect if user scrolled up
  const handleScroll = () => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const threshold = 100;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    userScrolledUp.current = distanceFromBottom > threshold;
  };

  // Always scroll to bottom after history loads
  useEffect(() => {
    if (historyLoaded && messagesContainerRef.current) {
      // Use requestAnimationFrame to ensure DOM has rendered messages
      requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView();
        scrollRestoredRef.current = true;
      });
    }
  }, [historyLoaded]);

  // Load chat history and AI prefs on mount
  useEffect(() => {
    const loadHistory = async () => {
      try {
        const history = await ai.chatHistory();
        if (history && history.length > 0) {
          const loaded: Message[] = [WELCOME_MESSAGE, ...history.map((m: any) => ({
            id: m.id,
            role: m.role as 'user' | 'ai',
            content: m.content,
            timestamp: new Date(m.created_at)
          }))];
          setMessages(loaded);
        }
      } catch (err) {
        console.error('Failed to load chat history:', err);
      } finally {
        setHistoryLoaded(true);
      }
    };
    loadHistory();

    // Load message limit
    ai.chatLimit().then((data: any) => {
      if (data) setMessageLimit(data);
    }).catch(() => {});

    // Load AI preferences
    const cached = localStorage.getItem('runwise_ai_prefs');
    if (cached) {
      try { setAiPrefs({ ...AI_DEFAULTS, ...JSON.parse(cached) }); } catch {}
    }
    profileApi.get().then((data: any) => {
      if (data?.ai_preferences) {
        const prefs = { ...AI_DEFAULTS, ...data.ai_preferences };
        setAiPrefs(prefs);
        localStorage.setItem('runwise_ai_prefs', JSON.stringify(prefs));
      }
    }).catch(() => {});
  }, []);

  const handleClearHistory = async () => {
    if (!window.confirm(t('chat.clearConfirm'))) return;
    try {
      await ai.clearChatHistory();
      setMessages([WELCOME_MESSAGE]);
    } catch (err) {
      console.error('Failed to clear history:', err);
    }
  };

  const handleSendMessage = async (text: string) => {
    if (!text.trim()) return;
    if (messageLimit && messageLimit.remaining <= 0) return;

    // Add user message
    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: text,
      timestamp: new Date()
    };
    setMessages(prev => [...prev, userMessage]);
    setInputValue('');
    setLoading(true);
    userScrolledUp.current = false;

    const aiMessageId = (Date.now() + 1).toString();
    let firstChunk = true;
    let fullContent = '';

    // Strip ===PLAN_UPDATE===...===END_PLAN_UPDATE=== block from displayed text
    const stripPlanBlock = (text: string) => {
      const planStart = text.indexOf('===PLAN_UPDATE===');
      if (planStart === -1) return text;
      const planEnd = text.indexOf('===END_PLAN_UPDATE===');
      if (planEnd !== -1) {
        // Full block found — remove it and keep text before + after
        const before = text.substring(0, planStart);
        const after = text.substring(planEnd + '===END_PLAN_UPDATE==='.length);
        return (before + after).trim();
      }
      // Block started but not closed yet — hide from ===PLAN_UPDATE=== onwards
      return text.substring(0, planStart).trim();
    };

    try {
      // Add empty AI message that will be filled progressively
      const aiMessage: Message = {
        id: aiMessageId,
        role: 'ai',
        content: '',
        timestamp: new Date()
      };
      setMessages(prev => [...prev, aiMessage]);

      await ai.chatStream(
        text,
        (chunk: string) => {
          if (firstChunk) {
            firstChunk = false;
            setLoading(false);
            setThinking(false);
          }
          fullContent += chunk;
          const displayContent = stripPlanBlock(fullContent);
          // Show "updating plan" indicator when plan block starts streaming
          if (fullContent.includes('===PLAN_UPDATE===')) {
            setUpdatingPlan(true);
          }
          setMessages(prev =>
            prev.map(m =>
              m.id === aiMessageId ? { ...m, content: displayContent } : m
            )
          );
        },
        (meta: { planUpdated: boolean }) => {
          setUpdatingPlan(false);
          setThinking(false);
          // Final cleanup: strip plan block from displayed message
          const cleanContent = stripPlanBlock(fullContent);
          setMessages(prev =>
            prev.map(m =>
              m.id === aiMessageId ? { ...m, content: cleanContent } : m
            )
          );
          if (meta.planUpdated) {
            // Clear cached plan so Plan screen fetches fresh data
            try { localStorage.removeItem('rw_plan_cache'); } catch {}
            const systemMsg: Message = {
              id: (Date.now() + 2).toString(),
              role: 'system',
              content: t('chat.planUpdated'),
              timestamp: new Date()
            };
            setMessages(prev => [...prev, systemMsg]);
          }
        },
        () => {
          setThinking(true);
        }
      );
      // Update limit after successful send
      ai.chatLimit().then((data: any) => {
        if (data) setMessageLimit(data);
      }).catch(() => {});
    } catch (err: any) {
      console.error('Chat error:', err);
      const isLimitError = err?.message?.includes('limit') || err?.message?.includes('429');
      setMessages(prev =>
        prev.map(m =>
          m.id === aiMessageId
            ? { ...m, content: isLimitError ? t('chat.limitReached') : t('chat.error') }
            : m
        )
      );
      if (isLimitError) {
        setMessageLimit(prev => prev ? { ...prev, remaining: 0 } : null);
      }
    } finally {
      setLoading(false);
      setUpdatingPlan(false);
      setThinking(false);
    }
  };

  const closeAiSettings = () => {
    setAiSettingsClosing(true);
    setTimeout(() => {
      setShowAiSettings(false);
      setAiSettingsClosing(false);
    }, 1000);
  };

  const handleSaveAiPrefs = async () => {
    setSavingPrefs(true);
    try {
      await profileApi.update({ ai_preferences: aiPrefs });
      localStorage.setItem('runwise_ai_prefs', JSON.stringify(aiPrefs));
      closeAiSettings();
    } catch (err) {
      console.error('Failed to save AI prefs:', err);
    } finally {
      setSavingPrefs(false);
    }
  };

  return (
    <div className="screen ai-chat-screen">
      <div className="chat-header">
        <h2 className="screen-title">🤖 {t('chat.title')}</h2>
        <div className="chat-header-actions">
          <button className="chat-settings-btn" onClick={() => setShowAiSettings(true)} title={t('chat.aiSettings')}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>
          {messages.length > 1 && (
            <button className="clear-chat-btn" onClick={handleClearHistory}>{t('common.clear')}</button>
          )}
        </div>
      </div>

      <div className="chat-container">
        <div className="messages" ref={messagesContainerRef} onScroll={handleScroll}>
          {messages.map(message => (
            <ChatMessage key={message.id} message={message} onWorkoutClick={onWorkoutClick} />
          ))}
          {loading && !thinking && (
            <div className="message ai-message">
              <div className="message-content">
                <div className="typing-indicator">
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
              </div>
            </div>
          )}
          {thinking && (
            <div className="message ai-message">
              <div className="message-content">
                <div className="thinking-indicator">
                  <span className="thinking-spinner"></span>
                  {t('chat.analyzing')}
                </div>
              </div>
            </div>
          )}
          {updatingPlan && (
            <div className="message system-message">
              <div className="message-content plan-updating">
                <span className="plan-updating-spinner"></span>
                📝 {t('chat.updatingPlan')}
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="quick-questions">
          <p className="quick-questions-label">{t('chat.quickQuestions')}</p>
          <div className="quick-questions-grid">
            {QUICK_QUESTIONS.map((question, index) => (
              <button
                key={index}
                className="quick-btn"
                onClick={() => handleSendMessage(question)}
                disabled={loading || (messageLimit !== null && messageLimit.remaining <= 0)}
              >
                {question}
              </button>
            ))}
          </div>
        </div>

        <div className="chat-input-area">
          {messageLimit && messageLimit.remaining <= 0 && (
            <div className="chat-limit-banner">{t('chat.limitReached')}</div>
          )}
          <div className="chat-input-wrapper">
            <input
              type="text"
              className="chat-input"
              placeholder={messageLimit && messageLimit.remaining <= 0 ? t('chat.limitReached') : t('chat.placeholder')}
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !loading && !(messageLimit && messageLimit.remaining <= 0)) {
                  handleSendMessage(inputValue);
                }
              }}
              disabled={loading || (messageLimit !== null && messageLimit.remaining <= 0)}
            />
            <button
              className="chat-send-btn"
              onClick={() => handleSendMessage(inputValue)}
              disabled={loading || (messageLimit !== null && messageLimit.remaining <= 0)}
            >
              ➤
            </button>
          </div>
        </div>
      </div>

      {showAiSettings && ReactDOM.createPortal(
        <div className={`modal-overlay${aiSettingsClosing ? ' modal-closing' : ''}`} onClick={closeAiSettings}>
          <div className={`modal-content${aiSettingsClosing ? ' modal-content-closing' : ''}`} onClick={e => e.stopPropagation()}>
            <h3 className="modal-title">{t('chat.aiSettings')}</h3>

            <div className="ai-settings-section">
              <div className="ai-settings-title">{t('chat.coachGender')}</div>
              <div className="ai-option-group">
                <button
                  className={`ai-option-btn${aiPrefs.coach_gender === 'male' ? ' active' : ''}`}
                  onClick={() => setAiPrefs(p => ({ ...p, coach_gender: 'male' }))}
                >
                  ♂ {t('chat.coachGenderMale')}
                </button>
                <button
                  className={`ai-option-btn${aiPrefs.coach_gender === 'female' ? ' active' : ''}`}
                  onClick={() => setAiPrefs(p => ({ ...p, coach_gender: 'female' }))}
                >
                  ♀ {t('chat.coachGenderFemale')}
                </button>
              </div>
            </div>

            <div className="ai-settings-section">
              <div className="ai-settings-title">{t('chat.personality')}</div>
              <div className="personality-grid">
                {(['bro', 'strict', 'calm', 'motivator'] as const).map(p => (
                  <button
                    key={p}
                    className={`ai-option-btn${aiPrefs.personality === p ? ' active' : ''}`}
                    onClick={() => setAiPrefs(prev => ({ ...prev, personality: p }))}
                  >
                    {p === 'bro' && '😎'} {p === 'strict' && '🎯'} {p === 'calm' && '🧘'} {p === 'motivator' && '🔥'} {t(`chat.personality${p.charAt(0).toUpperCase() + p.slice(1)}`)}
                  </button>
                ))}
              </div>
            </div>

            <div className="ai-settings-section">
              <div className="ai-settings-title">{t('chat.responseLength')}</div>
              <div className="ai-option-group ai-option-group-3">
                {(['short', 'medium', 'long'] as const).map(l => (
                  <button
                    key={l}
                    className={`ai-option-btn${aiPrefs.response_length === l ? ' active' : ''}`}
                    onClick={() => setAiPrefs(p => ({ ...p, response_length: l }))}
                  >
                    {t(`chat.responseLength${l.charAt(0).toUpperCase() + l.slice(1)}`)}
                  </button>
                ))}
              </div>
            </div>

            <div className="ai-settings-section">
              <div className="ai-settings-title">{t('chat.emojiLevel')}</div>
              <div className="ai-option-group">
                <button
                  className={`ai-option-btn${aiPrefs.emoji_level === 'few' ? ' active' : ''}`}
                  onClick={() => setAiPrefs(p => ({ ...p, emoji_level: 'few' }))}
                >
                  {t('chat.emojiFew')}
                </button>
                <button
                  className={`ai-option-btn${aiPrefs.emoji_level === 'many' ? ' active' : ''}`}
                  onClick={() => setAiPrefs(p => ({ ...p, emoji_level: 'many' }))}
                >
                  {t('chat.emojiMany')}
                </button>
              </div>
            </div>

            {messageLimit && (
              <div className="ai-settings-section ai-limit-section">
                <div className="ai-settings-title">{t('chat.dailyLimit')}</div>
                <div className="ai-limit-bar-wrapper">
                  <div className="ai-limit-bar">
                    <div
                      className={`ai-limit-bar-fill${messageLimit.remaining <= 3 ? ' low' : ''}`}
                      style={{ width: `${(messageLimit.remaining / messageLimit.limit) * 100}%` }}
                    />
                  </div>
                  <span className={`ai-limit-text${messageLimit.remaining <= 3 ? ' low' : ''}`}>
                    {t('chat.messagesLeft', { count: messageLimit.remaining, limit: messageLimit.limit })}
                  </span>
                </div>
              </div>
            )}

            <button
              className="btn btn-accent btn-full"
              onClick={handleSaveAiPrefs}
              disabled={savingPrefs}
              style={{ marginTop: '16px' }}
            >
              {savingPrefs ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

export default AIChat;
