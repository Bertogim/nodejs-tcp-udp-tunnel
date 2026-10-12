// test/privacy.js — IP display privacy + PPs/Bandwidth stats, end to end.
// Verifies that by default the last 2 octets of IPs are masked in logs, that
// --showip reveals full addresses (persisted to ip-settings.json), that a
// restart honors the persisted file, that a live stdin "hideip" switches back,
// and that the stats block reports packets/s and bandwidth while traffic flows.

const { spawn } = require('child_process');
const net = require('net');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = process.argv[2] || path.join(__dirname, '..');
const ASSERT = process.env.ASSERT === '1';

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
    const onData = (d) => { buf += d.toString(); if (pattern.test(buf)) { clearTimeout(timer); child.stdout.off('data', onData); resolve(); } };
    child.stdout.on('data', onData);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const UDP_BURST = (u, port, payload, ms) => new Promise((resolve) => {
  const timer = setInterval(() => u.send(payload, port, '127.0.0.1'), 20);
  setTimeout(() => { clearInterval(timer); resolve(); }, ms);
});

// Boots server + client + echo origins in `tmp`. `args`/`extraEnv` apply to the
// server. Returns handles plus captured stdout buffers.
async function boot(tmp, args, extraEnv, withStdin) {
  const serverPort = await freePort();
  const originTcpPort = await freePort();
  const originUdpPort = await freePort();

  const originTcp = net.createServer((s) => { s.on('error', () => {}); s.on('data', (c) => s.write(c)); });
  const originUdp = dgram.createSocket('udp4');
  originUdp.on('message', (m, r) => originUdp.send(m, r.port, r.address));
  await new Promise((res) => originTcp.listen(originTcpPort, '127.0.0.1', res));
  await new Promise((res) => originUdp.bind(originUdpPort, '127.0.0.1', res));

  const token = fs.readFileSync(path.join(tmp, 'token'), 'utf8').trim();
  fs.writeFileSync(path.join(tmp, 'client.json'), JSON.stringify({
    config: [{
      vps: { socket: `127.0.0.1:${serverPort}`, token },
      tcp: { enabled: true, socket: `127.0.0.1:${originTcpPort}` },
      udp: { enabled: true, socket: `127.0.0.1:${originUdpPort}` },
      http: { enabled: false, socket: `127.0.0.1:${originTcpPort}` },
    }],
  }));

  let serverOut = '';
  const server = spawn(process.execPath, ['server.js', ...args], {
    cwd: tmp,
    env: { ...process.env, SERVER_PORT: String(serverPort), STATS_INTERVAL_MS: '1000', ...(extraEnv || {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => { serverOut += d.toString(); });
  if (withStdin) { try { server.stdin.setEncoding('utf8'); } catch { } }

  let clientOut = '';
  const client = spawn(process.execPath, ['client.js'], { cwd: tmp });
  client.stdout.on('data', (d) => { clientOut += d.toString(); });

  await waitForOutput(server, /TCP listening/, 10000, 'server');
  await waitForOutput(client, /\[\+\] authenticated/, 15000, 'client');

  return { server, client, serverPort, originTcp, originUdp, serverOut: () => serverOut, clientOut: () => clientOut };
}

// Phase A — default mode hides last 2 octets; stats show PPs/Bandwidth.
async function phaseHide(tmp) {
  const h = await boot(tmp, [], {});
  try {
    const result = { ok: false, checks: {} };

    // First stats cadence primes the display; then push UDP so a bursty tick
    // lands with packets counted.
    await waitForOutput(h.server, /\[stats\]/, 10000, 'server-stats-prime');
    await sleep(500);

    const up = await new Promise((resolve) => { const s = dgram.createSocket('udp4'); s.bind(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    const u = dgram.createSocket('udp4');
    const payload = Buffer.from('BURST-' + Date.now());
    let echoes = 0;
    u.on('message', (m) => { if (m.toString() === payload.toString()) echoes++; });
    u.bind(up, '127.0.0.1', () => { UDP_BURST(u, h.serverPort, payload, 2500).then(() => { try { u.close(); } catch {} }); });

    const so = await waitForOutput(h.server, /\[stats\][^\n]*PPs=[1-9]\d*/, 12000, 'server-stats-pps')
      .then(() => h.serverOut())
      .catch(() => h.serverOut());
    await sleep(300);
    const co = h.clientOut();

    result.checks = {
      tcpWorkerMasked: /Worker connected from 127\.0\.xxx\.xxx:\d+/.test(so),
      noRawLoopbackInServer: !/127\.0\.0\.1:/.test(so),
      udpSrcMaskedOnClient: /UDP session 127\.0\.xxx\.xxx:\d+ creating/.test(co),
      noRawSrcKeyOnClient: !/UDP session 127\.0\.0\.1:\d+ creating/.test(co),
      ppsReported: /PPs=\d+/.test(so),
      bandwidthReported: /Bandwidth=/.test(so),
      ppsNonZeroWhileBursting: /PPs=[1-9]\d*/.test(so),
      noSettingsFileByDefault: !fs.existsSync(path.join(tmp, 'ip-settings.json')),
    };
    result.ok = Object.values(result.checks).every(Boolean) && echoes > 0;
    result.echoes = echoes;
    result.lastStats = so.split('\n').filter((l) => l.startsWith('[stats]')).slice(-1)[0];
    return result;
  } finally {
    h.server.kill('SIGKILL'); h.client.kill('SIGKILL');
    try { h.originTcp.close(); } catch {} try { h.originUdp.close(); } catch {}
  }
}

// Phase B — --showip reveals full addresses and persists the choice.
async function phaseShow(tmp) {
  const h = await boot(tmp, ['--showip'], {});
  try {
    const so = h.serverOut();
    const checks = {
      rawWorkerShown: /Worker connected from 127\.0\.0\.1:\d+/.test(so),
      maskedAbsent: !/127\.0\.xxx\.xxx/.test(so),
    };
    let settingsOk = false;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(tmp, 'ip-settings.json'), 'utf8'));
      settingsOk = parsed.ipMode === 'show';
    } catch { }
    checks.settingsPersisted = settingsOk;
    return { ok: Object.values(checks).every(Boolean), checks };
  } finally {
    h.server.kill('SIGKILL'); h.client.kill('SIGKILL');
    try { h.originTcp.close(); } catch {} try { h.originUdp.close(); } catch {}
  }
}

// Phase C — a restart with no flag honors the persisted "show" choice.
async function phasePersisted(tmp) {
  const h = await boot(tmp, [], {});
  try {
    const ok = /Worker connected from 127\.0\.0\.1:\d+/.test(h.serverOut());
    return { ok, checks: { persistedShowHonored: ok } };
  } finally {
    h.server.kill('SIGKILL'); h.client.kill('SIGKILL');
    try { h.originTcp.close(); } catch {} try { h.originUdp.close(); } catch {}
  }
}

// Phase D — live stdin "hideip" switches back and updates the file.
async function phaseStdinHide(tmp) {
  const h = await boot(tmp, [], {}, true);
  // A long-lived public TCP connection so the stats "Connected" list has an IP
  // to mask after the toggle.
  const keep = net.connect({ host: '127.0.0.1', port: h.serverPort });
  keep.on('error', () => {});
  try {
    h.server.stdin.write('hideip\n');
    await waitForOutput(h.server, /hideip \(last 2 octets masked in logs\)/, 5000, 'hideip-toggle');
    await sleep(200);
    const checks = {};
    try {
      checks.fileNowHide = JSON.parse(fs.readFileSync(path.join(tmp, 'ip-settings.json'), 'utf8')).ipMode === 'hide';
    } catch { checks.fileNowHide = false; }
    // After the toggle, a stats cadence must print masked IPs again.
    await waitForOutput(h.server, /\[stats\][^\n]*127\.0\.xxx\.xxx/, 15000, 'stats-masked-after-toggle');
    checks.maskedAgain = true;
    return { ok: checks.fileNowHide && checks.maskedAgain, checks };
  } finally {
    try { keep.destroy(); } catch {}
    h.server.kill('SIGKILL'); h.client.kill('SIGKILL');
    try { h.originTcp.close(); } catch {} try { h.originUdp.close(); } catch {}
  }
}

(async () => {
  const results = {};
  let allOk = true;
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-privA-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-privB-'));
  for (const [dir, f] of [[dirA, 'a'], [dirB, 'b']]) {
    for (const name of ['server.js', 'client.js']) fs.copyFileSync(path.join(REPO, name), path.join(dir, name));
    fs.writeFileSync(path.join(dir, 'token'), 'tok_' + f.repeat(40), { mode: 0o600 });
  }

  try {
    results.hide = await phaseHide(dirA);
    results.show = await phaseShow(dirB);
    results.persisted = await phasePersisted(dirB);
    results.stdinHide = await phaseStdinHide(dirB);
    for (const [k, r] of Object.entries(results)) { if (r.ok !== true) allOk = false; }
  } catch (e) {
    allOk = false;
    results.error = e.message;
  }

  const out = { ok: allOk, checks: results };
  console.log(JSON.stringify(out, null, 2));
  if (ASSERT && !allOk) process.exit(1);
})();