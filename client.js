// client.js

// By Bertogim
// v1.4.0

const net = require("net");
const dgram = require("dgram");
const tls = require("tls");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const crypto = require("crypto");

const VERSION = "1.4.0";

// TLS-PSK on the worker control channel (no certificates required). The key is
// derived from the same token the server uses, so it must match on both ends.
const TLS_MAGIC = Buffer.from("TUNS");
const TLS_IDENTITY = "TUN1";
const TLS_CIPHERS = "PSK-AES256-GCM-SHA384:PSK-AES128-GCM-SHA256:PSK-CHACHA20-POLY1305";

// --- CLI arguments ---
// Usage: node client.js [config.json] [--tls] [--log-dir <path>] [--no-log]
function parseArgs(argv) {
  const opts = { positional: [], logDir: null, noLog: false, version: false, help: false, tls: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-log" || a === "--no-logs") opts.noLog = true;
    else if (a === "--log-dir") opts.logDir = argv[++i] || null;
    else if (a.startsWith("--log-dir=")) opts.logDir = a.slice("--log-dir=".length);
    else if (a === "--tls") opts.tls = true;
    else if (a === "--no-tls") opts.tls = false;
    else if (a === "--version" || a === "-v") opts.version = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else opts.positional.push(a);
  }
  return opts;
}
const ARGS = parseArgs(process.argv.slice(2));

// --- Logging (optional and configurable) ---
// Disable with --no-log (or NO_LOG=1); change the directory with --log-dir <path> (or LOG_DIR).
const NO_LOG = ARGS.noLog || /^(1|true|yes|on)$/i.test(process.env.NO_LOG || "");
const LOG_DIR = ARGS.logDir || process.env.LOG_DIR || path.join(__dirname, "worker-logs");

const getLogFileName = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}.txt`;
};

let logFilePath = null;
let logStream = null;
let logClosed = false;

const originalLog = console.log;

function ensureLogStream() {
  if (NO_LOG) return;
  if (logStream && !logStream.destroyed) return;
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  logFilePath = path.join(LOG_DIR, getLogFileName());
  logStream = fs.createWriteStream(logFilePath, { flags: "a" });
  logStream.on("error", (err) => {
    originalLog.call(console, `[log-stream-error] ${err.message}`);
  });
}

// --- Pretty console UI (self-contained, no deps, TTY-aware, no flicker) ---
// When stdout is a TTY we pin a small status block at the bottom and print
// event logs above it using cursor movement (never a full console.clear()).
// When it is not a TTY (service / piped to a file) we emit plain, greppable
// lines and only dump stats every 30s so logs stay clean.
const _out = process.stdout;
const _isTTY = _out.isTTY === true;
const _useColor = _isTTY && !process.env.NO_COLOR;
const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  cyan: "\x1b[36m", gray: "\x1b[90m",
};
const paint = (code, s) => (_useColor ? code + s + C.reset : s);

function fmtEvent(msg) {
  if (!_useColor) return msg;
  const time = paint(C.gray, new Date().toTimeString().slice(0, 8));
  let body = msg;
  if (msg.startsWith("[+] ")) body = paint(C.green, "[+]") + " " + msg.slice(4);
  else if (msg.startsWith("[-] ")) body = paint(C.red, "[-]") + " " + msg.slice(4);
  else if (msg.startsWith("[*] ")) body = paint(C.cyan, "[*]") + " " + msg.slice(4);
  return time + " " + body;
}

const ui = (() => {
  let drawn = 0;
  let lastRows = [];
  let lastNonTtyAt = 0;
  const width = () => _out.columns || 100;

  function clear() {
    if (!_isTTY || drawn === 0) return;
    _out.write("\x1b[1A\x1b[2K".repeat(drawn));
    drawn = 0;
  }
  function drawRows(rows) {
    const labelWidth = rows.reduce((m, [k]) => Math.max(m, k.length + 1), 0);
    const lines = rows.map(([k, v]) => {
      let val = String(v);
      const room = Math.max(0, width() - labelWidth - 2);
      if (val.length > room) val = val.slice(0, Math.max(0, room - 1)) + "…";
      const label = paint(C.cyan, k + ":") + " ".repeat(labelWidth - (k.length + 1));
      return label + " " + val;
    });
    _out.write(lines.join("\n") + "\n");
    drawn = lines.length;
  }
  return {
    log(msg) {
      const line = fmtEvent(msg);
      if (!_isTTY) { _out.write(line + "\n"); return; }
      clear();
      _out.write(line + "\n");
      if (lastRows.length) drawRows(lastRows);
    },
    status(rows) {
      lastRows = rows;
      if (_isTTY) { clear(); drawRows(rows); return; }
      const now = Date.now();
      if (now - lastNonTtyAt < 30000) return;
      lastNonTtyAt = now;
      _out.write("[stats] " + rows.map(([k, v]) => `${k}=${v}`).join(" ") + "\n");
    },
    banner(title, subtitle) {
      if (!_isTTY) return;
      const bar = paint(C.cyan, "─".repeat(Math.min(width(), Math.max(24, title.length + 8))));
      _out.write("\n" + bar + "\n");
      _out.write(" " + paint(C.bold, title) + "\n");
      if (subtitle) _out.write(" " + paint(C.gray, subtitle) + "\n");
      _out.write(bar + "\n\n");
    },
    good(v) { return paint(C.green, v); },
    bad(v) { return paint(C.red, v); },
    dim(v) { return paint(C.gray, v); },
  };
})();

console.log = function (...args) {
  const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
  if (!NO_LOG && !logClosed) {
    ensureLogStream();
    logStream.write(`[${new Date().toISOString()}] ${message}\n`);
  }
  ui.log(message);
};

// --- CLI help ---
function printHelp() {
  originalLog.call(console, `nodejs-tcp-udp-tunnel client v${VERSION}

