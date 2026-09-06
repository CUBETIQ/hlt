import { Argument, Command, InvalidArgumentError, program } from "commander";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { initConfigFileClient, startClient } from "./api";
import { PROFILE_DEFAULT, PROFILE_PATH, SERVER_DEFAULT_URL } from "./constant";
import { listProfile } from "./manage";
import { createProxyServer } from "./proxy";
import { createProxyServer as createProxyTCPServer } from "./proxy_tcp";
import { getToken } from './sdk';
import { confirmPublicShare, createFileServer } from "./serve";
import { checkForUpdate, runUpgrade, updateBanner } from "./update";
import { generateUUID, isValidHost, isValidUrl, randomPort } from "./util";
import { startWebhookServer } from "./webhook";

const packageInfo = require("../package.json");

program
  .name("hlt")
  .description(
    "CUBETIQ HTTP tunnel client for fast, scalable, and secure local tunneling"
  )
  .version(`v${packageInfo.version}`);

/**
 * Options every tunnel-starting command shares. `--server`/`--token` override
 * the stored profile (and together make the profile optional entirely).
 */
const tunnelOptions = (cmd: Command): Command =>
  cmd
    .option(
      "-S, --server <url>",
      "server url, overrides the profile (comma separated for failover nodes)"
    )
    .option("-t, --token <jwt>", "auth token, overrides the profile")
    // No default: each command applies its own (start -> "default",
    // webhook -> "webhook"), and the client falls back to "default" anyway.
    .option("-p, --profile <string>", `profile name (default: "${PROFILE_DEFAULT}")`)
    .option("-k, --key <string>", "client api key for authentication access")
    .option(
      "-n, --name <names>",
      "comma separated public tunnel names to reserve (default: client id)"
    )
    .option("--log-level <level>", "silent | error | warn | info | debug", "info")
    .option("-q, --quiet", "only log errors (the live stats line stays)", false)
    .option("-d, --debug", "verbose logging", false)
    .option("--no-stats", "hide the live stats line")
    .option("--no-update-check", "skip the daily version check");

/** Normalise the shared flags into the Options shape the client expects. */
const tunnelArgs = (options: any) => ({
  ...options,
  logLevel: options.debug ? "debug" : options.quiet ? "error" : options.logLevel,
  names: options.name
    ? String(options.name).split(",").map((s: string) => s.trim()).filter(Boolean)
    : undefined,
});

/** Non-blocking: never delays the tunnel, never fails the command. */
const noticeUpdate = (options: any) => {
  if (options.updateCheck === false) return;
  checkForUpdate(packageInfo.version)
    .then((latest) => {
      if (latest) console.log(`\n${updateBanner(latest, packageInfo.version)}\n`);
    })
    .catch(() => { });
};

// init
program
  .command("init")
  .description("initialize client configuration and acquire JWT token")
  .option("-S, --server <string>", "setting server url", SERVER_DEFAULT_URL)
  .option(
    "-t, --token <string>",
    "setting token (defaults to auto-acquiring from server)",
    ""
  )
  .option("-c, --client <string>", "setting client id (auto generate uuid)")
  .option(
    "-k, --key <string>",
    "setting client api key for authentication access"
  )
  .option("-p, --profile <string>", "setting profile name", PROFILE_DEFAULT)
  .option("-f, --force", "force to generate new client and token", false)
  .action(async (options) => {
    initConfigFileClient(options);
  });

// start
tunnelOptions(
  program
    .command("start")
    .description("start a connection with specific port")
    .argument("<port> | <address>", "local server port number or address", (value) => {
      if (isValidHost(value)) {
        return value;
      }

      const port = parseInt(value, 10);
      if (isNaN(port)) {
        throw new InvalidArgumentError("Not a number or valid address.");
      }
      return port;
    })
)
  .option("-s, --suffix <string>", "suffix for client name")
  .option(
    "-K, --keep_connection <boolean>",
    "keep connection for client and old connection will be closed (override connection)",
    true
  )
  .option("-h, --host <string>", "local host value", "localhost")
  .option("-o, --origin <string>", "change request origin")
  .option(
    "-H, --host-header <value>",
    "host header sent to the local app: preserve (default), rewrite (use the local host:port — needed by Next.js/Vite dev servers that 403 cross-origin /_next/* requests), or an explicit host",
    "preserve"
  )
  .action((portOrAddress, options) => {
    noticeUpdate(options);
    startClient({
      port: portOrAddress,
      address: portOrAddress,
      options: tunnelArgs(options),
    })
  });

