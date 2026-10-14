// Serves a built web app (owner panel, admin panel, or POS) on $PORT, for hosting such as Railway.
// Usage: node scripts/serve-static.mjs apps/owner-web/dist
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? "dist");
const port = Number(process.env.PORT) || 8080;
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon",
  ".webp": "image/webp", ".woff2": "font/woff2", ".woff": "font/woff", ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json"
};

async function fileFor(urlPath) {
  const path = normalize(join(root, decodeURIComponent(urlPath)));
  if (path !== root && !path.startsWith(root + sep)) return null;
  const found = await stat(path).catch(() => null);
  if (found?.isFile()) return path;
  if (found?.isDirectory()) return fileFor(join(urlPath, "index.html"));
  return null;
}

createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  const urlPath = new URL(request.url ?? "/", "http://localhost").pathname;
  // A malformed path (bad % escape) is treated as not found.
  let path = await fileFor(urlPath).catch(() => null);
  // The apps route on the client, so unknown paths get the app itself; missing assets are a real 404.
  if (!path && !extname(urlPath)) path = join(root, "index.html");
  if (!path) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
    return;
  }
  // Built assets have content hashes in their names and never change; index.html must always be fresh.
  const cache = urlPath.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
  response.writeHead(200, {
    "Content-Type": types[extname(path).toLowerCase()] ?? "application/octet-stream",
    "Cache-Control": cache,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin"
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(path).pipe(response);
}).listen(port, () => console.log(`Serving ${root} on port ${port}`));
