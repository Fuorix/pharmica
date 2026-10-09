export interface ApiError {
  error: {
    code: string;
    message: string;
    requestId?: string;
    /** Machine-readable context, e.g. the subscription status behind a 402. */
    details?: Record<string, unknown>;
  };
}

export function apiError(
  status: number,
  code: string,
  message: string,
  requestIdOrDetails?: string | Record<string, unknown>
): Response {
  const extra = typeof requestIdOrDetails === "string" ? { requestId: requestIdOrDetails } : requestIdOrDetails ? { details: requestIdOrDetails } : {};
  const body: ApiError = { error: { code, message, ...extra } };
  return Response.json(body, { status });
}
