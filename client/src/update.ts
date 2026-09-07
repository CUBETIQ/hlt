import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PROFILE_PATH } from "./constant";

const PACKAGE_NAME = "@cubetiq/hlt";
const REGISTRY = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CACHE_FILE = () => path.resolve(os.homedir(), PROFILE_PATH, ".update-check.json");

/** semver-ish compare, enough for x.y.z and x.y.z-tag. */
function isNewer(latest: string, current: string): boolean {
    const parse = (v: string) => v.split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
    const [a, b] = [parse(latest), parse(current)];
    for (let i = 0; i < 3; i++) {
        if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
    }
    return false;
}

function readCache(): { checkedAt: number; latest: string } | null {
    try {
        return JSON.parse(fs.readFileSync(CACHE_FILE(), "utf8"));
    } catch {
        return null;
    }
}

function writeCache(latest: string) {
    try {
        fs.mkdirSync(path.dirname(CACHE_FILE()), { recursive: true });
        fs.writeFileSync(CACHE_FILE(), JSON.stringify({ checkedAt: Date.now(), latest }));
    } catch {
        // A missing cache only means we check again next run.
    }
}

/**
 * Look up the published version, at most once a day. Never throws and never
 * blocks the tunnel: the caller fires it and forgets.
 */
export async function checkForUpdate(
    currentVersion: string,
    options: { force?: boolean } = {}
): Promise<string | null> {
    // `force` is the explicit `hlt upgrade`: always ask the registry, and ignore
    // the opt-outs meant for the passive daily check.
    if (!options.force && (process.env.HLT_NO_UPDATE_CHECK === "1" || process.env.CI)) {
        return null;
    }

    const cached = readCache();
    if (!options.force && cached && Date.now() - cached.checkedAt < CHECK_INTERVAL_MS) {
        return isNewer(cached.latest, currentVersion) ? cached.latest : null;
    }

    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2500);
        // Plain JSON: the abbreviated "vnd.npm.install-v1+json" type is only
        // accepted on the full packument, and the registry answers 406 for it
        // here — which silently disabled every update check.
        const res = await fetch(REGISTRY, {
            signal: controller.signal,
            headers: { accept: "application/json" },
        });
        clearTimeout(timer);
        if (!res.ok) return null;

        const latest = ((await res.json()) as { version?: string })?.version;
        if (!latest) return null;
        writeCache(latest);
        return isNewer(latest, currentVersion) ? latest : null;
    } catch {
        return null;
    }
}

/**
 * Where this copy of the CLI actually lives at runtime.
 *
 * Not `__dirname`: the bundler inlines it as a build-time constant (the author's
 * source directory), so it says nothing about the installed location.
 */
export function runtimeDir(): string {
    const entry = process.argv[1] || require.main?.filename || "";
    return entry ? path.dirname(entry) : "";
}

/**
 * True when this process is the copy npx unpacked into its own cache. A global
 * install would not change what `npx @cubetiq/hlt` runs next time, so upgrading
 * has to be reported differently.
 */
export function isNpxRuntime(): boolean {
    const dir = runtimeDir();
    return dir.split(path.sep).includes("_npx");
}

/** The manager that most likely installed this binary. */
export function detectPackageManager(): "bun" | "npm" | "pnpm" | "yarn" {
    const ua = process.env.npm_config_user_agent || "";
    if (process.versions.bun || ua.startsWith("bun")) return "bun";
    if (ua.startsWith("pnpm")) return "pnpm";
    if (ua.startsWith("yarn")) return "yarn";
    return "npm";
}

export function upgradeCommand(): { cmd: string; args: string[] } {
    const target = `${PACKAGE_NAME}@latest`;
    switch (detectPackageManager()) {
        case "bun":
            return { cmd: "bun", args: ["add", "-g", target] };
        case "pnpm":
            return { cmd: "pnpm", args: ["add", "-g", target] };
        case "yarn":
            return { cmd: "yarn", args: ["global", "add", target] };
        default:
            return { cmd: "npm", args: ["install", "-g", target] };
    }
}

export function updateBanner(latest: string, current: string): string {
    const how = isNpxRuntime()
        ? `\x1b[1mnpx -y ${PACKAGE_NAME}@latest <command>\x1b[0m \x1b[90m(you are running via npx)\x1b[0m`
        : `\x1b[1mhlt upgrade\x1b[0m`;
    return (
        `\x1b[33m┌ Update available\x1b[0m ${current} → \x1b[32m${latest}\x1b[0m\n` +
        `\x1b[33m└ Run\x1b[0m ${how}`
    );
}

/** Run the upgrade in place, streaming the package manager's own output. */
export function runUpgrade(): Promise<number> {
    // npx runs a version-pinned copy out of its own cache; installing globally
    // would leave `npx @cubetiq/hlt` on the old one, which looks like "upgrade
    // did nothing".
    if (isNpxRuntime()) {
        console.log(
            `\x1b[33m! This copy was unpacked by npx (${runtimeDir()}).\x1b[0m\n` +
            `  npx keeps its own cache, so a global install would not change what you run.\n` +
            `  Use \x1b[1mnpx -y ${PACKAGE_NAME}@latest <command>\x1b[0m to always get the newest,\n` +
            `  or install it once with \x1b[1m${upgradeCommand().cmd} ${upgradeCommand().args.join(" ")}\x1b[0m and run \x1b[1mhlt\x1b[0m directly.`
        );
        return Promise.resolve(0);
    }

    const { cmd, args } = upgradeCommand();
    console.log(`\x1b[36m➜ Upgrading:\x1b[0m ${cmd} ${args.join(" ")}`);
    return new Promise((resolve) => {
        const child = spawn(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
        child.on("error", (err) => {
            console.error(
                `\x1b[31m✖ Upgrade failed:\x1b[0m ${err.message}\n` +
                `  Run it yourself: \x1b[1m${cmd} ${args.join(" ")}\x1b[0m`
            );
            resolve(1);
        });
        child.on("close", (code) => {
            if (code) {
                console.error(
                    `\x1b[31m✖ ${cmd} exited with code ${code}.\x1b[0m` +
                    (cmd === "npm" ? " A global install may need sudo, or use a node version manager." : "")
                );
            }
            resolve(code ?? 0);
        });
    });
}
