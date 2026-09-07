const { Writable, Duplex } = require("stream");

// Backpressure is measured in bytes handed to engine.io, not in queued packets:
// every multiplexed request shares one socket, so a packet-count threshold made
// hundreds of concurrent requests wait on a drain round-trip each (seconds of
// added latency under load).
const HIGH_WATER_BYTES =
  parseInt(process.env.HLT_SOCKET_HIGH_WATER, 10) || 4 * 1024 * 1024;
const DRAIN_TIMEOUT = 5000; // safety net if the transport never reports a drain

// Keyed by engine.io connection, so a reconnect starts clean.
const connStates = new WeakMap();

function connState(conn) {
  let state = connStates.get(conn);
  if (!state) {
    state = { bytes: 0, waiters: [] };
    connStates.set(conn, state);
    // engine.io drains its whole write buffer at once, so this is the point
    // where everything we counted has actually gone out.
    conn.on("drain", () => {
      state.bytes = 0;
      const waiting = state.waiters;
      state.waiters = [];
      for (const resume of waiting) resume();
    });
  }
  return state;
}

function byteSize(args) {
  let total = 0;
  for (const arg of args) {
    if (!arg) continue;
    if (Buffer.isBuffer(arg)) total += arg.length;
    else if (typeof arg === "string") total += Buffer.byteLength(arg);
    else if (Array.isArray(arg)) {
      for (const chunk of arg) total += (chunk && (chunk.length || chunk.byteLength)) || 0;
    }
  }
  return total;
}

/**
 * Emit, and only make the caller wait when the socket is genuinely behind.
 * Counting our own bytes is O(1) per write; summing engine.io's queue would be
 * O(queue length) on every chunk.
 */
