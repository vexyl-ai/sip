// ============================================================================
// @vexyl.ai/sip — RtpSession worker-pacer hook tests
//
// The pacer implementation itself lives in the host app (see patches/upstream
// README). These tests pin the library-side contract: with no pacer injected
// behavior is identical to the in-process socket path, and with one injected
// the socket, TX and teardown are delegated to it.
// ============================================================================

var assert = require('assert');
var rtp = require('../rtp');
var RtpSession = rtp.RtpSession;

var passed = 0;
var failed = 0;
var total = 0;

async function test(name, fn) {
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

// Fake pacer manager implementing the same contract as rtp-pacer.js
function fakePacer(options) {
  options = options || {};
  return {
    alive: options.alive !== false,
    calls: [],
    handlers: {},
    boundPort: options.boundPort || 40100,
    isAlive: function() { return this.alive; },
    open: function(opts) {
      this.calls.push(['open', opts.port, opts.ssrc, opts.payloadType]);
      if (options.openFails) return Promise.reject(new Error('pacer open timeout'));
      this.handlers.onRx = opts.onRx;
      // Real worker binds the requested port; only an ephemeral request (0/null)
      // comes back with a different one.
      return Promise.resolve({ sid: 7, port: opts.port || this.boundPort });
    },
    setRemote: function(sid, address, port) { this.calls.push(['setRemote', sid, address, port]); },
    sendPcm: function(sid, buf) { this.calls.push(['sendPcm', sid, buf.length]); return true; },
    sendRaw: function(sid, payload, pt, samples, marker) {
      this.calls.push(['sendRaw', sid, payload.length, pt, samples, marker]);
      return true;
    },
    flush: function(sid) { this.calls.push(['flush', sid]); return Promise.resolve(3); },
    close: function(sid) { this.calls.push(['close', sid]); }
  };
}

function names(pacer) { return pacer.calls.map(function(c) { return c[0]; }); }

function startSession(session) {
  return new Promise(function(resolve, reject) {
    session.start(function(err, addr) { err ? reject(err) : resolve(addr); });
  });
}

async function run() {
  console.log('\n=== RtpSession pacer hooks ===');

  await test('default: no pacer injected, sessions use the in-process socket', async function() {
    assert.strictEqual(RtpSession.pacer, null, 'RtpSession.pacer must default to null');
    var s = new RtpSession({ port: 0, remoteAddress: '127.0.0.1', remotePort: 40999 });
    var addr = await startSession(s);
    assert.ok(s.socket, 'legacy path must own a socket');
    assert.strictEqual(s._pacerSid, null);
    assert.ok(addr.port > 0);
    s.stop();
  });

  await test('pacer injected: worker binds the socket, session adopts its port', async function() {
    var pacer = fakePacer({ boundPort: 40120 });
    RtpSession.pacer = pacer;
    try {
      var s = new RtpSession({ port: 40120, remoteAddress: '10.0.0.5', remotePort: 5004 });
      var addr = await startSession(s);
      assert.strictEqual(s.socket, null, 'no in-process socket on the pacer path');
      assert.strictEqual(s._pacerSid, 7);
      assert.strictEqual(s.localPort, 40120);
      assert.strictEqual(addr.port, 40120);
      assert.strictEqual(s.active, true);
      assert.deepStrictEqual(pacer.calls[0], ['open', 40120, s.ssrc, s.payloadType]);
      // remote from SDP is pushed once at start
      assert.deepStrictEqual(pacer.calls[1], ['setRemote', 7, '10.0.0.5', 5004]);
      s.stop();
    } finally { RtpSession.pacer = null; }
  });

  await test('pacer path: inbound packets still reach the main-thread audio path', async function() {
    var pacer = fakePacer();
    RtpSession.pacer = pacer;
    try {
      var s = new RtpSession({ port: 40121, remoteAddress: '10.0.0.5', remotePort: 5004, jitterBuffer: false });
      await startSession(s);
      var audio = null;
      s.on('audio', function(pcm, header) { audio = header; });
      var pkt = rtp.buildRtpPacket(
        { payloadType: 0, sequenceNumber: 1, timestamp: 160, ssrc: 0x11223344 },
        Buffer.alloc(160, 0xff)
      );
      pacer.handlers.onRx(pkt, { address: '10.0.0.5', port: 5004 });
      assert.ok(audio, 'onRx must feed _onPacket');
      assert.strictEqual(audio.ssrc, 0x11223344);
      assert.strictEqual(s.stats.packetsReceived, 1);
      s.stop();
    } finally { RtpSession.pacer = null; }
  });

  await test('pacer path: sendPcm and sendPayload delegate to the worker and count stats', async function() {
    var pacer = fakePacer();
    RtpSession.pacer = pacer;
    try {
      var s = new RtpSession({ port: 40122, remoteAddress: '10.0.0.5', remotePort: 5004 });
      await startSession(s);
      s.sendPcm(Buffer.alloc(320)); // 160 samples of 16-bit PCM
      s.sendPayload(Buffer.alloc(4), { payloadType: 101, marker: 1 });
      assert.deepStrictEqual(names(pacer), ['open', 'setRemote', 'sendPcm', 'sendRaw']);
      assert.deepStrictEqual(pacer.calls[2], ['sendPcm', 7, 320]);
      assert.deepStrictEqual(pacer.calls[3], ['sendRaw', 7, 4, 101, 160, 1]);
      assert.strictEqual(s.stats.packetsSent, 2);
      assert.strictEqual(s.stats.bytesSent, (160 + 12) + (4 + 12));
      s.stop();
    } finally { RtpSession.pacer = null; }
  });

  await test('pacer path: symmetric-RTP re-latch pushes the new remote exactly once', async function() {
    var pacer = fakePacer();
    RtpSession.pacer = pacer;
    try {
      var s = new RtpSession({ port: 40123, remoteAddress: '10.0.0.5', remotePort: 5004, jitterBuffer: false });
      await startSession(s);
      var pkt = rtp.buildRtpPacket(
        { payloadType: 0, sequenceNumber: 1, timestamp: 160, ssrc: 1 }, Buffer.alloc(160)
      );
      pacer.handlers.onRx(pkt, { address: '203.0.113.9', port: 60002 }); // NAT-learned source
      s.sendPcm(Buffer.alloc(320));
      s.sendPcm(Buffer.alloc(320));
      var setRemotes = pacer.calls.filter(function(c) { return c[0] === 'setRemote'; });
      assert.strictEqual(setRemotes.length, 2, 'initial remote + one re-latch, no per-frame repeats');
      assert.deepStrictEqual(setRemotes[1], ['setRemote', 7, '203.0.113.9', 60002]);
      s.stop();
    } finally { RtpSession.pacer = null; }
  });

  await test('pacerFlush proxies to the worker; resolves 0 on the legacy path', async function() {
    var pacer = fakePacer();
    RtpSession.pacer = pacer;
    var s;
    try {
      s = new RtpSession({ port: 40124, remoteAddress: '10.0.0.5', remotePort: 5004 });
      await startSession(s);
      assert.strictEqual(await s.pacerFlush(), 3);
      s.stop();
    } finally { RtpSession.pacer = null; }

    var legacy = new RtpSession({ port: 0, remoteAddress: '127.0.0.1', remotePort: 40999 });
    await startSession(legacy);
    assert.strictEqual(await legacy.pacerFlush(), 0);
    legacy.stop();
  });

  await test('pacer open failure falls back to the in-process socket', async function() {
    var pacer = fakePacer({ openFails: true });
    RtpSession.pacer = pacer;
    try {
      var s = new RtpSession({ port: 0, remoteAddress: '127.0.0.1', remotePort: 40999 });
      var addr = await startSession(s);
      assert.strictEqual(s._pacerSid, null);
      assert.ok(s.socket, 'must fall back to a real socket');
      assert.ok(addr.port > 0);
      s.stop();
    } finally { RtpSession.pacer = null; }
  });

  await test('dead pacer is skipped entirely at start', async function() {
    var pacer = fakePacer({ alive: false });
    RtpSession.pacer = pacer;
    try {
      var s = new RtpSession({ port: 0, remoteAddress: '127.0.0.1', remotePort: 40999 });
      await startSession(s);
      assert.strictEqual(pacer.calls.length, 0, 'must not call a dead pacer');
      assert.ok(s.socket);
      s.stop();
    } finally { RtpSession.pacer = null; }
  });

  await test('stop() closes the worker session and releases the pool port', async function() {
    var pacer = fakePacer({ boundPort: 40125 });
    RtpSession.pacer = pacer;
    try {
      var pool = new rtp.PortPool(40200, 40202);
      var s = new RtpSession({ pool: pool, remoteAddress: '10.0.0.5', remotePort: 5004 });
      await startSession(s);
      var before = pool.stats().available;
      s.stop();
      assert.strictEqual(s._pacerSid, null);
      assert.deepStrictEqual(pacer.calls[pacer.calls.length - 1], ['close', 7]);
      assert.strictEqual(pool.stats().available, before + 1, 'pool port released after worker close');
    } finally { RtpSession.pacer = null; }
  });

  console.log('\n' + passed + '/' + total + ' passed, ' + failed + ' failed\n');
  process.exit(failed === 0 ? 0 : 1);
}

run();
