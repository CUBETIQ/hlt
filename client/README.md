# @cubetiq/hlt

Lightweight HTTP/WebSocket tunnel client for Node.js and Bun. Expose a local port to the internet through the HLT server.

## Install

```shell
npm i -g @cubetiq/hlt
```

Or run without installing:

```shell
npx -y @cubetiq/hlt <command>
```

## Quick start

```shell
# One-time setup: creates a client id and acquires a token
hlt init
```

```shell
# Expose local port 3000
hlt start 3000
```

Your public URL prints on connect, followed by a live status line:

```
➜ Forwarding: https://myapp.example.com -> http://localhost:3000
2m14s  38 reqs (36 http · 2 ws)  ↓ 1.2 MB  ↑ 8.4 MB  ● 1 ws open
```

No config file? Pass the server and token directly — nothing is written to disk:

```shell
hlt start 3000 --server https://your-server.com -t <token>
```

## Common use cases

**Expose a dev server**

```shell
hlt start 3000
```

**Give it a memorable name** (`https://myapp.example.com` instead of a random id)

```shell
hlt start 3000 -n myapp
```

**Reserve multiple names for one tunnel**

```shell
hlt start 3000 -n myapp,myapp-staging
```

**Forward to another host, not just localhost**

```shell
hlt start 3000 -h 192.168.1.50
```

**Point at a full address directly**

```shell
hlt start 192.168.1.50:8080
```

**Use a different server**

```shell
hlt config server https://your-server.com
hlt start 3000
```

**Run multiple tunnels with separate identities** (profiles)

```shell
hlt init -p work
hlt start 3000 -p work

hlt init -p personal
hlt start 4000 -p personal
```

**Share a folder** (streaming static file server + browsable index)

```shell
hlt serve ./dist                 # asks you to confirm before it goes public
hlt serve ./dist --auth me:s3cret   # protect it with basic auth
hlt serve ./dist --no-listing    # only direct file paths, no index
hlt serve ./dist --local         # serve locally, no tunnel
```

Files are streamed (never buffered in memory) and `Range` requests are honoured,
so large downloads resume and media seeks work.

**Receive webhooks locally**

```shell
hlt webhook --port 3000
```

**Local reverse proxy** (no tunnel, just forwards traffic on your machine)

```shell
hlt proxy 8080 https://api.example.com
hlt proxy 8080 tcp://127.0.0.1:5432
```

## Client identity

Your token carries a **client id**, and public tunnel names are locked to it. The
server issues that id — `hlt init` stores whatever it gets back — so no other
machine can be issued a token for your id and take over your names.

- Renewing (`hlt init -f`, `hlt config token new`) presents your current token
  and keeps the same id.
- Lost the token but kept the id? `hlt init -p <profile> -f` issues a fresh
  identity; your public URL changes with it.
- Each profile has its own id, so `-p work` and `-p personal` never collide.

## Config

```shell
hlt config server <url>       # set server URL
hlt config token <token>      # set token manually
hlt config token new          # request a fresh token from the server
hlt config client <id>        # set client id (or "new" to generate one)
hlt config key <apiKey>       # set API key
hlt config-get <type>         # read back a config value
hlt profile --list            # list saved profiles
```

Config is stored per profile under `~/.hlt/<profile>.json`.

## Options reference (`hlt start`, `hlt serve`)

| Flag | Description |
| --- | --- |
| `-S, --server <url>` | server URL, overrides the profile (comma-separated for failover nodes) |
| `-t, --token <jwt>` | token, overrides the profile — with `--server` no profile is needed |
| `-p, --profile <name>` | profile to use (default: `default`) |
| `-n, --name <names>` | comma-separated public tunnel names |
| `-s, --suffix <string>` | suffix appended to the client name |
| `-h, --host <string>` | local host to forward to (default: `localhost`) |
| `-H, --host-header <v>` | `preserve` (default), `rewrite`, or an explicit Host value |
| `-o, --origin <string>` | override request origin |
| `-K, --keep_connection` | evict any existing connection on the same name (default: `true`) |
| `-k, --key <string>` | client API key for authentication |
| `--log-level <level>` | `silent`, `error`, `warn`, `info` (default), `debug` |
| `-q, --quiet` | only log errors — the live stats line keeps running |
| `-d, --debug` | verbose logging |
| `--no-stats` | hide the live stats line |
| `--no-update-check` | skip the daily version check |

`hlt serve` adds `--port`, `--bind`, `--auth user:pass`, `--no-listing`, `--local` and `-y, --yes`.

**Dev servers returning 403** (Next.js on `/_next/*`, Vite): they reject requests
whose `Host`/`Origin` is not their own. Use `-H rewrite`, or allow the tunnel host
in the framework config (Next.js: `allowedDevOrigins`).

## Staying current

```shell
hlt upgrade    # installs the latest version with your package manager
```

The CLI checks for a new version once a day and prints a notice; set
`HLT_NO_UPDATE_CHECK=1` or pass `--no-update-check` to turn it off.

## SDK usage

```ts
import { HltClient } from "@cubetiq/hlt";

const hlt = new HltClient({ server: "https://your-server.com" });
const tunnel = await hlt.connect({ port: 3000, names: ["myapp"] });

console.log(tunnel.endpoint); // https://myapp.your-server.com
console.log(tunnel.stats);    // { requests, bytesIn, bytesOut, wsOpen, ... }

// later
tunnel.stop();
```

Serve a folder programmatically:

```ts
import { createFileServer } from "@cubetiq/hlt";

const server = createFileServer("./public", { auth: "me:s3cret" });
server.listen(4000, "127.0.0.1");
```

## Contributors

- Sambo Chea <sombochea@cubis.tech>
