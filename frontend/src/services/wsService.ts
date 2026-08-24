import { logger } from './logger';
import {
  CLOSE_INTERNAL_ERROR,
  CLOSE_PAYLOAD_TOO_LARGE,
  CLOSE_RATE_LIMITED,
  CLOSE_REPLACED,
  CLOSE_SESSION_FULL,
  CLOSE_SESSION_NOT_FOUND,
  CLOSE_UNAUTHORIZED,
  type ClientMessage,
  type JoinedPayload,
  type ServerMessage,
} from '@shared/protocol';
import type { ChatMessage, MediaState } from '../types';

/**
 * The signalling socket.
 *
 * Replaces signalRService. Three things changed shape, and each one closed a
 * real failure mode rather than merely being ported:
 *
 *   1. The URL carries the session id, so connecting IS joining. SignalR
 *      reconnected the transport but never re-invoked JoinSession, leaving a
 *      client with a healthy connection sitting outside the group, receiving
 *      nothing and looking fine.
 *   2. No sessionId travels in any message — the socket is bound to one server
 *      side. Every send method still takes one so callers did not have to
 *      change, and it is ignored.
 *   3. Errors arrive as close codes. A browser cannot read a response body from
 *      a rejected WebSocket upgrade, so the server accepts and then closes with
 *      a specific code; that code is the only channel for "why".
 */

export type WsEventHandlers = {
  onPeerJoined?: (displayName: string) => void;
  onExistingPeer?: (displayName: string) => void;
  onPeerLeft?: (displayName: string) => void;
  /** A peer replaced their socket — refresh, tab restore, network flap. */
  onPeerReconnected?: (displayName: string) => void;
  onReceiveOffer?: (sdpOffer: string, displayName: string) => void;
  onReceiveAnswer?: (sdpAnswer: string) => void;
  onReceiveIceCandidate?: (candidate: string) => void;
  onReceiveChatMessage?: (message: ChatMessage) => void;
  onPeerMediaStateChanged?: (displayName: string, state: MediaState) => void;
  onScreenShareRequested?: (displayName: string) => void;
  onScreenShareResponse?: (approved: boolean, displayName: string) => void;
  onScreenShareStarted?: (displayName: string, streamId: string) => void;
  onScreenShareStopped?: (displayName: string) => void;
  onReceiveRenegotiationOffer?: (sdpOffer: string) => void;
  onReceiveRenegotiationAnswer?: (sdpAnswer: string) => void;
  /** The socket dropped and is being retried. */
  onReconnecting?: () => void;
  /** The socket came back and the room re-entered. */
  onReconnected?: () => void;
  /** The socket is gone for good; `reason` is user-presentable. */
  onFatal?: (reason: string) => void;
};

/** What joinSession resolves with once the server releases the client. */
export interface JoinResult extends JoinedPayload {
  /**
   * Peers already in the room, collected from the ExistingPeer frames that
   * arrive before Joined.
   *
   * They are surfaced here rather than left to the handler because the offer
   * decision needs both halves at once: ExistingPeer says a peer is present,
   * Joined says whether we are the one who offers, and the server sends them in
   * that order. A caller acting on ExistingPeer alone does not yet know its own
   * role. Collecting them removes that ordering hazard instead of asking every
   * caller to work around it.
   */
  existingPeers: string[];
}

/** Close codes that mean "do not come back". */
const FATAL_CLOSE_CODES = new Set<number>([
  1000, // we left deliberately
  CLOSE_REPLACED, // another socket took this seat — retrying would ping-pong two tabs forever
  CLOSE_UNAUTHORIZED,
  CLOSE_SESSION_NOT_FOUND,
  CLOSE_SESSION_FULL,
  CLOSE_PAYLOAD_TOO_LARGE, // we sent something malformed; sending it again changes nothing
  /*
   * Fatal, which reads backwards until you see where it comes from: the server
   * closes with this precisely because something retried too fast. An automatic
   * ladder against a rate limiter is what produced the limit, so continuing it
   * is the one response guaranteed not to work. Handing the retry to the user
   * makes their own patience the backoff.
   *
   * Arrives from two places with the same meaning — the room's per-socket flood
   * guard, and the Worker refusing the upgrade itself.
   */
  CLOSE_RATE_LIMITED,
]);

/*
 * User-facing copy per close code.
 *
 * Deliberately wider than FATAL_CLOSE_CODES: this is also read on the join
 * path, where every close is terminal for that attempt whether or not it is
 * terminal for the session. A code can therefore have a message here and still
 * be worth reconnecting after.
 */
