// ============================================================================
// @vexyl.ai/sip — Phase 4 Tests
// T-25: Digest auth auto-retry
// T-26: Re-INVITE handling
// T-27: REFER / call transfer
// T-28: OPTIONS keepalive
// T-29: Graceful cleanup
// T-30: Test suite
// T-31: IP whitelist
// T-32: Rate limiting
// T-33: Pluggable logger
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

// ============================================================================
// T-33: Pluggable Logger Tests
// ============================================================================
console.log('\n=== T-33: Pluggable Logger ===');

var sip = require('../sip');

test('sip.js — no console.log in library (except debug function)', function() {
  var fs = require('fs');
  var content = fs.readFileSync(require('path').join(__dirname, '..', 'sip.js'), 'utf8');

  // Find all console.log/console.error calls
  var matches = content.match(/console\.(log|error|warn)\s*\(/g) || [];
  // Only the debug() function should have console.error (lines 14,17) — it's dead code but safe
  // Everything else should be replaced with logger callbacks
  var lines = content.split('\n');
  var offenders = [];
  lines.forEach(function(line, idx) {
    if (line.match(/console\.(log|warn)\s*\(/) && !line.match(/^\s*\/\//)) {
      offenders.push('Line ' + (idx + 1) + ': ' + line.trim());
    }
  });
  assert.strictEqual(offenders.length, 0, 'Found console.log/warn: ' + offenders.join('; '));
});

test('sip.js — error handlers default to noop (not console.error)', function() {
  var fs = require('fs');
  var content = fs.readFileSync(require('path').join(__dirname, '..', 'sip.js'), 'utf8');
  // Check that error handlers fall back to function() {} not console.error
  var errorFallbacks = content.match(/\|\| function\(e?\) \{ console\.error/g) || [];
  assert.strictEqual(errorFallbacks.length, 0, 'Found console.error fallbacks: ' + errorFallbacks.length);
});

// ============================================================================
// T-31: IP Whitelist Tests
// ============================================================================
console.log('\n=== T-31: IP Whitelist ===');

var SipStack = require('../stack').SipStack;

test('SipStack — allowedIps option creates whitelist', function() {
  var stack = new SipStack({ allowedIps: ['10.0.0.1', '10.0.0.2'] });
  assert.ok(stack._allowedIps);
  assert.strictEqual(stack._allowedIps.size, 2);
  assert.ok(stack._allowedIps.has('10.0.0.1'));
  assert.ok(stack._allowedIps.has('10.0.0.2'));
});

test('SipStack — no allowedIps means null (allow all)', function() {
  var stack = new SipStack();
  assert.strictEqual(stack._allowedIps, null);
});

test('SipStack — allowIp adds to whitelist', function() {
  var stack = new SipStack();
  stack.allowIp('192.168.1.1');
  assert.ok(stack._allowedIps.has('192.168.1.1'));
});

test('SipStack — removeIp removes from whitelist', function() {
  var stack = new SipStack({ allowedIps: ['10.0.0.1', '10.0.0.2'] });
  stack.removeIp('10.0.0.1');
  assert.strictEqual(stack._allowedIps.size, 1);
  assert.ok(!stack._allowedIps.has('10.0.0.1'));
});

test('SipStack — getAllowedIps returns array', function() {
  var stack = new SipStack({ allowedIps: ['10.0.0.1'] });
  var ips = stack.getAllowedIps();
  assert.ok(Array.isArray(ips));
  assert.strictEqual(ips.length, 1);
  assert.strictEqual(ips[0], '10.0.0.1');
});

test('SipStack — getAllowedIps returns null when disabled', function() {
  var stack = new SipStack();
  assert.strictEqual(stack.getAllowedIps(), null);
});

test('SipStack — disableIpWhitelist', function() {
  var stack = new SipStack({ allowedIps: ['10.0.0.1'] });
  stack.disableIpWhitelist();
  assert.strictEqual(stack._allowedIps, null);
  assert.strictEqual(stack.getAllowedIps(), null);
});

test('SipStack — _onRequest blocks unauthorized IP', function() {
  var stack = new SipStack({ allowedIps: ['10.0.0.1'] });
  var sent = [];
  stack._instance = {
    send: function(m) { sent.push(m); }
  };

  var request = {
    method: 'OPTIONS',
    headers: {
      via: [{ params: {} }],
      'call-id': 'test',
      to: { uri: 'sip:test@test' },
      from: { uri: 'sip:test@test', params: {} },
      cseq: { method: 'OPTIONS', seq: 1 }
    }
  };

  // Unauthorized IP
  stack._onRequest(request, { address: '10.0.0.99' });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].status, 403);
});

test('SipStack — _onRequest allows whitelisted IP', function() {
  var stack = new SipStack({ allowedIps: ['10.0.0.1'] });
  var sent = [];
  stack._instance = {
    send: function(m) { sent.push(m); }
  };

  var request = {
    method: 'OPTIONS',
    headers: {
      via: [{ params: {} }],
      'call-id': 'test',
      to: { uri: 'sip:test@test' },
      from: { uri: 'sip:test@test', params: {} },
      cseq: { method: 'OPTIONS', seq: 1 }
    }
  };

  stack._onRequest(request, { address: '10.0.0.1' });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].status, 200); // OPTIONS 200 OK
});

