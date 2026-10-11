const { spawn, execSync } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = process.argv[2] || path.join(__dirname, '..');
const N = parseInt(process.env.N || '50', 10);
const DURATION_MS = parseInt(process.env.DURATION_MS || '9000', 10);
const SAMPLE_MS = 250;
const UP = process.env.UP === '1';
const MAX_RSS_MB = parseInt(process.env.MAX_RSS_MB || '0', 10);
const ASSERT = process.env.ASSERT === '1';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function startOrigin(port) {
  const server = net.createServer((sock) => {
    sock.setNoDelay(true);
    let w = 0;
    sock.on('error', () => {});
    if (UP) { sock.pause(); return; } // slow local consumer
    function pump() {
      while (true) {
        const words = 16384;
        const buf = Buffer.allocUnsafe(words * 4);
        for (let i = 0; i < words; i++) buf.writeUInt32LE(w++, i * 4);
        if (!sock.write(buf)) return;
      }
    }
    sock.on('drain', pump);
    pump();
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function rssKb(pid) {
  try {
    const st = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = st.match(/VmRSS:\s+(\d+)\s+kB/);
    return m ? parseInt(m[1], 10) : null;
  } catch { return null; }
}

function waitForOutput(child, pattern, timeoutMs, tag) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`timeout ${pattern} in ${tag}`)), timeoutMs);
    const onData = (d) => { buf += d.toString(); if (pattern.test(buf)) { clearTimeout(timer); child.stdout.off('data', onData); resolve(); } };
    child.stdout.on('data', onData);
    child.on('exit', (code) => { if (code) { clearTimeout(timer); reject(new Error(`${tag} exited ${code}`)); } });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-mem-'));
  const serverSrc = process.env.OLD === '1' ? execSync('git show HEAD:server.js', { cwd: REPO }).toString() : fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
  fs.writeFileSync(path.join(tmp, 'server.js'), serverSrc);
  fs.copyFileSync(path.join(REPO, 'client.js'), path.join(tmp, 'client.js'));
  const token = 'tok_' + 'c'.repeat(40);
  fs.writeFileSync(path.join(tmp, 'token'), token, { mode: 0o600 });

  const serverPort = await freePort();
  const originPort = await freePort();
  fs.writeFileSync(path.join(tmp, 'client.json'), JSON.stringify({
    config: [{ vps: { socket: `127.0.0.1:${serverPort}`, token }, tcp: { enabled: true, socket: `127.0.0.1:${originPort}` }, udp: { enabled: true, socket: `127.0.0.1:${originPort}` }, http: { enabled: false, socket: `127.0.0.1:${originPort}` } }],
  }));

  const origin = await startOrigin(originPort);
  const server = spawn(process.execPath, ['server.js'], { cwd: tmp, env: { ...process.env, SERVER_PORT: String(serverPort), CONN_RATE_LIMIT_PER_IP: '1000000' } });
  const client = spawn(process.execPath, ['client.js'], { cwd: tmp });

  const result = { N, samples: [] };
  try {
    await waitForOutput(server, /TCP listening/, 10000, 'server');
    await waitForOutput(client, /\[\+\] authenticated/, 10000, 'client');
    await sleep(300);

    const idleRss = rssKb(server.pid);
    const socks = [];
    for (let i = 0; i < N; i++) {
      const s = net.connect(serverPort, '127.0.0.1');
      s.setNoDelay(true);
      s.on('error', () => {});
      if (UP) {
        const buf = Buffer.alloc(64 * 1024);
        const push = () => { if (s.write(buf)) setImmediate(push); };
        s.on('drain', push);
        push();
      } else {
        s.pause(); // never read -> backpressure
      }
      socks.push(s);
    }

    const start = Date.now();
    while (Date.now() - start < DURATION_MS) {
      await sleep(SAMPLE_MS);
      result.samples.push(rssKb(server.pid));
    }

    for (const s of socks) s.destroy();
    result.idleRssKb = idleRss;
    result.peakRssKb = Math.max(...result.samples.filter(Boolean));
    result.finalRssKb = result.samples[result.samples.length - 1];
    result.peakRssMB = (result.peakRssKb / 1024).toFixed(1);
    result.idleRssMB = (idleRss / 1024).toFixed(1);
    delete result.samples;
  } catch (e) {
    result.error = e.message;
  } finally {
    for (const p of [client, server]) { try { p.kill('SIGKILL'); } catch {} }
    try { origin.close(); } catch {}
  }

  console.log(JSON.stringify(result));

  if (result.error) process.exit(1);
  if (ASSERT && MAX_RSS_MB && result.peakRssMB && parseFloat(result.peakRssMB) > MAX_RSS_MB) {
    console.error(`memory assertion failed: peak ${result.peakRssMB}MB > MAX_RSS_MB ${MAX_RSS_MB}`);
    process.exit(1);
  }
})();
