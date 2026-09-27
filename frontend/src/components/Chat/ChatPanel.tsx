import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { useSessionContext } from '../../context/SessionContext';
import { useAuthContext } from '../../context/AuthContext';
import { ChatMessageItem } from './ChatMessage';
import { IconButton } from '../ui/Button';
import { ChatIcon, SendIcon } from '../ui/icons';

interface ChatPanelProps {
  onSendMessage: (message: string) => void;
  /** Fires on each keystroke. Parent throttles before sending over the wire. */
  onTyping?: () => void;
  /** True while a fresh PeerTyping signal hasn't yet timed out. */
  isPeerTyping?: boolean;
  /** Display name to weave into the indicator text. */
  peerTypingName?: string | null;
  /** Fallback name when peerTypingName isn't available (race conditions). */
  peerName?: string | null;
}

/** Messages from the same person this close together read as one turn. */
const GROUP_GAP_MS = 3 * 60 * 1000;

/**
 * The chat: your messages on the right in your light, theirs on the left in
 * theirs. Consecutive messages from one person group under a single name, and
 * the log follows new messages only while you are already at the bottom — if
 * you have scrolled up to reread something, it stays put.
 *
 * The typing line has a fixed height so the log does not jump when it comes
 * and goes.
 */
export function ChatPanel({
  onSendMessage,
  onTyping,
  isPeerTyping = false,
  peerTypingName,
  peerName,
}: ChatPanelProps) {
  const [input, setInput] = useState('');
  const { messages } = useSessionContext();
  const { user } = useAuthContext();
  const logRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useLayoutEffect(() => {
    const log = logRef.current;
    if (!log || !stickToBottom.current) return;
    log.scrollTo({ top: log.scrollHeight, behavior: messages.length > 1 ? 'smooth' : 'auto' });
  }, [messages.length]);

  // A layout shift from fonts or images arriving should not strand the view
  // just above the latest message.
  useEffect(() => {
    const log = logRef.current;
    if (!log) return;
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current) log.scrollTop = log.scrollHeight;
    });
    observer.observe(log);
    return () => observer.disconnect();
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    stickToBottom.current = true;
    onSendMessage(input.trim());
    setInput('');
  };

  const typingName = peerTypingName ?? peerName ?? 'They';

  return (
    <section className="chat" aria-label="Chat">
      <header className="chat__head">
        <h2 className="chat__title">Chat</h2>
        {messages.length > 0 && (
          <span className="muted tabular" style={{ fontSize: '0.8rem', fontWeight: 600 }}>
            {messages.length} {messages.length === 1 ? 'message' : 'messages'}
          </span>
        )}
      </header>

      <div
        ref={logRef}
        className="chat__log"
        role="log"
        aria-live="polite"
        aria-label="Messages"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {messages.length === 0 ? (
          <div className="chat__empty">
            <ChatIcon size={28} />
            <span>{peerName ? `Say hi to ${peerName}.` : 'Messages you send appear here.'}</span>
          </div>
        ) : (
          messages.map((msg, i) => {
            const prev = messages[i - 1];
            const first =
              !prev ||
              prev.sender !== msg.sender ||
              new Date(msg.timestamp).getTime() - new Date(prev.timestamp).getTime() > GROUP_GAP_MS;
            return (
              <ChatMessageItem
                key={`${msg.timestamp}-${i}`}
                message={msg}
                isOwnMessage={msg.sender === user?.username}
                isFirstInGroup={first}
              />
            );
          })
        )}
      </div>

      {/* Fixed-height row so the log does not reflow when it appears. */}
      <div className="chat__typing" aria-live="polite">
        <AnimatePresence>
          {isPeerTyping && (
            <m.span
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
            >
              <span>{typingName} is typing</span>
              <span aria-hidden="true" className="typing-dots">
                <span />
                <span />
                <span />
              </span>
            </m.span>
          )}
        </AnimatePresence>
      </div>

      <form onSubmit={handleSubmit} className="chat__compose">
        <input
          type="text"
          className="chat__input"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            // Parent decides whether to actually invoke notifyTyping (it
            // throttles via a ref-based timestamp). Whitespace still counts —
            // the user is composing.
            if (e.target.value.length > 0) onTyping?.();
          }}
          placeholder={peerName ? `Message ${peerName}` : 'Write a message'}
          aria-label="Message"
          maxLength={5000}
          enterKeyHint="send"
        />
        <IconButton label="Send" type="submit" tone={input.trim() ? 'amber' : undefined} disabled={!input.trim()} tip={false}>
          <SendIcon size={19} />
        </IconButton>
      </form>
    </section>
  );
}
