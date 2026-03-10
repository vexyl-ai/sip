// ============================================================================
// Phase 5 Tests — VEXYL SIP Bridge (T-34, T-35)
// ============================================================================
// Run: node test/test-phase5.js

var assert = require('assert');
var EventEmitter = require('events').EventEmitter;

var passed = 0;
var failed = 0;
var total = 0;

function test(name, fn) {
  total++;
  try {
    fn();
    passed++;
    console.log('  \u2713 ' + name);
  } catch (e) {
    failed++;
    console.log('  \u2717 ' + name);
    console.log('    ' + e.message);
  }
}

// ============================================================================
// Module Loading
// ============================================================================
console.log('\nPhase 5: VEXYL SIP Bridge');
console.log('=========================\n');

var bridge = require('../vexyl-sip-bridge');

console.log('Module Exports');

test('exports VexylSipBridge constructor', function() {
  assert.strictEqual(typeof bridge.VexylSipBridge, 'function');
});

test('exports SipSession constructor', function() {
  assert.strictEqual(typeof bridge.SipSession, 'function');
});

test('exports createBridge factory', function() {
  assert.strictEqual(typeof bridge.createBridge, 'function');
});

test('exports createBridgeFromEnv factory', function() {
  assert.strictEqual(typeof bridge.createBridgeFromEnv, 'function');
});

test('exports getMode function', function() {
  assert.strictEqual(typeof bridge.getMode, 'function');
});

// ============================================================================
// VexylSipBridge Constructor
// ============================================================================
console.log('\nVexylSipBridge Constructor');

test('creates bridge with default config', function() {
  var b = new bridge.VexylSipBridge();
  assert.strictEqual(b.sipPort, 5060);
  assert.strictEqual(b.active, false);
  assert.strictEqual(b.autoAnswer, true);
  assert.strictEqual(b.defaultLanguage, 'en-IN');
  assert.strictEqual(b.maxConcurrentCalls, 0);
  assert.strictEqual(b.rtpPortMin, 10000);
  assert.strictEqual(b.rtpPortMax, 20000);
  assert.strictEqual(b.defaultCodec, 0);
});

test('creates bridge with custom config', function() {
  var b = new bridge.VexylSipBridge({
    sipPort: 5080,
    publicAddress: '1.2.3.4',
    maxConcurrentCalls: 50,
    defaultLanguage: 'ml-IN',
    autoAnswer: false,
    ringDuration: 2000,
    rtpPortMin: 30000,
    rtpPortMax: 40000,
    defaultCodec: 8
  });
  assert.strictEqual(b.sipPort, 5080);
  assert.strictEqual(b.publicAddress, '1.2.3.4');
  assert.strictEqual(b.maxConcurrentCalls, 50);
  assert.strictEqual(b.defaultLanguage, 'ml-IN');
  assert.strictEqual(b.autoAnswer, false);
  assert.strictEqual(b.ringDuration, 2000);
  assert.strictEqual(b.rtpPortMin, 30000);
  assert.strictEqual(b.rtpPortMax, 40000);
  assert.strictEqual(b.defaultCodec, 8);
});

test('creates bridge with env-style config keys', function() {
  var b = new bridge.VexylSipBridge({
    SIP_PORT: '5070',
    PUBLIC_ADDRESS: '5.6.7.8',
    SIP_MAX_CALLS: '100',
    SIP_CODEC: '8',
    DEFAULT_LANGUAGE: 'hi-IN',
    RTP_PORT_MIN: '15000',
    RTP_PORT_MAX: '25000',
    SIP_RING_DURATION: '1000'
  });
  assert.strictEqual(b.sipPort, '5070'); // string from env
  assert.strictEqual(b.publicAddress, '5.6.7.8');
  assert.strictEqual(b.maxConcurrentCalls, 100);
  assert.strictEqual(b.defaultCodec, 8);
  assert.strictEqual(b.defaultLanguage, 'hi-IN');
  assert.strictEqual(b.rtpPortMin, 15000);
  assert.strictEqual(b.rtpPortMax, 25000);
  assert.strictEqual(b.ringDuration, 1000);
});

