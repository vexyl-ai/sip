// ============================================================================
// @vexyl.ai/sip — VEXYL SIP Bridge Module
// T-34: vexyl-sip-bridge.js — additional telephony path alongside AudioSocket
// T-35: Mode switch config flag
//
// Additional telephony path that runs alongside AudioSocket in VEXYL AI Voice
// Gateway. Receives SIP calls directly from carrier trunks, extracts RTP audio
// as PCM 16-bit LE @ 8kHz, and exposes the same event interface the gateway
// expects from AudioSocket sessions.
//
// Architecture (dual-path):
//
//   AudioSocket (Asterisk) ──→ PCM ──┐
//                                    ├──→ AI Pipeline (STT/LLM/TTS)
//   SIP Trunk → @vexyl.ai/sip ──→ PCM ──┘
//
// Both paths can run concurrently (TELEPHONY_MODE=both) or individually.
// ============================================================================

var EventEmitter = require('events').EventEmitter;
var crypto = require('crypto');
var SipStack = require('./stack').SipStack;

// ============================================================================
// VexylSipBridge — main bridge class
// ============================================================================
//
// Events:
//   'session'     (session)          — new call session (same interface as AudioSocket)
//   'error'       (err)              — bridge-level error
//   'started'     ()                 — bridge ready
//   'stopped'     ()                 — bridge shut down
//
// Each session emits:
//   'audio'       (pcmBuffer)        — 8kHz PCM 16-bit LE from caller
//   'dtmf'        (digit, method)    — DTMF digit detected
//   'end'         (reason)           — session ended
//   'metadata'    (meta)             — session metadata set
//
// Session has:
//   session.sendAudio(pcmBuffer)     — send PCM to caller (8kHz 16-bit LE)
//   session.sendAudioPaced(pcmBuffer)— send with 20ms pacing
//   session.hangup()                 — end the call
//   session.transfer(uri)            — transfer call (REFER)
//   session.id                       — session UUID
//   session.callerId                 — caller phone number
//   session.callerName               — caller display name
//   session.languageCode             — language (from metadata or default)

function VexylSipBridge(config) {
  EventEmitter.call(this);

  config = config || {};

  // SIP configuration
  this.sipPort = config.sipPort || config.SIP_PORT || 5060;
  this.publicAddress = config.publicAddress || config.PUBLIC_ADDRESS || config.SIP_PUBLIC_ADDRESS;
  this.sipCredentials = null;
  if (config.SIP_AUTH_USER || config.sipAuthUser) {
    this.sipCredentials = {
      user: config.SIP_AUTH_USER || config.sipAuthUser,
      password: config.SIP_AUTH_PASSWORD || config.sipAuthPassword || ''
    };
  }

  // Security
  this.allowedIps = config.allowedIps || config.SIP_ALLOWED_IPS || null;
  if (typeof this.allowedIps === 'string') {
    this.allowedIps = this.allowedIps.split(',').map(function(ip) { return ip.trim(); });
  }
  this.maxConcurrentCalls = parseInt(config.maxConcurrentCalls || config.SIP_MAX_CALLS || '0', 10);

  // Keepalive
  this.keepaliveTargets = [];
  if (config.SIP_KEEPALIVE_URI || config.sipKeepaliveUri) {
    this.keepaliveTargets = [{
      uri: config.SIP_KEEPALIVE_URI || config.sipKeepaliveUri,
      interval: parseInt(config.SIP_KEEPALIVE_INTERVAL || config.sipKeepaliveInterval || '30000', 10)
    }];
  }

  // RTP
  this.rtpPortMin = parseInt(config.rtpPortMin || config.RTP_PORT_MIN || '10000', 10);
  this.rtpPortMax = parseInt(config.rtpPortMax || config.RTP_PORT_MAX || '20000', 10);

  // Codec preference (0=PCMU, 8=PCMA)
  this.defaultCodec = parseInt(config.defaultCodec || config.SIP_CODEC || '0', 10);

  // Logger
  this.logger = config.logger || {
    info: function() {},
    error: function() {}
  };

  // Default language
  this.defaultLanguage = config.defaultLanguage || config.DEFAULT_LANGUAGE || 'en-IN';

  // Auto-answer settings
  this.autoAnswer = config.autoAnswer !== false;
  this.ringDuration = parseInt(config.ringDuration || config.SIP_RING_DURATION || '0', 10);

  // Internal state
  this._stack = null;
  this._sessions = {};  // sessionId → SipSession
  this.active = false;
}

