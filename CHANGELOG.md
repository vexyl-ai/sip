# Changelog

All notable changes to `@vexyl.ai/sip` will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/).

---

## [1.1.0] - 2026-07-18

### Added

- **REGISTER client** (`@vexyl.ai/sip/register`, RFC 3261 §10) — register as a PBX/SBC extension via `stack.register(aor, options)`. Digest auth with single retry (double-401 fails terminally), auto-refresh at 80% of the granted interval, `423 Interval Too Brief` honored with the server's `Min-Expires`, exponential backoff (1s→60s cap) on transport failure (408/5xx), and clean unregister (`Expires: 0`) on `client.stop()` / `stack.stop()`. Permanent rejections (403/404 and other non-408/5xx) fail terminally without retry. Optional OPTIONS keepalive toward the registrar for NAT. Emits `registered` / `unregistered` / `failed(err, willRetry)`. Full TypeScript declarations. (register.js, stack.js)
- Integration test against Asterisk in Docker (`npm run test:register-integration`, skips cleanly without Docker). (test/)

### Fixed

- **Keepalive timer leak** — `_startKeepalives()` was not idempotent; repeated calls (now reachable via `register(..., { keepalive: true })`) orphaned prior `setInterval` timers, leaking OPTIONS pings past `stack.stop()`. Now clears existing timers before rebuilding. (stack.js)

## [1.0.4] - 2026-07-18

### Fixed

- **TypeScript typings on subpath imports** — the `exports` map used bare string targets with no `types` condition, so under `node16`/`nodenext`/`bundler` resolution subpath imports (`@vexyl.ai/sip/stack`, etc.) resolved with no typings (TS7016). Added per-subpath `.d.ts` shims re-exporting from `index.d.ts` and a `types` condition on every `exports` entry. (package.json, *.d.ts)

## [1.0.3] - 2026-03-13

### Fixed

- **To-tag mismatch causing 481 on BYE** — `dialog.js accept()` generated a To tag in the 200 OK that didn't match `dialog.localTag`, so subsequent in-dialog requests (BYE) used a different From tag than what the remote party expected. Both sides rejected each other's BYE with 481 Call/Transaction Does Not Exist. Fixed by overriding the To tag in the 200 OK response to use `dialog.localTag`, per RFC 3261 §12.1.1. (dialog.js)

## [1.0.2] - 2026-03-13

### Fixed

- **SIP session event listener leaks** — Dialog event listeners were not properly cleaned up on call teardown, causing memory leaks on long-running processes. (dialog.js, stack.js)
- **Contact header in 200 OK** — Contact header incorrectly echoed the caller's address instead of the UAS's own address. (dialog.js)
- **Referred-By header** — REFER requests used incorrect Referred-By URI. (dialog.js)
- **Timer G retransmission removed** — Removed unnecessary INVITE 200 OK retransmission timer that caused duplicate responses. (dialog.js)
- **RFC 3261 compliant To/From headers** — In-dialog requests (BYE, re-INVITE) now correctly swap To/From tags per RFC 3261 §12.2.1.1. (dialog.js)

### Added

- **Client transaction handles** — `sip.send()` now returns transaction handle for CANCEL support. (sip.js)
- **UAC NAT detection** — Outbound requests use `publicAddress` for Via/Contact when behind NAT. (stack.js)
- **Upstream PR documentation** — Added UPSTREAM-PRS.md tracking fixes submitted to kirm/sip.js. (UPSTREAM-PRS.md)

## [1.0.1] - 2026-03-12

### Changed

- Updated repository URL and package metadata.
- Added `.npmignore` to exclude development files from published package.

## [1.0.0] - 2026-03-12

### Added

- Initial release — forked from [kirm/sip.js](https://github.com/kirm/sip.js) with 22+ bug fixes.
- **SipStack class** — Non-singleton, EventEmitter-based, async/await API.
- **Dialog class** — Per-call EventEmitter with audio, DTMF, end events.
- **RTP media layer** — Per-call UDP sockets, G.711 PCMU/PCMA, 20ms pacing, symmetric NAT.
- **DTMF detection** — RFC 2833 + SIP INFO + Goertzel in-band.
- **Digest auth auto-retry** — Automatic re-INVITE on 401/407.
- **Re-INVITE handling** — Hold/unhold, SDP update, codec change.
- **REFER / call transfer** — Send and receive with NOTIFY tracking.
- **OPTIONS keepalive** — Configurable ping for SIP trunk registration.
- **IP whitelist** — Reject unauthorized IPs with 403 Forbidden.
- **Rate limiting** — Concurrent call limit with 503 on overload.
- **SIP 603+** — FCC March 2026 compliant call blocking with Reason header (RFC 3326).
- **TypeScript definitions** — Full `index.d.ts` for all modules.
- **119 tests** — SIP parser, SDP, RTP codecs, DTMF, Dialog, SipStack.
