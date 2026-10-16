// server.js

// By Bertogim
// v1.6.2

const net = require("net");
const dgram = require("dgram");
const tls = require("tls");
const fs = require("fs");
const path = require("path");
const readline = require('readline');
const crypto = require('crypto');


// Addons are trusted local code, not sandboxed. Restart after adding/removing one.
function createServerAddons(options) {
  const MAX_DATA = 48 * 1024;
  const handlers = new Map();
  const datagrams = new Map();
  const validType = type => Number.isInteger(type) && type >= 0x80 && type <= 0xef;
  const report = err => console.error('[addon] ' + (err && err.message || err));
  function send(type, data, transport = 'tcp') {
    if (!validType(type) || !Buffer.isBuffer(data) || data.length > MAX_DATA ||
        !['tcp', 'udp'].includes(transport)) return false;
    try { return options.send(type, data, transport); }
    catch (err) { report(err); return false; }
  }
  const directory = path.join(__dirname, 'addons');
  const files = new Set();
  try {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isFile() && entry.name.endsWith('.js')) {
        files.add(path.join(directory, entry.name));
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') report(err);
  }
  // Preserve compatibility with explicitly configured addon paths.
  for (const file of (process.env.TUNNEL_ADDONS || '')
    .split(path.delimiter).filter(Boolean)) files.add(path.resolve(file));

  for (const file of files) {
    const pending = new Map();
    const pendingDatagrams = new Map();
    let loading = true;
    try {
      const setup = require(file);
      if (typeof setup !== 'function' || setup.constructor.name === 'AsyncFunction') {
        throw new Error('Addon must export a synchronous setup function');
      }
      const api = Object.freeze({
        role: 'server',
        send,
        onDatagram(prefix, handler) {
          if (!loading || typeof prefix !== 'string' ||
              !/^[A-Z0-9]{8}$/.test(prefix) || typeof handler !== 'function' ||
              datagrams.has(prefix) || pendingDatagrams.has(prefix)) {
            throw new Error('Invalid or duplicate datagram prefix');
          }
          pendingDatagrams.set(prefix, handler);
        },
        onMessage(type, handler) {
          if (!loading) throw new Error('Register handlers during addon setup');
          if (!validType(type) || typeof handler !== 'function' ||
              handlers.has(type) || pending.has(type)) {
            throw new Error('Invalid or duplicate addon type: ' + type);
          }
          pending.set(type, handler);
        }
      });
      const result = setup(api);
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch(report);
        throw new Error('Async addon setup is not supported');
      }
      for (const [type, handler] of pending) handlers.set(type, handler);
      for (const [prefix, handler] of pendingDatagrams) datagrams.set(prefix, handler);
      console.log('[addon] loaded ' + path.basename(file));
    } catch (err) {
      report(path.basename(file) + ': ' + (err && err.message || err));
    } finally {
      loading = false;
    }
  }
  return {
    datagram(packet) {
      if (!Buffer.isBuffer(packet) || packet.length < 8) return false;
      const handler = datagrams.get(packet.toString('ascii', 0, 8));
      if (!handler) return false;
      if (packet.length > 49152) return true;
      try { Promise.resolve(handler(packet.subarray(8))).catch(report); }
      catch (err) { report(err); }
      return true;
    },
    dispatch(msg, transport) {
      if (!validType(msg.type)) return false;
      const data = msg.data || Buffer.alloc(0);
      if (!Buffer.isBuffer(data) || data.length > MAX_DATA) return true;
      const handler = handlers.get(msg.type);
      if (handler) {
        try {
          Promise.resolve(handler(Buffer.from(data), {
            role: 'server', transport, sid: msg.sid,
            reply: payload => send(msg.type, payload, transport)
          })).catch(report);
        } catch (err) { report(err); }
      }
      return true;
    }
  };
}

const VERSION = "1.6.2";

// TLS-PSK (no certificates needed) used for the worker control channel when
// enabled. The key is derived from the token, so auth and encryption share the
// same secret and no certificate files have to be deployed alongside.
const TLS_MAGIC = Buffer.from("TUNS");
const TLS_IDENTITY = "TUN1";
const TLS_CIPHERS = "PSK-AES256-GCM-SHA384:PSK-AES128-GCM-SHA256:PSK-CHACHA20-POLY1305";

