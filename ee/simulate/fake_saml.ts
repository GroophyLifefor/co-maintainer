/** A fake SAML 2.0 identity provider for tests of the enterprise sign-in.
 *
 * Browser SSO as a service provider sees it: the provider's metadata, a
 * sign-in endpoint that takes the service provider's request and answers with
 * the signed response the browser would post back, and a sign-out endpoint.
 * The assertion is signed with enveloped XML-DSig, RSA-SHA256, with a
 * throwaway key.
 *
 * The XML is written in exactly the form that canonicalization would give it
 * (no extra space, attributes in order, namespaces declared where they are
 * used), so a service provider that checks the digest and the signature over
 * these bytes checks what a real one would. A real provider's XML is not
 * assumed to look like this: canonicalization is not simulated.
 * The provider's key is published in its metadata as a bare public key, not
 * a certificate.
 *
 * Time is the provider's own clock. Faults are switches on the object. */
import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { inflateRawSync } from "node:zlib";

export type FakeSamlUser = {
  nameId: string;
  email: string;
  name: string;
  groups?: string[];
};

export type FakeSamlOptions = {
  /** The service provider's entity id: what the assertion is for. */
  audience: string;
  /** Where the response is posted: the assertion consumer address. */
  acsUrl: string;
  users: FakeSamlUser[];
  /** Seconds the assertion and the session last. Defaults 300 and 3600. */
  assertionSeconds?: number;
  sessionSeconds?: number;
  startAt?: number;
};

export type SamlFaults = {
  /** Sign with a key that is not the published one, and put its public key in
   * the signature, as an attacker would. */
  signedByStranger: boolean;
  wrongAudience: boolean;
  wrongRecipient: boolean;
  wrongIssuer: boolean;
  /** Change the user after the assertion was signed. */
  tamperAfterSigning: boolean;
  /** Put a second, unsigned assertion in front of the signed one. */
  wrapping: boolean;
  /** No signature at all. */
  unsigned: boolean;
  /** An assertion that is already past its end. */
  expired: boolean;
  /** Leave out the answer to the request's id, as an unprompted response. */
  omitInResponseTo: boolean;
};

export type FakeSaml = {
  entityId: string;
  ssoUrl: string;
  sloUrl: string;
  metadataUrl: string;
  /** The provider's published public key, PEM. */
  publicKey: string;
  now(): number;
  advance(ms: number): void;
  faults: SamlFaults;
  signInAs(nameId: string): void;
  /** Whether a session the provider started is still on: not signed out and
   * not past its end. */
  isSessionActive(sessionIndex: string): boolean;
  /** The response an unprompted sign in (started at the provider) would post. */
  unsolicited(): { acsUrl: string; samlResponse: string };
  requests: string[];
  close(): Promise<void>;
};

const NS = {
  samlp: "urn:oasis:names:tc:SAML:2.0:protocol",
  saml: "urn:oasis:names:tc:SAML:2.0:assertion",
  ds: "http://www.w3.org/2000/09/xmldsig#",
};

