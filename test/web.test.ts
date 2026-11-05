import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createWebHandler } from "../src/web.ts";
import { createApp } from "../src/app.ts";

async function fixture(context: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "travel-static-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "<!doctype html><title>Synthetic frontend</title>");
  await writeFile(join(root, "assets", "index-test.js"), "console.log('synthetic');");
  await writeFile(join(root, "assets", "index-test.css"), "body{color:white}");
  await writeFile(join(root, ".env"), "SYNTHETIC=not-public");
  return pathToFileURL(`${root}/`);
}

test("serves the frontend and hashed assets with MIME, cache and security headers", async context => {
  const root = await fixture(context);
  const web = createWebHandler(createApp([], [], []), root);
  for (const [path, mime] of [["/", "text/html"], ["/index.html?origin=Roma", "text/html"], ["/assets/index-test.js", "text/javascript"], ["/assets/index-test.css", "text/css"]]) {
    const response = await web(new Request(`http://localhost${path}`));
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("content-type")!.startsWith(mime!));
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.match(response.headers.get("content-security-policy")!, /connect-src 'self'/);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("cache-control"), path!.startsWith("/assets") ? "public, max-age=31536000, immutable" : "no-cache");
  }
  const head = await web(new Request("http://localhost/", { method: "HEAD" }));
  assert.equal(await head.text(), "");
  assert.ok(Number(head.headers.get("content-length")) > 0);
});

test("does not serve source, env, maps, directories or encoded traversal paths", async context => {
  const web = createWebHandler(createApp([], [], []), await fixture(context));
  for (const path of ["/.env", "/src/domain.ts", "/assets/", "/assets/index-test.js.map", "/assets/%2e%2e%2f.env", "/assets/missing.js"]) {
    const response = await web(new Request(`http://localhost${path}`));
    assert.equal(response.status, 404, path);
    assert.doesNotMatch(await response.text(), /SYNTHETIC=not-public/);
  }
  assert.equal((await web(new Request("http://localhost/", { method: "POST" }))).status, 405);
});

test("browser aliases preserve query and client identity and do not alias MCP", async context => {
  const calls: Array<{ path: string; client?: string }> = [];
  const web = createWebHandler(async (request, client) => { calls.push({ path: new URL(request.url).pathname + new URL(request.url).search, client }); return Response.json({ ok: true }); }, await fixture(context));
  await web(new Request("http://localhost/api/journeys?searchId=test&offset=50&limit=50"), "synthetic-client");
  await web(new Request("http://localhost/providers"), "legacy-client");
  await web(new Request("http://localhost/api/mcp"));
  assert.deepEqual(calls, [{ path: "/journeys?searchId=test&offset=50&limit=50", client: "synthetic-client" }, { path: "/providers", client: "legacy-client" }, { path: "/api/mcp", client: undefined }]);
});

test("static requests do not consume the API rate budget and aliases share the legacy budget", async context => {
  const web = createWebHandler(createApp([], [], []), await fixture(context));
  for (let n = 0; n < 65; n++) assert.equal((await web(new Request("http://localhost/"))).status, 200);
  for (let n = 0; n < 60; n++) assert.equal((await web(new Request(`http://localhost/${n % 2 ? "api/" : ""}providers`))).status, 200);
  assert.equal((await web(new Request("http://localhost/api/providers"))).status, 429);
  assert.equal((await web(new Request("http://localhost/health"))).status, 200);
});

test("missing frontend builds leave legacy API routes operational", async context => {
  const root = new URL("missing/", await fixture(context));
  const web = createWebHandler(createApp([], [], []), root);
  assert.equal((await web(new Request("http://localhost/"))).status, 404);
  assert.equal((await web(new Request("http://localhost/providers"))).status, 200);
  assert.equal((await web(new Request("http://localhost/api/providers"))).status, 200);
  assert.equal((await web(new Request("http://localhost/api/mcp"))).status, 404);
});