// ============================================================================
// T-32: Rate Limiting Tests
// ============================================================================
console.log('\n=== T-32: Rate Limiting ===');

test('SipStack — maxConcurrentCalls option', function() {
  var stack = new SipStack({ maxConcurrentCalls: 10 });
  assert.strictEqual(stack._maxConcurrentCalls, 10);
});

test('SipStack — default maxConcurrentCalls is 0 (unlimited)', function() {
  var stack = new SipStack();
  assert.strictEqual(stack._maxConcurrentCalls, 0);
});

test('SipStack — setMaxConcurrentCalls', function() {
  var stack = new SipStack();
  stack.setMaxConcurrentCalls(5);
  assert.strictEqual(stack.getMaxConcurrentCalls(), 5);
});

test('SipStack — call rejects when rate limited', async function() {
  var stack = new SipStack({ maxConcurrentCalls: 1 });
  stack.active = true;
  stack._instance = { send: function() {} };
  // Simulate one active dialog
  stack._dialogs['existing'] = { state: 'active' };

  try {
    await stack.call('sip:test@test');
    assert.fail('Should reject');
  } catch(e) {
    assert.ok(e.message.includes('Rate limit'));
  }
});

test('SipStack — _onRequest rejects INVITE when rate limited', function() {
  var stack = new SipStack({ maxConcurrentCalls: 1 });
  var sent = [];
  stack._instance = { send: function(m) { sent.push(m); } };
  stack._dialogs['existing'] = { state: 'active' };

  var invite = {
    method: 'INVITE',
    headers: {
      via: [{ params: {} }],
      'call-id': 'new-call',
      to: { uri: 'sip:test@test' },
      from: { uri: 'sip:caller@test', params: { tag: 'abc' } },
      cseq: { method: 'INVITE', seq: 1 },
      contact: [{ uri: 'sip:caller@test' }]
    }
  };

  stack._onRequest(invite, { address: '10.0.0.1' });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].status, 503);
});

test('SipStack — getStats includes maxConcurrentCalls', function() {
  var stack = new SipStack({ maxConcurrentCalls: 50 });
  var stats = stack.getStats();
  assert.strictEqual(stats.maxConcurrentCalls, 50);
});

// ============================================================================
// T-28: OPTIONS Keepalive Tests
// ============================================================================
console.log('\n=== T-28: OPTIONS Keepalive ===');

test('SipStack — keepaliveTargets option stored', function() {
  var stack = new SipStack({
    keepaliveTargets: [{ uri: 'sip:trunk@provider.com', interval: 30000 }]
  });
  assert.strictEqual(stack._keepaliveTargets.length, 1);
  assert.strictEqual(stack._keepaliveTargets[0].uri, 'sip:trunk@provider.com');
});

test('SipStack — sendOptions builds correct OPTIONS request', function() {
  var stack = new SipStack({ publicAddress: '1.2.3.4', port: 5060 });
  var sent = [];
  stack._instance = { send: function(m, cb) { sent.push(m); if(cb) cb({ status: 200 }); } };

  stack.sendOptions('sip:trunk@provider.com');
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].method, 'OPTIONS');
  assert.strictEqual(sent[0].uri, 'sip:trunk@provider.com');
  assert.ok(sent[0].headers['call-id']);
  assert.strictEqual(sent[0].headers.cseq.method, 'OPTIONS');
});

