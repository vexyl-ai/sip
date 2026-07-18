# SBC / PBX Interop: REGISTER Client, Session Timers, PRACK

**Date:** 2026-07-18
**Status:** Approved
**Scope:** Signaling interop for enterprise SBCs (Cisco/Oracle) and generic PBXs (Asterisk/FreePBX/3CX). SRTP/TLS media encryption is explicitly deferred to a follow-up project.

## Goal

Let `@vexyl.ai/sip` register as an extension against a PBX and survive strict SBC signaling requirements: registration lifecycle (RFC 3261 §10), session timers (RFC 4028), and reliable provisional responses / PRACK (RFC 3262).

## Approach

Native, in-stack, phased (chosen over a wrapper layer or delegating to an external signaling library). Features live where they belong: a new `register.js` module for registration, and `dialog.js` for session timers and PRACK, matching the fork's existing module pattern (`rtp.js`, `dtmf.js`). Three phases, each independently shippable and testable against Asterisk in Docker:

1. REGISTER client (standalone; unlocks PBX connectivity)
2. Session timers (moderate; requires new in-dialog re-INVITE plumbing)
3. PRACK (hardest; rewires the INVITE state machine)

---

## Phase 1 — Registration client (`register.js`)

New module exporting `RegistrationClient` (EventEmitter), one instance per registration target.

### API

```js
const reg = stack.register('sip:100@pbx.local', {
  user: '100', password: 'secret',
  expires: 3600,          // requested; server may shorten
  keepalive: true,        // OPTIONS keepalive to registrar
  contactParams: {},      // optional extra Contact params
});
reg.on('registered', (expires) => {});
reg.on('unregistered', () => {});
reg.on('failed', (err, willRetry) => {});
reg.state;                // see state machine below
reg.getStats();
reg.stop();               // sends Expires: 0, resolves when confirmed
```

### Lifecycle

- Sends REGISTER through the existing `sip.js` transaction layer (`_instance.send` with callback, same as `SipStack.call`).
- 401/407: re-sign with existing `digest.signRequest` using the same `authCtx` pattern as `stack.call` (stack.js:158). Retry once; a second 401 means bad credentials — emit `failed` with `willRetry=false`, do not hammer the registrar.
- Success: read granted expiry from the response Contact/Expires header; schedule re-REGISTER at 80% of the granted interval.
- 423 Interval Too Brief: retry once with the server's `Min-Expires` value.
- Transport error / timeout: exponential backoff (1s → 2s → 4s … capped at 60s), emit `failed` with `willRetry=true`, keep retrying.
- CSeq increments on every REGISTER within the same Call-ID (RFC 3261 §10.2).
- `stack.stop()` unregisters all active registrations (Expires: 0) before transport teardown.

### State machine

`unregistered → registering → registered → refreshing → registered … → unregistering → unregistered`

### NAT keepalive

Reuses the existing OPTIONS keepalive machinery (T-28) pointed at the registrar, enabled by the `keepalive: true` option.

### Testing

- Unit: mock `sipSend`; cover 401-then-success, double-401, 423, timeout/backoff, stop-during-refresh.
- Integration: Asterisk in Docker with a pjsip extension config committed under `test/`; register, assert refresh, assert clean unregister. Matches the existing `test/test-phase*.js` style.

---

## Phase 2 — Session timers, RFC 4028 (`dialog.js` + stack options)

### Config

```js
new SipStack({ sessionTimers: { enabled: true, defaultExpires: 1800, minSE: 90 } })
// per-call override via CallOptions.sessionExpires
```

### Negotiation

- Outbound INVITE: add `Supported: timer` and `Session-Expires: <defaultExpires>`. No `Require: timer` — stays compatible with peers that do not support it.
- The 200 OK dictates the final interval and refresher role (`;refresher=uac|uas`). If the response carries no Session-Expires, the peer does not support timers: run without them, current behavior unchanged.
- 422 Session Interval Too Small: re-send the INVITE with the server's `Min-SE`; one retry.
- Inbound INVITE with `Session-Expires`: honor it. Below our `minSE`: reply 422 with `Min-SE`. Peer sends `Supported: timer` but no Session-Expires: we insert ours in the 200 OK and become the refresher.

