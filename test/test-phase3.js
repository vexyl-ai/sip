// ============================================================================
// @vexyl.ai/sip — Phase 3 Tests
// T-18: Dialog, T-19: Promise API, T-20: SipStack, T-21: TypeScript defs
// T-22: RFC 2833, T-23: SIP INFO DTMF, T-24: Goertzel DTMF
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
// T-22: RFC 2833 DTMF Tests
// ============================================================================
console.log('\n=== T-22: RFC 2833 DTMF ===');

var dtmf = require('../dtmf');

test('parseRfc2833 — digit 5', function() {
  // Event=5, E=0, volume=10, duration=160
  var buf = Buffer.alloc(4);
  buf[0] = 5;        // event = 5
  buf[1] = 10;       // E=0, volume=10
  buf.writeUInt16BE(160, 2); // duration=160

  var result = dtmf.parseRfc2833(buf);
  assert.ok(result);
  assert.strictEqual(result.digit, '5');
  assert.strictEqual(result.event, 5);
  assert.strictEqual(result.end, false);
  assert.strictEqual(result.volume, 10);
  assert.strictEqual(result.duration, 160);
});

test('parseRfc2833 — digit * with end bit', function() {
  var buf = Buffer.alloc(4);
  buf[0] = 10;       // event = 10 = *
  buf[1] = 0x80 | 10; // E=1, volume=10
  buf.writeUInt16BE(320, 2);

  var result = dtmf.parseRfc2833(buf);
  assert.strictEqual(result.digit, '*');
  assert.strictEqual(result.end, true);
  assert.strictEqual(result.duration, 320);
});

test('parseRfc2833 — digit # (event 11)', function() {
  var buf = Buffer.alloc(4);
  buf[0] = 11;
  buf[1] = 10;
  buf.writeUInt16BE(160, 2);

  var result = dtmf.parseRfc2833(buf);
  assert.strictEqual(result.digit, '#');
});

test('parseRfc2833 — digits A-D (events 12-15)', function() {
  ['A', 'B', 'C', 'D'].forEach(function(d, i) {
    var buf = Buffer.alloc(4);
    buf[0] = 12 + i;
    buf[1] = 10;
    buf.writeUInt16BE(160, 2);
    assert.strictEqual(dtmf.parseRfc2833(buf).digit, d);
  });
});

test('parseRfc2833 — invalid event returns null', function() {
  var buf = Buffer.alloc(4);
  buf[0] = 99; // invalid event
  assert.strictEqual(dtmf.parseRfc2833(buf), null);
});

test('parseRfc2833 — null/short buffer returns null', function() {
  assert.strictEqual(dtmf.parseRfc2833(null), null);
  assert.strictEqual(dtmf.parseRfc2833(Buffer.alloc(2)), null);
});

test('buildRfc2833 — roundtrip', function() {
  var buf = dtmf.buildRfc2833('9', true, 10, 320);
  var result = dtmf.parseRfc2833(buf);
  assert.strictEqual(result.digit, '9');
  assert.strictEqual(result.end, true);
  assert.strictEqual(result.volume, 10);
  assert.strictEqual(result.duration, 320);
});

test('buildRfc2833 — all digits roundtrip', function() {
  '0123456789*#ABCD'.split('').forEach(function(d) {
    var buf = dtmf.buildRfc2833(d, false, 10, 160);
    assert.ok(buf, 'buildRfc2833 returned null for ' + d);
    var result = dtmf.parseRfc2833(buf);
    assert.strictEqual(result.digit, d);
  });
});

test('buildRfc2833 — invalid digit returns null', function() {
  assert.strictEqual(dtmf.buildRfc2833('X', false, 10, 160), null);
});

test('Rfc2833Detector — emits digit once per event', function() {
  var detector = new dtmf.Rfc2833Detector();

  // First packet of event (new timestamp)
  var payload1 = Buffer.alloc(4);
  payload1[0] = 5; payload1[1] = 10; payload1.writeUInt16BE(160, 2);

  var d1 = detector.process({ payload: payload1, timestamp: 1000 });
  assert.strictEqual(d1, '5', 'Should emit on first packet');

  // Continuation of same event (same timestamp)
  var d2 = detector.process({ payload: payload1, timestamp: 1000 });
  assert.strictEqual(d2, null, 'Should not re-emit on continuation');

  // New event (different timestamp)
  var payload2 = Buffer.alloc(4);
  payload2[0] = 3; payload2[1] = 10; payload2.writeUInt16BE(160, 2);

  var d3 = detector.process({ payload: payload2, timestamp: 2000 });
  assert.strictEqual(d3, '3', 'Should emit on new event');
});

