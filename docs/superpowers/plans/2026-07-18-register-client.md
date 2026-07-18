# REGISTER Client (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `RegistrationClient` in a new `register.js` module that registers the stack as a PBX extension: digest auth, auto-refresh, 423/backoff handling, clean unregister, wired into `SipStack`.

**Architecture:** `RegistrationClient` is an EventEmitter that owns one registration (one AOR, one Call-ID, incrementing CSeq). It sends REGISTER through an injected `sipSend(msg, cb)` function — the same dependency-injection pattern `Dialog` uses (`dialog.js` takes `sipSend` in options), which makes unit tests trivial (mock the send). `SipStack.register()` constructs the client with the live transaction sender and tracks it for auto-unregister on `stack.stop()`.

**Tech Stack:** Plain Node.js (no deps), ES5 prototype style matching the rest of the repo, existing `digest.js` for auth, existing `sip.js` for tag generation.

## Global Constraints

- Zero new npm dependencies (spec: "pure Node, self-contained").
- ES5 prototype style (`function Foo() {}` + `Foo.prototype.x =`), `var`, no classes/arrow functions in library code — match `stack.js`/`dialog.js` idiom exactly.
- Node >= 18 (`crypto.randomUUID` is already used in `stack.js`).
- Every feature off/transparent by default; existing behavior unchanged (spec "Compatibility rule").
- Commit messages: Conventional Commits, no AI attribution of any kind.
- Test harness: same `test(name, fn)` / `testAsync(name, fn)` pattern as `test/test-phase3.js` (assert + counters, no test framework).

## File Structure

- `register.js` (new) — `RegistrationClient` only. Exports `{ RegistrationClient }`.
- `stack.js` (modify) — add `SipStack.prototype.register`, track clients, unregister in `stop()`.
- `test/test-register.js` (new) — unit tests, mocked `sipSend`.
- `index.d.ts`, `register.d.ts` (new shim), `package.json` (exports map + test script), `README.md` — declarations and docs.

---

### Task 1: RegistrationClient — construction and successful REGISTER

**Files:**
- Create: `register.js`
- Test: `test/test-register.js`
- Modify: `package.json` (add `"test:register": "node test/test-register.js"` to scripts)

**Interfaces:**
- Consumes: `sip.generateTag()` (from `./sip`), `crypto.randomUUID()`.
- Produces: `new RegistrationClient(options)` where `options = { aor, registrarUri?, credentials?, expires?, publicAddress, port, sipSend }`. Methods `register()`, states `'unregistered'|'registering'|'registered'|'refreshing'|'unregistering'`. Events: `'registered'` `(grantedExpires)`. Property `client.state`. Later tasks add `stop()`, `'failed'`, `'unregistered'` events.

- [ ] **Step 1: Write the failing test**

Create `test/test-register.js`:

```js
// ============================================================================
// @vexyl.ai/sip — RegistrationClient Tests (Phase 1 interop)
// ============================================================================

var assert = require('assert');
var passed = 0;
var failed = 0;
var total = 0;

function test(name, fn) {
  total++;
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch(e) {
    failed++;
    console.log('  ✗ ' + name);
    console.log('    ' + e.message);
  }
}

async function testAsync(name, fn) {
  total++;
  try {
    await fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch(e) {
    failed++;
    console.log('  ✗ ' + name);
    console.log('    ' + e.message);
  }
}

var RegistrationClient = require('../register').RegistrationClient;

// Helper: build a 200 OK for a captured REGISTER
function ok200(rq, grantedExpires) {
  return {
    status: 200,
    reason: 'OK',
    headers: {
      to: { uri: rq.headers.to.uri, params: { tag: 'srv-tag' } },
      from: rq.headers.from,
      'call-id': rq.headers['call-id'],
      cseq: rq.headers.cseq,
      contact: [{ uri: rq.headers.contact[0].uri, params: { expires: String(grantedExpires) } }],
      expires: grantedExpires
    }
  };
}

console.log('\n=== RegistrationClient: basic REGISTER ===');

var mainRun = (async function() {

await testAsync('sends well-formed REGISTER and emits registered', async function() {
  var sent = [];
  var client = new RegistrationClient({
    aor: 'sip:100@pbx.local',
    publicAddress: '10.0.0.5',
    port: 5060,
    expires: 3600,
    sipSend: function(rq, cb) {
      sent.push(rq);
      setImmediate(function() { cb(ok200(rq, 3600)); });
    }
  });

  var granted = await new Promise(function(resolve, reject) {
    client.on('registered', resolve);
    client.on('failed', reject);
    client.register();
  });

  assert.strictEqual(granted, 3600);
  assert.strictEqual(client.state, 'registered');
  assert.strictEqual(sent.length, 1);
  var rq = sent[0];
  assert.strictEqual(rq.method, 'REGISTER');
  assert.strictEqual(rq.uri, 'sip:pbx.local');                    // registrar derived from AOR host
  assert.strictEqual(rq.headers.to.uri, 'sip:100@pbx.local');
  assert.strictEqual(rq.headers.from.uri, 'sip:100@pbx.local');
  assert.ok(rq.headers.from.params.tag, 'From must have tag');
  assert.strictEqual(rq.headers.cseq.method, 'REGISTER');
  assert.strictEqual(rq.headers.cseq.seq, 1);
  assert.strictEqual(rq.headers.expires, 3600);
  assert.strictEqual(rq.headers.contact[0].uri, 'sip:100@10.0.0.5:5060');
  assert.strictEqual(rq.headers['max-forwards'], 70);
  assert.ok(rq.headers['call-id'], 'must have Call-ID');
  client.stopTimers();
});

await testAsync('explicit registrarUri overrides AOR-derived registrar', async function() {
  var sent = [];
  var client = new RegistrationClient({
    aor: 'sip:100@pbx.local',
    registrarUri: 'sip:sbc.corp.example:5061',
    publicAddress: '10.0.0.5',
    port: 5060,
    sipSend: function(rq, cb) { sent.push(rq); setImmediate(function() { cb(ok200(rq, 60)); }); }
  });
  await new Promise(function(resolve, reject) {
    client.on('registered', resolve);
    client.on('failed', reject);
    client.register();
  });
  assert.strictEqual(sent[0].uri, 'sip:sbc.corp.example:5061');
  client.stopTimers();
});

})();

mainRun.then(function() {
  console.log('\n' + passed + '/' + total + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/test-register.js`