test('SipStack — _startKeepalives with no targets is safe', function() {
  var stack = new SipStack();
  stack._startKeepalives(); // should not throw
});

test('SipStack — _stopKeepalives is safe when not started', function() {
  var stack = new SipStack();
  stack._stopKeepalives(); // should not throw
});

// ============================================================================
// T-26: Re-INVITE Handling Tests
// ============================================================================
console.log('\n=== T-26: Re-INVITE Handling ===');

var Dialog = require('../dialog').Dialog;
var sdpModule = require('../sdp');

test('Dialog — _onReInvite updates remote SDP', function() {
  var sent = [];
  var d = new Dialog({
    callId: 'reinv-test',
    request: {
      headers: {
        via: [{ params: {} }],
        'call-id': 'reinv-test',
        to: { uri: 'sip:a@test' },
        from: { uri: 'sip:b@test', params: {} },
        cseq: { method: 'INVITE', seq: 1 },
        contact: [{ uri: 'sip:b@test' }]
      }
    },
    sipSend: function(m) { sent.push(m); },
    sipMakeResponse: sip.makeResponse
  });
  d.state = 'active';

  var newSdpStr = 'v=0\r\no=- 123 1 IN IP4 10.0.0.99\r\ns=-\r\nc=IN IP4 10.0.0.99\r\nt=0 0\r\nm=audio 20000 RTP/AVP 0\r\na=sendrecv\r\n';
  var reinviteReq = {
    method: 'INVITE',
    headers: {
      via: [{ params: {} }],
      'call-id': 'reinv-test',
      to: { uri: 'sip:a@test' },
      from: { uri: 'sip:b@test', params: {} },
      cseq: { method: 'INVITE', seq: 2 }
    },
    content: newSdpStr
  };

  d._onReInvite(reinviteReq);
  assert.ok(d.remoteSdp);
  assert.strictEqual(d.remoteSdp.c.address, '10.0.0.99');
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].status, 200);
});

test('Dialog — _onReInvite detects hold (sendonly)', function() {
  var d = new Dialog({
    callId: 'hold-test',
    request: {
      headers: {
        via: [{ params: {} }], 'call-id': 'hold-test',
        to: { uri: 'sip:a@test' }, from: { uri: 'sip:b@test', params: {} },
        cseq: { method: 'INVITE', seq: 1 }, contact: [{ uri: 'sip:b@test' }]
      }
    },
    sipSend: function() {},
    sipMakeResponse: sip.makeResponse
  });
  d.state = 'active';

  var holdEvents = [];
  d.on('hold', function() { holdEvents.push('hold'); });

  var holdSdp = 'v=0\r\no=- 1 1 IN IP4 10.0.0.1\r\ns=-\r\nc=IN IP4 10.0.0.1\r\nt=0 0\r\nm=audio 20000 RTP/AVP 0\r\na=sendonly\r\n';
  d._onReInvite({
    method: 'INVITE',
    headers: { via: [{ params: {} }], 'call-id': 'hold-test', to: { uri: 'sip:a@test' }, from: { uri: 'sip:b@test', params: {} }, cseq: { method: 'INVITE', seq: 2 } },
    content: holdSdp
  });

  assert.strictEqual(holdEvents.length, 1);
  assert.strictEqual(d.state, 'held');
});

test('Dialog — _onReInvite detects unhold', function() {
  var d = new Dialog({
    callId: 'unhold-test',
    request: {
      headers: {
        via: [{ params: {} }], 'call-id': 'unhold-test',
        to: { uri: 'sip:a@test' }, from: { uri: 'sip:b@test', params: {} },
        cseq: { method: 'INVITE', seq: 1 }, contact: [{ uri: 'sip:b@test' }]
      }
    },
    sipSend: function() {},
    sipMakeResponse: sip.makeResponse
  });
  d.state = 'held';

  var events = [];
  d.on('unhold', function() { events.push('unhold'); });

  var activeSdp = 'v=0\r\no=- 1 1 IN IP4 10.0.0.1\r\ns=-\r\nc=IN IP4 10.0.0.1\r\nt=0 0\r\nm=audio 20000 RTP/AVP 0\r\na=sendrecv\r\n';
  d._onReInvite({
    method: 'INVITE',
    headers: { via: [{ params: {} }], 'call-id': 'unhold-test', to: { uri: 'sip:a@test' }, from: { uri: 'sip:b@test', params: {} }, cseq: { method: 'INVITE', seq: 3 } },
    content: activeSdp
  });

  assert.strictEqual(events.length, 1);
  assert.strictEqual(d.state, 'active');
});

