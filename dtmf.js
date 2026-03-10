// ============================================================================
// @vexyl.ai/sip — DTMF Detection Module
// T-22: RFC 2833 DTMF (RTP payload type 101)
// T-23: SIP INFO DTMF fallback
// T-24: Goertzel in-band DTMF detection
// ============================================================================

var EventEmitter = require('events').EventEmitter;

// ============================================================================
// T-22: RFC 2833 DTMF — RTP telephone-event (payload type 101)
// ============================================================================
//
// RFC 2833 / RFC 4733 event packet format:
//  0                   1                   2                   3
//  0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |     event     |E|R| volume    |          duration             |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+

// Event code to DTMF digit mapping
var EVENT_TO_DIGIT = {
  0: '0', 1: '1', 2: '2', 3: '3', 4: '4',
  5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
  10: '*', 11: '#',
  12: 'A', 13: 'B', 14: 'C', 15: 'D'
};

var DIGIT_TO_EVENT = {};
Object.keys(EVENT_TO_DIGIT).forEach(function(k) {
  DIGIT_TO_EVENT[EVENT_TO_DIGIT[k]] = parseInt(k, 10);
});

function parseRfc2833(payload) {
  if (!payload || payload.length < 4) return null;

  var event = payload[0];
  var endBit = (payload[1] >> 7) & 0x01;
  var volume = payload[1] & 0x3F;
  var duration = payload.readUInt16BE(2);

  var digit = EVENT_TO_DIGIT[event];
  if (digit === undefined) return null;

  return {
    event: event,
    digit: digit,
    end: !!endBit,
    volume: volume,
    duration: duration
  };
}

exports.parseRfc2833 = parseRfc2833;

function buildRfc2833(digit, end, volume, duration) {
  var event = DIGIT_TO_EVENT[digit];
  if (event === undefined) return null;

  var buf = Buffer.alloc(4);
  buf[0] = event;
  buf[1] = (end ? 0x80 : 0) | (volume & 0x3F);
  buf.writeUInt16BE(duration & 0xFFFF, 2);
  return buf;
}

exports.buildRfc2833 = buildRfc2833;

// RFC 2833 DTMF detector — tracks event state to emit digit only once per press
function Rfc2833Detector() {
  this.currentEvent = -1;
  this.currentTimestamp = 0;
}

Rfc2833Detector.prototype.process = function(rtpHeader) {
  // RFC 2833 uses dynamic payload type, typically 101
  var parsed = parseRfc2833(rtpHeader.payload);
  if (!parsed) return null;

  // New event = different timestamp from current
  if (rtpHeader.timestamp !== this.currentTimestamp) {
    this.currentTimestamp = rtpHeader.timestamp;
    this.currentEvent = parsed.event;
    // Emit on first packet of a new event
    return parsed.digit;
  }

  // Same timestamp = continuation/end of same event, don't re-emit
  return null;
};

Rfc2833Detector.prototype.reset = function() {
  this.currentEvent = -1;
  this.currentTimestamp = 0;
};

exports.Rfc2833Detector = Rfc2833Detector;

// ============================================================================
// T-23: SIP INFO DTMF fallback
// ============================================================================
//
// Some older trunks send DTMF as SIP INFO messages:
//   Content-Type: application/dtmf-relay
//   Body: Signal=5\r\nDuration=160\r\n
//
// Or:
//   Content-Type: application/dtmf
//   Body: 5

