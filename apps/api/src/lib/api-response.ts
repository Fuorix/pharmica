export interface ApiError {
  error: {
    code: string;
    message: string;
    requestId?: string;
  };
}

export function apiError(
  status: number,
  code: string,
  message: string,
  requestId?: string
): Response {
  const body: ApiError = { error: { code, message, requestId } };
  return Response.json(body, { status });
}
