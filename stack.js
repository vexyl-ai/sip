// ============================================================================
// @vexyl.ai/sip — SipStack Class
// T-20: SipStack class (replace global singleton)
// T-19: Promise-based call setup
// T-25: Digest auth 407/401 auto-retry
// T-26: Re-INVITE handling (in Dialog)
// T-27: REFER / call transfer
// T-28: OPTIONS ping / keepalive
// T-29: Graceful cleanup on call end
// T-31: Allowed trunk IP whitelist
// T-32: Concurrent call rate limiting
// T-33: Pluggable logger
// ============================================================================

var EventEmitter = require('events').EventEmitter;
var crypto = require('crypto');
var sip = require('./sip');
var sdp = require('./sdp');
var rtp = require('./rtp');
var digest = require('./digest');
var Dialog = require('./dialog').Dialog;

// ============================================================================
// SipStack — non-singleton, EventEmitter-based SIP stack
// ============================================================================

function SipStack(options) {
  EventEmitter.call(this);

  this.options = options || {};
  this.options.port = this.options.port || 5060;

  this._instance = null;
  this._dialogs = {};      // callId → Dialog
  this._portPool = null;
  this.active = false;

  // T-33: Pluggable logger
  this._log = this.options.logger || {};
  this._logError = this._log.error || function() {};
  this._logInfo = this._log.info || function() {};

  // T-31: IP whitelist
  this._allowedIps = null;
  if (this.options.allowedIps && Array.isArray(this.options.allowedIps)) {
    this._allowedIps = new Set(this.options.allowedIps);
  }

  // T-32: Rate limiting
  this._maxConcurrentCalls = this.options.maxConcurrentCalls || 0; // 0 = unlimited

  // T-28: OPTIONS keepalive
  this._keepaliveTimers = null;
  this._keepaliveTargets = this.options.keepaliveTargets || []; // [{uri, interval}]

  // T-25: Digest auth credentials
  this._credentials = this.options.credentials || null; // {user, password, realm?}
}

SipStack.prototype = Object.create(EventEmitter.prototype);
SipStack.prototype.constructor = SipStack;

// Start the SIP stack
SipStack.prototype.start = function() {
  var self = this;

  return new Promise(function(resolve, reject) {
    if (self.active) return resolve();

    try {
      // Create RTP port pool
      self._portPool = rtp.getDefaultPool(
        self.options.rtpPortMin || 10000,
        self.options.rtpPortMax || 20000
      );

      self._instance = sip.create(self.options, function(request, remote) {
        self._onRequest(request, remote);
      });

      self.active = true;

      // T-28: Start keepalive timers
      self._startKeepalives();

      self.emit('started');
      resolve();
    } catch(e) {
      reject(e);
    }
  });
};

// Stop the SIP stack
SipStack.prototype.stop = function() {
  var self = this;

  return new Promise(function(resolve) {
    if (!self.active) return resolve();

    // T-28: Stop keepalive timers
    self._stopKeepalives();

    // T-29: End all active dialogs gracefully
    var callIds = Object.keys(self._dialogs);
    var cleanupPromises = callIds.map(function(callId) {
      var dialog = self._dialogs[callId];
      if (dialog.state === 'active') {
        // Try to send BYE for active calls
        return dialog.bye().catch(function() {});
      } else if (dialog.state !== 'ended') {
        dialog._end('stack-shutdown');
      }
      return Promise.resolve();
    });

    Promise.all(cleanupPromises).then(function() {
      self._dialogs = {};

      if (self._instance) {
        self._instance.destroy();
        self._instance = null;
      }

      self.active = false;
      self.emit('stopped');
      resolve();
    });
  });
};

