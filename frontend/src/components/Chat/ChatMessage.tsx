import { m } from 'motion/react';
import type { ChatMessage as ChatMessageType } from '../../types';

interface ChatMessageProps {
  message: ChatMessageType;
  isOwnMessage: boolean;
  /** First of a run from one person: carries the name and time. */
  isFirstInGroup?: boolean;
}

/**
 * One message. Yours sit right in amber, theirs left in teal — the same two
 * lights as everywhere else. Arrives with a small spring from the side it
 * was sent from.
 */
export function ChatMessageItem({ message, isOwnMessage, isFirstInGroup = true }: ChatMessageProps) {
  const time = new Date(message.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <m.div
      className="msg"
      data-own={isOwnMessage ? '' : undefined}
      data-first={isFirstInGroup ? '' : undefined}
      initial={{ opacity: 0, y: 12, x: isOwnMessage ? 12 : -12, scale: 0.94 }}
      animate={{ opacity: 1, y: 0, x: 0, scale: 1 }}
      transition={{ type: 'spring', stiffness: 520, damping: 32 }}
    >
      {isFirstInGroup && (
        <div className="msg__meta">
          <span>{isOwnMessage ? 'You' : message.sender}</span>
          <time className="msg__time" dateTime={message.timestamp}>
            {time}
          </time>
        </div>
      )}
      <div className="msg__bubble" title={isFirstInGroup ? undefined : time}>
        {message.message}
      </div>
    </m.div>
  );
}
