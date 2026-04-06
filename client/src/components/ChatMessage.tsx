import React from 'react';

interface Message {
  id: string;
  role: 'user' | 'ai' | 'system';
  content: string;
  timestamp: Date;
}

interface ChatMessageProps {
  message: Message;
  onWorkoutClick?: (id: string) => void;
}

// Parse message content and render workout links as clickable cards
function renderContent(content: string, onWorkoutClick?: (id: string) => void): React.ReactNode[] {
  // Match pattern: [display text](workout:UUID)
  const regex = /\[([^\]]+)\]\(workout:([^)]+)\)/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    // Text before the link
    if (match.index > lastIndex) {
      parts.push(content.slice(lastIndex, match.index));
    }

    const label = match[1];
    const workoutId = match[2];

    parts.push(
      <button
        key={`wl-${workoutId}-${match.index}`}
        className="workout-link-chip"
        onClick={(e) => {
          e.stopPropagation();
          onWorkoutClick?.(workoutId);
        }}
      >
        <span className="workout-link-icon">🏃</span>
        <span className="workout-link-text">{label}</span>
        <span className="workout-link-arrow">›</span>
      </button>
    );

    lastIndex = match.index + match[0].length;
  }

  // Remaining text
  if (lastIndex < content.length) {
    parts.push(content.slice(lastIndex));
  }

  return parts.length > 0 ? parts : [content];
}

const ChatMessage: React.FC<ChatMessageProps> = ({ message, onWorkoutClick }) => {
  const isAi = message.role === 'ai';

  return (
    <div className={`message ${message.role === 'user' ? 'user-message' : message.role === 'system' ? 'system-message' : 'ai-message'}`}>
      <div className="message-content">
        <p>{isAi ? renderContent(message.content, onWorkoutClick) : message.content}</p>
      </div>
    </div>
  );
};

export default ChatMessage;
