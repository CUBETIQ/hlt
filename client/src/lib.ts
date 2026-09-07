import * as stream from "stream";
import { Socket } from "socket.io-client";

// Backpressure is measured in bytes handed to engine.io, not in queued packets:
// every multiplexed request shares one socket, so a packet-count threshold made
// hundreds of concurrent requests wait on a drain round-trip each (seconds of
// added latency under load).
const HIGH_WATER_BYTES =
  parseInt(process.env.HLT_SOCKET_HIGH_WATER || "", 10) || 4 * 1024 * 1024;
const DRAIN_TIMEOUT = 5000; // safety net if the transport never reports a drain

interface EngineState {
  bytes: number;
  waiters: Array<() => void>;
}

// Keyed by engine instance, so a reconnect (new engine) starts clean.
const engineStates = new WeakMap<any, EngineState>();

function engineState(engine: any): EngineState {
  let state = engineStates.get(engine);
  if (!state) {
    state = { bytes: 0, waiters: [] };
    engineStates.set(engine, state);
    // engine.io drains its whole write buffer at once, so this is the point
    // where everything we counted has actually gone out.
    engine.on("drain", () => {
      state!.bytes = 0;
      const waiting = state!.waiters;
      state!.waiters = [];
      for (const resume of waiting) resume();
    });
  }
  return state;
}

function byteSize(args: any[]): number {
  let total = 0;
  for (const arg of args) {
    if (!arg) continue;
    if (Buffer.isBuffer(arg)) total += arg.length;
    else if (typeof arg === "string") total += Buffer.byteLength(arg);
    else if (Array.isArray(arg)) {
      for (const chunk of arg) total += chunk?.length || chunk?.byteLength || 0;
    }
  }
  return total;
}

/**
 * Emit, and only make the caller wait when the socket is genuinely behind.
 * Counting our own bytes is O(1) per write; summing engine.io's queue would be
 * O(queue length) on every chunk.
 */
function safeEmitWithDrain(socket: Socket, event: string, ...args: any[]) {
  const callback = typeof args[args.length - 1] === "function" ? args.pop() : null;
  socket.emit(event, ...args);

  if (!callback) return;

  const engine = (socket as any).io?.engine;
  if (!engine) {
    process.nextTick(callback);
    return;
  }

  const state = engineState(engine);
  state.bytes += byteSize(args);
  if (state.bytes <= HIGH_WATER_BYTES) {
    process.nextTick(callback);
    return;
  }

  let called = false;
  const done = () => {
    if (called) return;
    called = true;
    clearTimeout(timer);
    callback();
  };
  const timer = setTimeout(done, DRAIN_TIMEOUT);
  timer.unref?.();
  state.waiters.push(done);
}

interface StreamEntry {
  requestStream?: TunnelRequest | null;
  responseStream?: TunnelResponse | null;
}

/**
 * Client-side Demultiplexer.
 * Registers ONLY ONE listener per event on the client socket.
 */
export class TunnelSocketManager {
  private streams = new Map<string, StreamEntry>();
  private onDisconnectHandler: () => void;

  constructor(private socket: Socket) {
    // Request stream events (from server to client)
    this.socket.on("request-pipe", (requestId: string, data: any) => {
      const entry = this.streams.get(requestId);
      if (entry?.requestStream) {
        entry.requestStream.handleChunk(data);
      }
    });

    this.socket.on("request-pipes", (requestId: string, data: any[]) => {
      const entry = this.streams.get(requestId);
      if (entry?.requestStream) {
        entry.requestStream.handleChunks(data);
      }
    });

    this.socket.on("request-pipe-end", (requestId: string, data?: any) => {
      const entry = this.streams.get(requestId);
      if (entry?.requestStream) {
        entry.requestStream.handleEnd(data);
      }
    });

    this.socket.on("request-pipe-error", (requestId: string, error?: any) => {
      const entry = this.streams.get(requestId);
      if (entry?.requestStream) {
        entry.requestStream.handleError(error);
      }
    });

    // Duplex response stream events (for WebSockets from server to client)
    this.socket.on("response-pipe", (responseId: string, data: any) => {
      const entry = this.streams.get(responseId);
      if (entry?.responseStream) {
        entry.responseStream.handleChunk(data);
      }
    });

    this.socket.on("response-pipes", (responseId: string, data: any[]) => {
      const entry = this.streams.get(responseId);
      if (entry?.responseStream) {
        entry.responseStream.handleChunks(data);
      }
    });

    this.socket.on("response-pipe-end", (responseId: string, data?: any) => {
      const entry = this.streams.get(responseId);
      if (entry?.responseStream) {
        entry.responseStream.handleEnd(data);
      }
    });

    this.socket.on("response-pipe-error", (responseId: string, error?: any) => {
      const entry = this.streams.get(responseId);
      if (entry?.responseStream) {
        entry.responseStream.handleError(error);
      }
    });

    this.onDisconnectHandler = () => {
      this.destroyAll(new Error("Socket disconnected"));
    };
    this.socket.once("disconnect", this.onDisconnectHandler);
  }

