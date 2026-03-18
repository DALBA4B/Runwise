import React from 'react';

interface Message {
  id: string;
  role: 'user' | 'ai' | 'system';
  content: string;
  timestamp: Date;
}

interface ChatMessageProps {
  message: Message;
}

const ChatMessage: React.FC<ChatMessageProps> = ({ message }) => {
  return (
    <div className={`message ${message.role === 'user' ? 'user-message' : message.role === 'system' ? 'system-message' : 'ai-message'}`}>
      <div className="message-content">
        <p>{message.content}</p>
      </div>
    </div>
  );
};

export default ChatMessage;
