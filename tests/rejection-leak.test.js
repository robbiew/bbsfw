/**
 * Regression tests for connection-slot leak on rejected connections
 * and for LOG_LEVEL=debug being honored.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server.address().port));
  });
}

function connect(port, host) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ port, host }, () => resolve(sock));
    sock.once('error', reject);
  });
}

// Waits for data (resolves) or close-without-data (resolves with null)
function firstData(sock, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    sock.once('data', (d) => {
      clearTimeout(timer);
      resolve(d);
    });
    sock.once('close', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

test('a rejected connection does not leak the active-connection slot', async (t) => {
  // Fake backend so the test never touches a real BBS
  const backend = net.createServer((sock) => {
    sock.write('HELLO-BACKEND');
  });
  const backendPort = await listen(backend, 0, '127.0.0.1');

  // Blocklist IPv4 loopback; the "allowed" client will come in via ::1
  const blocklistPath = path.join(os.tmpdir(), `bbsfw-test-blocklist-${process.pid}.txt`);
  fs.writeFileSync(blocklistPath, '127.0.0.1\n');

  const listenPort = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      LISTEN_PORT: String(listenPort),
      BACKEND_HOST: '127.0.0.1',
      BACKEND_PORT: String(backendPort),
      MAX_CONNECTIONS: '1',
      BLOCKED_COUNTRIES: '',
      RATE_LIMIT_ENABLED: 'false',
      BLOCKLIST_PATH: blocklistPath,
      SSH_ENABLED: 'false',
      LOG_LEVEL: 'info',
    },
  });

  t.after(() => {
    child.kill('SIGKILL');
    backend.close();
    fs.rmSync(blocklistPath, { force: true });
  });

  await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`server never started:\n${out}`)), 5000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (out.includes('listening on port')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => reject(new Error(`server exited (${code}):\n${out}`)));
  });

  // Blocked client: connects from the blocklisted IP, immediately sends bytes
  // (like a telnet client's IAC negotiation) and stays connected, leaving
  // unread data pending when the proxy rejects it.
  const blocked = await connect(listenPort, '127.0.0.1');
  blocked.write('\xff\xfd\x18');
  t.after(() => blocked.destroy());

  // Give the server time to reject the blocked client and release its slot
  await new Promise((r) => setTimeout(r, 500));

  // Allowed client: must get the only connection slot and reach the backend
  const allowed = await connect(listenPort, '::1');
  t.after(() => allowed.destroy());
  const data = await firstData(allowed, 2000);

  assert.ok(
    data && data.toString().includes('HELLO-BACKEND'),
    'allowed connection should reach the backend; got no data — the rejected connection leaked the slot'
  );
});

test('LOG_LEVEL=debug enables debug logging', () => {
  const result = spawnSync(
    process.execPath,
    ['-e', "require('./logger').debug('dbg-probe-message')"],
    { cwd: REPO_ROOT, env: { ...process.env, LOG_LEVEL: 'debug' }, encoding: 'utf8' }
  );
  assert.match(result.stdout, /dbg-probe-message/, 'debug message should be printed when LOG_LEVEL=debug');
});
