import * as stream from "stream";
import { Socket } from 'socket.io-client';

class TunnelRequest extends stream.Readable {
  constructor(private socket: Socket, private requestId: string) {
    super();

    const onRequestPipe = (requestId: string, data: any) => {
      if (this.requestId === requestId) {
        this.push(data);
      }
    };

    const onRequestPipes = (requestId: string, data: any) => {
      if (!data) return;
      if (this.requestId === requestId) {
        data.forEach((chunk: any) => {
          this.push(chunk);
        });
      }
    };

    const onRequestPipeError = (requestId: string, error?: any) => {
      if (this.requestId === requestId) {
        this.socket.off("request-pipe", onRequestPipe);
        this.socket.off("request-pipes", onRequestPipes);
        this.socket.off("request-pipe-error", onRequestPipeError);
        this.socket.off("request-pipe-end", onRequestPipeEnd);
        this.destroy(new Error(error));
      }
    };

    const onRequestPipeEnd = (requestId: string, data: any) => {
      if (this.requestId === requestId) {
        this.socket.off("request-pipe", onRequestPipe);
        this.socket.off("request-pipes", onRequestPipes);
        this.socket.off("request-pipe-error", onRequestPipeError);
        this.socket.off("request-pipe-end", onRequestPipeEnd);
        if (data) {
          this.push(data);
        }
        this.push(null);
      }
    };

    this.socket.on("request-pipe", onRequestPipe);
    this.socket.on("request-pipes", onRequestPipes);
    this.socket.on("request-pipe-error", onRequestPipeError);
    this.socket.on("request-pipe-end", onRequestPipeEnd);
  }

  _read() { }
}

class TunnelResponse extends stream.Duplex {
  constructor(private socket: Socket, private responseId: string, duplex?: boolean) {
    super();

    if (duplex) {
      // for websocket request: bidirection
      const onResponsePipe = (responseId: string, data: any) => {
        if (this.responseId === responseId) {
          this.push(data);
        }
      };

      const onResponsePipes = (responseId: string, data: any) => {
        if (this.responseId === responseId) {
          data.forEach((chunk: any) => {
            this.push(chunk);
          });
        }
      };

      const onResponsePipeError = (responseId: string, error?: any) => {
        if (this.responseId === responseId) {
          this.socket.off("response-pipe", onResponsePipe);
          this.socket.off("response-pipes", onResponsePipes);
          this.socket.off("response-pipe-error", onResponsePipeError);
          this.socket.off("response-pipe-end", onResponsePipeEnd);
          this.destroy(new Error(error));
        }
      };

      const onResponsePipeEnd = (responseId: string, data: any) => {
        if (this.responseId === responseId) {
          this.socket.off("response-pipe", onResponsePipe);
          this.socket.off("response-pipes", onResponsePipes);
          this.socket.off("response-pipe-error", onResponsePipeError);
          this.socket.off("response-pipe-end", onResponsePipeEnd);
          if (data) {
            this.push(data);
          }
          this.push(null);
        }
      };

      this.socket.on("response-pipe", onResponsePipe);
      this.socket.on("response-pipes", onResponsePipes);
      this.socket.on("response-pipe-error", onResponsePipeError);
      this.socket.on("response-pipe-end", onResponsePipeEnd);
    }
    
  }

  _write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.socket.emit("response-pipe", this.responseId, chunk);
    this.socket.io.engine.once("drain", () => {
      callback && callback();
    });
  }

  _writev(
    chunks: Array<{
      chunk: any;
      encoding: BufferEncoding;
    }>,
    callback: (error?: Error | null) => void) {
    this.socket.emit("response-pipes", this.responseId, chunks);
    this.socket.io.engine.once("drain", () => {
      callback();
    });
  }

  _final(callback: (error?: Error | null) => void) {
    this.socket.emit("response-pipe-end", this.responseId);
    this.socket.io.engine.once("drain", () => {
      callback();
    });
  }

  _destroy(error: Error | null, callback: (error: Error | null) => void) {
    if (error) {
      this.socket.emit(
        "response-pipe-error",
        this.responseId,
        error && error.message
      );

      this.socket.io.engine.once("drain", () => {
        callback(error);
      });

      return;
    }

    callback(null);
  }

  writeHead(statusCode: any, statusMessage?: any, headers?: any, httpVersion?: any) {
    this.socket.emit("response", this.responseId, {
      statusCode,
      statusMessage,
      headers,
      httpVersion,
    });
  }

  _read(size: number) { }
}

export {
  TunnelRequest,
  TunnelResponse
}