// --- CLI arguments ---
// Usage: node server.js [port] [--log-dir <path>] [--no-log] [--tls]
//        [--blacklist <file>] [--bind <ip>]
function parseArgs(argv) {
  const opts = { positional: [], logDir: null, noLog: false, version: false, help: false, tls: false, blacklist: null, bind: null, showIp: false, hideIp: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-log" || a === "--no-logs") opts.noLog = true;
    else if (a === "--log-dir") opts.logDir = argv[++i] || null;
    else if (a.startsWith("--log-dir=")) opts.logDir = a.slice("--log-dir=".length);
    else if (a === "--tls") opts.tls = true;
    else if (a === "--no-tls") opts.tls = false;
    else if (a === "--blacklist") opts.blacklist = argv[++i] || null;
    else if (a.startsWith("--blacklist=")) opts.blacklist = a.slice("--blacklist=".length);
    else if (a === "--bind") opts.bind = argv[++i] || null;
    else if (a.startsWith("--bind=")) opts.bind = a.slice("--bind=".length);
    else if (a === "--showip" || a === "--show-ip") opts.showIp = true;
    else if (a === "--hideip" || a === "--hide-ip") opts.hideIp = true;
    else if (a === "--version" || a === "-v") opts.version = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else opts.positional.push(a);
  }
  return opts;
}
const ARGS = parseArgs(process.argv.slice(2));

// --- IP display privacy (default: mask the last 2 octets in logs) ---
// Logs show IPv4 as a.b.xxx.xxx and IPv6 with the last 16 bits masked.
// `showip` reveals full addresses, `hideip` masks them again; the choice can be
// set with --showip/--hideip, SHOW_IP/HIDE_IP, a live stdin command, and it
// persists to ip-settings.json next to this file.
const IP_SETTINGS_FILE = path.join(__dirname, "ip-settings.json");
const IP_FLAG_TRUE = /^(1|true|yes|on)$/i;

function loadIpMode() {
  if (ARGS.showIp) return "show";
  if (ARGS.hideIp) return "hide";
  if (IP_FLAG_TRUE.test(process.env.SHOW_IP || "")) return "show";
  if (IP_FLAG_TRUE.test(process.env.HIDE_IP || "")) return "hide";
  try {
    const parsed = JSON.parse(fs.readFileSync(IP_SETTINGS_FILE, "utf8"));
    if (parsed && parsed.ipMode === "show") return "show";
  } catch { }
  return "hide";
}

let ipMode = loadIpMode();

function saveIpMode() {
  try { fs.writeFileSync(IP_SETTINGS_FILE, JSON.stringify({ ipMode }, null, 2)); } catch { }
}

function setIpMode(mode) {
  if (mode !== "show" && mode !== "hide") return;
  ipMode = mode;
  saveIpMode();
  console.log(`[*] IP display: ${mode === "show" ? "showip (full addresses in logs)" : "hideip (last 2 octets masked in logs)"}`);
}

// Masks the last 2 octets (IPv6: last 16 bits = final hextet) of an IP.
function maskIP(ip) {
  let s = String(ip || "");
  if (s.startsWith("::ffff:")) s = s.slice(7); // IPv4-mapped IPv6 -> plain IPv4
  const m4 = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m4) return `${m4[1]}.${m4[2]}.xxx.xxx`;
  if (s.indexOf(":") !== -1) {
    const i = s.lastIndexOf(":");
    if (i > 0) return s.slice(0, i) + ":xxxx";
  }
  return s;
}