// serve — publish a local folder over the tunnel
tunnelOptions(
  program
    .command("serve")
    .description("serve a local folder (static file browser) and publish it over a tunnel")
    .argument("[dir]", "directory to serve", ".")
)
  .option("--port <number>", "local port for the file server (default: random)")
  .option("--bind <address>", "local bind address", "127.0.0.1")
  .option("--auth <user:pass>", "protect the share with HTTP basic auth")
  .option("--no-listing", "do not show a directory index (only direct file paths)")
  .option("-y, --yes", "skip the public-exposure confirmation prompt", false)
  .option("--local", "serve locally only, do not open a tunnel", false)
  .action(async (dir, options) => {
    const listing = options.listing !== false;
    if (!options.local) {
      const ok = await confirmPublicShare(dir, {
        auth: options.auth,
        listing,
        assumeYes: options.yes,
      });
      if (!ok) {
        console.log("\x1b[90mCancelled — nothing was published.\x1b[0m");
        process.exit(0);
      }
    }

    const port = parseInt(options.port, 10) || randomPort();
    const server = createFileServer(dir, {
      listing,
      auth: options.auth,
      bind: options.bind,
    });

    server.on("error", (err) => {
      console.error(`\x1b[31m✖ File server error:\x1b[0m ${err.message}`);
      process.exit(1);
    });

    server.listen(port, options.bind, () => {
      console.log(
        `\x1b[36m➜ Serving:\x1b[0m ${path.resolve(dir)} on http://${options.bind}:${port}` +
        (options.auth ? " \x1b[32m(basic auth)\x1b[0m" : "")
      );
      if (options.local) return;

      noticeUpdate(options);
      startClient({
        port,
        options: { ...tunnelArgs(options), host: options.bind, autoinit: true },
      });
    });
  });

// upgrade
program
  .command("upgrade")
  .description("upgrade the hlt cli to the latest published version")
  .action(async () => {
    const latest = await checkForUpdate(packageInfo.version);
    if (!latest) {
      console.log(`\x1b[32m✔ hlt v${packageInfo.version} is up to date.\x1b[0m`);
      return;
    }
    console.log(`hlt v${packageInfo.version} → \x1b[32mv${latest}\x1b[0m`);
    process.exit(await runUpgrade());
  });



// webhook
tunnelOptions(
  program
    .command("webhook")
    .description("start a webhook server with specific port")
    .option("--port <number>", "local server port number", `${randomPort()}`)
)
  .action((options) => {
    const port = options.port || randomPort();
    startWebhookServer(port);

    const profile = options.profile || "webhook";
    console.log(`Start webhook: ${port} via hlt client with profile: ${profile}`);
    noticeUpdate(options);
    startClient({
      port,
      options: { ...tunnelArgs(options), profile, autoinit: true },
    })
  });

// config
program
  .command("config")
  .description("create and update config file for connection")
  .addArgument(
    new Argument("<type>", "config type").choices([
      "access",
      "token",
      "server",
      "client",
      "key",
    ])
  )
  .argument("<value>", "config value")
  .option("-p, --profile <string>", "setting profile name", PROFILE_DEFAULT)
  .action(async (type, value, options) => {
    if (!type) {
      console.error("type config is required!");
      return;
    }

    const configDir = path.resolve(os.homedir(), PROFILE_PATH);

    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir);
      console.log(`config file ${configDir} was created`);
    }

    let config: any = {};
    const configFilename = `${options.profile}.json`;
    const configFilePath = path.resolve(configDir, configFilename);

    if (fs.existsSync(configFilePath)) {
      config = JSON.parse(fs.readFileSync(configFilePath, "utf8"));
    }

    if (!config.server) {
      config.server = SERVER_DEFAULT_URL;
    }

    // Error Code status
    let errorCode = 0;

    if (type === "token" || type === "jwt") {
      if (value === "generate" || value === "new") {
        console.log(`Requesting token from ${config.server}...`);
        await getToken(config.server, {
          clientId: config.clientId,
          apiKey: config.apiKey,
          // Renewal of an id we already hold.
          currentToken: config.token,
        })
          .then((resp: any) => {
            if (resp.data?.token) {
              config.token = resp.data?.token;
              if (resp.data?.clientId) config.clientId = resp.data.clientId;
              console.log("Token acquired successfully!");
            } else {
              errorCode = 1;
              console.error("Generate token failed: empty response from server", resp);
              return;
            }
          })
          .catch((err: any) => {
            errorCode = 1;
            console.error("Cannot get token from server:", err?.message || err);
            return;
          });
      } else {
        config.token = value;
      }
    } else if (type === "server") {
      config.server = value;
    } else if (type === "clientId" || type === "client") {
      if (!value || value === "" || value === "new") {
        config.clientId = generateUUID();
      } else {
        config.clientId = value;
      }
      console.log(`client: ${config.clientId} was set to config`);
    } else if (type === "apiKey" || type === "key") {
      config.apiKey = value;
    } else if (type === "access") {
      console.log("Notice: Access types are consolidated into unified JWT authentication.");
    }

    if (!config.clientId && config.apiKey) {
      config.clientId = config.apiKey;
    }

    if (errorCode === 0) {
      fs.writeFileSync(configFilePath, JSON.stringify(config, null, 2));
      console.log(`${type} config saved successfully to: ${configFilePath}`);
    }
  });

