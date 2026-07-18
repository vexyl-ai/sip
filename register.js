// ============================================================================
// @vexyl.ai/sip — Registration client (RFC 3261 §10)
// Registers the stack as an extension against a PBX/registrar.
// ============================================================================

var EventEmitter = require('events').EventEmitter;
var crypto = require('crypto');
var sip = require('./sip');
var digest = require('./digest');

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
  this._authCtx = {};
  this._authAttempted = false;
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
