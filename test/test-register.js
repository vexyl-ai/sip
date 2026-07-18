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
