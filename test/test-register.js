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

await testAsync('stopTimers() during pending backoff resets state so register() works again', async function() {
  var sent = [];
  var client = new RegistrationClient({
    aor: 'sip:100@pbx.local',
    publicAddress: '10.0.0.5',
    port: 5060,
    backoffFloorMs: 10000,        // stays pending for the life of this test
    sipSend: function(rq, cb) {
      sent.push(rq);
      setImmediate(function() { cb({ status: 503, reason: 'Service Unavailable',
        headers: { to: rq.headers.to, from: rq.headers.from,
                   'call-id': rq.headers['call-id'], cseq: rq.headers.cseq } }); });
    }
  });

  await new Promise(function(resolve, reject) {
    client.on('failed', function(err, willRetry) {
      if (willRetry) resolve(); else reject(err);
    });
    client.register();
  });

  assert.strictEqual(client.state, 'registering');
  assert.ok(client._backoffTimer, 'backoff retry must be pending');
  assert.strictEqual(sent.length, 1);

  client.stopTimers();

  assert.strictEqual(client.state, 'unregistered', 'stopTimers() must clear the in-progress guard');

  client.register();
  assert.strictEqual(sent.length, 2, 'register() after stopTimers() must send a fresh REGISTER');

  client.stopTimers();
});

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
  assert.strictEqual(client.getStats().state, 'unregistered');
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

console.log('\n=== SipStack.register: keepalive timer leak (bugfix regression) ===');

await testAsync('_startKeepalives is idempotent: repeated register(..., {keepalive:true}) must not orphan timers', async function() {
  var stack = new SipStack({ port: 45081, publicAddress: '127.0.0.1' });
  await stack.start();

  // Spy on global setInterval/clearInterval to count real timer creation/teardown.
  // We can't rely on _keepaliveTimers.length alone: the buggy code rebuilds the
  // array from ALL targets on every call, so its length always tracks
  // _keepaliveTargets.length whether or not earlier timers were leaked.
  var realSetInterval = global.setInterval;
  var realClearInterval = global.clearInterval;
  var setIntervalCalls = 0;
  var clearIntervalCalls = 0;
  global.setInterval = function() {
    setIntervalCalls++;
    return realSetInterval.apply(this, arguments);
  };
  global.clearInterval = function() {
    clearIntervalCalls++;
    return realClearInterval.apply(this, arguments);
  };

  try {
    var client1 = stack.register('sip:100@127.0.0.1:45999', {
      credentials: { user: '100', password: 'x' },
      keepalive: true,
      keepaliveInterval: 999999, // long enough to never fire during the test
      _sipSendOverride: function(rq, cb) {
        setImmediate(function() { cb(ok200(rq, 60)); });
      }
    });
    await new Promise(function(resolve) { client1.on('registered', resolve); });

    var client2 = stack.register('sip:200@127.0.0.1:45999', {
      credentials: { user: '200', password: 'x' },
      keepalive: true,
      keepaliveInterval: 999999,
      _sipSendOverride: function(rq, cb) {
        setImmediate(function() { cb(ok200(rq, 60)); });
      }
    });
    await new Promise(function(resolve) { client2.on('registered', resolve); });

    assert.strictEqual(stack._keepaliveTargets.length, 2, 'two keepalive targets registered');

    await stack.stop();

    assert.strictEqual(
      setIntervalCalls, clearIntervalCalls,
      'every keepalive timer ever created must be cleared by stop() (setInterval=' +
        setIntervalCalls + ', clearInterval=' + clearIntervalCalls + ')'
    );
  } finally {
    global.setInterval = realSetInterval;
    global.clearInterval = realClearInterval;
  }
});

})();

mainRun.then(function() {
  console.log('\n' + passed + '/' + total + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
});