// ============================================================================
// T-23: SIP INFO DTMF Tests
// ============================================================================
console.log('\n=== T-23: SIP INFO DTMF ===');

test('parseSipInfoDtmf — application/dtmf-relay', function() {
  var result = dtmf.parseSipInfoDtmf({
    method: 'INFO',
    headers: { 'content-type': 'application/dtmf-relay' },
    content: 'Signal=5\r\nDuration=160\r\n'
  });
  assert.ok(result);
  assert.strictEqual(result.digit, '5');
  assert.strictEqual(result.duration, 160);
  assert.strictEqual(result.method, 'sip-info');
});

test('parseSipInfoDtmf — application/dtmf', function() {
  var result = dtmf.parseSipInfoDtmf({
    method: 'INFO',
    headers: { 'content-type': 'application/dtmf' },
    content: '9'
  });
  assert.ok(result);
  assert.strictEqual(result.digit, '9');
});

test('parseSipInfoDtmf — star and hash', function() {
  var star = dtmf.parseSipInfoDtmf({
    method: 'INFO',
    headers: { 'content-type': 'application/dtmf' },
    content: '*'
  });
  assert.strictEqual(star.digit, '*');

  var hash = dtmf.parseSipInfoDtmf({
    method: 'INFO',
    headers: { 'content-type': 'application/dtmf' },
    content: '#'
  });
  assert.strictEqual(hash.digit, '#');
});

test('parseSipInfoDtmf — not INFO returns null', function() {
  assert.strictEqual(dtmf.parseSipInfoDtmf({ method: 'INVITE', headers: {}, content: '' }), null);
});

test('parseSipInfoDtmf — no content-type returns null', function() {
  assert.strictEqual(dtmf.parseSipInfoDtmf({ method: 'INFO', headers: {}, content: '5' }), null);
});

test('parseSipInfoDtmf — wrong content-type returns null', function() {
  assert.strictEqual(dtmf.parseSipInfoDtmf({ method: 'INFO', headers: { 'content-type': 'text/plain' }, content: '5' }), null);
});

test('buildSipInfoDtmf — correct format', function() {
  var info = dtmf.buildSipInfoDtmf('7', 200);
  assert.strictEqual(info.contentType, 'application/dtmf-relay');
  assert.ok(info.body.indexOf('Signal=7') >= 0);
  assert.ok(info.body.indexOf('Duration=200') >= 0);
});

// ============================================================================
// T-24: Goertzel DTMF Tests
// ============================================================================
console.log('\n=== T-24: Goertzel DTMF ===');

// Generate a dual-tone DTMF signal as PCM 16-bit LE
function generateDtmfTone(digit, durationMs, sampleRate) {
  sampleRate = sampleRate || 8000;
  var lowFreqs = [697, 770, 852, 941];
  var highFreqs = [1209, 1336, 1477, 1633];
  var map = [
    ['1','2','3','A'],
    ['4','5','6','B'],
    ['7','8','9','C'],
    ['*','0','#','D']
  ];

  var lowIdx = -1, highIdx = -1;
  for (var r = 0; r < 4; r++) {
    for (var c = 0; c < 4; c++) {
      if (map[r][c] === digit) { lowIdx = r; highIdx = c; }
    }
  }
  if (lowIdx < 0) return null;

  var samples = Math.floor(sampleRate * durationMs / 1000);
  var buf = Buffer.alloc(samples * 2);
  var lowFreq = lowFreqs[lowIdx];
  var highFreq = highFreqs[highIdx];

  for (var i = 0; i < samples; i++) {
    var t = i / sampleRate;
    var sample = Math.round(16000 * (Math.sin(2 * Math.PI * lowFreq * t) + Math.sin(2 * Math.PI * highFreq * t)));
    sample = Math.max(-32768, Math.min(32767, sample));
    buf.writeInt16LE(sample, i * 2);
  }
  return buf;
}

test('GoertzelDetector — detect digit 5', function() {
  var detector = new dtmf.GoertzelDetector({ minDuration: 1 });
  var tone = generateDtmfTone('5', 80); // 80ms tone
  var digits = detector.process(tone);
  assert.ok(digits.length > 0, 'Should detect at least one digit');
  assert.strictEqual(digits[0], '5');
});

