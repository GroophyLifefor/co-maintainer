import { errorResponse } from "../errors.ts";

export async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown> | Response> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return errorResponse(400, "bad_request", "expected a JSON body");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return errorResponse(400, "bad_request", "expected a JSON object");
  }
  return value as Record<string, unknown>;
}
