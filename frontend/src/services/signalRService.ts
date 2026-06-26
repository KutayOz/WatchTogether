import { logger } from './logger';
import * as signalR from '@microsoft/signalr';
import { SIGNALR_URL } from '../utils/constants';
import type { ChatMessage, MediaState, QualityFeedback } from '../types';

export type SignalREventHandlers = {
  onPeerJoined?: (displayName: string) => void;
  onExistingPeer?: (displayName: string) => void;
  onPeerLeft?: (displayName: string) => void;
  onReceiveOffer?: (sdpOffer: string, displayName: string) => void;
  onReceiveAnswer?: (sdpAnswer: string) => void;
  onReceiveIceCandidate?: (candidate: string) => void;
  onReceiveChatMessage?: (message: ChatMessage) => void;
  onPeerMediaStateChanged?: (displayName: string, state: MediaState) => void;
  /** Peer began typing in chat. Receiver auto-clears the "X is typing…"
   *  indicator after ~2 s if no fresh PeerTyping arrives. */
  onPeerTyping?: (displayName: string) => void;
  /** Watch Together state transition from peer. action = load/play/pause/seek/close. */
  onPeerVideoSync?: (displayName: string, action: string, payload: string) => void;
  /** Floating emoji reaction from peer. */
  onPeerReaction?: (displayName: string, emoji: string) => void;
  /** Peer cursor position during screen share (normalized 0..1). */
  onPeerCursor?: (displayName: string, x: number, y: number) => void;
  onScreenShareRequested?: (displayName: string) => void;
  onScreenShareResponse?: (approved: boolean, displayName: string) => void;
  onScreenShareStarted?: (displayName: string, streamId: string) => void;
  onScreenShareStopped?: (displayName: string) => void;
  onReceiveRenegotiationOffer?: (sdpOffer: string) => void;
  onReceiveRenegotiationAnswer?: (sdpAnswer: string) => void;
  onReceiveQualityFeedback?: (displayName: string, feedback: QualityFeedback) => void;
};

class SignalRService {
  private connection: signalR.HubConnection | null = null;
  private handlers: SignalREventHandlers = {};
  private connectionPromise: Promise<void> | null = null;

  /**
   * Post-C4: auth is via HttpOnly cookie. We no longer need (or have access to)
   * the JWT in JS. `withCredentials: true` makes the WebSocket handshake send
   * the auth cookie automatically, same as fetch() with credentials:'include'.
   *
   * Backend extracts the token from the cookie in Program.cs's
   * OnMessageReceived event (third fallback after Authorization header + query).
   */
  async connect(): Promise<void> {
    logger.debug('[SignalR] connect() called, current state:', this.connection?.state);

    if (this.connection?.state === signalR.HubConnectionState.Connected) {
      logger.debug('[SignalR] Already connected');
      return;
    }

    // If already connecting, wait for that connection
    if (this.connectionPromise) {
      logger.debug('[SignalR] Connection in progress, waiting...');
      return this.connectionPromise;
    }

    this.connection = new signalR.HubConnectionBuilder()
      .withUrl(SIGNALR_URL, {
        withCredentials: true,
      })
      .withAutomaticReconnect()
      .configureLogging(signalR.LogLevel.Information)
      .build();

    this.registerHandlers();

    logger.debug('[SignalR] Starting connection...');
    this.connectionPromise = this.connection.start();
    try {
      await this.connectionPromise;
      logger.debug('[SignalR] Connection established successfully');
    } catch (err) {
      logger.error('[SignalR] Connection failed:', err);
      throw err;
    } finally {
      this.connectionPromise = null;
    }
  }

  async ensureConnected(): Promise<void> {
    logger.debug('[SignalR] ensureConnected() called, state:', this.connection?.state);

    // If already connected, we're good
    if (this.connection?.state === signalR.HubConnectionState.Connected) {
      return;
    }

    // If connection is in progress, wait for it
    if (this.connectionPromise) {
      logger.debug('[SignalR] Waiting for pending connection...');
      await this.connectionPromise;
      return;
    }

    // Reconnect — cookie auth means we don't need to remember any token.
    logger.debug('[SignalR] Attempting to (re)connect...');
    await this.connect();
  }

