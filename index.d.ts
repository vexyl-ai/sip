// ============================================================================
// @vexyl.ai/sip — TypeScript Type Definitions
// T-21: TypeScript type definitions
// ============================================================================

import { EventEmitter } from 'events';

// ============================================================================
// SIP Core (sip.js)
// ============================================================================

export interface SipUri {
  schema?: string;
  user?: string;
  password?: string;
  host: string;
  port?: number;
  params?: Record<string, string | undefined>;
  headers?: Record<string, string>;
}

export interface SipVia {
  version?: string;
  protocol?: string;
  host?: string;
  port?: number;
  params?: Record<string, string | undefined>;
}

export interface SipAOR {
  name?: string;
  uri: string;
  params?: Record<string, string | undefined>;
}

export interface SipCSeq {
  method: string;
  seq: number;
}

export interface SipHeaders {
  via?: SipVia[];
  to?: SipAOR;
  from?: SipAOR;
  contact?: SipAOR[];
  'call-id'?: string;
  cseq?: SipCSeq;
  'content-type'?: string;
  'content-length'?: number;
  route?: SipAOR[];
  'record-route'?: SipAOR[];
  allow?: string;
  reason?: SipReasonHeader;
  'www-authenticate'?: SipAuthHeader[];
  'proxy-authenticate'?: SipAuthHeader[];
  authorization?: SipAuthHeader[];
  'proxy-authorization'?: SipAuthHeader[];
  'authentication-info'?: SipAuthInfo;
  [key: string]: any;
}

export interface SipRequest {
  method: string;
  uri: string | SipUri;
  version?: string;
  headers: SipHeaders;
  content?: string;
}

export interface SipResponse {
  status: number;
  reason: string;
  version?: string;
  headers: SipHeaders;
  content?: string;
}

export type SipMessage = SipRequest | SipResponse;

export interface SipReasonHeader {
  protocol: string;
  cause: number;
  text?: string;
}

export interface SipAuthHeader {
  scheme: string;
  realm?: string;
  nonce?: string;
  opaque?: string;
  algorithm?: string;
  qop?: string;
  domain?: string;
  username?: string;
  uri?: string;
  nc?: string;
  cnonce?: string;
  response?: string;
}

export interface SipAuthInfo {
  qop?: string;
  cnonce?: string;
  nc?: string;
  rspauth?: string;
  nextnonce?: string;
}

export interface SipLoggerOptions {
  send?(msg: string, target: any): void;
  recv?(msg: string, remote: any): void;
  error?(err: any): void;
}

export interface SipStartOptions {
  port?: number;
  address?: string;
  publicAddress?: string;
  hostname?: string;
  udp?: boolean;
  tcp?: boolean;
  tls?: { key: string | Buffer; cert: string | Buffer; [key: string]: any };
  tls_port?: number;
  ws_port?: number;
  rport?: boolean;
  timerA?: number;
  timerB?: number;
  ringTimeLimit?: number;
  cancelTimeout?: number;
  maxBytesHeaders?: number;
  maxContentLength?: number;
  logger?: SipLoggerOptions;
}

export interface SipRemoteInfo {
  protocol: string;
  address: string;
  port: number;
  local?: { address: string; port: number };
}

export type SipRequestCallback = (request: SipRequest, remote: SipRemoteInfo) => void;
export type SipResponseCallback = (response: SipResponse) => void;

export interface SipInstance {
  send(message: SipMessage, callback?: SipResponseCallback): void;
  encodeFlowUri(flow: SipRemoteInfo): SipUri;
  decodeFlowUri(uri: string | SipUri): SipRemoteInfo | undefined;
  isFlowUri(uri: string | SipUri): boolean;
  hostname(): string;
  destroy(): void;
}

// Core functions
export function start(options: SipStartOptions, onRequest: SipRequestCallback): void;
export function stop(): void;
export function create(options: SipStartOptions, onRequest: SipRequestCallback): SipInstance;
export function send(message: SipMessage, callback?: SipResponseCallback): void;
export function parse(data: string | Buffer): SipMessage;
export function stringify(message: SipMessage): string;
export function parseUri(uri: string): SipUri | undefined;
export function stringifyUri(uri: SipUri): string;
export function parseAOR(data: { s: string; i: number }): SipAOR;
export function makeResponse(request: SipRequest, status: number, reason?: string, extension?: Partial<SipResponse>): SipResponse;
export function copyMessage(msg: SipMessage, deep?: boolean): SipMessage;
export function generateBranch(): string;
export function generateTag(): string;