test('parses SIP credentials from config', function() {
  var b = new bridge.VexylSipBridge({
    SIP_AUTH_USER: 'testuser',
    SIP_AUTH_PASSWORD: 'testpass'
  });
  assert.deepStrictEqual(b.sipCredentials, { user: 'testuser', password: 'testpass' });
});

test('no credentials when not provided', function() {
  var b = new bridge.VexylSipBridge({});
  assert.strictEqual(b.sipCredentials, null);
});

test('parses comma-separated IP whitelist', function() {
  var b = new bridge.VexylSipBridge({
    SIP_ALLOWED_IPS: '10.0.0.1, 10.0.0.2, 10.0.0.3'
  });
  assert.deepStrictEqual(b.allowedIps, ['10.0.0.1', '10.0.0.2', '10.0.0.3']);
});

test('accepts array IP whitelist', function() {
  var b = new bridge.VexylSipBridge({
    allowedIps: ['1.1.1.1', '2.2.2.2']
  });
  assert.deepStrictEqual(b.allowedIps, ['1.1.1.1', '2.2.2.2']);
});

test('parses keepalive target from config', function() {
  var b = new bridge.VexylSipBridge({
    SIP_KEEPALIVE_URI: 'sip:trunk@provider.com',
    SIP_KEEPALIVE_INTERVAL: '60000'
  });
  assert.strictEqual(b.keepaliveTargets.length, 1);
  assert.strictEqual(b.keepaliveTargets[0].uri, 'sip:trunk@provider.com');
  assert.strictEqual(b.keepaliveTargets[0].interval, 60000);
});

test('is an EventEmitter', function() {
  var b = new bridge.VexylSipBridge();
  assert.ok(b instanceof EventEmitter);
});


// ============================================================================
// SipSession
// ============================================================================
console.log('\nSipSession');

test('creates session with defaults', function() {
  var s = new bridge.SipSession({});
  assert.ok(s.id);
  assert.strictEqual(s.callerId, '');
  assert.strictEqual(s.callerName, '');
  assert.strictEqual(s.languageCode, 'en-IN');
  assert.strictEqual(s.state, 'init');
});

test('creates session with caller info', function() {
  var s = new bridge.SipSession({
    id: 'test-123',
    callerId: '+919876543210',
    callerName: 'Test Caller',
    remoteAddress: '10.0.0.1',
    remotePort: 5060,
    defaultLanguage: 'ml-IN'
  });
  assert.strictEqual(s.id, 'test-123');
  assert.strictEqual(s.callerId, '+919876543210');
  assert.strictEqual(s.callerName, 'Test Caller');
  assert.strictEqual(s.remoteAddress, '10.0.0.1');
  assert.strictEqual(s.remotePort, 5060);
  assert.strictEqual(s.languageCode, 'ml-IN');
});

test('is an EventEmitter', function() {
  var s = new bridge.SipSession({});
  assert.ok(s instanceof EventEmitter);
});

test('setMetadata merges metadata', function() {
  var s = new bridge.SipSession({ id: 'meta-test' });
  s.setMetadata({ language_code: 'ml-IN', custom: 'value1' });
  s.setMetadata({ extra: 'value2' });
  var meta = s.getMetadata();
  assert.strictEqual(meta.languageCode, 'ml-IN');
  assert.strictEqual(meta.custom, 'value1');
  assert.strictEqual(meta.extra, 'value2');
  assert.strictEqual(meta.sessionId, 'meta-test');
});

test('setMetadata updates languageCode', function() {
  var s = new bridge.SipSession({});
  assert.strictEqual(s.languageCode, 'en-IN');
  s.setMetadata({ language_code: 'hi-IN' });
  assert.strictEqual(s.languageCode, 'hi-IN');
});

test('setMetadata emits metadata event', function() {
  var s = new bridge.SipSession({});
  var received = null;
  s.on('metadata', function(meta) { received = meta; });
  s.setMetadata({ key: 'val' });
  assert.ok(received);
  assert.strictEqual(received.key, 'val');
});

test('_end is idempotent', function() {
  var s = new bridge.SipSession({ id: 'end-test' });
  var endCount = 0;
  s.on('end', function() { endCount++; });
  s._end('bye');
  s._end('bye');
  s._end('bye');
  assert.strictEqual(endCount, 1);
  assert.strictEqual(s.state, 'ended');
});

