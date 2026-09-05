import * as stream from "stream";
import { Socket } from "socket.io-client";

const DRAIN_THRESHOLD = 64 * 1024; // 64 KB buffer threshold
const DRAIN_TIMEOUT = 5000; // 5s safety timeout to prevent drain hangs

/**
 * Safely emit to socket with Engine.io buffer check.
 * Fixes the permanent stall when engine.writeBuffer is empty.
 */
function safeEmitWithDrain(socket: Socket, event: string, ...args: any[]) {
  const callback = typeof args[args.length - 1] === "function" ? args.pop() : null;
  socket.emit(event, ...args);

  if (!callback) return;

  const engine = (socket as any).io?.engine;
  if (engine && engine.writeBuffer && engine.writeBuffer.length > DRAIN_THRESHOLD) {
    let called = false;
    let timer: NodeJS.Timeout | null = null;

    const done = () => {
      if (called) return;
      called = true;
      if (timer) clearTimeout(timer);
      callback();
    };

    timer = setTimeout(done, DRAIN_TIMEOUT);
    engine.once("drain", done);
  } else {
    process.nextTick(callback);
  }
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