// 6xx Global Failure
export function isGlobalFailure(status: number): boolean;
export function makeDeclineResponse(request: SipRequest, text?: string): SipResponse;
export function makeUnwantedResponse(request: SipRequest, text?: string): SipResponse;
export function makeRejectedResponse(request: SipRequest, text?: string): SipResponse;

// ============================================================================
// SDP (sdp.js)
// ============================================================================

export namespace sdp {
  interface SdpOrigin {
    username: string;
    id: string | number;
    version: string | number;
    nettype: string;
    addrtype: string;
    address: string;
  }

  interface SdpConnection {
    nettype: string;
    addrtype: string;
    address: string;
  }

  interface SdpMedia {
    media: string;
    port: number;
    portnum?: number;
    proto: string;
    fmt: number[];
    c?: SdpConnection;
    a?: string[];
    b?: string;
    k?: string;
    i?: string;
  }

  interface SdpObject {
    v?: number | string;
    o?: SdpOrigin;
    s?: string;
    i?: string;
    u?: string;
    e?: string;
    p?: string;
    c?: SdpConnection;
    b?: string;
    t?: string;
    r?: string;
    z?: string;
    k?: string;
    a?: string[];
    m: SdpMedia[];
  }

  function parse(sdpString: string): SdpObject;
  function stringify(sdpObj: SdpObject): string;
  function setConnectionAddress(sdpObj: SdpObject, publicAddress: string): SdpObject;
}

// ============================================================================
// Digest Auth (digest.js)
// ============================================================================

export namespace digest {
  interface DigestContext {
    proxy?: boolean;
    realm?: string;
    user?: string;
    password?: string;
    userhash?: string;
    ha1?: string;
    nonce?: string;
    cnonce?: string;
    nc?: number;
    qop?: string;
    algorithm?: string;
    opaque?: string;
    uri?: string;
    domain?: string;
  }

  interface Credentials {
    user: string;
    password?: string;
    hash?: string;
    realm?: string;
  }

  function kd(...args: string[]): string;
  function calculateUserRealmPasswordHash(user: string, realm: string, password: string): string;
  function calculateHA1(ctx: DigestContext): string;
  function calculateDigest(ctx: DigestContext & { method: string; uri: string; entity?: string }): string;
  function generateNonce(tag: string, timestamp?: Date): string;
  function extractNonceTimestamp(nonce: string, tag: string): Date | false;
  function challenge(ctx: DigestContext, response: SipResponse): SipResponse;
  function authenticateRequest(ctx: DigestContext, request: SipRequest, credentials: Credentials): boolean;
  function signResponse(ctx: DigestContext, response: SipResponse): SipResponse;
  function signRequest(ctx: DigestContext, request: SipRequest, response: SipResponse | null, credentials: Credentials): DigestContext | null;
  function authenticateResponse(ctx: DigestContext, response: SipResponse): boolean | undefined;
}

// ============================================================================
// RTP (rtp.js)
// ============================================================================

export namespace rtp {
  interface RtpHeader {
    version: number;
    padding: number;
    extension: number;
    csrcCount: number;
    marker: number;
    payloadType: number;
    sequenceNumber: number;
    timestamp: number;
    ssrc: number;
    headerLength: number;
    payload: Buffer;
    pcm?: Buffer;
  }

  interface Codec {
    name: string;
    decode(buf: Buffer): Buffer;
    encode(buf: Buffer): Buffer;
    sampleRate: number;
    frameDuration: number;
    frameSize: number;
  }

  interface PortPoolStats {
    available: number;
    inUse: number;
    total: number;
  }

  interface RtpSessionOptions {
    port?: number;
    address?: string;
    remoteAddress?: string;
    remotePort?: number;
    payloadType?: number;
    ssrc?: number;
    symmetricRtp?: boolean;
    jitterBuffer?: boolean | JitterBufferOptions;
    pool?: PortPool;
    minPort?: number;
    maxPort?: number;
  }

  interface JitterBufferOptions {
    bufferMs?: number;
    maxSize?: number;
    frameDuration?: number;
  }

  interface RtpStats {
    packetsReceived: number;
    packetsSent: number;
    bytesReceived: number;
    bytesSent: number;
    packetsLost: number;
    localPort: number;
    remoteAddress: string;
    remotePort: number;
    ssrc: number;
    remoteSSRC: number | null;
    jitterBufferLength: number;
  }

