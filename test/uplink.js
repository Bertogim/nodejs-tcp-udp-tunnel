const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = process.argv[2] || path.join(__dirname, '..');
const TOTAL = parseInt(process.env.TOTAL || String(8 * 1024 * 1024), 10);
const CLIENTS = parseInt(process.env.CLIENTS || '4', 10);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function startEcho(port) {
  const server = net.createServer((sock) => {
    sock.setNoDelay(true);
    sock.on('error', () => {});
    sock.on('data', (c) => sock.write(c));
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
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

function makePayload(size) {
  const buf = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i += 4) buf.writeUInt32LE((i / 4) >>> 0, i);
  return buf;
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-up-'));
  fs.copyFileSync(path.join(REPO, 'server.js'), path.join(tmp, 'server.js'));
  fs.copyFileSync(path.join(REPO, 'client.js'), path.join(tmp, 'client.js'));
  const token = 'tok_' + 'd'.repeat(40);
  fs.writeFileSync(path.join(tmp, 'token'), token, { mode: 0o600 });

  const serverPort = await freePort();
  const originPort = await freePort();
  fs.writeFileSync(path.join(tmp, 'client.json'), JSON.stringify({
    config: [{ vps: { socket: `127.0.0.1:${serverPort}`, token }, tcp: { enabled: true, socket: `127.0.0.1:${originPort}` }, udp: { enabled: true, socket: `127.0.0.1:${originPort}` }, http: { enabled: false, socket: `127.0.0.1:${originPort}` } }],
  }));

  const origin = await startEcho(originPort);
  const server = spawn(process.execPath, ['server.js'], { cwd: tmp, env: { ...process.env, SERVER_PORT: String(serverPort) } });
  const client = spawn(process.execPath, ['client.js'], { cwd: tmp });

  const result = { ok: false, clients: [] };
  try {
    await waitForOutput(server, /TCP listening/, 10000, 'server');
    await waitForOutput(client, /\[\+\] authenticated/, 10000, 'client');
    await sleep(300);

    const payload = makePayload(TOTAL);

    async function runOne(idx) {
      return new Promise((resolve) => {
        const sock = net.connect(serverPort, '127.0.0.1');
        sock.setNoDelay(true);
        let offset = 0;
        let recv = 0;
        let mismatch = false;
        const expected = payload;

        sock.on('error', () => {});
        const pump = () => {
          while (offset < expected.length) {
            const end = Math.min(offset + 65536, expected.length);
            const chunk = expected.subarray(offset, end);
            offset = end;
            if (!sock.write(chunk)) return;
          }
        };
        sock.on('connect', pump);
        sock.on('drain', pump);
        sock.on('data', (c) => {
          if (recv + c.length <= expected.length) {
            if (!c.equals(expected.subarray(recv, recv + c.length))) mismatch = true;
          } else mismatch = true;
          recv += c.length;
          if (recv >= expected.length) {
            sock.destroy();
            resolve({ idx, recv, mismatch });
          }
        });
      });
    }

    const runs = await Promise.all(Array.from({ length: CLIENTS }, (_, i) => runOne(i)));
    result.clients = runs;
    result.ok = runs.every((r) => r.recv === TOTAL && !r.mismatch);
  } catch (e) {
    result.error = e.message;
  } finally {
    for (const p of [client, server]) { try { p.kill('SIGKILL'); } catch {} }
    try { origin.close(); } catch {}
  }

  console.log(JSON.stringify(result));
  if (process.env.ASSERT === '1' && !result.ok) process.exit(1);
})();
