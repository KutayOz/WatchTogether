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

  /**
   * Frames decoded, for asserting on message types.
   *
   * Skips anything that is not a protocol envelope, which today means the
   * keepalive: it goes out as the bare string "ping" so the room can answer it
   * from its auto-responder without waking. Assertions here are about what the
   * app said, not about whether the socket was still breathing — `sent` is
   * where the raw traffic lives if a test wants both.
   */
  get frames(): Array<{ t: string; d: Record<string, unknown> }> {
    return this.sent.flatMap((raw) => {
      try {
        return [JSON.parse(raw)];
      } catch {
        return [];
      }
    });
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

let trackSeq = 0;

/** A track that can be told apart by id and kind — enough for sender routing. */
export class FakeMediaStreamTrack {
  readonly kind: 'video' | 'audio';
  readonly id: string;
  readyState: MediaStreamTrackState = 'live';
  contentHint = '';
  enabled = true;
  onended: (() => void) | null = null;

  constructor(kind: 'video' | 'audio', id?: string) {
    this.kind = kind;
    this.id = id ?? `${kind}-${++trackSeq}`;
  }

  stop(): void {
    this.readyState = 'ended';
  }

  /**
   * Every applyConstraints() call, newest last.
   *
   * Recorded rather than swallowed: a capture track that had been clamped to
   * 720p once stayed 720p for the rest of the session because the re-apply path
   * only ever sent frameRate, and with a no-op double there was nothing a test
   * could assert to notice.
   */
  readonly constraints: MediaTrackConstraints[] = [];

  async applyConstraints(constraints?: MediaTrackConstraints): Promise<void> {
    this.constraints.push(structuredClone(constraints ?? {}));
  }

  /** The most recent constraint set, or null if never constrained. */
  get lastConstraints(): MediaTrackConstraints | null {
    return this.constraints[this.constraints.length - 1] ?? null;
  }

  private listeners = new Map<string, Array<(event?: unknown) => void>>();

  addEventListener(type: string, listener: (event?: unknown) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  /** Fire a track event, e.g. 'configurationchange' after a surface swap. */
  emit(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

export class FakeMediaStream {
  readonly id: string;
  private tracks: FakeMediaStreamTrack[];

  constructor(tracks: FakeMediaStreamTrack[], id = `stream-${++trackSeq}`) {
    this.tracks = [...tracks];
    this.id = id;
  }

  getTracks(): FakeMediaStreamTrack[] {
    return [...this.tracks];
  }
  getVideoTracks(): FakeMediaStreamTrack[] {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  getAudioTracks(): FakeMediaStreamTrack[] {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  addTrack(track: FakeMediaStreamTrack): void {
    if (!this.tracks.includes(track)) this.tracks.push(track);
  }
  removeTrack(track: FakeMediaStreamTrack): void {
    this.tracks = this.tracks.filter((t) => t !== track);
  }
}

/**
 * Records what the code under test asked the encoder for.
 *
 * getParameters() hands back a *copy*, exactly like the real API — code that
 * mutates the returned object and never calls setParameters must not appear to
 * have configured anything, or the test would pass on a no-op.
 */
export class FakeRtpSender {
  track: FakeMediaStreamTrack | null;
  /** Every setParameters() call, newest last. */
  readonly applied: RTCRtpSendParameters[] = [];
  private params: RTCRtpSendParameters = { encodings: [{}] } as RTCRtpSendParameters;

  constructor(track: FakeMediaStreamTrack) {
    this.track = track;
  }

  getParameters(): RTCRtpSendParameters {
    return structuredClone(this.params);
  }

  async setParameters(params: RTCRtpSendParameters): Promise<void> {
    this.params = structuredClone(params);
    this.applied.push(structuredClone(params));
  }

  async replaceTrack(track: FakeMediaStreamTrack | null): Promise<void> {
    this.track = track;
  }

  /** Current encoder ceiling in bps, or undefined if never set. */
  get maxBitrate(): number | undefined {
    return this.params.encodings?.[0]?.maxBitrate;
  }

  get networkPriority(): string | undefined {
    return (this.params.encodings?.[0] as { networkPriority?: string })?.networkPriority;
  }

  get scaleResolutionDownBy(): number | undefined {
    return this.params.encodings?.[0]?.scaleResolutionDownBy;
  }

  get maxFramerate(): number | undefined {
    return this.params.encodings?.[0]?.maxFramerate;
  }

  /** Stats this sender will report. Set by the test; empty by default. */
  stats: RTCStatsReport = new Map() as unknown as RTCStatsReport;

  async getStats(): Promise<RTCStatsReport> {
    return this.stats;
  }
}

/** Build a stats report from plain objects, keyed by their `id`. */
export function fakeStatsReport(
  entries: Array<Record<string, unknown> & { id: string; type: string }>,
): RTCStatsReport {
  return new Map(entries.map((e) => [e.id, e])) as unknown as RTCStatsReport;
}

/** Records the codec order the code under test asked to offer. */
export class FakeRtpTransceiver {
  readonly sender: FakeRtpSender;
  /** Codec order from the last setCodecPreferences call, or null if never set. */
  codecPreferences: RTCRtpCodec[] | null = null;

  constructor(sender: FakeRtpSender) {
    this.sender = sender;
  }

  setCodecPreferences(codecs: RTCRtpCodec[]): void {
    this.codecPreferences = [...codecs];
  }
}

/** Just enough RTCPeerConnection to hand out data channels and senders. */
export class FakePeerConnection {
  readonly channels: FakeDataChannel[] = [];
  readonly senders: FakeRtpSender[] = [];
  readonly transceivers: FakeRtpTransceiver[] = [];

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

  addTrack(track: FakeMediaStreamTrack): FakeRtpSender {
    const sender = new FakeRtpSender(track);
    this.senders.push(sender);
    // Real addTrack creates (or reuses) a transceiver for the sender. Codec
    // preferences live there, not on the sender.
    this.transceivers.push(new FakeRtpTransceiver(sender));
    return sender;
  }

  getTransceivers(): FakeRtpTransceiver[] {
    return [...this.transceivers];
  }

  /** The transceiver whose sender carries a given track id. */
  transceiverFor(trackId: string): FakeRtpTransceiver {
    const found = this.transceivers.find((t) => t.sender.track?.id === trackId);
    if (!found) throw new Error(`no transceiver for track ${trackId}`);
    return found;
  }

  /** Real removeTrack leaves the sender in place with a null track. */
  removeTrack(sender: FakeRtpSender): void {
    sender.track = null;
  }

  getSenders(): FakeRtpSender[] {
    return [...this.senders];
  }

  /** ICE state, so the diagnostics dump has something honest to report. */
  iceGatheringState: RTCIceGatheringState = 'complete';
  iceConnectionState: RTCIceConnectionState = 'connected';
  signalingState: RTCSignalingState = 'stable';

  /**
   * Assigned by the service, invoked by the test.
   *
   * A connection that stays 'failed' emits no further state change, so recovery
   * that only reacts to this event can never fire twice on its own — which is
   * exactly the latch this lets a test reproduce.
   */
  oniceconnectionstatechange: (() => void) | null = null;

  /** Options every createOffer was called with, newest last. */
  readonly offers: RTCOfferOptions[] = [];
  localDescription: RTCSessionDescriptionInit | null = null;

  async createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    this.offers.push(options ?? {});
    return { type: 'offer', sdp: 'v=0\r\n' };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description;
  }

  /** Connection-wide stats. Set by the test; empty by default. */
  stats: RTCStatsReport = new Map() as unknown as RTCStatsReport;

  async getStats(): Promise<RTCStatsReport> {
    return this.stats;
  }

  /** Whether close() was called — initialize must not orphan a live one. */
  closed = false;

  close(): void {
    this.closed = true;
  }
}

/**
 * A getDisplayMedia stub, so what captureScreen actually ASKS FOR is testable.
 *
 * It had no coverage at all, which is how it shipped requesting
 * `max: 3840/2160/60` for every quality preset — on a 4K desktop that means the
 * track arrives at 3840x2160 and the quality scaler steps down through 1080p
 * rather than defending it.
 *
 * Returns the stream and records every constraint set it was called with.
 */
export function stubDisplayMedia(stream: FakeMediaStream): {
  calls: DisplayMediaStreamOptions[];
} {
  const calls: DisplayMediaStreamOptions[] = [];
  const existing = globalThis.navigator.mediaDevices as MediaDevices | undefined;
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      ...existing,
      getDisplayMedia: async (constraints?: DisplayMediaStreamOptions) => {
        calls.push(structuredClone(constraints ?? {}));
        return stream as unknown as MediaStream;
      },
    },
  });
  return { calls };
}
