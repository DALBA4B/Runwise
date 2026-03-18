import React, { useState, useRef, useEffect } from 'react';
import ChatMessage from '../components/ChatMessage';
import { ai } from '../api/api';

interface Message {
  id: string;
  role: 'user' | 'ai' | 'system';
  content: string;
  timestamp: Date;
}

const QUICK_QUESTIONS = [
  '📋 Расскажи про мой текущий план',
  '😓 Мне тяжело, уменьши нагрузку в плане',
  '💪 Как мне улучшить свой темп?',
  '📊 Как я прогрессирую?',
  '❤️ Почему высокий пульс на лёгких пробежках?',
  '🔄 Когда делать интервальные тренировки?'
];

const WELCOME_MESSAGE: Message = {
  id: '1',
  role: 'ai',
  content: 'Привет! 👋 Я твой персональный AI тренер Runwise. Спроси меня что-то о твоих тренировках, попроси рекомендации или измени план прямо в чате.',
  timestamp: new Date()
};

const AIChat: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([WELCOME_MESSAGE]);
  const [inputValue, setInputValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [updatingPlan, setUpdatingPlan] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Only auto-scroll if user hasn't scrolled up
  useEffect(() => {
    if (!userScrolledUp.current) {
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

  // Load chat history on mount
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
  }, []);

  const handleClearHistory = async () => {
    if (!window.confirm('Очистить историю чата?')) return;
    try {
      await ai.clearChatHistory();
      setMessages([WELCOME_MESSAGE]);
    } catch (err) {
      console.error('Failed to clear history:', err);
    }
  };

  const handleSendMessage = async (text: string) => {
    if (!text.trim()) return;

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

    // Strip ===PLAN_UPDATE===...===END_PLAN_UPDATE=== and everything after ===PLAN_UPDATE===
    const stripPlanBlock = (text: string) => {
      const planStart = text.indexOf('===PLAN_UPDATE===');
      if (planStart === -1) return text;
      // Hide everything from ===PLAN_UPDATE=== onwards (it may not be complete yet)
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
          // Final cleanup: strip plan block from displayed message
          const cleanContent = stripPlanBlock(fullContent);
          setMessages(prev =>
            prev.map(m =>
              m.id === aiMessageId ? { ...m, content: cleanContent } : m
            )
          );
          if (meta.planUpdated) {
            const systemMsg: Message = {
              id: (Date.now() + 2).toString(),
              role: 'system',
              content: '✅ План тренировок обновлён! Перейди во вкладку «План» чтобы увидеть изменения.',
              timestamp: new Date()
            };
            setMessages(prev => [...prev, systemMsg]);
          }
        }
      );
    } catch (err) {
      console.error('Chat error:', err);
      setMessages(prev =>
        prev.map(m =>
          m.id === aiMessageId
            ? { ...m, content: 'Извини, что-то пошло не так. Попробуй позже.' }
            : m
        )
      );
    } finally {
      setLoading(false);
      setUpdatingPlan(false);
    }
  };

  return (
    <div className="screen ai-chat-screen">
      <div className="chat-header">
        <h2 className="screen-title">🤖 AI Тренер</h2>
        {messages.length > 1 && (
          <button className="clear-chat-btn" onClick={handleClearHistory}>Очистить</button>
        )}
      </div>

      <div className="chat-container">
        <div className="messages" ref={messagesContainerRef} onScroll={handleScroll}>
          {messages.map(message => (
            <ChatMessage key={message.id} message={message} />
          ))}
          {loading && (
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
          {updatingPlan && (
            <div className="message system-message">
              <div className="message-content plan-updating">
                <span className="plan-updating-spinner"></span>
                📝 Обновляю план тренировок...
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="quick-questions">
          <p className="quick-questions-label">Быстрые вопросы:</p>
          <div className="quick-questions-grid">
            {QUICK_QUESTIONS.map((question, index) => (
              <button
                key={index}
                className="quick-btn"
                onClick={() => handleSendMessage(question)}
                disabled={loading}
              >
                {question}
              </button>
            ))}
          </div>
        </div>

        <div className="chat-input-area">
          <div className="chat-input-wrapper">
            <input
              type="text"
              className="chat-input"
              placeholder="Спроси меня о твоих тренировках..."
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !loading) {
                  handleSendMessage(inputValue);
                }
              }}
              disabled={loading}
            />
            <button
              className="chat-send-btn"
              onClick={() => handleSendMessage(inputValue)}
              disabled={loading}
            >
              ➤
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AIChat;
