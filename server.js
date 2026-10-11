// server.js

// By Bertogim
// v1.0.0

const net = require("net");
const dgram = require("dgram");
const fs = require("fs");
const path = require("path");
const readline = require('readline');
const crypto = require('crypto');

// --- CLI arguments ---
// Usage: node server.js [port] [--log-dir <path>] [--no-log]
function parseArgs(argv) {
  const opts = { positional: [], logDir: null, noLog: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-log" || a === "--no-logs") opts.noLog = true;
    else if (a === "--log-dir") opts.logDir = argv[++i] || null;
    else if (a.startsWith("--log-dir=")) opts.logDir = a.slice("--log-dir=".length);
    else opts.positional.push(a);
  }
  return opts;
}
const ARGS = parseArgs(process.argv.slice(2));

// --- Logging (optional and configurable) ---
// Disable with --no-log (or NO_LOG=1); change the directory with --log-dir <path> (or LOG_DIR).
const NO_LOG = ARGS.noLog || /^(1|true|yes|on)$/i.test(process.env.NO_LOG || "");
const LOG_DIR = ARGS.logDir || process.env.LOG_DIR || path.join(__dirname, "server-logs");

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
  if (!NO_LOG) {
    ensureLogStream();
    logStream.write(`[${new Date().toISOString()}] ${message}\n`);
  }
  ui.log(message);
};

// --- Token handling ---
function getToken() {
  const tokenPath = path.join(__dirname, 'token');
  if (fs.existsSync(tokenPath)) {
    const token = fs.readFileSync(tokenPath, 'utf8').trim();
    if (token.length > 0) {
      console.log(`[*] Token loaded from ${tokenPath}`);
      return token;
    }
  }
  // Generate new token
  const newToken = crypto.randomBytes(64).toString('hex');
  fs.writeFileSync(tokenPath, newToken, { mode: 0o600 });
  console.log(`[*] TOKEN IN ${tokenPath}`);
  console.log(`[*] New token generated: ${newToken.slice(0, 8)}... (saved to ${tokenPath})`);
  return newToken;
}

