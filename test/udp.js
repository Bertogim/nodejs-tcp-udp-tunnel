const { spawn, execSync } = require('child_process');
const net = require('net');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = process.argv[2] || path.join(__dirname, '..');
const ASSERT = process.env.ASSERT === '1';
const PACKETS = parseInt(process.env.PACKETS || '500', 10);
const PACE_MS = parseFloat(process.env.PACE_MS || '5');
const PACE_EVERY = parseInt(process.env.PACE_EVERY || '5', 10);
const OLD = process.env.OLD === '1';
const BASELINE_REF = process.env.BASELINE_REF || 'v1.0.0';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function freeUdpPort() {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.on('error', reject);
    s.bind(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function startOrigin(tcpPort, udpPort) {
  const tcp = net.createServer((sock) => { sock.on('error', () => {}); });
  const udp = dgram.createSocket('udp4');
  udp.on('message', (msg, rinfo) => udp.send(msg, rinfo.port, rinfo.address));
  return new Promise((resolve, reject) => {
    tcp.on('error', reject);
    udp.on('error', reject);
    tcp.listen(tcpPort, '127.0.0.1', () => udp.bind(udpPort, '127.0.0.1', () => resolve({ tcp, udp })));
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-udp-'));
  const serverSrc = OLD
    ? execSync(`git show ${BASELINE_REF}:server.js`, { cwd: REPO }).toString()
    : fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
  fs.writeFileSync(path.join(tmp, 'server.js'), serverSrc);
  fs.copyFileSync(path.join(REPO, 'client.js'), path.join(tmp, 'client.js'));
  const token = 'tok_' + 'e'.repeat(60);
  fs.writeFileSync(path.join(tmp, 'token'), token, { mode: 0o600 });

  const serverPort = await freePort();
  const originTcp = await freePort();
  const originUdp = await freeUdpPort();
  fs.writeFileSync(path.join(tmp, 'client.json'), JSON.stringify({
    config: [{ vps: { socket: `127.0.0.1:${serverPort}`, token }, tcp: { enabled: true, socket: `127.0.0.1:${originTcp}` }, udp: { enabled: true, socket: `127.0.0.1:${originUdp}` }, http: { enabled: false, socket: `127.0.0.1:${originTcp}` } }],
  }));

  const result = { packets: PACKETS, received: 0, ok: false };
  const origin = await startOrigin(originTcp, originUdp);
  const server = spawn(process.execPath, ['server.js'], { cwd: tmp, env: { ...process.env, SERVER_PORT: String(serverPort) } });
  const client = spawn(process.execPath, ['client.js'], { cwd: tmp });

  try {
    await waitForOutput(server, /TCP listening/, 10000, 'server');
    await waitForOutput(client, /\[\+\] authenticated/, 10000, 'client');
    await sleep(500);

    const sock = dgram.createSocket('udp4');
    const seen = new Set();
    sock.on('message', (msg) => {
      if (msg.length >= 4) seen.add(msg.readUInt32LE(0));
    });

    // Steady UDP flow from a single endpoint, like a game client (~1000 pps by
    // default). This rate is far above the removed 50/s per-packet limit, so the
    // test would fail if steady-state traffic were throttled again.
    for (let i = 0; i < PACKETS; i++) {
      const buf = Buffer.allocUnsafe(4);
      buf.writeUInt32LE(i, 0);
      sock.send(buf, serverPort, '127.0.0.1');
      if (PACE_MS > 0 && i % PACE_EVERY === PACE_EVERY - 1) await sleep(PACE_MS);
    }

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && seen.size < PACKETS) await sleep(50);
    result.received = seen.size;
    try { sock.close(); } catch {}

    // UDP can be lossy under instantaneous microbursts (kernel buffer), but a
    // steady one-endpoint flow must NOT be rate-limited.
    result.ok = result.received >= Math.floor(PACKETS * 0.95);
  } catch (e) {
    result.error = e.message;
  } finally {
    for (const p of [client, server]) { try { p.kill('SIGKILL'); } catch {} }
    try { origin.tcp.close(); } catch {}
    try { origin.udp.close(); } catch {}
  }

  console.log(JSON.stringify(result));
  if (ASSERT && !result.ok) process.exit(1);
})();
