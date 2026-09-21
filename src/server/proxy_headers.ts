import { isIP } from "node:net";

/** The rightmost entry is the one the nearest trusted proxy appended, so a
 * client cannot forge it the way it can the entries to its left. */
export function clientAddress(request: Request, socketAddress: string): string {
  const last = request.headers.get("x-forwarded-for")?.split(",").pop()?.trim();
  return last && isIP(last) ? last : socketAddress;
}

export function forwardedHttps(request: Request): boolean {
  const last = request.headers
    .get("x-forwarded-proto")
    ?.split(",")
    .pop()
    ?.trim()
    .toLowerCase();
  return last === "https";
}