VexylSipBridge.prototype = Object.create(EventEmitter.prototype);
VexylSipBridge.prototype.constructor = VexylSipBridge;

// Start the SIP bridge
VexylSipBridge.prototype.start = function() {
  var self = this;

  return new Promise(function(resolve, reject) {
    if (self.active) return resolve();

    // Create SipStack
    var stackOpts = {
      port: self.sipPort,
      publicAddress: self.publicAddress,
      credentials: self.sipCredentials,
      allowedIps: self.allowedIps,
      maxConcurrentCalls: self.maxConcurrentCalls,
      keepaliveTargets: self.keepaliveTargets,
      rtpPortMin: self.rtpPortMin,
      rtpPortMax: self.rtpPortMax,
      logger: self.logger
    };

    self._stack = new SipStack(stackOpts);

    // Handle incoming calls
    self._stack.on('invite', function(dialog, remote) {
      self._onInvite(dialog, remote);
    });

    self._stack.on('error', function(err) {
      self.emit('error', err);
    });

    // Start SIP stack
    self._stack.start().then(function() {
      self.active = true;
      self.logger.info('VEXYL SIP Bridge started on port ' + self.sipPort);
      self.emit('started');
      resolve();
    }).catch(reject);
  });
};

// Stop the SIP bridge
VexylSipBridge.prototype.stop = function() {
  var self = this;

  return new Promise(function(resolve) {
    if (!self.active) return resolve();

    // Stop SIP stack (graceful BYE for all calls)
    var stopPromise = self._stack ? self._stack.stop() : Promise.resolve();
    stopPromise.then(function() {
      self._sessions = {};
      self.active = false;
      self.logger.info('VEXYL SIP Bridge stopped');
      self.emit('stopped');
      resolve();
    });
  });
};

// Handle incoming INVITE
VexylSipBridge.prototype._onInvite = function(dialog, remote) {
  var self = this;

  // Extract caller info from SIP headers
  var fromHeader = dialog.request.headers.from || {};
  var toHeader = dialog.request.headers.to || {};
  var callerId = '';
  var callerName = '';

  if (fromHeader.uri) {
    var fromUri = typeof fromHeader.uri === 'string' ? fromHeader.uri : '';
    var userMatch = fromUri.match(/sip:([^@]+)@/);
    if (userMatch) callerId = userMatch[1];
  }
  if (fromHeader.name) callerName = fromHeader.name;

  // Create session wrapper (AudioSocket-compatible interface)
  var sessionId = crypto.randomUUID();
  var session = new SipSession({
    id: sessionId,
    dialog: dialog,
    callerId: callerId,
    callerName: callerName,
    remoteAddress: remote ? remote.address : null,
    remotePort: remote ? remote.port : null,
    defaultLanguage: self.defaultLanguage,
    logger: self.logger
  });

  self._sessions[sessionId] = session;

  session.on('end', function() {
    delete self._sessions[sessionId];
  });

  // Auto-answer flow
  if (self.autoAnswer) {
    self._autoAnswer(session, dialog);
  } else {
    // Manual mode — emit session, let app handle answer
    self.emit('session', session);
  }
};

VexylSipBridge.prototype._autoAnswer = function(session, dialog) {
  var self = this;

  dialog.trying().then(function() {
    if (self.ringDuration > 0) {
      return dialog.ringing().then(function() {
        return new Promise(function(resolve) {
          setTimeout(resolve, self.ringDuration);
        });
      });
    }
    return Promise.resolve();
  }).then(function() {
    return dialog.accept({ payloadType: self.defaultCodec });
  }).then(function() {
    self.logger.info('SIP call answered: ' + session.id + ' from ' + session.callerId);
    self.emit('session', session);
  }).catch(function(err) {
    self.logger.error('Failed to answer SIP call: ' + err.message);
    session._end('answer-failed');
  });
};

// Get bridge stats
VexylSipBridge.prototype.getStats = function() {
  var stackStats = this._stack ? this._stack.getStats() : {};
  return {
    active: this.active,
    mode: 'sip_bridge',
    sessions: Object.keys(this._sessions).length,
    sipPort: this.sipPort,
    publicAddress: this.publicAddress,
    stack: stackStats
  };
};