// T-19: Make an outbound call — Promise-based
// T-25: Auto-retries on 401/407 with digest auth
SipStack.prototype.call = function(uri, options) {
  var self = this;
  options = options || {};

  return new Promise(function(resolve, reject) {
    if (!self.active || !self._instance) {
      return reject(new Error('SipStack not started'));
    }

    // T-32: Check rate limit
    if (self._maxConcurrentCalls > 0) {
      var activeCalls = Object.keys(self._dialogs).length;
      if (activeCalls >= self._maxConcurrentCalls) {
        return reject(new Error('Rate limit exceeded: ' + activeCalls + '/' + self._maxConcurrentCalls + ' concurrent calls'));
      }
    }

    var callId = options.callId || crypto.randomUUID();
    var localTag = sip.generateTag();
    var fromUri = options.fromUri || 'sip:vexyl@' + (self.options.publicAddress || self.options.hostname || '127.0.0.1');
    var payloadType = options.payloadType !== undefined ? options.payloadType : 0;
    var creds = options.credentials || self._credentials;
    var authCtx = {}; // T-25: digest auth context
    var cseqNum = 1;

    // Create Dialog
    var dialog = new Dialog({
      callId: callId,
      direction: 'outbound',
      localTag: localTag,
      localUri: fromUri,
      remoteUri: uri,
      sipSend: self._instance.send.bind(self._instance),
      sipMakeResponse: sip.makeResponse,
      sipOptions: self.options,
      rtp: { pool: self._portPool },
      dtmf: options.dtmf || {}
    });

    self._dialogs[callId] = dialog;

    dialog.on('end', function() {
      delete self._dialogs[callId];
    });

    // Create RTP session first to know our local port
    var rtpOpts = {
      pool: self._portPool,
      payloadType: payloadType,
      address: self.options.address || '0.0.0.0'
    };

    var rtpSession = rtp.createSession(rtpOpts);
    dialog.rtpSession = rtpSession;

    rtpSession.on('audio', function(pcm, header) {
      if (dialog.state === 'active') {
        dialog.emit('audio', pcm, header);
        dialog.dtmfDetector.processRtp(header);
      }
    });

    rtpSession.on('error', function(err) {
      dialog.emit('error', err);
      if (dialog.state !== 'ended') {
        dialog._end('rtp-error');
      }
    });

    rtpSession.start(function(err, addr) {
      if (err) {
        rtpSession.removeAllListeners();
        rtpSession.stop();
        delete self._dialogs[callId];
        return reject(err);
      }

      var publicAddress = self.options.publicAddress || self.options.address || addr.address;
      var codecName = payloadType === 8 ? 'PCMA' : 'PCMU';

      // Build offer SDP
      var offerSdp = {
        v: 0,
        o: { username: '-', id: Date.now(), version: 1, nettype: 'IN', addrtype: 'IP4', address: publicAddress },
        s: 'vexyl',
        c: { nettype: 'IN', addrtype: 'IP4', address: publicAddress },
        t: '0 0',
        m: [{
          media: 'audio',
          port: addr.port,
          proto: 'RTP/AVP',
          fmt: [payloadType, 101],
          a: [
            'rtpmap:' + payloadType + ' ' + codecName + '/8000',
            'ptime:20',
            'sendrecv',
            'rtpmap:101 telephone-event/8000',
            'fmtp:101 0-15'
          ]
        }]
      };

      dialog.localSdp = offerSdp;
      var sdpBody = sdp.stringify(offerSdp);

      function buildInvite() {
        var invite = {
          method: 'INVITE',
          uri: uri,
          headers: {
            to: { uri: uri },
            from: { uri: fromUri, params: { tag: localTag } },
            'call-id': callId,
            cseq: { method: 'INVITE', seq: cseqNum },
            contact: [{ uri: 'sip:' + localTag + '@' + publicAddress + ':' + self.options.port }],
            'max-forwards': 70,
            'content-type': 'application/sdp'
          },
          content: sdpBody
        };

        // Copy custom headers
        if (options.headers) {
          Object.keys(options.headers).forEach(function(h) {
            invite.headers[h] = options.headers[h];
          });
        }

        return invite;
      }

      function sendInvite(invite) {
        dialog.request = invite;

        self._instance.send(invite, function(rs) {
          dialog.emit('response', rs);

          // T-25: Auto-retry on 401/407 with digest auth
          // RFC 2617 — also retry on stale nonce (stale=true in challenge)
          if ((rs.status === 401 || rs.status === 407) && creds && (cseqNum === 1 || authCtx.stale)) {
            cseqNum++;
            var retry = buildInvite();

            // Send ACK for the 401/407
            var ack401 = {
              method: 'ACK',
              uri: uri,
              headers: {
                to: rs.headers.to,
                from: rs.headers.from,
                'call-id': callId,
                cseq: { method: 'ACK', seq: cseqNum - 1 },
                via: [],
                'max-forwards': 70
              }
            };
            self._instance.send(ack401);

            // Sign the retry with digest auth
            digest.signRequest(authCtx, retry, rs, creds);
            sendInvite(retry);
            return;
          }

          if (rs.status >= 200 && rs.status < 300) {
            // Parse remote SDP
            if (rs.content) {
              try {
                dialog.remoteSdp = sdp.parse(rs.content);
                if (dialog.remoteSdp.m) {
                  for (var i = 0; i < dialog.remoteSdp.m.length; i++) {
                    var m = dialog.remoteSdp.m[i];
                    if (m.media === 'audio') {
                      rtpSession.remotePort = m.port;
                      var cLine = m.c || dialog.remoteSdp.c;
                      if (cLine) rtpSession.remoteAddress = cLine.address;
                      break;
                    }
                  }
                }
              } catch(e) {}
            }

            // RFC 3261 §12.1.2 — construct route set from Record-Route (kept in order for UAC)
            if (rs.headers['record-route']) {
              dialog._routeSet = rs.headers['record-route'].slice();
            }
            // RFC 3261 §12.1.2 — remote target from Contact in 2xx
            if (rs.headers.contact && rs.headers.contact.length > 0) {
              dialog._remoteTarget = rs.headers.contact[0].uri;
            }

            // NAT detection for UAC: compare Contact host with original dialed URI
            if (dialog._remoteTarget) {
              var contactParsed = sip.parseUri(dialog._remoteTarget);
              var dialedParsed = sip.parseUri(uri);
              if (contactParsed && dialedParsed && contactParsed.host !== dialedParsed.host) {
                dialog._natAddress = { host: dialedParsed.host, port: dialedParsed.port || 5060 };
              }
            }

            // Send ACK
            var ackUri = (rs.headers.contact && rs.headers.contact.length > 0)
              ? rs.headers.contact[0].uri : uri;
            var ack = {
              method: 'ACK',
              uri: ackUri,
              headers: {
                to: rs.headers.to,
                from: rs.headers.from,
                'call-id': callId,
                cseq: { method: 'ACK', seq: cseqNum },
                via: [],
                'max-forwards': 70
              }
            };

            // RFC 3261 §12.2.1.1 — include Route set in ACK
            if (dialog._routeSet && dialog._routeSet.length > 0) {
              ack.headers.route = dialog._routeSet.slice();
            }

            self._instance.send(ack);
            dialog.state = 'active';
            dialog.remoteTag = rs.headers.to && rs.headers.to.params ? rs.headers.to.params.tag : null;
            dialog.emit('ready');
            resolve(dialog);
          } else if (rs.status > 100 && rs.status < 200) {
            dialog.state = rs.status === 180 ? 'ringing' : 'trying';
          } else if (rs.status >= 300) {
            dialog._end('rejected-' + rs.status);
            delete self._dialogs[callId];
            reject(new Error('Call rejected: ' + rs.status + ' ' + rs.reason));
          }
        });
      }

      sendInvite(buildInvite());
    });
  });
};

