// server.js

// By Bertogim
// v1.0.0

const net = require("net");
const dgram = require("dgram");
const fs = require("fs");
const path = require("path");
const readline = require('readline');
const crypto = require('crypto');

// --- Logging ---
const logsDir = path.join(__dirname, 'server-logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

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

let logFilePath = path.join(logsDir, getLogFileName());
let logStream = fs.createWriteStream(logFilePath, { flags: "a" });

function ensureLogStream() {
  if (logStream && !logStream.destroyed) return;
  logFilePath = path.join(logsDir, getLogFileName());
  logStream = fs.createWriteStream(logFilePath, { flags: "a" });
  logStream.on("error", (err) => {
    originalLog.call(console, `[log-stream-error] ${err.message}`);
  });
}

const originalLog = console.log;
console.log = function (...args) {
  const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}\n`;
  ensureLogStream();
  logStream.write(logLine);
  originalLog.apply(console, args);
};

const consoleOnly = function (...args) {
  originalLog.apply(console, args);
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
  let detectedPort = getPort();
  if (!detectedPort) {
    detectedPort = await requestManualPort();
  }

  const PORT = detectedPort;
  const TOKEN = getToken();                    // ← token from file
  const BUFFER_SIZE = 256 * 1024;
  const MAX_PARSER_BUFFER = 1024 * 1024;      // 1 MB max parser buffer size
  const WORKER_HANDSHAKE_TIMEOUT_MS = 250;
  const CLIENT_SOCKET_HIGH_WATERMARK = 1024 * 1024;
  const MAX_PER_SESSION_QUEUE = 4 * 1024 * 1024;    // 4 MB max queue per session

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
  };

  const CONTROL_KEEPALIVE_DELAY_MS = 30_000;
  const WORKER_HEARTBEAT_TIMEOUT_MS = 45_000;
  const WORKER_UDP_TIMEOUT_MS = 45_000;
  const WORKER_UDP_AUTH_PREFIX = "TUN1UDP";
  const CONSOLE_ACTIVITY_TIMEOUT_MS = 60 * 1000;

  let worker = null;
  let workerUdpEndpoint = null;
  let workerConnected = false;
  let workerPausedGlobally = false;

  const tcpSessions = new Map();
  const udpClients = new Map();
  let nextSid = 1;
  let stats = { connections: 0, errors: 0 };

  let recentConnections = new Map();
  let sessionIPs = new Set();

  // --- Stats loop (IPs only, no numbers) ---
  setInterval(() => {
    console.clear();
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

    consoleOnly('Worker TCP:', workerConnected ? 'YES' : 'NO');
    consoleOnly('Worker UDP:', workerUdpEndpoint ? 'YES' : 'NO');
    consoleOnly('Worker Paused:', workerPausedGlobally ? 'YES' : 'NO');
    consoleOnly(' ');
    consoleOnly('Connected:', Array.from(active).sort().join(' '));
    consoleOnly(' ');
    consoleOnly('Recent (5min):', Array.from(recentIPs).sort().join(' '));
    consoleOnly(' ');
    consoleOnly('Sessions:', Array.from(sessionIPs).sort().join(' '));
    if (sessionIPs.size > 100000) sessionIPs.clear();
  }, 5000);

  const UDP_TIMEOUT = 60 * 1000;
  setInterval(() => {
    const now = Date.now();
    for (const [key, client] of udpClients.entries()) {
      if (now - client.lastSeen > UDP_TIMEOUT) udpClients.delete(key);
    }
  }, 10000);

  // --- Helper functions ---
  function getPort() {
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
    if (totalLen !== packet.length || totalLen > 1024 * 1024) return false;
    const dataLen = packet.readUInt32BE(9);
    if (13 + dataLen !== totalLen) return false;
    const expectedPrefix = `${WORKER_UDP_AUTH_PREFIX} ${TOKEN}`;
    if (packet.length < 13 + expectedPrefix.length) return false;
    return packet.toString('utf8', 13, 13 + expectedPrefix.length) === expectedPrefix;
  }

  function sendToWorker(type, sid, data) {
    if (!worker || worker.destroyed || !workerConnected) return false;
    const msg = encodeMessage(type, sid, data);
    worker.write(msg);
    return true;
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

          // If queue limit exceeded, force close the session
          if (session.queueSize > MAX_PER_SESSION_QUEUE) {
            console.log(`[-] Session ${sid}: queue overflow, closing`);
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

          // Pause reading from the worker so it stops sending data
          if (!workerPausedGlobally && worker && !worker.destroyed) {
            worker.pause();
            workerPausedGlobally = true;
            //console.log(`[*] Pausing worker due to session ${sid} backpressure`);
          }
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
          session.queue = [];
          session.queueSize = 0;
          session.paused = false;
          // If this session was the only paused one, resume worker if needed
          checkAndResumeWorker();
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

  // Check if all sessions are unpaused and resume the worker
  function checkAndResumeWorker() {
    if (!workerPausedGlobally) return;
    let anyPaused = false;
    for (const session of tcpSessions.values()) {
      if (session.paused) {
        anyPaused = true;
        break;
      }
    }
    if (!anyPaused && worker && !worker.destroyed) {
      worker.resume();
      workerPausedGlobally = false;
      //console.log(`[*] Resuming worker, all sessions writable`);
    }
  }

  // --- Worker connection ---
  function handleWorkerConnection(sock, firstChunk) {
    let authenticated = false;
    const clientAddr = sock.remoteAddress + ':' + sock.remotePort;
    stats.connections++;

    const parse = createBinaryParser((msg) => {
      if (!authenticated) {
        if (msg.type !== MSG_TYPE.AUTH_HELLO) {
          console.log(`[-] ${clientAddr}: expected AUTH_HELLO, got ${msg.type}`);
          stats.errors++;
          sock.destroy();
          return;
        }
        const authData = msg.data ? msg.data.toString() : "";
        const parts = authData.split(" ");
        if (parts[0] !== "TUN1" || parts[1] !== TOKEN) {
          console.log(`[-] ${clientAddr}: auth failed`);
          stats.errors++;
          sock.destroy();
          return;
        }
        authenticated = true;

        // Reject if a worker is already connected
        if (workerConnected) {
          console.log(`[-] ${clientAddr}: Worker already connected, rejecting new connection`);
          stats.errors++;
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

        // Resume TCP sessions that were paused due to lack of worker
        for (const [sid, session] of tcpSessions) {
          const sockClient = session.socket;
          if (sockClient && !sockClient.destroyed) {
            sendToWorker(MSG_TYPE.TCP_OPEN, Number(sid), null);
            sockClient.resume();
          }
        }

        sock.on("close", () => {
          if (worker === sock) {
            worker = null;
            workerConnected = false;
            workerPausedGlobally = false;
            console.log(`[-] Worker disconnected: ${clientAddr}`);
            for (const session of tcpSessions.values()) {
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
    recentConnections.set(sock.remoteAddress, Date.now());
    sock.lastActivityAt = Date.now();
    sessionIPs.add(sock.remoteAddress);

    const session = {
      socket: sock,
      queue: [],
      queueSize: 0,
      paused: false,
    };

    // 'drain' event handler to resume data sending
    session.onDrain = () => {
      if (!session.paused) return;
      // Try to send all queued data
      while (session.queue.length > 0) {
        const chunk = session.queue[0];
        if (sock.write(chunk) === false) {
          // It's full again, break out of loop
          break;
        }
        // Written successfully, remove from queue
        session.queue.shift();
        session.queueSize -= chunk.length;
      }
      // If the queue is empty, the session is no longer paused
      if (session.queue.length === 0) {
        session.paused = false;
        checkAndResumeWorker();
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
        sendToWorker(MSG_TYPE.TCP_DATA, sid, chunk);
      } else {
        if (!sock.isPaused()) sock.pause();
      }
    });

    sock.on("close", () => {
      sock.removeListener('drain', session.onDrain);
      session.queue = [];
      session.queueSize = 0;
      session.paused = false;
      tcpSessions.delete(String(sid));
      if (workerConnected) sendToWorker(MSG_TYPE.TCP_CLOSE, sid, null);
      checkAndResumeWorker(); // in case it was the last paused session
    });

    sock.on("error", (err) => {
      sock.removeListener('drain', session.onDrain);
      session.queue = [];
      session.queueSize = 0;
      session.paused = false;
      tcpSessions.delete(String(sid));
      if (workerConnected) sendToWorker(MSG_TYPE.TCP_CLOSE, sid, null);
      checkAndResumeWorker();
    });
  }

  function isWorkerHandshakeChunk(chunk) {
    if (chunk.length < 13) return false;
    const msgLen = chunk.readUInt32BE(0);
    if (msgLen < 13 || msgLen > 1024 * 1024) return false;
    if (chunk[4] !== MSG_TYPE.AUTH_HELLO) return false;
    const dataLen = chunk.readUInt32BE(9);
    if (dataLen < 0 || 13 + dataLen > 1024 * 1024) return false;
    if (chunk.length < 13 + dataLen) return true;
    const authData = chunk.slice(13, 13 + dataLen).toString();
    return authData.startsWith(`TUN1 ${TOKEN}`);
  }

  // --- UDP from clients ---
  function handleClientUdpPacket(msg, rinfo) {
    const srcKey = rinfo.address + ':' + rinfo.port;
    let entry = udpClients.get(srcKey);
    if (!entry) {
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