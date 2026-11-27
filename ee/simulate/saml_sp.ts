/** A small SAML 2.0 service provider for the fake provider's tests: what the
 * enterprise sign-in must check on a response, written plainly.
 *
 * The checks run in the order that matters: nothing in the assertion is
 * believed until its signature is checked against the key from the provider's
 * metadata (never a key the response itself carries), and the signed
 * assertion must be the only one in the response, so an unsigned one cannot
 * be slipped in ahead of it.
 *
 * It reads the form of XML the fake provider writes and is not a general XML
 * parser. It is test support, not the product's sign-in. */
import { createHash, createVerify } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { randomBytes } from "node:crypto";

export type SpConfig = {
  /** This service provider's entity id: the audience of an assertion. */
  entityId: string;
  acsUrl: string;
  idpEntityId: string;
  idpSsoUrl: string;
  /** The provider's public key, read from its metadata. */
  idpPublicKey: string;
};

export class SamlError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export type SamlLogin = {
  nameId: string;
  email: string | undefined;
  name: string | undefined;
  groups: string[];
  sessionIndex: string;
  sessionNotOnOrAfter: number;
  assertionId: string;
};

export type VerifyContext = {
  /** The id of the request this sign in answers. Unset: an unprompted
   * response, which is refused. */
  expectedRequestId: string | undefined;
  /** This side's clock, in milliseconds. */
  now: number;
  /** Assertion ids already accepted. The caller keeps it between calls. */
  usedAssertionIds: Set<string>;
  /** Seconds of difference between the clocks that is accepted. */
  skew?: number;
};

/** Reads the provider's public key out of its metadata. */
export async function readMetadataKey(url: string): Promise<{
  entityId: string;
  publicKey: string;
}> {
  const xml = await (await fetch(url)).text();
  const entityId = /entityID="([^"]+)"/.exec(xml)?.[1];
  const key = /<ds:KeyValue>([\s\S]*?)<\/ds:KeyValue>/.exec(xml)?.[1];
  if (!entityId || !key) throw new SamlError("metadata", "unusable metadata");
  return { entityId, publicKey: unescapeXml(key) };
}

export function unescapeXml(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
}

/** The address that sends the browser to the provider, and the request id the
 * response must answer. */
export function buildAuthnRequest(sp: SpConfig): { id: string; url: string } {
  const id = `_q${randomBytes(8).toString("hex")}`;
  const xml =
    `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="${id}" Version="2.0" ` +
    `AssertionConsumerServiceURL="${sp.acsUrl}"><saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${sp.entityId}</saml:Issuer></samlp:AuthnRequest>`;
  const url = new URL(sp.idpSsoUrl);
  url.searchParams.set(
    "SAMLRequest",
    deflateRawSync(Buffer.from(xml, "utf8")).toString("base64"),
  );
  url.searchParams.set("RelayState", id);
  return { id, url: url.toString() };
}

/** The browser: asks the provider to sign in and returns what it would post
 * back to the service provider. */
export async function browse(url: string): Promise<{
  status: number;
  acsUrl?: string;
  samlResponse?: string;
  relayState?: string;
}> {
  const response = await fetch(url);
  if (!response.ok) return { status: response.status };
  return { status: response.status, ...((await response.json()) as object) };
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
}

function time(value: string | undefined): number | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value))
    return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