Expected: crash with `Cannot find module '../register'`

- [ ] **Step 3: Write minimal implementation**

Create `register.js`:

```js
// ============================================================================
// @vexyl.ai/sip — Registration client (RFC 3261 §10)
// Registers the stack as an extension against a PBX/registrar.
// ============================================================================

var EventEmitter = require('events').EventEmitter;
var crypto = require('crypto');
var sip = require('./sip');

function RegistrationClient(options) {
  EventEmitter.call(this);

  options = options || {};
  if (!options.aor) throw new Error('RegistrationClient: aor is required');
  if (typeof options.sipSend !== 'function') throw new Error('RegistrationClient: sipSend is required');

  this.aor = options.aor;
  this.registrarUri = options.registrarUri || deriveRegistrar(options.aor);
  this.credentials = options.credentials || null;   // {user, password, realm?}
  this.requestedExpires = options.expires || 3600;
  this.publicAddress = options.publicAddress;
  this.port = options.port || 5060;
  this._sipSend = options.sipSend;

  this.state = 'unregistered';
  this._callId = crypto.randomUUID();
  this._localTag = sip.generateTag();
  this._cseq = 0;
  this._refreshTimer = null;
}

RegistrationClient.prototype = Object.create(EventEmitter.prototype);
RegistrationClient.prototype.constructor = RegistrationClient;

// Registrar URI = AOR without the user part: sip:100@pbx.local → sip:pbx.local
function deriveRegistrar(aor) {
  var parsed = sip.parseUri(aor);
  if (!parsed) throw new Error('RegistrationClient: cannot parse aor: ' + aor);
  return parsed.schema + ':' + parsed.host + (parsed.port ? ':' + parsed.port : '');
}

RegistrationClient.prototype._contactUri = function() {
  var parsed = sip.parseUri(this.aor);
  var user = (parsed && parsed.user) || 'vexyl';
  return 'sip:' + user + '@' + this.publicAddress + ':' + this.port;
};

RegistrationClient.prototype._buildRegister = function(expires) {
  this._cseq++;
  return {
    method: 'REGISTER',
    uri: this.registrarUri,
    headers: {
      to: { uri: this.aor },
      from: { uri: this.aor, params: { tag: this._localTag } },
      'call-id': this._callId,
      cseq: { method: 'REGISTER', seq: this._cseq },
      contact: [{ uri: this._contactUri() }],
      expires: expires,
      'max-forwards': 70
    }
  };
};

RegistrationClient.prototype.register = function() {
  if (this.state === 'registering' || this.state === 'refreshing') return;
  this.state = this.state === 'registered' ? 'refreshing' : 'registering';
  this._sendRegister(this._buildRegister(this.requestedExpires));
};

RegistrationClient.prototype._sendRegister = function(rq) {
  var self = this;
  this._sipSend(rq, function(rs) {
    self._onResponse(rq, rs);
  });
};

RegistrationClient.prototype._onResponse = function(rq, rs) {
  if (rs.status >= 200 && rs.status < 300) {
    var granted = grantedExpires(rs, this.requestedExpires);
    this.state = 'registered';
    this._scheduleRefresh(granted);
    this.emit('registered', granted);
    return;
  }
};

// Granted expiry: matching Contact param wins, then Expires header, then requested
function grantedExpires(rs, fallback) {
  if (rs.headers.contact && rs.headers.contact.length > 0) {
    var params = rs.headers.contact[0].params;
    if (params && params.expires !== undefined) {
      var e = parseInt(params.expires, 10);
      if (!isNaN(e)) return e;
    }
  }
  if (rs.headers.expires !== undefined) {
    var eh = parseInt(rs.headers.expires, 10);
    if (!isNaN(eh)) return eh;
  }
  return fallback;
}

// Re-REGISTER at 80% of granted interval
RegistrationClient.prototype._scheduleRefresh = function(granted) {
  var self = this;
  this._clearRefresh();
  this._refreshTimer = setTimeout(function() {
    self.register();
  }, Math.max(granted * 800, 1000));   // granted is seconds; 80% in ms; floor 1s
};

RegistrationClient.prototype._clearRefresh = function() {
  if (this._refreshTimer) {
    clearTimeout(this._refreshTimer);
    this._refreshTimer = null;
  }
};

// Test/teardown helper — cancels pending timers without sending anything
RegistrationClient.prototype.stopTimers = function() {
  this._clearRefresh();
};

exports.RegistrationClient = RegistrationClient;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/test-register.js`
Expected: `2/2 passed, 0 failed`, exit 0