// T-27: REFER / call transfer
SipStack.prototype.transfer = function(callId, targetUri) {
  var self = this;

  return new Promise(function(resolve, reject) {
    var dialog = self._dialogs[callId];
    if (!dialog || dialog.state !== 'active') {
      return reject(new Error('No active dialog for ' + callId));
    }
    if (!self._instance) return reject(new Error('Stack not active'));

    // Build REFER request
    var referUri = dialog.remoteUri;
    if (dialog.request && dialog.request.headers.contact && dialog.request.headers.contact.length > 0) {
      referUri = dialog.request.headers.contact[0].uri;
    }

    dialog._cseqOut++;
    var refer = dialog._buildRequest('REFER');
    refer.headers['refer-to'] = targetUri;
    refer.headers['referred-by'] = dialog.localUri || ('sip:' + dialog.localTag + '@localhost');

    self._instance.send(refer, function(rs) {
      if (rs.status >= 200 && rs.status < 300) {
        dialog.emit('transferred', targetUri);
        resolve(rs);
      } else {
        reject(new Error('REFER failed: ' + rs.status + ' ' + rs.reason));
      }
    });
  });
};

// Handle incoming SIP requests
SipStack.prototype._onRequest = function(request, remote) {
  var callId = request.headers['call-id'];

  // T-31: IP whitelist check
  if (this._allowedIps && remote && remote.address) {
    if (!this._allowedIps.has(remote.address)) {
      this._logError('Blocked request from unauthorized IP: ' + remote.address);
      if (this._instance) {
        this._instance.send(sip.makeResponse(request, 403, 'Forbidden'));
      }
      return;
    }
  }

  if (request.method === 'INVITE') {
    // Check if this is a re-INVITE for an existing dialog
    var existing = this._dialogs[callId];
    if (existing && existing.state === 'active') {
      // T-26: Re-INVITE handling
      existing._onReInvite(request);
      return;
    }

    // T-32: Rate limit check for new calls
    if (this._maxConcurrentCalls > 0) {
      var activeCalls = Object.keys(this._dialogs).length;
      if (activeCalls >= this._maxConcurrentCalls) {
        this._logError('Rate limit reached: ' + activeCalls + '/' + this._maxConcurrentCalls);
        if (this._instance) {
          this._instance.send(sip.makeResponse(request, 503, 'Service Unavailable'));
        }
        return;
      }
    }

    // New inbound call
    this._onInvite(request, remote);
  } else if (request.method === 'BYE') {
    var dialog = this._dialogs[callId];
    if (dialog) {
      dialog._onBye(request);
      // dialog._end() emits 'end' which triggers delete via dialog.on('end')
    } else {
      if (this._instance) {
        this._instance.send(sip.makeResponse(request, 481, 'Call/Transaction Does Not Exist'));
      }
    }
  } else if (request.method === 'ACK') {
    var dialog = this._dialogs[callId];
    if (dialog) {
      dialog._onAck(request);
    }
  } else if (request.method === 'INFO') {
    var dialog = this._dialogs[callId];
    if (dialog) {
      dialog._onInfo(request);
    } else {
      this.emit('message', request, remote);
    }
  } else if (request.method === 'CANCEL') {
    var dialog = this._dialogs[callId];
    if (dialog && dialog.state !== 'active' && dialog.state !== 'ended') {
      if (this._instance) {
        this._instance.send(sip.makeResponse(request, 200, 'OK'));
      }
      if (dialog.request) {
        var rs487 = sip.makeResponse(dialog.request, 487, 'Request Terminated');
        if (this._instance) this._instance.send(rs487);
      }
      dialog._end('cancelled');
      delete this._dialogs[callId];
    }
  } else if (request.method === 'OPTIONS') {
    if (this._instance) {
      var rs = sip.makeResponse(request, 200, 'OK');
      rs.headers.allow = 'INVITE, ACK, BYE, CANCEL, OPTIONS, INFO, REFER';
      this._instance.send(rs);
    }
  } else if (request.method === 'REFER') {
    // T-27: Handle incoming REFER
    var dialog = this._dialogs[callId];
    if (dialog) {
      dialog._onRefer(request);
    } else {
      if (this._instance) {
        this._instance.send(sip.makeResponse(request, 481, 'Call/Transaction Does Not Exist'));
      }
    }
  } else if (request.method === 'NOTIFY') {
    // NOTIFY for REFER subscription
    var dialog = this._dialogs[callId];
    if (dialog) {
      dialog._onNotify(request);
    } else {
      if (this._instance) {
        this._instance.send(sip.makeResponse(request, 200, 'OK'));
      }
    }
  } else {
    this.emit('message', request, remote);
  }
};

