// Integration: register against real Asterisk in Docker.
// Skips (exit 0) when docker is unavailable.
var execSync = require('child_process').execSync;
var assert = require('assert');

try { execSync('docker info', { stdio: 'ignore' }); }
catch(e) { console.log('SKIP: docker not available'); process.exit(0); }

var CONTAINER = 'vexyl-sip-asterisk-test';

function sh(cmd) { return execSync(cmd, { stdio: 'pipe' }).toString(); }

async function main() {
  // Start Asterisk with our config mounted
  try { sh('docker rm -f ' + CONTAINER); } catch(e) {}
  sh('docker run -d --name ' + CONTAINER +
     ' -p 45060:5060/udp' +
     ' -v ' + __dirname + '/asterisk/pjsip.conf:/etc/asterisk/pjsip.conf:ro' +
     ' -v ' + __dirname + '/asterisk/extensions.conf:/etc/asterisk/extensions.conf:ro' +
     ' andrius/asterisk:latest');
  // Wait for Asterisk to accept SIP
  await new Promise(function(r) { setTimeout(r, 8000); });

  var SipStack = require('../stack').SipStack;
  var stack = new SipStack({ port: 45070, publicAddress: '127.0.0.1' });
  await stack.start();

  try {
    var client = stack.register('sip:100@127.0.0.1:45060', {
      credentials: { user: '100', password: 'test100' },
      expires: 120
    });

    var granted = await new Promise(function(resolve, reject) {
      var t = setTimeout(function() { reject(new Error('registration timed out')); }, 15000);
      client.on('registered', function(e) { clearTimeout(t); resolve(e); });
      client.on('failed', function(err, willRetry) {
        if (!willRetry) { clearTimeout(t); reject(err); }
      });
    });
    console.log('  ✓ registered, granted ' + granted + 's');
    assert.ok(granted > 0);

    // Verify Asterisk sees the contact
    var contacts = sh('docker exec ' + CONTAINER + ' asterisk -rx "pjsip show contacts"');
    assert.ok(/100/.test(contacts), 'Asterisk must list contact for 100');
    console.log('  ✓ contact visible in Asterisk');

    await stack.stop();
    var after = sh('docker exec ' + CONTAINER + ' asterisk -rx "pjsip show contacts"');
    assert.ok(!/Contact:\s+100\/sip/.test(after), 'contact must be gone after unregister');
    console.log('  ✓ unregistered cleanly');
    console.log('\nintegration: all passed');
  } finally {
    try { await stack.stop(); } catch(e) {}
    try { sh('docker rm -f ' + CONTAINER); } catch(e) {}
  }
}

main().catch(function(e) {
  console.error('  ✗ ' + e.message);
  try { execSync('docker rm -f ' + CONTAINER, { stdio: 'ignore' }); } catch(x) {}
  process.exit(1);
});