Usage: node client.js [config.json] [options]

Options:
  --tls                Encrypt the worker control connection (server must use --tls)
  --log-dir <path>     Directory for log files (default worker-logs/)
  --no-log             Disable file logging
  -h, --help           Show this help and exit
  -v, --version        Show version and exit

Environment: TLS=1, NO_LOG, LOG_DIR, UDP_SESSION_TIMEOUT_MS, MAX_UDP_SESSIONS.`);
}

// --- Graceful shutdown (Pterodactyl-friendly: SIGTERM/SIGINT or stdin command) ---
const cleanupHooks = [];
let shuttingDown = false;
let exited = false;
function registerCleanup(fn) { cleanupHooks.push(fn); }
function shutdown(reason, code) {
  if (shuttingDown) return;
  shuttingDown = true;
  const finish = () => { if (exited) return; exited = true; process.exit(code || 0); };
  console.log(`[*] Shutting down (${reason})...`);
  logClosed = true;
  for (const hook of cleanupHooks) { try { hook(); } catch { } }
  if (logStream && !logStream.destroyed) {
    try { logStream.end(finish); } catch { finish(); }
    setTimeout(finish, 1500);
  } else {
    finish();
  }
}
process.on("SIGINT", () => shutdown("SIGINT", 0));
process.on("SIGTERM", () => shutdown("SIGTERM", 0));
process.on("SIGHUP", () => shutdown("SIGHUP", 0));
process.on("SIGQUIT", () => shutdown("SIGQUIT", 0));
process.on("uncaughtException", (err) => {
  console.log(`[-] uncaughtException: ${err && err.stack ? err.stack : err}`);
  shutdown("uncaughtException", 1);
});
process.on("unhandledRejection", (err) => {
  console.log(`[-] unhandledRejection: ${err && err.stack ? err.stack : err}`);
  shutdown("unhandledRejection", 1);
});

function StartTunnel(VPS_NAME, TOKEN, VPS_IP, VPS_PORT, LOCAL_TCP_HOST, LOCAL_TCP_PORT, LOCAL_UDP_HOST, LOCAL_UDP_PORT, ENABLE_HTTP_PORT, LOCAL_HTTP_HOST, LOCAL_HTTP_PORT, ENABLE_TLS) {

  const BUFFER_SIZE = 256 * 1024; // 256KB

  // Idle timeout and hard cap for per-source UDP sessions. A live game flow
  // (hundreds of pps) keeps refreshing lastSeen, so it is never evicted; only
  // truly idle endpoints are reclaimed.
  const UDP_SESSION_TIMEOUT_MS = parseInt(process.env.UDP_SESSION_TIMEOUT_MS || "60000", 10);
  const MAX_UDP_SESSIONS = parseInt(process.env.MAX_UDP_SESSIONS || "4096", 10);
  const psk = crypto.createHash("sha256").update(TOKEN).digest();

  const localIntervals = [];
  const every = (fn, ms) => { const id = setInterval(fn, ms); localIntervals.push(id); return id; };

  // Message types
  const MSG_TYPE = {
    TCP_OPEN: 0x01,
    TCP_DATA: 0x02,
    TCP_CLOSE: 0x03,
    UDP_IN: 0x04,
    UDP_OUT: 0x05,
    AUTH_HELLO: 0x10,
    AUTH_OK: 0x11,
    AUTH_FAIL: 0x12,
    HEARTBEAT_PING: 0x20,
    HEARTBEAT_PONG: 0x21,
    TCP_PAUSE: 0x30,
    TCP_RESUME: 0x31,
  };

  const CONTROL_KEEPALIVE_DELAY_MS = 30_000;
  const HEARTBEAT_INTERVAL_MS = 15_000;
  const HEARTBEAT_TIMEOUT_MS = 45_000;
  const UDP_TUNNEL_HELLO_INTERVAL_MS = 10_000;
  const WORKER_UDP_AUTH_PREFIX = "TUN1UDP";

  const tcpSessions = new Map(); // sid -> { socket, ready, pending: Buffer[], port, host, writeBlocked, _drainListenerAttached }
  const udpSessions = new Map(); // srcKey -> { socket, ready, pending }

  let control = null;
  let controlGen = 0;
  let udpControl = null;
  let controlAuthenticated = false;
  let udpControlAuthenticated = false;
  let heartbeatInterval = null;
  let udpHelloInterval = null;
  let lastHeartbeatAt = 0;

  // ---- Backpressure: local -> control ----
  const pausedLocalSockets = new Set();

  function onControlDrain() {
    for (const s of tcpSessions.values()) {
      const sock = s.socket;
      if (sock && !sock.destroyed && pausedLocalSockets.has(sock) && !s.remotePaused) {
        sock.resume();
      }
    }
    pausedLocalSockets.clear();
  }

  // ---- Backpressure: control -> local ----
  let blockedWritesCount = 0;

  function pauseControlIfNeeded() {
    if (control && !control.isPaused()) {
      control.pause();
    }
  }

  function resumeControlIfPossible() {
    if (blockedWritesCount === 0 && control && control.isPaused()) {
      control.resume();
    }
  }

  every(() => {
    const workerTcpStatus = (control && !control.destroyed && controlAuthenticated) ? "YES" : "NO";
    const workerUdpStatus = (udpControl && !udpControl.destroyed && udpControlAuthenticated) ? "YES" : "NO";

    ui.status([
      ["Tunnel", VPS_NAME],
      ["Worker TCP", ui[(workerTcpStatus === "YES") ? "good" : "bad"](workerTcpStatus)],
      ["Worker UDP", ui[(workerUdpStatus === "YES") ? "good" : "bad"](workerUdpStatus)],
      ["TCP sessions", String(tcpSessions.size)],
      ["UDP sessions", String(udpSessions.size)],
    ]);
  }, 1000);

  // Reclaim idle UDP sessions so a long-running worker does not leak one socket
  // per distinct source endpoint. Active flows refresh lastSeen on every packet.
  every(() => {
    const now = Date.now();
    for (const [key, s] of udpSessions) {
      if (now - (s.lastSeen || 0) > UDP_SESSION_TIMEOUT_MS) closeUdpSession(key);
    }
  }, Math.min(Math.max(5000, Math.floor(UDP_SESSION_TIMEOUT_MS / 2)), 30000));

  // ==================== Length-Prefixed Binary Protocol ====================

  function encodeMessage(type, sid, data) {
    const dataLen = data ? data.length : 0;
    const payloadLen = 1 + 4 + 4 + dataLen;
    const totalLen = 4 + payloadLen;

    const buf = Buffer.allocUnsafe(totalLen);
    buf.writeUInt32BE(totalLen, 0);
    buf.writeUInt8(type, 4);
    buf.writeUInt32BE(sid, 5);
    buf.writeUInt32BE(dataLen, 9);

    if (data && dataLen > 0) {
      data.copy(buf, 13);
    }

    return buf;
  }

  function createBinaryParser(onMessage) {
    let buffer = Buffer.allocUnsafe(BUFFER_SIZE);
    let offset = 0;

    return (chunk) => {
      if (offset + chunk.length > buffer.length) {
        const newSize = Math.max(buffer.length * 2, offset + chunk.length);
        const newBuf = Buffer.allocUnsafe(newSize);
        buffer.copy(newBuf, 0, 0, offset);
        buffer = newBuf;
      }
      chunk.copy(buffer, offset);
      offset += chunk.length;

      let pos = 0;
      while (pos + 4 <= offset) {
        const msgLen = buffer.readUInt32BE(pos);

        if (msgLen < 13 || msgLen > 1024 * 1024) {
          pos++;
          continue;
        }

        if (offset - pos < msgLen) break;

        const type = buffer[pos + 4];
        const sid = buffer.readUInt32BE(pos + 5);
        const dataLen = buffer.readUInt32BE(pos + 9);

        const expectedPayloadLen = 1 + 4 + 4 + dataLen;
        const expectedTotalLen = 4 + expectedPayloadLen;

        if (msgLen !== expectedTotalLen) {
          pos++;
          continue;
        }

        const data = dataLen > 0 ? Buffer.from(buffer.slice(pos + 13, pos + 13 + dataLen)) : null;

        try { onMessage({ type, sid, data }); } catch (e) { console.log("[-] error processing message:", e.message); }
        pos += msgLen;
      }

      if (pos > 0) {
        if (pos < offset) {
          buffer.copy(buffer, 0, pos, offset);
        }
        offset -= pos;
      }

      if (offset > 0 && buffer.length > BUFFER_SIZE * 4) {
        const newBuf = Buffer.allocUnsafe(Math.max(BUFFER_SIZE, offset));
        buffer.copy(newBuf, 0, 0, offset);
        buffer = newBuf;
      }
    };
  }

  function decodeSingleMessage(packet) {
    if (!packet || packet.length < 13) return null;

    const msgLen = packet.readUInt32BE(0);
    if (msgLen !== packet.length || msgLen > 1024 * 1024) return null;

    const type = packet.readUInt8(4);
    const sid = packet.readUInt32BE(5);
    const dataLen = packet.readUInt32BE(9);
    const expectedTotalLen = 13 + dataLen;

    if (msgLen !== expectedTotalLen) return null;

    return {
      type,
      sid,
      data: dataLen > 0 ? packet.subarray(13, 13 + dataLen) : null,
    };
  }

  function sendMessage(type, sid, data) {
    if (!control || control.destroyed) return true; // without control, no restriction
    const msg = encodeMessage(type, sid, data);
    return control.write(msg);
  }

  function sendUdpTunnelMessage(type, sid, data) {
    if (!udpControl) return false;

    const packet = encodeMessage(type, sid, data);
    udpControl.send(packet, (err) => {
      if (err) {
        console.log(`[-] udp tunnel send error: ${err.message}`);
      }
    });
    return true;
  }

  function stopHeartbeat() {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  }

  function stopUdpHello() {
    if (udpHelloInterval) {
      clearInterval(udpHelloInterval);
      udpHelloInterval = null;
    }
  }

  function sendUdpHello() {
    sendUdpTunnelMessage(MSG_TYPE.AUTH_HELLO, 0, Buffer.from(`${WORKER_UDP_AUTH_PREFIX} ${TOKEN}`));
  }

  function startUdpHello() {
    stopUdpHello();
    sendUdpHello();
    udpHelloInterval = setInterval(() => {
      sendUdpHello();
    }, UDP_TUNNEL_HELLO_INTERVAL_MS);
  }

  function startHeartbeat() {
    stopHeartbeat();
    lastHeartbeatAt = Date.now();

    heartbeatInterval = setInterval(() => {
      if (!control || control.destroyed || !controlAuthenticated) return;

      const now = Date.now();
      if (now - lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS) {
        console.log("[-] heartbeat timeout, reconnecting control tunnel");
        try { control.destroy(); } catch { }
        return;
      }

      sendMessage(MSG_TYPE.HEARTBEAT_PING, 0, null);
    }, HEARTBEAT_INTERVAL_MS);
  }

  function closeAllSessions() {
    for (const [, s] of tcpSessions) {
      try { s.socket.destroy(); } catch { }
      s.pending = []; // free queues
    }
    tcpSessions.clear();
    pausedLocalSockets.clear();
    blockedWritesCount = 0;
    resumeControlIfPossible();

    for (const [, s] of udpSessions) {
      try { s.socket.close(); } catch { }
      s.pending = [];
    }
    udpSessions.clear();
  }

  // Helper to establish local connection (TCP or HTTP)
  function connectLocal(sid, s) {
    // If already have a socket, do nothing
    if (s.socket) return;

    const sock = net.connect({ port: s.port, host: s.host, highWaterMark: BUFFER_SIZE });
    sock.setNoDelay(true);
    s.socket = sock;
    s._reconnecting = false;

    sock.on("connect", () => {
      s.ready = true;
      if (s.remotePaused) sock.pause();
      console.log(`[*] local TCP session ${sid} connected to ${s.host}:${s.port}`);
      for (const chunk of s.pending) sock.write(chunk);
      s.pending = [];
    });

    sock.on("data", (chunk) => {
      const ok = sendMessage(MSG_TYPE.TCP_DATA, sid, chunk);
      if (!ok && !pausedLocalSockets.has(sock)) {
        sock.pause();
        pausedLocalSockets.add(sock);
      }
    });

    sock.on("close", () => {
      if (!s._reconnecting) {
        console.log(`[-] local TCP session ${sid} closed`);
        sendMessage(MSG_TYPE.TCP_CLOSE, sid, null);
        pausedLocalSockets.delete(sock);
        if (s.writeBlocked) {
          s.writeBlocked = false;
          blockedWritesCount--;
          resumeControlIfPossible();
        }
        // Clear pending to free memory
        s.pending = [];
        tcpSessions.delete(String(sid));
      } else {
        s.socket = null;
        s.ready = false;
      }
    });

    sock.on("error", (err) => {
      console.log(`[-] local TCP session ${sid} error: ${err.message}`);
      if (
        ENABLE_HTTP_PORT &&
        s.port === LOCAL_HTTP_PORT &&
        s.host === LOCAL_HTTP_HOST &&
        (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND')
      ) {
        console.log(`[*] HTTP port not available, falling back to TCP for session ${sid}`);
        s._reconnecting = true;
        s.port = LOCAL_TCP_PORT;
        s.host = LOCAL_TCP_HOST;
        try { sock.destroy(); } catch { }
        connectLocal(sid, s);
      } else {
        try { sock.destroy(); } catch { }
      }
    });
  }

  function handleTcpData(sid, data) {
    const s = tcpSessions.get(String(sid));
    if (!s) return;

    if (!s.socket && ENABLE_HTTP_PORT) {
      let port = LOCAL_TCP_PORT;
      let host = LOCAL_TCP_HOST;

      if (data && data.length > 0) {
        const str = data.toString("ascii", 0, Math.min(10, data.length));
        if (/^[A-Z]+\s/.test(str)) {
          port = LOCAL_HTTP_PORT;
          host = LOCAL_HTTP_HOST;
        }
      }
      s.port = port;
      s.host = host;
      connectLocal(sid, s);
      s.pending.push(data);
      return;
    }

    if (!s.socket) {
      s.port = LOCAL_TCP_PORT;
      s.host = LOCAL_TCP_HOST;
      connectLocal(sid, s);
      s.pending.push(data);
      return;
    }

    if (s.ready) {
      const canWrite = s.socket.write(data);
      if (!canWrite && !s.writeBlocked) {
        s.writeBlocked = true;
        blockedWritesCount++;
        pauseControlIfNeeded();
        if (!s._drainListenerAttached) {
          s._drainListenerAttached = true;
          s.socket.once("drain", () => {
            if (s.writeBlocked) {
              s.writeBlocked = false;
              blockedWritesCount--;
              resumeControlIfPossible();
            }
            s._drainListenerAttached = false;
          });
        }
      }
    } else {
      s.pending.push(data);
    }
  }

  function createTcpSession(sid) {
    const state = {
      socket: null,
      ready: false,
      pending: [],
      port: LOCAL_TCP_PORT,
      host: LOCAL_TCP_HOST,
      writeBlocked: false,
      _drainListenerAttached: false,
      remotePaused: false,
    };

    tcpSessions.set(String(sid), state);

    if (ENABLE_HTTP_PORT) {
      return;
    }

    const sock = net.connect({ port: state.port, host: state.host, highWaterMark: BUFFER_SIZE });
    sock.setNoDelay(true);
    state.socket = sock;

    sock.on("connect", () => {
      state.ready = true;
      if (state.remotePaused) sock.pause();
      console.log(`[*] local TCP session ${sid} connected to ${state.host}:${state.port}`);
      for (const chunk of state.pending) sock.write(chunk);
      state.pending = [];
    });

    sock.on("data", (chunk) => {
      const ok = sendMessage(MSG_TYPE.TCP_DATA, sid, chunk);
      if (!ok && !pausedLocalSockets.has(sock)) {
        sock.pause();
        pausedLocalSockets.add(sock);
      }
    });

    sock.on("close", () => {
      console.log(`[-] local TCP session ${sid} closed`);
      sendMessage(MSG_TYPE.TCP_CLOSE, sid, null);
      pausedLocalSockets.delete(sock);
      if (state.writeBlocked) {
        state.writeBlocked = false;
        blockedWritesCount--;
        resumeControlIfPossible();
      }
      state.pending = []; // free
      tcpSessions.delete(String(sid));
    });

    sock.on("error", (err) => {
      console.log(`[-] local TCP session ${sid} error: ${err.message}`);
      try { sock.destroy(); } catch { }
    });
  }

  function closeUdpSession(key) {
    const s = udpSessions.get(key);
    if (!s) return;
    udpSessions.delete(key);
    s.pending = [];
    try { s.socket.close(); } catch { }
  }

  // Evict the least-recently-used UDP session when the hard cap is reached, so
  // a flood of distinct source ports cannot grow memory without bound.
  function evictUdpSessionsIfNeeded() {
    while (udpSessions.size >= MAX_UDP_SESSIONS) {
      let oldestKey = null;
      let oldest = Infinity;
      for (const [key, s] of udpSessions) {
        if ((s.lastSeen || 0) < oldest) { oldest = s.lastSeen || 0; oldestKey = key; }
      }
      if (oldestKey === null) break;
      closeUdpSession(oldestKey);
    }
  }

  function getUdpSession(srcKey) {
    let s = udpSessions.get(srcKey);
    if (s) { s.lastSeen = Date.now(); return s; }

    evictUdpSessionsIfNeeded();

    const sock = dgram.createSocket("udp4");
    const state = { socket: sock, ready: false, pending: [], lastSeen: Date.now() };

    sock.on("error", (err) => {
      console.log(`[-] UDP session ${srcKey} error: ${err.message}`);
      try { sock.close(); } catch { }
    });

    sock.on("message", (msg) => {
      const srcKeyBuf = Buffer.from(srcKey);
      const data = Buffer.concat([srcKeyBuf, Buffer.from([0]), msg]);
      if (!udpControlAuthenticated || !sendUdpTunnelMessage(MSG_TYPE.UDP_OUT, 0, data)) {
        sendMessage(MSG_TYPE.UDP_OUT, 0, data);
      }
    });

    console.log(`[*] UDP session ${srcKey} creating local socket to ${LOCAL_UDP_HOST}:${LOCAL_UDP_PORT}`);
    sock.connect(LOCAL_UDP_PORT, LOCAL_UDP_HOST, () => {
      state.ready = true;
      console.log(`[*] UDP session ${srcKey} connected to local ${LOCAL_UDP_HOST}:${LOCAL_UDP_PORT}`);
      for (const buf of state.pending) {
        sock.send(buf, (err) => {
          if (err) {
            console.log(`[-] UDP session ${srcKey} send error: ${err.message}`);
          } else {
            console.log(`[*] UDP session ${srcKey} flushed ${buf.length} bytes pending`);
          }
        });
      }
      state.pending = [];
    });

    s = state;
    udpSessions.set(srcKey, s);
    return s;
  }

  function handleServerMessage(msg) {
    try {
      const { type, sid, data } = msg;

      if (type === MSG_TYPE.TCP_OPEN) {
        createTcpSession(sid);
        return;
      }

      if (type === MSG_TYPE.TCP_DATA) {
        handleTcpData(sid, data);
        return;
      }

      if (type === MSG_TYPE.TCP_CLOSE) {
        const s = tcpSessions.get(String(sid));
        if (s) {
          try { s.socket.destroy(); } catch { }
          s.pending = [];
          tcpSessions.delete(String(sid));
        }
        return;
      }

      // Pause/resume: the server may send them, but we handle carefully
      if (type === MSG_TYPE.TCP_PAUSE) {
        const s = tcpSessions.get(String(sid));
        if (s) s.remotePaused = true;
        if (s && s.socket && !s.socket.destroyed) {
          s.socket.pause();
          console.log(`[*] Session ${sid} paused (received from server)`);
        }
        return;
      }

      if (type === MSG_TYPE.TCP_RESUME) {
        const s = tcpSessions.get(String(sid));
        if (s) s.remotePaused = false;
        if (s && s.socket && !s.socket.destroyed && !pausedLocalSockets.has(s.socket)) {
          s.socket.resume();
          console.log(`[*] Session ${sid} resumed (received from server)`);
        }
        return;
      }

      if (type === MSG_TYPE.UDP_IN) {
        const nullIdx = data.indexOf(0);
        if (nullIdx === -1) return;
        const srcKey = data.slice(0, nullIdx).toString();
        const payload = data.slice(nullIdx + 1);

        const s = getUdpSession(srcKey);
        if (s.ready) {
          s.socket.send(payload, (err) => {
            if (err) console.log(`[-] UDP send error for ${srcKey}: ${err.message}`);
          });
        } else {
          s.pending.push(payload);
        }
        return;
      }

      if (type === MSG_TYPE.AUTH_OK) {
        controlAuthenticated = true;
        lastHeartbeatAt = Date.now();
        startHeartbeat();
        console.log("[+] authenticated");
        return;
      }

      if (type === MSG_TYPE.AUTH_FAIL) {
        console.log("[-] auth failed");
        control.destroy();
        return;
      }

      if (type === MSG_TYPE.HEARTBEAT_PING) {
        lastHeartbeatAt = Date.now();
        sendMessage(MSG_TYPE.HEARTBEAT_PONG, 0, null);
        return;
      }

      if (type === MSG_TYPE.HEARTBEAT_PONG) {
        lastHeartbeatAt = Date.now();
        return;
      }
    } catch (e) {
      console.log("[-] bad frame:", e.message);
    }
  }

  function handleUdpTunnelMessage(packet) {
    const msg = decodeSingleMessage(packet);
    if (!msg) return;

    try {
      const { type, data } = msg;

      if (type === MSG_TYPE.AUTH_OK) {
        if (!udpControlAuthenticated) {
          udpControlAuthenticated = true;
          console.log("[+] UDP tunnel authenticated");
        }
        return;
      }

      if (type !== MSG_TYPE.UDP_IN || !data) return;

      const nullIdx = data.indexOf(0);
      if (nullIdx === -1) return;
      const srcKey = data.slice(0, nullIdx).toString();
      const payload = data.slice(nullIdx + 1);

      const s = getUdpSession(srcKey);
      if (s.ready) {
        s.socket.send(payload, (err) => {
          if (err) console.log(`[-] UDP send error for ${srcKey}: ${err.message}`);
        });
      } else {
        s.pending.push(payload);
      }
    } catch (e) {
      console.log(`[-] bad udp tunnel frame: ${e.message}`);
    }
  }

  function connectUdpControl() {
    if (udpControl) {
      stopUdpHello();
      udpControlAuthenticated = false;
      try { udpControl.close(); } catch { }
    }

    udpControl = dgram.createSocket("udp4");
    udpControlAuthenticated = false;

    udpControl.on("message", handleUdpTunnelMessage);
    udpControl.on("error", (err) => {
      console.log(`[-] udp control socket error: ${err.message}`);
    });
    udpControl.on("close", () => {
      udpControlAuthenticated = false;
      stopUdpHello();
      if (!shuttingDown) setTimeout(connectUdpControl, 2000);
    });

    udpControl.connect(VPS_PORT, VPS_IP, () => {
      console.log("[+] UDP tunnel connected to VPS");
      startUdpHello();
    });
  }

  function connectControl() {
    if (shuttingDown) return;
    console.log("[*] connecting...");
    controlAuthenticated = false;
    stopHeartbeat();

    const gen = ++controlGen;
    let downCalled = false;
    let bound = false;
    const isCurrent = () => gen === controlGen && !shuttingDown;

    const down = () => {
      if (downCalled || !isCurrent()) return;
      downCalled = true;
      console.log("[-] control disconnected, retrying...");
      controlAuthenticated = false;
      stopHeartbeat();
      closeAllSessions();
      setTimeout(() => { if (gen === controlGen && !shuttingDown) connectControl(); }, 2000);
    };

    const bindControl = (sock) => {
      bound = true;
      control = sock;
      sock.on("drain", onControlDrain);
      sock.on("data", createBinaryParser(handleServerMessage));
      sock.on("error", (err) => console.log(`[-] control socket error: ${err.message}`));
      try { sock.setNoDelay(true); sock.setKeepAlive(true, CONTROL_KEEPALIVE_DELAY_MS); } catch { }
      sendMessage(MSG_TYPE.AUTH_HELLO, 0, Buffer.from(`TUN1 ${TOKEN}`));
    };

    const raw = net.connect({ port: VPS_PORT, host: VPS_IP, highWaterMark: BUFFER_SIZE });
    raw.on("error", (err) => { if (!bound) console.log(`[-] control socket error: ${err.message}`); });
    raw.on("close", down);

    raw.on("connect", () => {
      if (!isCurrent()) return;

      if (!ENABLE_TLS) {
        console.log("[+] connected to VPS");
        bindControl(raw);
        return;
      }

      // Announce the worker marker, then run the TLS-PSK handshake on the same
      // socket. The ClientHello rides right behind the marker.
      raw.write(TLS_MAGIC);
      const tlsSock = tls.connect({
        socket: raw,
        ciphers: TLS_CIPHERS,
        minVersion: "TLSv1.2",
        maxVersion: "TLSv1.2",
        pskCallback: () => ({ psk, identity: TLS_IDENTITY }),
        rejectUnauthorized: false,
      }, () => {
        if (!isCurrent()) return;
        console.log("[+] connected to VPS (TLS)");
        bindControl(tlsSock);
      });
      tlsSock.on("error", (err) => console.log(`[-] TLS control error: ${err.message}`));
    });
  }

  function cleanup() {
    for (const id of localIntervals) { try { clearInterval(id); } catch { } }
    localIntervals.length = 0;
    stopHeartbeat();
    stopUdpHello();
    closeAllSessions();
    try { if (control) control.destroy(); } catch { }
    try { if (udpControl) udpControl.close(); } catch { }
  }
  registerCleanup(cleanup);

  connectControl();
  connectUdpControl();
}

// If an argument is passed, use it; otherwise use "client.json" in the current directory
const CONFIG_PATH = ARGS.positional[0]
  ? path.resolve(process.cwd(), ARGS.positional[0])
  : path.join(__dirname, "client.json");

const EXAMPLE_CONFIG = {
  config: [{
    vps: { socket: "IP:PORT", token: "YOUR_TOKEN_HERE" },
    tcp: { enabled: true, socket: "127.0.0.1:7000" },
    udp: { enabled: true, socket: "127.0.0.1:7000" },
    http: { comment: "Detects HTTP to send to another socket. This can break some specific server-first games", enabled: false, socket: "127.0.0.1:8080" },
    tls: { comment: "Encrypt the control channel with the server. The server must be started with --tls or TLS=1", enabled: false }
  }]
};

function parseSocket(str, context) {
  const parts = String(str).split(":");
  if (parts.length !== 2 || !parts[0]) {
    throw new Error(`[CONFIG ERROR] Invalid format in ${context}: "${str}". Expected "ip:port" (e.g. 127.0.0.1:8000)`);
  }
  const host = parts[0];
  const port = parseInt(parts[1], 10);
  if (isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(`[CONFIG ERROR] Port in ${context} ("${parts[1]}") is not a valid number.`);
  }
  return { host, port };
}

function isValidSocket(str) {
  try { parseSocket(str, "x"); return true; } catch { return false; }
}

// --- Interactive first-run setup (only when stdin/stdout are a TTY) ---
async function runSetup() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q, def) => new Promise((resolve) => {
    rl.question(def ? `${q} [${def}]: ` : `${q}: `, (a) => resolve(a.trim()));
  });
  const askSocket = async (q, def) => {
    for (;;) {
      const answer = def ? ((await ask(q, def)) || def) : await ask(q);
      if (answer && isValidSocket(answer)) return answer;
      ui.log("[-] Invalid, expected IP:port (e.g. 127.0.0.1:8000)");
    }
  };

  ui.banner("nodejs-tcp-udp-tunnel — setup", "no config found, a few quick questions");
  console.log("Config not detected, asking for setup.");

  const vpsSocket = await askSocket("server socket (IP:port)");

  let token = "";
  while (!token) {
    token = await ask("token");
    if (!token) ui.log("[-] Token is required");
  }

  let mode = "";
  while (!["1", "2", "3"].includes(mode)) {
    mode = (await ask("mode: 1 tcp, 2 udp, 3 tcp+udp", "3")) || "3";
  }

  const tcpSocket = await askSocket("tcp socket (IP:port)");
  const udpSocket = await askSocket("udp socket (IP:port) (Enter for same as TCP)", tcpSocket);

  let httpAnswer = "pending";
  while (!["", "1", "2"].includes(httpAnswer)) {
    httpAnswer = await ask("add http redirection to another socket? 1 no, 2 yes (Enter for no)", "1");
  }
  let httpSocket = "127.0.0.1:8080";
  if (httpAnswer === "2") httpSocket = await askSocket("http socket (IP:port)", "127.0.0.1:8080");

  let tlsAnswer = "pending";
  while (!["", "1", "2"].includes(tlsAnswer)) {
    tlsAnswer = await ask("encrypt the control channel with TLS? 1 no, 2 yes (Enter for no)", "1");
  }

  rl.close();

  const config = {
    config: [{
      vps: { socket: vpsSocket, token },
      tcp: { enabled: mode === "1" || mode === "3", socket: tcpSocket },
      udp: { enabled: mode === "2" || mode === "3", socket: udpSocket },
      http: { comment: EXAMPLE_CONFIG.config[0].http.comment, enabled: httpAnswer === "2", socket: httpSocket },
      tls: { comment: EXAMPLE_CONFIG.config[0].tls.comment, enabled: tlsAnswer === "2" }
    }]
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 4));
  console.log(`[+] Config saved to ${CONFIG_PATH}`);
}

// --- MAIN / CONFIGURATION LOADING ---
async function main() {
  if (ARGS.help) { printHelp(); process.exit(0); }
  if (ARGS.version) { originalLog.call(console, VERSION); process.exit(0); }

  if (!fs.existsSync(CONFIG_PATH)) {
    if (process.stdin.isTTY) {
      await runSetup();
    } else {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(EXAMPLE_CONFIG, null, 4));
      console.log("Generated client.json. Configure it and restart.");
      process.exit(0);
    }
  }

  const { config } = JSON.parse(fs.readFileSync(CONFIG_PATH));
  const TLS_FROM_ENV = ARGS.tls || /^(1|true|yes|on)$/i.test(process.env.TLS || process.env.TLS_ENABLED || "");
  ui.banner(`nodejs-tcp-udp-tunnel v${VERSION}`, "worker client");
  console.log(NO_LOG ? "[*] Logging disabled" : `[*] Logging to ${LOG_DIR}`);

  config.forEach(c => {
    const vpsData = parseSocket(c.vps.socket, "VPS SOCKET");
    const tcpData = parseSocket(c.tcp.socket, "TCP SOCKET");
    const udpData = parseSocket(c.udp.socket, "UDP SOCKET");
    const httpData = parseSocket(c.http.socket, "HTTP SOCKET");
    const enableTls = TLS_FROM_ENV || !!(c.tls && c.tls.enabled);

    console.log(`[*] Configuring instance: ${c.vps.socket}`);
    console.log(`[*] TCP: ${c.tcp.enabled ? "on" : "off"} ${c.tcp.socket}`);
    console.log(`[*] UDP: ${c.udp.enabled ? "on" : "off"} ${c.udp.socket}`);
    console.log(`[*] HTTP: ${c.http.enabled ? "on" : "off"} ${c.http.socket}`);
    console.log(`[*] TLS: ${enableTls ? "on" : "off"}`);

    StartTunnel(c.vps.socket, c.vps.token, vpsData.host, vpsData.port, tcpData.host, tcpData.port, udpData.host, udpData.port, c.http.enabled, httpData.host, httpData.port, enableTls)
  });

  // Pterodactyl may stop a server by writing a command to its stdin.
  if (process.stdin && !process.stdin.destroyed) {
    process.stdin.on("data", (d) => {
      const line = d.toString().trim().toLowerCase();
      if (["stop", "exit", "quit", "shutdown", "end"].includes(line)) shutdown("stdin", 0);
    });
    process.stdin.on("end", () => shutdown("stdin-eof", 0));
    try { process.stdin.resume(); } catch { }
  }
}

main().catch((err) => {
  console.log(`[-] ${err.message}`);
  process.exit(1);
});
