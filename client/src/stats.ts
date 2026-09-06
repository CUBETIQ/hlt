/**
 * Live tunnel counters plus an ngrok-style status line pinned to the bottom of
 * the terminal. Everything is in-memory and free: when stdout is not a TTY
 * (piped output, SDK use, CI) the line is never drawn and only the counters and
 * the normal per-request logs remain.
 */
const CLEAR_LINE = "\x1b[2K\r";

export function formatBytes(bytes: number): string {
    if (!bytes || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDuration(ms: number): string {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h${m}m`;
    if (m > 0) return `${m}m${sec}s`;
    return `${sec}s`;
}

/** Ordered: everything at or below the active level is printed. */
export const LOG_LEVELS = ["silent", "error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface TunnelStatsSnapshot {
    requests: number;
    httpRequests: number;
    wsRequests: number;
    bytesIn: number;
    bytesOut: number;
    wsOpen: number;
    errors: number;
    startedAt: number;
}

export class TunnelStats {
    private requests = 0;
    private httpRequests = 0;
    private wsRequests = 0;
    private bytesIn = 0;
    private bytesOut = 0;
    private wsOpen = 0;
    private errors = 0;
    private startedAt = Date.now();

    private timer: NodeJS.Timeout | null = null;
    private drawn = false;
    private readonly tty = !!process.stdout.isTTY;

    // Logging and the live line are independent: silencing request logs still
    // leaves the realtime counters on screen.
    private level: LogLevel = "info";
    private lineEnabled = true;

    public setLevel(level?: string) {
        if (level && (LOG_LEVELS as readonly string[]).includes(level)) {
            this.level = level as LogLevel;
        }
    }

    public setLineEnabled(enabled: boolean) {
        this.lineEnabled = enabled;
        if (!enabled) this.clear();
    }

    public enabled(level: LogLevel): boolean {
        return LOG_LEVELS.indexOf(level) <= LOG_LEVELS.indexOf(this.level);
    }

    /** Redraw once a second so the uptime clock stays alive between requests. */
    public start() {
        if (!this.tty || !this.lineEnabled || this.timer) return;
        this.timer = setInterval(() => this.draw(), 1000);
        this.timer.unref?.();
    }

    public stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.clear();
    }

    public recordHttp(bytesIn: number, bytesOut: number, failed = false) {
        this.requests++;
        this.httpRequests++;
        this.bytesIn += bytesIn;
        this.bytesOut += bytesOut;
        if (failed) this.errors++;
        this.draw();
    }

    public recordWsOpen() {
        this.requests++;
        this.wsRequests++;
        this.wsOpen++;
        this.draw();
    }

    public recordWsClose(bytesIn: number, bytesOut: number) {
        if (this.wsOpen > 0) this.wsOpen--;
        this.bytesIn += bytesIn;
        this.bytesOut += bytesOut;
        this.draw();
    }

    public snapshot(): TunnelStatsSnapshot {
        return {
            requests: this.requests,
            httpRequests: this.httpRequests,
            wsRequests: this.wsRequests,
            bytesIn: this.bytesIn,
            bytesOut: this.bytesOut,
            wsOpen: this.wsOpen,
            errors: this.errors,
            startedAt: this.startedAt,
        };
    }

    /** Log a line without leaving the status line duplicated above it. */
    public log(message: string, level: LogLevel = "info") {
        if (!this.enabled(level)) return;
        this.clear();
        console.log(message);
        this.draw();
    }

    public error(message: string) {
        if (!this.enabled("error")) return;
        this.clear();
        console.error(message);
        this.draw();
    }

    public warn(message: string) {
        this.log(message, "warn");
    }

    /** Always shown (unless fully silent): the URL is the point of the command. */
    public banner(message: string) {
        this.log(message, "error");
    }

    public debug(message: string) {
        this.log(`\x1b[90m${message}\x1b[0m`, "debug");
    }

    /** Final one-line summary, printed on shutdown. */
    public summary(): string {
        const s = this.snapshot();
        return (
            `\x1b[1mSession summary\x1b[0m  ` +
            `${s.requests} requests (${s.httpRequests} http, ${s.wsRequests} ws)  ` +
            `\x1b[36m↓ ${formatBytes(s.bytesIn)}\x1b[0m  ` +
            `\x1b[32m↑ ${formatBytes(s.bytesOut)}\x1b[0m  ` +
            `over ${formatDuration(Date.now() - s.startedAt)}` +
            (s.errors ? `  \x1b[31m${s.errors} failed\x1b[0m` : "")
        );
    }

    private clear() {
        if (!this.tty || !this.drawn) return;
        process.stdout.write(CLEAR_LINE);
        this.drawn = false;
    }

    private draw() {
        if (!this.tty || !this.lineEnabled) return;
        const uptime = formatDuration(Date.now() - this.startedAt);
        const line =
            `\x1b[90m${uptime}\x1b[0m  ` +
            `\x1b[1m${this.requests}\x1b[0m reqs ` +
            `\x1b[90m(${this.httpRequests} http · ${this.wsRequests} ws)\x1b[0m  ` +
            `\x1b[36m↓ ${formatBytes(this.bytesIn)}\x1b[0m  ` +
            `\x1b[32m↑ ${formatBytes(this.bytesOut)}\x1b[0m` +
            (this.wsOpen ? `  \x1b[35m● ${this.wsOpen} ws open\x1b[0m` : "") +
            (this.errors ? `  \x1b[31m✖ ${this.errors}\x1b[0m` : "");

        process.stdout.write(CLEAR_LINE + line);
        this.drawn = true;
    }
}
