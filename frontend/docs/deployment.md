# One Docker image for frontend, API and MCP

The repository's existing root Dockerfile builds the TypeScript backend and the Vite frontend in separate build stages, then copies both outputs into the same Node 24 runtime image. Only the existing Node HTTP process runs. There is no frontend Dockerfile, NGINX, second container, runtime proxy endpoint or additional service.

Run from the repository root:

```sh
docker build -t italian-travel-search:local .
docker run --rm -p 127.0.0.1:3000:3000 italian-travel-search:local
```

| URL | Purpose |
|---|---|
| `http://127.0.0.1:3000/` | Dark Binario frontend |
| `http://127.0.0.1:3000/api/providers` | Browser HTTP API (six search/discovery aliases) |
| `http://127.0.0.1:3000/providers` | Existing HTTP route, unchanged |
| `http://127.0.0.1:3000/health` | Existing liveness endpoint |
| `http://127.0.0.1:3000/mcp` | Existing MCP Streamable HTTP endpoint |

The final image runs `node dist/index.js` as the `node` user. HOST defaults to `0.0.0.0` inside the container and PORT remains 3000. Only compiled backend output, production backend dependencies and `frontend/dist` are copied into the runtime. Frontend dependencies, source, tests, local overrides, private evidence and browser traces are excluded. The common `.dockerignore` excludes nested sensitive/local files from the build context.

Frontend requests use relative `/api/*` URLs. The Node wrapper maps exactly six browser search/discovery routes to the existing API handler, preserving client identity, parameters, rate limiting and snapshots. `/api/mcp` is not exposed as an alias. Existing root HTTP paths and `/mcp` remain on the same listener for compatibility. HTML is served with no-cache; generated JavaScript/CSS use immutable caching. Static responses carry same-origin CSP, nosniff and no-referrer headers. Unknown paths are not rewritten to the application, and source/maps/environment files are not served.

No API_ORIGIN, API_RESOLVER or MCPHub key is required in the image. API_ORIGIN in ignored `frontend/.env.local` applies only to Vite development/preview. Existing HOST/PORT settings and backend health checks remain applicable. No database, Redis, volume, customer authentication or booking process was added.

Without Docker:

```sh
npm ci
npm ci --prefix frontend
npm run build:all
node dist/index.js
# Open http://127.0.0.1:3000/
```

For development with automatic frontend rebuilding, keep `npm start` and `npm run web:dev` in separate terminals. This development convenience does not create another production process.

## Verification

Automated tests remain offline. `npm run check:all` covers backend/static route tests, frontend logic, the existing synthetic browser scenarios and an additional browser suite against the compiled Node server with injected synthetic providers. The latter verifies the production assets, one-origin snapshot search, legacy/browser API routes, liveness and MCP initialization without contacting real operators.

After building the image locally, check:

```sh
curl --fail http://127.0.0.1:3000/health
curl --fail http://127.0.0.1:3000/api/providers
curl --fail http://127.0.0.1:3000/providers
curl -I http://127.0.0.1:3000/
# Must return 404:
curl -i http://127.0.0.1:3000/.env
curl -i http://127.0.0.1:3000/api/mcp
```

Both linux/amd64 and linux/arm64 images were built and started locally. Default-entrypoint smoke checks passed with network disabled, and the production browser suite passed against the image using synthetic providers on a dedicated Docker test network. The 88 backend checks also passed inside both Node 24 Linux build stages without network. The publication workflow now targets both linux/amd64 and linux/arm64 under one image index. No local check calls live providers or changes the cluster; an authorized push to master triggers the existing GHCR publication workflow.

## Existing infrastructure

The existing container publication workflow rebuilds the same image when frontend runtime/build files change. No new image or Deployment is needed. Existing API/MCP consumers keep their URLs. Keep one backend replica while snapshots remain process-local. If an ingress is considered later, explicitly choose which existing API/MCP paths it may expose; the UI does not itself require exposing MCP to public users. Review deployment authorization and environment-specific instructions separately. Publishing source does not require hosting this service.

To rerun the browser suite against an already running synthetic container on loopback port 4174, set `CONTAINER_TEST=1` when running `npm --prefix frontend run test:production`. The fixture entrypoint `frontend/test/production-server.mjs` honors HOST/PORT so it can be mounted read-only into the image for tests; it is not copied into the production image. Keep that container on a dedicated test network and do not use live providers in automation.

## Multiarch builds

The same published image tag supports `linux/amd64` and `linux/arm64`. Build both locally with a multi-platform-capable Docker builder:

```sh
docker buildx build --platform linux/amd64,linux/arm64 --load -t italian-travel-search:multiarch-verification .
docker run --rm --network none --platform linux/amd64 italian-travel-search:multiarch-verification node -p process.arch
docker run --rm --network none --platform linux/arm64 italian-travel-search:multiarch-verification node -p process.arch
```

The expected outputs are `x64` and `arm64`. The existing GitHub workflow uses QEMU and Buildx to push both variants together; no architecture-specific deployment or second frontend image is needed. Inspect the published tag with `docker buildx imagetools inspect ghcr.io/alexxanddr/italian-travel-search:latest` and confirm both runnable platform entries. A Docker store that cannot load a multi-platform image can test each `--platform` build separately instead.
