/** The one error shape every `/api/*` response uses — see PLAN.md Section 7. */
export type ApiError = {
  code: string;
  message: string;
  detail?: unknown;
  requestId: string;
};

export function errorResponse(
  status: number,
  code: string,
  message: string,
  detail?: unknown,
): Response {
  const requestId = crypto.randomUUID();
  const error: ApiError = detail === undefined
    ? { code, message, requestId }
    : { code, message, detail, requestId };
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
