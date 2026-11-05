# Verification

Implementation review: 2026-11-05.

| Check | Result |
|---|---|
| `npm test` | 19 offline unit/client tests passed |
| `npm run build` | Strict TypeScript and Vite production build passed |
| `npm run test:browser` | 20 offline Chromium scenarios passed (10 desktop, 10 mobile) |
| `npm run test:production` | 4 offline browser cases against the compiled combined Node server passed |
| Backend `npm run check` | 88 offline tests, type check, lint and build passed; existing HTTP/provider contracts preserved; static/alias handling added |
| `npm audit --audit-level=high` | No vulnerabilities at verification |
| Manual browser flow against real HTTP backend | Search, progress, compare, source/details, overnight dates and partial provider failure checked; evidence in ignored docs/private |
| Combined Docker image runtime | linux/amd64 build and default non-root entrypoint passed; private-file exclusion, UI/assets, HTTP/MCP and four synthetic browser cases verified |

## Offline coverage

- Unified city search, bus only and train only; dark color scheme; shared provider-specific all-stations resolution; keyboard autocomplete and exact route names; share URL and Back restoration.
- Today in Europe/Rome, already departed journeys, toggle without changing date or issuing another search, overnight arrivals, Italian midnight and both DST fold instants/gap behavior.
- Null versus actual zero prices, currency grouping, missing bus passenger basis, unknown changes, unavailable journeys and excluded-transfer suggestions.
- Provider progress, one provider/mode failing while others succeed, empty success versus unsuccessful search, 503 structured errors and readable provider failures.
- More than fifty journeys, stable ID and total across continuation, only ID/offset/limit in continuation, expiry discarding the affected snapshot, partial coverage labels and complete sorting/filtering after every page loads.
- New search while previous responses remain in flight, late-response suppression, browser abort and no duplicated active-query submission.
- Retry-After cooldown, malformed HTTP prices and basic/extended timezone offsets at the response boundary.
- Mobile viewport without horizontal overflow; collapsible filters; native disclosure keyboard behavior; safe HTTPS official booking links. Screenshots under ignored test-results use synthetic fixtures only.

Tests block all nonlocal browser origins and inject fetch into HTTP client tests. Fixtures never contain captured live responses. There is no live smoke script in the automated suite.

## Remaining scope

Browser automation uses Chromium desktop and Chromium mobile emulation, not physical devices or a complete Safari/Firefox/assistive-technology matrix. The manual browser check is low volume and cannot establish universal provider uptime or fare validity. Backend tests prove its existing behavior, not commercial price guarantees. Docker validation covers linux/amd64 on Node 24; other image architectures were not exercised. Live counts/prices belong only in ignored private notes, never in synthetic tests or public claims.

The 0.3.8 update adds synthetic regression coverage for native Italo + Trenitalia legs via Paola, the full connection fare, exact Cosenza arrival, all-stations city resolution, refusal to choose an arbitrary station, and reuse of completed autocomplete lookups. Manual evidence for the updated backend and unified dark form remains in ignored docs/private.

## Repository integration and source-publication review

The frontend now lives in `frontend/` in the backend repository and shares `src/domain.ts` through type-only exports. Root `web:*`, `build:all` and `check:all` commands coordinate the two lockfiles. CI runs frontend tests separately without changing backend publishing. The root package verification checks Git paths and the backend npm export. See [source publication review](../../docs/publication-review.md) for scan scope and the historical local-path disclosure; no Git history was rewritten. Local private notes/configuration were preserved and remain ignored after the move.

## Single-image integration

The root Dockerfile now includes the built frontend. Five additional offline backend tests cover static MIME/security/cache behavior, HEAD, missing builds, private/source/map/traversal rejection, browser aliases and shared rate budgets. Four additional browser cases (desktop/mobile) exercise the real production assets through the compiled Node server with injected synthetic providers, including snapshot search and MCP initialization on the same origin. Build the backend first (`npm run build`) when running the frontend production suite independently. No live provider calls are made by these tests.

## Docker verification completed

The unified linux/amd64 image was built and tested locally after Docker became available. Its default entrypoint ran with `--network none`: non-root identity, production-only filesystem, UI assets and headers, browser/legacy APIs, private-path rejection, input validation and MCP initialization passed. All 88 backend checks also passed in the Node 24 Linux build stage with network disabled and read-only synthetic test fixtures. The four production browser cases were rerun against the final image on a dedicated Docker test network with a read-only synthetic provider fixture, exposed only on loopback. No live provider call or image publication was part of these local checks. Both dependency audits returned zero vulnerabilities.
