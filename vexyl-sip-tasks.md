# @vexyl.ai/sip — Development Task Document

> Pure Node.js SIP Stack · No native deps · No sidecar process · Built for AI voice agents  
> **Base:** `kirm/sip` (SIP layer) + `node.js-sip` RTP/DTMF cherry-picks

---

## Priority Legend

| Badge | Meaning |
|-------|---------|
| 🔴 P1 — Critical | Blocking. No call completes without this |
| 🟠 P2 — Core | Required for production quality |
| 🟢 P3 — Important | Production hardening & reliability |
| 🔵 P4 — Enhancement | Nice-to-have, post-launch |

---

## PHASE 1 — Fix the Foundation `Week 1`

> Everything here must be done before a single SIP call can complete reliably. These are correctness fixes, not polish.

| ID | 🔴 Task | Why it matters | Effort |
|----|---------|---------------|--------|
| T-01 | Replace deprecated `Buffer` API | `new Buffer.from()` throws on Node 18+, crashes on Node 22 | 30 min |
| T-02 | Replace `util.debug()` → `console.error()` | `util.debug` removed in newer Node versions — silent crashes | 15 min |
| T-03 | Fix `engines` field in `package.json` | Currently `>=0.2.2` — set to `>=18.0.0` | 5 min |
| T-04 | Add `To`-tag on 200 OK response | RFC 3261 requires To-tag on final responses. Missing = call setup fails with many carriers | 1 hr |
| T-05 | Fix `makeResponse()` to copy all required headers | `Contact` header missing from 200 OK causes in-dialog requests (BYE) to fail | 1 hr |
| T-06 | SDP: inject `publicAddress` into `c=` line | Without this, VEXYL advertises private/bind IP in SDP — RTP audio never arrives | 1 hr |
| T-07 | Make `ws` an optional peer dependency | Only needed for WebSocket transport. Hard dep prevents zero-dep for UDP/TCP use | 30 min |

### Phase 1 Definition of Done
- `npm install @vexyl.ai/sip` installs with zero warnings on Node 18/20/22
- A SIP INVITE can be received and answered with a valid 200 OK
- SDP in 200 OK contains the correct public IP

---

## PHASE 2 — RTP Media Layer `Week 2`

> The SIP stack handles signalling only. These tasks add the media pipe that feeds VEXYL's AI pipeline.

| ID | 🔴 Task | Why it matters | Effort |
|----|---------|---------------|--------|
| T-08 | RTP UDP socket — per-call instance | `node.js-sip` uses a singleton. Breaks concurrent calls. Must be one socket per call | 1 day |
| T-09 | RTP header parser | Strip 12-byte header, extract payload type, sequence, timestamp, SSRC | 2 hrs |
| T-10 | G.711 ulaw → PCM decode (payload type 0) | PCMU is the most common carrier codec. Required for STT input | 1 hr |
| T-11 | G.711 alaw → PCM decode (payload type 8) | PCMA used by Indian carriers (BSNL, Airtel SIP trunks) | 1 hr |
| T-12 | Symmetric RTP for NAT | Send RTP back to where packets **arrived from**, not what SDP says. ~5 lines. Critical for callers behind NAT | 1 hr |
| T-13 | RTP packet builder (PCM → G.711) | For TTS audio playback to caller. **Fix timestamp bug from node.js-sip** — must be `+= 160`, not `+= 1` | 2 hrs |
| T-14 | RTP packet pacing (20ms intervals) | Dump all packets at once = audio distortion. Must pace at real-time rate | 1 hr |

| ID | 🟠 Task | Why it matters | Effort |
|----|---------|---------------|--------|
| T-15 | RTP port pool manager | Allocate/release ports from range (e.g. 10000–20000). Prevents conflicts across concurrent calls | 2 hrs |
| T-16 | SSRC tracking per call | Proper multi-stream RTP identification. Required for correct per-call isolation | 1 hr |
| T-17 | Basic RTP jitter buffer | Reorder out-of-sequence packets. Without this, STT quality degrades on poor networks | 1 day |

### Phase 2 Definition of Done
- `dialog.on('audio')` fires with a PCM buffer on an inbound call
- PCM fed into Sarvam STT returns readable text
- TTS audio plays back to the caller without distortion