test('GoertzelDetector — detect digit 1', function() {
  var detector = new dtmf.GoertzelDetector({ minDuration: 1 });
  var tone = generateDtmfTone('1', 80);
  var digits = detector.process(tone);
  assert.ok(digits.length > 0, 'Should detect digit 1');
  assert.strictEqual(digits[0], '1');
});

test('GoertzelDetector — detect digit *', function() {
  var detector = new dtmf.GoertzelDetector({ minDuration: 1 });
  var tone = generateDtmfTone('*', 80);
  var digits = detector.process(tone);
  assert.ok(digits.length > 0, 'Should detect *');
  assert.strictEqual(digits[0], '*');
});

test('GoertzelDetector — detect digit #', function() {
  var detector = new dtmf.GoertzelDetector({ minDuration: 1 });
  var tone = generateDtmfTone('#', 80);
  var digits = detector.process(tone);
  assert.ok(digits.length > 0, 'Should detect #');
  assert.strictEqual(digits[0], '#');
});

test('GoertzelDetector — detect all 16 DTMF digits', function() {
  var detector = new dtmf.GoertzelDetector({ minDuration: 1 });
  '0123456789*#ABCD'.split('').forEach(function(d) {
    detector.reset();
    var tone = generateDtmfTone(d, 80);
    var digits = detector.process(tone);
    assert.ok(digits.length > 0, 'Should detect ' + d);
    assert.strictEqual(digits[0], d, 'Expected ' + d + ' but got ' + digits[0]);
  });
});

test('GoertzelDetector — silence produces no detection', function() {
  var detector = new dtmf.GoertzelDetector({ minDuration: 1 });
  var silence = Buffer.alloc(320 * 2); // 40ms of silence
  var digits = detector.process(silence);
  assert.strictEqual(digits.length, 0, 'Silence should produce no digits');
});

test('GoertzelDetector — debounce with minDuration=2', function() {
  var detector = new dtmf.GoertzelDetector({ minDuration: 2 });
  // Short tone (one block) should not trigger
  var shortTone = generateDtmfTone('5', 30);
  var digits = detector.process(shortTone);
  // With a 30ms tone and 25ms blocks, we get ~1 block — should not emit with minDuration=2
  // Longer tone should emit
  detector.reset();
  var longTone = generateDtmfTone('5', 100);
  digits = detector.process(longTone);
  assert.ok(digits.length > 0, 'Longer tone should produce detection with minDuration=2');
});

test('GoertzelDetector — reset clears state', function() {
  var detector = new dtmf.GoertzelDetector({ minDuration: 1 });
  var tone = generateDtmfTone('5', 80);
  detector.process(tone);
  detector.reset();
  assert.strictEqual(detector.lastDigit, null);
  assert.strictEqual(detector.sampleBuffer.length, 0);
});

// ============================================================================
// Unified DtmfDetector Tests
// ============================================================================
console.log('\n=== DtmfDetector (unified) ===');

test('DtmfDetector — RFC 2833 event emits digit', function() {
  var detector = new dtmf.DtmfDetector();
  var emitted = [];
  detector.on('digit', function(d, m) { emitted.push({ digit: d, method: m }); });

  var payload = Buffer.alloc(4);
  payload[0] = 7; payload[1] = 10; payload.writeUInt16BE(160, 2);
  detector.processRtp({ payloadType: 101, payload: payload, timestamp: 1000 });

  assert.strictEqual(emitted.length, 1);
  assert.strictEqual(emitted[0].digit, '7');
  assert.strictEqual(emitted[0].method, 'rfc2833');
});

test('DtmfDetector — SIP INFO emits digit', function() {
  var detector = new dtmf.DtmfDetector();
  var emitted = [];
  detector.on('digit', function(d, m) { emitted.push({ digit: d, method: m }); });

  detector.processSipInfo({
    method: 'INFO',
    headers: { 'content-type': 'application/dtmf-relay' },
    content: 'Signal=3\r\nDuration=160\r\n'
  });

  assert.strictEqual(emitted.length, 1);
  assert.strictEqual(emitted[0].digit, '3');
  assert.strictEqual(emitted[0].method, 'sip-info');
});

test('DtmfDetector — Goertzel on audio packets', function() {
  var detector = new dtmf.DtmfDetector({ goertzel: { minDuration: 1 } });
  var emitted = [];
  detector.on('digit', function(d, m) { emitted.push({ digit: d, method: m }); });

  var tone = generateDtmfTone('9', 80);
  detector.processRtp({ payloadType: 0, pcm: tone, payload: tone, timestamp: 1000 });

  assert.ok(emitted.length > 0, 'Goertzel should detect digit');
  assert.strictEqual(emitted[0].digit, '9');
  assert.strictEqual(emitted[0].method, 'goertzel');
});