  public static getOrCreate(socket: Socket): TunnelSocketManager {
    const s = socket as any;
    if (!s._tunnelManager) {
      s._tunnelManager = new TunnelSocketManager(socket);
    }
    return s._tunnelManager;
  }

  public registerRequest(id: string, stream: TunnelRequest) {
    let entry = this.streams.get(id);
    if (!entry) {
      entry = {};
      this.streams.set(id, entry);
    }
    entry.requestStream = stream;
    const onDone = () => {
      const cur = this.streams.get(id);
      if (cur) {
        cur.requestStream = null;
        if (!cur.responseStream) this.streams.delete(id);
      }
    };
    stream.once("close", onDone);
    stream.once("end", onDone);
  }

  public registerResponse(id: string, stream: TunnelResponse) {
    let entry = this.streams.get(id);
    if (!entry) {
      entry = {};
      this.streams.set(id, entry);
    }
    entry.responseStream = stream;
    const onDone = () => {
      const cur = this.streams.get(id);
      if (cur) {
        cur.responseStream = null;
        if (!cur.requestStream) this.streams.delete(id);
      }
    };
    stream.once("close", onDone);
    stream.once("finish", onDone);
    stream.once("end", onDone);
  }

  public unregister(id: string) {
    this.streams.delete(id);
  }

  public destroyAll(err: Error) {
    for (const [id, entry] of this.streams.entries()) {
      if (entry.requestStream && !entry.requestStream.destroyed) {
        entry.requestStream.destroy(err);
      }
      if (entry.responseStream && !entry.responseStream.destroyed) {
        entry.responseStream.destroy(err);
      }
    }
    this.streams.clear();
  }
}

export class TunnelRequest extends stream.Readable {
  private manager: TunnelSocketManager;

  constructor(private socket: Socket, private requestId: string) {
    super({ highWaterMark: 64 * 1024 });
    this.manager = TunnelSocketManager.getOrCreate(socket);
    this.manager.registerRequest(requestId, this);
    // A visitor closing the tab makes the server destroy its side, which lands
    // here as an error. Without a listener that is an unhandled 'error' event —
    // it took the whole CLI down under normal traffic.
    this.on("error", () => {});
  }

  public handleChunk(data: any) {
    if (data) {
      this.push(data);
    }
  }

  public handleChunks(data: any[]) {
    if (!data || !Array.isArray(data)) return;
    for (const chunk of data) {
      const c = chunk?.chunk || chunk;
      if (c) this.push(c);
    }
  }

  public handleEnd(data?: any) {
    if (data) {
      this.push(data);
    }
    this.push(null);
  }

  public handleError(error?: any) {
    this.destroy(new Error(error || "Remote tunnel error"));
  }

  _read() {}
}

export class TunnelResponse extends stream.Duplex {
  private manager: TunnelSocketManager;

  constructor(
    private socket: Socket,
    private responseId: string,
    duplex?: boolean
  ) {
    super({ highWaterMark: 64 * 1024 });
    this.manager = TunnelSocketManager.getOrCreate(socket);
    this.manager.registerResponse(responseId, this);
    // Same as TunnelRequest: an aborted visitor request must not be fatal.
    this.on("error", () => {});
  }

  public handleChunk(data: any) {
    if (data) {
      this.push(data);
    }
  }

  public handleChunks(data: any[]) {
    if (!data || !Array.isArray(data)) return;
    for (const chunk of data) {
      const c = chunk?.chunk || chunk;
      if (c) this.push(c);
    }
  }

  public handleEnd(data?: any) {
    if (data) {
      this.push(data);
    }
    this.push(null);
  }

  public handleError(error?: any) {
    this.destroy(new Error(error || "Remote response error"));
  }

  _read(size: number) {}

  _write(
    chunk: any,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ) {
    safeEmitWithDrain(
      this.socket,
      "response-pipe",
      this.responseId,
      chunk,
      callback
    );
  }

  _writev(
    chunks: Array<{
      chunk: any;
      encoding: BufferEncoding;
    }>,
    callback: (error?: Error | null) => void
  ) {
    const data = chunks.map((c) => c.chunk);
    safeEmitWithDrain(
      this.socket,
      "response-pipes",
      this.responseId,
      data,
      callback
    );
  }

  _final(callback: (error?: Error | null) => void) {
    safeEmitWithDrain(
      this.socket,
      "response-pipe-end",
      this.responseId,
      callback
    );
  }

  _destroy(error: Error | null, callback: (error: Error | null) => void) {
    if (error && this.socket.connected) {
      safeEmitWithDrain(
        this.socket,
        "response-pipe-error",
        this.responseId,
        error.message || String(error),
        () => callback(error)
      );
      return;
    }
    callback(null);
  }

  writeHead(
    statusCode: any,
    statusMessage?: any,
    headers?: any,
    httpVersion?: any
  ) {
    this.socket.emit("response", this.responseId, {
      statusCode,
      statusMessage,
      headers,
      httpVersion,
    });
  }
}