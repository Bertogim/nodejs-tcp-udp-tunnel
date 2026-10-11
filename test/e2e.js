const { spawn, execSync } = require('child_process');
const net = require('net');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = process.argv[2] || path.join(__dirname, '..');
const MODE = process.argv[3] || process.env.MODE || 'fixed';
const ASSERT = process.env.ASSERT === '1';
const BASELINE_REF = process.env.BASELINE_REF || 'v1.0.0';

const PAUSE_MS = 2000;
const TARGET_BYTES = 8 * 1024 * 1024;
const GLOBAL_TIMEOUT = 45000;
const FAST_MIN_DURING_PAUSE = parseInt(process.env.FAST_MIN_DURING_PAUSE || String(12 * 1024 * 1024), 10);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function freeUdpPort() {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.on('error', reject);
    s.bind(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function makeVerifier(name) {
  let buf = Buffer.alloc(0);
  let expected = 0;
  let received = 0;
  let error = null;
  return {
    feed(chunk) {
      received += chunk.length;
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= 4) {
        const v = buf.readUInt32LE(0);
        if (v !== expected && error === null) {
          error = `${name}: word mismatch at index ${expected}, got ${v} (duplicate/loss/reorder)`;
        }
        expected++;
        buf = buf.subarray(4);
      }
      if (buf.length && buf.buffer.byteLength > buf.length + 65536) buf = Buffer.from(buf);
    },
    get received() { return received; },
    get error() { return error; },
    get words() { return expected; },
  };
}

const ORIGIN_RATE_BPS = 8 * 1024 * 1024; // 8 MiB/s per connection

function startOrigin(port, udpPort) {
  const server = net.createServer((sock) => {
    sock.setNoDelay(true);
    let w = 0;
    let written = 0;
    let start = Date.now();
    let stopped = false;
    sock.on('error', () => {});
    sock.on('close', () => { stopped = true; });
    function pump() {
      if (stopped) return;
      while (true) {
        const elapsed = (Date.now() - start) / 1000;
        if (written > ORIGIN_RATE_BPS * elapsed) {
          setTimeout(pump, 5);
          return;
        }
        const words = 16384; // 64 KiB per chunk
        const buf = Buffer.allocUnsafe(words * 4);
        for (let i = 0; i < words; i++) buf.writeUInt32LE(w++, i * 4);
        written += buf.length;
        if (!sock.write(buf)) return;
      }
    }
    sock.on('drain', pump);
    pump();
  });
  const udp = dgram.createSocket('udp4');
  udp.on('message', (msg, rinfo) => udp.send(msg, rinfo.port, rinfo.address));

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    udp.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      udp.bind(udpPort, '127.0.0.1', () => resolve({ tcp: server, udp }));
    });
  });
}

