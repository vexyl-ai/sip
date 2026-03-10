var dgram = require('dgram');
var EventEmitter = require('events').EventEmitter;
var crypto = require('crypto');

// ============================================================================
// T-10: G.711 mu-law (PCMU) codec — payload type 0
// ============================================================================

// mu-law decode table: 256 entries, maps u-law byte → 16-bit PCM
var ulawDecodeLut = new Int16Array(256);
(function() {
  for (var i = 0; i < 256; i++) {
    var sign, exponent, mantissa, sample;
    var inv = ~i & 0xFF;
    sign = inv & 0x80;
    exponent = (inv >> 4) & 0x07;
    mantissa = inv & 0x0F;
    sample = (mantissa << 3) + 0x84;
    sample <<= exponent;
    sample -= 0x84;
    ulawDecodeLut[i] = sign ? -sample : sample;
  }
})();


function pcmuDecode(ulawBuf) {
  var pcm = Buffer.alloc(ulawBuf.length * 2);
  for (var i = 0; i < ulawBuf.length; i++) {
    var sample = ulawDecodeLut[ulawBuf[i]];
    pcm.writeInt16LE(sample, i * 2);
  }
  return pcm;
}

function pcmuEncodeSample(sample) {
  var BIAS = 0x84;
  var CLIP = 32635;
  var sign = 0;
  if (sample < 0) { sign = 0x80; sample = -sample; }
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  var exponent = 7;
  var mask = 0x4000;
  for (; exponent > 0; exponent--, mask >>= 1) {
    if (sample & mask) break;
  }
  var mantissa = (sample >> (exponent + 3)) & 0x0F;
  return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

function pcmuEncode(pcmBuf) {
  var ulaw = Buffer.alloc(pcmBuf.length / 2);
  for (var i = 0; i < ulaw.length; i++) {
    ulaw[i] = pcmuEncodeSample(pcmBuf.readInt16LE(i * 2));
  }
  return ulaw;
}

// ============================================================================
// T-11: G.711 A-law (PCMA) codec — payload type 8
// ============================================================================

var alawDecodeLut = new Int16Array(256);
(function() {
  for (var i = 0; i < 256; i++) {
    var val = i ^ 0x55;
    var sign = val & 0x80;
    var exponent = (val >> 4) & 0x07;
    var mantissa = val & 0x0F;
    var sample;
    if (exponent === 0) {
      sample = (mantissa << 4) + 8;
    } else {
      sample = ((mantissa << 4) + 0x108) << (exponent - 1);
    }
    alawDecodeLut[i] = sign ? -sample : sample;
  }
})();


function pcmaDecode(alawBuf) {
  var pcm = Buffer.alloc(alawBuf.length * 2);
  for (var i = 0; i < alawBuf.length; i++) {
    var sample = alawDecodeLut[alawBuf[i]];
    pcm.writeInt16LE(sample, i * 2);
  }
  return pcm;
}

function pcmaEncodeSample(sample) {
  var sign = 0;
  if (sample < 0) { sign = 0x80; sample = -sample; }
  if (sample > 32767) sample = 32767;
  var companded;
  if (sample >= 256) {
    var exponent = 7;
    var mask = 0x4000;
    for (; exponent > 1; exponent--, mask >>= 1) {
      if (sample & mask) break;
    }
    var mantissa = (sample >> (exponent + 3)) & 0x0F;
    companded = (exponent << 4) | mantissa;
  } else {
    companded = sample >> 4;
  }
  return (sign | companded) ^ 0x55;
}

function pcmaEncode(pcmBuf) {
  var alaw = Buffer.alloc(pcmBuf.length / 2);
  for (var i = 0; i < alaw.length; i++) {
    alaw[i] = pcmaEncodeSample(pcmBuf.readInt16LE(i * 2));
  }
  return alaw;
}

exports.pcmuDecode = pcmuDecode;
exports.pcmuEncode = pcmuEncode;
exports.pcmaDecode = pcmaDecode;
exports.pcmaEncode = pcmaEncode;

// Codec registry
var codecs = {
  0:  { name: 'PCMU', decode: pcmuDecode, encode: pcmuEncode, sampleRate: 8000, frameDuration: 20, frameSize: 160 },
  8:  { name: 'PCMA', decode: pcmaDecode, encode: pcmaEncode, sampleRate: 8000, frameDuration: 20, frameSize: 160 }
};

exports.codecs = codecs;

// ============================================================================
// T-09: RTP header parser / T-13: RTP packet builder
// ============================================================================

// RTP header: 12 bytes minimum
//  0                   1                   2                   3
//  0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |V=2|P|X|  CC   |M|     PT      |       sequence number         |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |                           timestamp                           |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |                             SSRC                              |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+

function parseRtpHeader(buf) {
  if (!buf || buf.length < 12) return null;

  var byte0 = buf[0];
  var byte1 = buf[1];
  var version = (byte0 >> 6) & 0x03;
  if (version !== 2) return null;

  var padding = (byte0 >> 5) & 0x01;
  var extension = (byte0 >> 4) & 0x01;
  var csrcCount = byte0 & 0x0F;
  var marker = (byte1 >> 7) & 0x01;
  var payloadType = byte1 & 0x7F;
  var sequenceNumber = buf.readUInt16BE(2);
  var timestamp = buf.readUInt32BE(4);
  var ssrc = buf.readUInt32BE(8);

  var headerLength = 12 + (csrcCount * 4);

  // Skip extension header if present
  if (extension && buf.length >= headerLength + 4) {
    var extLength = buf.readUInt16BE(headerLength + 2);
    headerLength += 4 + (extLength * 4);
  }

  // Handle padding
  var payloadEnd = buf.length;
  if (padding && buf.length > headerLength) {
    payloadEnd -= buf[buf.length - 1];
  }

  if (headerLength > buf.length) return null;

  return {
    version: version,
    padding: padding,
    extension: extension,
    csrcCount: csrcCount,
    marker: marker,
    payloadType: payloadType,
    sequenceNumber: sequenceNumber,
    timestamp: timestamp,
    ssrc: ssrc,
    headerLength: headerLength,
    payload: buf.slice(headerLength, payloadEnd)
  };
}

exports.parseRtpHeader = parseRtpHeader;

function buildRtpPacket(header, payload) {
  var buf = Buffer.alloc(12 + payload.length);

  buf[0] = 0x80; // V=2, no padding, no extension, no CSRC
  buf[1] = (header.marker ? 0x80 : 0) | (header.payloadType & 0x7F);
  buf.writeUInt16BE(header.sequenceNumber & 0xFFFF, 2);
  buf.writeUInt32BE(header.timestamp >>> 0, 4);
  buf.writeUInt32BE(header.ssrc >>> 0, 8);

  payload.copy(buf, 12);
  return buf;
}

exports.buildRtpPacket = buildRtpPacket;

// ============================================================================
// T-15: RTP port pool manager
// ============================================================================

function PortPool(minPort, maxPort) {
  this.minPort = minPort || 10000;
  this.maxPort = maxPort || 20000;
  // RTP ports must be even (RTCP = RTP + 1)
  if (this.minPort % 2 !== 0) this.minPort++;
  this.available = [];
  for (var p = this.minPort; p < this.maxPort; p += 2) {
    this.available.push(p);
  }
  this.inUse = new Set();
}

PortPool.prototype.allocate = function() {
  if (this.available.length === 0) return null;
  // Random selection to avoid predictable ports
  var idx = Math.floor(Math.random() * this.available.length);
  var port = this.available.splice(idx, 1)[0];
  this.inUse.add(port);
  return port;
};

PortPool.prototype.release = function(port) {
  if (this.inUse.has(port)) {
    this.inUse.delete(port);
    this.available.push(port);
  }
};

PortPool.prototype.stats = function() {
  return { available: this.available.length, inUse: this.inUse.size, total: this.available.length + this.inUse.size };
};

exports.PortPool = PortPool;

// Default shared pool
var defaultPool = null;
exports.getDefaultPool = function(minPort, maxPort) {
  if (!defaultPool) defaultPool = new PortPool(minPort, maxPort);
  return defaultPool;
};

// ============================================================================
// T-17: Basic RTP jitter buffer
// ============================================================================

function JitterBuffer(options) {
  options = options || {};
  this.bufferMs = options.bufferMs || 60;        // buffer depth in ms
  this.maxSize = options.maxSize || 50;           // max packets to hold
  this.packets = [];
  this.lastSeq = -1;
  this.ready = false;
  this.frameDuration = options.frameDuration || 20;
  this.bufferPackets = Math.ceil(this.bufferMs / this.frameDuration);
}

JitterBuffer.prototype.put = function(packet) {
  // Insert in sequence order
  var seq = packet.sequenceNumber;
  var inserted = false;

  // Drop duplicates and very old packets
  if (this.lastSeq >= 0) {
    var diff = seq - this.lastSeq;
    // Handle 16-bit wrap
    if (diff < -32000) diff += 65536;
    if (diff < 0) return; // already played
  }

  for (var i = this.packets.length - 1; i >= 0; i--) {
    if (this.packets[i].sequenceNumber === seq) return; // duplicate
    if (this.seqBefore(this.packets[i].sequenceNumber, seq)) {
      this.packets.splice(i + 1, 0, packet);
      inserted = true;
      break;
    }
  }
  if (!inserted) this.packets.splice(0, 0, packet);

  // Trim overflow
  while (this.packets.length > this.maxSize) {
    this.packets.shift();
  }

  if (!this.ready && this.packets.length >= this.bufferPackets) {
    this.ready = true;
  }
};

JitterBuffer.prototype.get = function() {
  if (!this.ready || this.packets.length === 0) return null;
  var pkt = this.packets.shift();
  this.lastSeq = pkt.sequenceNumber;
  return pkt;
};

JitterBuffer.prototype.seqBefore = function(a, b) {
  var diff = b - a;
  if (diff < -32000) diff += 65536;
  if (diff > 32000) diff -= 65536;
  return diff > 0;
};

JitterBuffer.prototype.reset = function() {
  this.packets = [];
  this.lastSeq = -1;
  this.ready = false;
};

JitterBuffer.prototype.length = function() {
  return this.packets.length;
};

exports.JitterBuffer = JitterBuffer;

// ============================================================================
// T-08: RTP Session — per-call UDP socket
// T-12: Symmetric RTP for NAT
// T-14: RTP packet pacing (20ms intervals)
// T-16: SSRC tracking per call
// ============================================================================

function RtpSession(options) {
  EventEmitter.call(this);

  options = options || {};
  this.localPort = options.port || null;
  this.localAddress = options.address || '0.0.0.0';
  this.remoteAddress = options.remoteAddress || null;
  this.remotePort = options.remotePort || null;
  this.payloadType = options.payloadType !== undefined ? options.payloadType : 0;
  this.codec = codecs[this.payloadType] || codecs[0];

  // T-16: Per-call SSRC
  this.ssrc = options.ssrc || crypto.randomBytes(4).readUInt32BE(0);
  this.remoteSSRC = null;

  // Outbound state
  this.sequenceNumber = Math.floor(Math.random() * 65535);
  this.timestamp = Math.floor(Math.random() * 0xFFFFFFFF);

  // T-12: Symmetric RTP — track actual source address
  this.symmetricRtp = options.symmetricRtp !== false; // default: true
  this.natAddress = null;
  this.natPort = null;
  this.natLocked = false;

  // T-17: Jitter buffer
  this.jitterBuffer = options.jitterBuffer !== false ? new JitterBuffer(options.jitterBuffer || {}) : null;

  // Internal state
  this.socket = null;
  this.active = false;
  this.pacingTimer = null;
  this.sendQueue = [];
  this.pool = options.pool || null;
  this.stats = { packetsReceived: 0, packetsSent: 0, bytesReceived: 0, bytesSent: 0, packetsLost: 0 };
}

RtpSession.prototype = Object.create(EventEmitter.prototype);
RtpSession.prototype.constructor = RtpSession;

RtpSession.prototype.start = function(callback) {
  var self = this;

  // Allocate port from pool if not specified
  if (!this.localPort && this.pool) {
    this.localPort = this.pool.allocate();
    if (!this.localPort) {
      var err = new Error('No RTP ports available');
      if (callback) return callback(err);
      this.emit('error', err);
      return;
    }
  }

  this.socket = dgram.createSocket('udp4');

  this.socket.on('error', function(err) {
    self.emit('error', err);
  });

  this.socket.on('message', function(data, rinfo) {
    self._onPacket(data, rinfo);
  });

  this.socket.bind(this.localPort, this.localAddress, function() {
    var addr = self.socket.address();
    self.localPort = addr.port;
    self.active = true;
    self.emit('ready', { address: addr.address, port: addr.port });
    if (callback) callback(null, { address: addr.address, port: addr.port });
  });
};

RtpSession.prototype._onPacket = function(data, rinfo) {
  var header = parseRtpHeader(data);
  if (!header) return;

  this.stats.packetsReceived++;
  this.stats.bytesReceived += data.length;

  // T-16: Track remote SSRC
  if (this.remoteSSRC === null) {
    this.remoteSSRC = header.ssrc;
  }

  // T-12: Symmetric RTP — learn actual source address for NAT traversal
  if (this.symmetricRtp && !this.natLocked) {
    this.natAddress = rinfo.address;
    this.natPort = rinfo.port;
    // Lock after first packet to prevent spoofing
    this.natLocked = true;
  }

  // Decode payload if we have a codec
  var codec = codecs[header.payloadType];
  if (codec && codec.decode) {
    header.pcm = codec.decode(header.payload);
  }

  if (this.jitterBuffer) {
    this.jitterBuffer.put(header);
    this._drainJitterBuffer();
  } else {
    this.emit('audio', header.pcm || header.payload, header);
  }
};

RtpSession.prototype._drainJitterBuffer = function() {
  var pkt;
  while ((pkt = this.jitterBuffer.get()) !== null) {
    this.emit('audio', pkt.pcm || pkt.payload, pkt);
  }
};

// T-12: Get the effective remote address (NAT-learned or configured)
RtpSession.prototype.getRemote = function() {
  if (this.symmetricRtp && this.natAddress) {
    return { address: this.natAddress, port: this.natPort };
  }
  return { address: this.remoteAddress, port: this.remotePort };
};

// Send raw RTP payload (already encoded)
RtpSession.prototype.sendPayload = function(payload, options) {
  if (!this.active || !this.socket) return;

  options = options || {};
  var remote = this.getRemote();
  if (!remote.address || !remote.port) return;

  var packet = buildRtpPacket({
    payloadType: options.payloadType !== undefined ? options.payloadType : this.payloadType,
    sequenceNumber: this.sequenceNumber++,
    timestamp: this.timestamp,
    ssrc: this.ssrc,
    marker: options.marker || 0
  }, payload);

  // T-13: timestamp must advance by frameSize (160 for 20ms @ 8kHz), NOT by 1
  this.timestamp += this.codec.frameSize;

  this.socket.send(packet, 0, packet.length, remote.port, remote.address);
  this.stats.packetsSent++;
  this.stats.bytesSent += packet.length;
};

// Send PCM audio — encodes and sends
RtpSession.prototype.sendPcm = function(pcmBuffer) {
  if (!this.codec || !this.codec.encode) return;
  var encoded = this.codec.encode(pcmBuffer);
  this.sendPayload(encoded);
};

// T-14: Send PCM audio with proper 20ms pacing
// Accepts a full PCM buffer (any length), splits into 20ms frames, paces at real-time rate
RtpSession.prototype.sendPcmPaced = function(pcmBuffer, callback) {
  var self = this;
  var frameBytes = this.codec.frameSize * 2; // 16-bit PCM = 2 bytes per sample
  var frameDuration = this.codec.frameDuration;
  var offset = 0;

  function sendNext() {
    if (offset >= pcmBuffer.length || !self.active) {
      if (callback) callback();
      self.emit('sendComplete');
      return;
    }

    var end = Math.min(offset + frameBytes, pcmBuffer.length);
    var frame = pcmBuffer.slice(offset, end);

    // Pad last frame if needed
    if (frame.length < frameBytes) {
      var padded = Buffer.alloc(frameBytes);
      frame.copy(padded);
      frame = padded;
    }

    self.sendPcm(frame);
    offset += frameBytes;

    self.pacingTimer = setTimeout(sendNext, frameDuration);
  }

  sendNext();
};

// Enqueue PCM buffer for paced sending (queues multiple buffers)
RtpSession.prototype.enqueuePcm = function(pcmBuffer) {
  this.sendQueue.push(pcmBuffer);
  if (this.sendQueue.length === 1) {
    this._processQueue();
  }
};

RtpSession.prototype._processQueue = function() {
  var self = this;
  if (this.sendQueue.length === 0) return;

  var buf = this.sendQueue[0];
  this.sendPcmPaced(buf, function() {
    self.sendQueue.shift();
    self._processQueue();
  });
};

RtpSession.prototype.stop = function() {
  this.active = false;

  if (this.pacingTimer) {
    clearTimeout(this.pacingTimer);
    this.pacingTimer = null;
  }

  this.sendQueue = [];

  if (this.jitterBuffer) {
    this.jitterBuffer.reset();
  }

  if (this.socket) {
    try { this.socket.close(); } catch(e) {}
    this.socket = null;
  }

  // Return port to pool
  if (this.pool && this.localPort) {
    this.pool.release(this.localPort);
  }

  this.emit('close');
};

RtpSession.prototype.getStats = function() {
  return Object.assign({}, this.stats, {
    localPort: this.localPort,
    remoteAddress: this.getRemote().address,
    remotePort: this.getRemote().port,
    ssrc: this.ssrc,
    remoteSSRC: this.remoteSSRC,
    jitterBufferLength: this.jitterBuffer ? this.jitterBuffer.length() : 0
  });
};

exports.RtpSession = RtpSession;

// ============================================================================
// Convenience: create a session with port pool
// ============================================================================

exports.createSession = function(options) {
  options = options || {};
  if (!options.pool && !options.port) {
    options.pool = exports.getDefaultPool(options.minPort, options.maxPort);
  }
  return new RtpSession(options);
};
