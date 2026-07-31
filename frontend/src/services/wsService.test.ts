import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeWebSocket } from './testDoubles';
import { wsService } from './wsService';
import {
  CLOSE_REPLACED,
  CLOSE_SESSION_FULL,
  CLOSE_UNAUTHORIZED,
} from '@shared/protocol';

const SESSION = 'sess-abc';

/** Join the room and hand back the socket the service opened. */
async function join(existingPeers: string[] = [], isOfferer = true) {
  const pending = wsService.join(SESSION);
  const socket = FakeWebSocket.latest;

  for (const name of existingPeers) {
    socket.receive({ t: 'ExistingPeer', d: { name } });
  }
  socket.receive({
    t: 'Joined',
    d: { you: { userId: 'u1', username: 'ada' }, isOfferer, capacity: 2 },
  });

  return { result: await pending, socket };
}

describe('wsService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.reset();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    wsService.setHandlers({});
  });

  afterEach(() => {
    wsService.leave();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('joining', () => {
    it('opens a session-scoped socket — connecting IS joining', async () => {
      const pending = wsService.join(SESSION);
      const socket = FakeWebSocket.latest;

      expect(socket.url).toMatch(/\/api\/session\/ws\/sess-abc$/);
      // No separate join message. SignalR needed one, and nothing re-sent it
      // after a reconnect, which is how a client ended up connected but
      // outside the room.
      expect(socket.sent).toEqual([]);

      socket.receive({
        t: 'Joined',
        d: { you: { userId: 'u1', username: 'ada' }, isOfferer: false, capacity: 2 },
      });
      await expect(pending).resolves.toMatchObject({ isOfferer: false });
    });

    it('resolves only on Joined, not on the socket opening', async () => {
      const pending = wsService.join(SESSION);
      let settled = false;
      // The catch is not decoration: afterEach leaves the room, which closes a
      // socket that never produced a Joined, and that rejects this promise.
      void pending.then(
        () => {
          settled = true;
        },
        () => {},
      );

      FakeWebSocket.latest.receive({ t: 'PeerJoined', d: { name: 'grace' } });
      await Promise.resolve();
      expect(settled).toBe(false);
    });

    it('carries the server-decided offerer role', async () => {
      const { result } = await join([], true);
      expect(result.isOfferer).toBe(true);
      expect(result.you).toEqual({ userId: 'u1', username: 'ada' });
    });

    /*
     * The server sends ExistingPeer before Joined, so a handler acting on
     * ExistingPeer alone knows a peer is present but not yet whether it is the
     * one who offers. Collecting them into the resolution hands the caller both
     * halves at once.
     */
    it('collects the peers already in the room into the resolution', async () => {
      const { result } = await join(['grace']);
      expect(result.existingPeers).toEqual(['grace']);
    });

    it('reports an empty room as an empty list, not undefined', async () => {
      const { result } = await join([]);
      expect(result.existingPeers).toEqual([]);
    });

    it.each([
      [CLOSE_SESSION_FULL, /full/i],
      [CLOSE_UNAUTHORIZED, /sign in/i],
    ])('rejects close code %i with something worth showing a user', async (code, expected) => {
      const pending = wsService.join(SESSION);
      FakeWebSocket.latest.close(code);
      await expect(pending).rejects.toThrow(expected);
    });

    it('gives up rather than hanging when Joined never arrives', async () => {
      const pending = wsService.join(SESSION);
      const assertion = expect(pending).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(20_000);
      await assertion;
    });
  });

  describe('dispatch', () => {
    it('routes every server frame to its handler', async () => {
      const handlers = {
        onPeerJoined: vi.fn(),
        onPeerLeft: vi.fn(),
        onPeerReconnected: vi.fn(),
        onReceiveOffer: vi.fn(),
        onReceiveAnswer: vi.fn(),
        onReceiveIceCandidate: vi.fn(),
        onReceiveChatMessage: vi.fn(),
        onPeerMediaStateChanged: vi.fn(),
        onScreenShareRequested: vi.fn(),
        onScreenShareResponse: vi.fn(),
        onScreenShareStarted: vi.fn(),
        onScreenShareStopped: vi.fn(),
        onReceiveRenegotiationOffer: vi.fn(),
        onReceiveRenegotiationAnswer: vi.fn(),
      };
      wsService.setHandlers(handlers);
      const { socket } = await join();

      socket.receive({ t: 'PeerJoined', d: { name: 'grace' } });
      socket.receive({ t: 'PeerReconnected', d: { name: 'grace' } });
      socket.receive({ t: 'ReceiveOffer', d: { sdp: 'OFFER', name: 'grace' } });
      socket.receive({ t: 'ReceiveAnswer', d: { sdp: 'ANSWER' } });
      socket.receive({ t: 'ReceiveIceCandidate', d: { c: 'CANDIDATE' } });
      socket.receive({
        t: 'ReceiveChatMessage',
        d: { sender: 'ada', message: 'hi', timestamp: 't' },
      });
      socket.receive({
        t: 'PeerMediaStateChanged',
        d: { name: 'grace', state: { isMuted: true, isCameraOn: false, isScreenSharing: false } },
      });
      socket.receive({ t: 'ScreenShareRequested', d: { name: 'grace' } });
      socket.receive({ t: 'ScreenShareResponse', d: { approved: true, name: 'grace' } });
      socket.receive({ t: 'ScreenShareStarted', d: { name: 'grace', streamId: 's1' } });
      socket.receive({ t: 'ScreenShareStopped', d: { name: 'grace' } });
      socket.receive({ t: 'ReceiveRenegotiationOffer', d: { sdp: 'REOFFER' } });
      socket.receive({ t: 'ReceiveRenegotiationAnswer', d: { sdp: 'REANSWER' } });
      socket.receive({ t: 'PeerLeft', d: { name: 'grace' } });

      expect(handlers.onPeerJoined).toHaveBeenCalledWith('grace');
      expect(handlers.onPeerReconnected).toHaveBeenCalledWith('grace');
      expect(handlers.onReceiveOffer).toHaveBeenCalledWith('OFFER', 'grace');
      expect(handlers.onReceiveAnswer).toHaveBeenCalledWith('ANSWER');
      expect(handlers.onReceiveIceCandidate).toHaveBeenCalledWith('CANDIDATE');
      expect(handlers.onReceiveChatMessage).toHaveBeenCalledWith({
        sender: 'ada',
        message: 'hi',
        timestamp: 't',
      });
      expect(handlers.onPeerMediaStateChanged).toHaveBeenCalledWith('grace', {
        isMuted: true,
        isCameraOn: false,
        isScreenSharing: false,
      });
      expect(handlers.onScreenShareRequested).toHaveBeenCalledWith('grace');
      expect(handlers.onScreenShareResponse).toHaveBeenCalledWith(true, 'grace');
      expect(handlers.onScreenShareStarted).toHaveBeenCalledWith('grace', 's1');
      expect(handlers.onScreenShareStopped).toHaveBeenCalledWith('grace');
      expect(handlers.onReceiveRenegotiationOffer).toHaveBeenCalledWith('REOFFER');
      expect(handlers.onReceiveRenegotiationAnswer).toHaveBeenCalledWith('REANSWER');
      expect(handlers.onPeerLeft).toHaveBeenCalledWith('grace');
    });

    it('survives an unparseable frame instead of tearing down the socket', async () => {
      const onPeerJoined = vi.fn();
      wsService.setHandlers({ onPeerJoined });
      const { socket } = await join();

      socket.receiveRaw('not json {');
      socket.receiveRaw(new ArrayBuffer(4));
      socket.receive({ t: 'PeerJoined', d: { name: 'grace' } });

      expect(onPeerJoined).toHaveBeenCalledWith('grace');
      expect(socket.readyState).toBe(FakeWebSocket.OPEN);
    });

    it('tracks the peer name, which is what the DataChannel has no room for', async () => {
      const { socket } = await join();
      expect(wsService.getPeerName()).toBeNull();

      socket.receive({ t: 'PeerJoined', d: { name: 'grace' } });
      expect(wsService.getPeerName()).toBe('grace');

      socket.receive({ t: 'PeerLeft', d: { name: 'grace' } });
      expect(wsService.getPeerName()).toBeNull();
    });
  });

  describe('sending', () => {
    it('never puts a sessionId in a frame — the socket already is one', async () => {
      const { socket } = await join();

      wsService.send({ t: 'offer', d: { sdp: 'OFFER' } });
      wsService.send({ t: 'ice', d: { c: 'CANDIDATE' } });
      wsService.send({ t: 'chat', d: { m: 'hello' } });

      for (const frame of socket.frames) {
        expect(Object.keys(frame)).toEqual(['t', 'd']);
        expect(JSON.stringify(frame)).not.toContain(SESSION);
      }
    });

    it('does not echo chat back locally — that is the server\'s job', async () => {
      const onReceiveChatMessage = vi.fn();
      wsService.setHandlers({ onReceiveChatMessage });
      await join();

      wsService.send({ t: 'chat', d: { m: 'hello' } });

      // The UI appends nothing on send; a message appears only when the server
      // broadcasts it back. A local echo here would double every message.
      expect(onReceiveChatMessage).not.toHaveBeenCalled();
    });
  });

  describe('reconnection', () => {
    it('reopens after an unclean drop and rejoins by doing so', async () => {
      const onReconnecting = vi.fn();
      const onReconnected = vi.fn();
      wsService.setHandlers({ onReconnecting, onReconnected });
      const { socket } = await join();

      socket.drop();
      expect(onReconnecting).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(600);
      expect(FakeWebSocket.instances).toHaveLength(2);

      FakeWebSocket.latest.receive({
        t: 'Joined',
        d: { you: { userId: 'u1', username: 'ada' }, isOfferer: true, capacity: 2 },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(onReconnected).toHaveBeenCalled();
    });

    it('backs off instead of hammering a server that is not answering', async () => {
      wsService.setHandlers({});
      const { socket } = await join();

      socket.drop();
      await vi.advanceTimersByTimeAsync(600);
      expect(FakeWebSocket.instances).toHaveLength(2);

      // Second attempt fails too; the next retry must wait longer than the first.
      FakeWebSocket.latest.close(1006);
      await vi.advanceTimersByTimeAsync(600);
      expect(FakeWebSocket.instances).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(600);
      expect(FakeWebSocket.instances).toHaveLength(3);
    });

    /*
     * 4000 means another socket took this seat. Retrying would evict that one,
     * which would retry and evict this one, forever — two tabs playing tennis
     * with the session.
     */
    it('stays down when replaced, rather than fighting the other tab', async () => {
      const onFatal = vi.fn();
      const onReconnecting = vi.fn();
      wsService.setHandlers({ onFatal, onReconnecting });
      const { socket } = await join();

      socket.close(CLOSE_REPLACED);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(onFatal).toHaveBeenCalledWith(expect.stringMatching(/another tab/i));
      expect(onReconnecting).not.toHaveBeenCalled();
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    it('holds signalling sent while down, then flushes it on rejoin', async () => {
      wsService.setHandlers({});
      const { socket } = await join();
      socket.drop();

      // A lost ICE candidate can be the difference between a call connecting
      // and not, so these are queued rather than thrown away.
      wsService.send({ t: 'ice', d: { c: 'CANDIDATE-1' } });
      wsService.send({ t: 'ice', d: { c: 'CANDIDATE-2' } });

      await vi.advanceTimersByTimeAsync(600);
      const reopened = FakeWebSocket.latest;
      expect(reopened.sent).toEqual([]);

      reopened.receive({
        t: 'Joined',
        d: { you: { userId: 'u1', username: 'ada' }, isOfferer: true, capacity: 2 },
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(reopened.frames.map((f) => f.d.c)).toEqual(['CANDIDATE-1', 'CANDIDATE-2']);
    });

    it('bounds the queue so a long outage cannot replay minutes of stale signalling', async () => {
      wsService.setHandlers({});
      const { socket } = await join();
      socket.drop();

      for (let i = 0; i < 200; i++) {
        wsService.send({ t: 'ice', d: { c: `CANDIDATE-${i}` } });
      }

      await vi.advanceTimersByTimeAsync(600);
      const reopened = FakeWebSocket.latest;
      reopened.receive({
        t: 'Joined',
        d: { you: { userId: 'u1', username: 'ada' }, isOfferer: true, capacity: 2 },
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(reopened.sent.length).toBeLessThanOrEqual(64);
      // The newest candidates are the ones worth keeping.
      expect(reopened.frames.at(-1)!.d.c).toBe('CANDIDATE-199');
    });

    it('discards the queue on a fatal close so a dead session cannot bleed into the next', async () => {
      wsService.setHandlers({ onFatal: vi.fn() });
      const { socket } = await join();
      socket.drop();
      wsService.send({ t: 'ice', d: { c: 'STALE' } });

      await vi.advanceTimersByTimeAsync(600);
      FakeWebSocket.latest.close(CLOSE_UNAUTHORIZED);
      await vi.advanceTimersByTimeAsync(30_000);

      const opened = FakeWebSocket.instances.length;
      const { socket: fresh } = await join();
      expect(FakeWebSocket.instances.length).toBe(opened + 1);
      expect(fresh.sent).toEqual([]);
    });
  });

  describe('leaving', () => {
    it('says goodbye, closes, and does not come back', async () => {
      const onReconnecting = vi.fn();
      wsService.setHandlers({ onReconnecting });
      const { socket } = await join();

      wsService.leave();

      expect(socket.frames.map((f) => f.t)).toEqual(['leave']);
      expect(socket.readyState).toBe(FakeWebSocket.CLOSED);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(onReconnecting).not.toHaveBeenCalled();
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    it('cancels a reconnect that was already scheduled', async () => {
      wsService.setHandlers({});
      const { socket } = await join();
      socket.drop();

      wsService.leave();
      await vi.advanceTimersByTimeAsync(30_000);

      expect(FakeWebSocket.instances).toHaveLength(1);
    });
  });
});