function displayIP(ip) { return ipMode === "show" ? String(ip) : maskIP(ip); }
function displayAddr(ip, port) {
  const shown = displayIP(ip);
  if (port === undefined || port === null || port === "") return shown;
  return shown + ":" + port;
}

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
const STATS_INTERVAL_MS = parseInt(process.env.STATS_INTERVAL_MS || "30000", 10);
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
  let lastRows = null;   // one-column layout ([label, value] pairs)
  let lastCols = null;   // multi-column layout (array of row-groups)
  let lastNonTtyAt = 0;
  const width = () => _out.columns || 100;
  const vlen = (s) => _useColor ? String(s).replace(/\x1b\[[0-9;]*m/g, "").length : String(s).length;
  const vpad = (s, n) => { const pad = n - vlen(s); return pad > 0 ? s + " ".repeat(pad) : s; };

  // Truncates a (possibly colored) string to `max` visible characters while
  // keeping ANSI sequences intact; the caller appends the ellipsis.
  function truncVis(s, max) {
    const re = /\x1b\[[0-9;]*m/g;
    let out = "";
    let vis = 0;
    let last = 0;
    while (vis < max) {
      const m = re.exec(s);
      const end = m ? m.index : s.length;
      const plain = s.slice(last, end);
      const need = max - vis;
      if (plain.length >= need) { out += plain.slice(0, need); break; }
      out += plain;
      vis += plain.length;
      if (!m) break;
      out += m[0];
      last = re.lastIndex;
    }
    return out;
  }

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
      if (vlen(val) > room) val = truncVis(val, Math.max(0, room - 1)) + "…";
      const label = paint(C.cyan, k + ":") + " ".repeat(labelWidth - (k.length + 1));
      return label + " " + val;
    });
    _out.write(lines.join("\n") + "\n");
    drawn = lines.length;
  }
  // Renders row-groups (segments) as side-by-side columns. Uses as many
  // columns as the terminal fits — up to one column per segment — with at
  // least COL_GAP blank characters between columns; each column truncates its
  // values to its own share of the terminal width.
  const COL_GAP = 4;
  const MIN_COL_WIDTH = 26;
  function drawCols(segments) {
    const total = Math.max(24, width());
    // Pick the column count: all segments if they fit, otherwise merge the
    // leading segments and keep the trailing ones (IP lists / traffic) whole.
    let k = segments.length;
    while (k > 1 && total - COL_GAP * (k - 1) < k * MIN_COL_WIDTH) k--;
    let cols;
    if (k >= segments.length) cols = segments.map((g) => g.slice());
    else if (k === 1) cols = [[].concat(...segments)];
    else cols = [[].concat(...segments.slice(0, segments.length - (k - 1)))].concat(
      segments.slice(-(k - 1)).map((g) => g.slice()));
    const colWidth = Math.max(14, Math.floor((total - COL_GAP * (cols.length - 1)) / cols.length));
    const rendered = cols.map((rows) => {
      const labelWidth = rows.reduce((m, [k]) => Math.max(m, k.length + 1), 0);
      return rows.map(([k, v]) => {
        let val = String(v);
        const room = Math.max(0, colWidth - labelWidth - 2);
        if (vlen(val) > room) val = truncVis(val, Math.max(0, room - 1)) + "…";
        const label = paint(C.cyan, k + ":") + " ".repeat(labelWidth - (k.length + 1));
        return vpad(label + " " + val, colWidth);
      });
    });
    const maxRows = Math.max(1, ...cols.map((g) => g.length));
    const lines = [];
    for (let i = 0; i < maxRows; i++) {
      const row = [];
      for (let c = 0; c < rendered.length; c++) row.push(rendered[c][i] || " ".repeat(colWidth));
      lines.push(row.join(" ".repeat(COL_GAP)));
    }
    _out.write(lines.join("\n") + "\n");
    drawn = lines.length;
  }
  return {
    log(msg) {
      let m = String(msg);
      // Keep what is painted to the terminal within the terminal width
      // (long IP lists should never wrap). Files/log lines keep full length.
      if (_isTTY) {
        const bodyMax = Math.max(1, width() - (_useColor ? 9 : 0)); // reserve HH:MM:SS + space
        if (m.length > bodyMax) m = m.slice(0, Math.max(1, bodyMax - 1)) + "…";
      }
      const line = fmtEvent(m);
      if (!_isTTY) { _out.write(line + "\n"); return; }
      clear();
      _out.write(line + "\n");
      if (lastCols) drawCols(lastCols);
      else if (lastRows) drawRows(lastRows);
    },
    status(rows) {
      lastCols = null;
      lastRows = rows;
      if (_isTTY) { clear(); drawRows(rows); return; }
      const now = Date.now();
      if (now - lastNonTtyAt < STATS_INTERVAL_MS) return;
      lastNonTtyAt = now;
      _out.write("[stats] " + rows.map(([k, v]) => `${k}=${v}`).join(" ") + "\n");
    },
    statusCols(groups) {
      lastRows = null;
      lastCols = groups;
      if (_isTTY) { clear(); drawCols(groups); return; }
      const now = Date.now();
      if (now - lastNonTtyAt < STATS_INTERVAL_MS) return;
      lastNonTtyAt = now;
      const flat = [];
      for (const g of groups) flat.push(...g);
      _out.write("[stats] " + flat.map(([k, v]) => `${k}=${v}`).join(" ") + "\n");
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
  originalLog.call(console, `nodejs-tcp-udp-tunnel server v${VERSION}

Usage: node server.js [port] [options]

Options:
  --bind <ip>          Address to listen on (default 0.0.0.0)
  --tls                Require TLS-PSK on the worker control connection
                       (the client must enable tls in its config)
  --blacklist <file>   Load IP/CIDR blacklist entries from a file
  --showip             Show full IP addresses in logs (saved to ip-settings.json)
  --hideip             Mask the last 2 octets of IPs again (default, saved to ip-settings.json)
  --log-dir <path>     Directory for log files (default server-logs/)
  --no-log             Disable file logging
  -h, --help           Show this help and exit
  -v, --version        Show version and exit

Environment: SERVER_PORT/PORT, BIND_HOST, TLS=1, IP_BLACKLIST, BLACKLIST_FILE,
  SHOW_IP/HIDE_IP, LOG_DIR, NO_LOG, MAX_CONNECTIONS, CONN_RATE_LIMIT_PER_IP and more (see README).`);
}

// --- IP blacklist (CIDR-aware, IPv4 + IPv6) ---
// Every address is normalized to a 16-byte form (IPv4 is mapped as
// ::ffff:a.b.c.d) so a single prefix match handles both families.
let BLACKLIST = null;

function normalizeIP(ip) {
  const s = String(ip || "");
  return s.startsWith("::ffff:") ? s.slice(7) : s;
}

function parseIPv4ToBytes(ip) {
  const parts = String(ip).split(".");
  if (parts.length !== 4) return null;
  const out = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) {
    if (!/^\d{1,3}$/.test(parts[i])) return null;
    const n = Number(parts[i]);
    if (n < 0 || n > 255) return null;
    out[i] = n;
  }
  return out;
}

