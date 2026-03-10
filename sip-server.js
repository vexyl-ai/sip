#!/usr/bin/env node
'use strict';

const { createBridgeFromEnv } = require('./vexyl-sip-bridge');

// --help flag
if (process.argv.includes('--help')) {
  console.log(`
VexylSipBridge — Standalone SIP Server

Usage: node sip-server.js [--help]

Environment variables:

  SIP_PORT              SIP listening port (default: 5060)
  SIP_PUBLIC_ADDRESS    Public IP for SIP signaling (alias: PUBLIC_IP)
  SIP_AUTH_USER         SIP authentication username
  SIP_AUTH_PASSWORD     SIP authentication password
  SIP_ALLOWED_IPS      Comma-separated allowed source IPs
  SIP_MAX_CALLS         Max concurrent calls
  SIP_KEEPALIVE_URI     URI for keepalive OPTIONS pings
  SIP_KEEPALIVE_INTERVAL  Keepalive interval in ms
  SIP_CODEC             Codec preference (0=PCMU, 8=PCMA)
  SIP_RING_DURATION     Ring duration before answer (ms)
  RTP_PORT_MIN          Min RTP port (default: 10000)
  RTP_PORT_MAX          Max RTP port (default: 20000)
  DEFAULT_LANGUAGE      Default language code (default: en-IN)

Example:
  SIP_PORT=5060 node sip-server.js
`);
  process.exit(0);
}

const bridge = createBridgeFromEnv();

// Track audio packets per session
const audioPacketCounts = new Map();

bridge.on('session', (session) => {
  const { id, callerId, callerName } = session;
  const label = callerName ? `${callerName} <${callerId}>` : callerId || 'unknown';
  console.log(`[CALL] New incoming call  session=${id}  from=${label}`);

  audioPacketCounts.set(id, 0);

  session.on('ready', () => {
    console.log(`[CALL] Session ready  session=${id}`);
  });

  session.on('dtmf', (digit, method) => {
    console.log(`[DTMF] digit=${digit}  method=${method}  session=${id}`);
  });

  session.on('audio', () => {
    const count = (audioPacketCounts.get(id) || 0) + 1;
    audioPacketCounts.set(id, count);
    // Log every 500 packets (~10 seconds of audio at 20ms intervals)
    if (count % 500 === 0) {
      console.log(`[AUDIO] ${count} packets received  session=${id}`);
    }
  });

  session.on('end', (reason) => {
    const packets = audioPacketCounts.get(id) || 0;
    console.log(`[CALL] Session ended  reason=${reason}  packets=${packets}  session=${id}`);
    audioPacketCounts.delete(id);
  });

  session.on('error', (err) => {
    console.error(`[ERROR] Session error  session=${id}  ${err.message || err}`);
  });
});

bridge.on('error', (err) => {
  console.error(`[ERROR] Bridge error: ${err.message || err}`);
});

// Graceful shutdown
let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\n[SHUTDOWN] Received ${signal}, stopping bridge...`);
  bridge.stop().then(() => {
    console.log('[SHUTDOWN] Bridge stopped');
    process.exit(0);
  }).catch((err) => {
    console.error('[SHUTDOWN] Error during stop:', err.message || err);
    process.exit(1);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Start
bridge.start().then(() => {
  const sipPort = bridge.sipPort || 5060;
  const publicAddr = bridge.publicAddress || 'not set';

  console.log('');
  console.log('========================================');
  console.log('  VexylSipBridge — SIP Server Running');
  console.log('========================================');
  console.log(`  SIP port:    ${sipPort}`);
  console.log(`  Public IP:   ${publicAddr}`);
  console.log('========================================');
  console.log('');
  console.log('Waiting for incoming calls...');
}).catch((err) => {
  console.error('[FATAL] Failed to start bridge:', err.message || err);
  process.exit(1);
});