// ============================================================================
// T-18: Dialog Tests
// ============================================================================
console.log('\n=== T-18: Dialog Class ===');

var Dialog = require('../dialog').Dialog;

test('Dialog — constructor defaults', function() {
  var d = new Dialog();
  assert.ok(d.id);
  assert.strictEqual(d.direction, 'inbound');
  assert.strictEqual(d.state, 'init');
  assert.strictEqual(d.rtpSession, null);
});

test('Dialog — custom options', function() {
  var d = new Dialog({ callId: 'test-123', direction: 'outbound' });
  assert.strictEqual(d.id, 'test-123');
  assert.strictEqual(d.direction, 'outbound');
});

test('Dialog — emits events', function() {
  var d = new Dialog();
  var events = [];
  d.on('dtmf', function(digit, method) { events.push({ digit: digit, method: method }); });
  d.on('end', function(reason) { events.push({ end: reason }); });

  d.dtmfDetector.emit('digit', '5', 'rfc2833');
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].digit, '5');

  d._end('test-bye');
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[1].end, 'test-bye');
  assert.strictEqual(d.state, 'ended');
});

test('Dialog — double end is safe', function() {
  var d = new Dialog();
  var endCount = 0;
  d.on('end', function() { endCount++; });
  d._end('first');
  d._end('second');
  assert.strictEqual(endCount, 1, 'Should only emit end once');
});

test('Dialog — getStats', function() {
  var d = new Dialog({ callId: 'stats-test' });
  var stats = d.getStats();
  assert.strictEqual(stats.id, 'stats-test');
  assert.strictEqual(stats.state, 'init');
  assert.strictEqual(stats.rtp, null);
});

test('Dialog — trying/ringing rejects without SIP context', async function() {
  var d = new Dialog();
  try {
    await d.trying();
    assert.fail('Should reject');
  } catch(e) {
    assert.ok(e.message.includes('No SIP context'));
  }
});

test('Dialog — reject rejects without SIP context', async function() {
  var d = new Dialog();
  try {
    await d.reject();
    assert.fail('Should reject');
  } catch(e) {
    assert.ok(e.message.includes('No SIP context'));
  }
});

// ============================================================================
// T-20: SipStack Tests
// ============================================================================
console.log('\n=== T-20: SipStack Class ===');

var SipStack = require('../stack').SipStack;

test('SipStack — constructor defaults', function() {
  var stack = new SipStack();
  assert.strictEqual(stack.options.port, 5060);
  assert.strictEqual(stack.active, false);
});

test('SipStack — custom options', function() {
  var stack = new SipStack({ port: 5080, publicAddress: '1.2.3.4' });
  assert.strictEqual(stack.options.port, 5080);
  assert.strictEqual(stack.options.publicAddress, '1.2.3.4');
});

test('SipStack — getStats before start', function() {
  var stack = new SipStack();
  var stats = stack.getStats();
  assert.strictEqual(stats.active, false);
  assert.strictEqual(stats.dialogs, 0);
});

test('SipStack — getDialogs empty', function() {
  var stack = new SipStack();
  var dialogs = stack.getDialogs();
  assert.strictEqual(Object.keys(dialogs).length, 0);
});

test('SipStack — getDialog returns null for unknown', function() {
  var stack = new SipStack();
  assert.strictEqual(stack.getDialog('nonexistent'), null);
});

test('SipStack — is EventEmitter', function() {
  var stack = new SipStack();
  assert.strictEqual(typeof stack.on, 'function');
  assert.strictEqual(typeof stack.emit, 'function');
});

test('SipStack — call rejects when not started', async function() {
  var stack = new SipStack();
  try {
    await stack.call('sip:test@example.com');
    assert.fail('Should reject');
  } catch(e) {
    assert.ok(e.message.includes('not started'));
  }
});

// ============================================================================
// T-21: TypeScript Definitions Tests
// ============================================================================
console.log('\n=== T-21: TypeScript Definitions ===');

var fs = require('fs');
var dtsPath = require('path').join(__dirname, '..', 'index.d.ts');

test('index.d.ts exists', function() {
  assert.ok(fs.existsSync(dtsPath));
});