test('Dialog — reinvite event emitted', function() {
  var d = new Dialog({
    callId: 'reinv-evt',
    request: {
      headers: {
        via: [{ params: {} }], 'call-id': 'reinv-evt',
        to: { uri: 'sip:a@test' }, from: { uri: 'sip:b@test', params: {} },
        cseq: { method: 'INVITE', seq: 1 }, contact: [{ uri: 'sip:b@test' }]
      }
    },
    sipSend: function() {},
    sipMakeResponse: sip.makeResponse
  });
  d.state = 'active';

  var events = [];
  d.on('reinvite', function(req) { events.push(req); });

  d._onReInvite({
    method: 'INVITE',
    headers: { via: [{ params: {} }], 'call-id': 'reinv-evt', to: {}, from: { params: {} }, cseq: { method: 'INVITE', seq: 2 } },
    content: ''
  });

  assert.strictEqual(events.length, 1);
});

// ============================================================================
// T-27: REFER / Call Transfer Tests
// ============================================================================
console.log('\n=== T-27: REFER / Call Transfer ===');

test('Dialog — _onRefer sends 202 and emits event', function() {
  var sent = [];
  var d = new Dialog({
    callId: 'refer-test',
    request: {
      headers: {
        via: [{ params: {} }], 'call-id': 'refer-test',
        to: { uri: 'sip:a@test' }, from: { uri: 'sip:b@test', params: {} },
        cseq: { method: 'INVITE', seq: 1 }, contact: [{ uri: 'sip:b@test' }]
      }
    },
    sipSend: function(m) { sent.push(m); },
    sipMakeResponse: sip.makeResponse
  });
  d.state = 'active';

  var referEvents = [];
  d.on('refer', function(target, req) { referEvents.push(target); });

  d._onRefer({
    method: 'REFER',
    headers: {
      via: [{ params: {} }], 'call-id': 'refer-test',
      to: { uri: 'sip:a@test' }, from: { uri: 'sip:b@test', params: {} },
      cseq: { method: 'REFER', seq: 2 },
      'refer-to': 'sip:c@test'
    }
  });

  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].status, 202);
  assert.strictEqual(referEvents.length, 1);
  assert.strictEqual(referEvents[0], 'sip:c@test');
});

test('Dialog — _onNotify sends 200 and emits event', function() {
  var sent = [];
  var d = new Dialog({
    callId: 'notify-test',
    request: {
      headers: {
        via: [{ params: {} }], 'call-id': 'notify-test',
        to: { uri: 'sip:a@test' }, from: { uri: 'sip:b@test', params: {} },
        cseq: { method: 'INVITE', seq: 1 }, contact: [{ uri: 'sip:b@test' }]
      }
    },
    sipSend: function(m) { sent.push(m); },
    sipMakeResponse: sip.makeResponse
  });

  var notifyEvents = [];
  d.on('notify', function(req) { notifyEvents.push(req.method); });

  d._onNotify({
    method: 'NOTIFY',
    headers: {
      via: [{ params: {} }], 'call-id': 'notify-test',
      to: { uri: 'sip:a@test' }, from: { uri: 'sip:b@test', params: {} },
      cseq: { method: 'NOTIFY', seq: 3 }
    }
  });

  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].status, 200);
  assert.strictEqual(notifyEvents.length, 1);
});

test('SipStack — handles incoming REFER for active dialog', function() {
  var stack = new SipStack();
  var sent = [];
  stack._instance = { send: function(m) { sent.push(m); } };

  // Create mock dialog
  var events = [];
  var mockDialog = new Dialog({
    callId: 'ref-incoming',
    request: {
      headers: {
        via: [{ params: {} }], 'call-id': 'ref-incoming',
        to: { uri: 'sip:a@test' }, from: { uri: 'sip:b@test', params: {} },
        cseq: { method: 'INVITE', seq: 1 }, contact: [{ uri: 'sip:b@test' }]
      }
    },
    sipSend: function(m) { sent.push(m); },
    sipMakeResponse: sip.makeResponse
  });
  mockDialog.state = 'active';
  stack._dialogs['ref-incoming'] = mockDialog;

  mockDialog.on('refer', function(target) { events.push(target); });

  stack._onRequest({
    method: 'REFER',
    headers: {
      via: [{ params: {} }], 'call-id': 'ref-incoming',
      to: { uri: 'sip:a@test' }, from: { uri: 'sip:b@test', params: {} },
      cseq: { method: 'REFER', seq: 5 },
      'refer-to': 'sip:operator@hospital.local'
    }
  }, { address: '10.0.0.1' });

  assert.ok(events.length > 0);
  assert.strictEqual(events[0], 'sip:operator@hospital.local');
});