- [ ] **Step 5: Add test script and commit**

In `package.json` scripts add: `"test:register": "node test/test-register.js"`.

```bash
git add register.js test/test-register.js package.json
git commit -m "feat(register): RegistrationClient with basic REGISTER flow"
```

---

### Task 2: Digest auth — 401/407 retry, double-401 failure

**Files:**
- Modify: `register.js`
- Test: `test/test-register.js` (append)

**Interfaces:**
- Consumes: `digest.signRequest(authCtx, rq, rs, creds)` from `./digest` — mutates `rq` adding the Authorization header, returns ctx or null; `authCtx.stale` is set when the server reports a stale nonce (same usage as `stack.js:293`).
- Produces: `'failed'` event `(err, willRetry)`. Auth retry is transparent; `client._authCtx` holds digest state across refreshes.

- [ ] **Step 1: Write the failing tests**

Append to `test/test-register.js` inside the async block (before the closing `})();`):

```js
console.log('\n=== RegistrationClient: digest auth ===');

function challenge401(rq) {
  return {
    status: 401,
    reason: 'Unauthorized',
    headers: {
      to: { uri: rq.headers.to.uri, params: { tag: 'srv-tag' } },
      from: rq.headers.from,
      'call-id': rq.headers['call-id'],
      cseq: rq.headers.cseq,
      'www-authenticate': [{
        scheme: 'Digest',
        realm: '"pbx"',
        nonce: '"abc123"',
        algorithm: 'MD5',
        qop: '"auth"'
      }]
    }
  };
}

await testAsync('401 → signed retry → registered', async function() {
  var sent = [];
  var client = new RegistrationClient({
    aor: 'sip:100@pbx.local',
    publicAddress: '10.0.0.5',
    port: 5060,
    credentials: { user: '100', password: 'secret' },
    sipSend: function(rq, cb) {
      sent.push(rq);
      if (sent.length === 1) setImmediate(function() { cb(challenge401(rq)); });
      else setImmediate(function() { cb(ok200(rq, 300)); });
    }
  });
  var granted = await new Promise(function(resolve, reject) {
    client.on('registered', resolve);
    client.on('failed', reject);
    client.register();
  });
  assert.strictEqual(granted, 300);
  assert.strictEqual(sent.length, 2);
  assert.strictEqual(sent[1].headers.cseq.seq, 2, 'retry must bump CSeq');
  assert.ok(sent[1].headers.authorization, 'retry must carry Authorization');
  client.stopTimers();
});

await testAsync('second 401 → failed(willRetry=false), no third attempt', async function() {
  var sent = [];
  var client = new RegistrationClient({
    aor: 'sip:100@pbx.local',
    publicAddress: '10.0.0.5',
    port: 5060,
    credentials: { user: '100', password: 'wrong' },
    sipSend: function(rq, cb) {
      sent.push(rq);
      setImmediate(function() { cb(challenge401(rq)); });
    }
  });
  var result = await new Promise(function(resolve) {
    client.on('failed', function(err, willRetry) { resolve({ err: err, willRetry: willRetry }); });
    client.register();
  });
  assert.strictEqual(result.willRetry, false);
  assert.ok(/auth/i.test(result.err.message));
  assert.strictEqual(sent.length, 2, 'must not hammer registrar');
  assert.strictEqual(client.state, 'unregistered');
  client.stopTimers();
});

await testAsync('401 with no credentials → failed immediately', async function() {
  var client = new RegistrationClient({
    aor: 'sip:100@pbx.local',
    publicAddress: '10.0.0.5',
    port: 5060,
    sipSend: function(rq, cb) { setImmediate(function() { cb(challenge401(rq)); }); }
  });
  var result = await new Promise(function(resolve) {
    client.on('failed', function(err, willRetry) { resolve({ willRetry: willRetry }); });
    client.register();
  });
  assert.strictEqual(result.willRetry, false);
  client.stopTimers();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node test/test-register.js`
Expected: the three new tests fail (client currently ignores non-2xx, promises hang → use the existing pattern: they will time out as failures or hang; if hang, that IS the failure signal — kill and proceed)

- [ ] **Step 3: Implement auth handling**

In `register.js` constructor add:

```js
  this._authCtx = {};
  this._authAttempted = false;
```

Replace `_onResponse` with:

