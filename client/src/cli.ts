import { Argument, InvalidArgumentError, program } from "commander";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { initConfigFileClient, startClient } from "./api";
import { PROFILE_DEFAULT, PROFILE_PATH, SERVER_DEFAULT_URL, TOKEN_FREE } from "./constant";
import { listProfile } from "./manage";
import { createProxyServer } from "./proxy";
import { createProxyServer as createProxyTCPServer } from "./proxy_tcp";
import { getTokenFree } from './sdk';
import { generateUUID, isValidHost, isValidUrl, randomPort } from "./util";
import { startWebhookServer } from "./webhook";

const packageInfo = require("../package.json");

program
  .name("hlt")
  .description(
    "CUBETIQ HTTP tunnel client with free access for local tunneling"
  )
  .version(`v${packageInfo.version}`);

// init
program
  .command("init")
  .description("generate a new client and token with free access")
  .option("-s, --server <string>", "setting server url", SERVER_DEFAULT_URL)
  .option(
    "-t, --token <string>",
    "setting token (default generate FREE access token)",
    ""
  )
  .option("-a, --access <string>", "setting token access type", TOKEN_FREE)
  .option("-c, --client <string>", "setting client (auto generate uuid)")
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
  .option("-s, --suffix <string>", "suffix for client name")
  .option(
    "-K, --keep_connection <boolean>",
    "keep connection for client and old connection will be closed (override connection)",
    true
  )
  .option(
    "-k --key <string>",
    "setting client api key for authentication access"
  )
  .option("-a, --access <string>", "access type (FREE)", TOKEN_FREE)
  .option("-p, --profile <string>", "profile name", PROFILE_DEFAULT)
  .option("-h, --host <string>", "local host value", "localhost")
  .option("-o, --origin <string>", "change request origin")
  .action((portOrAddress, options) => {
    startClient({
      port: portOrAddress,
      address: portOrAddress,
      options,
    })
  });



// webhook
program
  .command("webhook")
  .description("start a webhook server with specific port")
  .option("--port <number>", "local server port number", `${randomPort()}`)
  .option("-p, --profile <string>", "setting profile name for connect with hlt server (webhook with current local port)")
  .action((options) => {
    const port = options.port || randomPort();
    startWebhookServer(port);

    // Check if profile is not set, please set default profile to webhook
    if (!options?.profile) {
      options.profile = "webhook"
      options.autoinit = true;
      console.log(`Start webhook: ${port} via hlt client with profile: ${options.profile}`);
      startClient({
        port,
        options,
      })
    } else {
      console.log(`Start webhook: ${port} via hlt client with profile: ${options.profile}`);
      startClient({
        port,
        options,
      })
    }
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
      config.token = value;
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
      config.access = (value && value.toUpperCase().trim()) || TOKEN_FREE;

      // FREE
      if (config.access === TOKEN_FREE) {
        await getTokenFree(config.server)
          .then((resp: any) => {
            if (resp.data?.token) {
              config.token = resp.data?.token;
            } else {
              errorCode = 1;
              console.error("Generate free token failed, return with null or empty from server!", resp);
              return;
            }
          })
          .catch((err: any) => {
            errorCode = 1;
            console.error("cannot get free token from server", err);
            return;
          });
      }
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
program
  .command("proxy")
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
  .option("-p, --profile <string>", "setting profile name for connect with hlt server (proxy with current local port)")
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


const onConnectProxy = (port: number, options: any) => {
  if (options?.profile) {
    console.log(`Start proxy: ${port} via hlt client with profile: ${options.profile}`);
    startClient({
      port,
      options,
    })
  }
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