function safeEmitWithDrain(socket, event, ...args) {
  const callback = typeof args[args.length - 1] === "function" ? args.pop() : null;
  socket.emit(event, ...args);

  if (!callback) return;

  const conn = socket.conn;
  if (!conn) {
    process.nextTick(callback);
    return;
  }

  const state = connState(conn);
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

/**
 * Manages all active streams for a single tunnel socket.
 * Registers ONLY ONE permanent listener per event on the socket,
 * completely eliminating MaxListenersExceeded and O(N) listener loops.
 */
class TunnelSocketManager {
  constructor(socket) {
    this.socket = socket;
    this.socket._tunnelManager = this;
    this.streams = new Map(); // id -> { requestStream, responseStream }

    this._onResponse = (id, data) => {
      const entry = this.streams.get(id);
      if (entry && entry.responseStream) {
        entry.responseStream.handleResponse(data);
      }
    };

    this._onResponsePipe = (id, chunk) => {
      const entry = this.streams.get(id);
      if (entry && entry.responseStream) {
        entry.responseStream.handleChunk(chunk);
      }
    };

    this._onResponsePipes = (id, chunks) => {
      const entry = this.streams.get(id);
      if (entry && entry.responseStream) {
        entry.responseStream.handleChunks(chunks);
      }
    };

    this._onResponsePipeEnd = (id, chunk) => {
      const entry = this.streams.get(id);
      if (entry && entry.responseStream) {
        entry.responseStream.handleEnd(chunk);
      }
    };

    this._onResponsePipeError = (id, error) => {
      const entry = this.streams.get(id);
      if (entry && entry.responseStream) {
        entry.responseStream.handleError(error);
      }
    };

    this._onRequestError = (id, error) => {
      const entry = this.streams.get(id);
      if (entry && entry.responseStream) {
        entry.responseStream.handleRequestError(error);
      }
    };

    // Attach single persistent listeners
    socket.on("response", this._onResponse);
    socket.on("response-pipe", this._onResponsePipe);
    socket.on("response-pipes", this._onResponsePipes);
    socket.on("response-pipe-end", this._onResponsePipeEnd);
    socket.on("response-pipe-error", this._onResponsePipeError);
    socket.on("request-error", this._onRequestError);

    this._onDisconnect = () => {
      this.destroyAll(new Error("Socket disconnected"));
      this.cleanup();
    };
    socket.once("disconnect", this._onDisconnect);
  }

  static getOrCreate(socket) {
    if (!socket._tunnelManager) {
      socket._tunnelManager = new TunnelSocketManager(socket);
    }
    return socket._tunnelManager;
  }

  registerRequest(id, stream) {
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
    stream.once("finish", onDone);
  }

  registerResponse(id, stream) {
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

  unregister(id) {
    this.streams.delete(id);
  }

  destroyAll(err) {
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

  cleanup() {
    this.socket.off("response", this._onResponse);
    this.socket.off("response-pipe", this._onResponsePipe);
    this.socket.off("response-pipes", this._onResponsePipes);
    this.socket.off("response-pipe-end", this._onResponsePipeEnd);
    this.socket.off("response-pipe-error", this._onResponsePipeError);
    this.socket.off("request-error", this._onRequestError);
    this.socket.off("disconnect", this._onDisconnect);
    this.socket._tunnelManager = null;
  }
}

const byteLength = (chunk) =>
  chunk ? (chunk.length || chunk.byteLength || 0) : 0;

class TunnelRequest extends Writable {
  constructor({ socket, requestId, request }) {
    super({ highWaterMark: 64 * 1024 });
    this._socket = socket;
    this._requestId = requestId;
    // Bytes relayed for this request, for per-tunnel/per-client traffic stats.
    this.bytesSent = 0;
    this._manager = TunnelSocketManager.getOrCreate(socket);
    this._manager.registerRequest(requestId, this);
    // Prevent unhandled error event if destroyed during client disconnect
    this.on("error", () => {});

    this._socket.emit("request", requestId, request);
  }

  _write(chunk, encoding, callback) {
    this.bytesSent += byteLength(chunk);
    safeEmitWithDrain(
      this._socket,
      "request-pipe",
      this._requestId,
      chunk,
      callback
    );
  }

  _writev(chunks, callback) {
    const data = chunks.map((c) => c.chunk);
    data.forEach((c) => (this.bytesSent += byteLength(c)));
    safeEmitWithDrain(
      this._socket,
      "request-pipes",
      this._requestId,
      data,
      callback
    );
  }

  _final(callback) {
    safeEmitWithDrain(
      this._socket,
      "request-pipe-end",
      this._requestId,
      callback
    );
  }

  _destroy(e, callback) {
    if (e && !this._socket.disconnected) {
      safeEmitWithDrain(
        this._socket,
        "request-pipe-error",
        this._requestId,
        e.message || String(e),
        () => callback(e)
      );
      return;
    }
    callback(e);
  }
}

class TunnelResponse extends Duplex {
  constructor({ socket, responseId }) {
    super({ highWaterMark: 64 * 1024 });
    this._socket = socket;
    this._responseId = responseId;
    // bytesReceived: payload sent back to the visitor. bytesSent: visitor payload
    // pushed to the tunnel client (WebSocket traffic, where this stream is duplex).
    this.bytesReceived = 0;
    this.bytesSent = 0;
    this._manager = TunnelSocketManager.getOrCreate(socket);
    this._manager.registerResponse(responseId, this);
    // Prevent unhandled error event if destroyed during client disconnect
    this.on("error", () => {});
  }

  handleResponse(data) {
    this.emit("response", {
      statusCode: data.statusCode,
      statusMessage: data.statusMessage,
      headers: data.headers,
      httpVersion: data.httpVersion,
    });
  }

  handleChunk(chunk) {
    if (chunk) {
      this.bytesReceived += byteLength(chunk);
      this.push(chunk);
    }
  }

  handleChunks(chunks) {
    if (!chunks || !Array.isArray(chunks)) return;
    for (const item of chunks) {
      const chunk = item?.chunk || item;
      if (chunk) {
        this.bytesReceived += byteLength(chunk);
        this.push(chunk);
      }
    }
  }

  handleEnd(chunk) {
    if (chunk) {
      this.bytesReceived += byteLength(chunk);
      this.push(chunk);
    }
    this.push(null);
  }

  handleError(error) {
    this.destroy(new Error(error || "Remote response error"));
  }

  handleRequestError(error) {
    this.emit("requestError", error);
  }

  _read(size) {}

  _write(chunk, encoding, callback) {
    this.bytesSent += byteLength(chunk);
    safeEmitWithDrain(
      this._socket,
      "response-pipe",
      this._responseId,
      chunk,
      callback
    );
  }

  _writev(chunks, callback) {
    const data = chunks.map((c) => c.chunk);
    data.forEach((c) => (this.bytesSent += byteLength(c)));
    safeEmitWithDrain(
      this._socket,
      "response-pipes",
      this._responseId,
      data,
      callback
    );
  }

  _final(callback) {
    safeEmitWithDrain(
      this._socket,
      "response-pipe-end",
      this._responseId,
      callback
    );
  }

  _destroy(e, callback) {
    if (e && !this._socket.disconnected) {
      safeEmitWithDrain(
        this._socket,
        "response-pipe-error",
        this._responseId,
        e.message || String(e),
        () => callback(e)
      );
      return;
    }
    callback(e);
  }
}

exports.TunnelSocketManager = TunnelSocketManager;
exports.TunnelRequest = TunnelRequest;
exports.TunnelResponse = TunnelResponse;
exports.safeEmitWithDrain = safeEmitWithDrain;
