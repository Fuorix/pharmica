const localOrigins = [
  // Vite uses 3000–3002; if those ports are already taken it walks 3003+.
  ...[3000, 3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009, 3010].flatMap((port) => [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`
  ]),
  // Tauri POS webview origins (Windows and other platforms).
  "http://tauri.localhost",
  "tauri://localhost"
];

/** The local apps plus any hosted ones listed in PHARMICA_ALLOWED_ORIGINS (comma-separated, e.g. https://owner.example.com). */
function allowedOrigins(): Set<string> {
  const hosted = (process.env.PHARMICA_ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim().replace(/\/+$/, "")).filter(Boolean);
  return new Set([...localOrigins, ...hosted]);
}

export function corsOptions(request: Request): Response {
  return withCors(new Response(null, { status: 204 }), request);
}

export function withCors(response: Response, request: Request): Response {
  const origin = request.headers.get("origin");
  if (origin && allowedOrigins().has(origin)) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Access-Control-Allow-Credentials", "true");
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    response.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key, X-Device-Token");
    response.headers.set("Vary", "Origin");
  }
  return response;
}