test('getStats returns session info', function() {
  var s = new bridge.SipSession({ id: 'stats-test', callerId: '1234' });
  var stats = s.getStats();
  assert.strictEqual(stats.id, 'stats-test');
  assert.strictEqual(stats.callerId, '1234');
  assert.strictEqual(stats.state, 'init');
  assert.strictEqual(stats.dialog, null);
});

// ============================================================================
// SipSession — Dialog wiring
// ============================================================================
console.log('\nSipSession Dialog Wiring');

// Mock dialog for testing event wiring
function MockDialog() {
  EventEmitter.call(this);
  this.id = 'mock-dialog-1';
  this._byeCalled = false;
  this._referTarget = null;
  this._holdCalled = false;
  this._unholdCalled = false;
  this._sentAudio = [];
  this._sentDtmf = [];
}
MockDialog.prototype = Object.create(EventEmitter.prototype);
MockDialog.prototype.constructor = MockDialog;
MockDialog.prototype.sendAudio = function(buf) { this._sentAudio.push(buf); };
MockDialog.prototype.sendAudioPaced = function(buf) { this._sentAudio.push(buf); return Promise.resolve(); };
MockDialog.prototype.enqueueAudio = function(buf) { this._sentAudio.push(buf); };
MockDialog.prototype.sendDtmf = function(d, dur) { this._sentDtmf.push({ digit: d, duration: dur }); };
MockDialog.prototype.bye = function() { this._byeCalled = true; return Promise.resolve(); };
MockDialog.prototype.refer = function(uri) { this._referTarget = uri; return Promise.resolve(); };
MockDialog.prototype.hold = function() { this._holdCalled = true; return Promise.resolve(); };
MockDialog.prototype.unhold = function() { this._unholdCalled = true; return Promise.resolve(); };
MockDialog.prototype.getStats = function() { return { id: this.id, direction: 'inbound', state: 'active', rtp: null }; };

test('wires dialog audio events to session', function() {
  var d = new MockDialog();
  var s = new bridge.SipSession({ dialog: d });
  var received = null;
  s.on('audio', function(pcm) { received = pcm; });
  d.emit('audio', Buffer.from([1, 2, 3]), {});
  assert.ok(received);
  assert.deepStrictEqual(received, Buffer.from([1, 2, 3]));
  assert.strictEqual(s.state, 'active'); // auto-transitions on first audio
});

test('wires dialog dtmf events to session', function() {
  var d = new MockDialog();
  var s = new bridge.SipSession({ dialog: d });
  var digit = null, method = null;
  s.on('dtmf', function(dig, meth) { digit = dig; method = meth; });
  d.emit('dtmf', '5', 'rfc2833');
  assert.strictEqual(digit, '5');
  assert.strictEqual(method, 'rfc2833');
});

test('wires dialog end event to session', function() {
  var d = new MockDialog();
  var s = new bridge.SipSession({ dialog: d });
  var reason = null;
  s.on('end', function(r) { reason = r; });
  d.emit('end', 'remote-bye');
  assert.strictEqual(reason, 'remote-bye');
  assert.strictEqual(s.state, 'ended');
});

test('wires dialog error event to session', function() {
  var d = new MockDialog();
  var s = new bridge.SipSession({ dialog: d });
  var err = null;
  s.on('error', function(e) { err = e; });
  d.emit('error', new Error('test'));
  assert.strictEqual(err.message, 'test');
});

test('wires dialog ready event to session', function() {
  var d = new MockDialog();
  var s = new bridge.SipSession({ dialog: d });
  var ready = false;
  s.on('ready', function() { ready = true; });
  d.emit('ready');
  assert.strictEqual(ready, true);
  assert.strictEqual(s.state, 'active');
});

test('sendAudio forwards to dialog', function() {
  var d = new MockDialog();
  var s = new bridge.SipSession({ dialog: d });
  s.state = 'active';
  s.sendAudio(Buffer.from([10, 20]));
  assert.strictEqual(d._sentAudio.length, 1);
});