function waitForOutput(child, pattern, timeoutMs, tag) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${pattern} in ${tag}`)), timeoutMs);
    const onData = (d) => {
      buf += d.toString();
      if (pattern.test(buf)) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.on('exit', (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`${tag} exited early with code ${code}`));
      }
    });
  });
}

function collect(child, tag, store) {
  const lines = [];
  child.stdout.on('data', (d) => {
    for (const l of d.toString().split('\n')) if (l.trim()) lines.push(l.trim());
    if (lines.length > 400) lines.splice(0, lines.length - 400);
  });
  child.stderr.on('data', (d) => {
    for (const l of d.toString().split('\n')) if (l.trim()) lines.push('[stderr] ' + l.trim());
  });
  store[tag] = lines;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-e2e-'));
  const serverSrc = MODE === 'old'
    ? execSync(`git show ${BASELINE_REF}:server.js`, { cwd: REPO }).toString()
    : fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
  const clientSrc = fs.readFileSync(path.join(REPO, 'client.js'), 'utf8');

  fs.writeFileSync(path.join(tmp, 'server.js'), serverSrc);
  fs.writeFileSync(path.join(tmp, 'client.js'), clientSrc);

  const token = 'testtoken_' + 'a'.repeat(40);
  fs.writeFileSync(path.join(tmp, 'token'), token, { mode: 0o600 });

  const serverPort = await freePort();
  const originPort = await freePort();
  const originUdpPort = await freeUdpPort();

  fs.writeFileSync(path.join(tmp, 'client.json'), JSON.stringify({
    config: [{
      vps: { socket: `127.0.0.1:${serverPort}`, token },
      tcp: { enabled: true, socket: `127.0.0.1:${originPort}` },
      udp: { enabled: true, socket: `127.0.0.1:${originUdpPort}` },
      http: { enabled: false, socket: `127.0.0.1:${originPort}` },
    }],
  }, null, 2));

  const store = {};
  const origin = await startOrigin(originPort, originUdpPort);

  const server = spawn(process.execPath, ['server.js'], {
    cwd: tmp,
    env: { ...process.env, SERVER_PORT: String(serverPort) },
  });
  collect(server, 'server', store);

  const client = spawn(process.execPath, ['client.js'], { cwd: tmp, env: { ...process.env } });
  collect(client, 'client', store);

  const result = { mode: MODE, tmp, ok: false, checks: {}, diagnostics: {} };

  try {
    await waitForOutput(server, /TCP listening/, 10000, 'server');
    await waitForOutput(client, /\[\+\] authenticated/, 10000, 'client');
    await sleep(500);

    // --- UDP round-trip through the tunnel (regression guard for the UDP path) ---
    const udpPayload = Buffer.from('ping-udp-' + Date.now());
    const udpSock = dgram.createSocket('udp4');
    const udpReply = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 5000);
      udpSock.on('message', (m) => { clearTimeout(t); resolve(m); });
      udpSock.send(udpPayload, serverPort, '127.0.0.1');
    });
    const udpEchoOk = !!udpReply && udpReply.equals(udpPayload);
    try { udpSock.close(); } catch {}

    const fastV = makeVerifier('fast');
    const slowV = makeVerifier('slow');

    const fast = net.connect(serverPort, '127.0.0.1');
    const slow = net.connect(serverPort, '127.0.0.1');
    fast.setNoDelay(true);
    slow.setNoDelay(true);

    fast.on('data', (c) => fastV.feed(c));
    slow.on('data', (c) => slowV.feed(c));
    fast.on('error', () => {});
    slow.on('error', () => {});

    await new Promise((res) => fast.once('connect', res));
    await new Promise((res) => slow.once('connect', res));

    // Give origin time to start streaming.
    await sleep(400);

    // Slow client stops reading -> server side backpressure for that session only.
    slow.pause();
    const fastAtPause = fastV.received;
    const tPause = Date.now();
    await sleep(PAUSE_MS);
    const fastAfterPause = fastV.received;
    const fastDuringPause = fastAfterPause - fastAtPause;

    // Resume slow and let both streams finish.
    slow.resume();

    const deadline = Date.now() + GLOBAL_TIMEOUT;
    while (Date.now() < deadline && (fastV.received < TARGET_BYTES || slowV.received < TARGET_BYTES)) {
      await sleep(100);
    }

    const fastOk = fastV.received >= TARGET_BYTES;
    const slowOk = slowV.received >= TARGET_BYTES;

    fast.destroy();
    slow.destroy();

    result.checks = {
      fastReceivedBytes: fastV.received,
      slowReceivedBytes: slowV.received,
      fastWords: fastV.words,
      slowWords: slowV.words,
      fastDuringPauseBytes: fastDuringPause,
      pauseDurationMs: Date.now() - tPause,
      fastReachedTarget: fastOk,
      slowReachedTarget: slowOk,
      fastIntegrity: fastV.error,
      slowIntegrity: slowV.error,
      udpEchoOk,
    };
    result.diagnostics.serverTail = store.server.slice(-25);
    result.diagnostics.clientTail = store.client.slice(-15);

    const integrityOk = fastV.error === null && slowV.error === null;
    const isolationOk = fastDuringPause >= FAST_MIN_DURING_PAUSE;
    const valuesOk = fastOk && slowOk;

    if (MODE === 'old') {
      // Sanity: the test must be able to detect the regression (global pause).
      result.expectation = 'old server should FAIL (fast stalls during slow-client pause)';
      result.detectedRegression = !isolationOk;
      result.ok = result.detectedRegression;
    } else {
      result.ok = integrityOk && isolationOk && valuesOk && udpEchoOk;
      result.expectation = 'fixed server should PASS (isolation + integrity + UDP)';
    }
  } catch (e) {
    result.error = e.message;
    result.diagnostics.serverTail = (store.server || []).slice(-30);
    result.diagnostics.clientTail = (store.client || []).slice(-20);
  } finally {
    for (const p of [client, server]) {
      try { p.kill('SIGKILL'); } catch {}
    }
    try { origin.tcp.close(); } catch {}
    try { origin.udp.close(); } catch {}
  }

  console.log(JSON.stringify(result, null, 2));

  if (ASSERT && MODE === 'fixed' && !result.ok) process.exit(1);
  if (ASSERT && MODE === 'old' && !result.detectedRegression) process.exit(1);
})();