// config
program
  .command("config-get")
  .description("get type from config file")
  .addArgument(
    new Argument("<type>", "config type").choices([
      "access",
      "token",
      "server",
      "client",
      "key",
    ])
  )
  .option("-p, --profile <string>", "setting profile name", PROFILE_DEFAULT)
  .action(async (type, options) => {
    if (!type) {
      console.error("type config is required!");
      return;
    }

    const configDir = path.resolve(os.homedir(), PROFILE_PATH);
    if (!fs.existsSync(configDir)) {
      console.log(`config file ${configDir} not found`);
      return;
    }

    let config: any = {};
    const configFilename = `${options.profile}.json`;
    const configFilePath = path.resolve(configDir, configFilename);

    if (fs.existsSync(configFilePath)) {
      config = JSON.parse(fs.readFileSync(configFilePath, "utf8"));
    } else {
      console.log(`config file ${configFilePath} not found`);
      return;
    }

    if (type === "token" || type === "jwt") {
      console.log(config.token);
    } else if (type === "server") {
      console.log(config.server);
    } else if (type === "clientId" || type === "client") {
      console.log(config.clientId);
    } else if (type === "apiKey" || type === "key") {
      console.log(config.apiKey);
    } else if (type === "access") {
      console.log(config.access);
    } else {
      console.log('no config found for type: "' + type + '"');
    }
  });

// proxy
tunnelOptions(program.command("proxy"))
  .description("start a proxy server with specific port")
  .argument("<port>", "local server port number", (value) => {
    const port = parseInt(value, 10);
    if (isNaN(port)) {
      throw new InvalidArgumentError("Not a number.");
    }
    return port;
  })
  .argument("<target>", "target server url (https://google.com) or tcp (tcp://127.0.0.1:8080 or 127.0.0.1:8080)", (value) => {
    // Validate target
    if (!value) {
      throw new InvalidArgumentError("Target is required.");
    }

    // Check if target is url
    if (value.indexOf("http") === 0 || value.indexOf("https") === 0) {
      if (isValidUrl(value)) {
        return value;
      }

      throw new InvalidArgumentError("Target is not a valid url.");
    }

    if (value.indexOf("tcp") === 0) {
      // Remove tcp prefix from target
      const t = value.substring(6); // remove tcp prefix (tcp://)
      if (isValidHost(t)) {
        return value;
      }

      throw new InvalidArgumentError("Target is not a valid tcp host.");
    }

    // Check if target is host with port (tcp)
    const target = value.split(":");
    if (target.length === 2) {
      const port = parseInt(target[1], 10);
      if (isNaN(port)) {
        throw new InvalidArgumentError("Target port is not a number.");
      }

      return `tcp://${value}`;
    }

    if (isValidHost(value)) {
      return `tcp://${value}`
    }

    throw new InvalidArgumentError("Target is not a url or host with port.");
  })
  .action((port, target, options) => {
    const isTcp = target.indexOf("tcp") === 0;
    if (isTcp) {
      console.log("[TCP] Start proxy server with port:", port, "and target:", target);
      const t = target.substring(6); // remove tcp prefix (tcp://)
      const targetHost = t.split(":")[0];
      const targetPort = parseInt(t.split(":")[1], 10);
      const proxy = createProxyTCPServer(targetHost, targetPort, {
        proxyPort: port,
      });

      onConnectProxy(port, options);

      proxy.on("error", (err) => {
        console.error("Proxy server error:", err);
      });

      proxy.on("close", () => {
        console.log("Proxy server closed");
      });

    } else {
      console.log("[HTTP/HTTPS] Start proxy server with port:", port, "and target:", target);
      const proxy = createProxyServer(target, {
        proxyPort: port,
      });

      onConnectProxy(port, options);

      proxy.on("error", (err) => {
        console.error("Proxy server error:", err);
      });

      proxy.on("close", () => {
        console.log("Proxy server closed");
      });
    }
  });


/** Tunnel the proxy only when the caller supplied credentials to tunnel with. */
const onConnectProxy = (port: number, options: any) => {
  const canTunnel = options?.profile || (options?.server && options?.token);
  if (!canTunnel) return;

  console.log(
    `Start proxy: ${port} via hlt client with profile: ${options.profile || PROFILE_DEFAULT}`
  );
  startClient({
    port,
    options: tunnelArgs(options),
  })
}

// profile
program
  .command("profile")
  .description("manage profile")
  .option("-l, --list", "list all profiles", false)
  .action((options) => {
    if (options.list) {
      listProfile();
    } else {
      console.log("profile command is required");
    }
  });

program.parse();