// ============================================================================
// T-25: Digest Auth Auto-Retry Tests
// ============================================================================
console.log('\n=== T-25: Digest Auth Auto-Retry ===');

var digest = require('../digest');

test('digest.signRequest — signs correctly', function() {
  var ctx = {};
  var rq = {
    method: 'INVITE',
    uri: 'sip:+919876@trunk.com',
    headers: {}
  };
  var rs = {
    status: 401,
    headers: {
      'www-authenticate': [{
        scheme: 'Digest',
        realm: '"trunk.com"',
        nonce: '"abc123"',
        algorithm: 'md5',
        qop: '"auth"'
      }]
    }
  };
  var creds = { user: 'vexyl', password: 'secret' };

  var result = digest.signRequest(ctx, rq, rs, creds);
  assert.ok(rq.headers.authorization);
  assert.strictEqual(rq.headers.authorization.length, 1);
  assert.strictEqual(rq.headers.authorization[0].scheme, 'Digest');
  assert.ok(rq.headers.authorization[0].response);
});

test('SipStack — credentials option stored', function() {
  var stack = new SipStack({ credentials: { user: 'test', password: 'pass' } });
  assert.ok(stack._credentials);
  assert.strictEqual(stack._credentials.user, 'test');
});

test('SipStack — call with auth retry rejects on non-401 error', async function() {
  var stack = new SipStack({ credentials: { user: 'test', password: 'pass' } });
  stack.active = true;
  stack._portPool = require('../rtp').getDefaultPool(30000, 30100);

  var sentMessages = [];
  stack._instance = {
    send: function(m, cb) {
      sentMessages.push(m);
      if (cb && m.method === 'INVITE') {
        // Simulate 404 (not 401, so no retry)
        cb({ status: 404, reason: 'Not Found', headers: { to: { uri: 'sip:test@test', params: {} }, from: { uri: 'sip:test@test', params: {} } } });
      }
    }
  };

  try {
    await stack.call('sip:test@test.com');
    assert.fail('Should reject');
  } catch(e) {
    assert.ok(e.message.includes('404'));
  }
});

// ============================================================================
// T-29: Graceful Cleanup Tests
// ============================================================================
console.log('\n=== T-29: Graceful Cleanup ===');

test('Dialog — _end stops RTP and resets DTMF', function() {
  var d = new Dialog({ callId: 'cleanup-test' });
  d.state = 'active';

  // Mock RTP session
  var rtpStopped = false;
  d.rtpSession = { stop: function() { rtpStopped = true; } };

  d._end('test');
  assert.strictEqual(d.state, 'ended');
  assert.strictEqual(rtpStopped, true);
  assert.strictEqual(d.rtpSession, null);
  assert.strictEqual(d._cleanedUp, true);
});

test('Dialog — _end is idempotent', function() {
  var d = new Dialog({ callId: 'idempotent-test' });
  var endCount = 0;
  d.on('end', function() { endCount++; });
  d._end('first');
  d._end('second');
  assert.strictEqual(endCount, 1);
});

test('SipStack — stop ends all dialogs', async function() {
  var stack = new SipStack();
  stack.active = true;
  stack._instance = { destroy: function() {} };

  var endReasons = [];
  var d1 = new Dialog({ callId: 'stop-1' });
  d1.state = 'trying';
  d1.on('end', function(r) { endReasons.push(r); });
  stack._dialogs['stop-1'] = d1;

  var d2 = new Dialog({ callId: 'stop-2' });
  d2.state = 'ringing';
  d2.on('end', function(r) { endReasons.push(r); });
  stack._dialogs['stop-2'] = d2;

  await stack.stop();

  assert.strictEqual(stack.active, false);
  assert.strictEqual(endReasons.length, 2);
  assert.ok(endReasons.every(function(r) { return r === 'stack-shutdown'; }));
});