  private registerHandlers(): void {
    if (!this.connection) return;

    this.connection.on('PeerJoined', (displayName: string) => {
      this.handlers.onPeerJoined?.(displayName);
    });

    this.connection.on('ExistingPeer', (displayName: string) => {
      this.handlers.onExistingPeer?.(displayName);
    });

    this.connection.on('PeerLeft', (displayName: string) => {
      this.handlers.onPeerLeft?.(displayName);
    });

    this.connection.on('ReceiveOffer', (sdpOffer: string, displayName: string) => {
      this.handlers.onReceiveOffer?.(sdpOffer, displayName);
    });

    this.connection.on('ReceiveAnswer', (sdpAnswer: string) => {
      this.handlers.onReceiveAnswer?.(sdpAnswer);
    });

    this.connection.on('ReceiveIceCandidate', (candidate: string) => {
      logger.debug('[SignalR Service] ReceiveIceCandidate event fired');
      this.handlers.onReceiveIceCandidate?.(candidate);
    });

    this.connection.on('ReceiveChatMessage', (message: ChatMessage) => {
      this.handlers.onReceiveChatMessage?.(message);
    });

    this.connection.on('PeerMediaStateChanged', (displayName: string, state: MediaState) => {
      this.handlers.onPeerMediaStateChanged?.(displayName, state);
    });

    this.connection.on('PeerTyping', (displayName: string) => {
      this.handlers.onPeerTyping?.(displayName);
    });

    this.connection.on('PeerVideoSync', (displayName: string, action: string, payload: string) => {
      this.handlers.onPeerVideoSync?.(displayName, action, payload);
    });

    this.connection.on('PeerReaction', (displayName: string, emoji: string) => {
      this.handlers.onPeerReaction?.(displayName, emoji);
    });

    this.connection.on('PeerCursor', (displayName: string, x: number, y: number) => {
      this.handlers.onPeerCursor?.(displayName, x, y);
    });

    this.connection.on('ScreenShareRequested', (displayName: string) => {
      this.handlers.onScreenShareRequested?.(displayName);
    });

    this.connection.on('ScreenShareResponse', (approved: boolean, displayName: string) => {
      this.handlers.onScreenShareResponse?.(approved, displayName);
    });

    this.connection.on('ScreenShareStarted', (displayName: string, streamId: string) => {
      this.handlers.onScreenShareStarted?.(displayName, streamId);
    });

    this.connection.on('ScreenShareStopped', (displayName: string) => {
      this.handlers.onScreenShareStopped?.(displayName);
    });

    this.connection.on('ReceiveRenegotiationOffer', (sdpOffer: string) => {
      this.handlers.onReceiveRenegotiationOffer?.(sdpOffer);
    });

    this.connection.on('ReceiveRenegotiationAnswer', (sdpAnswer: string) => {
      this.handlers.onReceiveRenegotiationAnswer?.(sdpAnswer);
    });

    this.connection.on('ReceiveQualityFeedback', (displayName: string, feedback: QualityFeedback) => {
      this.handlers.onReceiveQualityFeedback?.(displayName, feedback);
    });
  }

  setHandlers(handlers: SignalREventHandlers): void {
    this.handlers = handlers;
  }

  async joinSession(sessionId: string): Promise<boolean> {
    logger.debug('[SignalR] joinSession() called for:', sessionId);
    // Ensure we're connected before attempting to join
    await this.ensureConnected();
    if (!this.connection) throw new Error('Not connected');
    logger.debug('[SignalR] Invoking JoinSession...');
    const result = await this.connection.invoke<boolean>('JoinSession', sessionId);
    logger.debug('[SignalR] JoinSession result:', result);
    return result;
  }

  async leaveSession(sessionId: string): Promise<void> {
    if (!this.connection) return;
    await this.connection.invoke('LeaveSession', sessionId);
  }

  async sendOffer(sessionId: string, sdpOffer: string): Promise<void> {
    if (!this.connection) throw new Error('Not connected');
    await this.connection.invoke('SendOffer', sessionId, sdpOffer);
  }

  async sendAnswer(sessionId: string, sdpAnswer: string): Promise<void> {
    if (!this.connection) throw new Error('Not connected');
    await this.connection.invoke('SendAnswer', sessionId, sdpAnswer);
  }

