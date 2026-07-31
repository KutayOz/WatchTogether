import { type RefObject, useState, useRef, useCallback, useEffect } from 'react';

type PresenceSender = {
  notifyCursor: (sessionId: string, x: number, y: number) => void;
  notifyTyping: (sessionId: string) => void;
  notifyReaction: (sessionId: string, emoji: string) => void;
};

export interface PeerCursor { x: number; y: number; name: string; lastSeenAt: number }
export interface FloatingReaction { id: number; emoji: string; from: string }

/**
 * Ephemeral peer-presence interactions extracted from SessionRoom: the live
 * cursor halo, the "X is typing…" indicator, and floating emoji reactions.
 * Each owns its state, its throttled outgoing sender, and its auto-clear timer.
 *
 * The RECEIVE side stays in SessionRoom's central transport handler, which drives
 * the returned setters (setPeerCursor / setPeerTyping* / setReactions). Sends
 * route through transportRef so this hook can be called before useTransport wires up.
 */
export function usePeerPresence(
  sessionIdRef: RefObject<string | null>,
  transportRef: RefObject<PresenceSender | null>,
  displayName: string | undefined,
) {
  /* ── cursor halo ── */
  const [peerCursor, setPeerCursor] = useState<PeerCursor | null>(null);
  const lastCursorSentAtRef = useRef(0);

  // Outgoing-cursor throttle. ~10Hz — past that a cursor stops looking any
  // smoother. These frames ride the WebRTC DataChannel now, so each one costs a
  // peer-to-peer packet rather than a billable Durable Object request; the
  // throttle is about how it looks, not what it costs.
  const handleLocalCursor = useCallback((x: number, y: number) => {
    if (!sessionIdRef.current) return;
    const now = Date.now();
    if (now - lastCursorSentAtRef.current < 100) return;
    lastCursorSentAtRef.current = now;
    transportRef.current?.notifyCursor(sessionIdRef.current, x, y);
  }, [sessionIdRef, transportRef]);

  // Auto-clear stale cursor — if no fresh PeerCursor in ~1.5s, hide the halo.
  useEffect(() => {
    if (!peerCursor) return;
    const handle = window.setTimeout(() => {
      setPeerCursor((c) => (c && Date.now() - c.lastSeenAt >= 1400 ? null : c));
    }, 1500);
    return () => window.clearTimeout(handle);
  }, [peerCursor]);

  /* ── typing indicator ── */
  const [peerTypingAt, setPeerTypingAt] = useState<number>(0);
  const [peerTypingName, setPeerTypingName] = useState<string | null>(null);
  // Freshness comes from the auto-clear effect below (resets peerTypingAt to 0
  // ~2.5s after the last keystroke), so a plain `> 0` check stays pure — no
  // Date.now() in render.
  const isPeerTyping = peerTypingAt > 0;
  const lastTypingSentAtRef = useRef(0);

  // Outgoing-typing throttle. Send NotifyTyping at most once every 2s while the
  // user is actively typing. Doing it on every keystroke would spam.
  const handleLocalTyping = useCallback(() => {
    if (!sessionIdRef.current) return;
    const now = Date.now();
    if (now - lastTypingSentAtRef.current < 2000) return;
    lastTypingSentAtRef.current = now;
    transportRef.current?.notifyTyping(sessionIdRef.current);
  }, [sessionIdRef, transportRef]);

  // Auto-clear the "X is typing" indicator 2.5s after the last keystroke. A
  // timeout (vs. pure render-time math) ensures the UI re-renders when it clears.
  useEffect(() => {
    if (peerTypingAt === 0) return;
    const handle = window.setTimeout(() => {
      setPeerTypingAt(0);
      setPeerTypingName(null);
    }, 2500);
    return () => window.clearTimeout(handle);
  }, [peerTypingAt]);

  /* ── floating reactions ── */
  const [reactions, setReactions] = useState<FloatingReaction[]>([]);
  const lastReactionSentAtRef = useRef(0);

  const handleSendReaction = useCallback(
    (emoji: string) => {
      // Throttle to one per second so no one can mash the keyboard into spam.
      const now = Date.now();
      if (now - lastReactionSentAtRef.current < 1000) return;
      lastReactionSentAtRef.current = now;

      // Render our own reaction locally too — symmetric experience, no
      // round-trip wait to see your own emoji float up.
      const id = now * 1000 + Math.floor(Math.random() * 1000);
      const myName = displayName ?? 'you';
      setReactions((prev) => [...prev, { id, emoji, from: myName }]);
      window.setTimeout(() => {
        setReactions((prev) => prev.filter((r) => r.id !== id));
      }, 2400);

      if (sessionIdRef.current) {
        transportRef.current?.notifyReaction(sessionIdRef.current, emoji);
      }
    },
    [sessionIdRef, transportRef, displayName],
  );

  return {
    peerCursor,
    setPeerCursor,
    handleLocalCursor,
    peerTypingName,
    isPeerTyping,
    setPeerTypingAt,
    setPeerTypingName,
    handleLocalTyping,
    reactions,
    setReactions,
    handleSendReaction,
  };
}
