import { useState, useRef, useEffect } from 'react';
import { useSessionContext } from '../../context/SessionContext';
import { useAuthContext } from '../../context/AuthContext';
import { ChatMessageItem } from './ChatMessage';
import { SectionTitle, Doodle } from '../manga';

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

/**
 * ChatPanel — manga-style chat with spiral binding on the left edge,
 * thought-bubble input, and an airplane send button.
 *
 * Typing indicator lives below the input as a fixed-height row (always
 * occupies its space so messages don't jump when it appears/disappears).
 * Three animated dots when active; visibility:hidden when idle.
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
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    onSendMessage(input.trim());
    setInput('');
  };

  return (
    <div
      style={{
        position: 'relative',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--cream)',
        border: '4px solid var(--ink)',
        borderRadius: 6,
        boxShadow: '6px 6px 0 var(--ink)',
        overflow: 'hidden',
        minHeight: 240,
      }}
    >
      {/* Spiral binding on the left edge */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: 18,
          background: 'rgba(26,20,23,0.06)',
          borderRight: '3px dashed var(--ink)',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-around',
          alignItems: 'center',
          padding: '10px 0',
          zIndex: 1,
        }}
        aria-hidden="true"
      >
        {Array.from({ length: 10 }, (_, i) => (
          <span
            key={i}
            style={{
              width: 8,
              height: 12,
              border: '2px solid var(--ink)',
              borderRadius: 999,
              background: 'rgba(26,20,23,0.08)',
            }}
          />
        ))}
      </div>

      {/* Header */}
      <div
        style={{
          padding: '12px 16px 8px 30px',
          borderBottom: '2px dashed var(--ink)',
          display: 'flex',
          alignItems: 'baseline',
          gap: 10,
          flexShrink: 0,
        }}
      >
        <SectionTitle size={24} underline="pink">
          CHAT
        </SectionTitle>
      </div>

      {/* Messages */}
      <div
        className="scroll-y"
        style={{
          flex: 1,
          padding: '14px 14px 14px 30px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          minHeight: 0,
        }}
      >
        {messages.length === 0 ? (
          <div
            className="hand"
            style={{ textAlign: 'center', fontSize: 18, color: 'rgba(26,20,23,0.55)', marginTop: 12 }}
          >
            say hi! ↓
          </div>
        ) : (
          messages.map((msg, i) => (
            <ChatMessageItem
              key={i}
              message={msg}
              isOwnMessage={msg.sender === user?.username}
            />
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Typing indicator — fixed-height row above the input so the chat
          doesn't reflow when it appears/disappears. visibility:hidden when
          idle preserves the slot. Three dots stagger via CSS keyframes. */}
      <div
        aria-live="polite"
        style={{
          paddingLeft: 30,
          paddingRight: 14,
          height: 22,
          fontFamily: 'var(--font-hand)',
          fontSize: 15,
          color: 'rgba(26,20,23,0.6)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          visibility: isPeerTyping ? 'visible' : 'hidden',
          flexShrink: 0,
        }}
      >
        <span>{peerTypingName ?? peerName ?? 'peer'} is typing</span>
        <span aria-hidden="true" className="typing-dots">
          <span />
          <span />
          <span />
        </span>
      </div>

      {/* Input */}
      <form
        onSubmit={handleSubmit}
        style={{
          borderTop: '2px dashed var(--ink)',
          padding: '12px 10px 12px 30px',
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          background: 'rgba(255,79,163,0.04)',
          flexShrink: 0,
        }}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            // Parent decides whether to actually invoke notifyTyping (it
            // throttles via a ref-based timestamp). Empty/whitespace-only
            // input still counts — the user is composing.
            if (e.target.value.length > 0) onTyping?.();
          }}
          placeholder="thoughts…"
          style={{
            flex: 1,
            minWidth: 0,
            background: 'var(--cream)',
            border: '3px solid var(--ink)',
            borderRadius: '20px 20px 6px 20px',
            padding: '10px 14px',
            fontFamily: 'var(--font-body)',
            fontWeight: 600,
            fontSize: 14,
            outline: 'none',
            color: 'var(--ink)',
          }}
        />
        <button
          type="submit"
          disabled={!input.trim()}
          title="send"
          style={{
            background: input.trim() ? 'var(--pink)' : 'rgba(255,79,163,0.4)',
            border: '3px solid var(--ink)',
            borderRadius: 12,
            width: 40,
            height: 40,
            cursor: input.trim() ? 'pointer' : 'not-allowed',
            display: 'grid',
            placeItems: 'center',
            boxShadow: '0 3px 0 var(--ink)',
            transform: 'rotate(-6deg)',
            padding: 0,
            flexShrink: 0,
            transition: 'transform .15s, background .15s',
          }}
          onMouseEnter={(e) => {
            if (input.trim()) {
              e.currentTarget.style.transform = 'rotate(0) translateY(-2px) scale(1.08)';
            }
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'rotate(-6deg)';
          }}
        >
          <Doodle kind="airplane" size={22} color="var(--ink)" />
        </button>
      </form>
    </div>
  );
}