export function xmlEscape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function instant(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function rsaKey(): { privateKey: KeyObject; publicPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  return {
    privateKey,
    publicPem: String(publicKey.export({ type: "spki", format: "pem" })),
  };
}

function signRsa(privateKey: KeyObject, text: string): string {
  return createSign("RSA-SHA256")
    .update(text)
    .sign(privateKey)
    .toString("base64");
}

function signedInfo(assertionId: string, digest: string): string {
  return (
    `<ds:SignedInfo xmlns:ds="${NS.ds}">` +
    `<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></ds:CanonicalizationMethod>` +
    `<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"></ds:SignatureMethod>` +
    `<ds:Reference URI="#${assertionId}">` +
    `<ds:Transforms><ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></ds:Transform>` +
    `<ds:Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></ds:Transform></ds:Transforms>` +
    `<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod>` +
    `<ds:DigestValue>${digest}</ds:DigestValue></ds:Reference></ds:SignedInfo>`
  );
}

export async function startFakeSaml(
  options: FakeSamlOptions,
): Promise<FakeSaml> {
  const assertionSeconds = options.assertionSeconds ?? 300;
  const sessionSeconds = options.sessionSeconds ?? 3600;
  let clock = options.startAt ?? Date.UTC(2027, 0, 1);
  const published = rsaKey();
  const stranger = rsaKey();
  let signedInAs = options.users[0]!.nameId;
  const requests: string[] = [];
  /** Every session the provider started, by session index. */
  const sessions = new Map<string, { endsAt: number; signedOut: boolean }>();
  const faults: SamlFaults = {
    signedByStranger: false,
    wrongAudience: false,
    wrongRecipient: false,
    wrongIssuer: false,
    tamperAfterSigning: false,
    wrapping: false,
    unsigned: false,
    expired: false,
    omitInResponseTo: false,
  };
  let entityId = "";

  const assertion = (
    user: FakeSamlUser,
    inResponseTo: string | undefined,
    sessionIndex: string,
  ): { xml: string; id: string } => {
    const id = `_a${randomBytes(8).toString("hex")}`;
    const issuer = faults.wrongIssuer ? `${entityId}/other` : entityId;
    const end = faults.expired
      ? clock - 60_000
      : clock + assertionSeconds * 1000;
    const start = clock - 60_000 - (faults.expired ? 3_600_000 : 0);
    const recipient = faults.wrongRecipient
      ? `${options.acsUrl}/other`
      : options.acsUrl;
    const audience = faults.wrongAudience
      ? "https://another.example/sp"
      : options.audience;
    const attrs = [
      ["email", user.email],
      ["name", user.name],
      ...(user.groups ?? []).map((g) => ["group", g]),
    ]
      .map(
        ([n, v]) =>
          `<saml:Attribute Name="${xmlEscape(n!)}"><saml:AttributeValue>${xmlEscape(v!)}</saml:AttributeValue></saml:Attribute>`,
      )
      .join("");
    const body =
      `<saml:Issuer>${xmlEscape(issuer)}</saml:Issuer>` +
      `@@SIGNATURE@@` +
      `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${xmlEscape(user.nameId)}</saml:NameID>` +
      `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData ${
        inResponseTo ? `InResponseTo="${xmlEscape(inResponseTo)}" ` : ""
      }NotOnOrAfter="${instant(end)}" Recipient="${xmlEscape(recipient)}"></saml:SubjectConfirmationData></saml:SubjectConfirmation></saml:Subject>` +
      `<saml:Conditions NotBefore="${instant(start)}" NotOnOrAfter="${instant(end)}"><saml:AudienceRestriction><saml:Audience>${xmlEscape(audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
      `<saml:AuthnStatement AuthnInstant="${instant(clock)}" SessionIndex="${sessionIndex}" SessionNotOnOrAfter="${instant(clock + sessionSeconds * 1000)}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
      `<saml:AttributeStatement>${attrs}</saml:AttributeStatement>`;
    const open = `<saml:Assertion xmlns:saml="${NS.saml}" ID="${id}" IssueInstant="${instant(clock)}" Version="2.0">`;
    const close = `</saml:Assertion>`;
    if (faults.unsigned) {
      return { id, xml: open + body.replace("@@SIGNATURE@@", "") + close };
    }
    // The digest is over the assertion as it is without its signature.
    const bare = open + body.replace("@@SIGNATURE@@", "") + close;
    const digest = createHash("sha256").update(bare).digest("base64");
    const info = signedInfo(id, digest);
    const key = faults.signedByStranger ? stranger : published;
    const signatureValue = signRsa(key.privateKey, info);
    const keyInfo = faults.signedByStranger
      ? `<ds:KeyInfo><ds:KeyValue>${xmlEscape(key.publicPem)}</ds:KeyValue></ds:KeyInfo>`
      : "";
    const signature =
      `<ds:Signature xmlns:ds="${NS.ds}">${info}` +
      `<ds:SignatureValue>${signatureValue}</ds:SignatureValue>${keyInfo}</ds:Signature>`;
    let xml = open + body.replace("@@SIGNATURE@@", signature) + close;
    if (faults.tamperAfterSigning) {
      xml = xml.replace(
        `>${xmlEscape(user.nameId)}</saml:NameID>`,
        `>admin@${xmlEscape(user.nameId.split("@")[1] ?? "example.test")}</saml:NameID>`,
      );
    }
    return { id, xml };
  };

  const response = (
    user: FakeSamlUser,
    inResponseTo: string | undefined,
  ): string => {
    const sessionIndex = `_s${randomBytes(6).toString("hex")}`;
    sessions.set(sessionIndex, {
      endsAt: clock + sessionSeconds * 1000,
      signedOut: false,
    });
    const real = assertion(user, inResponseTo, sessionIndex);
    let assertions = real.xml;
    if (faults.wrapping) {
      // An unsigned assertion for another person, ahead of the signed one.
      const evil = assertion(
        {
          ...user,
          nameId: "admin@example.test",
          email: "admin@example.test",
          name: "Admin",
        },
        inResponseTo,
        sessionIndex,
      );
      const stripped = evil.xml.replace(
        /<ds:Signature[\s\S]*<\/ds:Signature>/,
        "",
      );
      assertions = stripped + real.xml;
    }
    const id = `_r${randomBytes(8).toString("hex")}`;
    const xml =
      `<samlp:Response xmlns:samlp="${NS.samlp}" xmlns:saml="${NS.saml}" Destination="${xmlEscape(options.acsUrl)}" ID="${id}" ${
        inResponseTo && !faults.omitInResponseTo
          ? `InResponseTo="${xmlEscape(inResponseTo)}" `
          : ""
      }IssueInstant="${instant(clock)}" Version="2.0">` +
      `<saml:Issuer>${xmlEscape(entityId)}</saml:Issuer>` +
      `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"></samlp:StatusCode></samlp:Status>` +
      assertions +
      `</samlp:Response>`;
    return Buffer.from(xml, "utf8").toString("base64");
  };

  const server = createServer((request, reply) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push(`${request.method} ${url.pathname}`);
    const send = (status: number, type: string, body: string) => {
      reply.writeHead(status, { "content-type": type });
      reply.end(body);
    };
    if (url.pathname === "/metadata") {
      return send(
        200,
        "application/xml",
        `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${xmlEscape(entityId)}">` +
          `<md:IDPSSODescriptor><md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="${NS.ds}"><ds:KeyValue>${xmlEscape(published.publicPem)}</ds:KeyValue></ds:KeyInfo></md:KeyDescriptor>` +
          `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${entityId}/sso"></md:SingleSignOnService>` +
          `<md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${entityId}/slo"></md:SingleLogoutService>` +
          `</md:IDPSSODescriptor></md:EntityDescriptor>`,
      );
    }
    if (url.pathname === "/sso") {
      // The browser would show a form that posts this to the service provider.
      let requestId: string | undefined;
      const raw = url.searchParams.get("SAMLRequest");
      if (raw) {
        try {
          const text = inflateRawSync(Buffer.from(raw, "base64")).toString(
            "utf8",
          );
          requestId = /\bID="([^"]+)"/.exec(text)?.[1];
        } catch {
          return send(400, "text/plain", "bad request");
        }
      }
      if (!requestId) return send(400, "text/plain", "no request");
      const user = options.users.find((u) => u.nameId === signedInAs)!;
      return send(
        200,
        "application/json",
        JSON.stringify({
          acsUrl: options.acsUrl,
          samlResponse: response(user, requestId),
          relayState: url.searchParams.get("RelayState") ?? undefined,
        }),
      );
    }
    if (url.pathname === "/slo") {
      const index = url.searchParams.get("SessionIndex") ?? "";
      const session = sessions.get(index);
      // Only a session that is on can be ended.
      const ended = Boolean(
        session && !session.signedOut && clock < session.endsAt,
      );
      if (session) session.signedOut = true;
      return send(
        200,
        "application/json",
        JSON.stringify({ loggedOut: ended }),
      );
    }
    send(404, "text/plain", "not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  entityId = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    entityId,
    ssoUrl: `${entityId}/sso`,
    sloUrl: `${entityId}/slo`,
    metadataUrl: `${entityId}/metadata`,
    publicKey: published.publicPem,
    now: () => clock,
    advance: (ms) => {
      clock += ms;
    },
    faults,
    signInAs: (nameId) => {
      if (!options.users.some((u) => u.nameId === nameId)) {
        throw new Error(`no such fake user: ${nameId}`);
      }
      signedInAs = nameId;
    },
    isSessionActive: (index) => {
      const session = sessions.get(index);
      return Boolean(session && !session.signedOut && clock < session.endsAt);
    },
    unsolicited: () => ({
      acsUrl: options.acsUrl,
      samlResponse: response(
        options.users.find((u) => u.nameId === signedInAs)!,
        undefined,
      ),
    }),
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
