// test/tls.js — TLS-PSK control channel end-to-end.
// Verifies that with the server running under --tls the worker can only connect
// through TLS: the plaintext handshake is rejected and a wrong token cannot
// complete the handshake, while TCP and UDP traffic still work normally.

const { spawn } = require('child_process');
const net = require('net');
const tls = require('tls');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const REPO = process.argv[2] || path.join(__dirname, '..');
const ASSERT = process.env.ASSERT === '1';

const TLS_MAGIC = Buffer.from('TUNS');
const TLS_IDENTITY = 'TUN1';
const TLS_CIPHERS = 'PSK-AES256-GCM-SHA384:PSK-AES128-GCM-SHA256:PSK-CHACHA20-POLY1305';

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
    const timer = setTimeout(() => reject(new Error(`timeout ${pattern} in ${tag}\n${buf.slice(-1500)}`)), timeoutMs);
    const onData = (d) => { buf += d.toString(); if (pattern.test(buf)) { clearTimeout(timer); child.stdout.off('data', onData); resolve(); } };
    child.stdout.on('data', onData);
    child.on('exit', (code) => { if (code !== null && code !== 0) { clearTimeout(timer); reject(new Error(`${tag} exited ${code}`)); } });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Raw TLS-PSK client that presents the marker first, like the real worker.
function tlsConnect(port, token, timeoutMs) {
  return new Promise((resolve) => {
    const psk = crypto.createHash('sha256').update(token).digest();
    const raw = net.connect(port, '127.0.0.1', () => {
      raw.write(TLS_MAGIC);
      const t = tls.connect({
        socket: raw,
        ciphers: TLS_CIPHERS,
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.2',
        pskCallback: () => ({ psk, identity: TLS_IDENTITY }),
        rejectUnauthorized: false,
      }, () => resolve({ ok: true, sock: t }));
      t.on('error', () => resolve({ ok: false }));
      t.on('close', () => resolve({ ok: false }));
    });
    raw.on('error', () => resolve({ ok: false }));
    setTimeout(() => resolve({ ok: false }), timeoutMs);
  });
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-tls-'));
  fs.copyFileSync(path.join(REPO, 'server.js'), path.join(tmp, 'server.js'));
  fs.copyFileSync(path.join(REPO, 'client.js'), path.join(tmp, 'client.js'));
  const token = 'tls_test_' + 'a'.repeat(50);
  fs.writeFileSync(path.join(tmp, 'token'), token, { mode: 0o600 });

  const serverPort = await freePort();
  const originTcpPort = await freePort();
  const originUdpPort = await freePort();

  fs.writeFileSync(path.join(tmp, 'client.json'), JSON.stringify({
    config: [{
      vps: { socket: `127.0.0.1:${serverPort}`, token },
      tcp: { enabled: true, socket: `127.0.0.1:${originTcpPort}` },
      udp: { enabled: true, socket: `127.0.0.1:${originUdpPort}` },
      http: { enabled: false, socket: `127.0.0.1:${originTcpPort}` },
      tls: { enabled: true },
    }],
  }, null, 2));

  const originTcp = net.createServer((s) => { s.on('error', () => {}); s.on('data', (c) => s.write(c)); });
  const originUdp = dgram.createSocket('udp4');
  originUdp.on('message', (m, r) => originUdp.send(m, r.port, r.address));
  await new Promise((res) => originTcp.listen(originTcpPort, '127.0.0.1', res));
  await new Promise((res) => originUdp.bind(originUdpPort, '127.0.0.1', res));

  let serverOut = '';
  const server = spawn(process.execPath, ['server.js', '--tls'], {
    cwd: tmp, env: { ...process.env, SERVER_PORT: String(serverPort) },
  });
  server.stdout.on('data', (d) => { serverOut += d.toString(); });

  const client = spawn(process.execPath, ['client.js'], { cwd: tmp });

  const result = { ok: false, checks: {} };
  try {
    await waitForOutput(server, /TCP listening/, 10000, 'server');
    await waitForOutput(client, /\[\+\] authenticated/, 15000, 'client');
    await sleep(400);

    // TCP round-trip through the encrypted control channel
    const tcpOk = await new Promise((resolve) => {
      const s = net.connect(serverPort, '127.0.0.1', () => s.write('TLS-HELLO'));
      s.on('data', (d) => { s.destroy(); resolve(d.toString() === 'TLS-HELLO'); });
      s.on('error', () => resolve(false));
      setTimeout(() => resolve(false), 5000);
    });

    // UDP round-trip through the tunnel (UDP itself is not TLS-encrypted)
    const udpOk = await new Promise((resolve) => {
      const s = dgram.createSocket('udp4');
      const payload = Buffer.from('UDPLESSTLS');
      s.on('message', (m) => { s.close(); resolve(m.equals(payload)); });
      s.send(payload, serverPort, '127.0.0.1');
      setTimeout(() => { try { s.close(); } catch {} resolve(false); }, 5000);
    });

    // A plaintext AUTH_HELLO while TLS is required must be dropped (downgrade
    // protection), not routed to the local service and not accepted as worker.
    const plainRejected = await new Promise((resolve) => {
      const payload = Buffer.from(`TUN1 ${token}`);
      const f = Buffer.allocUnsafe(13 + payload.length);
      f.writeUInt32BE(13 + payload.length, 0);
      f.writeUInt8(0x10, 4);
      f.writeUInt32BE(0, 5);
      f.writeUInt32BE(payload.length, 9);
      payload.copy(f, 13);
      const s = net.connect(serverPort, '127.0.0.1', () => s.write(f));
      let closed = false;
      s.on('close', () => { closed = true; resolve(true); });
      s.on('error', () => {});
      s.on('data', () => {});
      setTimeout(() => { try { s.destroy(); } catch {} resolve(closed); }, 3000);
    });

    // A TLS client with the wrong token cannot complete the handshake.
    const wrongTokenHandshake = await tlsConnect(serverPort, token + 'WRONG', 3000);
    const wrongTokenRejected = !wrongTokenHandshake.ok;

    // A TLS client with the correct token connects (confirms the handshake path).
    const goodHandshake = await tlsConnect(serverPort, token, 3000);
    if (goodHandshake.ok) try { goodHandshake.sock.destroy(); } catch {}

    result.checks = { tcpOk, udpOk, plainRejected, wrongTokenRejected, goodTokenOk: goodHandshake.ok };
    result.serverSaysTlsEnabled = serverOut.includes('Control TLS: ENABLED');
    result.ok = tcpOk && udpOk && plainRejected && wrongTokenRejected && goodHandshake.ok && result.serverSaysTlsEnabled;
  } catch (e) {
    result.error = e.message;
    result.serverTail = serverOut.slice(-1500);
  } finally {
    for (const p of [client, server]) { try { p.kill('SIGKILL'); } catch {} }
    try { originTcp.close(); } catch {}
    try { originUdp.close(); } catch {}
  }

  console.log(JSON.stringify(result, null, 2));
  if (ASSERT && !result.ok) process.exit(1);
})();