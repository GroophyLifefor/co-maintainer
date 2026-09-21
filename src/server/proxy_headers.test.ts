import { test } from "node:test";
import { clientAddress, forwardedHttps } from "./proxy_headers.ts";

const withHeaders = (headers: Record<string, string>) =>
  new Request("http://localhost/", { headers });

test("clientAddress takes the rightmost valid address", () => {
  const cases: [string | undefined, string][] = [
    [undefined, "10.0.0.1"],
    ["", "10.0.0.1"],
    ["203.0.113.5", "203.0.113.5"],
    ["1.1.1.1, 203.0.113.5", "203.0.113.5"],
    [" 1.1.1.1 ,  203.0.113.5 ", "203.0.113.5"],
    ["2001:db8::1", "2001:db8::1"],
    ["203.0.113.5, junk", "10.0.0.1"],
    ["203.0.113.5:4433", "10.0.0.1"],
    ["<script>", "10.0.0.1"],
  ];
  for (const [header, expected] of cases) {
    const request = withHeaders(
      header === undefined ? {} : { "x-forwarded-for": header },
    );
    const got = clientAddress(request, "10.0.0.1");
    if (got !== expected) {
      throw new Error(
        `${JSON.stringify(header)} gave ${got}, wanted ${expected}`,
      );
    }
  }
});

test("forwardedHttps reads the last hop and ignores case", () => {
  const cases: [string | undefined, boolean][] = [
    [undefined, false],
    ["https", true],
    ["HTTPS", true],
    ["http", false],
    ["http, https", true],
    ["https, http", false],
    ["wss", false],
  ];
  for (const [header, expected] of cases) {
    const request = withHeaders(
      header === undefined ? {} : { "x-forwarded-proto": header },
    );
    if (forwardedHttps(request) !== expected) {
      throw new Error(`${JSON.stringify(header)} should be ${expected}`);
    }
  }
});