  class PortPool {
    constructor(minPort?: number, maxPort?: number);
    allocate(): number | null;
    release(port: number): void;
    stats(): PortPoolStats;
  }

  class JitterBuffer {
    constructor(options?: JitterBufferOptions);
    put(packet: RtpHeader): void;
    get(): RtpHeader | null;
    reset(): void;
    length(): number;
  }

  class RtpSession extends EventEmitter {
    localPort: number | null;
    remoteAddress: string | null;
    remotePort: number | null;
    payloadType: number;
    ssrc: number;
    remoteSSRC: number | null;
    active: boolean;
    sequenceNumber: number;
    timestamp: number;

    constructor(options?: RtpSessionOptions);
    start(callback?: (err: Error | null, addr?: { address: string; port: number }) => void): void;
    stop(): void;
    sendPayload(payload: Buffer, options?: { payloadType?: number; marker?: number }): void;
    sendPcm(pcmBuffer: Buffer): void;
    sendPcmPaced(pcmBuffer: Buffer, callback?: () => void): void;
    enqueuePcm(pcmBuffer: Buffer): void;
    getRemote(): { address: string; port: number };
    getStats(): RtpStats;

    on(event: 'audio', listener: (pcm: Buffer, header: RtpHeader) => void): this;
    on(event: 'ready', listener: (addr: { address: string; port: number }) => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: 'close', listener: () => void): this;
    on(event: 'sendComplete', listener: () => void): this;
  }

  function parseRtpHeader(buf: Buffer): RtpHeader | null;
  function buildRtpPacket(header: Partial<RtpHeader>, payload: Buffer): Buffer;
  function createSession(options?: RtpSessionOptions): RtpSession;
  function getDefaultPool(minPort?: number, maxPort?: number): PortPool;

  function pcmuDecode(buf: Buffer): Buffer;
  function pcmuEncode(buf: Buffer): Buffer;
  function pcmaDecode(buf: Buffer): Buffer;
  function pcmaEncode(buf: Buffer): Buffer;

  const codecs: Record<number, Codec>;
}

// ============================================================================
// DTMF (dtmf.js)
// ============================================================================

export namespace dtmf {
  interface Rfc2833Event {
    event: number;
    digit: string;
    end: boolean;
    volume: number;
    duration: number;
  }

  interface SipInfoDtmf {
    digit: string;
    duration: number;
    method: 'sip-info';
  }

  interface DtmfDetectorOptions {
    rfc2833PayloadType?: number;
    rfc2833?: boolean;
    goertzel?: boolean | GoertzelOptions;
  }

  interface GoertzelOptions {
    sampleRate?: number;
    blockSize?: number;
    threshold?: number;
    twistLimit?: number;
    minDuration?: number;
  }

  class Rfc2833Detector {
    process(rtpHeader: rtp.RtpHeader): string | null;
    reset(): void;
  }

  class GoertzelDetector {
    constructor(options?: GoertzelOptions);
    process(pcmBuffer: Buffer): string[];
    reset(): void;
  }

  class DtmfDetector extends EventEmitter {
    constructor(options?: DtmfDetectorOptions);
    processRtp(rtpHeader: rtp.RtpHeader): string | null;
    processSipInfo(request: SipRequest): string | null;
    reset(): void;

    on(event: 'digit', listener: (digit: string, method: 'rfc2833' | 'sip-info' | 'goertzel') => void): this;
  }

  function parseRfc2833(payload: Buffer): Rfc2833Event | null;
  function buildRfc2833(digit: string, end: boolean, volume: number, duration: number): Buffer | null;
  function parseSipInfoDtmf(request: SipRequest): SipInfoDtmf | null;
  function buildSipInfoDtmf(digit: string, duration?: number): { contentType: string; body: string };

  const EVENT_TO_DIGIT: Record<number, string>;
  const DIGIT_TO_EVENT: Record<string, number>;
  const DTMF_FREQS_LOW: number[];
  const DTMF_FREQS_HIGH: number[];
}

// ============================================================================
// Dialog (dialog.js)
// ============================================================================

export namespace dialog {
  interface DialogOptions {
    callId?: string;
    direction?: 'inbound' | 'outbound';
    request?: SipRequest;
    localTag?: string;
    remoteTag?: string;
    localUri?: string;
    remoteUri?: string;
    sipSend?: Function;
    sipMakeResponse?: Function;
    sipOptions?: SipStartOptions;
    rtp?: Partial<rtp.RtpSessionOptions>;
    dtmf?: dtmf.DtmfDetectorOptions;
  }