function parseIPv6ToBytes(ip) {
  let str = String(ip);
  const doubleIdx = str.indexOf("::");
  if (str.indexOf("::", doubleIdx + 1) !== -1) return null;
  const expand = (part) => {
    const groups = [];
    if (part === "") return groups;
    for (const g of part.split(":")) {
      if (g.includes(".")) {
        const v4 = parseIPv4ToBytes(g);
        if (!v4) return null;
        groups.push(v4.readUInt16BE(0), v4.readUInt16BE(2));
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
        groups.push(parseInt(g, 16));
      }
    }
    return groups;
  };
  let groups;
  if (doubleIdx === -1) {
    groups = expand(str);
    if (!groups || groups.length !== 8) return null;
  } else {
    const head = expand(str.slice(0, doubleIdx));
    const tail = expand(str.slice(doubleIdx + 2));
    if (!head || !tail) return null;
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = head.concat(new Array(fill).fill(0), tail);
  }
  const out = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) out.writeUInt16BE(groups[i] & 0xffff, i * 2);
  return out;
}

function ipTo16Bytes(ip) {
  const norm = normalizeIP(ip);
  const v4 = parseIPv4ToBytes(norm);
  if (v4) return Buffer.concat([Buffer.alloc(10), Buffer.from([0xff, 0xff]), v4]);
  return parseIPv6ToBytes(norm);
}

