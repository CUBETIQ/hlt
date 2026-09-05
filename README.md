# HLT - High-Performance HTTP & WebSocket Tunnel

HLT is a lightweight, scalable, and ultra-fast HTTP and WebSocket tunneling system powered by [Bun](https://bun.sh). It exposes local development servers, APIs, Webhooks, and complex frontend applications (such as Next.js, React Fast Refresh, Vite HMR, and large file streams) to the public internet through a secure TCP multiplexed tunnel.

---

## Key Features & Architectural Improvements

- **Blazing Fast Performance**: Built on Bun with native streaming and optimized socket buffers.
- **WebSocket & HMR Reliability**: Full duplex streaming with unshifted initial head flushing, case-insensitive upgrade negotiation, and clean socket teardown for Next.js Fast Refresh and Vite/React HMR.
- **Zero-Leak Stream Multiplexing**: $O(1)$ stream dispatch via `TunnelSocketManager`. Single listener per event eliminates Node's `MaxListenersExceededWarning` and prevents memory bloat under heavy concurrent loads.
- **Threshold Backpressure Flow Control**: Engine.io buffer monitoring with drain safety timeouts prevents sender deadlocks and socket starvation during large file transfers.
- **Multi-Worker Cluster**: Built-in host-sticky TCP router (`cluster.js`) distributes incoming HTTP/WS traffic across CPU cores while keeping each client tunnel pinned to its worker.
- **Unified Security & JWT**: Single consolidated `/api/token` route for acquiring tokens with strict JWT validation across CLI and SDK.
- **Admin Management API**: RESTful management endpoints under `/admin/api` protected with JWT middleware.
- **Privacy-First Telemetry**: Aggregated counters (connections, requests, active sockets) stored in Redis or memory. Strictly **no** credentials, sensitive headers, or user payloads are ever tracked or stored.
- **Dual Client Support**: Use as a standalone CLI tool or embed into your JavaScript/TypeScript runtime (Node.js & Bun) via the SDK.

---

## Quick Start (Local Development)

### Prerequisites

- [Bun](https://bun.sh) v1.1+ (recommended: latest Bun)
- Node.js 18+ (optional, for client runtime compatibility)

### 1. Run Server Locally

```bash
cd server
bun install

# Start single server instance
bun run server

# OR start in clustered mode (auto-scales to CPU cores)
bun run start
```

The server listens on `http://localhost:3000`. Health check endpoint: `http://localhost:3000/_/health`.

### 2. Run Client CLI

```bash
cd client
bun install
bun run build

# Initialize configuration and acquire JWT token
bun run start init --server http://localhost:3000

# Tunnel local port 8080 to the public/server endpoint
bun run start 8080
```

---

## Client CLI & SDK Usage

### Global Installation (CLI)

```bash
npm install -g @cubetiq/hlt
# OR
bun add -g @cubetiq/hlt
```

#### CLI Commands

```bash
# 1. Initialize client config and acquire JWT token
hlt init -s https://tunnel.example.com

# 2. Forward local port 3000
hlt start 3000

# 3. Forward with custom subdomain / suffix
hlt start 3000 -s dev

# 4. Forward to remote IP / internal network address
hlt start 192.168.1.50:8080

# 5. Start webhook receiver
hlt webhook --port 8080

# 6. Manage profiles
hlt profile list
```

### Programmatic SDK (Node.js & Bun)

Install in your project:

```bash
npm install @cubetiq/hlt
# OR
bun add @cubetiq/hlt
```

#### TypeScript / JavaScript Example

```ts
import { HltClient, getToken } from "@cubetiq/hlt";

async function main() {
  // 1. Initialize client
  const hlt = new HltClient({
    server: "https://tunnel.example.com",
    // apiKey: "optional_server_api_key_if_registration_is_restricted",
  });

  // 2. Start tunnel forwarding to local port 3000
  const tunnel = await hlt.connect({
    port: 3000,
    host: "localhost",
    suffix: "myapp",
  });

  console.log("Public Tunnel URL:", tunnel.endpoint);

  // 3. Graceful shutdown on SIGINT / application stop
  process.on("SIGINT", () => {
    tunnel.stop();
    process.exit(0);
  });
}

main().catch(console.error);
```

---

## Web Admin Console

HLT includes a modern, high-performance Web Admin Console embedded directly with the server, built using **React 19**, **Tailwind CSS v4**, **shadcn UI**, **TanStack Query** (for background state polling & cache invalidation), and **TanStack Table** (for interactive data tables).

### Features
- **Live Cluster Overview**: Real-time KPI summary (active tunnels, routed requests, total sessions, uptime) and V8 memory heap/CPU gauges.
- **Active Tunnels Management**: Searchable and sortable table of all connected client sockets with per-host request counts and one-click disconnect actions.
- **Client Token Generator**: Admin workspace to issue cryptographically signed JWT credentials with customizable expiration periods and one-click copyable CLI / SDK commands.
- **Privacy-Preserving Telemetry**: Aggregate monotonic counters and traffic distribution tracking with zero retention of user payloads, headers, or tokens.

### Accessing the Web Console
- **Production URL**: `http://localhost:3000/admin` (or your configured server domain)
- **Local Development**: Run `cd web && bun install && bun run dev` to launch the Vite dev server with instant HMR and API proxy on `http://localhost:5173`.
- **Default Credentials**: Configured via `ADMIN_USERNAME` (default `admin`) and `ADMIN_PASSWORD` (default `admin123`).

---

## Production Deployment Guide

### Deployment via Docker Compose

HLT provides a production-ready `docker-compose.yml` leveraging lightweight `oven/bun:alpine` images and healthchecks.

```bash
# Clone the repository
git clone https://github.com/cubetiq/hlt.git
cd hlt

# Copy and configure environment variables
cp .env.example .env
nano .env

# Launch server with Docker Compose
docker compose up -d --build
```

### Dockerfile Highlights

- **Multi-Stage Build**: Installs production dependencies in a builder stage and copies them to an unprivileged Alpine runner (`USER bun`).
- **Minimal Image Size**: ~120MB total container footprint.
- **Built-in Healthcheck**: Probes `/_/health` via Bun's HTTP client every 30s.

---

## Server Clustering (High Concurrency)

HLT includes a high-performance cluster router (`server/cluster.js`) with host-sticky TCP proxying:

```
                  [ Public HTTP / WebSocket Traffic ]
                                   │
                                   ▼
                       ┌───────────────────────┐
                       │  Cluster Master (:3000)│
                       │  Host-Sticky TCP Proxy│
                       └───────────┬───────────┘
                                   │ IPC Socket Handover
             ┌─────────────────────┼─────────────────────┐
             ▼                     ▼                     ▼
     ┌───────────────┐     ┌───────────────┐     ┌───────────────┐
     │ Worker 1 (Bun)│     │ Worker 2 (Bun)│     │ Worker N (Bun)│
     └───────────────┘     └───────────────┘     └───────────────┘
```

To enable clustering:
```env
CLUSTER_ENABLED=true
WORKERS=auto  # 'auto' uses os.cpus().length, or specify a number (e.g. 4)
```

Worker processes register active tunnel client hosts with the master over IPC. Inbound requests for a given tunnel domain are handed off directly to the worker holding that client's socket connection, avoiding inter-worker proxying overhead.

---

## Security & Authentication

### 1. Tunnel Client Authentication

HLT enforces JWT token authentication on every WebSocket connection:
- Public or private token acquisition via `POST /api/token`.
- When `PUBLIC_TOKEN_REGISTRATION=false`, clients must supply a matching `SERVER_API_KEY` to acquire tokens.
- Sockets attempting to connect without a valid token signed by `SECRET_KEY` are rejected immediately with `401 Unauthorized`.

### 2. Admin Management API

The server exposes management routes under `/admin/api`:

| Method | Path | Description | Protected |
| :--- | :--- | :--- | :--- |
| `POST` | `/admin/api/auth/login` | Login with username/password to acquire Admin JWT | No |
| `GET` | `/admin/api/status` | Instance uptime, CPU/memory usage, active sockets | Yes (Bearer JWT) |
| `GET` | `/admin/api/sockets` | List connected tunnel sockets and stats | Yes (Bearer JWT) |
| `DELETE` | `/admin/api/sockets/:host` | Forcefully disconnect a client tunnel by host | Yes (Bearer JWT) |
| `GET` | `/admin/api/stats` | Global accumulated privacy-first metrics | Yes (Bearer JWT) |
| `POST` | `/admin/api/tokens/generate` | Generate long-lived tunnel tokens with custom claims | Yes (Bearer JWT) |

#### Example: Authenticating with Admin API

```bash
# 1. Login to get Admin JWT
TOKEN=$(curl -s -X POST http://localhost:3000/admin/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"your_admin_password"}' | jq -r .token)

# 2. Query server status
curl -s http://localhost:3000/admin/api/status \
  -H "Authorization: Bearer $TOKEN" | jq
```

---

## Privacy-First Telemetry

Telemetry records only non-identifying operational counters:
- `total_connections` & `total_disconnections`
- `active_sockets`
- `total_http_requests` & `total_ws_requests`
- Per-host request count and connection timestamps

**Privacy Guarantees**:
- No request headers (cookies, auth headers) are ever inspected or stored.
- No client payload data is ever logged or retained.
- When `REDIS_ENABLED=true`, aggregated counters use Redis hashes (`HINCRBY`) with zero retention of sensitive metadata.

---

## Environment Variable Reference

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3000` | HTTP & WebSocket server port |
| `TRUSTED_HOST` | `localhost:3000` | Host header reserved for server APIs (bypasses tunnel routing) |
| `TRUSTED_SECRET` | *(empty)* | Optional header token for trusted administration |
| `CLUSTER_ENABLED` | `true` | Enable multi-process clustering |
| `WORKERS` | `auto` | Number of worker processes (`auto` or numeric count) |
| `SECRET_KEY` | *(required)* | Secret key used to sign and verify client tunnel JWTs |
| `VERIFY_TOKEN` | *(optional)* | Secondary token claim check |
| `PUBLIC_TOKEN_REGISTRATION` | `true` | When `false`, requires `SERVER_API_KEY` to generate tokens |
| `SERVER_API_KEY` | *(empty)* | API key required if public registration is disabled |
| `ADMIN_USERNAME` | `admin` | Admin dashboard/API username |
| `ADMIN_PASSWORD` | `admin123` | Admin dashboard/API password |
| `ADMIN_JWT_SECRET` | *(secret)* | Secret used to sign Admin management JWT tokens |
| `ADMIN_JWT_EXPIRES_IN` | `24h` | Expiration duration for Admin tokens |
| `REDIS_ENABLED` | `false` | Enable Redis adapter for telemetry and multi-node sync |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL |
| `MAX_HTTP_BUFFER_SIZE` | `500000000` | Maximum socket buffer size in bytes (default: 500MB) |
| `CONCURRENCY_LIMIT` | `1000` | Concurrency limit for active streams per socket |

---

## Reverse Proxy Configuration (Nginx)

When deploying behind Nginx with wildcard domain support (e.g., `*.tunnel.example.com`):

```nginx
server {
    listen 80;
    server_name tunnel.example.com *.tunnel.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Disable buffering for line-speed chunked responses
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
        client_max_body_size 0;
    }
}
```

---

## License

ISC License. Copyright (c) 2026 Cubis.
