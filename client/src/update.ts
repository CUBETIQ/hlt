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
export async function checkForUpdate(currentVersion: string): Promise<string | null> {
    if (process.env.HLT_NO_UPDATE_CHECK === "1" || process.env.CI) return null;

    const cached = readCache();
    if (cached && Date.now() - cached.checkedAt < CHECK_INTERVAL_MS) {
        return isNewer(cached.latest, currentVersion) ? cached.latest : null;
    }

    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2500);
        const res = await fetch(REGISTRY, {
            signal: controller.signal,
            headers: { accept: "application/vnd.npm.install-v1+json" },
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
    const { cmd, args } = upgradeCommand();
    return (
        `\x1b[33m┌ Update available\x1b[0m ${current} → \x1b[32m${latest}\x1b[0m\n` +
        `\x1b[33m└ Run\x1b[0m \x1b[1mhlt upgrade\x1b[0m \x1b[90m(${cmd} ${args.join(" ")})\x1b[0m`
    );
}

/** Run the upgrade in place, streaming the package manager's own output. */
export function runUpgrade(): Promise<number> {
    const { cmd, args } = upgradeCommand();
    console.log(`\x1b[36m➜ Upgrading:\x1b[0m ${cmd} ${args.join(" ")}`);
    return new Promise((resolve) => {
        const child = spawn(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
        child.on("error", (err) => {
            console.error(`\x1b[31m✖ Upgrade failed:\x1b[0m ${err.message}`);
            resolve(1);
        });
        child.on("close", (code) => resolve(code ?? 0));
    });
}