// Get all active sessions
VexylSipBridge.prototype.getSessions = function() {
  return Object.assign({}, this._sessions);
};

// Get session by ID
VexylSipBridge.prototype.getSession = function(id) {
  return this._sessions[id] || null;
};

// ============================================================================
// SipSession — AudioSocket-compatible session wrapper
// ============================================================================
//
// This wraps a Dialog to provide the same interface that the VEXYL gateway
// expects from AudioSocket sessions: audio events, sendAudio, metadata, etc.

function SipSession(options) {
  EventEmitter.call(this);

  options = options || {};
  this.id = options.id || crypto.randomUUID();
  this.callerId = options.callerId || '';
  this.callerName = options.callerName || '';
  this.remoteAddress = options.remoteAddress || null;
  this.remotePort = options.remotePort || null;
  this.languageCode = options.defaultLanguage || 'en-IN';
  this.state = 'init'; // init, active, ended

  this._dialog = options.dialog || null;
  this._metadata = {};
  this._logger = options.logger || { info: function() {}, error: function() {} };

  // Wire up dialog events
  if (this._dialog) {
    this._wireDialog();
  }
}

SipSession.prototype = Object.create(EventEmitter.prototype);
SipSession.prototype.constructor = SipSession;

SipSession.prototype._wireDialog = function() {
  var self = this;

  this._dialog.on('audio', function(pcm, header) {
    if (self.state !== 'active') {
      self.state = 'active';
    }
    // Emit PCM buffer — same as AudioSocket provides
    self.emit('audio', pcm);
  });

  this._dialog.on('dtmf', function(digit, method) {
    self.emit('dtmf', digit, method);
  });

  this._dialog.on('end', function(reason) {
    self._end(reason);
  });

  this._dialog.on('error', function(err) {
    self.emit('error', err);
  });

  this._dialog.on('ready', function() {
    self.state = 'active';
    self.emit('ready');
  });
};

// Send PCM audio to the caller (TTS output)
// Input: PCM 16-bit LE @ 8kHz (same as AudioSocket)
SipSession.prototype.sendAudio = function(pcmBuffer) {
  if (this._dialog && this.state === 'active') {
    this._dialog.sendAudio(pcmBuffer);
  }
};

// Send PCM with 20ms pacing (for TTS playback)
SipSession.prototype.sendAudioPaced = function(pcmBuffer, callback) {
  if (this._dialog && this.state === 'active') {
    return this._dialog.sendAudioPaced(pcmBuffer).then(function() {
      if (callback) callback();
    });
  }
  if (callback) callback();
  return Promise.resolve();
};

// Enqueue audio for sequential paced sending
SipSession.prototype.enqueueAudio = function(pcmBuffer) {
  if (this._dialog && this.state === 'active') {
    this._dialog.enqueueAudio(pcmBuffer);
  }
};

// Hang up the call
SipSession.prototype.hangup = function() {
  var self = this;
  if (this._dialog && this.state !== 'ended') {
    return this._dialog.bye().catch(function(err) {
      self._logger.error('Hangup error: ' + err.message);
    }).then(function() {
      self._end('local-hangup');
    });
  }
  return Promise.resolve();
};

// Transfer the call (REFER)
SipSession.prototype.transfer = function(targetUri) {
  if (this._dialog && this.state === 'active') {
    return this._dialog.refer(targetUri);
  }
  return Promise.reject(new Error('Not active'));
};

// Hold / unhold
SipSession.prototype.hold = function() {
  if (this._dialog) return this._dialog.hold();
  return Promise.reject(new Error('Not active'));
};

SipSession.prototype.unhold = function() {
  if (this._dialog) return this._dialog.unhold();
  return Promise.reject(new Error('Not active'));
};

// Send DTMF
SipSession.prototype.sendDtmf = function(digit, duration) {
  if (this._dialog && this.state === 'active') {
    this._dialog.sendDtmf(digit, duration);
  }
};

// Set session metadata (from HTTP API or programmatic)
SipSession.prototype.setMetadata = function(meta) {
  var self = this;
  Object.keys(meta).forEach(function(k) {
    self._metadata[k] = meta[k];
  });

  // Extract known fields
  if (meta.language_code) this.languageCode = meta.language_code;
  if (meta.callerid && !this.callerId) this.callerId = meta.callerid;
  if (meta.name && !this.callerName) this.callerName = meta.name;

  this.emit('metadata', this._metadata);
};

