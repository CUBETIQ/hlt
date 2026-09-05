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

# Expose local port 3000
hlt start 3000
```

Your public URL prints on connect.

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

**Receive webhooks locally**

```shell
hlt webhook --port 3000
```

**Local reverse proxy** (no tunnel, just forwards traffic on your machine)

```shell
hlt proxy 8080 https://api.example.com
hlt proxy 8080 tcp://127.0.0.1:5432
```

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

## Options reference (`hlt start`)

| Flag | Description |
| --- | --- |
| `-p, --profile <name>` | profile to use (default: `default`) |
| `-n, --name <names>` | comma-separated public tunnel names |
| `-s, --suffix <string>` | suffix appended to the client name |
| `-h, --host <string>` | local host to forward to (default: `localhost`) |
| `-o, --origin <string>` | override request origin |
| `-K, --keep_connection` | evict any existing connection on the same name (default: `true`) |
| `-k, --key <string>` | client API key for authentication |

## SDK usage

```ts
import { HltClient } from "@cubetiq/hlt";

const hlt = new HltClient({ server: "https://your-server.com" });
const tunnel = await hlt.connect({ port: 3000, names: ["myapp"] });

console.log(tunnel.endpoint); // https://myapp.your-server.com

// later
tunnel.stop();
```

## Contributors

- Sambo Chea <sombochea@cubis.tech>