  interface AcceptOptions {
    payloadType?: number;
    rtpPort?: number;
    pool?: rtp.PortPool;
  }

  interface DialogStats {
    id: string;
    direction: 'inbound' | 'outbound';
    state: string;
    rtp: rtp.RtpStats | null;
  }
}

export class Dialog extends EventEmitter {
  id: string;
  direction: 'inbound' | 'outbound';
  state: 'init' | 'trying' | 'ringing' | 'active' | 'held' | 'ended';
  request: SipRequest | null;
  localTag: string | null;
  remoteTag: string | null;
  rtpSession: rtp.RtpSession | null;
  remoteSdp: sdp.SdpObject | null;
  localSdp: sdp.SdpObject | null;

  constructor(options?: dialog.DialogOptions);

  // Inbound call flow
  trying(): Promise<void>;
  ringing(): Promise<void>;
  accept(options?: dialog.AcceptOptions): Promise<Dialog>;
  reject(status?: number, reason?: string): Promise<void>;
  decline(text?: string): Promise<void>;

  // Active call operations
  sendAudio(pcmBuffer: Buffer): void;
  sendAudioPaced(pcmBuffer: Buffer): Promise<void>;
  enqueueAudio(pcmBuffer: Buffer): void;
  sendDtmf(digit: string, duration?: number): void;
  bye(): Promise<SipResponse | void>;

  // T-26: Hold/Unhold (re-INVITE)
  hold(): Promise<void>;
  unhold(): Promise<void>;

  // T-27: Call transfer
  refer(targetUri: string): Promise<SipResponse>;

  // Stats
  getStats(): dialog.DialogStats;

  // Events
  on(event: 'audio', listener: (pcm: Buffer, header: rtp.RtpHeader) => void): this;
  on(event: 'dtmf', listener: (digit: string, method: 'rfc2833' | 'sip-info' | 'goertzel') => void): this;
  on(event: 'end', listener: (reason: string) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'ready', listener: () => void): this;
  on(event: 'response', listener: (rs: SipResponse) => void): this;
  on(event: 'reinvite', listener: (request: SipRequest) => void): this;
  on(event: 'refer', listener: (targetUri: string, request: SipRequest) => void): this;
  on(event: 'transferred', listener: (targetUri: string) => void): this;
  on(event: 'hold', listener: () => void): this;
  on(event: 'unhold', listener: () => void): this;
  on(event: 'notify', listener: (request: SipRequest) => void): this;
}

// ============================================================================
// SipStack (stack.js)
// ============================================================================

export interface SipStackOptions extends SipStartOptions {
  rtpPortMin?: number;
  rtpPortMax?: number;
  dtmf?: dtmf.DtmfDetectorOptions;
  // T-25: Digest auth credentials
  credentials?: { user: string; password: string; realm?: string };
  // T-28: OPTIONS keepalive
  keepaliveTargets?: Array<{ uri: string; interval?: number }>;
  // T-31: IP whitelist
  allowedIps?: string[];
  // T-32: Rate limiting
  maxConcurrentCalls?: number;
}

export interface CallOptions {
  callId?: string;
  fromUri?: string;
  payloadType?: number;
  headers?: Record<string, any>;
  dtmf?: dtmf.DtmfDetectorOptions;
  credentials?: { user: string; password: string; realm?: string };
}

export interface StackStats {
  active: boolean;
  dialogs: number;
  maxConcurrentCalls: number;
  rtpPorts: rtp.PortPoolStats | null;
}

export class SipStack extends EventEmitter {
  options: SipStackOptions;
  active: boolean;

  constructor(options?: SipStackOptions);

  start(): Promise<void>;
  stop(): Promise<void>;
  call(uri: string, options?: CallOptions): Promise<Dialog>;
  send(message: SipMessage, callback?: SipResponseCallback): void;

  // T-27: Call transfer
  transfer(callId: string, targetUri: string): Promise<SipResponse>;

  // T-28: OPTIONS keepalive
  sendOptions(uri: string): void;

  // T-31: IP whitelist
  allowIp(ip: string): void;
  removeIp(ip: string): void;
  getAllowedIps(): string[] | null;
  disableIpWhitelist(): void;

