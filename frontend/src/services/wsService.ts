import { logger } from './logger';
import {
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
  /**
   * A peer who was already in the room. `sharing` is their screen-share stream
   * id as the ROOM has it, or null — the authoritative answer, applied on every
   * join so a reconnect resyncs rather than inheriting whatever we last guessed.
   */
  onExistingPeer?: (displayName: string, sharing: string | null) => void;
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
]);

const FATAL_MESSAGES: Record<number, string> = {
  [CLOSE_REPLACED]: 'This session was opened in another tab.',
  [CLOSE_UNAUTHORIZED]: 'Your session expired — please sign in again.',
  [CLOSE_SESSION_NOT_FOUND]: 'That session has ended.',
  [CLOSE_SESSION_FULL]: 'That session is full.',
};

const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000];
/**
 * Fraction of the reconnect delay to scatter each attempt over.
 *
 * Both peers of a room are usually dropped by the SAME event — an edge restart,
 * a Durable Object move — and a fixed ladder then has them retrying in lockstep,
 * arriving at the upgrade route together on every rung. That is the shape the
 * per-IP limiter on /api/session/* is built to refuse, and its refusal closes
 * with CLOSE_RATE_LIMITED, which is fatal. Scattering costs nothing and keeps
 * the two of them from turning one shared outage into two dead sessions.
 */
const RECONNECT_JITTER = 0.2;
const JOIN_TIMEOUT_MS = 15_000;
/**
 * Keepalive interval.
 *
 * Under a Cloudflare edge that closes an idle WebSocket at around 100 s, and
 * this socket really does go idle: presence and quality ride the DataChannel,
 * chat is sporadic, and a settled screen share signals nothing at all for
 * minutes at a time.
 *
 * The frame is the bare string "ping" rather than a protocol envelope because
 * the room registers it with setWebSocketAutoResponse — the runtime answers
 * "pong" without waking the Durable Object, so this costs no request, no
 * billing, and no rate-limit token. Sending anything else would wake it.
 */
const HEARTBEAT_INTERVAL_MS = 25_000;
/**
 * How long a ping may go unanswered before the socket is presumed dead.
 *
 * This is the whole point of the heartbeat. A half-open socket — NAT rebind,
 * laptop suspend, Wi-Fi handoff — leaves readyState at OPEN, so send() takes
 * the happy path and writes every frame into a void that reports nothing back:
 * no throw, no queueing, no onclose, no reconnect. A screen-share request lost
 * that way left the asker waiting on a peer who was never told anything.
 */
const PONG_TIMEOUT_MS = 10_000;
/**
 * What we close a socket with when its ping went unanswered.
 *
 * Explicit, and deliberately not one of the protocol's CLOSE_* codes: those are
 * the room's verdicts on a client, and this is a client's verdict on its own
 * socket — the server has no handling for it beyond the ordinary departure.
 * Explicit rather than a bare close() because an argument-less close reports
 * 1005, and 1005 means "no status was given", which is a thing this close very
 * much does have. It must stay outside FATAL_CLOSE_CODES: giving up on a dead
 * socket is the beginning of a reconnect, not the end of a session.
 */
const CLOSE_KEEPALIVE_TIMEOUT = 4100;
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
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Armed when a ping goes out, cleared by its pong. See startHeartbeat. */
  private pongTimer: ReturnType<typeof setTimeout> | null = null;

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

        // Before the parse, because it is not JSON: the room's auto-responder
        // replies with the bare string. Parsing it would only log it as an
        // unparseable frame every 25 seconds.
        if (event.data === 'pong') {
          this.clearPongTimer();
          return;
        }

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
          // Only once the room has released us. Pinging a socket that has not
          // finished joining would just race the join timeout.
          this.startHeartbeat(socket);
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
        this.stopHeartbeat();
        if (this.socket === socket) this.socket = null;

        if (!settled) {
          settled = true;
          reject(new Error(FATAL_MESSAGES[event.code] ?? 'Could not join the session.'));
          return;
        }

        this.handleClose(event.code);
      };
    });
  }

  /**
   * Start pinging, and treat an unanswered ping as a dead socket.
   *
   * The ping goes out through socket.send directly rather than through send(),
   * which queues: a keepalive held for a socket that is down and replayed
   * afterwards is a keepalive that proved nothing about either socket.
   *
   * Closing on a missed pong is the recovery. It is a local close, so it fires
   * onclose even when nothing is coming back over the wire, and that lands in
   * handleClose with 1005 — deliberately not a fatal code — so the existing
   * reconnect ladder takes it from there and the room re-entry it performs
   * repairs whatever the dead socket silently swallowed.
   */
  private startHeartbeat(socket: WebSocket): void {
    this.stopHeartbeat();

    this.heartbeatTimer = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;

      try {
        socket.send('ping');
      } catch (err) {
        logger.warn('[ws] heartbeat send failed:', err);
      }

      // Already waiting on an earlier one — do not restart its deadline, or a
      // socket that never answers is never judged.
      if (this.pongTimer) return;

      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        logger.warn('[ws] no pong — closing a socket that only looks open');
        try {
          socket.close(CLOSE_KEEPALIVE_TIMEOUT, 'keepalive_timeout');
        } catch {
          // Already closing; onclose still runs.
        }
      }, PONG_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private clearPongTimer(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.clearPongTimer();
  }

  private handleClose(code: number): void {
    if (this.deliberateClose) return;

    if (FATAL_CLOSE_CODES.has(code)) {
      this.queue = [];
      this.handlers.onFatal?.(FATAL_MESSAGES[code] ?? 'Lost connection to the session.');
      return;
    }

    const sessionId = this.sessionId;
    if (!sessionId) return;

    const rung =
      RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]!;
    const delay = Math.round(rung * (1 + (Math.random() * 2 - 1) * RECONNECT_JITTER));
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
          // from here or the retry chain stops silently.
          this.handleClose(1006);
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
        return this.handlers.onExistingPeer?.(message.d.name, message.d.sharing ?? null);
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
    this.stopHeartbeat();
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