async function main() {
  ui.banner("nodejs-tcp-udp-tunnel", "server");
  console.log(NO_LOG ? "[*] Logging disabled" : `[*] Logging to ${LOG_DIR}`);
  let detectedPort = getPort();
  if (!detectedPort) {
    detectedPort = await requestManualPort();
  }

  const PORT = detectedPort;
  const TOKEN = getToken();                    // ← token from file
  const BUFFER_SIZE = 256 * 1024;
  const MAX_PARSER_BUFFER = 1024 * 1024;      // 1 MB max parser buffer size
  const WORKER_HANDSHAKE_TIMEOUT_MS = 250;
  const CLIENT_SOCKET_HIGH_WATERMARK = parseInt(process.env.CLIENT_SOCKET_HIGH_WATERMARK || String(256 * 1024), 10);
  const MAX_PER_SESSION_QUEUE = parseInt(process.env.MAX_PER_SESSION_QUEUE || String(4 * 1024 * 1024), 10);   // per-session slow-client cap
  const GLOBAL_QUEUE_BUDGET = parseInt(process.env.GLOBAL_QUEUE_BUDGET || String(64 * 1024 * 1024), 10);       // total slow-client buffering cap
  const RECENT_CONNECTIONS_TTL_MS = 5 * 60 * 1000;

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
  const WORKER_HEARTBEAT_TIMEOUT_MS = 45_000;
  const WORKER_UDP_TIMEOUT_MS = 45_000;
  const WORKER_UDP_AUTH_PREFIX = "TUN1UDP";
  const CONSOLE_ACTIVITY_TIMEOUT_MS = 60 * 1000;

  // --- Security limits (all env-tunable) ---
  const AUTH_TIMEOUT_MS = parseInt(process.env.AUTH_TIMEOUT_MS || '2000', 10);
  const MAX_CONNECTIONS = parseInt(process.env.MAX_CONNECTIONS || '4096', 10);
  const CONN_RATE_LIMIT_PER_IP = parseInt(process.env.CONN_RATE_LIMIT_PER_IP || '50', 10);
  const UDP_NEW_CLIENT_RATE_LIMIT_PER_IP = parseInt(process.env.UDP_NEW_CLIENT_RATE_LIMIT_PER_IP || '50', 10);
  const CONN_RATE_WINDOW_MS = 1000;
  const LOG_FAIL_THROTTLE_MS = parseInt(process.env.LOG_FAIL_THROTTLE_MS || '10000', 10);
  const MAX_UDP_CLIENTS = parseInt(process.env.MAX_UDP_CLIENTS || '10000', 10);
  const MAX_SESSION_IPS = parseInt(process.env.MAX_SESSION_IPS || '100000', 10);
  const MAX_AUTH_DATA = 4096; // auth payloads are tiny (TUN1 <128-char token>); bounds parser growth
  const TCP_AUTH_PAYLOAD = `TUN1 ${TOKEN}`;
  const UDP_AUTH_PAYLOAD = `${WORKER_UDP_AUTH_PREFIX} ${TOKEN}`;

  let worker = null;
  let workerUdpEndpoint = null;
  let workerConnected = false;

  const tcpSessions = new Map();
  const udpClients = new Map();
  let nextSid = 1;
  let stats = { connections: 0, errors: 0 };
  let totalQueuedBytes = 0;

  let recentConnections = new Map();
  let sessionIPs = new Set();

  const tcpRateLimit = new Map();   // ip -> { count, windowStart }
  const udpRateLimit = new Map();   // ip -> { count, windowStart }
  const authFailLogAt = new Map();  // ip -> last log timestamp

  // --- Stats loop ---
  const fmtList = (iterable) => {
    const list = Array.from(iterable).sort();
    const shown = list.slice(0, 30);
    return shown.join(" ") + (list.length > shown.length ? ` +${list.length - shown.length}` : "");
  };

  setInterval(() => {
    const now = Date.now();
    const active = new Set();

    for (const session of tcpSessions.values()) {
      const sock = session.socket;
      if (!sock || sock.destroyed) continue;
      if (now - (sock.lastActivityAt || 0) > CONSOLE_ACTIVITY_TIMEOUT_MS) continue;
      active.add(sock.remoteAddress);
    }

    for (const [key, client] of udpClients.entries()) {
      if (now - client.lastSeen <= CONSOLE_ACTIVITY_TIMEOUT_MS) {
        const ip = key.slice(0, key.lastIndexOf(':'));
        active.add(ip);
      }
    }

    const recentIPs = new Set(
      Array.from(recentConnections.entries())
        .filter(([ip, time]) => time > now - 5 * 60 * 1000)
        .map(([ip]) => ip)
    );

    const paused = Array.from(tcpSessions.values()).filter(session => session.paused).length;

    ui.status([
      ["Worker TCP", workerConnected ? ui.good("YES") : ui.bad("NO")],
      ["Worker UDP", workerUdpEndpoint ? ui.good("YES") : ui.bad("NO")],
      ["Paused TCP", String(paused)],
      ["Connected", fmtList(active)],
      ["Recent 5min", fmtList(recentIPs)],
      ["Sessions", fmtList(sessionIPs)],
    ]);
    if (sessionIPs.size > MAX_SESSION_IPS) sessionIPs.clear();
  }, 5000);

  const UDP_TIMEOUT = 60 * 1000;
  setInterval(() => {
    const now = Date.now();
    for (const [key, client] of udpClients.entries()) {
      if (now - client.lastSeen > UDP_TIMEOUT) udpClients.delete(key);
    }
    for (const [ip, seenAt] of recentConnections) {
      if (now - seenAt > RECENT_CONNECTIONS_TTL_MS) recentConnections.delete(ip);
    }
    for (const map of [tcpRateLimit, udpRateLimit]) {
      for (const [ip, entry] of map) {
        if (now - entry.windowStart > CONN_RATE_WINDOW_MS) map.delete(ip);
      }
    }
    for (const [ip, t] of authFailLogAt) {
      if (now - t > LOG_FAIL_THROTTLE_MS) authFailLogAt.delete(ip);
    }
  }, 10000);

  // --- Helper functions ---
  // Constant-time string compare for secrets (token). Falls back to false on
  // length mismatch; token length is public/fixed so this leaks nothing useful.
  function safeEqual(a, b) {
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
  }

  // Fixed-window per-IP rate limiter. Returns false when the limit is exceeded.
  function allowRate(map, ip, limit) {
    const now = Date.now();
    let entry = map.get(ip);
    if (!entry || now - entry.windowStart >= CONN_RATE_WINDOW_MS) {
      entry = { count: 0, windowStart: now };
      map.set(ip, entry);
    }
    entry.count++;
    return entry.count <= limit;
  }

  // Throttle repeated failure logs per IP so a flood cannot fill the disk/CPU.
  function logThrottled(ip, message) {
    const now = Date.now();
    if (now - (authFailLogAt.get(ip) || 0) >= LOG_FAIL_THROTTLE_MS) {
      authFailLogAt.set(ip, now);
      console.log(message);
    }
  }

  function getPort() {
    const argPort = parseInt(ARGS.positional[0], 10);
    if (Number.isInteger(argPort) && argPort > 0 && argPort <= 65535) return argPort;
    if (process.env.SERVER_PORT) return parseInt(process.env.SERVER_PORT, 10);
    if (process.env.PORT) return parseInt(process.env.PORT, 10);
    return null;
  }

  function requestManualPort() {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      rl.question('⚠️ Enter port manually: ', (answer) => {
        rl.close();
        const p = parseInt(answer.trim(), 10);
        if (isNaN(p) || p <= 0 || p > 65535) {
          console.log('❌ Invalid port. Using 3000');
          resolve(3000);
        } else {
          resolve(p);
        }
      });
    });
  }

  function encodeHeader(type, sid, dataLen) {
    const buf = Buffer.allocUnsafe(13);
    buf.writeUInt32BE(13 + dataLen, 0);
    buf.writeUInt8(type, 4);
    buf.writeUInt32BE(sid, 5);
    buf.writeUInt32BE(dataLen, 9);
    return buf;
  }

  function encodeMessage(type, sid, data) {
    const dataLen = data ? data.length : 0;
    const totalLen = 13 + dataLen;
    const buf = Buffer.allocUnsafe(totalLen);
    buf.writeUInt32BE(totalLen, 0);
    buf.writeUInt8(type, 4);
    buf.writeUInt32BE(sid, 5);
    buf.writeUInt32BE(dataLen, 9);
    if (data && dataLen > 0) data.copy(buf, 13);
    return buf;
  }

  function buildUdpInMessage(srcKey, payload) {
    const keyLen = Buffer.byteLength(srcKey);
    const totalLen = 13 + keyLen + 1 + payload.length;
    const buf = Buffer.allocUnsafe(totalLen);
    buf.writeUInt32BE(totalLen, 0);
    buf.writeUInt8(MSG_TYPE.UDP_IN, 4);
    buf.writeUInt32BE(0, 5);
    buf.writeUInt32BE(keyLen + 1 + payload.length, 9);
    let offset = 13;
    buf.write(srcKey, offset, keyLen, 'utf8');
    offset += keyLen;
    buf[offset] = 0;
    offset += 1;
    payload.copy(buf, offset);
    return buf;
  }

  // Binary parser with memory control
  function createBinaryParser(onMessage) {
    let buffer = Buffer.allocUnsafe(BUFFER_SIZE);
    let offset = 0;

    function maybeShrinkBuffer() {
      // If buffer is empty and too large, shrink to free memory
      if (offset === 0 && buffer.length > BUFFER_SIZE) {
        buffer = Buffer.allocUnsafe(BUFFER_SIZE);
      }
    }

    return (chunk) => {
      if (offset + chunk.length > buffer.length) {
        // Only grow up to the maximum limit
        let newSize = Math.min(MAX_PARSER_BUFFER, Math.max(buffer.length * 2, offset + chunk.length));
        if (newSize < offset + chunk.length) {
          // If still doesn't fit, force to required size (very rare)
          newSize = offset + chunk.length;
        }
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
          stats.errors++;
          pos++;
          continue;
        }
        if (offset - pos < msgLen) break;

        const type = buffer[pos + 4];
        const sid = buffer.readUInt32BE(pos + 5);
        const dataLen = buffer.readUInt32BE(pos + 9);
        if (msgLen !== 13 + dataLen) {
          stats.errors++;
          pos++;
          continue;
        }
        const data = dataLen > 0 ? Buffer.from(buffer.slice(pos + 13, pos + 13 + dataLen)) : null;
        try { onMessage({ type, sid, data }); } catch (e) { console.log("[-] error processing message:", e.message); }
        pos += msgLen;
      }

      if (pos > 0) {
        if (pos < offset) buffer.copy(buffer, 0, pos, offset);
        offset -= pos;
      }
      maybeShrinkBuffer();
    };
  }

  function isWorkerAuthHello(packet) {
    if (packet.length < 13 || packet[4] !== MSG_TYPE.AUTH_HELLO) return false;
    const totalLen = packet.readUInt32BE(0);
    if (totalLen !== packet.length || totalLen > MAX_AUTH_DATA) return false;
    const dataLen = packet.readUInt32BE(9);
    if (13 + dataLen !== totalLen) return false;
    if (packet.length < 13 + UDP_AUTH_PAYLOAD.length) return false;
    return safeEqual(packet.toString('utf8', 13, 13 + UDP_AUTH_PAYLOAD.length), UDP_AUTH_PAYLOAD);
  }

  // Writes a frame without copying the payload: a 13-byte header plus the
  // caller's buffer are corked together so the OS sees a single writev.
  function sendToWorker(type, sid, data) {
    if (!worker || worker.destroyed || !workerConnected) return false;
    const dataLen = data ? data.length : 0;
    const header = encodeHeader(type, sid, dataLen);
    if (dataLen === 0) return worker.write(header);
    worker.cork();
    const wroteHeader = worker.write(header);
    const wroteData = worker.write(data);
    worker.uncork();
    return wroteHeader && wroteData;
  }

  // --- Worker message handling ---
  function handleWorkerMessage(msg) {
    try {
      const { type, sid, data } = msg;

      if (type === MSG_TYPE.HEARTBEAT_PING) {
        if (worker && !worker.destroyed) {
          worker.lastHeartbeatAt = Date.now();
          worker.write(encodeMessage(MSG_TYPE.HEARTBEAT_PONG, 0, null));
        }
        return;
      }

      if (type === MSG_TYPE.HEARTBEAT_PONG) {
        if (worker && !worker.destroyed) {
          worker.lastHeartbeatAt = Date.now();
        }
        return;
      }

      if (type === MSG_TYPE.TCP_DATA) {
        const session = tcpSessions.get(String(sid));
        if (!session) return;
        const sock = session.socket;
        if (!sock || sock.destroyed) return;
        sock.lastActivityAt = Date.now();

        // If the session is paused due to flow control, enqueue data
        if (session.paused) {
          session.queue.push(data);
          session.queueSize += data.length;
          totalQueuedBytes += data.length;

          // Force close when this session, or all sessions together, exceed
          // the buffering budget (protects the server's memory).
          if (session.queueSize > MAX_PER_SESSION_QUEUE || totalQueuedBytes > GLOBAL_QUEUE_BUDGET) {
            console.log(`[-] Session ${sid}: queue overflow, closing`);
            totalQueuedBytes -= session.queueSize;
            session.queue = [];
            session.queueSize = 0;
            sock.destroy();
            tcpSessions.delete(String(sid));
            sendToWorker(MSG_TYPE.TCP_CLOSE, sid, null);
            return;
          }
          return;
        }

        // Try to write to client socket
        const ok = sock.write(data);
        if (!ok) {
          // The socket's internal buffer is full, pause the session
          session.paused = true;

          // Stop only this session's producer, keeping the tunnel readable.
          sendToWorker(MSG_TYPE.TCP_PAUSE, sid, null);
        }
        return;
      }

      if (type === MSG_TYPE.TCP_CLOSE) {
        const session = tcpSessions.get(String(sid));
        if (session) {
          if (session.socket && !session.socket.destroyed) {
            session.socket.removeListener('drain', session.onDrain);
            session.socket.destroy();
          }
          // Clear queue and state
          totalQueuedBytes -= session.queueSize;
          session.queue = [];
          session.queueSize = 0;
          session.paused = false;
          session.workerBlocked = false;
        }
        tcpSessions.delete(String(sid));
        return;
      }

      if (type === MSG_TYPE.UDP_OUT) {
        const nullIdx = data.indexOf(0);
        if (nullIdx === -1) return;
        const srcKey = data.toString('utf8', 0, nullIdx);
        const payload = data.subarray(nullIdx + 1);
        const entry = udpClients.get(srcKey);
        if (!entry) return;
        entry.lastSeen = Date.now();
        udpServer.send(payload, entry.port, entry.address, (err) => {
          if (err) console.log(`[-] UDP send error to ${entry.address}:${entry.port}: ${err.message}`);
        });
        return;
      }
    } catch (e) {
      console.log("[-] error in handleWorkerMessage:", e.message);
    }
  }

  // --- Worker connection ---
  function handleWorkerConnection(sock, firstChunk) {
    let authenticated = false;
    const clientAddr = sock.remoteAddress + ':' + sock.remotePort;
    const clientIp = sock.remoteAddress;
    stats.connections++;

    // An unauthenticated "worker candidate" must not hold the socket (and its
    // parser buffer) indefinitely. Drop it if auth does not complete in time.
    const authTimer = setTimeout(() => {
      if (authenticated) return;
      stats.errors++;
      logThrottled(clientIp, `[-] ${clientAddr}: auth timeout`);
      sock.destroy();
    }, AUTH_TIMEOUT_MS);
    sock.once('close', () => clearTimeout(authTimer));
    sock.once('error', () => clearTimeout(authTimer));

    const parse = createBinaryParser((msg) => {
      if (!authenticated) {
        if (msg.type !== MSG_TYPE.AUTH_HELLO) {
          stats.errors++;
          logThrottled(clientIp, `[-] ${clientAddr}: expected AUTH_HELLO, got ${msg.type}`);
          clearTimeout(authTimer);
          sock.destroy();
          return;
        }
        const authData = msg.data ? msg.data.toString() : "";
        if (!safeEqual(authData, TCP_AUTH_PAYLOAD)) {
          stats.errors++;
          logThrottled(clientIp, `[-] ${clientAddr}: auth failed`);
          clearTimeout(authTimer);
          sock.destroy();
          return;
        }
        authenticated = true;
        clearTimeout(authTimer);

        // Reject if a worker is already connected
        if (workerConnected) {
          stats.errors++;
          logThrottled(clientIp, `[-] ${clientAddr}: Worker already connected, rejecting new connection`);
          sock.destroy();
          return;
        }

        console.log(`[+] Worker connected from ${clientAddr}`);

        // Clean any residual reference
        if (worker && worker !== sock) {
          console.log("[*] Cleaning stale worker reference");
          worker = null;
        }

        worker = sock;
        worker.setNoDelay(true);
        worker.setKeepAlive(true, CONTROL_KEEPALIVE_DELAY_MS);
        worker.lastHeartbeatAt = Date.now();
        worker.write(encodeMessage(MSG_TYPE.AUTH_OK, 0, null));
        workerConnected = true;

        // When the worker's write buffer drains, resume clients we paused.
        worker.on("drain", () => {
          for (const session of tcpSessions.values()) {
            if (!session.workerBlocked) continue;
            session.workerBlocked = false;
            const sockClient = session.socket;
            if (sockClient && !sockClient.destroyed && sockClient.isPaused()) sockClient.resume();
          }
        });

        // Resume TCP sessions that were paused due to lack of worker
        for (const [sid, session] of tcpSessions) {
          const sockClient = session.socket;
          if (sockClient && !sockClient.destroyed) {
            sendToWorker(MSG_TYPE.TCP_OPEN, Number(sid), null);
            if (session.paused) sendToWorker(MSG_TYPE.TCP_PAUSE, Number(sid), null);
            sockClient.resume();
          }
        }

        sock.on("close", () => {
          if (worker === sock) {
            worker = null;
            workerConnected = false;
            console.log(`[-] Worker disconnected: ${clientAddr}`);
            for (const session of tcpSessions.values()) {
              session.workerBlocked = false;
              const sockClient = session.socket;
              if (sockClient && !sockClient.destroyed) sockClient.pause();
            }
          }
          workerUdpEndpoint = null;
        });

        sock.on("error", (err) => {
          console.log(`[-] Worker socket error ${clientAddr}: ${err.message}`);
        });
        return;
      }
      handleWorkerMessage(msg);
    });

    parse(firstChunk);
    sock.on("data", parse);
  }

  // --- Public TCP client ---
  function handlePublicTcp(sock, firstChunk) {
    sock.setNoDelay(true);
    sock.setKeepAlive(true, CONTROL_KEEPALIVE_DELAY_MS);

    const clientAddr = sock.remoteAddress + ':' + sock.remotePort;
    const sid = nextSid++;
    stats.connections++;
    if (recentConnections.size < MAX_SESSION_IPS) recentConnections.set(sock.remoteAddress, Date.now());
    sock.lastActivityAt = Date.now();
    if (sessionIPs.size < MAX_SESSION_IPS) sessionIPs.add(sock.remoteAddress);

    const session = {
      socket: sock,
      queue: [],
      queueSize: 0,
      paused: false,
      workerBlocked: false,
    };

    // 'drain' event handler to resume data sending
    session.onDrain = () => {
      if (!session.paused || sock.destroyed) return;
      // Try to send all queued data
      while (session.queue.length > 0) {
        const chunk = session.queue.shift();
        session.queueSize -= chunk.length;
        totalQueuedBytes -= chunk.length;
        // write(false) still accepts the chunk; never enqueue it again.
        if (sock.write(chunk) === false) {
          return;
        }
      }
      // If the queue is empty, the session is no longer paused
      if (session.queue.length === 0) {
        session.paused = false;
        sendToWorker(MSG_TYPE.TCP_RESUME, sid, null);
      }
    };

    sock.on('drain', session.onDrain);

    tcpSessions.set(String(sid), session);

    if (!workerConnected) {
      sock.pause();
    } else {
      sendToWorker(MSG_TYPE.TCP_OPEN, sid, null);
      if (firstChunk && firstChunk.length) {
        sendToWorker(MSG_TYPE.TCP_DATA, sid, firstChunk);
      }
    }

    sock.on("data", (chunk) => {
      if (worker && !worker.destroyed && workerConnected) {
        sock.lastActivityAt = Date.now();
        // If the worker cannot keep up, stop reading from this client so the
        // worker's write queue cannot grow without bound.
        if (!sendToWorker(MSG_TYPE.TCP_DATA, sid, chunk) && !sock.isPaused()) {
          session.workerBlocked = true;
          sock.pause();
        }
      } else {
        if (!sock.isPaused()) sock.pause();
      }
    });

    sock.on("close", () => {
      sock.removeListener('drain', session.onDrain);
      totalQueuedBytes -= session.queueSize;
      session.queue = [];
      session.queueSize = 0;
      session.paused = false;
      session.workerBlocked = false;
      tcpSessions.delete(String(sid));
      if (workerConnected) sendToWorker(MSG_TYPE.TCP_CLOSE, sid, null);
    });

    sock.on("error", (err) => {
      sock.removeListener('drain', session.onDrain);
      totalQueuedBytes -= session.queueSize;
      session.queue = [];
      session.queueSize = 0;
      session.paused = false;
      session.workerBlocked = false;
      tcpSessions.delete(String(sid));
      if (workerConnected) sendToWorker(MSG_TYPE.TCP_CLOSE, sid, null);
    });
  }

  function isWorkerHandshakeChunk(chunk) {
    if (chunk.length < 13) return false;
    const msgLen = chunk.readUInt32BE(0);
    if (msgLen < 13 || msgLen > MAX_AUTH_DATA) return false;
    if (chunk[4] !== MSG_TYPE.AUTH_HELLO) return false;
    const dataLen = chunk.readUInt32BE(9);
    if (dataLen < 0 || dataLen > MAX_AUTH_DATA) return false;
    if (chunk.length < 13 + dataLen) return true; // partial AUTH_HELLO, keep reading
    if (dataLen < TCP_AUTH_PAYLOAD.length) return false;
    return safeEqual(chunk.slice(13, 13 + TCP_AUTH_PAYLOAD.length).toString(), TCP_AUTH_PAYLOAD);
  }

  // --- UDP from clients ---
  function handleClientUdpPacket(msg, rinfo) {
    const srcKey = rinfo.address + ':' + rinfo.port;
    let entry = udpClients.get(srcKey);
    if (!entry) {
      // Rate-limit only the creation of new UDP endpoints (memory churn), never
      // the steady-state packet flow of an established player/session.
      if (udpClients.size >= MAX_UDP_CLIENTS) return;
      if (!allowRate(udpRateLimit, rinfo.address, UDP_NEW_CLIENT_RATE_LIMIT_PER_IP)) {
        stats.errors++;
        return;
      }
      entry = { address: rinfo.address, port: rinfo.port, lastSeen: 0 };
      udpClients.set(srcKey, entry);
    }
    entry.lastSeen = Date.now();

    if (!workerConnected) return;

    const packet = buildUdpInMessage(srcKey, msg);
    if (workerUdpEndpoint) {
      udpServer.send(packet, workerUdpEndpoint.port, workerUdpEndpoint.address, (err) => {
        if (err) console.log(`[-] worker UDP send error: ${err.message}`);
      });
    } else if (worker && !worker.destroyed) {
      worker.write(packet);
    }
  }

  function handleWorkerUdpMessage(msg, rinfo) {
    if (msg.length < 13) return;
    const totalLen = msg.readUInt32BE(0);
    if (totalLen !== msg.length) return;
    if (msg[4] !== MSG_TYPE.UDP_OUT) return;
    const dataLen = msg.readUInt32BE(9);
    if (13 + dataLen !== totalLen) return;

    const dataStart = 13;
    const nullIdx = msg.indexOf(0, dataStart);
    if (nullIdx === -1) return;

    const srcKey = msg.toString('utf8', dataStart, nullIdx);
    const payload = msg.subarray(nullIdx + 1, dataStart + dataLen);
    const entry = udpClients.get(srcKey);
    if (!entry) return;
    entry.lastSeen = Date.now();
    udpServer.send(payload, entry.port, entry.address, (err) => {
      if (err) console.log(`[-] UDP send error to ${entry.address}:${entry.port}: ${err.message}`);
    });
  }

  // --- Servers ---
  const tcpServer = net.createServer({
    highWaterMark: CLIENT_SOCKET_HIGH_WATERMARK,
    pauseOnConnect: false
  }, (sock) => {
    if (!allowRate(tcpRateLimit, sock.remoteAddress, CONN_RATE_LIMIT_PER_IP)) {
      stats.errors++;
      logThrottled(sock.remoteAddress, `[-] ${sock.remoteAddress}: TCP connection rate limit exceeded`);
      sock.on('error', () => {});
      sock.destroy();
      return;
    }
    sock.setNoDelay(true);
    sock.setKeepAlive(true, CONTROL_KEEPALIVE_DELAY_MS);

    let classified = false;
    const handshakeTimer = setTimeout(() => {
      if (classified) return;
      classified = true;
      handlePublicTcp(sock, null);
    }, WORKER_HANDSHAKE_TIMEOUT_MS);

    sock.once("data", (firstChunk) => {
      if (classified) return;
      clearTimeout(handshakeTimer);
      classified = true;

      if (isWorkerHandshakeChunk(firstChunk)) {
        handleWorkerConnection(sock, firstChunk);
      } else {
        handlePublicTcp(sock, firstChunk);
      }
    });

    sock.on("error", (err) => {
      clearTimeout(handshakeTimer);
    });

    sock.on("close", () => {
      clearTimeout(handshakeTimer);
    });
  });

  tcpServer.maxConnections = MAX_CONNECTIONS;

  const udpServer = dgram.createSocket("udp4");

  setInterval(() => {
    if (!worker || worker.destroyed) return;
    if (Date.now() - (worker.lastHeartbeatAt || 0) > WORKER_HEARTBEAT_TIMEOUT_MS) {
      console.log("[-] worker heartbeat timed out, closing stale control socket");
      try { worker.destroy(); } catch { }
    }
  }, 10_000);

  setInterval(() => {
    if (!workerUdpEndpoint) return;
    if (Date.now() - workerUdpEndpoint.lastSeen > WORKER_UDP_TIMEOUT_MS) {
      console.log("[-] worker UDP endpoint timed out");
      workerUdpEndpoint = null;
    }
  }, 10_000);

  udpServer.on("message", (msg, rinfo) => {
    if (isWorkerAuthHello(msg)) {
      workerUdpEndpoint = {
        address: rinfo.address,
        port: rinfo.port,
        lastSeen: Date.now(),
      };
      const resp = encodeMessage(MSG_TYPE.AUTH_OK, 0, null);
      udpServer.send(resp, rinfo.port, rinfo.address);
      return;
    }

    if (workerUdpEndpoint &&
      rinfo.address === workerUdpEndpoint.address &&
      rinfo.port === workerUdpEndpoint.port) {
      workerUdpEndpoint.lastSeen = Date.now();
      handleWorkerUdpMessage(msg, rinfo);
      return;
    }

    if (!workerConnected) return;
    handleClientUdpPacket(msg, rinfo);
  });

  udpServer.on("error", (err) => {
    console.log(`[-] UDP server error: ${err.message}`);
  });

  tcpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`[*] TCP listening on ${PORT}`);
  });

  udpServer.bind(PORT, "0.0.0.0", () => {
    console.log(`[*] UDP listening on ${PORT}`);
    console.log(`[*] Server ready - Client socket highWaterMark: ${CLIENT_SOCKET_HIGH_WATERMARK / 1024}KB`);
  });
}

main().catch(console.error);