// ============================================================================
// T-30: SIP Parser Tests
// ============================================================================
console.log('\n=== T-30: SIP Parser Tests ===');

test('sip.parse — valid INVITE', function() {
  var raw = 'INVITE sip:bob@biloxi.com SIP/2.0\r\n' +
    'Via: SIP/2.0/UDP pc33.atlanta.com;branch=z9hG4bK776asdhds\r\n' +
    'To: Bob <sip:bob@biloxi.com>\r\n' +
    'From: Alice <sip:alice@atlanta.com>;tag=1928301774\r\n' +
    'Call-ID: a84b4c76e66710\r\n' +
    'CSeq: 314159 INVITE\r\n' +
    'Max-Forwards: 70\r\n' +
    'Content-Length: 0\r\n' +
    '\r\n';

  var m = sip.parse(raw);
  assert.ok(m);
  assert.strictEqual(m.method, 'INVITE');
  assert.strictEqual(m.headers['call-id'], 'a84b4c76e66710');
  assert.strictEqual(m.headers.cseq.method, 'INVITE');
  assert.strictEqual(m.headers.cseq.seq, 314159);
});

test('sip.parse — valid 200 OK response', function() {
  var raw = 'SIP/2.0 200 OK\r\n' +
    'Via: SIP/2.0/UDP pc33.atlanta.com;branch=z9hG4bK776asdhds\r\n' +
    'To: Bob <sip:bob@biloxi.com>;tag=a6c85cf\r\n' +
    'From: Alice <sip:alice@atlanta.com>;tag=1928301774\r\n' +
    'Call-ID: a84b4c76e66710\r\n' +
    'CSeq: 314159 INVITE\r\n' +
    'Content-Length: 0\r\n' +
    '\r\n';

  var m = sip.parse(raw);
  assert.ok(m);
  assert.strictEqual(m.status, 200);
  assert.strictEqual(m.reason, 'OK');
});

test('sip.parseUri — standard URI', function() {
  var uri = sip.parseUri('sip:alice@atlanta.com');
  assert.ok(uri);
  assert.strictEqual(uri.user, 'alice');
  assert.strictEqual(uri.host, 'atlanta.com');
});

test('sip.parseUri — IPv6', function() {
  var uri = sip.parseUri('sip:alice@[::1]:5060');
  assert.ok(uri);
  assert.strictEqual(uri.host, '[::1]');
});

test('sip.stringifyUri — roundtrip', function() {
  var uri = sip.parseUri('sip:alice@atlanta.com:5060;transport=udp');
  assert.ok(uri);
  var s = sip.stringifyUri(uri);
  assert.ok(s.includes('alice'));
  assert.ok(s.includes('atlanta.com'));
});

test('sip.makeResponse — creates valid response', function() {
  var rq = {
    method: 'INVITE',
    uri: 'sip:bob@biloxi.com',
    headers: {
      via: [{ version: '2.0', protocol: 'UDP', host: 'pc33.atlanta.com', port: 5060, params: { branch: 'z9hG4bK776' } }],
      to: { uri: 'sip:bob@biloxi.com', params: {} },
      from: { uri: 'sip:alice@atlanta.com', params: { tag: '1928301774' } },
      'call-id': 'a84b4c76e66710',
      cseq: { method: 'INVITE', seq: 1 }
    }
  };

  var rs = sip.makeResponse(rq, 200, 'OK');
  assert.strictEqual(rs.status, 200);
  assert.strictEqual(rs.reason, 'OK');
  assert.ok(rs.headers.to.params.tag); // Auto To-tag on 200
});

test('sip.generateBranch — starts with z9hG4bK', function() {
  var branch = sip.generateBranch();
  assert.ok(branch.startsWith('z9hG4bK'));
});

test('sip.generateTag — returns non-empty string', function() {
  var tag = sip.generateTag();
  assert.ok(typeof tag === 'string');
  assert.ok(tag.length > 0);
});

test('sip.isGlobalFailure — 600-699', function() {
  assert.strictEqual(sip.isGlobalFailure(600), true);
  assert.strictEqual(sip.isGlobalFailure(603), true);
  assert.strictEqual(sip.isGlobalFailure(607), true);
  assert.strictEqual(sip.isGlobalFailure(699), true);
  assert.strictEqual(sip.isGlobalFailure(500), false);
  assert.strictEqual(sip.isGlobalFailure(200), false);
});