test('sendAudio does not forward when ended', function() {
  var d = new MockDialog();
  var s = new bridge.SipSession({ dialog: d });
  s.state = 'ended';
  s.sendAudio(Buffer.from([10, 20]));
  assert.strictEqual(d._sentAudio.length, 0);
});

test('sendDtmf forwards to dialog', function() {
  var d = new MockDialog();
  var s = new bridge.SipSession({ dialog: d });
  s.state = 'active';
  s.sendDtmf('9', 250);
  assert.strictEqual(d._sentDtmf.length, 1);
  assert.strictEqual(d._sentDtmf[0].digit, '9');
});

test('hold/unhold forwards to dialog', function() {
  var d = new MockDialog();
  var s = new bridge.SipSession({ dialog: d });
  s.hold();
  s.unhold();
  assert.strictEqual(d._holdCalled, true);
  assert.strictEqual(d._unholdCalled, true);
});

test('transfer forwards to dialog.refer', function() {
  var d = new MockDialog();
  var s = new bridge.SipSession({ dialog: d });
  s.state = 'active';
  s.transfer('sip:agent@hospital.com');
  assert.strictEqual(d._referTarget, 'sip:agent@hospital.com');
});

test('getStats includes dialog stats when wired', function() {
  var d = new MockDialog();
  var s = new bridge.SipSession({ dialog: d, id: 'stats-wired' });
  var stats = s.getStats();
  assert.strictEqual(stats.dialog.id, 'mock-dialog-1');
});

// ============================================================================
// Bridge methods (without starting)
// ============================================================================
console.log('\nBridge Methods');

test('getStats returns bridge info', function() {
  var b = new bridge.VexylSipBridge({ sipPort: 5090 });
  var stats = b.getStats();
  assert.strictEqual(stats.active, false);
  assert.strictEqual(stats.mode, 'sip_bridge');
  assert.strictEqual(stats.sessions, 0);
  assert.strictEqual(stats.sipPort, 5090);
});

test('getSessions returns empty object initially', function() {
  var b = new bridge.VexylSipBridge();
  var sessions = b.getSessions();
  assert.deepStrictEqual(sessions, {});
});

test('getSession returns null for unknown id', function() {
  var b = new bridge.VexylSipBridge();
  assert.strictEqual(b.getSession('nonexistent'), null);
});

// ============================================================================
// T-35: Mode Switch
// ============================================================================
console.log('\nT-35: Mode Switch');

test('getMode returns audiosocket by default', function() {
  var orig = process.env.TELEPHONY_MODE;
  delete process.env.TELEPHONY_MODE;
  assert.strictEqual(bridge.getMode(), 'audiosocket');
  if (orig !== undefined) process.env.TELEPHONY_MODE = orig;
});

test('getMode returns sip_bridge for TELEPHONY_MODE=sip_bridge', function() {
  var orig = process.env.TELEPHONY_MODE;
  process.env.TELEPHONY_MODE = 'sip_bridge';
  assert.strictEqual(bridge.getMode(), 'sip_bridge');
  if (orig !== undefined) process.env.TELEPHONY_MODE = orig;
  else delete process.env.TELEPHONY_MODE;
});

test('getMode returns sip_bridge for TELEPHONY_MODE=sip', function() {
  var orig = process.env.TELEPHONY_MODE;
  process.env.TELEPHONY_MODE = 'sip';
  assert.strictEqual(bridge.getMode(), 'sip_bridge');
  if (orig !== undefined) process.env.TELEPHONY_MODE = orig;
  else delete process.env.TELEPHONY_MODE;
});

test('getMode returns sip_bridge for TELEPHONY_MODE=sipbridge', function() {
  var orig = process.env.TELEPHONY_MODE;
  process.env.TELEPHONY_MODE = 'sipbridge';
  assert.strictEqual(bridge.getMode(), 'sip_bridge');
  if (orig !== undefined) process.env.TELEPHONY_MODE = orig;
  else delete process.env.TELEPHONY_MODE;
});

test('getMode is case-insensitive', function() {
  var orig = process.env.TELEPHONY_MODE;
  process.env.TELEPHONY_MODE = 'SIP_BRIDGE';
  assert.strictEqual(bridge.getMode(), 'sip_bridge');
  if (orig !== undefined) process.env.TELEPHONY_MODE = orig;
  else delete process.env.TELEPHONY_MODE;
});

