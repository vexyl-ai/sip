# @vexyl.ai/sip

**Pure Node.js SIP stack for AI voice agents** — zero native deps, zero sidecar process.

Built for [VEXYL AI](https://vexyl.ai) voice gateway. Forked from [`kirm/sip.js`](https://github.com/kirm/sip.js) with extensive modernisation, bug fixes, and production hardening.

```
npm install @vexyl.ai/sip
```

> Requires Node.js >= 18.0.0 | Full TypeScript definitions included

---

## Why this fork?

The original `kirm/sip.js` is a solid RFC 3261 implementation but hasn't been maintained for production use on modern Node.js. This fork fixes **22+ known bugs**, adds **RFC compliance** missing from the original, and prepares the stack for AI voice agent workloads on Indian carrier SIP trunks.

### What's different from `kirm/sip.js`

| Area | Original | @vexyl.ai/sip |
|------|----------|---------------|
| Node.js support | Crashes on Node 18+ (`new Buffer`, `util.debug`) | Clean on Node 18/20/22 |
| API | Raw callbacks only | `SipStack` class + `Dialog` EventEmitter + async/await |
| RTP media | Not included | Full RTP layer — G.711, pacing, symmetric NAT, jitter buffer |
| DTMF | Not included | RFC 2833 + SIP INFO + Goertzel in-band detection |
| RFC 3261 compliance | Missing To-tag, Contact header on 200 OK | Correct final responses |
| DNS resolution | SRV + A/AAAA only | NAPTR + SRV + A/AAAA (RFC 3263) |
| IPv6 | Broken in URI and Via parsing | Full IPv6 support |
| SIP 603+ (FCC March 2026) | No 6xx handling | Proper 6xx, no retry, Reason header (RFC 3326) |
| Digest auth | Typos, quoting bugs, manual only | Fixed + auto-retry on 401/407 |
| Re-INVITE | Not handled | Hold/unhold, codec change, SDP update |
| REFER | Not handled | Call transfer with NOTIFY tracking |
| Security | Open relay | IP whitelist + concurrent call rate limiting |
| Logging | `console.log` everywhere | Pluggable logger — zero console output |
| Transaction IDs | `Math.random()` collisions | `crypto.randomBytes` — collision-free |
| WebSocket dep | Hard dependency | Optional peer dependency |
| TypeScript | Not typed | Full `index.d.ts` with all modules |
| Tests | CoffeeScript only | 119 tests across parser, RTP, DTMF, Dialog, Stack |

---

## Quick Start

### Modern API (recommended)

```js
const { SipStack } = require('@vexyl.ai/sip/stack');

const stack = new SipStack({
  port: 5060,
  publicAddress: '203.0.113.10',
  credentials: { user: 'vexyl', password: 'secret' },
  allowedIps: ['10.0.0.1', '10.0.0.2'],
  maxConcurrentCalls: 50,
  keepaliveTargets: [{ uri: 'sip:trunk@provider.com', interval: 30000 }],
  logger: { error: console.error, info: console.log }
});

await stack.start();

// Receive calls
stack.on('invite', async (dialog) => {
  await dialog.trying();
  await dialog.ringing();
  await dialog.accept({ payloadType: 0 }); // PCMU

  dialog.on('audio', (pcm, header) => {
    // PCM 16-bit LE @ 8kHz — feed to STT
    sttEngine.processAudio(pcm);
  });

  dialog.on('dtmf', (digit, method) => {
    console.log(`DTMF: ${digit} via ${method}`);
    // method: 'rfc2833' | 'sip-info' | 'goertzel'
  });

  dialog.on('end', (reason) => {
    console.log('Call ended:', reason);
  });

  // Play TTS audio back (20ms paced)
  const ttsAudio = await ttsEngine.synthesize('Hello from VEXYL');
  await dialog.sendAudioPaced(ttsAudio);
});

// Make outbound calls (auto digest auth on 401/407)
const call = await stack.call('sip:+919876543210@trunk.provider.com');
call.on('audio', (pcm) => { /* ... */ });

// Transfer a call
await call.refer('sip:operator@hospital.local');

// Hold / unhold
await call.hold();
await call.unhold();

// Hang up
await call.bye();
```

### Classic API (low-level)

```js
var sip = require('@vexyl.ai/sip');

sip.start({ port: 5060, publicAddress: '203.0.113.10' }, function(rq, remote) {
  if (rq.method === 'INVITE') {
    var rs = sip.makeResponse(rq, 200, 'OK');
    sip.send(rs);
  }
  else if (rq.method === 'BYE') {
    sip.send(sip.makeResponse(rq, 200, 'OK'));
  }
});
```

### Reject spam calls (FCC 603+ compliant)

```js
sip.send(sip.makeDeclineResponse(rq, 'Network Blocked'));   // 603
sip.send(sip.makeUnwantedResponse(rq, 'Spam detected'));    // 607
sip.send(sip.makeRejectedResponse(rq, 'Blacklisted'));      // 608
```

---

## Modules

| Module | Import | Description |
|--------|--------|-------------|
| `sip` | `require('@vexyl.ai/sip')` | Core SIP parser, transport, transactions |
| `stack` | `require('@vexyl.ai/sip/stack')` | `SipStack` class — modern async/await API |
| `dialog` | `require('@vexyl.ai/sip/dialog')` | `Dialog` EventEmitter — per-call state |
| `rtp` | `require('@vexyl.ai/sip/rtp')` | RTP sessions, G.711 codecs, jitter buffer |
| `dtmf` | `require('@vexyl.ai/sip/dtmf')` | DTMF detection — RFC 2833, SIP INFO, Goertzel |
| `sdp` | `require('@vexyl.ai/sip/sdp')` | SDP parser/stringifier |
| `digest` | `require('@vexyl.ai/sip/digest')` | Digest authentication (RFC 2617) |

---

## API Reference

### SipStack (`@vexyl.ai/sip/stack`)

```js
const { SipStack } = require('@vexyl.ai/sip/stack');
const stack = new SipStack(options);
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `port` | number | 5060 | SIP UDP/TCP port |
| `publicAddress` | string | — | Public IP for Via/SDP (critical for NAT) |
| `credentials` | object | — | `{ user, password, realm? }` for digest auth auto-retry |
| `allowedIps` | string[] | — | IP whitelist (rejects others with 403) |
| `maxConcurrentCalls` | number | 0 | Max concurrent calls (0 = unlimited) |
| `keepaliveTargets` | array | — | `[{ uri, interval }]` OPTIONS keepalive targets |
| `rtpPortMin` | number | 10000 | RTP port range start |
| `rtpPortMax` | number | 20000 | RTP port range end |
| `logger` | object | — | `{ error, info, send, recv }` pluggable logger |

**Methods:**

| Method | Returns | Description |
|--------|---------|-------------|
| `stack.start()` | `Promise<void>` | Start SIP stack |
| `stack.stop()` | `Promise<void>` | Graceful shutdown (BYE all calls, release ports) |
| `stack.call(uri, options?)` | `Promise<Dialog>` | Outbound call with auto auth retry |
| `stack.transfer(callId, targetUri)` | `Promise` | REFER-based call transfer |
| `stack.sendOptions(uri)` | void | Send OPTIONS ping |
| `stack.allowIp(ip)` | void | Add IP to whitelist |
| `stack.removeIp(ip)` | void | Remove IP from whitelist |
| `stack.disableIpWhitelist()` | void | Allow all IPs |
| `stack.setMaxConcurrentCalls(n)` | void | Update rate limit |
| `stack.getDialogs()` | object | All active dialogs |
| `stack.getDialog(callId)` | Dialog | Get dialog by Call-ID |
| `stack.getStats()` | object | Stack statistics |

**Events:**

| Event | Arguments | Description |
|-------|-----------|-------------|
| `invite` | `(dialog, remote)` | New inbound call |
| `message` | `(request, remote)` | Non-dialog SIP request |
| `started` | — | Stack ready |
| `stopped` | — | Stack shut down |
| `error` | `(err)` | Stack-level error |

### Dialog (`@vexyl.ai/sip/dialog`)

**Inbound call flow:**

```js
stack.on('invite', async (dialog) => {
  await dialog.trying();           // 100 Trying
  await dialog.ringing();          // 180 Ringing
  await dialog.accept(options);    // 200 OK + start RTP
  // or
  await dialog.reject(486, 'Busy Here');
  await dialog.decline('Not accepting calls');  // 603
});
```

**Active call methods:**

| Method | Description |
|--------|-------------|
| `dialog.sendAudio(pcmBuffer)` | Send single PCM frame |
| `dialog.sendAudioPaced(pcmBuffer)` | Send PCM with 20ms pacing (returns Promise) |
| `dialog.enqueueAudio(pcmBuffer)` | Queue PCM for sequential paced sending |
| `dialog.sendDtmf(digit, duration?)` | Send DTMF via RFC 2833 |
| `dialog.hold()` | Put call on hold (re-INVITE sendonly) |
| `dialog.unhold()` | Take off hold (re-INVITE sendrecv) |
| `dialog.refer(targetUri)` | Transfer call via REFER |
| `dialog.bye()` | Hang up |
| `dialog.getStats()` | Call statistics (RTP counts, ports, SSRC) |

**Events:**

| Event | Arguments | Description |
|-------|-----------|-------------|
| `audio` | `(pcmBuffer, rtpHeader)` | Decoded audio from remote (PCM 16-bit LE @ 8kHz) |
| `dtmf` | `(digit, method)` | DTMF detected (`rfc2833`, `sip-info`, `goertzel`) |
| `end` | `(reason)` | Call terminated |
| `error` | `(err)` | Error occurred |
| `ready` | — | RTP session ready |
| `hold` | — | Call put on hold (by remote) |
| `unhold` | — | Call taken off hold |
| `reinvite` | `(request)` | Re-INVITE received |
| `refer` | `(targetUri, request)` | REFER received |
| `transferred` | `(targetUri)` | REFER sent successfully |

### RTP (`@vexyl.ai/sip/rtp`)

```js
var rtp = require('@vexyl.ai/sip/rtp');

// Create per-call RTP session
var session = rtp.createSession({
  remoteAddress: '10.0.0.1',
  remotePort: 20000,
  payloadType: 0,        // 0=PCMU, 8=PCMA
  symmetricRtp: true      // Learn NAT address from first packet
});

session.start(function(err, addr) {
  console.log('RTP listening on', addr.port);
});

session.on('audio', function(pcm, header) {
  // PCM 16-bit LE buffer — feed to STT
});

// Send audio
session.sendPcm(pcmBuffer);
session.sendPcmPaced(longPcmBuffer, callback); // 20ms paced

// Codecs
var pcm = rtp.pcmuDecode(ulawBuffer);
var ulaw = rtp.pcmuEncode(pcmBuffer);
var pcm = rtp.pcmaDecode(alawBuffer);
var alaw = rtp.pcmaEncode(pcmBuffer);

// Port pool
var pool = new rtp.PortPool(10000, 20000);
var port = pool.allocate();   // Even port (RTCP = port+1)
pool.release(port);
```

### DTMF (`@vexyl.ai/sip/dtmf`)

```js
var dtmf = require('@vexyl.ai/sip/dtmf');

// Unified detector (all three methods)
var detector = new dtmf.DtmfDetector({
  rfc2833PayloadType: 101,
  goertzel: { minDuration: 2 }
});

detector.on('digit', function(digit, method) {
  console.log('DTMF:', digit, 'via', method);
});

// Feed RTP packets
detector.processRtp(rtpHeader);

// Feed SIP INFO requests
detector.processSipInfo(sipRequest);

// RFC 2833 packet builder (for sending DTMF)
var payload = dtmf.buildRfc2833('5', false, 10, 160);

// Goertzel standalone (in-band audio)
var goertzel = new dtmf.GoertzelDetector();
var digits = goertzel.process(pcmBuffer);
```

### SDP (`@vexyl.ai/sip/sdp`)

```js
var sdp = require('@vexyl.ai/sip/sdp');

var parsed = sdp.parse(sdpString);
var str = sdp.stringify(parsed);

// Inject public IP into all c= and o= lines
sdp.setConnectionAddress(parsed, '203.0.113.10');
```

### Digest Authentication (`@vexyl.ai/sip/digest`)

```js
var digest = require('@vexyl.ai/sip/digest');

// Auto-retry: SipStack handles this automatically when credentials are set
// Manual usage:
digest.signRequest(ctx, request, response, { user: 'vexyl', password: 'secret' });
digest.challenge(ctx, response);
digest.authenticateRequest(ctx, request, credentials);
```

### Core SIP (`@vexyl.ai/sip`)

| Function | Description |
|----------|-------------|
| `sip.start(options, onRequest)` | Start SIP stack (singleton) |
| `sip.stop()` | Stop SIP stack |
| `sip.create(options, onRequest)` | Create non-singleton instance |
| `sip.send(message[, callback])` | Send SIP message transactionally |
| `sip.parse(data)` | Parse raw SIP message |
| `sip.stringify(message)` | Stringify SIP message |
| `sip.parseUri(uri)` | Parse SIP URI |
| `sip.stringifyUri(uri)` | Stringify SIP URI |
| `sip.makeResponse(rq, status[, reason])` | Create response (auto To-tag, Contact) |
| `sip.copyMessage(msg[, deep])` | Copy SIP message |
| `sip.generateBranch()` | Generate Via branch (`crypto.randomBytes`) |
| `sip.generateTag()` | Generate random tag |
| `sip.isGlobalFailure(status)` | Returns `true` for 600-699 |
| `sip.makeDeclineResponse(rq[, text])` | Create 603 with Reason header |
| `sip.makeUnwantedResponse(rq[, text])` | Create 607 with Reason header |
| `sip.makeRejectedResponse(rq[, text])` | Create 608 with Reason header |

### SipStack Options

```js
new SipStack({
  // Network
  port: 5060,                          // SIP port
  address: '0.0.0.0',                 // Bind address
  publicAddress: '203.0.113.10',       // Public IP (critical for NAT)

  // Authentication
  credentials: { user: 'vexyl', password: 'secret' },

  // Security
  allowedIps: ['10.0.0.1'],           // Trunk IP whitelist
  maxConcurrentCalls: 50,             // Rate limit

  // Keepalive
  keepaliveTargets: [
    { uri: 'sip:trunk@provider.com', interval: 30000 }
  ],

  // RTP
  rtpPortMin: 10000,                  // RTP port range
  rtpPortMax: 20000,

  // Transport
  udp: true,
  tcp: true,
  tls: { key, cert },
  tls_port: 5061,
  ws_port: 8080,

  // Timers
  timerA: 500,                         // INVITE retransmit ms
  timerB: 32000,                       // INVITE timeout ms

  // Logging (no console output by default)
  logger: {
    send: (msg, target) => {},
    recv: (msg, remote) => {},
    error: (err) => {},
    info: (msg) => {}
  }
});
```

---

## Changelog from kirm/sip.js

### Bug Fixes (22 fixes)

- **#131/#105** — Replace deprecated `new Buffer()` with `Buffer.from()`
- **#136** — Crash on malformed headers (robust `checkMessage` validation)
- **#137** — `copyMessage` deep copy crash on `null` values
- **#102** — `generateBranch()` collisions replaced with `crypto.randomBytes`
- **#155** — CANCEL memory leak (transaction stuck in proceeding state)
- **#147** — EADDRINUSE crash (error handlers on all server sockets)
- **#148** — `hop` undefined crash when `parseUri` fails
- **#154/#91** — Route `lr` param lost / `rq` undefined in strict routing
- **#162** — IPv6 address parsing in `parseUri`
- **#144** — UTF-8 display name parsing in AOR headers
- **#96** — TCP FIN_WAIT2 leak (`stream.end()` -> `stream.destroy()`)
- **#98** — Configurable INVITE timers (`timerA`, `timerB`)
- **#92/#118** — Digest auth algorithm quoting and typo fixes
- **#107** — `nc` as number type coercion in digest
- **digest.js** — `entity` typo in `authenticateResponse` (broke `auth-int` QoP)
- **sip.js** — `createClientTransaction` missing `options` parameter

### Adopted PRs

- **PR #143** — IPv6 support in `parseVia` regex
- **PR #135** — Correct UDP response port per RFC 3261 section 18.2.2 / RFC 3581
- **PR #163** — NAPTR DNS resolution per RFC 3263
- **PR #122** — HAProxy PROXY protocol v1 support
- **PR #160** — `ws` security update to 7.5.10

### New Features

- **SipStack class** — Non-singleton, EventEmitter-based, async/await API
- **Dialog class** — Per-call EventEmitter with `audio`, `dtmf`, `end` events
- **RTP media layer** — Per-call UDP sockets, G.711 PCMU/PCMA, 20ms pacing, symmetric NAT
- **DTMF detection** — RFC 2833 (RTP events) + SIP INFO fallback + Goertzel in-band
- **Digest auth auto-retry** — Automatic re-INVITE on 401/407
- **Re-INVITE handling** — Hold/unhold detection, SDP update, codec change
- **REFER / call transfer** — Send and receive REFER with NOTIFY tracking
- **OPTIONS keepalive** — Configurable ping to keep SIP trunk alive
- **IP whitelist** — Reject unauthorized IPs with 403 Forbidden
- **Rate limiting** — Concurrent call limit with 503 on overload
- **Pluggable logger** — Zero `console.log` in library, accepts `opts.logger`
- **RTP port pool** — Even-port allocation, random selection, per-call isolation
- **Jitter buffer** — Sequence-ordered, duplicate rejection, 16-bit wrap handling
- **SSRC tracking** — Per-call RTP stream identification
- **SIP 603+** — FCC March 2026 compliant call blocking with Reason header (RFC 3326)
- **TypeScript definitions** — Full `index.d.ts` for all modules
- **119 tests** — SIP parser, SDP, RTP codecs, DTMF, Dialog, SipStack

---

## File Structure

```
@vexyl.ai/sip/
+-- sip.js              SIP parser, transport, transactions (RFC 3261)
+-- stack.js            SipStack class (modern async/await API)
+-- dialog.js           Dialog EventEmitter (per-call state)
+-- rtp.js              RTP sessions, G.711 codecs, jitter buffer
+-- dtmf.js             DTMF detection (RFC 2833 + SIP INFO + Goertzel)
+-- sdp.js              SDP parser/stringifier
+-- digest.js           Digest authentication (RFC 2617)
+-- index.d.ts          TypeScript definitions
+-- test/
|   +-- test-phase3.js  58 tests (Dialog, Stack, DTMF, TypeScript)
|   +-- test-phase4.js  61 tests (auth, REFER, hold, whitelist, rate limit)
+-- package.json
+-- README.md
```

---

## Credits

Based on [kirm/sip.js](https://github.com/kirm/sip.js) by Kirill Mikhailov (MIT License).

---

## License

MIT