  async sendIceCandidate(sessionId: string, candidate: string): Promise<void> {
    logger.debug('[SignalR] sendIceCandidate called, connection state:', this.connection?.state);
    if (!this.connection) throw new Error('Not connected');
    if (this.connection.state !== 'Connected') {
      throw new Error(`SignalR not in Connected state: ${this.connection.state}`);
    }
    await this.connection.invoke('SendIceCandidate', sessionId, candidate);
  }

  async sendChatMessage(sessionId: string, message: string): Promise<void> {
    if (!this.connection) throw new Error('Not connected');
    await this.connection.invoke('SendChatMessage', sessionId, message);
  }

  async notifyTyping(sessionId: string): Promise<void> {
    if (!this.connection || this.connection.state !== signalR.HubConnectionState.Connected) return;
    try {
      await this.connection.invoke('NotifyTyping', sessionId);
    } catch {
      // Typing notifications are best-effort. A failed invoke (transient
      // connection blip) shouldn't surface to the user — they just won't
      // see "X is typing" for that keystroke window.
    }
  }

  async notifyVideoSync(sessionId: string, action: string, payload: string): Promise<void> {
    if (!this.connection || this.connection.state !== signalR.HubConnectionState.Connected) return;
    try {
      await this.connection.invoke('NotifyVideoSync', sessionId, action, payload);
    } catch (err) {
      logger.warn('[SignalR] NotifyVideoSync failed:', err);
    }
  }

  async notifyReaction(sessionId: string, emoji: string): Promise<void> {
    if (!this.connection || this.connection.state !== signalR.HubConnectionState.Connected) return;
    try {
      await this.connection.invoke('NotifyReaction', sessionId, emoji);
    } catch {
      // Reactions are fire-and-forget vibes. Don't error-toast a dropped 🩷.
    }
  }

  async notifyCursor(sessionId: string, x: number, y: number): Promise<void> {
    if (!this.connection || this.connection.state !== signalR.HubConnectionState.Connected) return;
    try {
      await this.connection.invoke('NotifyCursor', sessionId, x, y);
    } catch {
      // Cursor relays are ~10 Hz best-effort; one missed packet is invisible.
    }
  }

  async notifyMediaStateChange(sessionId: string, state: MediaState): Promise<void> {
    if (!this.connection) throw new Error('Not connected');
    await this.connection.invoke('NotifyMediaStateChange', sessionId, state);
  }

  async requestScreenShare(sessionId: string): Promise<void> {
    if (!this.connection) throw new Error('Not connected');
    await this.connection.invoke('RequestScreenShare', sessionId);
  }

  async respondScreenShare(sessionId: string, approved: boolean): Promise<void> {
    if (!this.connection) throw new Error('Not connected');
    await this.connection.invoke('RespondScreenShare', sessionId, approved);
  }

  async stopScreenShare(sessionId: string): Promise<void> {
    if (!this.connection) throw new Error('Not connected');
    await this.connection.invoke('StopScreenShare', sessionId);
  }

  async notifyScreenShareStarted(sessionId: string, streamId: string): Promise<void> {
    if (!this.connection) throw new Error('Not connected');
    await this.connection.invoke('NotifyScreenShareStarted', sessionId, streamId);
  }

  async sendRenegotiationOffer(sessionId: string, sdpOffer: string): Promise<void> {
    if (!this.connection) throw new Error('Not connected');
    await this.connection.invoke('SendRenegotiationOffer', sessionId, sdpOffer);
  }

  async sendRenegotiationAnswer(sessionId: string, sdpAnswer: string): Promise<void> {
    if (!this.connection) throw new Error('Not connected');
    await this.connection.invoke('SendRenegotiationAnswer', sessionId, sdpAnswer);
  }

  async sendQualityFeedback(sessionId: string, feedback: QualityFeedback): Promise<void> {
    if (!this.connection) throw new Error('Not connected');
    await this.connection.invoke('SendQualityFeedback', sessionId, feedback);
  }

  async disconnect(): Promise<void> {
    if (this.connection) {
      await this.connection.stop();
      this.connection = null;
    }
  }

  get isConnected(): boolean {
    return this.connection?.state === signalR.HubConnectionState.Connected;
  }
}

export const signalRService = new SignalRService();
