const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = process.argv[2] || path.join(__dirname, '..');
const ASSERT = process.env.ASSERT === '1';
const AUTH_ATTEMPTS = parseInt(process.env.AUTH_ATTEMPTS || '10', 10);

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

function frame(type, sid, data) {
  const dataLen = data ? data.length : 0;
  const total = 13 + dataLen;
  const b = Buffer.allocUnsafe(total);
  b.writeUInt32BE(total, 0);
  b.writeUInt8(type, 4);
  b.writeUInt32BE(sid, 5);
  b.writeUInt32BE(dataLen, 9);
  if (dataLen) data.copy(b, 13);
  return b;
}

// Split a wrong-token AUTH_HELLO so the first chunk is partial (classified as a
// worker candidate) and the completion carries the bad token.
function wrongAuth(serverPort) {
  return new Promise((resolve) => {
    const s = net.connect(serverPort, '127.0.0.1');
    const payload = Buffer.from('TUN1 ' + 'e'.repeat(128));
    const f = frame(0x10, 0, payload);
    let finished = false;
    const done = (why) => { if (finished) return; finished = true; try { s.destroy(); } catch {} resolve(why); };
    s.on('error', () => done('error'));
    s.on('close', () => done('close'));
    s.on('connect', () => {
      s.write(f.subarray(0, 23));
      setTimeout(() => { if (!finished) s.write(f.subarray(23)); }, 30);
    });
    setTimeout(() => done('timeout'), 4000);
  });
}

// Send a partial AUTH_HELLO (header only, declares a large-but-bounded payload)
// and never complete it: the server must drop the candidate via AUTH_TIMEOUT_MS.
function authTimeout(serverPort) {
  return new Promise((resolve) => {
    const s = net.connect(serverPort, '127.0.0.1');
    const header = Buffer.allocUnsafe(13);
    header.writeUInt32BE(13 + 4000, 0);
    header.writeUInt8(0x10, 4);
    header.writeUInt32BE(0, 5);
    header.writeUInt32BE(4000, 9);
    let finished = false;
    const t0 = Date.now();
    const done = (why) => { if (finished) return; finished = true; try { s.destroy(); } catch {} resolve({ why, ms: Date.now() - t0 }); };
    s.on('error', () => done('error'));
    s.on('close', () => done('close'));
    s.on('connect', () => s.write(header));
    setTimeout(() => done('timeout'), 4000);
  });
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-auth-'));
  fs.copyFileSync(path.join(REPO, 'server.js'), path.join(tmp, 'server.js'));
  const token = 'tok_' + 'a'.repeat(60);
  fs.writeFileSync(path.join(tmp, 'token'), token, { mode: 0o600 });

  const serverPort = await freePort();
  const result = { ok: false, wrongAuthResults: [], authTimeout: null, authFailLogs: 0 };

  let serverOutput = '';
  const server = spawn(process.execPath, ['server.js'], {
    cwd: tmp,
    env: {
      ...process.env,
      SERVER_PORT: String(serverPort),
      AUTH_TIMEOUT_MS: '500',
      LOG_FAIL_THROTTLE_MS: '60000',
      CONN_RATE_LIMIT_PER_IP: '1000000',
    },
  });
  server.stdout.on('data', (d) => { serverOutput += d.toString(); });

  try {
    await waitForOutput(server, /TCP listening/, 10000, 'server');
    await sleep(100);

    for (let i = 0; i < AUTH_ATTEMPTS; i++) result.wrongAuthResults.push(await wrongAuth(serverPort));
    result.authTimeout = await authTimeout(serverPort);

    await sleep(300);
    result.authFailLogs = (serverOutput.match(/auth failed/g) || []).length;

    const wrongAllClosed = result.wrongAuthResults.every((r) => r !== 'timeout');
    const timeoutDropped = result.authTimeout.why !== 'timeout' && result.authTimeout.ms < 2500;
    const logsThrottled = result.authFailLogs <= 2; // 10 attempts, same IP -> ~1 line

    result.ok = wrongAllClosed && timeoutDropped && logsThrottled;
    result.checks = { wrongAllClosed, timeoutDropped, logsThrottled };
  } catch (e) {
    result.error = e.message;
  } finally {
    try { server.kill('SIGKILL'); } catch {}
  }

  console.log(JSON.stringify(result, null, 2));
  if (ASSERT && !result.ok) process.exit(1);
})();