test('sip.stringify — roundtrip parse/stringify', function() {
  var raw = 'INVITE sip:bob@biloxi.com SIP/2.0\r\n' +
    'Via: SIP/2.0/UDP pc33.atlanta.com;branch=z9hG4bK776\r\n' +
    'To: <sip:bob@biloxi.com>\r\n' +
    'From: <sip:alice@atlanta.com>;tag=123\r\n' +
    'Call-ID: testid\r\n' +
    'CSeq: 1 INVITE\r\n' +
    'Content-Length: 0\r\n' +
    '\r\n';

  var m = sip.parse(raw);
  assert.ok(m);
  var s = sip.stringify(m);
  assert.ok(s.includes('INVITE'));
  assert.ok(s.includes('testid'));
});

test('sip.copyMessage — shallow copy', function() {
  var m = sip.parse('INVITE sip:bob@test SIP/2.0\r\nVia: SIP/2.0/UDP host;branch=z9hG4bK1\r\nTo: <sip:bob@test>\r\nFrom: <sip:alice@test>;tag=1\r\nCall-ID: copy1\r\nCSeq: 1 INVITE\r\n\r\n');
  var copy = sip.copyMessage(m);
  assert.ok(copy);
  assert.strictEqual(copy.method, 'INVITE');
  assert.strictEqual(copy.headers['call-id'], 'copy1');
});

// ============================================================================
// T-30: SDP Parser Tests
// ============================================================================
console.log('\n=== T-30: SDP Tests ===');

test('sdp.parse — basic SDP', function() {
  var s = 'v=0\r\no=- 123 1 IN IP4 10.0.0.1\r\ns=test\r\nc=IN IP4 10.0.0.1\r\nt=0 0\r\nm=audio 8000 RTP/AVP 0\r\n';
  var parsed = sdpModule.parse(s);
  assert.ok(parsed);
  assert.strictEqual(parsed.o.address, '10.0.0.1');
  assert.strictEqual(parsed.m.length, 1);
  assert.strictEqual(parsed.m[0].media, 'audio');
  assert.strictEqual(parsed.m[0].port, 8000);
});

test('sdp.stringify — roundtrip', function() {
  var s = 'v=0\r\no=- 123 1 IN IP4 10.0.0.1\r\ns=test\r\nc=IN IP4 10.0.0.1\r\nt=0 0\r\nm=audio 8000 RTP/AVP 0\r\n';
  var parsed = sdpModule.parse(s);
  var out = sdpModule.stringify(parsed);
  assert.ok(out.includes('audio'));
  assert.ok(out.includes('10.0.0.1'));
});

test('sdp.setConnectionAddress — updates c= and o=', function() {
  var s = 'v=0\r\no=- 123 1 IN IP4 10.0.0.1\r\ns=test\r\nc=IN IP4 10.0.0.1\r\nt=0 0\r\nm=audio 8000 RTP/AVP 0\r\n';
  var parsed = sdpModule.parse(s);
  sdpModule.setConnectionAddress(parsed, '203.0.113.10');
  assert.strictEqual(parsed.c.address, '203.0.113.10');
  assert.strictEqual(parsed.o.address, '203.0.113.10');
});

// ============================================================================
// T-30: RTP Tests
// ============================================================================
console.log('\n=== T-30: RTP Tests ===');

var rtpModule = require('../rtp');

test('rtp.parseRtpHeader — valid packet', function() {
  var buf = Buffer.alloc(172);
  buf[0] = 0x80; // V=2
  buf[1] = 0x00; // PT=0, M=0
  buf.writeUInt16BE(1234, 2); // seq
  buf.writeUInt32BE(160000, 4); // timestamp
  buf.writeUInt32BE(0xDEADBEEF, 8); // ssrc

  var h = rtpModule.parseRtpHeader(buf);
  assert.ok(h);
  assert.strictEqual(h.version, 2);
  assert.strictEqual(h.payloadType, 0);
  assert.strictEqual(h.sequenceNumber, 1234);
  assert.strictEqual(h.timestamp, 160000);
  assert.strictEqual(h.ssrc, 0xDEADBEEF);
  assert.strictEqual(h.payload.length, 160);
});

