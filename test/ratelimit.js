const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = process.argv[2] || path.join(__dirname, '..');
const ASSERT = process.env.ASSERT === '1';
const LIMIT = parseInt(process.env.LIMIT || '5', 10);
const ATTEMPTS = parseInt(process.env.ATTEMPTS || '30', 10);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function waitForOutput(child, pattern, timeoutMs, tag) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`timeout ${pattern} in ${tag}`)), timeoutMs);
    const onData = (d) => { buf += d.toString(); if (pattern.test(buf)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.on('exit', (code) => { if (code) { clearTimeout(timer); reject(new Error(`${tag} exited ${code}`)); } });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-rate-'));
  fs.copyFileSync(path.join(REPO, 'server.js'), path.join(tmp, 'server.js'));
  fs.writeFileSync(path.join(tmp, 'token'), 'tok_' + 'f'.repeat(60), { mode: 0o600 });

  const serverPort = await freePort();
  const result = { limit: LIMIT, attempts: ATTEMPTS, accepted: 0, rejected: 0, ok: false };

  const server = spawn(process.execPath, ['server.js'], {
    cwd: tmp,
    env: { ...process.env, SERVER_PORT: String(serverPort), CONN_RATE_LIMIT_PER_IP: String(LIMIT) },
  });

  const socks = [];
  try {
    await waitForOutput(server, /TCP listening/, 10000, 'server');

    for (let i = 0; i < ATTEMPTS; i++) {
      const s = net.connect(serverPort, '127.0.0.1');
      s.on('error', () => {});
      socks.push(s);
    }

    await sleep(1500);

    for (const s of socks) {
      if (s.destroyed) result.rejected++;
      else result.accepted++;
    }

    // With a per-IP limit of LIMIT/s, only a handful may be accepted; the rest
    // are dropped at accept time. Windows reset each second, hence the margin.
    const acceptedBounded = result.accepted <= LIMIT + 5;
    const rejectedMany = result.rejected >= ATTEMPTS - (LIMIT + 5);
    result.ok = acceptedBounded && rejectedMany;
    result.checks = { acceptedBounded, rejectedMany };
  } catch (e) {
    result.error = e.message;
  } finally {
    for (const s of socks) { try { s.destroy(); } catch {} }
    try { server.kill('SIGKILL'); } catch {}
  }

  console.log(JSON.stringify(result, null, 2));
  if (ASSERT && !result.ok) process.exit(1);
})();
