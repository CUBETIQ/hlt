const { Writable, Duplex } = require("stream");

const DRAIN_THRESHOLD = 64 * 1024; // 64 KB buffer threshold
const DRAIN_TIMEOUT = 5000; // 5s safety timeout to prevent drain hangs

/**
 * Helper to safely write/emit to a Socket.io socket with backpressure.
 * Prevents memory bloat while avoiding the `socket.conn.once("drain")` deadlock
 * when the Engine.io writeBuffer is already empty.
 */
function safeEmitWithDrain(socket, event, ...args) {
  const callback = typeof args[args.length - 1] === "function" ? args.pop() : null;
  socket.emit(event, ...args);

  if (!callback) return;

  const conn = socket.conn;
  if (conn && conn.writeBuffer && conn.writeBuffer.length > DRAIN_THRESHOLD) {
    let called = false;
    let timer = null;

    const done = () => {
      if (called) return;
      called = true;
      if (timer) clearTimeout(timer);
      callback();
    };

    timer = setTimeout(done, DRAIN_TIMEOUT);
    conn.once("drain", done);
  } else {
    process.nextTick(callback);
  }
}

/**
 * Manages all active streams for a single tunnel socket.
 * Registers ONLY ONE permanent listener per event on the socket,
 * completely eliminating MaxListenersExceeded and O(N) listener loops.
 */
class TunnelSocketManager {
  constructor(socket) {
    this.socket = socket;
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

class TunnelRequest extends Writable {
  constructor({ socket, requestId, request }) {
    super({ highWaterMark: 64 * 1024 });
    this._socket = socket;
    this._requestId = requestId;
    this._manager = TunnelSocketManager.getOrCreate(socket);
    this._manager.registerRequest(requestId, this);

    this._socket.emit("request", requestId, request);
  }

  _write(chunk, encoding, callback) {
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
    this._manager = TunnelSocketManager.getOrCreate(socket);
    this._manager.registerResponse(responseId, this);
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
      this.push(chunk);
    }
  }

  handleChunks(chunks) {
    if (!chunks || !Array.isArray(chunks)) return;
    for (const item of chunks) {
      const chunk = item?.chunk || item;
      if (chunk) this.push(chunk);
    }
  }

  handleEnd(chunk) {
    if (chunk) {
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
