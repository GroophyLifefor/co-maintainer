/** Where `serve` may send an `openai-compatible` request. The base URL is a
 * setting, so without this an admin, or anyone who gets the setting changed,
 * could point the server at a private service or the cloud metadata address
 * and read the answer back. The check runs when the connection resolves the
 * name, so a name that resolves elsewhere later (DNS rebinding) is caught,
 * and again before each request, which also covers an address given as an
 * IP. Only `node:dns` and `node:net`. */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent } from "undici";
import { getEnv } from "../util/runtime.ts";

const BLOCKED = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  ["::1", 128],
  ["::", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["64:ff9b::", 96],
  ["2002::", 16],
] as const) {
  BLOCKED.addSubnet(address, prefix, "ipv6");
}

/** A private, loopback, link-local, metadata or otherwise special address. */
export function isBlockedAddress(address: string): boolean {
  // An IPv4 address written as IPv6 (`::ffff:10.0.0.7`) is judged as IPv4.
  // The URL parser writes it in hex (`::ffff:a00:7`), which counts too.
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  const fromHex = hex
    ? [
        parseInt(hex[1]!, 16) >> 8,
        parseInt(hex[1]!, 16) & 255,
        parseInt(hex[2]!, 16) >> 8,
        parseInt(hex[2]!, 16) & 255,
      ].join(".")
    : undefined;
  const checked = dotted ?? fromHex ?? address;
  const family = isIP(checked);
  if (family === 0) return true;
  return BLOCKED.check(checked, family === 4 ? "ipv4" : "ipv6");
}

let guardOn = false;

/** `serve` turns the guard on for the process. The CLI talks to what its
 * own user configured, so it stays off there. */
export function setEgressGuard(on: boolean): void {
  guardOn = on;
}

/** The host who runs the server may allow private addresses, for a model
 * server on the same network. Not a setting: the dashboard cannot turn it
 * on. */
export function egressGuardActive(): boolean {
  return guardOn && getEnv("CM_AI_ALLOW_PRIVATE") !== "1";
}

export type Resolve = (hostname: string) => Promise<string[]>;

const systemResolve: Resolve = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true }, (error, addresses) => {
      if (error) reject(error);
      else
        resolve((addresses as LookupAddress[]).map((entry) => entry.address));
    });
  });

let resolver: Resolve = systemResolve;

/** Test seam: the simulated world answers names itself. */
export function setEgressResolverForTest(fn?: Resolve): void {
  resolver = fn ?? systemResolve;
}

export class EgressRefused extends Error {
  constructor(host: string) {
    super(
      `The AI base URL ${host} resolves to a private or special address, which this server does not call. The host can allow it with CM_AI_ALLOW_PRIVATE=1.`,
    );
    this.name = "EgressRefused";
  }
}

/** Throws when the guard is on and the URL's host is, or resolves to, a
 * blocked address. Every address counts: one blocked answer refuses. */
export async function checkEgress(url: string): Promise<void> {
  if (!egressGuardActive()) return;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : await resolver(host);
  if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
    throw new EgressRefused(host);
  }
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/** The connection's own lookup, so the name is checked on the address the
 * socket really uses, while TLS keeps the hostname for SNI and the
 * certificate. */
function guardedLookup(
  hostname: string,
  options: { all?: boolean; family?: number },
  callback: LookupCallback,
): void {
  dnsLookup(hostname, { all: true }, (error, addresses) => {
    if (error) return callback(error, []);
    const list = addresses as LookupAddress[];
    if (
      egressGuardActive() &&
      (list.length === 0 ||
        list.some((entry) => isBlockedAddress(entry.address)))
    ) {
      return callback(new EgressRefused(hostname), []);
    }
    if (options.all) return callback(null, list);
    const first = list[0]!;
    callback(null, first.address, first.family);
  });
}

let cached: { ms: number; agent: Agent } | undefined;

/** An agent with the AI timeout whose connections resolve through the
 * guard. One per timeout, like the plain AI dispatcher. */
export function guardedDispatcher(ms: number): Agent {
  if (cached?.ms === ms) return cached.agent;
  const previous = cached?.agent;
  cached = {
    ms,
    agent: new Agent({
      headersTimeout: ms,
      bodyTimeout: ms,
      connect: { lookup: guardedLookup as never },
    }),
  };
  void previous?.close().catch(() => {});
  return cached.agent;
}
