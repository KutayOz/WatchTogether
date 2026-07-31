import { logger } from './logger';
import {
  CONTROL_CHANNEL,
  FAST_CHANNEL,
  channelFor,
  decodeDataChannelMessage,
  encodeData,
  type DataChannelMessage,
} from '@shared/dataChannelProtocol';

/**
 * Peer-to-peer presence transport.
 *
 * Net-new. webrtcService had no createDataChannel at all — the README's "Data
 * Channel — Chat and metadata" line described something that did not exist, and
 * every presence message went through the server.
 *
 * Both channels are negotiated with fixed ids, so each side creates its own end
 * with no ondatachannel handshake and no offerer/answerer asymmetry. Because
 * they are created before the first createOffer, they appear in the initial SDP
 * and never trigger a renegotiation of their own.
 */

export type DataChannelHandlers = {
  onMessage?: (message: DataChannelMessage) => void;
  onOpen?: () => void;
};

class DataChannelService {
  private fast: RTCDataChannel | null = null;
  private control: RTCDataChannel | null = null;
  private handlers: DataChannelHandlers = {};

  setHandlers(handlers: DataChannelHandlers): void {
    this.handlers = handlers;
  }

  /** Called from webrtcService.initialize(), before any offer is created. */
  attach(peerConnection: RTCPeerConnection): void {
    this.detach();

    // Unreliable and unordered on purpose. Cursor frames are a stream where
    // only the newest matters; a reliable ordered channel would head-of-line
    // block the current position behind the retransmit of one nobody will see.
    this.fast = peerConnection.createDataChannel(FAST_CHANNEL.label, {
      negotiated: true,
      id: FAST_CHANNEL.id,
      ordered: false,
      maxRetransmits: 0,
    });

    // Reliable and ordered. A dropped 'pause' desynchronises playback until
    // someone notices and fixes it by hand.
    this.control = peerConnection.createDataChannel(CONTROL_CHANNEL.label, {
      negotiated: true,
      id: CONTROL_CHANNEL.id,
      ordered: true,
    });

    this.wire(this.fast);
    this.wire(this.control);
  }

  private wire(channel: RTCDataChannel): void {
    channel.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      const message = decodeDataChannelMessage(event.data);
      // Silently dropped: presence is best-effort, and a peer running a
      // modified client should degrade to "their cursor stopped moving", not
      // to an error the user has to read.
      if (!message) return;
      this.handlers.onMessage?.(message);
    };

    channel.onopen = () => {
      logger.debug(`[dc] ${channel.label} open`);
      this.handlers.onOpen?.();
    };

    channel.onerror = (event) => {
      logger.warn(`[dc] ${channel.label} error`, event);
    };
  }

  /**
   * Send, reporting whether the frame actually went out.
   *
   * There is no WebSocket fallback: the server protocol has no presence
   * messages, deliberately. So a false return means the frame is gone, and the
   * caller decides whether that is worth telling the user about — it is for
   * "start watching this video", it is not for a cursor position.
   *
   * The window where this matters is narrow: the channels open with the peer
   * connection and the presence features are only reachable during a live call.
   * The real exposure is a peer connection rebuilt mid-call, where a video-sync
   * action can be lost — accepted, because playback is already desynchronised
   * for as long as the connection is down.
   */
  send(message: DataChannelMessage): boolean {
    const channel = channelFor(message.t) === 'fast' ? this.fast : this.control;
    if (channel?.readyState !== 'open') return false;

    try {
      channel.send(encodeData(message));
      return true;
    } catch (err) {
      logger.debug('[dc] send failed:', err);
      return false;
    }
  }

  get isOpen(): boolean {
    return this.control?.readyState === 'open';
  }

  detach(): void {
    for (const channel of [this.fast, this.control]) {
      if (!channel) continue;
      channel.onmessage = null;
      channel.onopen = null;
      channel.onerror = null;
      try {
        channel.close();
      } catch {
        // Peer connection already torn down.
      }
    }
    this.fast = null;
    this.control = null;
  }
}

export const dataChannelService = new DataChannelService();