// Handle new INVITE
SipStack.prototype._onInvite = function(request, remote) {
  var self = this;
  var callId = request.headers['call-id'];

  var dialog = new Dialog({
    callId: callId,
    direction: 'inbound',
    request: request,
    localTag: sip.generateTag(),
    remoteTag: request.headers.from && request.headers.from.params ? request.headers.from.params.tag : null,
    localUri: request.headers.to ? request.headers.to.uri : null,
    remoteUri: request.headers.from ? request.headers.from.uri : null,
    sipSend: this._instance.send.bind(this._instance),
    sipMakeResponse: sip.makeResponse,
    sipOptions: this.options,
    rtp: { pool: this._portPool },
    dtmf: this.options.dtmf || {}
  });

  this._dialogs[callId] = dialog;

  dialog.on('end', function() {
    delete self._dialogs[callId];
  });

  if (this.listenerCount('invite') > 0) {
    this.emit('invite', dialog, remote);
  } else {
    if (this._instance) {
      this._instance.send(sip.makeResponse(request, 486, 'Busy Here'));
    }
    dialog._end('no-handler');
    delete this._dialogs[callId];
  }
};

// ============================================================================
// T-28: OPTIONS ping / keepalive
// ============================================================================

SipStack.prototype._startKeepalives = function() {
  var self = this;

  if (!this._keepaliveTargets || this._keepaliveTargets.length === 0) return;

  this._keepaliveTimers = this._keepaliveTargets.map(function(target) {
    var interval = target.interval || 30000; // default 30s
    return setInterval(function() {
      self._sendOptions(target.uri);
    }, interval);
  });
};