const CLOSE_MESSAGES: Record<number, string> = {
  [CLOSE_REPLACED]: 'This session was opened in another tab.',
  [CLOSE_UNAUTHORIZED]: 'Your session expired — please sign in again.',
  [CLOSE_SESSION_NOT_FOUND]: 'That session has ended.',
  [CLOSE_SESSION_FULL]: 'That session is full.',
  [CLOSE_PAYLOAD_TOO_LARGE]: 'The connection sent more than the session allows.',
  [CLOSE_RATE_LIMITED]: 'Too many attempts — wait a moment and try again.',
  [CLOSE_INTERNAL_ERROR]: 'Something went wrong on our side.',
  /*
   * 1006 is the browser's "the handshake never completed" — no status reached
   * us, so the honest message is about reachability rather than about the
   * session. Message only: adding 1006 to FATAL_CLOSE_CODES would disable
   * reconnection outright, since it is the code every ordinary network drop
   * arrives as.
   */
  1006: 'Could not reach the session — check your connection.',
};

/** Carries the close code past the promise boundary. See handleClose. */
class WsCloseError extends Error {
  // Assigned in the body rather than as a parameter property: the frontend
  // compiles with erasableSyntaxOnly, which forbids the shorthand.
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'WsCloseError';
    this.code = code;
  }
}

/**
 * What to show for a close that ended a join attempt.
 *
 * An unmapped code gets its number appended rather than swallowed: it is the
 * only handle anyone has on a failure nothing anticipated, and it costs one
 * parenthetical. 1006 is mapped above precisely so the common case does not
 * take this branch and read like a defect leaking through.
 */
function joinFailureMessage(code: number): string {
  return CLOSE_MESSAGES[code] ?? `Could not join the session. (code ${code})`;
}

const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000];
const JOIN_TIMEOUT_MS = 15_000;
/**
 * Outbound frames held while the socket is down. Bounded because ICE gathering
 * can produce candidates faster than a reconnect completes, and an unbounded
 * queue would replay minutes of stale signalling into a fresh peer connection.
 */
const MAX_QUEUED_FRAMES = 64;

