// ============================================================================
// @vexyl.ai/sip — Dialog Class
// T-18: EventEmitter-based Dialog class
// T-19: Promise-based call setup
// T-26: Re-INVITE handling
// T-27: REFER / call transfer
// T-29: Graceful cleanup on call end
// ============================================================================

var EventEmitter = require('events').EventEmitter;
var crypto = require('crypto');
var sdp = require('./sdp');
var rtp = require('./rtp');
var dtmf = require('./dtmf');

// ============================================================================
// T-18: EventEmitter-based Dialog
// ============================================================================
//
// Events:
//   'audio'       (pcmBuffer, rtpHeader)  — decoded audio from remote party
//   'dtmf'        (digit, method)         — DTMF digit detected
//   'end'         (reason)                — call terminated
//   'error'       (err)                   — error occurred
//   'ready'       ()                      — RTP session ready
//   'response'    (rs)                    — SIP response received (outbound)
//   'reinvite'    (request)               — re-INVITE received
//   'refer'       (targetUri, request)    — REFER received (call transfer)
//   'transferred' (targetUri)             — REFER sent successfully
//   'hold'        ()                      — call put on hold
//   'unhold'      ()                      — call taken off hold

function Dialog(options) {
  EventEmitter.call(this);

  options = options || {};
  this.id = options.callId || crypto.randomUUID();
  this.direction = options.direction || 'inbound';
  this.state = 'init'; // init, trying, ringing, active, held, ended

  // SIP context
  this.request = options.request || null;
  this.localTag = options.localTag || null;
  this.remoteTag = options.remoteTag || null;
  this.localUri = options.localUri || null;
  this.remoteUri = options.remoteUri || null;
  this._cseqOut = 1; // outbound CSeq counter

  // SIP stack reference
  this._sipSend = options.sipSend || null;
  this._sipMakeResponse = options.sipMakeResponse || null;
  this._sipOptions = options.sipOptions || {};

  // RTP session
  this.rtpSession = null;
  this.rtpOptions = options.rtp || {};

  // DTMF detector
  this.dtmfDetector = new dtmf.DtmfDetector(options.dtmf || {});
  this.dtmfDetector.on('digit', this._onDtmf.bind(this));

  // SDP state
  this.remoteSdp = null;
  this.localSdp = null;

  // RFC 3261 §12 — Route set for in-dialog requests
  this._routeSet = null;
  // Remote target (Contact URI) for request-URI of in-dialog requests
  this._remoteTarget = null;

  // T-29: Cleanup tracking
  this._cleanedUp = false;
}

Dialog.prototype = Object.create(EventEmitter.prototype);
Dialog.prototype.constructor = Dialog;

// ---- Inbound call flow ----

Dialog.prototype.trying = function() {
  var self = this;
  return new Promise(function(resolve, reject) {
    if (!self.request || !self._sipSend) return reject(new Error('No SIP context'));
    if (self.state === 'ended') return reject(new Error('Dialog ended'));

    self.state = 'trying';
    var rs = self._sipMakeResponse(self.request, 100, 'Trying');
    self._sipSend(rs);
    resolve();
  });
};

// RFC 3261 §13.3.1 — 183 Session Progress (early media)
Dialog.prototype.progress = function(options) {
  var self = this;
  options = options || {};
  return new Promise(function(resolve, reject) {
    if (!self.request || !self._sipSend) return reject(new Error('No SIP context'));
    if (self.state === 'ended') return reject(new Error('Dialog ended'));

    self.state = 'ringing';
    var rs = self._sipMakeResponse(self.request, 183, 'Session Progress');
    if (options.sdp) {
      rs.headers['content-type'] = 'application/sdp';
      rs.content = options.sdp;
    }
    self._sipSend(rs);
    resolve();
  });
};

Dialog.prototype.ringing = function() {
  var self = this;
  return new Promise(function(resolve, reject) {
    if (!self.request || !self._sipSend) return reject(new Error('No SIP context'));
    if (self.state === 'ended') return reject(new Error('Dialog ended'));

    self.state = 'ringing';
    var rs = self._sipMakeResponse(self.request, 180, 'Ringing');
    self._sipSend(rs);
    resolve();
  });
};