  // T-32: Rate limiting
  setMaxConcurrentCalls(max: number): void;
  getMaxConcurrentCalls(): number;

  getDialogs(): Record<string, Dialog>;
  getDialog(callId: string): Dialog | null;
  getStats(): StackStats;

  on(event: 'invite', listener: (dialog: Dialog, remote: SipRemoteInfo) => void): this;
  on(event: 'message', listener: (request: SipRequest, remote: SipRemoteInfo) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'started', listener: () => void): this;
  on(event: 'stopped', listener: () => void): this;
}

// ============================================================================
// VEXYL SIP Bridge (vexyl-sip-bridge.js)
// ============================================================================

export interface VexylSipBridgeConfig {
  sipPort?: number;
  SIP_PORT?: string | number;
  publicAddress?: string;
  PUBLIC_ADDRESS?: string;
  SIP_PUBLIC_ADDRESS?: string;
  sipAuthUser?: string;
  SIP_AUTH_USER?: string;
  sipAuthPassword?: string;
  SIP_AUTH_PASSWORD?: string;
  allowedIps?: string[] | string;
  SIP_ALLOWED_IPS?: string;
  maxConcurrentCalls?: number | string;
  SIP_MAX_CALLS?: string;
  sipKeepaliveUri?: string;
  SIP_KEEPALIVE_URI?: string;
  sipKeepaliveInterval?: number | string;
  SIP_KEEPALIVE_INTERVAL?: string;
  rtpPortMin?: number | string;
  RTP_PORT_MIN?: string;
  rtpPortMax?: number | string;
  RTP_PORT_MAX?: string;
  defaultCodec?: number | string;
  SIP_CODEC?: string;
  httpPort?: number | string;
  HTTP_PORT?: string;
  httpHost?: string;
  HTTP_HOST?: string;
  enableHttp?: boolean;
  SIP_BRIDGE_HTTP?: string;
  logger?: { info: (...args: any[]) => void; error: (...args: any[]) => void };
  defaultLanguage?: string;
  DEFAULT_LANGUAGE?: string;
  autoAnswer?: boolean;
  ringDuration?: number | string;
  SIP_RING_DURATION?: string;
}

export interface SipSessionMetadata {
  sessionId: string;
  callerId: string;
  callerName: string;
  languageCode: string;
  state: string;
  remoteAddress: string | null;
  [key: string]: any;
}

export interface BridgeStats {
  active: boolean;
  mode: 'sip_bridge';
  sessions: number;
  sipPort: number;
  publicAddress: string | undefined;
  stack: StackStats | {};
}

export class SipSession extends EventEmitter {
  id: string;
  callerId: string;
  callerName: string;
  remoteAddress: string | null;
  remotePort: number | null;
  languageCode: string;
  state: 'init' | 'active' | 'ended';

  sendAudio(pcmBuffer: Buffer): void;
  sendAudioPaced(pcmBuffer: Buffer, callback?: () => void): Promise<void>;
  enqueueAudio(pcmBuffer: Buffer): void;
  hangup(): Promise<void>;
  transfer(targetUri: string): Promise<SipResponse>;
  hold(): Promise<void>;
  unhold(): Promise<void>;
  sendDtmf(digit: string, duration?: number): void;
  setMetadata(meta: Record<string, any>): void;
  getMetadata(): SipSessionMetadata;
  getStats(): { id: string; callerId: string; state: string; dialog: dialog.DialogStats | null };

  on(event: 'audio', listener: (pcm: Buffer) => void): this;
  on(event: 'dtmf', listener: (digit: string, method: string) => void): this;
  on(event: 'end', listener: (reason: string) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'ready', listener: () => void): this;
  on(event: 'metadata', listener: (meta: SipSessionMetadata) => void): this;
}

export class VexylSipBridge extends EventEmitter {
  active: boolean;

  constructor(config?: VexylSipBridgeConfig);

  start(): Promise<void>;
  stop(): Promise<void>;
  getStats(): BridgeStats;
  getSessions(): Record<string, SipSession>;
  getSession(id: string): SipSession | null;

  on(event: 'session', listener: (session: SipSession) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'started', listener: () => void): this;
  on(event: 'stopped', listener: () => void): this;
}

export function createBridge(config?: VexylSipBridgeConfig): VexylSipBridge;
export function createBridgeFromEnv(): VexylSipBridge;
export function getMode(): 'sip_bridge' | 'audiosocket' | 'both';