```js
RegistrationClient.prototype._onResponse = function(rq, rs) {
  var self = this;

  if (rs.status >= 200 && rs.status < 300) {
    this._authAttempted = false;   // fresh auth cycle for next refresh
    var granted = grantedExpires(rs, this.requestedExpires);
    this.state = 'registered';
    this._scheduleRefresh(granted);
    this.emit('registered', granted);
    return;
  }

  if (rs.status === 401 || rs.status === 407) {
    // RFC 2617: retry once with signed request; also retry when nonce is stale
    if (this.credentials && (!this._authAttempted || this._authCtx.stale)) {
      this._authAttempted = true;
      var retry = this._buildRegister(this.requestedExpires);
      var digest = require('./digest');
      digest.signRequest(this._authCtx, retry, rs, this.credentials);
      this._sendRegister(retry);
      return;
    }
    this._fail(new Error('Registration auth failed (' + rs.status + ')'), false);
    return;
  }
};

RegistrationClient.prototype._fail = function(err, willRetry) {
  if (!willRetry) this.state = 'unregistered';
  this.emit('failed', err, willRetry);
};
```

Move `var digest = require('./digest');` to the top of the file with the other requires (`var digest = require('./digest');` after `var sip = ...`), and drop the inline require.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test/test-register.js`
Expected: `5/5 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add register.js test/test-register.js
git commit -m "feat(register): digest auth retry with double-401 protection"
```

---

### Task 3: 423 Interval Too Brief

**Files:**
- Modify: `register.js`
- Test: `test/test-register.js` (append)

**Interfaces:**
- Consumes: response header `min-expires` (number or numeric string).
- Produces: transparent single retry with the server's minimum.

- [ ] **Step 1: Write the failing test**

Append inside the async block:

```js
console.log('\n=== RegistrationClient: 423 handling ===');

await testAsync('423 → retry with Min-Expires → registered', async function() {
  var sent = [];
  var client = new RegistrationClient({
    aor: 'sip:100@pbx.local',
    publicAddress: '10.0.0.5',
    port: 5060,
    expires: 60,
    sipSend: function(rq, cb) {
      sent.push(rq);
      if (sent.length === 1) {
        setImmediate(function() { cb({
          status: 423, reason: 'Interval Too Brief',
          headers: {
            to: rq.headers.to, from: rq.headers.from,
            'call-id': rq.headers['call-id'], cseq: rq.headers.cseq,
            'min-expires': 1800
          }
        }); });
      } else {
        setImmediate(function() { cb(ok200(rq, 1800)); });
      }
    }
  });
  var granted = await new Promise(function(resolve, reject) {
    client.on('registered', resolve);
    client.on('failed', function(e) { reject(e); });
    client.register();
  });
  assert.strictEqual(granted, 1800);
  assert.strictEqual(sent[1].headers.expires, 1800, 'retry must use Min-Expires');
  client.stopTimers();
});