Dialog.prototype.accept = function(options) {
  var self = this;
  options = options || {};

  return new Promise(function(resolve, reject) {
    if (!self.request || !self._sipSend) return reject(new Error('No SIP context'));
    if (self.state === 'ended') return reject(new Error('Dialog ended'));

    // Parse remote SDP
    if (self.request.content) {
      try { self.remoteSdp = sdp.parse(self.request.content); } catch(e) {}
    }

    var remoteRtpPort = null;
    var remoteRtpAddr = null;
    var payloadType = options.payloadType !== undefined ? options.payloadType : 0;

    if (self.remoteSdp) {
      var audioMedia = null;
      if (self.remoteSdp.m) {
        for (var i = 0; i < self.remoteSdp.m.length; i++) {
          if (self.remoteSdp.m[i].media === 'audio') {
            audioMedia = self.remoteSdp.m[i];
            break;
          }
        }
      }
      if (audioMedia) {
        remoteRtpPort = audioMedia.port;
        var cLine = audioMedia.c || self.remoteSdp.c;
        if (cLine) remoteRtpAddr = cLine.address;
        if (options.payloadType === undefined && audioMedia.fmt && audioMedia.fmt.length > 0) {
          payloadType = audioMedia.fmt[0];
        }
      }
    }

    var rtpOpts = {
      remoteAddress: remoteRtpAddr,
      remotePort: remoteRtpPort,
      payloadType: payloadType,
      pool: options.pool || self.rtpOptions.pool || undefined,
      port: options.rtpPort || self.rtpOptions.port || undefined,
      address: self.rtpOptions.address || '0.0.0.0',
      symmetricRtp: self.rtpOptions.symmetricRtp !== false
    };

    self.rtpSession = rtp.createSession(rtpOpts);

    self.rtpSession.on('audio', function(pcm, header) {
      self.emit('audio', pcm, header);
      self.dtmfDetector.processRtp(header);
    });

    self.rtpSession.on('error', function(err) {
      self.emit('error', err);
    });

    self.rtpSession.start(function(err, addr) {
      if (err) return reject(err);

      var publicAddress = self._sipOptions.publicAddress || self._sipOptions.address || addr.address;
      var codecName = payloadType === 8 ? 'PCMA' : 'PCMU';
      var rtpmapLine = 'rtpmap:' + payloadType + ' ' + codecName + '/8000';

      var answerSdp = {
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
            rtpmapLine,
            'ptime:20',
            'sendrecv',
            'rtpmap:101 telephone-event/8000',
            'fmtp:101 0-15'
          ]
        }]
      };

      self.localSdp = answerSdp;
      var sdpBody = sdp.stringify(answerSdp);

      var rs = self._sipMakeResponse(self.request, 200, 'OK');
      rs.headers['content-type'] = 'application/sdp';
      rs.content = sdpBody;

      // RFC 3261 §12.1.1 — construct route set from Record-Route (reversed for UAS)
      if (self.request.headers['record-route']) {
        self._routeSet = self.request.headers['record-route'].slice().reverse();
      }
      // RFC 3261 §12.1.1 — remote target from Contact header
      if (self.request.headers.contact && self.request.headers.contact.length > 0) {
        self._remoteTarget = self.request.headers.contact[0].uri;
      }

      self._sipSend(rs);
      self.state = 'active';
      self.emit('ready');
      resolve(self);
    });
  });
};

Dialog.prototype.reject = function(status, reason) {
  var self = this;
  status = status || 486;
  reason = reason || 'Busy Here';

  return new Promise(function(resolve, reject) {
    if (!self.request || !self._sipSend) return reject(new Error('No SIP context'));

    var rs = self._sipMakeResponse(self.request, status, reason);
    self._sipSend(rs);
    self._end('rejected');
    resolve();
  });
};

Dialog.prototype.decline = function(text) {
  return this.reject(603, text || 'Decline');
};

// ---- Active call operations ----

Dialog.prototype.sendAudio = function(pcmBuffer) {
  if (this.rtpSession && this.state === 'active') {
    this.rtpSession.sendPcm(pcmBuffer);
  }
};

Dialog.prototype.sendAudioPaced = function(pcmBuffer) {
  var self = this;
  return new Promise(function(resolve) {
    if (!self.rtpSession || self.state !== 'active') return resolve();
    self.rtpSession.sendPcmPaced(pcmBuffer, resolve);
  });
};

Dialog.prototype.enqueueAudio = function(pcmBuffer) {
  if (this.rtpSession && this.state === 'active') {
    this.rtpSession.enqueuePcm(pcmBuffer);
  }
};

Dialog.prototype.sendDtmf = function(digit, duration) {
  if (!this.rtpSession || this.state !== 'active') return;

  duration = duration || 160;
  var self = this;

  var eventPayload = dtmf.buildRfc2833(digit, false, 10, 0);
  if (!eventPayload) return;

  var startTimestamp = this.rtpSession.timestamp;
  var sendCount = 0;

  function sendEvent() {
    if (sendCount < 3) {
      var dur = Math.min((sendCount + 1) * 160, duration);
      var payload = dtmf.buildRfc2833(digit, false, 10, dur);
      self.rtpSession.sendPayload(payload, {
        payloadType: 101,
        marker: sendCount === 0 ? 1 : 0
      });
      self.rtpSession.timestamp = startTimestamp;
      sendCount++;
      setTimeout(sendEvent, 20);
    } else if (sendCount < 6) {
      var payload = dtmf.buildRfc2833(digit, true, 10, duration);
      self.rtpSession.sendPayload(payload, { payloadType: 101 });
      self.rtpSession.timestamp = startTimestamp;
      sendCount++;
      if (sendCount < 6) setTimeout(sendEvent, 20);
    }
  }

  sendEvent();
};