function prefixMask(prefix) {
  const mask = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) {
    const left = prefix - i * 8;
    mask[i] = left >= 8 ? 0xff : left <= 0 ? 0x00 : (0xff << (8 - left)) & 0xff;
  }
  return mask;
}

function parseBlacklistEntry(text) {
  const raw = String(text).trim();
  if (!raw || raw.startsWith("#")) return null;
  const [addr, prefixStr] = raw.split("/");
  const v4 = parseIPv4ToBytes(addr);
  let bytes, prefix;
  if (v4) {
    bytes = Buffer.concat([Buffer.alloc(10), Buffer.from([0xff, 0xff]), v4]);
    prefix = 96 + (prefixStr === undefined ? 32 : Number(prefixStr));
  } else {
    const v6 = parseIPv6ToBytes(addr);
    if (!v6) return null;
    bytes = v6;
    prefix = prefixStr === undefined ? 128 : Number(prefixStr);
  }
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return null;
  return { base: bytes, mask: prefixMask(prefix), prefix };
}

function loadBlacklist() {
  const entries = [];
  const sources = [];
  const seen = new Set();
  const add = (text, source) => {
    for (const line of String(text).split(/[\n,;]+/)) {
      const entry = parseBlacklistEntry(line);
      if (entry) {
        const key = entry.base.toString("hex") + "/" + entry.prefix;
        if (!seen.has(key)) { seen.add(key); entry.source = source; entries.push(entry); }
      } else if (line.trim() && !line.trim().startsWith("#")) {
        console.log(`[-] Ignoring invalid blacklist entry: "${line.trim()}"`);
      }
    }
  };
  const explicitFile = ARGS.blacklist || process.env.BLACKLIST_FILE;
  const defaultFile = path.join(__dirname, "blacklist.txt");
  const file = explicitFile || (fs.existsSync(defaultFile) ? defaultFile : null);
  if (file) {
    if (fs.existsSync(file)) { add(fs.readFileSync(file, "utf8"), file); sources.push(file); }
    else console.log(`[-] Blacklist file not found: ${file}`);
  }
  if (process.env.IP_BLACKLIST) { add(process.env.IP_BLACKLIST, "IP_BLACKLIST"); sources.push("IP_BLACKLIST"); }
  return { entries, sources };
}

