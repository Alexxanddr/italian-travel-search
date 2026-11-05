import { readFile } from "node:fs/promises";

type Handler = (request: Request, clientId?: string) => Promise<Response>;
const browserRoutes = new Set(["/providers", "/train-providers", "/locations", "/train-locations", "/journeys", "/train-journeys"]);
const securityHeaders = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

export function createWebHandler(api: Handler, root = new URL("../frontend/dist/", import.meta.url)): Handler {
  return async (request, clientId) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/") && browserRoutes.has(url.pathname.slice(4))) {
      url.pathname = url.pathname.slice(4);
      return api(new Request(url, request), clientId);
    }
    const index = url.pathname === "/" || url.pathname === "/index.html";
    const asset = /^\/assets\/[a-zA-Z0-9_-]+\.(js|css)$/.exec(url.pathname);
    if (!index && !asset) return api(request, clientId);
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { ...securityHeaders, allow: "GET, HEAD" } });
    let data: Uint8Array<ArrayBuffer>;
    try {
      data = new Uint8Array(await readFile(new URL(index ? "index.html" : url.pathname.slice(1), root)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return new Response("Frontend asset not found; build the frontend first", { status: 404, headers: securityHeaders });
    }
    return new Response(request.method === "HEAD" ? null : data, { headers: {
      ...securityHeaders,
      "content-type": index ? "text/html; charset=utf-8" : asset![1] === "js" ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8",
      "content-length": String(data.byteLength),
      "cache-control": index ? "no-cache" : "public, max-age=31536000, immutable",
    } });
  };
}