function socketUrl(sessionId: string): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}/api/session/ws/${encodeURIComponent(sessionId)}`;
}

class WsService {
  private socket: WebSocket | null = null;
  private handlers: WsEventHandlers = {};
  private sessionId: string | null = null;
  /** Set when the caller asked to leave, so an expected close is not retried. */
  private deliberateClose = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: string[] = [];
  /** Peer display name, learned from the server. The DataChannel has no names
   *  of its own — see transportService. */
  private peerName: string | null = null;

  setHandlers(handlers: WsEventHandlers): void {
    this.handlers = handlers;
  }

  get isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  getPeerName(): string | null {
    return this.peerName;
  }

  /**
   * Open the socket and wait for the server to release us with Joined.
   *
   * Joined is the readiness barrier that JoinSession's boolean return used to
   * be: until it arrives the room does not know about us and we do not know our
   * negotiation role.
   */
  join(sessionId: string): Promise<JoinResult> {
    this.sessionId = sessionId;
    this.deliberateClose = false;
    this.reconnectAttempt = 0;
    this.peerName = null;
    return this.open(sessionId);
  }

  private open(sessionId: string): Promise<JoinResult> {
    return new Promise<JoinResult>((resolve, reject) => {
      let settled = false;
      const existingPeers: string[] = [];

      // The cookie rides the handshake automatically — same-origin WebSocket,
      // no header to set and no token in JS to leak.
      const socket = new WebSocket(socketUrl(sessionId));
      this.socket = socket;

      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.close();
        reject(new Error('Timed out joining the session.'));
      }, JOIN_TIMEOUT_MS);

      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return;

        let message: ServerMessage;
        try {
          message = JSON.parse(event.data) as ServerMessage;
        } catch {
          logger.warn('[ws] dropped unparseable frame');
          return;
        }

        // Buffered until Joined so the caller learns role and occupancy
        // together; the handler still fires so peer-name state updates.
        if (!settled && message.t === 'ExistingPeer') {
          existingPeers.push(message.d.name);
        }

        if (!settled && message.t === 'Joined') {
          settled = true;
          window.clearTimeout(timeout);
          this.reconnectAttempt = 0;
          this.flushQueue();
          resolve({ ...message.d, existingPeers });
          return;
        }

        this.dispatch(message);
      };

      socket.onerror = () => {
        // Never carries a reason — onclose does the real work.
        logger.warn('[ws] socket error');
      };

      socket.onclose = (event) => {
        window.clearTimeout(timeout);
        if (this.socket === socket) this.socket = null;

        if (!settled) {
          settled = true;
          // warn, not debug: logger silences debug and info in production
          // builds, and this is the one line that says why a join failed.
          logger.warn(`[ws] join rejected — close ${event.code} ${event.reason}`);
          reject(new WsCloseError(event.code, joinFailureMessage(event.code)));
          return;
        }

        this.handleClose(event.code);
      };
    });
  }

  private handleClose(code: number): void {
    if (this.deliberateClose) return;

    if (FATAL_CLOSE_CODES.has(code)) {
      this.queue = [];
      // warn rather than debug: a session ending for good is the one close
      // worth having in a production log.
      logger.warn(`[ws] closed for good (${code})`);
      this.handlers.onFatal?.(CLOSE_MESSAGES[code] ?? 'Lost connection to the session.');
      return;
    }

    const sessionId = this.sessionId;
    if (!sessionId) return;

    const delay =
      RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]!;
    this.reconnectAttempt += 1;
    logger.debug(`[ws] closed (${code}) — reconnecting in ${delay}ms`);
    this.handlers.onReconnecting?.();

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.deliberateClose || this.sessionId !== sessionId) return;

      // Reconnecting IS rejoining: the server evicts our previous socket and
      // replays ExistingPeer + Joined. Nothing extra to re-invoke.
      this.open(sessionId).then(
        () => this.handlers.onReconnected?.(),
        (err: unknown) => {
          logger.warn('[ws] reconnect attempt failed:', err);
          // A rejected reopen never reached onclose, so drive the next attempt
          // from here or the retry chain stops silently. The code has to come
          // off the error: substituting a literal 1006 here meant a reconnect
          // refused as rate-limited, full or unauthorized never consulted
          // FATAL_CLOSE_CODES at all, and retried forever.
          this.handleClose(err instanceof WsCloseError ? err.code : 1006);
        },
      );
    }, delay);
  }

  private dispatch(message: ServerMessage): void {
    switch (message.t) {
      case 'Joined':
        // A Joined outside the join handshake means the server re-released us
        // after a reconnect; the promise for it has long since resolved.
        return;
      case 'PeerJoined':
        this.peerName = message.d.name;
        return this.handlers.onPeerJoined?.(message.d.name);
      case 'ExistingPeer':
        this.peerName = message.d.name;
        return this.handlers.onExistingPeer?.(message.d.name);
      case 'PeerReconnected':
        this.peerName = message.d.name;
        return this.handlers.onPeerReconnected?.(message.d.name);
      case 'PeerLeft':
        this.peerName = null;
        return this.handlers.onPeerLeft?.(message.d.name);
      case 'ReceiveOffer':
        return this.handlers.onReceiveOffer?.(message.d.sdp, message.d.name);
      case 'ReceiveAnswer':
        return this.handlers.onReceiveAnswer?.(message.d.sdp);
      case 'ReceiveIceCandidate':
        return this.handlers.onReceiveIceCandidate?.(message.d.c);
      case 'ReceiveChatMessage':
        return this.handlers.onReceiveChatMessage?.(message.d);
      case 'PeerMediaStateChanged':
        return this.handlers.onPeerMediaStateChanged?.(message.d.name, message.d.state);
      case 'ScreenShareRequested':
        return this.handlers.onScreenShareRequested?.(message.d.name);
      case 'ScreenShareResponse':
        return this.handlers.onScreenShareResponse?.(message.d.approved, message.d.name);
      case 'ScreenShareStarted':
        return this.handlers.onScreenShareStarted?.(message.d.name, message.d.streamId);
      case 'ScreenShareStopped':
        return this.handlers.onScreenShareStopped?.(message.d.name);
      case 'ReceiveRenegotiationOffer':
        return this.handlers.onReceiveRenegotiationOffer?.(message.d.sdp);
      case 'ReceiveRenegotiationAnswer':
        return this.handlers.onReceiveRenegotiationAnswer?.(message.d.sdp);
      case 'Error':
        logger.warn('[ws] server error frame:', message.d.message);
        return;
    }
  }

  /**
   * Queue rather than throw when the socket is down.
   *
   * Signalling is the one thing that must not be dropped during a flap: a lost
   * ICE candidate can be the difference between a call connecting and not. The
   * queue is bounded, and it is discarded on a fatal close so a dead session
   * cannot replay into a new one.
   */
  send(message: ClientMessage): void {
    const frame = JSON.stringify(message);

    if (this.socket?.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(frame);
        return;
      } catch (err) {
        logger.warn('[ws] send failed, queueing:', err);
      }
    }

    if (this.queue.length >= MAX_QUEUED_FRAMES) this.queue.shift();
    this.queue.push(frame);
  }

  private flushQueue(): void {
    if (!this.queue.length || this.socket?.readyState !== WebSocket.OPEN) return;
    const pending = this.queue;
    this.queue = [];
    for (const frame of pending) {
      try {
        this.socket.send(frame);
      } catch (err) {
        logger.warn('[ws] flush failed:', err);
      }
    }
  }

  leave(): void {
    this.deliberateClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.queue = [];
    this.peerName = null;

    if (this.socket?.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(JSON.stringify({ t: 'leave', d: {} } satisfies ClientMessage));
      } catch {
        // Closing anyway; the server reaps the socket either way.
      }
    }
    try {
      this.socket?.close(1000, 'left');
    } catch {
      // Already closing.
    }
    this.socket = null;
    this.sessionId = null;
  }
}

export const wsService = new WsService();
