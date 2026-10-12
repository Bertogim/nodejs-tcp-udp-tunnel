# Node.js TCP/UDP Tunneling System on a Single Port

Run a standalone tunnel without dependencies on a Node.js hosting and make local TCP and UDP services accessible from anywhere using a single public port.

---

## Quick Setup

Follow these steps in order. You do not need to clone the repository; just download the two main files.

### Prerequisites

- Node.js (v14 or newer) installed on both the public server and your local machine.
- A public server (Node.js hosting, VPS, cloud instance) with a public IP and an open port (both TCP and UDP must be allowed in the firewall).

---

### 1. Get the files

Download `server.js` and `client.js` directly from the [releases](https://github.com/Bertogim/nodejs-tcp-udp-tunnel/releases) section.  

---

### 2. Server setup (on the public hosting)

- Place `server.js` on the server.
- Run it passing the port as an argument. If you omit the port, you will be prompted to enter one.

```bash
node server.js 8080
```

- On first start, the server creates a `token` file in its directory. This file contains a random 64‑byte hex string. **Copy this token**, you will need it for the client.

- The server automatically creates a `server-logs/` folder and writes a new log file per run (timestamped). See [Logging](#logging) to change the directory or disable it.

- The server listens on all interfaces (`0.0.0.0`) by default. Use `--bind <ip>` to restrict it, `--tls` to require an encrypted control channel, and `--blacklist <file>` to load deny‑listed IPs. Run `node server.js --help` for all options (see [Command Line Flags](#command-line-flags)).

---

### 3. Client setup (on your local machine)

- Place `client.js` on your local machine.
- Create a configuration file named `client.json` in the same directory. If the client is run without it, an interactive setup wizard will ask a few questions and write the file for you (when run in a terminal). If run without a terminal (e.g. as a service) and without a config, it writes a commented example instead.

The wizard asks:

```
server socket (IP:port): 203.0.113.10:9000
token: <the token from the server>
mode: 1 tcp, 2 udp, 3 tcp+udp [3]:
tcp socket (IP:port): 127.0.0.1:25565
udp socket (IP:port) (Enter for same as TCP) [127.0.0.1:25565]:
add http redirection to another socket? 1 no, 2 yes (Enter for no) [1]:
encrypt the control channel with TLS? 1 no, 2 yes (Enter for no) [1]:
```

- The `client.json` file must have this structure:

```json
{
    "config": [
        {
            "vps": {
                "socket": "IP:PORT",
                "token": "YOUR_TOKEN_HERE"
            },
            "tcp": {
                "enabled": true,
                "socket": "LOCALIP:PORT"
            },
            "udp": {
                "enabled": true,
                "socket": "LOCALIP:PORT"
            },
            "http": {
                "enabled": false,
                "socket": "LOCALIP:PORT"
            },
            "tls": {
                "enabled": false
            }
        }
    ]
}
```

Explanation of the fields:

- **`vps.socket`**: public IP and port of your server.
- **`vps.token`**: the token you copied from the server's `token` file.
- **`tcp.socket`**: address and port of the local TCP service you want to expose (e.g., `127.0.0.1:22` for SSH, `127.0.0.1:25565` for Minecraft).
- **`udp.socket`**: address and port of the local UDP service.
- **`http`** (optional): when enabled (`enabled: true`), the client inspects the first bytes of each new TCP connection. If it looks like an HTTP request (starts with `GET`, `POST`, etc.), it routes to the specified HTTP port instead of the TCP port. **Caution**: This can break some specific server-first games.
- **`tls`** (optional): when `enabled: true`, the worker control connection is encrypted with TLS-PSK (see [Control Channel Security (TLS)](#control-channel-security-tls)). The server must be started with `--tls` or `TLS=1`, otherwise it will reject the encrypted handshake.

Run the client:

```bash
node client.js
```

If your config is in another location:

```bash
node client.js /path/to/your/config.json
```

- The client creates a `worker-logs/` folder and writes a new log file per run. See [Logging](#logging) to change the directory or disable it.

---

Once both are running, your local services are accessible from the internet via the public server's IP and port.

---

## How It Works

### Architecture

```
[Internet]  →  [Node.js Server: server.js]  ↔  [Client: client.js]  →  [Local Services]
```

- The server listens on a single port for both TCP and UDP.
- The client establishes a persistent TCP control connection to the server and authenticates with the token.
- The client also opens a UDP control socket to the server for efficient UDP forwarding.
- Incoming traffic is encapsulated into length‑prefixed binary frames and forwarded to the client, which then connects to the local services.
- Heartbeats keep the connection alive; if broken, the client automatically reconnects.

### Protocol (Binary Frames)

Each message has the format:

```
[4 bytes: total length] [1 byte: type] [4 bytes: session ID] [4 bytes: data length] [data...]
```

Message types include:
- `TCP_OPEN`, `TCP_DATA`, `TCP_CLOSE`
- `TCP_PAUSE`, `TCP_RESUME` (per-session flow control)
- `UDP_IN`, `UDP_OUT`
- `AUTH_HELLO`, `AUTH_OK`, `AUTH_FAIL`
- `HEARTBEAT_PING`, `HEARTBEAT_PONG`

Authentication is performed by sending `TUN1 <token>` inside an `AUTH_HELLO` message.

### Flow Control and Memory Management

- The parser buffer is capped at 1 MB to prevent memory exhaustion.
- Each TCP session has a queue limit of 4 MB (`MAX_PER_SESSION_QUEUE`); if exceeded, the session is force‑closed.
- A global buffer budget of 64 MB (`GLOBAL_QUEUE_BUDGET`) caps the total memory used by slow clients across all sessions.
- Per‑session backpressure: when a single client's connection cannot keep up, the server pauses *only that session* (via `TCP_PAUSE`/`TCP_RESUME`) instead of stalling the whole worker.
- Uplink backpressure: if the worker control socket is congested, the server pauses reading from the affected public socket until it drains.
- The client also pauses reading from local sockets when its control connection's write buffer is full. These mechanisms ensure stability under heavy load.

---

## Token Management

- The server generates the token automatically on first start and saves it in a `token` file (permissions: read/write only for the owner).
- To regenerate the token, delete the `token` file and restart the server.
- The client must use the same token in its `client.json`.

---

## Control Channel Security (TLS)

The worker control connection (the TCP link between the server and the client that carries the token and all tunnel metadata) can be encrypted with **TLS‑PSK 1.2**. No certificates are needed — the pre‑shared key is derived automatically from the token (`SHA‑256(token)`), so there is nothing extra to configure or exchange.

- **Server**: start with `--tls` (or `TLS=1`). When enabled the server **refuses plaintext worker handshakes** (`plaintext worker rejected (TLS required)`), so an attacker cannot force a downgrade.
- **Client**: enable `tls: { "enabled": true }` in `client.json`, or pass `--tls` / set `TLS=1`.
- TLS is **opt‑in and off by default**, so existing plaintext deployments keep working unchanged. When the server runs plaintext, clients with TLS enabled will not be able to connect (and vice versa) — both sides must agree.
- Ciphers: `PSK-AES256-GCM-SHA384`, `PSK-AES128-GCM-SHA256`, `PSK-CHACHA20-POLY1305` (TLS 1.2 only).

> **Note on the data plane**: TLS protects the control channel only. Forwarded TCP data and UDP datagrams still travel between server and client as they always did. For full end‑to‑end encryption of the *tunneled* traffic you still need to layer your own encryption on top (e.g. WireGuard, an SSH tunnel on another port, or application‑level TLS like Minecraft's built‑in encryption).

---

## IP Blacklist (with CIDR subnets)

The server can block IP addresses from using the tunnel. Both TCP connections and UDP datagrams from a blocked source are dropped immediately.

- **IPv4 and IPv6** are supported, including **CIDR subnets**: `203.0.113.7`, `203.0.113.0/24`, `2001:db8::/32`. IPv4 addresses are matched against their IPv4‑mapped form.
- **File formats**: one entry per line, `#` comments and blank lines allowed. Entries can also be separated by commas or semicolons.

Load blacklist entries from any of these (all are combined; invalid lines are ignored with a warning):

| Source | How |
|--------|-----|
| `--blacklist <file>` | CLI flag (recommended) |
| `BLACKLIST_FILE=<path>` | Environment variable |
| `IP_BLACKLIST="1.2.3.4, 5.6.7.0/24"` | Environment variable with inline entries |
| `blacklist.txt` | Auto‑loaded from the server's own directory if present |

Example `blacklist.txt`:

```
# deny one host
198.51.100.10
# deny a whole /24
198.51.100.0/24
# deny an IPv6 prefix
2001:db8:dead::/48
```

When the blacklist is active the server logs `IP blacklist active: N entries from <sources>` at startup, and each blocked attempt is logged (throttled per IP).

---

## IP Privacy in Logs (showip / hideip)

By default both the server and the client **mask the last 2 octets** of every IP address they print, so log files and consoles never leak full visitor/source addresses:

```
IPv4  203.0.113.10:51234  ->  203.0.xxx.xxx:51234
IPv6  2001:db8::1:51234   ->  2001:db8::xxxx:51234   (last 16 bits masked)
```

- Log lines are also kept **within the terminal width** — long IP lists in the stats block are truncated with `…` instead of wrapping.
- **`showip`** reveals full addresses; **`hideip`** masks them again.
- The choice persists to **`ip-settings.json`** next to the script (`{ "ipMode": "show" | "hide" }`), so a restart keeps your last choice. The file is written once you toggle; the default (hide) never creates it.

You can switch the mode in three ways (all equivalent):

| How | Example |
|-----|---------|
| CLI flag | `node server.js 8080 --showip` (persisted) |
| Environment | `SHOW_IP=1 node server.js` or `HIDE_IP=1 node client.js` |
| Live stdin command | write `showip` / `hideip` + Enter to the process stdin (Pterodactyl console) |

On startup the current mode is logged: `[*] IP display: hideip (last 2 octets masked in logs)` or `[*] IP display: showip (full addresses in logs)`, and toggling at runtime prints the same line so you can confirm the switch took effect.

> The server's own bind address (`BIND_HOST`/`--bind`, e.g. `0.0.0.0`) is kept verbatim — it is your public configuration, not a third‑party address.

---

## Graceful Shutdown (Pterodactyl-compatible)

Both processes shut down cleanly on `SIGINT` (Ctrl‑C), `SIGTERM`, `SIGHUP` and `SIGQUIT`. **Stdin is never used for stopping** — earlier versions also stopped on a command or EOF on stdin, but some hosts (Wings included) deliver an immediate stdin EOF at boot, which made the server stop by itself right after starting. Stopping now depends only on signals, so nothing can kill the process accidentally.

On shutdown the process closes listeners, drops active sessions/worker connections, closes the log file, and exits promptly (well under Pterodactyl's 30 s kill grace). This matters on Pterodactyl/Wings because the panel can stop a server in different ways:

| Pterodactyl stop mechanism | What the process sees | Result |
|----------------------------|----------------------|--------|
| `SIGTERM` (default docker stop) | `SIGTERM` signal | Clean shutdown |
| Egg stop command `^C` | `SIGINT` (Ctrl‑C) | Clean shutdown |

Shutdown is idempotent — repeated signals during teardown are ignored and cannot hang the process.

---

## Command Line Flags

Server (`node server.js [port] [options]`):

| Flag | Description |
|------|-------------|
| `--bind <ip>` | Address to listen on (default `0.0.0.0`) |
| `--tls` | Require TLS‑PSK on the worker control connection |
| `--blacklist <file>` | Load IP/CIDR blacklist entries from a file |
| `--showip` | Show full IP addresses in logs (saved to `ip-settings.json`) |
| `--hideip` | Mask the last 2 octets of IPs again (default, saved to `ip-settings.json`) |
| `--log-dir <path>` | Directory for log files (default `server-logs/`) |
| `--no-log` | Disable file logging |
| `-h, --help` | Show help and exit |
| `-v, --version` | Show version and exit |

Client (`node client.js [config.json] [options]`):

| Flag | Description |
|------|-------------|
| `--tls` | Encrypt the worker control connection (server must use `--tls`) |
| `--showip` | Show full IP addresses in logs (saved to `ip-settings.json`) |
| `--hideip` | Mask the last 2 octets of IPs again (default, saved to `ip-settings.json`) |
| `--log-dir <path>` | Directory for log files (default `worker-logs/`) |
| `--no-log` | Disable file logging |
| `-h, --help` | Show help and exit |
| `-v, --version` | Show version and exit |

`--version` and `--help` work on both programs, so you can always check the exact semantics:

```bash
node server.js --help
node client.js --version
```

---

## Monitoring

Both server and client print periodic statistics to the console:

- **Server** (every 5 s): worker TCP/UDP status, paused TCP sessions, **packets/s (PPs)** and **bandwidth** of tunneled traffic, connected IP addresses, recent IPs (last 5 minutes), active session IPs.
- **Client** (every 1 s): worker TCP/UDP status, number of active TCP/UDP sessions, **packets/s (PPs)** and **bandwidth** of tunneled traffic.

PPs and bandwidth are sampled once per tick from plain counters (an increment per packet), so they add no per-packet work and no measurable overhead to the forwarding path.

In a terminal the stats are shown as a **pinned status block** at the bottom while event logs scroll above it (colored, no full‑screen clears). The block is split into two side‑by‑side columns: the traffic/number metrics on the left (server: worker TCP/UDP, paused TCP, PPs, bandwidth; client: tunnel, worker TCP/UDP, TCP/UDP sessions) and the per‑traffic columns on the right (server: connected, recent and session IPs; client: PPs, bandwidth). Each column truncates its values with `…` to its own share of the terminal width, so long IP lists never wrap or push the metrics out of view.

When output is not a terminal (piped or run as a service) the client prints plain, greppable lines and stats are emitted only every 30 seconds (tunable with `STATS_INTERVAL_MS`). Statistics are console‑only and are not written to log files.

---

## Logging

Both `server.js` and `client.js` write a timestamped log file per run (`server-logs/` and `worker-logs/` by default). Logging is optional and the directory is configurable.

| Option | CLI flag | Environment variable |
|--------|----------|----------------------|
| Change the log directory | `--log-dir <path>` | `LOG_DIR=<path>` |
| Disable file logging | `--no-log` | `NO_LOG=1` |

Examples:

```bash
node server.js 8080 --log-dir /var/log/tunnel
node server.js 8080 --no-log
LOG_DIR=/var/log/tunnel node client.js
NO_LOG=1 node client.js /path/to/config.json
```

- The log directory is created automatically if it does not exist.
- When logging is disabled the program still prints everything to the console; only the file is skipped.

---

## Testing

The test suite spins up a real `server.js` + `client.js` + local origin service on loopback ports and checks behaviour end to end. It needs `git` (used to fetch the `v1.0.0` baseline for the regression test) and is Linux/macOS only (memory/CPU sampling reads `/proc`). No dev dependencies are required.

```bash
npm test        # full correctness suite (10 suites, see below)
npm run bench   # throughput + CPU benchmark (tune with N_READERS, DURATION_MS)
```

Individual suites:

```bash
npm run test:e2e          # slow-client isolation + stream integrity + UDP round-trip
npm run test:regression   # asserts the old v1.0.0 server FAILS the isolation check
npm run test:uplink       # upstream (client -> origin) byte-exact echo
npm run test:udp          # steady-state UDP flow is not throttled (game-style burst)
npm run test:mem          # asserts server RSS stays bounded under 100 slow clients
npm run test:auth         # wrong token is rejected; incomplete handshake times out; logs throttled
npm run test:ratelimit    # per-IP connection rate limit drops excess connections
npm run test:tls          # TLS control channel: works end-to-end, plaintext/wrong-token rejected
npm run test:blacklist    # IP blacklist: single IP + CIDR blocked on TCP and UDP
npm run test:privacy      # IP display privacy (hideip default, showip/hideip, persistence) + PPs/Bandwidth stats
```

The `test:regression` suite is the sensitivity check: it runs the pre-optimization `v1.0.0` server and expects it to stall a fast client while another client is paused. If that ever stops failing, the isolation guarantee has regressed.

---

## Security

### What is protected

- **Strong token**: 64 random bytes (`crypto.randomBytes(64)`, 1024 bits), stored in `token` with `0600` permissions. The comparison uses `crypto.timingSafeEqual` (constant time).
- **A failed/forged auth cannot hijack the worker**: the live worker reference is only replaced *after* a successful token check; a bad handshake only drops the attacker's own socket. A second connection presenting a valid token while a worker is already connected is rejected.
- **Auth deadline**: an unauthenticated TCP connection that looks like a worker handshake is closed after `AUTH_TIMEOUT_MS` (default 2 s), so a fake candidate cannot hold a socket or buffer.
- **Bounded pre-auth parsing**: handshake payloads are capped (`MAX_AUTH_DATA`, 4 KB).
- **Per-IP rate limiting** on TCP connections, plus a hard `MAX_CONNECTIONS` cap, so a connection flood cannot exhaust file descriptors/RAM. UDP limits only the rate of **new** endpoints per IP; established flows (e.g. game traffic) are never throttled.
- **Bounded bookkeeping**: `udpClients`, `sessionIPs` and `recentConnections` have hard caps, and repeated failure logs are throttled per IP.

### What is NOT protected (threat model)

- **Transport encryption is optional.** By default the control connection is plain TCP and the token travels in the clear inside `AUTH_HELLO`; start the server with `--tls` and the client with `tls.enabled` to encrypt the control channel with TLS‑PSK (see [Control Channel Security (TLS)](#control-channel-security-tls)). While TLS is enabled the server rejects plaintext worker handshakes, protecting against token theft by on‑path/MITM attackers. Without TLS, run the tunnel only over a trusted network.
- **Forwarded traffic is not encrypted.** TLS protects the *control* channel; the tunneled TCP/UDP data is still relayed unencrypted. If the tunneled service carries sensitive data you should layer your own encryption on top.
- **UDP is unauthenticated per datagram** and cannot be encrypted by this design; source addresses are spoofable, so UDP tunnels can be abused as relays/amplifiers.
- **The public port is an open relay by design.** Anyone who can reach it gets their TCP connection forwarded to your local service. Security of that service (SSH keys, game auth, etc.) is what actually protects it.
- Limits are **soft** protections for availability, not confidentiality.

---

## Environment Variables (Server)

| Variable       | Description                           | Default |
|----------------|---------------------------------------|---------|
| `PORT` / `SERVER_PORT` | Port to listen on (also positional arg) | (prompt) |
| `BIND_HOST`    | Address to listen on (also `--bind`) | `0.0.0.0` |
| `TLS` / `TLS_ENABLED` | Set to `1`/`true` to require TLS‑PSK on the control channel (also `--tls`) | (disabled) |
| `IP_BLACKLIST` | Inline IP/CIDR blacklist entries, comma/`;`/newline separated | (none) |
| `BLACKLIST_FILE` | Load IP/CIDR blacklist entries from a file (also `--blacklist`) | (none) |
| `SHOW_IP` / `HIDE_IP` | Set `SHOW_IP=1` to reveal full IPs, `HIDE_IP=1` to mask the last 2 octets (also `--showip`/`--hideip`; persisted to `ip-settings.json`) | `hide` (masked) |
| `STATS_INTERVAL_MS` | Min interval between `[stats]` lines when output is not a TTY | `30000` (30 s) |
| `LOG_DIR`      | Directory for log files (also `--log-dir`) | `server-logs/` |
| `NO_LOG`       | Set to `1` to disable file logging (also `--no-log`) | (enabled) |
| `CLIENT_SOCKET_HIGH_WATERMARK` | Write buffer threshold (bytes) for public client sockets before backpressure kicks in | `262144` (256 KB) |
| `MAX_PER_SESSION_QUEUE` | Max queued bytes for a single slow client before its session is force‑closed | `4194304` (4 MB) |
| `GLOBAL_QUEUE_BUDGET` | Max total queued bytes across all slow clients before sessions are force‑closed | `67108864` (64 MB) |
| `AUTH_TIMEOUT_MS` | Max time an unauthenticated worker candidate may hold its socket | `2000` |
| `MAX_CONNECTIONS` | Hard cap on concurrent TCP connections | `4096` |
| `CONN_RATE_LIMIT_PER_IP` | Max new TCP connections per IP per second | `50` |
| `UDP_NEW_CLIENT_RATE_LIMIT_PER_IP` | Max **new** UDP client endpoints per IP per second (does not limit steady-state packet flow) | `50` |
| `LOG_FAIL_THROTTLE_MS` | Minimum interval between failure logs for the same IP | `10000` |
| `MAX_UDP_CLIENTS` | Hard cap on tracked UDP client endpoints | `10000` |
| `MAX_SESSION_IPS` | Hard cap on tracked session/recent IPs | `100000` |

---

## Environment Variables (Client)

| Variable       | Description                           | Default |
|----------------|---------------------------------------|---------|
| `TLS` / `TLS_ENABLED` | Set to `1`/`true` to encrypt the control channel (also `--tls` or `tls.enabled` in config) | (disabled) |
| `SHOW_IP` / `HIDE_IP` | Set `SHOW_IP=1` to reveal full IPs, `HIDE_IP=1` to mask the last 2 octets (also `--showip`/`--hideip`; persisted to `ip-settings.json`) | `hide` (masked) |
| `STATS_INTERVAL_MS` | Min interval between `[stats]` lines when output is not a TTY | `30000` (30 s) |
| `LOG_DIR`      | Directory for log files (also `--log-dir`) | `worker-logs/` |
| `NO_LOG`       | Set to `1` to disable file logging (also `--no-log`) | (enabled) |
| `UDP_SESSION_TIMEOUT_MS` | Idle timeout for per‑source UDP sessions. Active flows refresh on every packet, so game traffic is never evicted | `60000` (60 s) |
| `MAX_UDP_SESSIONS` | Hard cap on tracked per‑source UDP sessions (LRU eviction when full) | `4096` |

---

## Troubleshooting

| Symptom | Likely Cause | Solution |
|---------|--------------|----------|
| Connection refused | Server not running or firewall blocking port | Start the server; allow TCP and UDP on the port in the firewall. |
| Authentication failed | Token mismatch | Copy the exact token from the server's `token` file to `client.json`. |
| "TLS required" / connection drops instantly | One side has TLS on and the other off | Enable TLS on both sides (server `--tls`, client `tls.enabled: true`). |
| IP is blocked (TCP dropped / UDP ignored) | Blacklist entry matches the source IP | Remove the IP/CIDR from `blacklist.txt`, `--blacklist <file>`, or `IP_BLACKLIST`. |
| Both sides kept the same `--tls` but connection still fails | `token` file predates TLS / was regenerated | TLS derives its key from the token — delete `token`, restart the server, and copy the new value to the client. |
| UDP not working | UDP port blocked or client UDP socket not connected | Ensure both TCP and UDP are open on the hosting firewall. Check client logs for UDP errors. |
| High memory usage | Too many slow clients buffering data | Lower `GLOBAL_QUEUE_BUDGET` or `MAX_PER_SESSION_QUEUE` (env vars on the server). |
| Client disconnects repeatedly | Heartbeat timeout | Check network stability; increase `HEARTBEAT_TIMEOUT_MS` in the code if needed. |

---

## License

This project is licensed under the GNU General Public License v3.0 or later (GPL-3.0-or-later). See the [LICENSE](LICENSE) file for the full text. You are free to use, modify, and redistribute it under the terms of that license.

---

## Contributing

Contributions are welcome. Please open an issue or pull request for improvements, bug fixes, or new features.