SipStack.prototype._stopKeepalives = function() {
  if (this._keepaliveTimers) {
    this._keepaliveTimers.forEach(function(t) { clearInterval(t); });
    this._keepaliveTimers = null;
  }
};

SipStack.prototype._sendOptions = function(uri) {
  if (!this._instance) return;

  var publicAddress = this.options.publicAddress || this.options.hostname || '127.0.0.1';
  var opts = {
    method: 'OPTIONS',
    uri: uri,
    headers: {
      to: { uri: uri },
      from: { uri: 'sip:vexyl@' + publicAddress, params: { tag: sip.generateTag() } },
      'call-id': crypto.randomUUID(),
      cseq: { method: 'OPTIONS', seq: 1 },
      contact: [{ uri: 'sip:vexyl@' + publicAddress + ':' + this.options.port }],
      'max-forwards': 70
    }
  };

  this._instance.send(opts, function(rs) {
    // Response received — trunk is alive
  });
};

// Send OPTIONS ping on demand
SipStack.prototype.sendOptions = function(uri) {
  this._sendOptions(uri);
};

// ============================================================================
// T-31: IP Whitelist management
// ============================================================================

SipStack.prototype.allowIp = function(ip) {
  if (!this._allowedIps) this._allowedIps = new Set();
  this._allowedIps.add(ip);
};

SipStack.prototype.removeIp = function(ip) {
  if (this._allowedIps) this._allowedIps.delete(ip);
};

SipStack.prototype.getAllowedIps = function() {
  return this._allowedIps ? Array.from(this._allowedIps) : null;
};

// Disable whitelist (allow all)
SipStack.prototype.disableIpWhitelist = function() {
  this._allowedIps = null;
};

// ============================================================================
// T-32: Rate limit management
// ============================================================================

SipStack.prototype.setMaxConcurrentCalls = function(max) {
  this._maxConcurrentCalls = max;
};

SipStack.prototype.getMaxConcurrentCalls = function() {
  return this._maxConcurrentCalls;
};

// ============================================================================
// Getters
// ============================================================================

SipStack.prototype.getDialogs = function() {
  return Object.assign({}, this._dialogs);
};

SipStack.prototype.getDialog = function(callId) {
  return this._dialogs[callId] || null;
};

SipStack.prototype.getStats = function() {
  var activeDialogs = Object.keys(this._dialogs).length;
  var rtpPool = this._portPool ? this._portPool.stats() : null;
  return {
    active: this.active,
    dialogs: activeDialogs,
    maxConcurrentCalls: this._maxConcurrentCalls,
    rtpPorts: rtpPool
  };
};

SipStack.prototype.send = function(message, callback) {
  if (this._instance) {
    this._instance.send(message, callback);
  }
};

exports.SipStack = SipStack;