function isBlacklisted(ip) {
  if (!BLACKLIST || BLACKLIST.entries.length === 0) return false;
  const bytes = ipTo16Bytes(ip);
  if (!bytes) return false;
  for (const e of BLACKLIST.entries) {
    let match = true;
    for (let i = 0; i < 16; i++) {
      if ((bytes[i] & e.mask[i]) !== (e.base[i] & e.mask[i])) { match = false; break; }
    }
    if (match) return true;
  }
  return false;
}

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
  if (ARGS.help) { printHelp(); process.exit(0); }
  if (ARGS.version) { originalLog.call(console, VERSION); process.exit(0); }

  ui.banner(`nodejs-tcp-udp-tunnel v${VERSION}`, "server");
  console.log(NO_LOG ? "[*] Logging disabled" : `[*] Logging to ${LOG_DIR}`);
  console.log(ipMode === "show"
    ? "[*] IP display: showip (full addresses in logs)"
    : "[*] IP display: hideip (last 2 octets masked in logs)");
  if (ARGS.showIp || ARGS.hideIp) saveIpMode(); // persist an explicit CLI choice
  let detectedPort = getPort();
  if (!detectedPort) {
    detectedPort = await requestManualPort();
  }

  const PORT = detectedPort;
  const TOKEN = getToken();                    // ← token from file
  BLACKLIST = loadBlacklist();
  const TLS_ENABLED = ARGS.tls || /^(1|true|yes|on)$/i.test(process.env.TLS || process.env.TLS_ENABLED || "");
  const BIND_HOST = ARGS.bind || process.env.BIND_HOST || "0.0.0.0";
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

  console.log(TLS_ENABLED
    ? "[*] Control TLS: ENABLED (TLS-PSK 1.2, key derived from the token)"
    : "[*] Control TLS: disabled (start with --tls or TLS=1 to encrypt the control channel)");
  if (BLACKLIST.entries.length > 0) {
    console.log(`[*] IP blacklist active: ${BLACKLIST.entries.length} entr${BLACKLIST.entries.length === 1 ? "y" : "ies"} from ${BLACKLIST.sources.join(", ")}`);
  }

  let worker = null;
  let workerUdpEndpoint = null;
  let workerConnected = false;

  const tcpSessions = new Map();
  const udpClients = new Map();
  let nextSid = 1;
  let stats = { connections: 0, errors: 0 };
  let totalQueuedBytes = 0;

  // --- Cheap traffic counters (O(1) per packet: just an increment). Rates are
  // sampled once per stats tick, so they never touch the hot path. ---
  let traffic = { packets: 0, bytes: 0 };
  const countTraffic = (bytes) => { traffic.packets++; traffic.bytes += bytes; };

  let recentConnections = new Map();
  let sessionIPs = new Set();

  const tcpRateLimit = new Map();   // ip -> { count, windowStart }
  const udpRateLimit = new Map();   // ip -> { count, windowStart }
  const authFailLogAt = new Map();  // ip -> last log timestamp

  // --- Graceful shutdown bookkeeping ---
  const shutdownHooks = [];
  let shuttingDown = false;
  let exited = false;
  const trackInterval = (id) => { shutdownHooks.push(() => clearInterval(id)); return id; };

  // --- Stats loop ---
  const fmtList = (iterable) => {
    const list = Array.from(iterable).map(displayIP).sort();
    const shown = list.slice(0, 30);
    return shown.join(" ") + (list.length > shown.length ? ` +${list.length - shown.length}` : "");
  };
  const fmtBandwidth = (bps) => {
    if (bps >= 1024 * 1024) return (bps / (1024 * 1024)).toFixed(1) + " MB/s";
    if (bps >= 1024) return (bps / 1024).toFixed(1) + " KB/s";
    return Math.round(bps) + " B/s";
  };
  let lastTrafficSampleAt = Date.now();

  trackInterval(setInterval(() => {
    const now = Date.now();
    const active = new Set();

    // Sample per-tick packet/bandwidth rates and reset the counters.
    const elapsed = (now - lastTrafficSampleAt) / 1000;
    lastTrafficSampleAt = now;
    let pps = 0, bps = 0;
    if (elapsed > 0) { pps = Math.round(traffic.packets / elapsed); bps = traffic.bytes / elapsed; }
    traffic = { packets: 0, bytes: 0 };

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

    ui.statusCols([
      [
        ["Worker TCP", workerConnected ? ui.good("YES") : ui.bad("NO")],
        ["Worker UDP", workerUdpEndpoint ? ui.good("YES") : ui.bad("NO")],
        ["Paused TCP", String(paused)],
      ],
      [
        ["PPs", String(pps)],
        ["Bandwidth", fmtBandwidth(bps)],
        ["Connections", String(tcpSessions.size + udpClients.size)],
      ],
      [
        ["Connected", fmtList(active)],
        ["Recent 5min", fmtList(recentIPs)],
        ["Sessions", fmtList(sessionIPs)],
      ],
    ]);
    if (sessionIPs.size > MAX_SESSION_IPS) sessionIPs.clear();
  }, 5000));

  const UDP_TIMEOUT = 60 * 1000;
  trackInterval(setInterval(() => {
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
  }, 10000));

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

  // Standalone server: automatically load trusted local addons/*.js.
  const addons = createServerAddons({
      role: 'server',
      send(type, data, transport) {
      if (transport === 'udp') {
        if (!workerConnected || !workerUdpEndpoint) return false;
        udpServer.send(encodeMessage(type, 0, data),
          workerUdpEndpoint.port, workerUdpEndpoint.address, err => {
            if (err) console.error('[addon] ' + err.message);
          });
        return true;
      }
      if (!workerConnected || !worker || worker.destroyed ||
          worker.writableLength > 256 * 1024) return false;
      sendToWorker(type, 0, data);
      return true;
      }
    });

  // --- Worker message handling ---
  function handleWorkerMessage(msg) {
    if (addons.dispatch(msg, 'tcp')) return;
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
        countTraffic(data.length);
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
        countTraffic(payload.length);
        entry.lastSeen = Date.now();
        udpServer.send(payload, entry.port, entry.address, (err) => {
          if (err) console.log(`[-] UDP send error to ${displayAddr(entry.address, entry.port)}: ${err.message}`);
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
    const clientAddr = displayAddr(sock.remoteAddress, sock.remotePort);
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

    if (firstChunk && firstChunk.length) parse(firstChunk);
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
        countTraffic(chunk.length);
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
    countTraffic(msg.length);

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
    const dataLen = msg.readUInt32BE(9);
    if (13 + dataLen !== totalLen) return;
    if (addons.dispatch({
      type: msg[4], sid: msg.readUInt32BE(5), data: msg.subarray(13)
    }, 'udp')) return;
    if (msg[4] !== MSG_TYPE.UDP_OUT) return;

    const dataStart = 13;
    const nullIdx = msg.indexOf(0, dataStart);
    if (nullIdx === -1) return;

    const srcKey = msg.toString('utf8', dataStart, nullIdx);
    const payload = msg.subarray(nullIdx + 1, dataStart + dataLen);
    const entry = udpClients.get(srcKey);
    if (!entry) return;
    countTraffic(payload.length);
    entry.lastSeen = Date.now();
    udpServer.send(payload, entry.port, entry.address, (err) => {
      if (err) console.log(`[-] UDP send error to ${displayAddr(entry.address, entry.port)}: ${err.message}`);
    });
  }

  // --- TLS-PSK control server (only when enabled) ---
  let tlsServer = null;
  if (TLS_ENABLED) {
    const psk = crypto.createHash("sha256").update(TOKEN).digest();
    tlsServer = tls.createServer({
      ciphers: TLS_CIPHERS,
      minVersion: "TLSv1.2",
      maxVersion: "TLSv1.2",
      pskCallback: (socket, identity) => (identity === TLS_IDENTITY ? { psk, identity } : null),
    }, (tlsSock) => {
      handleWorkerConnection(tlsSock, null);
    });
    tlsServer.on("error", (err) => console.log(`[-] TLS server error: ${err.message}`));
  }

  // --- Servers ---
  const tcpServer = net.createServer({
    highWaterMark: CLIENT_SOCKET_HIGH_WATERMARK,
    pauseOnConnect: false
  }, (sock) => {
    if (isBlacklisted(sock.remoteAddress)) {
      stats.errors++;
      logThrottled(sock.remoteAddress, `[-] ${displayAddr(sock.remoteAddress, sock.remotePort)}: blocked by IP blacklist`);
      sock.on('error', () => {});
      sock.destroy();
      return;
    }
    if (!allowRate(tcpRateLimit, sock.remoteAddress, CONN_RATE_LIMIT_PER_IP)) {
      stats.errors++;
      logThrottled(sock.remoteAddress, `[-] ${displayAddr(sock.remoteAddress, sock.remotePort)}: TCP connection rate limit exceeded`);
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

      if (TLS_ENABLED) {
        // Worker control connections start with a magic prefix followed by the
        // TLS ClientHello. Feed the socket to the TLS server, keeping any bytes
        // that arrived glued to the magic in the same packet.
        if (firstChunk.length >= TLS_MAGIC.length && firstChunk.subarray(0, TLS_MAGIC.length).equals(TLS_MAGIC)) {
          sock.pause();
          const rest = firstChunk.subarray(TLS_MAGIC.length);
          if (rest.length) sock.unshift(rest);
          tlsServer.emit("connection", sock);
          return;
        }
        // A plaintext worker handshake while TLS is required is a downgrade
        // attempt: drop it instead of forwarding it to the local service.
        if (isWorkerHandshakeChunk(firstChunk)) {
          stats.errors++;
          logThrottled(sock.remoteAddress, `[-] ${displayAddr(sock.remoteAddress, sock.remotePort)}: plaintext worker rejected (TLS required)`);
          sock.on('error', () => {});
          sock.destroy();
          return;
        }
        handlePublicTcp(sock, firstChunk);
        return;
      }

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

  trackInterval(setInterval(() => {
    if (!worker || worker.destroyed) return;
    if (Date.now() - (worker.lastHeartbeatAt || 0) > WORKER_HEARTBEAT_TIMEOUT_MS) {
      console.log("[-] worker heartbeat timed out, closing stale control socket");
      try { worker.destroy(); } catch { }
    }
  }, 10_000));

  trackInterval(setInterval(() => {
    if (!workerUdpEndpoint) return;
    if (Date.now() - workerUdpEndpoint.lastSeen > WORKER_UDP_TIMEOUT_MS) {
      console.log("[-] worker UDP endpoint timed out");
      workerUdpEndpoint = null;
    }
  }, 10_000));

  udpServer.on("message", (msg, rinfo) => {
    if (isBlacklisted(rinfo.address)) return;
    if (addons.datagram(msg)) return;
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

  // --- Graceful shutdown ---
  // Compatible with Pterodactyl: Wings stops a server with SIGTERM (default)
  // or SIGINT (egg stop command "^C"). Stopping never depends on stdin, because
  // some hosts deliver an immediate stdin EOF at boot (which self-stopped it).
  function shutdown(reason, code) {
    if (shuttingDown) return;
    shuttingDown = true;
    const finish = () => { if (exited) return; exited = true; process.exit(code || 0); };
    console.log(`[*] Shutting down (${reason})...`);
    logClosed = true;
    for (const hook of shutdownHooks) { try { hook(); } catch { } }
    try { tcpServer.close(); } catch { }
    try { udpServer.close(); } catch { }
    if (tlsServer) { try { tlsServer.close(); } catch { } }
    for (const session of tcpSessions.values()) {
      try { if (session.socket) session.socket.destroy(); } catch { }
    }
    tcpSessions.clear();
    udpClients.clear();
    if (worker) { try { worker.destroy(); } catch { } }
    if (logStream && !logStream.destroyed) {
      try { logStream.end(finish); } catch { finish(); }
      setTimeout(finish, 1500);
    } else {
      finish();
    }
  }

  const handleSignal = (sig) => () => shutdown(sig, 0);
  process.on("SIGINT", handleSignal("SIGINT"));
  process.on("SIGTERM", handleSignal("SIGTERM"));
  process.on("SIGHUP", handleSignal("SIGHUP"));
  process.on("SIGQUIT", handleSignal("SIGQUIT"));
  process.on("uncaughtException", (err) => {
    console.log(`[-] uncaughtException: ${err && err.stack ? err.stack : err}`);
    shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (err) => {
    console.log(`[-] unhandledRejection: ${err && err.stack ? err.stack : err}`);
    shutdown("unhandledRejection", 1);
  });

  // Stopping is handled exclusively by the signal handlers above (SIGINT/"^C"
  // egg stop, SIGTERM from Wings). Nothing here reacts to stdin commands or
  // EOF: some hosts (Wings included) deliver an immediate stdin EOF at boot,
  // which used to stop the server by itself. stdin is only used for the live
  // "showip"/"hideip" display toggles (persisted).
  if (process.stdin && !process.stdin.destroyed) {
    process.stdin.on("data", (d) => {
      const line = d.toString().trim().toLowerCase();
      if (line === "showip") setIpMode("show");
      else if (line === "hideip") setIpMode("hide");
    });
    try { process.stdin.resume(); } catch { }
  }

  tcpServer.listen(PORT, BIND_HOST, () => {
    console.log(`[*] TCP listening on ${BIND_HOST}:${PORT}`);
  });

  udpServer.bind(PORT, BIND_HOST, () => {
    console.log(`[*] UDP listening on ${BIND_HOST}:${PORT}`);
    console.log(`[*] Server ready - Client socket highWaterMark: ${CLIENT_SOCKET_HIGH_WATERMARK / 1024}KB`);
  });
}

main().catch(console.error);
