/** Bounded request body read — plan §14.5 / G6 (bytes, streaming). */

export type BoundedBodyResult =
  | { ok: true; text: string }
  | { ok: false; reason: "too_large" | "empty" };

export async function readBoundedUtf8(
  request: Request,
  maxBytes: number,
): Promise<BoundedBodyResult> {
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader !== null) {
    const declared = Number(lengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { ok: false, reason: "too_large" };
    }
  }

  const stream = request.body;
  if (!stream) return { ok: true, text: "" };

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (total === 0) return { ok: true, text: "" };

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return { ok: true, text: new TextDecoder().decode(merged) };
}

export async function readBoundedJson(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; status: number; code: string; message: string }> {
  const body = await readBoundedUtf8(request, maxBytes);
  if (!body.ok) {
    return {
      ok: false,
      status: 413,
      code: "payload_too_large",
      message: "request body too large",
    };
  }
  if (!body.text.trim()) {
    return {
      ok: false,
      status: 400,
      code: "bad_request",
      message: "expected a JSON body",
    };
  }
  try {
    return { ok: true, value: JSON.parse(body.text) };
  } catch {
    return {
      ok: false,
      status: 400,
      code: "bad_request",
      message: "expected a JSON body",
    };
  }
}
