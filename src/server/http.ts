/** A manual `node:http` ↔ `fetch` bridge (plan §2 HTTP).
 *
 * The app is written against the Web `Request`/`Response` types, which Deno
 * served natively. Node has both types but no server that speaks them
 * directly, so this translates per request and streams responses — including
 * the SSE job feed — instead of buffering them. */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Server } from "node:http";
import { Readable } from "node:stream";

export type FetchApp = (
  request: Request,
  remoteAddr?: string,
) => Promise<Response> | Response;

export type HttpServer = {
  port: number;
  shutdown: () => Promise<void>;
  finished: Promise<void>;
};

function requestHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value))
      for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  return headers;
}

/** Node's `IncomingMessage` is a Node stream; `fetch` wants a Web body. A
 * GET/HEAD has none, and passing `undefined` is required there — a body on a
 * GET makes undici throw. */
function requestBody(
  req: IncomingMessage,
  method: string,
): ReadableStream<Uint8Array> | undefined {
  if (method === "GET" || method === "HEAD") return undefined;
  return Readable.toWeb(req) as ReadableStream<Uint8Array>;
}

function toFetchRequest(req: IncomingMessage, secure: boolean): Request {
  const method = req.method ?? "GET";
  const host = req.headers.host ?? "localhost";
  const url = new URL(req.url ?? "/", `${secure ? "https" : "http"}://${host}`);
  return new Request(url, {
    method,
    headers: requestHeaders(req),
    body: requestBody(req, method),
    // Required by undici whenever a stream body is attached.
    duplex: "half",
  } as RequestInit);
}

async function writeResponse(
  res: ServerResponse,
  response: Response,
): Promise<void> {
  res.statusCode = response.status;
  for (const [name, value] of response.headers) {
    // `set-cookie` repeats, and Node needs each as its own array entry.
    if (name === "set-cookie") res.appendHeader(name, value);
    else res.setHeader(name, value);
  }
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Backpressure: pause until the socket drains before reading more, so
      // a slow client cannot balloon memory (matters for SSE).
      if (!res.write(value)) {
        await new Promise<void>((resolve) => res.once("drain", resolve));
      }
    }
    res.end();
  } catch {
    res.destroy();
  } finally {
    reader.releaseLock();
  }
}

/** Starts an HTTP server that hands each request to `app`. */
export function serveHttp(app: FetchApp, port: number): HttpServer {
  let resolveFinished: () => void;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });

  const server: Server = createServer((req, res) => {
    const remoteAddr = req.socket.remoteAddress;
    void (async () => {
      try {
        const request = toFetchRequest(req, false);
        const response = await app(request, remoteAddr);
        await writeResponse(res, response);
      } catch (error) {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("content-type", "text/plain");
          res.end(`Internal Server Error: ${String(error)}`);
        } else {
          res.destroy();
        }
      }
    })();
  });

  server.listen(port);
  return {
    port,
    shutdown: () =>
      new Promise<void>((resolve) => {
        // SSE streams never end on their own, so `close()` alone would wait
        // forever. Tear the connections down, then wait for the close event
        // so the listening socket is actually released before we return.
        server.closeAllConnections();
        server.close(() => {
          resolveFinished();
          resolve();
        });
      }),
    finished,
  };
}
