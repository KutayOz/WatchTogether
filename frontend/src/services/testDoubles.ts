/**
 * Controllable stand-ins for the two wires.
 *
 * Both are driven by the test rather than by a network: nothing here dials out,
 * and every frame that arrives does so because a test said so. That is what
 * makes "did this message take the WebSocket or the DataChannel?" answerable —
 * which is the question the whole transport split exists to get right.
 */

type Listener = (event: unknown) => void;

export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  /** Every socket the code under test has opened, in order. */
  static instances: FakeWebSocket[] = [];

  static reset(): void {
    FakeWebSocket.instances = [];
  }

  static get latest(): FakeWebSocket {
    const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    if (!socket) throw new Error('no socket was opened');
    return socket;
  }

  readyState: number = FakeWebSocket.CONNECTING;
  /** Raw frames the code under test sent, newest last. */
  readonly sent: string[] = [];

  onmessage: Listener | null = null;
  onclose: Listener | null = null;
  onerror: Listener | null = null;
  onopen: Listener | null = null;

  readonly url: string;

  // Written out rather than declared as a parameter property: the app's
  // tsconfig sets erasableSyntaxOnly, so TypeScript-only syntax that emits code
  // is off the table.
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    // Real sockets do not open synchronously, but every send path here either
    // queues or writes based on readyState, so opening immediately keeps the
    // tests free of timing noise without changing which branch is taken.
    this.readyState = FakeWebSocket.OPEN;
  }

  send(frame: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('socket is not open');
    this.sent.push(frame);
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  /** Deliver a server frame. */
  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  /** Deliver something that is not a frame at all. */
  receiveRaw(data: unknown): void {
    this.onmessage?.({ data });
  }

  /** Drop the connection without a clean close, as a network flap would. */
  drop(code = 1006): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason: '' });
  }

  /** Frames decoded, for asserting on message types. */
  get frames(): Array<{ t: string; d: Record<string, unknown> }> {
    return this.sent.map((raw) => JSON.parse(raw));
  }
}

export class FakeDataChannel {
  readyState: RTCDataChannelState = 'open';
  readonly sent: string[] = [];

  onmessage: ((event: { data: unknown }) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  readonly label: string;
  readonly options: RTCDataChannelInit;

  constructor(label: string, options: RTCDataChannelInit) {
    this.label = label;
    this.options = options;
  }

  send(frame: string): void {
    if (this.readyState !== 'open') throw new Error('channel is not open');
    this.sent.push(frame);
  }

  close(): void {
    this.readyState = 'closed';
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  get frames(): Array<{ t: string; d: Record<string, unknown> }> {
    return this.sent.map((raw) => JSON.parse(raw));
  }
}

/** Just enough RTCPeerConnection to hand out data channels. */
export class FakePeerConnection {
  readonly channels: FakeDataChannel[] = [];

  createDataChannel(label: string, options: RTCDataChannelInit): FakeDataChannel {
    const channel = new FakeDataChannel(label, options);
    this.channels.push(channel);
    return channel;
  }

  channel(label: string): FakeDataChannel {
    const found = this.channels.find((c) => c.label === label);
    if (!found) throw new Error(`no channel labelled ${label}`);
    return found;
  }
}
