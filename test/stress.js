const { spawn, execSync } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = process.argv[2] || path.join(__dirname, '..');
const N_READERS = parseInt(process.env.N_READERS || '8', 10);
const DURATION_MS = parseInt(process.env.DURATION_MS || '8000', 10);
const PROF = process.env.PROF === '1';
const CLK_TCK = 100;

function cpuSeconds(pid) {
  try {
    const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = st.lastIndexOf(')');
    const fields = st.slice(close + 2).split(' ');
    return (parseInt(fields[11], 10) + parseInt(fields[12], 10)) / CLK_TCK;
  } catch { return null; }
}

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-stress-'));
  fs.copyFileSync(path.join(REPO, 'server.js'), path.join(tmp, 'server.js'));
  fs.copyFileSync(path.join(REPO, 'client.js'), path.join(tmp, 'client.js'));
  const token = 'tok_' + 'b'.repeat(40);
  fs.writeFileSync(path.join(tmp, 'token'), token, { mode: 0o600 });

  const serverPort = await freePort();
  const originPort = await freePort();
  fs.writeFileSync(path.join(tmp, 'client.json'), JSON.stringify({
    config: [{ vps: { socket: `127.0.0.1:${serverPort}`, token }, tcp: { enabled: true, socket: `127.0.0.1:${originPort}` }, udp: { enabled: true, socket: `127.0.0.1:${originPort}` }, http: { enabled: false, socket: `127.0.0.1:${originPort}` } }],
  }));

  const origin = await startOrigin(originPort);
  const serverArgs = PROF ? ['--prof', 'server.js'] : ['server.js'];
  const server = spawn(process.execPath, serverArgs, { cwd: tmp, env: { ...process.env, SERVER_PORT: String(serverPort) } });
  const client = spawn(process.execPath, ['client.js'], { cwd: tmp });

  try {
    await waitForOutput(server, /TCP listening/, 10000, 'server');
    await waitForOutput(client, /\[\+\] authenticated/, 10000, 'client');
    await sleep(300);

    const readers = [];
    let total = 0;
    for (let i = 0; i < N_READERS; i++) {
      const s = net.connect(serverPort, '127.0.0.1');
      s.setNoDelay(true);
      s.on('data', (c) => { total += c.length; });
      s.on('error', () => {});
      readers.push(s);
    }

    const before = process.hrtime.bigint();
    const cpuBefore = { server: cpuSeconds(server.pid), client: cpuSeconds(client.pid), self: process.cpuUsage() };
    await sleep(DURATION_MS);
    const elapsed = Number(process.hrtime.bigint() - before) / 1e9;
    const cpuAfter = { server: cpuSeconds(server.pid), client: cpuSeconds(client.pid), self: process.cpuUsage() };

    for (const r of readers) r.destroy();
    const pct = (beforeS, afterS) => beforeS !== null && afterS !== null ? (100 * (afterS - beforeS) / elapsed) : null;
    const selfBefore = cpuBefore.self.user + cpuBefore.self.system;
    const selfAfter = cpuAfter.self.user + cpuAfter.self.system;
    const sPct = pct(cpuBefore.server, cpuAfter.server);
    const cPct = pct(cpuBefore.client, cpuAfter.client);
    const oPct = 100 * (selfAfter - selfBefore) / 1e6 / elapsed;
    console.log(`readers=${N_READERS} received=${(total / 1048576).toFixed(1)}MB in ${elapsed.toFixed(1)}s => ${(total / 1048576 / elapsed).toFixed(1)} MB/s | CPU% server=${sPct.toFixed(1)} worker=${cPct.toFixed(1)} origin=${oPct.toFixed(1)}`);
  } finally {
    for (const p of [client, server]) { try { p.kill('SIGKILL'); } catch {} }
    try { origin.close(); } catch {}
  }

  if (!PROF) return;
  await sleep(500);
  const log = fs.readdirSync(tmp).find((f) => f.endsWith('-v8.log'));
  if (!log) { console.log('no v8 log found'); return; }
  console.log(`\n=== profile: ${log} ===`);
  const out = execSync(`${process.execPath} --prof-process ${JSON.stringify(path.join(tmp, log))}`).toString();
  console.log(out);
})();
