import type { ChatMessage as ChatMessageType } from '../../types';
import { SpeechBubble } from '../manga';

interface ChatMessageProps {
  message: ChatMessageType;
  isOwnMessage: boolean;
}

/**
 * ChatMessageItem — manga-style speech bubble.
 * - Own messages: pink, tail on the right
 * - Peer messages: cream, tail on the left
 */
export function ChatMessageItem({ message, isOwnMessage }: ChatMessageProps) {
  const time = new Date(message.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: isOwnMessage ? 'flex-end' : 'flex-start',
        gap: 2,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, padding: '0 6px' }}>
        <span className="hand" style={{ fontSize: 14, color: 'rgba(26,20,23,0.65)' }}>
          {message.sender}
        </span>
        <span className="hand" style={{ fontSize: 12, color: 'rgba(26,20,23,0.45)' }}>{time}</span>
      </div>
      <SpeechBubble kind="rect" color={isOwnMessage ? 'pink' : 'cream'} small>
        {message.message}
      </SpeechBubble>
    </div>
  );
}