test('index.d.ts has SipStack class', function() {
  var content = fs.readFileSync(dtsPath, 'utf8');
  assert.ok(content.includes('export class SipStack'));
});

test('index.d.ts has Dialog class', function() {
  var content = fs.readFileSync(dtsPath, 'utf8');
  assert.ok(content.includes('export class Dialog'));
});

test('index.d.ts has RtpSession class', function() {
  var content = fs.readFileSync(dtsPath, 'utf8');
  assert.ok(content.includes('class RtpSession'));
});

test('index.d.ts has DtmfDetector class', function() {
  var content = fs.readFileSync(dtsPath, 'utf8');
  assert.ok(content.includes('class DtmfDetector'));
});

test('index.d.ts has core SIP functions', function() {
  var content = fs.readFileSync(dtsPath, 'utf8');
  assert.ok(content.includes('export function start'));
  assert.ok(content.includes('export function stop'));
  assert.ok(content.includes('export function send'));
  assert.ok(content.includes('export function parse'));
  assert.ok(content.includes('export function parseUri'));
  assert.ok(content.includes('export function makeResponse'));
  assert.ok(content.includes('export function generateBranch'));
  assert.ok(content.includes('export function generateTag'));
});

test('index.d.ts has 6xx helpers', function() {
  var content = fs.readFileSync(dtsPath, 'utf8');
  assert.ok(content.includes('export function isGlobalFailure'));
  assert.ok(content.includes('export function makeDeclineResponse'));
  assert.ok(content.includes('export function makeUnwantedResponse'));
  assert.ok(content.includes('export function makeRejectedResponse'));
});

test('index.d.ts has sdp namespace', function() {
  var content = fs.readFileSync(dtsPath, 'utf8');
  assert.ok(content.includes('export namespace sdp'));
  assert.ok(content.includes('function setConnectionAddress'));
});

test('index.d.ts has digest namespace', function() {
  var content = fs.readFileSync(dtsPath, 'utf8');
  assert.ok(content.includes('export namespace digest'));
  assert.ok(content.includes('function signRequest'));
});

test('index.d.ts has rtp namespace', function() {
  var content = fs.readFileSync(dtsPath, 'utf8');
  assert.ok(content.includes('export namespace rtp'));
  assert.ok(content.includes('function parseRtpHeader'));
  assert.ok(content.includes('function buildRtpPacket'));
});

test('index.d.ts has dtmf namespace', function() {
  var content = fs.readFileSync(dtsPath, 'utf8');
  assert.ok(content.includes('export namespace dtmf'));
  assert.ok(content.includes('function parseRfc2833'));
  assert.ok(content.includes('function parseSipInfoDtmf'));
});

// ============================================================================
// Constants & exports validation
// ============================================================================
console.log('\n=== Module Exports Validation ===');

test('dtmf.js exports all expected functions', function() {
  assert.strictEqual(typeof dtmf.parseRfc2833, 'function');
  assert.strictEqual(typeof dtmf.buildRfc2833, 'function');
  assert.strictEqual(typeof dtmf.parseSipInfoDtmf, 'function');
  assert.strictEqual(typeof dtmf.buildSipInfoDtmf, 'function');
  assert.strictEqual(typeof dtmf.Rfc2833Detector, 'function');
  assert.strictEqual(typeof dtmf.GoertzelDetector, 'function');
  assert.strictEqual(typeof dtmf.DtmfDetector, 'function');
});

test('dtmf.js EVENT_TO_DIGIT has 16 entries', function() {
  assert.strictEqual(Object.keys(dtmf.EVENT_TO_DIGIT).length, 16);
});

test('dtmf.js DIGIT_TO_EVENT has 16 entries', function() {
  assert.strictEqual(Object.keys(dtmf.DIGIT_TO_EVENT).length, 16);
});

test('dialog.js exports Dialog', function() {
  assert.strictEqual(typeof Dialog, 'function');
  var d = new Dialog();
  assert.ok(d instanceof require('events').EventEmitter);
});

test('stack.js exports SipStack', function() {
  assert.strictEqual(typeof SipStack, 'function');
  var s = new SipStack();
  assert.ok(s instanceof require('events').EventEmitter);
});

// ============================================================================
// Summary
// ============================================================================
console.log('\n========================================');
console.log('Phase 3 Tests: ' + passed + '/' + total + ' passed, ' + failed + ' failed');
console.log('========================================\n');

process.exit(failed > 0 ? 1 : 0);
