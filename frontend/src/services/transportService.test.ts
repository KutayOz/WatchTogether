import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePeerConnection, FakeWebSocket } from './testDoubles';
import { dataChannelService } from './dataChannelService';
import { transportService } from './transportService';
import { CONTROL_CHANNEL, FAST_CHANNEL } from '@shared/dataChannelProtocol';

const SESSION = 'sess-abc';

async function connect() {
  const pending = transportService.joinSession(SESSION);
  const socket = FakeWebSocket.latest;
  socket.receive({ t: 'PeerJoined', d: { name: 'grace' } });
  socket.receive({
    t: 'Joined',
    d: { you: { userId: 'u1', username: 'ada' }, isOfferer: true, capacity: 2 },
  });
  await pending;

  const peer = new FakePeerConnection();
  dataChannelService.attach(peer as unknown as RTCPeerConnection);
  return { socket, peer };
}

describe('transportService', () => {
  beforeEach(() => {
    FakeWebSocket.reset();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    transportService.setHandlers({});
  });

  afterEach(() => {
    transportService.leaveSession(SESSION);
    dataChannelService.detach();
    vi.unstubAllGlobals();
  });

  /*
   * The whole reason the transport is split in two.
   *
   * Every inbound WebSocket message bills one Durable Object request against
   * 100,000 a day. Cursors alone run at 10Hz — about 18,000 per sender across a
   * 30-minute screen-share. If any of these five ever drift back onto the
   * socket, the free plan stops being free and nothing else in the app will
   * look wrong.
   */
  describe('the split', () => {
    it('keeps presence traffic off the billable wire', async () => {
      const { socket, peer } = await connect();

      await transportService.notifyCursor(SESSION, 0.5, 0.5);
      await transportService.notifyTyping(SESSION);
      await transportService.notifyReaction(SESSION, '🩷');
      await transportService.notifyVideoSync(SESSION, 'play', '12');
      await transportService.sendQualityFeedback(SESSION, {
        level: 'good',
        score: 80,
        packetLossPercent: 0,
        jitterMs: 5,
        rttMs: 30,
        fps: 30,
      });

      expect(socket.sent).toEqual([]);

      const peerFrames = [
        ...peer.channel(FAST_CHANNEL.label).frames,
        ...peer.channel(CONTROL_CHANNEL.label).frames,
      ];
      expect(peerFrames.map((f) => f.t).sort()).toEqual([
        'cursor',
        'quality',
        'reaction',
        'typing',
        'videoSync',
      ]);
    });

    it('keeps signalling and chat on the wire that survives a dead peer connection', async () => {
      const { socket, peer } = await connect();

      await transportService.sendOffer(SESSION, 'OFFER');
      await transportService.sendAnswer(SESSION, 'ANSWER');
      await transportService.sendIceCandidate(SESSION, 'CANDIDATE');
      await transportService.sendRenegotiationOffer(SESSION, 'REOFFER');
      await transportService.sendRenegotiationAnswer(SESSION, 'REANSWER');
      await transportService.sendChatMessage(SESSION, 'i cannot see you');
      await transportService.notifyMediaStateChange(SESSION, {
        isMuted: true,
        isCameraOn: false,
        isScreenSharing: false,
      });
      await transportService.requestScreenShare(SESSION);
      await transportService.respondScreenShare(SESSION, true);
      await transportService.notifyScreenShareStarted(SESSION, 'stream-1');
      await transportService.stopScreenShare(SESSION);

      expect(socket.frames.map((f) => f.t)).toEqual([
        'offer',
        'answer',
        'ice',
        'reoffer',
        'reanswer',
        'chat',
        'media',
        'ss:req',
        'ss:res',
        'ss:start',
        'ss:stop',
      ]);

      for (const channel of peer.channels) {
        expect(channel.sent).toEqual([]);
      }
    });

    /*
     * Chat is the deliberate exception. It is low volume, and it has to keep
     * working when the peer connection does not — which is precisely when
     * someone needs to type "I can't see you".
     */
    it('leaves chat on the socket even with the peer channel wide open', async () => {
      const { socket, peer } = await connect();
      expect(transportService.isPeerChannelOpen).toBe(true);

      await transportService.sendChatMessage(SESSION, 'hello');

      expect(socket.frames.map((f) => f.t)).toEqual(['chat']);
      expect(peer.channel(CONTROL_CHANNEL.label).sent).toEqual([]);
    });

    it('measures the saving on a 30-minute screen-share', async () => {
      const { socket } = await connect();

      // usePeerPresence throttles cursors to ~10Hz; 30 minutes of one sender.
      for (let i = 0; i < 18_000; i++) {
        await transportService.notifyCursor(SESSION, i / 18_000, 0.5);
      }

      // Over a third of the daily Durable Object budget, from one participant
      // of one call, before this phase.
      expect(socket.sent).toHaveLength(0);
    });
  });

  describe('channel choice', () => {
    it('sends cursors unreliably and everything else in order', async () => {
      const { peer } = await connect();

      const fast = peer.channel(FAST_CHANNEL.label);
      const control = peer.channel(CONTROL_CHANNEL.label);

      // Only the newest cursor matters, so a retransmit would head-of-line
      // block a position nobody will ever see.
      expect(fast.options).toMatchObject({ ordered: false, maxRetransmits: 0 });
      // A dropped 'pause' desynchronises playback until a human fixes it.
      expect(control.options).toMatchObject({ ordered: true });

      await transportService.notifyCursor(SESSION, 0.1, 0.2);
      await transportService.notifyVideoSync(SESSION, 'pause', '3');

      expect(fast.frames.map((f) => f.t)).toEqual(['cursor']);
      expect(control.frames.map((f) => f.t)).toEqual(['videoSync']);
    });

    it('negotiates both channels with fixed ids so neither end waits for the other', async () => {
      const { peer } = await connect();

      for (const channel of peer.channels) {
        expect(channel.options.negotiated).toBe(true);
        expect(typeof channel.options.id).toBe('number');
      }
    });

    it('refuses an action the peer would silently drop', async () => {
      await connect();
      await expect(transportService.notifyVideoSync(SESSION, 'destroy', '')).resolves.toBe(false);
      await expect(transportService.notifyVideoSync(SESSION, 'play', '1')).resolves.toBe(true);
    });

    it('reports the frame as lost when the peer channel is not up yet', async () => {
      const pending = transportService.joinSession(SESSION);
      FakeWebSocket.latest.receive({
        t: 'Joined',
        d: { you: { userId: 'u1', username: 'ada' }, isOfferer: true, capacity: 2 },
      });
      await pending;

      // No peer connection, so nothing to send over. Callers that care — "start
      // watching this" — can say so; a cursor cannot.
      await expect(transportService.notifyVideoSync(SESSION, 'load', 'abc')).resolves.toBe(false);
      expect(transportService.isPeerChannelOpen).toBe(false);
    });
  });

  describe('receiving from the peer', () => {
    it('names the sender from what the server told us, not from the frame', async () => {
      const handlers = {
        onPeerCursor: vi.fn(),
        onPeerTyping: vi.fn(),
        onPeerReaction: vi.fn(),
        onPeerVideoSync: vi.fn(),
        onReceiveQualityFeedback: vi.fn(),
      };
      transportService.setHandlers(handlers);
      const { peer } = await connect();

      const fast = peer.channel(FAST_CHANNEL.label);
      const control = peer.channel(CONTROL_CHANNEL.label);

      fast.receive({ t: 'cursor', d: { x: 0.25, y: 0.75 } });
      control.receive({ t: 'typing', d: {} });
      control.receive({ t: 'reaction', d: { emoji: '🩷' } });
      control.receive({ t: 'videoSync', d: { action: 'seek', payload: '30' } });
      control.receive({
        t: 'quality',
        d: {
          feedback: {
            level: 'critical',
            score: 10,
            packetLossPercent: 12,
            jitterMs: 90,
            rttMs: 400,
            fps: 4,
          },
        },
      });

      // A direct link to exactly one peer, whose name the server already gave
      // us — putting it in a 10Hz frame would re-send what we know and create a
      // second source of truth for it.
      expect(handlers.onPeerCursor).toHaveBeenCalledWith('grace', 0.25, 0.75);
      expect(handlers.onPeerTyping).toHaveBeenCalledWith('grace');
      expect(handlers.onPeerReaction).toHaveBeenCalledWith('grace', '🩷');
      expect(handlers.onPeerVideoSync).toHaveBeenCalledWith('grace', 'seek', '30');
      expect(handlers.onReceiveQualityFeedback).toHaveBeenCalledWith(
        'grace',
        expect.objectContaining({ level: 'critical' }),
      );
    });

    it('drops a malformed peer frame instead of feeding it to React state', async () => {
      const onPeerCursor = vi.fn();
      const onPeerReaction = vi.fn();
      transportService.setHandlers({ onPeerCursor, onPeerReaction });
      const { peer } = await connect();

      peer.channel(FAST_CHANNEL.label).receive({ t: 'cursor', d: { x: 42, y: -1 } });
      peer.channel(CONTROL_CHANNEL.label).receive({ t: 'reaction', d: { emoji: '' } });
      peer.channel(CONTROL_CHANNEL.label).onmessage?.({ data: 'not json {' });

      expect(onPeerCursor).not.toHaveBeenCalled();
      expect(onPeerReaction).not.toHaveBeenCalled();
    });

    it('falls back to a placeholder name rather than throwing when no peer is known', async () => {
      const onPeerTyping = vi.fn();
      transportService.setHandlers({ onPeerTyping });

      const pending = transportService.joinSession(SESSION);
      FakeWebSocket.latest.receive({
        t: 'Joined',
        d: { you: { userId: 'u1', username: 'ada' }, isOfferer: true, capacity: 2 },
      });
      await pending;

      const peer = new FakePeerConnection();
      dataChannelService.attach(peer as unknown as RTCPeerConnection);
      peer.channel(CONTROL_CHANNEL.label).receive({ t: 'typing', d: {} });

      expect(onPeerTyping).toHaveBeenCalledWith('peer');
    });
  });

  describe('teardown', () => {
    it('closes both channels and stops delivering their frames', async () => {
      const onPeerTyping = vi.fn();
      transportService.setHandlers({ onPeerTyping });
      const { peer } = await connect();

      const control = peer.channel(CONTROL_CHANNEL.label);
      dataChannelService.detach();

      expect(control.readyState).toBe('closed');
      expect(control.onmessage).toBeNull();
      expect(transportService.isPeerChannelOpen).toBe(false);
      expect(onPeerTyping).not.toHaveBeenCalled();
    });

    it('replaces the old channels when a peer connection is rebuilt', async () => {
      const { peer: first } = await connect();
      const stale = first.channel(CONTROL_CHANNEL.label);

      const second = new FakePeerConnection();
      dataChannelService.attach(second as unknown as RTCPeerConnection);

      expect(stale.readyState).toBe('closed');
      await transportService.notifyTyping(SESSION);
      expect(stale.sent).toEqual([]);
      expect(second.channel(CONTROL_CHANNEL.label).frames.map((f) => f.t)).toEqual(['typing']);
    });
  });
});