### Runtime (per dialog)

- We are refresher: send a refresh re-INVITE with unchanged SDP at interval/2.
- Peer is refresher: expiry watchdog at `interval − min(32s, interval/3)` (RFC formula). Nothing received by then: send BYE, emit `end('session-timer-expired')`.
- A successful refresh resets both timers. Refresh 4xx/timeout: BYE + end.
- All timers cleared in dialog teardown, following the existing timer-cleanup pattern.

### Prerequisite: in-dialog re-INVITE plumbing

`dialog.js` currently has no re-INVITE support. Both directions are needed and are roughly half this phase's effort:

- Send: re-INVITE inside the dialog — correct CSeq bump, To/From tags, route set, Contact; handle the 200 and send ACK; SDP unchanged so no RTP renegotiation.
- Receive: inbound re-INVITE on an active dialog → answer 200 with the current SDP (today this would be mishandled as a new call or dropped).

This plumbing later enables hold/resume and SRTP re-keying at no extra cost.

### Testing

- Unit: negotiation matrix — 422 retry, no-support fallback, uac vs uas refresher, watchdog BYE.
- Integration: Asterisk with `timers=always` in pjsip.conf (forces SBC-like behavior); kill the refresh path, assert BYE fires at expiry.

---

## Phase 3 — PRACK / reliable provisionals, RFC 3262 (`dialog.js` INVITE machine)

### Config

`prack: 'supported' | 'required' | 'off'` on stack options. Default `'supported'` — advertise, use when the peer does.

### UAC side (outbound calls)

- INVITE gets `Supported: 100rel` (plus `Require: 100rel` when config is `required`).
- A provisional 101–199 carrying `Require: 100rel` + `RSeq` triggers an in-dialog PRACK (`RAck: <rseq> <cseq> INVITE`); await its 200.
- RSeq bookkeeping: the first reliable provisional sets the expected sequence; retransmits (same RSeq) are PRACKed once; out-of-order RSeq ignored per RFC.
- A 183 with SDP arriving reliably hands the SDP to the RTP layer early: early media (ringback/IVR audio before answer). The dialog enters an `early` state with the remote tag pinned.

### UAS side (inbound calls)

- When the INVITE advertises `100rel` and our config is on: 180/183 are sent reliably — add `RSeq` + `Require: 100rel`, retransmit at T1 doubling until PRACK arrives. No PRACK within 64×T1: reject the INVITE with 5xx and tear down.
- Inbound PRACK: answer 200, stop retransmission.
- Peer requires `100rel` while our config is `off`: respond 420 Bad Extension with `Unsupported: 100rel`.

### Non-goals (explicit)

UPDATE in early dialogs (RFC 3311), early-media SDP renegotiation, forking / multiple early dialogs — a single early dialog only. Deferred until an SBC demands them.

### Risk

This phase rewires the INVITE state machine: `init → trying → ringing` gains reliable-provisional branches in both directions. The existing non-PRACK path must remain byte-identical when the peer does not negotiate 100rel; the regression suite asserts this explicitly.

### Testing

- Unit: RSeq ordering, retransmission/timeout, 420 path, non-PRACK regression suite.
- Integration: Asterisk with `100rel=required`; assert early media audio is received before answer.

---

## Cross-cutting

- **Type declarations:** every new public API (RegistrationClient, sessionTimers/prack options, new Dialog states and events) gets added to `index.d.ts`, with subpath shims updated if a new subpath (`./register`) is exposed.
- **Docs:** README API reference sections for each phase as it ships.
- **Versioning:** each phase ships as a minor release (1.1.0, 1.2.0, 1.3.0).
- **Compatibility rule:** every feature is off or transparently negotiated by default; a peer that supports none of this sees today's exact behavior.
