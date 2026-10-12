// test/blacklist.js — IP/CIDR blacklist end to end.
// Connects from several loopback source IPs. Blacklisted sources (single IP and
// CIDR) must be dropped at accept time on TCP, and their UDP datagrams must be
// ignored, while non-blacklisted sources keep working.

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

// Open a TCP connection from a given loopback source. Returns:
//  - 'rejected' if the server dropped it right after accept (blacklisted)
//  - 'open' if it was accepted and stayed up past the grace window
function tcpFrom(sourceIp, port, timeoutMs, graceMs = 400) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port, localAddress: sourceIp });
    let connectedAt = null;
    s.on('connect', () => { connectedAt = Date.now(); s.write('x'); });
    s.on('close', () => {
      try { s.destroy(); } catch {}
      resolve(connectedAt === null ? 'rejected' : (Date.now() - connectedAt < graceMs ? 'rejected' : 'open'));
    });
    s.on('error', () => {});
    setTimeout(() => {
      try { s.destroy(); } catch {}
      resolve(connectedAt === null ? 'rejected' : 'open');
    }, timeoutMs);
  });
}

// UDP echo probe from a given loopback source. Resolves true only if the server
// forwarded the datagram back (i.e. the source is not blacklisted).
function udpEcho(serverPort, fromIp) {
  return new Promise((resolve) => {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const payload = Buffer.from(`BL-${Date.now()}-${fromIp}`);
    s.bind(0, fromIp);
    s.on('message', (m) => { s.close(); resolve(m.equals(payload)); });
    s.send(payload, serverPort, '127.0.0.1', () => {});
    setTimeout(() => { try { s.close(); } catch {} resolve(false); }, 3000);
  });
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-bl-'));
  fs.copyFileSync(path.join(REPO, 'server.js'), path.join(tmp, 'server.js'));
  const token = 'tok_' + 'b'.repeat(40);
  fs.writeFileSync(path.join(tmp, 'token'), token, { mode: 0o600 });

  // Block 127.0.0.3 exactly and the /29 covering .96..103 (includes .99).
  fs.writeFileSync(path.join(tmp, 'blacklist.txt'), [
    '# test blacklist',
    '127.0.0.3',
    '127.0.0.96/29',
    '',
    'not_an_ip', // must be ignored, not crash
  ].join('\n'));

  const serverPort = await freePort();
  const originTcpPort = await freePort();
  const originUdpPort = await freePort();

  const originTcp = net.createServer((s) => { s.on('error', () => {}); s.on('data', (c) => s.write(c)); });
  const originUdp = dgram.createSocket('udp4');
  originUdp.on('message', (m, r) => originUdp.send(m, r.port, r.address));
  await new Promise((res) => originTcp.listen(originTcpPort, '127.0.0.1', res));
  await new Promise((res) => originUdp.bind(originUdpPort, '127.0.0.1', res));

  fs.copyFileSync(path.join(REPO, 'client.js'), path.join(tmp, 'client.js'));
  fs.writeFileSync(path.join(tmp, 'client.json'), JSON.stringify({
    config: [{
      vps: { socket: `127.0.0.1:${serverPort}`, token },
      tcp: { enabled: true, socket: `127.0.0.1:${originTcpPort}` },
      udp: { enabled: true, socket: `127.0.0.1:${originUdpPort}` },
      http: { enabled: false, socket: `127.0.0.1:${originTcpPort}` },
    }],
  }));

  const result = { ok: false, checks: {} };
  let serverOutput = '';
  const server = spawn(process.execPath, ['server.js', `--blacklist=${path.join(tmp, 'blacklist.txt')}`], {
    cwd: tmp,
    env: { ...process.env, SERVER_PORT: String(serverPort), CONN_RATE_LIMIT_PER_IP: '1000000' },
  });
  server.stdout.on('data', (d) => { serverOutput += d.toString(); });

  const client = spawn(process.execPath, ['client.js'], { cwd: tmp });

  try {
    await waitForOutput(server, /TCP listening/, 10000, 'server');
    await waitForOutput(client, /\[\+\] authenticated/, 15000, 'client');
    await sleep(400);

    const allowedTcp = await tcpFrom('127.0.0.2', serverPort, 1500);
    const blockedSigle = await tcpFrom('127.0.0.3', serverPort, 1500);
    const blockedCidr = await tcpFrom('127.0.0.99', serverPort, 1500);

    const udpAllowed = await udpEcho(serverPort, '127.0.0.2');
    const udpBlocked = await udpEcho(serverPort, '127.0.0.99');

    const blockedTcpOk = blockedSigle === 'rejected' && blockedCidr === 'rejected';
    const allowedTcpOk = allowedTcp === 'open';
    result.checks = { allowedTcp, blockedSigle, blockedCidr, udpAllowed, udpBlocked, blockedTcpOk, allowedTcpOk };
    result.ok = blockedTcpOk && allowedTcpOk && udpAllowed && !udpBlocked;

    // Sanity: the server parsed the blacklist file (entries count logged).
    result.entriesLogged = /IP blacklist active: 2 entr/.test(serverOutput);
    result.ok = result.ok && result.entriesLogged;
  } catch (e) {
    result.error = e.message;
  } finally {
    for (const p of [client, server]) { try { p.kill('SIGKILL'); } catch {} }
    try { originTcp.close(); } catch {}
    try { originUdp.close(); } catch {}
  }

  console.log(JSON.stringify(result, null, 2));
  if (ASSERT && !result.ok) process.exit(1);
})();