---

## PHASE 3 — Modern API & DTMF `Week 3`

> Make the library developer-friendly. DTMF is required for IVR, PIN entry, and hospital menu navigation.

| ID | 🟠 Task | Why it matters | Effort |
|----|---------|---------------|--------|
| T-18 | `EventEmitter`-based `Dialog` class | Replace raw callbacks with `dialog.on('audio')`, `dialog.on('dtmf')`, `dialog.on('end')` | 1 day |
| T-19 | Promise-based call setup | `await sip.answer(req)` / `await sip.call(uri)` — clean async/await API for VEXYL | 1 day |
| T-20 | `SipStack` class (replace global singleton) | `kirm/sip` uses a module-level global. Rewrite as class so multiple instances can coexist | 1 day |
| T-21 | TypeScript type definitions (`index.d.ts`) | Required for enterprise adoption. IDE autocomplete for VEXYL developers | 1 day |
| T-22 | RFC 2833 DTMF (RTP payload type 101) | Detect DTMF from RTP event packets — the standard method on most carriers | 1 day |
| T-23 | SIP INFO DTMF fallback | Some older trunks send DTMF as SIP INFO messages, not RFC 2833 | 2 hrs |

| ID | 🟢 Task | Why it matters | Effort |
|----|---------|---------------|--------|
| T-24 | Goertzel in-band DTMF detection | Last resort for trunks that send DTMF as audio tones. Cherry-pick from node.js-sip | 1 day |

### Target API after Phase 3

```js
import { SipStack } from '@vexyl.ai/sip';

const sip = new SipStack({ port: 5060, publicAddress: process.env.PUBLIC_IP });

sip.on('invite', async (dialog) => {
  await dialog.trying();
  await dialog.ringing();
  await dialog.accept({ rtpPort: 12000, codec: 'PCMU' });

  dialog.on('audio', (pcm) => ai.processAudio(pcm));
  dialog.on('dtmf',  (digit) => console.log('Pressed:', digit));
  dialog.on('end',   () => ai.end());
});

// Outbound
const call = await sip.call('sip:+919876543210@trunk.provider.com');
```

---

## PHASE 4 — Production Hardening `Week 4`

> Required before VEXYL can use this in the Kerala hospital production deployment.

| ID | 🟢 Task | Why it matters | Effort |
|----|---------|---------------|--------|
| T-25 | Digest authentication — 407/401 auto-retry | Most SIP trunks require digest auth on INVITE. Without this, outbound calls fail immediately | 1 day |
| T-26 | Re-INVITE handling | Carriers send re-INVITEs to update codec or hold calls. Must handle gracefully | 1 day |
| T-27 | REFER / call transfer | Required for hospital operator use case — transfer call to another extension | 1 day |
| T-28 | OPTIONS ping / keepalive | Carriers drop idle SIP registrations. Periodic OPTIONS keeps trunk alive | 2 hrs |
| T-29 | Graceful cleanup on call end | Ensure RTP socket, port pool slot, and Redis session are always released on BYE/error | 1 day |
| T-30 | Jest test suite | Replace CoffeeScript tests with Jest. Cover parser, transaction state machines, RTP builder | 2 days |
| T-31 | Allowed trunk IP whitelist | Reject INVITEs from unauthorised IPs. Prevents open SIP relay abuse | 2 hrs |
| T-32 | Concurrent call rate limiting | Max calls per trunk config. Protection against SIP flood attacks | 2 hrs |
| T-33 | Pluggable logger (no `console.log` in library) | Library must accept `opts.logger`. VEXYL uses PM2 — no rogue console output in production | 2 hrs |

---

## PHASE 5 — VEXYL Integration & Release `Week 5`

| ID | 🟢 Task | Why it matters | Effort |
|----|---------|---------------|--------|
| T-34 | `vexyl-sip-bridge.js` VEXYL module | New module that uses `@vexyl.ai/sip` as an additional path alongside AudioSocket/Asterisk | 2 days |
| T-35 | Mode switch config flag | `telephony.mode: 'audiosocket' \| 'sip_bridge'` — zero disruption to existing deployments | 2 hrs |
| T-36 | Production test — Kerala hospital | Test against real SIP trunk. Validate latency, audio quality, DTMF end-to-end | 3 days |