test('getMode returns both for TELEPHONY_MODE=both', function() {
  var orig = process.env.TELEPHONY_MODE;
  process.env.TELEPHONY_MODE = 'both';
  assert.strictEqual(bridge.getMode(), 'both');
  if (orig !== undefined) process.env.TELEPHONY_MODE = orig;
  else delete process.env.TELEPHONY_MODE;
});

test('getMode returns both for TELEPHONY_MODE=dual', function() {
  var orig = process.env.TELEPHONY_MODE;
  process.env.TELEPHONY_MODE = 'dual';
  assert.strictEqual(bridge.getMode(), 'both');
  if (orig !== undefined) process.env.TELEPHONY_MODE = orig;
  else delete process.env.TELEPHONY_MODE;
});

test('getMode returns audiosocket for unknown values', function() {
  var orig = process.env.TELEPHONY_MODE;
  process.env.TELEPHONY_MODE = 'webrtc';
  assert.strictEqual(bridge.getMode(), 'audiosocket');
  if (orig !== undefined) process.env.TELEPHONY_MODE = orig;
  else delete process.env.TELEPHONY_MODE;
});

// ============================================================================
// Factory Functions
// ============================================================================
console.log('\nFactory Functions');

test('createBridge returns VexylSipBridge instance', function() {
  var b = bridge.createBridge({ sipPort: 5099 });
  assert.ok(b instanceof bridge.VexylSipBridge);
  assert.strictEqual(b.sipPort, 5099);
});

test('createBridge with no args uses defaults', function() {
  var b = bridge.createBridge();
  assert.ok(b instanceof bridge.VexylSipBridge);
  assert.strictEqual(b.sipPort, 5060);
});

test('createBridgeFromEnv returns VexylSipBridge instance', function() {
  var b = bridge.createBridgeFromEnv();
  assert.ok(b instanceof bridge.VexylSipBridge);
});

// ============================================================================
// TypeScript definitions validation
// ============================================================================
console.log('\nTypeScript Definitions');

var fs = require('fs');
var dts = fs.readFileSync(require('path').join(__dirname, '..', 'index.d.ts'), 'utf8');

test('index.d.ts exports VexylSipBridge class', function() {
  assert.ok(dts.includes('export class VexylSipBridge'));
});

test('index.d.ts exports SipSession class', function() {
  assert.ok(dts.includes('export class SipSession'));
});

test('index.d.ts exports VexylSipBridgeConfig interface', function() {
  assert.ok(dts.includes('export interface VexylSipBridgeConfig'));
});

test('index.d.ts exports createBridge function', function() {
  assert.ok(dts.includes('export function createBridge'));
});

test('index.d.ts exports createBridgeFromEnv function', function() {
  assert.ok(dts.includes('export function createBridgeFromEnv'));
});

test('index.d.ts exports getMode function', function() {
  assert.ok(dts.includes('export function getMode'));
});

test('index.d.ts exports SipSessionMetadata interface', function() {
  assert.ok(dts.includes('export interface SipSessionMetadata'));
});

test('index.d.ts exports BridgeStats interface', function() {
  assert.ok(dts.includes('export interface BridgeStats'));
});

// ============================================================================
// Package.json validation
// ============================================================================
console.log('\nPackage.json');

var pkg = JSON.parse(fs.readFileSync(require('path').join(__dirname, '..', 'package.json'), 'utf8'));

test('package.json exports vexyl-sip-bridge', function() {
  assert.strictEqual(pkg.exports['./vexyl-sip-bridge'], './vexyl-sip-bridge.js');
});

test('package.json has test:phase5 script', function() {
  assert.ok(pkg.scripts['test:phase5']);
});

test('test:all includes phase5', function() {
  assert.ok(pkg.scripts['test:all'].includes('test-phase5'));
});

// ============================================================================
// Summary
// ============================================================================
console.log('\n' + '='.repeat(50));
console.log('Phase 5 Results: ' + passed + '/' + total + ' passed, ' + failed + ' failed');
console.log('='.repeat(50));

if (failed > 0) {
  process.exit(1);
}
