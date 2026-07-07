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
- Run it. If you do not specify a port via environment variables, you will be prompted to enter one.

```bash
node server.js
```

To set the port in advance:

```bash
PORT=8080 node server.js
# or
SERVER_PORT=8080 node server.js
```

- On first start, the server creates a `token` file in its directory. This file contains a random 64‑byte hex string. **Copy this token**, you will need it for the client.

- The server automatically creates a `server-logs/` folder and writes a new log file per run (timestamped).

---

### 3. Client setup (on your local machine)

- Place `client.js` on your local machine.
- Create a configuration file named `client.json` in the same directory. If the client is run without it, it will generate an example configuration that you can edit.

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

Run the client:

```bash
node client.js
```

If your config is in another location:

```bash
node client.js /path/to/your/config.json
```

- The client creates a `worker-logs/` folder and writes a new log file per run.

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
- `UDP_IN`, `UDP_OUT`
- `AUTH_HELLO`, `AUTH_OK`, `AUTH_FAIL`
- `HEARTBEAT_PING`, `HEARTBEAT_PONG`

Authentication is performed by sending `TUN1 <token>` inside an `AUTH_HELLO` message.

### Flow Control and Memory Management

- The parser buffer is capped at 1 MB to prevent memory exhaustion.
- Each TCP session has a queue limit of 4 MB; if exceeded, the session is force‑closed.
- Global backpressure: if the client's local sockets cannot keep up, the server pauses reading from the client.
- The client also pauses reading from local sockets when its control connection's write buffer is full.
- These mechanisms ensure stability under heavy load.

---

## Token Management

- The server generates the token automatically on first start and saves it in a `token` file (permissions: read/write only for the owner).
- To regenerate the token, delete the `token` file and restart the server.
- The client must use the same token in its `client.json`.

---

## Monitoring

Both server and client print periodic statistics to the console every 5 seconds:

- **Server**: worker TCP/UDP status, active IP addresses, recent IPs (last 5 minutes), active session IPs.
- **Client**: worker TCP/UDP status, number of active TCP/UDP sessions.

These statistics are console‑only and are not written to log files.

---

## Environment Variables (Server)

| Variable       | Description                           | Default |
|----------------|---------------------------------------|---------|
| `SERVER_PORT`  | Port the server listens on            | (prompt) |
| `PORT`         | Alternative environment variable for port | (prompt) |

---

## Troubleshooting

| Symptom | Likely Cause | Solution |
|---------|--------------|----------|
| Connection refused | Server not running or firewall blocking port | Start the server; allow TCP and UDP on the port in the firewall. |
| Authentication failed | Token mismatch | Copy the exact token from the server's `token` file to `client.json`. |
| UDP not working | UDP port blocked or client UDP socket not connected | Ensure both TCP and UDP are open on the hosting firewall. Check client logs for UDP errors. |
| High memory usage | Queue limits exceeded | Reduce traffic or increase `MAX_PER_SESSION_QUEUE` (server) / adjust limits in the code. |
| Client disconnects repeatedly | Heartbeat timeout | Check network stability; increase `HEARTBEAT_TIMEOUT_MS` in the code if needed. |

---

## License

MIT, free to use, modify, and distribute.

---

## Contributing

Contributions are welcome. Please open an issue or pull request for improvements, bug fixes, or new features.