// T-26: Send hold (re-INVITE with sendonly)
Dialog.prototype.hold = function() {
  var self = this;
  return new Promise(function(resolve, reject) {
    if (self.state !== 'active' || !self._sipSend) return reject(new Error('Cannot hold'));

    var holdSdp = JSON.parse(JSON.stringify(self.localSdp));
    if (holdSdp.m && holdSdp.m[0] && holdSdp.m[0].a) {
      holdSdp.m[0].a = holdSdp.m[0].a.map(function(a) {
        return a === 'sendrecv' ? 'sendonly' : a;
      });
    }

    self._cseqOut++;
    var reinvite = self._buildRequest('INVITE');
    reinvite.headers['content-type'] = 'application/sdp';
    reinvite.content = sdp.stringify(holdSdp);

    self._sipSend(reinvite, function(rs) {
      if (rs.status >= 200 && rs.status < 300) {
        // ACK the 200
        var ack = self._buildRequest('ACK');
        ack.headers.cseq = { method: 'ACK', seq: reinvite.headers.cseq.seq };
        self._sipSend(ack);
        self.state = 'held';
        self.emit('hold');
        resolve();
      } else if (rs.status >= 300) {
        reject(new Error('Hold failed: ' + rs.status));
      }
    });
  });
};

// T-26: Take off hold (re-INVITE with sendrecv)
Dialog.prototype.unhold = function() {
  var self = this;
  return new Promise(function(resolve, reject) {
    if (self.state !== 'held' || !self._sipSend) return reject(new Error('Not on hold'));

    self._cseqOut++;
    var reinvite = self._buildRequest('INVITE');
    reinvite.headers['content-type'] = 'application/sdp';
    reinvite.content = sdp.stringify(self.localSdp);

    self._sipSend(reinvite, function(rs) {
      if (rs.status >= 200 && rs.status < 300) {
        var ack = self._buildRequest('ACK');
        ack.headers.cseq = { method: 'ACK', seq: reinvite.headers.cseq.seq };
        self._sipSend(ack);
        self.state = 'active';
        self.emit('unhold');
        resolve();
      } else if (rs.status >= 300) {
        reject(new Error('Unhold failed: ' + rs.status));
      }
    });
  });
};

// Hang up
Dialog.prototype.bye = function() {
  var self = this;
  return new Promise(function(resolve, reject) {
    if (self.state === 'ended') return resolve();
    if (!self._sipSend) return reject(new Error('No SIP context'));

    self._cseqOut++;
    var bye = self._buildRequest('BYE');

    self._sipSend(bye, function(rs) {
      self._end('local-bye');
      resolve(rs);
    });
  });
};

// ---- T-27: REFER / Call Transfer ----

// Send REFER to transfer the remote party
Dialog.prototype.refer = function(targetUri) {
  var self = this;
  return new Promise(function(resolve, reject) {
    if (self.state !== 'active' || !self._sipSend) return reject(new Error('Cannot REFER'));

    self._cseqOut++;
    var refer = self._buildRequest('REFER');
    refer.headers['refer-to'] = targetUri;
    refer.headers['referred-by'] = self.localUri;

    self._sipSend(refer, function(rs) {
      if (rs.status >= 200 && rs.status < 300) {
        self.emit('transferred', targetUri);
        resolve(rs);
      } else {
        reject(new Error('REFER failed: ' + rs.status + ' ' + rs.reason));
      }
    });
  });
};

// ---- Internal: build in-dialog request ----

Dialog.prototype._buildRequest = function(method) {
  // RFC 3261 §12.2.1.1 — Request-URI is remote target (Contact from peer)
  var requestUri = this._remoteTarget || this.remoteUri
    || (this.request ? this.request.headers.from.uri : 'sip:unknown@localhost');

  // Fallback: if no stored remote target, check request Contact
  if (!this._remoteTarget && this.request && this.request.headers.contact && this.request.headers.contact.length > 0) {
    requestUri = this.request.headers.contact[0].uri;
  }

  var rq = {
    method: method,
    uri: requestUri,
    headers: {
      to: this.direction === 'inbound' ? this.request.headers.from : this.request.headers.to,
      from: this.direction === 'inbound' ? this.request.headers.to : this.request.headers.from,
      'call-id': this.id,
      cseq: { method: method, seq: this._cseqOut },
      'max-forwards': 70
    }
  };

  // RFC 3261 §12.2.1.1 — include Route set if present
  if (this._routeSet && this._routeSet.length > 0) {
    rq.headers.route = this._routeSet.slice();
  }

  // RFC 3261 §12.2.1.1 — Contact for dialog-modifying requests
  if (method === 'INVITE' || method === 'UPDATE' || method === 'REFER') {
    var localAddr = (this._sipOptions && this._sipOptions.publicAddress) || '127.0.0.1';
    var localPort = (this._sipOptions && this._sipOptions.port) || 5060;
    rq.headers.contact = [{ uri: 'sip:vexyl@' + localAddr + ':' + localPort }];
  }

  return rq;
};

