import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import * as readline from "readline";

export interface ServeOptions {
    /** Show a browsable index for directories without index.html. */
    listing?: boolean;
    /** "user:pass" — enables HTTP Basic auth on every request. */
    auth?: string;
    /** Bind address for the local server (loopback by default). */
    bind?: string;
}

const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".gz": "application/gzip",
    ".tar": "application/x-tar",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".wasm": "application/wasm",
};

const escapeHtml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function formatSize(bytes: number): string {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function listingPage(urlPath: string, entries: fs.Dirent[], stats: (fs.Stats | null)[]): string {
    const rows = entries
        .map((entry, i) => {
            const isDir = entry.isDirectory();
            const name = entry.name + (isDir ? "/" : "");
            const href = encodeURIComponent(entry.name) + (isDir ? "/" : "");
            const st = stats[i];
            return `<tr><td><a href="${href}">${isDir ? "📁" : "📄"} ${escapeHtml(name)}</a></td>` +
                `<td class="r">${isDir ? "—" : formatSize(st?.size || 0)}</td>` +
                `<td class="r">${st ? new Date(st.mtimeMs).toISOString().slice(0, 16).replace("T", " ") : "—"}</td></tr>`;
        })
        .join("\n");

    const parent = urlPath === "/" ? "" : `<tr><td colspan="3"><a href="../">↩ ..</a></td></tr>`;
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Index of ${escapeHtml(urlPath)}</title><style>
:root{color-scheme:light dark}
body{font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0;padding:2rem;max-width:60rem}
h1{font-size:1rem;font-weight:600;margin:0 0 1rem;word-break:break-all}
table{width:100%;border-collapse:collapse}
td{padding:.35rem .5rem;border-bottom:1px solid color-mix(in srgb, currentColor 12%, transparent)}
td.r{text-align:right;opacity:.6;white-space:nowrap}
a{text-decoration:none;color:inherit}a:hover{text-decoration:underline}
footer{margin-top:1.5rem;opacity:.5;font-size:12px}
</style></head><body><h1>Index of ${escapeHtml(urlPath)}</h1>
<table>${parent}${rows}</table>
<footer>served by hlt</footer></body></html>`;
}

/**
 * Static file server. Everything is streamed with fs.createReadStream — the file
 * never lands in memory as a whole — and Range requests are honoured so large
 * media seeks and resumable downloads work over the tunnel.
 */
export function createFileServer(rootDir: string, options: ServeOptions = {}): http.Server {
    const root = path.resolve(rootDir);
    const listing = options.listing !== false;
    const expectedAuth = options.auth
        ? "Basic " + Buffer.from(options.auth).toString("base64")
        : null;

    return http.createServer((req, res) => {
        const send = (code: number, body: string, headers: Record<string, string> = {}) => {
            res.writeHead(code, { "content-type": "text/plain; charset=utf-8", ...headers });
            res.end(req.method === "HEAD" ? undefined : body);
        };

        if (expectedAuth) {
            const given = req.headers.authorization || "";
            const ok =
                given.length === expectedAuth.length &&
                crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expectedAuth));
            if (!ok) {
                return send(401, "Unauthorized", {
                    "www-authenticate": 'Basic realm="hlt", charset="UTF-8"',
                });
            }
        }

        if (req.method !== "GET" && req.method !== "HEAD") {
            return send(405, "Method Not Allowed", { allow: "GET, HEAD" });
        }

        let pathname: string;
        try {
            pathname = decodeURIComponent(new URL(req.url || "/", "http://local").pathname);
        } catch {
            return send(400, "Bad Request");
        }

        // Contain every request inside the served root: resolve first, then prove
        // the result is still under it (this is what stops ../ traversal).
        const target = path.resolve(root, "." + path.posix.normalize(pathname));
        if (target !== root && !target.startsWith(root + path.sep)) {
            return send(403, "Forbidden");
        }

        fs.stat(target, (err, stat) => {
            if (err) return send(404, "Not Found");

            if (stat.isDirectory()) {
                const indexFile = path.join(target, "index.html");
                if (fs.existsSync(indexFile)) return streamFile(indexFile, fs.statSync(indexFile));
                if (!listing) return send(403, "Directory listing is disabled");

                // Redirect so relative links inside the listing resolve correctly.
                if (!pathname.endsWith("/")) {
                    return send(301, "", { location: pathname + "/" });
                }
                return fs.readdir(target, { withFileTypes: true }, (dirErr, entries) => {
                    if (dirErr) return send(500, "Cannot read directory");
                    const visible = entries
                        .filter((e) => !e.name.startsWith("."))
                        .sort((a, b) =>
                            a.isDirectory() === b.isDirectory()
                                ? a.name.localeCompare(b.name)
                                : a.isDirectory()
                                    ? -1
                                    : 1
                        );
                    const stats = visible.map((e) => {
                        try {
                            return fs.statSync(path.join(target, e.name));
                        } catch {
                            return null;
                        }
                    });
                    const html = listingPage(pathname, visible, stats);
                    res.writeHead(200, {
                        "content-type": "text/html; charset=utf-8",
                        "content-length": Buffer.byteLength(html),
                        "cache-control": "no-store",
                    });
                    res.end(req.method === "HEAD" ? undefined : html);
                });
            }

            if (!stat.isFile()) return send(404, "Not Found");
            streamFile(target, stat);
        });

        function streamFile(file: string, stat: fs.Stats) {
            const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
            const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
            const baseHeaders: Record<string, string> = {
                "content-type": type,
                etag,
                "last-modified": stat.mtime.toUTCString(),
                "accept-ranges": "bytes",
                "cache-control": "public, max-age=0, must-revalidate",
            };

            if (req.headers["if-none-match"] === etag) {
                res.writeHead(304, baseHeaders);
                return res.end();
            }

            // Range: stream just the requested slice (video seeking, resumes).
            const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
            let start = 0;
            let end = stat.size - 1;
            if (range) {
                const [, rawStart, rawEnd] = range;
                if (rawStart) {
                    start = parseInt(rawStart, 10);
                    if (rawEnd) end = Math.min(parseInt(rawEnd, 10), end);
                } else if (rawEnd) {
                    start = Math.max(0, stat.size - parseInt(rawEnd, 10));
                }
                if (isNaN(start) || start > end) {
                    res.writeHead(416, { "content-range": `bytes */${stat.size}` });
                    return res.end();
                }
                res.writeHead(206, {
                    ...baseHeaders,
                    "content-range": `bytes ${start}-${end}/${stat.size}`,
                    "content-length": end - start + 1,
                });
            } else {
                res.writeHead(200, { ...baseHeaders, "content-length": stat.size });
            }

            if (req.method === "HEAD") return res.end();

            const stream = fs.createReadStream(file, { start, end, highWaterMark: 64 * 1024 });
            stream.on("error", () => res.destroy());
            res.on("close", () => stream.destroy());
            stream.pipe(res);
        }
    });
}

/** Big red warning + y/N prompt before a directory goes on the public internet. */
export async function confirmPublicShare(
    root: string,
    opts: { auth?: string; listing: boolean; assumeYes?: boolean }
): Promise<boolean> {
    const abs = path.resolve(root);
    let entries = 0;
    try {
        entries = fs.readdirSync(abs).length;
    } catch {
        console.error(`\x1b[31m✖ Cannot read directory: ${abs}\x1b[0m`);
        return false;
    }

    console.log(
        `\n\x1b[41m\x1b[97m WARNING \x1b[0m \x1b[1mYou are about to publish a local folder to the public internet.\x1b[0m\n` +
        `  \x1b[90mfolder  \x1b[0m ${abs} \x1b[90m(${entries} entries at the top level)\x1b[0m\n` +
        `  \x1b[90mlisting \x1b[0m ${opts.listing ? "\x1b[33mon — every file is browsable\x1b[0m" : "off"}\n` +
        `  \x1b[90mauth    \x1b[0m ${opts.auth ? "\x1b[32mbasic auth enabled\x1b[0m" : "\x1b[33mnone — anyone with the URL can read every file\x1b[0m"}\n` +
        `  \x1b[90mSecrets, .env files and keys inside this folder would be readable. Sub-folders are included.\x1b[0m\n`
    );

    if (opts.assumeYes) {
        console.log("\x1b[90m--yes given, continuing.\x1b[0m");
        return true;
    }
    if (!process.stdin.isTTY) {
        console.error("\x1b[31m✖ Refusing to share without confirmation. Re-run with --yes.\x1b[0m");
        return false;
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) =>
        rl.question("Publish this folder? [y/N] ", (a) => {
            rl.close();
            resolve(a.trim().toLowerCase());
        })
    );
    return answer === "y" || answer === "yes";
}