| ID | 🔵 Task | Why it matters | Effort |
|----|---------|---------------|--------|
| T-37 | `npm publish @vexyl.ai/sip` | Publish under vexyl.ai scope. Set up GitHub Actions CI/CD | 1 day |
| T-38 | README + API docs | Full quickstart + API reference. Key differentiator vs abandoned alternatives | 1 day |
| T-39 | Community launch posts | Dev.to, r/selfhosted, r/LocalLLaMA, Asterisk forums — same strategy as vexyl-stt launch | 1 day |

---

## Acceptance Criteria — First Successful Call

A build is **Phase 1+2 complete** when all of the following pass on a real SIP trunk:

| Checkpoint | Pass Condition |
|-----------|----------------|
| INVITE received | `stack.on('invite')` fires with correct From / To / Call-ID |
| 100 Trying sent | Carrier receives 100 within 500ms of INVITE |
| 200 OK sent | Contains valid To-tag, Contact header, and answer SDP with correct public IP |
| ACK received | Dialog established — no retransmit loops |
| RTP audio received | `dialog.on('audio')` fires with PCM — verified by STT returning text |
| TTS audio plays back | Caller hears AI response — no distortion, correct 20ms pacing |
| BYE handled | `dialog.on('end')` fires, RTP socket closed, port returned to pool |
| Concurrent calls | 5 simultaneous calls on same process — no port conflicts, no crosstalk |

---

## What NOT to Build (Scope Boundaries)

| Out of Scope | Reason |
|-------------|--------|
| Full ICE / STUN / TURN | WebRTC concern. Irrelevant for carrier SIP trunks |
| SRTP / DTLS media encryption | Carriers use plain RTP. Add later if WebRTC endpoint support needed |
| SIP REGISTER server (registrar) | VEXYL is a UAS/UAC, not a registrar |
| Video (SDP `m=video`) | Voice-only for AI pipeline. Unnecessary complexity |
| TCP/TLS transport improvements | UDP covers all carrier trunk use cases. Existing TCP/TLS from kirm/sip is sufficient |
| Opus / G.729 codec | G.711 covers 99% of Indian carrier trunks. Add Opus later for WebRTC endpoints |

---

## File Structure Target

```
@vexyl.ai/sip/
├── src/
│   ├── index.js          ← SipStack class (public API)
│   ├── dialog.js         ← Dialog EventEmitter class
│   ├── parser.js         ← SIP message parser (from kirm/sip, modernised)
│   ├── transaction.js    ← RFC 3261 state machines (from kirm/sip, modernised)
│   ├── transport.js      ← UDP/TCP/TLS (from kirm/sip, modernised)
│   ├── sdp.js            ← SDP parse/build with publicAddress support
│   ├── rtp.js            ← RTP socket, G.711, pacing, symmetric NAT
│   ├── dtmf.js           ← RFC 2833 + SIP INFO + Goertzel
│   └── digest.js         ← Digest auth (from kirm/sip)
├── types/
│   └── index.d.ts        ← TypeScript definitions
├── test/
│   ├── parser.test.js
│   ├── transaction.test.js
│   ├── rtp.test.js
│   └── sdp.test.js
├── examples/
│   ├── inbound-call.js
│   ├── outbound-call.js
│   └── vexyl-bridge.js   ← Full VEXYL integration example
├── package.json
└── README.md
```

---

## Summary Timeline

| Week | Phase | Key Milestone |
|------|-------|---------------|
| 1 | Foundation fixes | `npm install` works cleanly, 200 OK sends correctly |
| 2 | RTP media layer | First real audio through STT |
| 3 | Modern API + DTMF | Clean async/await API, DTMF working |
| 4 | Production hardening | Digest auth, re-INVITE, tests passing |
| 5 | Integration + release | Live on Kerala hospital trunk, npm published |

**Total: ~5 weeks to production-ready + published**

---

*VEXYL AI Voice Gateway · github.com/vexyl-ai/node-sip*