function parseSipInfoDtmf(request) {
  if (!request || request.method !== 'INFO') return null;

  var contentType = request.headers['content-type'];
  if (!contentType) return null;

  var body = request.content;
  if (!body) return null;

  contentType = contentType.toLowerCase().trim();

  if (contentType === 'application/dtmf-relay') {
    // Format: Signal=5\r\nDuration=160\r\n
    var signalMatch = body.match(/Signal\s*=\s*([0-9A-D*#])/i);
    var durationMatch = body.match(/Duration\s*=\s*(\d+)/i);
    if (signalMatch) {
      return {
        digit: signalMatch[1],
        duration: durationMatch ? parseInt(durationMatch[1], 10) : 160,
        method: 'sip-info'
      };
    }
  } else if (contentType === 'application/dtmf') {
    // Simple body: just the digit
    var digit = body.trim();
    if (/^[0-9A-D*#]$/.test(digit)) {
      return { digit: digit, duration: 160, method: 'sip-info' };
    }
  }

  return null;
}

exports.parseSipInfoDtmf = parseSipInfoDtmf;

// Build a SIP INFO body for sending DTMF
function buildSipInfoDtmf(digit, duration) {
  return {
    contentType: 'application/dtmf-relay',
    body: 'Signal=' + digit + '\r\nDuration=' + (duration || 160) + '\r\n'
  };
}

exports.buildSipInfoDtmf = buildSipInfoDtmf;

// ============================================================================
// T-24: Goertzel in-band DTMF detection
// ============================================================================
//
// DTMF tones are dual-frequency:
//         1209 Hz  1336 Hz  1477 Hz  1633 Hz
// 697 Hz    1        2        3        A
// 770 Hz    4        5        6        B
// 852 Hz    7        8        9        C
// 941 Hz    *        0        #        D

var DTMF_FREQS_LOW  = [697, 770, 852, 941];
var DTMF_FREQS_HIGH = [1209, 1336, 1477, 1633];

var DTMF_MAP = [
  ['1', '2', '3', 'A'],
  ['4', '5', '6', 'B'],
  ['7', '8', '9', 'C'],
  ['*', '0', '#', 'D']
];

// Goertzel algorithm — compute power at a specific frequency
function goertzelMagnitude(samples, sampleRate, targetFreq, numSamples) {
  var k = Math.round(numSamples * targetFreq / sampleRate);
  var w = 2 * Math.PI * k / numSamples;
  var coeff = 2 * Math.cos(w);

  var s0 = 0, s1 = 0, s2 = 0;
  for (var i = 0; i < numSamples; i++) {
    s0 = samples[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }

  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

// Goertzel-based DTMF detector
// Operates on PCM 16-bit LE buffers at 8000 Hz sample rate
function GoertzelDetector(options) {
  options = options || {};
  this.sampleRate = options.sampleRate || 8000;
  this.blockSize = options.blockSize || 205;  // ~25.6ms at 8kHz — standard Goertzel block
  this.threshold = options.threshold || 100;    // Minimum power threshold (normalized float samples)
  this.twistLimit = options.twistLimit || 6;    // Max dB difference between low and high group
  this.lastDigit = null;
  this.digitCount = 0;
  this.minDuration = options.minDuration || 2;  // Minimum consecutive detections (debounce)
  this.sampleBuffer = [];
}

GoertzelDetector.prototype.process = function(pcmBuffer) {
  var results = [];

  // Convert PCM buffer to float samples
  for (var i = 0; i < pcmBuffer.length; i += 2) {
    if (i + 1 < pcmBuffer.length) {
      this.sampleBuffer.push(pcmBuffer.readInt16LE(i) / 32768.0);
    }
  }

  // Process complete blocks
  while (this.sampleBuffer.length >= this.blockSize) {
    var block = this.sampleBuffer.splice(0, this.blockSize);
    var digit = this._detectBlock(block);
    if (digit) results.push(digit);
  }

  return results;
};

GoertzelDetector.prototype._detectBlock = function(samples) {
  var numSamples = samples.length;

  // Calculate power for each DTMF frequency
  var lowPowers = new Array(4);
  var highPowers = new Array(4);

  for (var i = 0; i < 4; i++) {
    lowPowers[i] = goertzelMagnitude(samples, this.sampleRate, DTMF_FREQS_LOW[i], numSamples);
    highPowers[i] = goertzelMagnitude(samples, this.sampleRate, DTMF_FREQS_HIGH[i], numSamples);
  }

  // Find peak in each group
  var bestLow = 0, bestLowIdx = 0;
  var bestHigh = 0, bestHighIdx = 0;

  for (var i = 0; i < 4; i++) {
    if (lowPowers[i] > bestLow) { bestLow = lowPowers[i]; bestLowIdx = i; }
    if (highPowers[i] > bestHigh) { bestHigh = highPowers[i]; bestHighIdx = i; }
  }

  // Check threshold
  if (bestLow < this.threshold || bestHigh < this.threshold) {
    // No tone — reset state
    if (this.lastDigit !== null) {
      this.lastDigit = null;
      this.digitCount = 0;
    }
    return null;
  }

  // Twist check: ensure both frequencies are roughly equal power (within twistLimit dB)
  var twistDb = 10 * Math.log10(bestHigh / bestLow);
  if (Math.abs(twistDb) > this.twistLimit) {
    this.lastDigit = null;
    this.digitCount = 0;
    return null;
  }

  // Check that the peak is significantly stronger than the second-strongest in its group
  for (var i = 0; i < 4; i++) {
    if (i !== bestLowIdx && lowPowers[i] > bestLow * 0.3) {
      this.lastDigit = null;
      this.digitCount = 0;
      return null;
    }
    if (i !== bestHighIdx && highPowers[i] > bestHigh * 0.3) {
      this.lastDigit = null;
      this.digitCount = 0;
      return null;
    }
  }

  var digit = DTMF_MAP[bestLowIdx][bestHighIdx];

  // Debounce: require minDuration consecutive detections of same digit
  if (digit === this.lastDigit) {
    this.digitCount++;
    if (this.digitCount === this.minDuration) {
      return digit; // Emit once on reaching threshold
    }
    return null;
  }

  // New digit
  this.lastDigit = digit;
  this.digitCount = 1;
  if (this.minDuration <= 1) return digit;
  return null;
};

GoertzelDetector.prototype.reset = function() {
  this.lastDigit = null;
  this.digitCount = 0;
  this.sampleBuffer = [];
};

exports.GoertzelDetector = GoertzelDetector;

// ============================================================================
// Unified DTMF Detector — combines all three methods
// ============================================================================

function DtmfDetector(options) {
  EventEmitter.call(this);

  options = options || {};
  this.rfc2833PayloadType = options.rfc2833PayloadType || 101;
  this.enableRfc2833 = options.rfc2833 !== false;
  this.enableGoertzel = options.goertzel !== false;

  if (this.enableRfc2833) {
    this.rfc2833 = new Rfc2833Detector();
  }
  if (this.enableGoertzel) {
    this.goertzel = new GoertzelDetector(options.goertzel || {});
  }
}

DtmfDetector.prototype = Object.create(EventEmitter.prototype);
DtmfDetector.prototype.constructor = DtmfDetector;

// Process an RTP packet — checks for RFC 2833 event, falls back to Goertzel
DtmfDetector.prototype.processRtp = function(rtpHeader) {
  // Check for RFC 2833 telephone-event
  if (this.enableRfc2833 && rtpHeader.payloadType === this.rfc2833PayloadType) {
    var digit = this.rfc2833.process(rtpHeader);
    if (digit) {
      this.emit('digit', digit, 'rfc2833');
      return digit;
    }
    return null; // Don't run Goertzel on event packets
  }

  // Try Goertzel on audio packets
  if (this.enableGoertzel && rtpHeader.pcm) {
    var digits = this.goertzel.process(rtpHeader.pcm);
    for (var i = 0; i < digits.length; i++) {
      this.emit('digit', digits[i], 'goertzel');
    }
    return digits.length > 0 ? digits[0] : null;
  }

  return null;
};

// Process a SIP INFO request
DtmfDetector.prototype.processSipInfo = function(request) {
  var result = parseSipInfoDtmf(request);
  if (result) {
    this.emit('digit', result.digit, 'sip-info');
    return result.digit;
  }
  return null;
};

DtmfDetector.prototype.reset = function() {
  if (this.rfc2833) this.rfc2833.reset();
  if (this.goertzel) this.goertzel.reset();
};

exports.DtmfDetector = DtmfDetector;

// Export constants
exports.EVENT_TO_DIGIT = EVENT_TO_DIGIT;
exports.DIGIT_TO_EVENT = DIGIT_TO_EVENT;
exports.DTMF_FREQS_LOW = DTMF_FREQS_LOW;
exports.DTMF_FREQS_HIGH = DTMF_FREQS_HIGH;
