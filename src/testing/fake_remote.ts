/** A fake remote review server over real TLS (CORE-25).
 *
 * It speaks just enough of the remote protocol for `runRemoteReview` to get
 * from handshake to a result: `/api/remote/handshake`, `/api/remote/reviews`,
 * and `/api/remote/reviews/:id/sync`. It records every request's path, bearer
 * token and body so a test can prove which host and token the CLI actually
 * used. It is HTTPS, not HTTP, because the point of the CORE-25 test is that a
 * `https://` host with an inline token works end to end. */
import { createServer, type Server } from "node:https";
import { writeFileSync } from "node:fs";
import { TLS_CERT_PEM, TLS_KEY_PEM } from "./fixtures/tls_cert.ts";

export type FakeRemoteRequest = {
  path: string;
  authorization: string | undefined;
  body: unknown;
};

export type FakeRemote = {
  url: string;
  requests: FakeRemoteRequest[];
  close: () => Promise<void>;
};

export type FakeRemoteOptions = {
  /** Repository full name the handshake reports. */
  repo?: string;
  /** `sync` responses in order. The last one repeats if the client asks again. */
  sync?: unknown[];
  /** The guides `GET /api/remote/guides` answers with (CORE-44). */
  guides?: {
    repo?: { fullName?: string };
    guideBuiltAt?: string | null;
    guides?: unknown[];
  };
  /** Answers every request with this status and the server's error shape, so
   * the client's rejection handling can be exercised (CORE-44). */
  refuse?: number;
};

const SYNC_DONE = {
  schemaVersion: 1,
  status: "done",
  logs: [],
  result: { findings: [], summary: {} },
  abort: null,
};

/** Writes the test certificate to a temp file and returns its path, for
 * `NODE_EXTRA_CA_CERTS`. The OS trust store does not know this CA. */
export async function writeCaCert(dir: string): Promise<string> {
  const path = `${dir}/cm-test-ca.pem`;
  writeFileSync(path, TLS_CERT_PEM);
  return path;
}

export async function startFakeRemote(
  options: FakeRemoteOptions = {},
): Promise<FakeRemote> {
  const requests: FakeRemoteRequest[] = [];
  const syncQueue = [...(options.sync ?? [SYNC_DONE])];
  const server: Server = createServer(
    { cert: TLS_CERT_PEM, key: TLS_KEY_PEM },
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let body: unknown = undefined;
        try {
          body = raw ? JSON.parse(raw) : undefined;
        } catch {
          body = raw;
        }
        requests.push({
          path: req.url ?? "",
          authorization: req.headers.authorization,
          body,
        });
        const send = (status: number, payload: unknown): void => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        if (options.refuse !== undefined) {
          send(options.refuse, {
            error: {
              code: "token_invalid",
              message: "invalid or missing token",
              requestId: "fake",
            },
          });
          return;
        }
        if (req.url === "/api/remote/handshake") {
          send(200, {
            schemaVersion: 1,
            minClientSchema: 1,
            serverVersion: "0.5.0",
            repo: {
              fullName: options.repo ?? "owner/repo",
              defaultBranch: "main",
            },
            sync: { intervalSeconds: 1, timeoutSeconds: 10 },
            limits: { maxBodyBytes: 50 * 1024 * 1024 },
          });
          return;
        }
        if (req.url === "/api/remote/reviews") {
          send(202, { schemaVersion: 1, jobId: "job_1", reviewId: "rev_1" });
          return;
        }
        if ((req.url ?? "").startsWith("/api/remote/guides")) {
          send(200, {
            schemaVersion: 1,
            repo: { fullName: options.repo ?? "owner/repo" },
            guideBuiltAt: null,
            guides: [],
            ...options.guides,
          });
          return;
        }
        if (/^\/api\/remote\/reviews\/[^/]+\/sync$/.test(req.url ?? "")) {
          const next = syncQueue.length > 1 ? syncQueue.shift() : syncQueue[0];
          send(200, next);
          return;
        }
        send(404, { error: { code: "not_found", message: "no such path" } });
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `https://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Reads a request's bearer token without the header prefix, for assertions. */
export function bearerOf(request: FakeRemoteRequest): string | undefined {
  return request.authorization?.replace(/^Bearer /, "");
}