// Get session metadata
SipSession.prototype.getMetadata = function() {
  return Object.assign({
    sessionId: this.id,
    callerId: this.callerId,
    callerName: this.callerName,
    languageCode: this.languageCode,
    state: this.state,
    remoteAddress: this.remoteAddress
  }, this._metadata);
};

// Get call stats
SipSession.prototype.getStats = function() {
  return {
    id: this.id,
    callerId: this.callerId,
    state: this.state,
    dialog: this._dialog ? this._dialog.getStats() : null
  };
};

SipSession.prototype._end = function(reason) {
  if (this.state === 'ended') return;
  this.state = 'ended';
  this.emit('end', reason || 'unknown');
};

// ============================================================================
// T-35: Mode switch — factory function
// ============================================================================
//
// Usage in VEXYL gateway:
//
//   var telephony = require('@vexyl.ai/sip/vexyl-sip-bridge');
//
//   // Read from env or config
//   var mode = telephony.getMode(); // 'audiosocket', 'sip_bridge', or 'both'
//
//   // AudioSocket path (runs when mode is 'audiosocket' or 'both')
//   if (mode === 'audiosocket' || mode === 'both') {
//     // ... existing AudioSocket setup ...
//   }
//
//   // SIP Bridge path (runs when mode is 'sip_bridge' or 'both')
//   if (mode === 'sip_bridge' || mode === 'both') {
//     var bridge = telephony.createBridge({
//       SIP_PORT: 5060,
//       PUBLIC_ADDRESS: process.env.PUBLIC_IP,
//       SIP_ALLOWED_IPS: process.env.SIP_ALLOWED_IPS,
//       SIP_MAX_CALLS: process.env.SIP_MAX_CALLS,
//       DEFAULT_LANGUAGE: 'en-IN'
//     });
//
//     bridge.start();
//     bridge.on('session', function(session) {
//       // Same interface as AudioSocket session
//       session.on('audio', function(pcm) { /* feed to STT */ });
//       session.sendAudioPaced(ttsBuffer);
//       session.on('dtmf', function(digit) { /* handle DTMF */ });
//       session.on('end', function() { /* cleanup */ });
//     });
//   }

// Create bridge from config (env vars or object)
function createBridge(config) {
  return new VexylSipBridge(config);
}

// Create bridge from process.env
function createBridgeFromEnv() {
  return new VexylSipBridge({
    SIP_PORT: process.env.SIP_PORT,
    PUBLIC_ADDRESS: process.env.SIP_PUBLIC_ADDRESS || process.env.PUBLIC_IP,
    SIP_AUTH_USER: process.env.SIP_AUTH_USER,
    SIP_AUTH_PASSWORD: process.env.SIP_AUTH_PASSWORD,
    SIP_ALLOWED_IPS: process.env.SIP_ALLOWED_IPS,
    SIP_MAX_CALLS: process.env.SIP_MAX_CALLS,
    SIP_KEEPALIVE_URI: process.env.SIP_KEEPALIVE_URI,
    SIP_KEEPALIVE_INTERVAL: process.env.SIP_KEEPALIVE_INTERVAL,
    SIP_CODEC: process.env.SIP_CODEC,
    SIP_RING_DURATION: process.env.SIP_RING_DURATION,
    RTP_PORT_MIN: process.env.RTP_PORT_MIN,
    RTP_PORT_MAX: process.env.RTP_PORT_MAX,
    DEFAULT_LANGUAGE: process.env.DEFAULT_LANGUAGE,
    logger: {
      info: console.log.bind(console),
      error: console.error.bind(console)
    }
  });
}

// T-35: Detect mode from env
function getMode() {
  var mode = (process.env.TELEPHONY_MODE || 'audiosocket').toLowerCase();
  if (mode === 'both' || mode === 'dual') return 'both';
  if (mode === 'sip' || mode === 'sip_bridge' || mode === 'sipbridge') return 'sip_bridge';
  return 'audiosocket';
}

exports.VexylSipBridge = VexylSipBridge;
exports.SipSession = SipSession;
exports.createBridge = createBridge;
exports.createBridgeFromEnv = createBridgeFromEnv;
exports.getMode = getMode;