// ---- Internal event handlers ----

Dialog.prototype._onBye = function(request) {
  if (this._sipSend && this._sipMakeResponse) {
    var rs = this._sipMakeResponse(request, 200, 'OK');
    this._sipSend(rs);
  }
  this._end('remote-bye');
};

Dialog.prototype._onAck = function() {
  // ACK confirms dialog established
};

Dialog.prototype._onInfo = function(request) {
  this.dtmfDetector.processSipInfo(request);
  if (this._sipSend && this._sipMakeResponse) {
    var rs = this._sipMakeResponse(request, 200, 'OK');
    this._sipSend(rs);
  }
};

// T-26: Handle incoming re-INVITE
Dialog.prototype._onReInvite = function(request) {
  // Parse new SDP
  var newSdp = null;
  if (request.content) {
    try { newSdp = sdp.parse(request.content); } catch(e) {}
  }

  // Detect hold (sendonly/inactive from remote = they're holding us)
  if (newSdp && newSdp.m && newSdp.m[0] && newSdp.m[0].a) {
    var attrs = newSdp.m[0].a;
    var isHold = attrs.indexOf('sendonly') >= 0 || attrs.indexOf('inactive') >= 0;
    if (isHold && this.state === 'active') {
      this.state = 'held';
      this.emit('hold');
    } else if (!isHold && this.state === 'held') {
      this.state = 'active';
      this.emit('unhold');
    }
  }

  // Update remote SDP
  if (newSdp) {
    this.remoteSdp = newSdp;

    // Update RTP remote address if changed
    if (this.rtpSession && newSdp.m) {
      for (var i = 0; i < newSdp.m.length; i++) {
        if (newSdp.m[i].media === 'audio') {
          var cLine = newSdp.m[i].c || newSdp.c;
          if (cLine) this.rtpSession.remoteAddress = cLine.address;
          if (newSdp.m[i].port) this.rtpSession.remotePort = newSdp.m[i].port;
          break;
        }
      }
    }
  }

  // RFC 3261 §12.2.2 — update remote target if Contact changed
  if (request.headers.contact && request.headers.contact.length > 0) {
    this._remoteTarget = request.headers.contact[0].uri;
  }

  this.emit('reinvite', request);

  // Respond 200 OK with current SDP
  if (this._sipSend && this._sipMakeResponse) {
    var rs = this._sipMakeResponse(request, 200, 'OK');
    if (this.localSdp) {
      rs.headers['content-type'] = 'application/sdp';
      rs.content = sdp.stringify(this.localSdp);
    }
    this._sipSend(rs);
  }
};

// T-27: Handle incoming REFER
Dialog.prototype._onRefer = function(request) {
  var referTo = request.headers['refer-to'];

  if (this._sipSend && this._sipMakeResponse) {
    // Accept the REFER with 202
    var rs = this._sipMakeResponse(request, 202, 'Accepted');
    this._sipSend(rs);
  }

  this.emit('refer', referTo, request);
};

// Handle NOTIFY (typically for REFER status)
Dialog.prototype._onNotify = function(request) {
  if (this._sipSend && this._sipMakeResponse) {
    var rs = this._sipMakeResponse(request, 200, 'OK');
    this._sipSend(rs);
  }
  this.emit('notify', request);
};

Dialog.prototype._onDtmf = function(digit, method) {
  this.emit('dtmf', digit, method);
};

// T-29: Graceful cleanup
Dialog.prototype._end = function(reason) {
  if (this.state === 'ended') return;

  this.state = 'ended';

  // Stop RTP session and return port to pool
  if (this.rtpSession) {
    this.rtpSession.stop();
    this.rtpSession = null;
  }

  // Reset DTMF detector
  this.dtmfDetector.reset();

  // Remove all listeners to prevent memory leaks
  this._cleanedUp = true;

  this.emit('end', reason || 'unknown');
};

Dialog.prototype.getStats = function() {
  return {
    id: this.id,
    direction: this.direction,
    state: this.state,
    rtp: this.rtpSession ? this.rtpSession.getStats() : null
  };
};

exports.Dialog = Dialog;
