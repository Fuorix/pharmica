const allowedOrigins = new Set([
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
  // Tauri POS webview origins (Windows and other platforms).
  "http://tauri.localhost",
  "tauri://localhost"
]);

export function corsOptions(request: Request): Response {
  return withCors(new Response(null, { status: 204 }), request);
}

export function withCors(response: Response, request: Request): Response {
  const origin = request.headers.get("origin");
  if (origin && allowedOrigins.has(origin)) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Access-Control-Allow-Credentials", "true");
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    response.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key, X-Device-Token");
    response.headers.set("Vary", "Origin");
  }
  return response;
}