await testAsync('double 423 → failed, no loop', async function() {
  var sent = [];
  var client = new RegistrationClient({
    aor: 'sip:100@pbx.local',
    publicAddress: '10.0.0.5',
    port: 5060,
    expires: 60,
    sipSend: function(rq, cb) {
      sent.push(rq);
      setImmediate(function() { cb({
        status: 423, reason: 'Interval Too Brief',
        headers: { to: rq.headers.to, from: rq.headers.from,
                   'call-id': rq.headers['call-id'], cseq: rq.headers.cseq,
                   'min-expires': 1800 }
      }); });
    }
  });
  var result = await new Promise(function(resolve) {
    client.on('failed', function(err, willRetry) { resolve({ willRetry: willRetry }); });
    client.register();
  });
  assert.strictEqual(result.willRetry, false);
  assert.strictEqual(sent.length, 2);
  client.stopTimers();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node test/test-register.js`
Expected: new tests fail/hang (423 unhandled)

- [ ] **Step 3: Implement**

In the constructor add `this._retried423 = false;`. In `_onResponse`, after the 401/407 block:

```js
  if (rs.status === 423) {
    var minExpires = parseInt(rs.headers['min-expires'], 10);
    if (!this._retried423 && !isNaN(minExpires)) {
      this._retried423 = true;
      this.requestedExpires = minExpires;
      this._sendRegister(this._buildRegister(minExpires));
      return;
    }
    this._fail(new Error('Registration rejected: 423 Interval Too Brief'), false);
    return;
  }
```

In the 2xx branch also reset `this._retried423 = false;`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test/test-register.js`
Expected: `7/7 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add register.js test/test-register.js
git commit -m "feat(register): honor 423 Min-Expires with single retry"
```

---

### Task 4: Transport failure — exponential backoff

**Files:**
- Modify: `register.js`
- Test: `test/test-register.js` (append)

**Interfaces:**
- Consumes: `sip.js` transaction timeout surfaces as a `408`-style response via the send callback (`stack.js:1094` shows the transaction layer synthesizing `makeResponse(rq, 408)` on timeout). Treat 408 and 503 as transport-level failures.
- Produces: `'failed'` `(err, willRetry=true)` + automatic retry. Backoff: 1s, 2s, 4s … cap 60s, reset on success. `options.backoffFloorMs` (default 1000) exists so tests run fast.

- [ ] **Step 1: Write the failing test**

Append inside the async block:

```js
console.log('\n=== RegistrationClient: transport failure backoff ===');

await testAsync('408 → failed(willRetry=true) → auto-retry succeeds', async function() {
  var sent = [];
  var failures = [];
  var client = new RegistrationClient({
    aor: 'sip:100@pbx.local',
    publicAddress: '10.0.0.5',
    port: 5060,
    backoffFloorMs: 10,           // fast test
    sipSend: function(rq, cb) {
      sent.push(rq);
      if (sent.length === 1) {
        setImmediate(function() { cb({ status: 408, reason: 'Request Timeout',
          headers: { to: rq.headers.to, from: rq.headers.from,
                     'call-id': rq.headers['call-id'], cseq: rq.headers.cseq } }); });
      } else {
        setImmediate(function() { cb(ok200(rq, 300)); });
      }
    }
  });
  client.on('failed', function(err, willRetry) { failures.push(willRetry); });
  var granted = await new Promise(function(resolve) {
    client.on('registered', resolve);
    client.register();
  });
  assert.strictEqual(granted, 300);
  assert.deepStrictEqual(failures, [true]);
  assert.strictEqual(sent.length, 2);
  client.stopTimers();
});

await testAsync('backoff delay doubles', async function() {
  var times = [];
  var client = new RegistrationClient({
    aor: 'sip:100@pbx.local',
    publicAddress: '10.0.0.5',
    port: 5060,
    backoffFloorMs: 20,
    sipSend: function(rq, cb) {
      times.push(Date.now());
      if (times.length <= 3) {
        setImmediate(function() { cb({ status: 503, reason: 'Service Unavailable',
          headers: { to: rq.headers.to, from: rq.headers.from,
                     'call-id': rq.headers['call-id'], cseq: rq.headers.cseq } }); });
      } else {
        setImmediate(function() { cb(ok200(rq, 300)); });
      }
    }
  });
  await new Promise(function(resolve) {
    client.on('registered', resolve);
    client.register();
  });
  assert.strictEqual(times.length, 4);
  var gap1 = times[1] - times[0];
  var gap2 = times[2] - times[1];
  assert.ok(gap2 >= gap1 * 1.5, 'second gap (' + gap2 + 'ms) should be ~2x first (' + gap1 + 'ms)');
  client.stopTimers();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node test/test-register.js`
Expected: new tests fail/hang (408/503 unhandled)

- [ ] **Step 3: Implement**

Constructor additions:

```js
  this._backoffFloorMs = options.backoffFloorMs || 1000;
  this._backoffMs = this._backoffFloorMs;
  this._backoffTimer = null;
```

In `_onResponse`, add after the 423 block (this is the terminal else — any other non-2xx is a retryable failure):

```js
  // 408 (transaction timeout), 503, and anything else unexpected: retry with backoff
  var self2 = this;
  this._fail(new Error('Registration failed: ' + rs.status + ' ' + (rs.reason || '')), true);
  this._backoffTimer = setTimeout(function() {
    self2._backoffTimer = null;
    self2._sendRegister(self2._buildRegister(self2.requestedExpires));
  }, this._backoffMs);
  this._backoffMs = Math.min(this._backoffMs * 2, 60000);
```

In the 2xx branch reset backoff: `this._backoffMs = this._backoffFloorMs;`.
`_fail` keeps state as-is when `willRetry` is true (do not force `unregistered` mid-retry): it already only resets state when `!willRetry`.
Extend `stopTimers` to also clear `_backoffTimer`:

```js
RegistrationClient.prototype.stopTimers = function() {
  this._clearRefresh();
  if (this._backoffTimer) {
    clearTimeout(this._backoffTimer);
    this._backoffTimer = null;
  }
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test/test-register.js`
Expected: `9/9 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add register.js test/test-register.js
git commit -m "feat(register): exponential backoff on transport failure"
```

---

### Task 5: stop() — clean unregister

**Files:**
- Modify: `register.js`
- Test: `test/test-register.js` (append)

**Interfaces:**
- Produces: `client.stop()` returns a Promise; sends REGISTER with `Expires: 0` and `Contact` param `expires=0`, emits `'unregistered'`, resolves. Safe to call in any state (no-op resolve when already unregistered). Cancels refresh/backoff timers first.

- [ ] **Step 1: Write the failing test**

Append inside the async block:

```js
console.log('\n=== RegistrationClient: stop/unregister ===');

await testAsync('stop() sends Expires:0 and emits unregistered', async function() {
  var sent = [];
  var client = new RegistrationClient({
    aor: 'sip:100@pbx.local',
    publicAddress: '10.0.0.5',
    port: 5060,
    sipSend: function(rq, cb) { sent.push(rq); setImmediate(function() { cb(ok200(rq, rq.headers.expires)); }); }
  });
  await new Promise(function(resolve) { client.on('registered', resolve); client.register(); });

  var unregisteredFired = false;
  client.on('unregistered', function() { unregisteredFired = true; });
  await client.stop();

  assert.strictEqual(client.state, 'unregistered');
  assert.strictEqual(unregisteredFired, true);
  var last = sent[sent.length - 1];
  assert.strictEqual(last.headers.expires, 0);
  assert.strictEqual(last.headers.cseq.seq, 2, 'unregister must bump CSeq');
});

await testAsync('stop() when never registered resolves without sending', async function() {
  var sent = [];
  var client = new RegistrationClient({
    aor: 'sip:100@pbx.local',
    publicAddress: '10.0.0.5',
    port: 5060,
    sipSend: function(rq, cb) { sent.push(rq); }
  });
  await client.stop();
  assert.strictEqual(sent.length, 0);
});

await testAsync('stop() resolves even if unregister gets no useful answer', async function() {
  var calls = 0;
  var client = new RegistrationClient({
    aor: 'sip:100@pbx.local',
    publicAddress: '10.0.0.5',
    port: 5060,
    sipSend: function(rq, cb) {
      calls++;
      if (calls === 1) setImmediate(function() { cb(ok200(rq, 300)); });
      else setImmediate(function() { cb({ status: 503, reason: 'Service Unavailable',
        headers: { to: rq.headers.to, from: rq.headers.from,
                   'call-id': rq.headers['call-id'], cseq: rq.headers.cseq } }); });
    }
  });
  await new Promise(function(resolve) { client.on('registered', resolve); client.register(); });
  await client.stop();   // must not hang or loop on the 503
  assert.strictEqual(client.state, 'unregistered');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node test/test-register.js`
Expected: `client.stop is not a function`

- [ ] **Step 3: Implement**

```js
// Unregister: Expires 0. Resolves regardless of the registrar's answer —
// teardown must never hang on a dead registrar.
RegistrationClient.prototype.stop = function() {
  var self = this;
  this.stopTimers();

  if (this.state === 'unregistered' || this.state === 'unregistering') {
    this.state = 'unregistered';
    return Promise.resolve();
  }

  this.state = 'unregistering';
  return new Promise(function(resolve) {
    var rq = self._buildRegister(0);
    var done = false;
    var finish = function() {
      if (done) return;
      done = true;
      self.state = 'unregistered';
      self.emit('unregistered');
      resolve();
    };
    var guard = setTimeout(finish, 2000);   // registrar unreachable → resolve anyway
    self._sipSend(rq, function(rs) {
      // Auth the unregister if challenged, once
      if ((rs.status === 401 || rs.status === 407) && self.credentials && !done) {
        var retry = self._buildRegister(0);
        digest.signRequest(self._authCtx, retry, rs, self.credentials);
        self._sipSend(retry, function() { clearTimeout(guard); finish(); });
        return;
      }
      clearTimeout(guard);
      finish();
    });
  });
};
```

Also add `getStats()` (spec promises it) with a quick assertion in the first stop() test (`assert.strictEqual(client.getStats().state, 'unregistered')` after stop):

```js
RegistrationClient.prototype.getStats = function() {
  return {
    aor: this.aor,
    registrarUri: this.registrarUri,
    state: this.state,
    cseq: this._cseq,
    requestedExpires: this.requestedExpires
  };
};
```

Guard `_onResponse` against acting while unregistering — first line:

```js
  if (this.state === 'unregistering' || this.state === 'unregistered') return;
```

(Prevents a late refresh response from re-scheduling timers after stop. The stop() flow uses its own callbacks, not `_onResponse`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test/test-register.js`
Expected: `12/12 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add register.js test/test-register.js
git commit -m "feat(register): clean unregister on stop with hang guard"
```

---

### Task 6: SipStack integration

**Files:**
- Modify: `stack.js` (constructor, `stop()`, new `register` method — insert after `sendOptions`, around `stack.js:600`)
- Test: `test/test-register.js` (append)

**Interfaces:**
- Consumes: `RegistrationClient` from Task 1–5 (constructor options `{aor, registrarUri, credentials, expires, publicAddress, port, sipSend, backoffFloorMs}`, methods `register()`, `stop()`, `stopTimers()`).
- Produces: `SipStack.prototype.register(aor, options)` → returns the `RegistrationClient` (already `register()`ed). `stack.stop()` unregisters all clients before transport teardown. `stack.getRegistrations()` → array of clients.

- [ ] **Step 1: Write the failing test**

Append inside the async block:

```js
console.log('\n=== SipStack.register integration ===');

var SipStack = require('../stack').SipStack;

await testAsync('stack.register returns started client; stack.stop unregisters', async function() {
  var stack = new SipStack({ port: 45061, publicAddress: '127.0.0.1' });
  await stack.start();

  var sent = [];
  // Inject: intercept the transaction sender the stack hands to clients
  var client = stack.register('sip:100@127.0.0.1:45999', {
    credentials: { user: '100', password: 'x' },
    _sipSendOverride: function(rq, cb) {
      sent.push(rq);
      setImmediate(function() { cb(ok200(rq, 60)); });
    }
  });

  await new Promise(function(resolve) { client.on('registered', resolve); });
  assert.strictEqual(sent[0].method, 'REGISTER');
  assert.strictEqual(stack.getRegistrations().length, 1);

  await stack.stop();
  assert.strictEqual(client.state, 'unregistered');
  var last = sent[sent.length - 1];
  assert.strictEqual(last.headers.expires, 0, 'stop must unregister');
  assert.strictEqual(stack.getRegistrations().length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/test-register.js`
Expected: `stack.register is not a function`

- [ ] **Step 3: Implement**

`stack.js` — top of file, with the other requires: `var RegistrationClient = require('./register').RegistrationClient;`

Constructor (after the `_credentials` line):

```js
  // Interop phase 1: registration clients
  this._registrations = [];
```

New methods after `sendOptions` (~line 600):

```js
// ============================================================================
// Interop phase 1: REGISTER client (RFC 3261 §10)
// ============================================================================
SipStack.prototype.register = function(aor, options) {
  if (!this.active || !this._instance) throw new Error('SipStack not started');
  options = options || {};

  var self = this;
  var client = new RegistrationClient({
    aor: aor,
    registrarUri: options.registrarUri,
    credentials: options.credentials || this._credentials,
    expires: options.expires,
    publicAddress: this.options.publicAddress || this.options.hostname || '127.0.0.1',
    port: this.options.port,
    backoffFloorMs: options.backoffFloorMs,
    sipSend: options._sipSendOverride || this._instance.send.bind(this._instance)
  });

  this._registrations.push(client);
  client.on('unregistered', function() {
    var i = self._registrations.indexOf(client);
    if (i !== -1) self._registrations.splice(i, 1);
  });

  // T-28 reuse: OPTIONS keepalive toward the registrar for NAT hole-punching
  if (options.keepalive) {
    this._keepaliveTargets.push({ uri: client.registrarUri, interval: options.keepaliveInterval });
    this._startKeepalives && this._startKeepalives();
  }

  client.register();
  return client;
};

SipStack.prototype.getRegistrations = function() {
  return this._registrations.slice();
};
```

Note: check the actual keepalive start method name with `grep -n "keepalive" stack.js` — the plan assumes `_startKeepalives`; if the real name differs (e.g. `_setupKeepalives`), use that. If keepalives only start inside `start()`, push the target and call the same method `start()` calls.

In `stop()`, before `self._stopKeepalives();` add:

```js
    // Interop phase 1: unregister everything first, while transport is alive
    var regs = self._registrations.slice();
    self._registrations = [];
    var unregPromises = regs.map(function(r) { return r.stop().catch(function() {}); });
```

and change the dialog-cleanup Promise chain to wait for both:

```js
    Promise.all(unregPromises.concat(cleanupPromises)).then(function() {
```

(the existing `Promise.all(cleanupPromises)` line becomes this).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test/test-register.js`
Expected: `13/13 passed, 0 failed`

Also run regression: `npm run test:all`
Expected: all existing phase tests still pass

- [ ] **Step 5: Commit**

```bash
git add stack.js test/test-register.js
git commit -m "feat(stack): register() API with auto-unregister on stop"
```

---

### Task 7: Type declarations, exports map, README

**Files:**
- Modify: `index.d.ts` (add after the `StackStats` interface, before `export class SipStack`), `package.json` (exports), `README.md` (API reference section after Dialog)
- Create: `register.d.ts`

**Interfaces:**
- Consumes: everything shipped in Tasks 1–6.
- Produces: typed public API on `@vexyl.ai/sip` and `@vexyl.ai/sip/register`.

- [ ] **Step 1: Add declarations to `index.d.ts`**

```ts
// ============================================================================
// Registration client (register.js) — RFC 3261 §10
// ============================================================================

export interface RegistrationOptions {
  registrarUri?: string;
  credentials?: { user: string; password: string; realm?: string };
  expires?: number;
  keepalive?: boolean;
  keepaliveInterval?: number;
  backoffFloorMs?: number;
}

export type RegistrationState =
  | 'unregistered' | 'registering' | 'registered'
  | 'refreshing' | 'unregistering';

export class RegistrationClient extends EventEmitter {
  aor: string;
  registrarUri: string;
  state: RegistrationState;

  register(): void;
  stop(): Promise<void>;
  stopTimers(): void;
  getStats(): {
    aor: string;
    registrarUri: string;
    state: RegistrationState;
    cseq: number;
    requestedExpires: number;
  };

  on(event: 'registered', listener: (grantedExpires: number) => void): this;
  on(event: 'unregistered', listener: () => void): this;
  on(event: 'failed', listener: (err: Error, willRetry: boolean) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
}
```

And inside `export class SipStack` add:

```ts
  register(aor: string, options?: RegistrationOptions): RegistrationClient;
  getRegistrations(): RegistrationClient[];
```

- [ ] **Step 2: Create `register.d.ts` and wire exports**

`register.d.ts`:

```ts
// Type shim for `@vexyl.ai/sip/register` — all types live in index.d.ts
export { RegistrationClient } from './index';
export type { RegistrationOptions, RegistrationState } from './index';
```

`package.json` exports — add:

```json
    "./register": { "types": "./register.d.ts", "default": "./register.js" },
```

- [ ] **Step 3: Verify types compile**

```bash
npx tsc --noEmit --strict --moduleResolution node16 --module node16 --types node index.d.ts register.d.ts
```

Expected: exit 0. (If `tsc` is not installed locally, `npx --yes typescript@latest tsc ...`.)

- [ ] **Step 4: README section**

Add after the Dialog API reference section:

````markdown
### RegistrationClient (`@vexyl.ai/sip/register`)

Register as a PBX extension (RFC 3261 §10). Auto-refreshes at 80% of the
granted interval, retries digest auth once, honors 423 Min-Expires, backs
off exponentially on transport failure, unregisters on `stack.stop()`.

```js
const reg = stack.register('sip:100@pbx.local', {
  credentials: { user: '100', password: 'secret' },
  expires: 3600,
  keepalive: true,
});
reg.on('registered', (expires) => console.log('registered for', expires, 's'));
reg.on('failed', (err, willRetry) => console.log(err.message, { willRetry }));
await reg.stop(); // unregister
```
````

- [ ] **Step 5: Commit**

```bash
git add index.d.ts register.d.ts package.json README.md
git commit -m "docs(register): typings, register subpath export, README"
```

---

### Task 8: Integration test against Asterisk (Docker)

**Files:**
- Create: `test/asterisk/pjsip.conf`, `test/asterisk/extensions.conf`, `test/test-register-integration.js`
- Modify: `package.json` (script `"test:register-integration"`)

**Interfaces:**
- Consumes: the full Task 1–7 API.
- Produces: proof against a real registrar. Skips cleanly (exit 0, message) when Docker is unavailable.

- [ ] **Step 1: Asterisk config**

`test/asterisk/pjsip.conf`:

```ini
[transport-udp]
type=transport
protocol=udp
bind=0.0.0.0:5060

[100]
type=endpoint
context=default
disallow=all
allow=ulaw
auth=100
aors=100

[100]
type=auth
auth_type=userpass
username=100
password=test100

[100]
type=aor
max_contacts=2
remove_existing=yes
```

`test/asterisk/extensions.conf`:

```ini
[default]
exten => 600,1,Answer()
 same => n,Playback(demo-congrats)
 same => n,Hangup()
```

- [ ] **Step 2: Integration test**

`test/test-register-integration.js`:

```js
// Integration: register against real Asterisk in Docker.
// Skips (exit 0) when docker is unavailable.
var execSync = require('child_process').execSync;
var assert = require('assert');

try { execSync('docker info', { stdio: 'ignore' }); }
catch(e) { console.log('SKIP: docker not available'); process.exit(0); }

var CONTAINER = 'vexyl-sip-asterisk-test';

function sh(cmd) { return execSync(cmd, { stdio: 'pipe' }).toString(); }

async function main() {
  // Start Asterisk with our config mounted
  try { sh('docker rm -f ' + CONTAINER); } catch(e) {}
  sh('docker run -d --name ' + CONTAINER +
     ' -p 45060:5060/udp' +
     ' -v ' + __dirname + '/asterisk/pjsip.conf:/etc/asterisk/pjsip.conf:ro' +
     ' -v ' + __dirname + '/asterisk/extensions.conf:/etc/asterisk/extensions.conf:ro' +
     ' andrius/asterisk:latest');
  // Wait for Asterisk to accept SIP
  await new Promise(function(r) { setTimeout(r, 8000); });

  var SipStack = require('../stack').SipStack;
  var stack = new SipStack({ port: 45070, publicAddress: '127.0.0.1' });
  await stack.start();

  try {
    var client = stack.register('sip:100@127.0.0.1:45060', {
      credentials: { user: '100', password: 'test100' },
      expires: 120
    });

    var granted = await new Promise(function(resolve, reject) {
      var t = setTimeout(function() { reject(new Error('registration timed out')); }, 15000);
      client.on('registered', function(e) { clearTimeout(t); resolve(e); });
      client.on('failed', function(err, willRetry) {
        if (!willRetry) { clearTimeout(t); reject(err); }
      });
    });
    console.log('  ✓ registered, granted ' + granted + 's');
    assert.ok(granted > 0);

    // Verify Asterisk sees the contact
    var contacts = sh('docker exec ' + CONTAINER + ' asterisk -rx "pjsip show contacts"');
    assert.ok(/100/.test(contacts), 'Asterisk must list contact for 100');
    console.log('  ✓ contact visible in Asterisk');

    await stack.stop();
    var after = sh('docker exec ' + CONTAINER + ' asterisk -rx "pjsip show contacts"');
    assert.ok(!/Contact:\s+100\/sip/.test(after), 'contact must be gone after unregister');
    console.log('  ✓ unregistered cleanly');
    console.log('\nintegration: all passed');
  } finally {
    try { await stack.stop(); } catch(e) {}
    try { sh('docker rm -f ' + CONTAINER); } catch(e) {}
  }
}

main().catch(function(e) {
  console.error('  ✗ ' + e.message);
  try { execSync('docker rm -f ' + CONTAINER, { stdio: 'ignore' }); } catch(x) {}
  process.exit(1);
});
```

- [ ] **Step 3: Run it**

```bash
node test/test-register-integration.js
```

Expected with Docker: three ✓ lines, exit 0. Without Docker: `SKIP`, exit 0.
If the `andrius/asterisk:latest` image fails to pull or boot, try `mlan/asterisk`; adjust config mount paths to that image's layout (`/srv/etc/asterisk/`).

- [ ] **Step 4: Add script and commit**

`package.json` scripts: `"test:register-integration": "node test/test-register-integration.js"`.

```bash
git add test/asterisk test/test-register-integration.js package.json
git commit -m "test(register): integration test against Asterisk in Docker"
```

---

## Final verification

- [ ] `node test/test-register.js` — 13/13
- [ ] `npm run test:all` — no regressions
- [ ] `node test/test-register-integration.js` — passes or SKIPs
- [ ] `npx tsc --noEmit --strict --moduleResolution node16 --module node16 --types node index.d.ts register.d.ts` — exit 0