export function verifyResponse(
  sp: SpConfig,
  samlResponse: string,
  context: VerifyContext,
): SamlLogin {
  const xml = Buffer.from(samlResponse, "base64").toString("utf8");
  const skew = (context.skew ?? 30) * 1000;
  const responseTag = /<samlp:Response\b[^>]*>/.exec(xml)?.[0];
  if (!responseTag) throw new SamlError("malformed", "not a SAML response");
  if (unescapeXml(attr(responseTag, "Destination") ?? "") !== sp.acsUrl) {
    throw new SamlError("destination", "the response is for another address");
  }
  if (!xml.includes('Value="urn:oasis:names:tc:SAML:2.0:status:Success"')) {
    throw new SamlError("status", "the provider did not report success");
  }
  // An unprompted response, or one that answers another request, is refused.
  const answered = attr(responseTag, "InResponseTo");
  if (context.expectedRequestId === undefined || answered === undefined) {
    throw new SamlError("unsolicited", "the response answers no request");
  }
  if (answered !== context.expectedRequestId) {
    throw new SamlError(
      "in_response_to",
      "the response answers another request",
    );
  }
  // One assertion only: a signed one cannot vouch for an unsigned one.
  const starts = [...xml.matchAll(/<saml:Assertion\b/g)];
  if (starts.length !== 1) {
    throw new SamlError(
      "assertions",
      `${starts.length} assertions in the response`,
    );
  }
  const assertion = /<saml:Assertion\b[\s\S]*<\/saml:Assertion>/.exec(xml)![0];
  const signature = /<ds:Signature\b[\s\S]*<\/ds:Signature>/.exec(
    assertion,
  )?.[0];
  if (!signature)
    throw new SamlError("unsigned", "the assertion is not signed");
  const info = /<ds:SignedInfo\b[\s\S]*<\/ds:SignedInfo>/.exec(signature)?.[0];
  const value = /<ds:SignatureValue>([^<]*)<\/ds:SignatureValue>/.exec(
    signature,
  )?.[1];
  if (!info || !value)
    throw new SamlError("malformed", "the signature is incomplete");
  // The key comes from the provider's metadata. A key inside the response is
  // whatever the sender wants it to be.
  const valid = createVerify("RSA-SHA256")
    .update(info)
    .verify(sp.idpPublicKey, Buffer.from(value, "base64"));
  if (!valid) throw new SamlError("signature", "the signature does not match");
  const assertionTag = /<saml:Assertion\b[^>]*>/.exec(assertion)![0];
  const id = attr(assertionTag, "ID");
  if (!id) throw new SamlError("malformed", "the assertion has no id");
  if (attr(/<ds:Reference\b[^>]*>/.exec(info)?.[0] ?? "", "URI") !== `#${id}`) {
    throw new SamlError("reference", "the signature covers another element");
  }
  const bare = assertion.replace(signature, "");
  const digest = createHash("sha256").update(bare).digest("base64");
  if (/<ds:DigestValue>([^<]*)<\/ds:DigestValue>/.exec(info)?.[1] !== digest) {
    throw new SamlError(
      "digest",
      "the assertion was changed after it was signed",
    );
  }
  // Only now is the content believed.
  const issuer = /<saml:Issuer>([^<]*)<\/saml:Issuer>/.exec(assertion)?.[1];
  if (unescapeXml(issuer ?? "") !== sp.idpEntityId) {
    throw new SamlError("issuer", "wrong issuer");
  }
  const conditions = /<saml:Conditions\b[^>]*>/.exec(assertion)?.[0] ?? "";
  const notBefore = time(attr(conditions, "NotBefore"));
  const notOnOrAfter = time(attr(conditions, "NotOnOrAfter"));
  if (notBefore === undefined || notOnOrAfter === undefined) {
    throw new SamlError("malformed", "the conditions are incomplete");
  }
  if (context.now + skew < notBefore)
    throw new SamlError("not_yet", "not valid yet");
  if (context.now - skew >= notOnOrAfter)
    throw new SamlError("expired", "the assertion has ended");
  const audience = /<saml:Audience>([^<]*)<\/saml:Audience>/.exec(
    assertion,
  )?.[1];
  if (unescapeXml(audience ?? "") !== sp.entityId) {
    throw new SamlError("audience", "the assertion is for another service");
  }
  const confirmation =
    /<saml:SubjectConfirmationData\b[^>]*>/.exec(assertion)?.[0] ?? "";
  if (unescapeXml(attr(confirmation, "Recipient") ?? "") !== sp.acsUrl) {
    throw new SamlError("recipient", "the assertion is for another address");
  }
  if (attr(confirmation, "InResponseTo") !== context.expectedRequestId) {
    throw new SamlError(
      "in_response_to",
      "the assertion answers another request",
    );
  }
  const confirmedUntil = time(attr(confirmation, "NotOnOrAfter"));
  if (confirmedUntil === undefined || context.now - skew >= confirmedUntil) {
    throw new SamlError("expired", "the confirmation has ended");
  }
  if (context.usedAssertionIds.has(id)) {
    throw new SamlError("replay", "the assertion was already used");
  }
  context.usedAssertionIds.add(id);
  const nameId = unescapeXml(
    /<saml:NameID\b[^>]*>([^<]*)<\/saml:NameID>/.exec(assertion)?.[1] ?? "",
  );
  if (!nameId) throw new SamlError("malformed", "no NameID");
  const attributes = [
    ...assertion.matchAll(
      /<saml:Attribute Name="([^"]*)"><saml:AttributeValue>([^<]*)<\/saml:AttributeValue>/g,
    ),
  ].map(([, n, v]) => [unescapeXml(n!), unescapeXml(v!)] as const);
  const authn = /<saml:AuthnStatement\b[^>]*>/.exec(assertion)?.[0] ?? "";
  return {
    nameId,
    email: attributes.find(([n]) => n === "email")?.[1],
    name: attributes.find(([n]) => n === "name")?.[1],
    groups: attributes.filter(([n]) => n === "group").map(([, v]) => v),
    sessionIndex: attr(authn, "SessionIndex") ?? "",
    sessionNotOnOrAfter: time(attr(authn, "SessionNotOnOrAfter")) ?? 0,
    assertionId: id,
  };
}