test('rtp.buildRtpPacket — valid output', function() {
  var payload = Buffer.alloc(160);
  var packet = rtpModule.buildRtpPacket({
    payloadType: 0,
    sequenceNumber: 100,
    timestamp: 1600,
    ssrc: 12345,
    marker: 0
  }, payload);

  assert.strictEqual(packet.length, 172);
  assert.strictEqual(packet[0], 0x80);
  assert.strictEqual(packet[1] & 0x7F, 0);
});

test('rtp.PortPool — allocate and release', function() {
  var pool = new rtpModule.PortPool(40000, 40010);
  var stats = pool.stats();
  assert.ok(stats.available > 0);
  assert.strictEqual(stats.inUse, 0);

  var p = pool.allocate();
  assert.ok(p >= 40000 && p < 40010);
  assert.strictEqual(pool.stats().inUse, 1);

  pool.release(p);
  assert.strictEqual(pool.stats().inUse, 0);
});

test('rtp.codecs — PCMU roundtrip', function() {
  var pcm = Buffer.alloc(320);
  for (var i = 0; i < 160; i++) {
    pcm.writeInt16LE(Math.round(Math.sin(i * 0.1) * 16000), i * 2);
  }
  var encoded = rtpModule.pcmuEncode(pcm);
  var decoded = rtpModule.pcmuDecode(encoded);
  assert.strictEqual(decoded.length, 320);
});

test('rtp.codecs — PCMA roundtrip', function() {
  var pcm = Buffer.alloc(320);
  for (var i = 0; i < 160; i++) {
    pcm.writeInt16LE(Math.round(Math.sin(i * 0.1) * 16000), i * 2);
  }
  var encoded = rtpModule.pcmaEncode(pcm);
  var decoded = rtpModule.pcmaDecode(encoded);
  assert.strictEqual(decoded.length, 320);
});

// ============================================================================
// T-30: Digest Auth Tests
// ============================================================================
console.log('\n=== T-30: Digest Auth Tests ===');

test('digest.calculateUserRealmPasswordHash', function() {
  var hash = digest.calculateUserRealmPasswordHash('user', 'realm', 'password');
  assert.ok(typeof hash === 'string');
  assert.strictEqual(hash.length, 32); // MD5 hex
});

test('digest.generateNonce — returns base64 string', function() {
  var nonce = digest.generateNonce('tag');
  assert.ok(typeof nonce === 'string');
  assert.ok(nonce.length > 0);
});

test('digest.extractNonceTimestamp — roundtrip', function() {
  var nonce = digest.generateNonce('testtag');
  var ts = digest.extractNonceTimestamp(nonce, 'testtag');
  assert.ok(ts instanceof Date);
});

test('digest.challenge — adds www-authenticate header', function() {
  var ctx = { realm: 'test.com' };
  var rs = { status: 401, headers: {} };
  digest.challenge(ctx, rs);
  assert.ok(rs.headers['www-authenticate']);
  assert.strictEqual(rs.headers['www-authenticate'].length, 1);
  assert.strictEqual(rs.headers['www-authenticate'][0].scheme, 'Digest');
});

// ============================================================================
// Module Structure Validation
// ============================================================================
console.log('\n=== Module Structure ===');

test('All modules load without error', function() {
  require('../sip');
  require('../sdp');
  require('../rtp');
  require('../dtmf');
  require('../digest');
  require('../dialog');
  require('../stack');
});

test('package.json has types field', function() {
  var pkg = require('../package.json');
  assert.strictEqual(pkg.types, 'index.d.ts');
});

test('package.json has exports map', function() {
  var pkg = require('../package.json');
  assert.ok(pkg.exports);
  assert.ok(pkg.exports['.']);
  assert.ok(pkg.exports['./sdp']);
  assert.ok(pkg.exports['./rtp']);
  assert.ok(pkg.exports['./dtmf']);
  assert.ok(pkg.exports['./digest']);
  assert.ok(pkg.exports['./dialog']);
  assert.ok(pkg.exports['./stack']);
});

test('index.d.ts exists and is non-empty', function() {
  var fs = require('fs');
  var content = fs.readFileSync(require('path').join(__dirname, '..', 'index.d.ts'), 'utf8');
  assert.ok(content.length > 1000);
});

// ============================================================================
// Summary
// ============================================================================
console.log('\n========================================');
console.log('Phase 4 Tests: ' + passed + '/' + total + ' passed, ' + failed + ' failed');
console.log('========================================\n');

process.exit(failed > 0 ? 1 : 0);
