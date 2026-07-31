import { dataChannelService } from './dataChannelService';
import { wsService, type JoinResult, type WsEventHandlers } from './wsService';
import { VIDEO_SYNC_ACTIONS, type VideoSyncAction } from '@shared/dataChannelProtocol';
import type { MediaState, QualityFeedback } from '../types';

/**
 * The single transport surface the app talks to.
 *
 * Two wires behind one set of method names, split by cost. Everything that must
 * survive a dead peer connection — signalling, chat, screen-share control —
 * goes over the WebSocket and bills a Durable Object request. Everything
 * high-frequency that is meaningless before the peer connection exists goes
 * peer-to-peer over the DataChannel and bills nothing.
 *
 * The method names are the ones signalRService used, and every send still
 * accepts a sessionId it no longer needs, because callers should not have to
 * care which wire a message takes. usePeerPresence and useWatchTogether hold a
 * ref to this object and needed no edits at all.
 */

export type TransportEventHandlers = WsEventHandlers & {
  /** Peer began typing in chat. Cleared by the receiver after ~2s of silence. */
  onPeerTyping?: (displayName: string) => void;
  /** Watch Together transition. action = load/close/play/pause/seek. */
  onPeerVideoSync?: (displayName: string, action: string, payload: string) => void;
  onPeerReaction?: (displayName: string, emoji: string) => void;
  /** Peer cursor over the shared surface, normalised 0..1. */
  onPeerCursor?: (displayName: string, x: number, y: number) => void;
  onReceiveQualityFeedback?: (displayName: string, feedback: QualityFeedback) => void;
};

class TransportService {
  private handlers: TransportEventHandlers = {};

  setHandlers(handlers: TransportEventHandlers): void {
    this.handlers = handlers;
    wsService.setHandlers(handlers);

    dataChannelService.setHandlers({
      onMessage: (message) => {
        // The DataChannel carries no sender name and does not need to: it is a
        // direct link to exactly one peer, whose name the server already told
        // us over the WebSocket. Putting a name in a 10 Hz frame would be bytes
        // spent re-sending something we know, and a second source of truth for
        // it.
        const name = wsService.getPeerName() ?? 'peer';

        switch (message.t) {
          case 'cursor':
            return this.handlers.onPeerCursor?.(name, message.d.x, message.d.y);
          case 'typing':
            return this.handlers.onPeerTyping?.(name);
          case 'reaction':
            return this.handlers.onPeerReaction?.(name, message.d.emoji);
          case 'videoSync':
            return this.handlers.onPeerVideoSync?.(name, message.d.action, message.d.payload);
          case 'quality':
            return this.handlers.onReceiveQualityFeedback?.(name, message.d.feedback);
        }
      },
    });
  }

  get isConnected(): boolean {
    return wsService.isConnected;
  }

  /** True once presence traffic has somewhere to go. */
  get isPeerChannelOpen(): boolean {
    return dataChannelService.isOpen;
  }

  // -------------------------------------------------------------------------
  // WebSocket — server-relayed, one Durable Object request per message
  // -------------------------------------------------------------------------

  async joinSession(sessionId: string): Promise<JoinResult> {
    return wsService.join(sessionId);
  }

  async leaveSession(_sessionId: string): Promise<void> {
    wsService.leave();
  }

  async sendOffer(_sessionId: string, sdp: string): Promise<void> {
    wsService.send({ t: 'offer', d: { sdp } });
  }

  async sendAnswer(_sessionId: string, sdp: string): Promise<void> {
    wsService.send({ t: 'answer', d: { sdp } });
  }

  async sendIceCandidate(_sessionId: string, candidate: string): Promise<void> {
    wsService.send({ t: 'ice', d: { c: candidate } });
  }

  async sendRenegotiationOffer(_sessionId: string, sdp: string): Promise<void> {
    wsService.send({ t: 'reoffer', d: { sdp } });
  }

  async sendRenegotiationAnswer(_sessionId: string, sdp: string): Promise<void> {
    wsService.send({ t: 'reanswer', d: { sdp } });
  }

  /**
   * Chat stays on the WebSocket on purpose.
   *
   * Volume is trivial, and it is the one channel that has to keep working when
   * the peer connection does not — someone needs to be able to type "I can't
   * see you". The server echoes it back to the sender; the UI does not append
   * locally, so your own messages appear only via that echo.
   */
  async sendChatMessage(_sessionId: string, message: string): Promise<void> {
    wsService.send({ t: 'chat', d: { m: message } });
  }

  async notifyMediaStateChange(_sessionId: string, state: MediaState): Promise<void> {
    wsService.send({ t: 'media', d: state });
  }

  async requestScreenShare(_sessionId: string): Promise<void> {
    wsService.send({ t: 'ss:req', d: {} });
  }

  async respondScreenShare(_sessionId: string, approved: boolean): Promise<void> {
    wsService.send({ t: 'ss:res', d: { approved } });
  }

  async notifyScreenShareStarted(_sessionId: string, streamId: string): Promise<void> {
    wsService.send({ t: 'ss:start', d: { streamId } });
  }

  async stopScreenShare(_sessionId: string): Promise<void> {
    wsService.send({ t: 'ss:stop', d: {} });
  }

  // -------------------------------------------------------------------------
  // DataChannel — peer-to-peer, free
  //
  // All best-effort. A dropped frame here is invisible (cursor), cosmetic
  // (reaction) or self-correcting (typing, quality), so none of these report
  // failure upward — except video sync, whose caller may want to say something.
  // -------------------------------------------------------------------------

  async notifyCursor(_sessionId: string, x: number, y: number): Promise<void> {
    dataChannelService.send({ t: 'cursor', d: { x, y } });
  }

  async notifyTyping(_sessionId: string): Promise<void> {
    dataChannelService.send({ t: 'typing', d: {} });
  }

  async notifyReaction(_sessionId: string, emoji: string): Promise<void> {
    dataChannelService.send({ t: 'reaction', d: { emoji } });
  }

  /**
   * `action` stays a bare string because useWatchTogether's VideoSyncSender
   * declares it that way, so it is checked here rather than cast away — an
   * unrecognised action would be silently dropped by the peer's decoder, which
   * is a much harder thing to notice than a false return.
   */
  async notifyVideoSync(_sessionId: string, action: string, payload: string): Promise<boolean> {
    if (!VIDEO_SYNC_ACTIONS.includes(action as VideoSyncAction)) return false;
    return dataChannelService.send({
      t: 'videoSync',
      d: { action: action as VideoSyncAction, payload },
    });
  }

  async sendQualityFeedback(_sessionId: string, feedback: QualityFeedback): Promise<void> {
    dataChannelService.send({ t: 'quality', d: { feedback } });
  }
}

export const transportService = new TransportService();
export type { JoinResult };
