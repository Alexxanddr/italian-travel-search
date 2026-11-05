# HTTP API

The read-only HTTP API is split by transport mode:

- [Bus API](api-bus.md) — providers, stop resolution, journeys, prices, and booking links.
- [Train API](api-trains.md) — Trenitalia/Italo stations, journeys, live prices, status, and station boards.

Both APIs return JSON and use ISO 8601 timestamps. Unknown routes return
`404`; unsupported methods return `405`. Requests are limited to 60 per client
identifier in each process-local minute. `GET /health` returns
`{"status":"ok"}` without contacting any provider.

`/health` is exempt from the request limit. Input text is trimmed and limited
to 200 characters. Search dates can be today or later in `Europe/Rome`,
independently of the host timezone. Past and invalid calendar dates are rejected.
Same-day searches retain the requested calendar date; they do not automatically
remove departures earlier in the day or guarantee that those departures remain bookable. An empty successful search returns `200`
with `NO_JOURNEYS`; upstream failure with no journeys returns `503`.

Provider failures are isolated. Aggregate responses preserve successful data
and add safe entries to `errors`; upstream bodies, cookies, tokens, and stack
traces are never returned.

```json
{
  "provider": "trenitalia",
  "code": "QUOTE_UNAVAILABLE",
  "message": "Trenitalia quote request failed"
}
```

Common error codes are `INVALID_INPUT`, `UNKNOWN_LOCATION`, `NO_JOURNEYS`,
`PROVIDER_UNAVAILABLE`, `INCOMPATIBLE_RESPONSE`, and `RATE_LIMITED`. Rail also
uses `AMBIGUOUS_LOCATION`, `COVERAGE_UNAVAILABLE`, `QUOTE_UNAVAILABLE`,
`LIVE_STATUS_UNAVAILABLE`, and `TRAIN_NOT_FOUND`.

MCP exposes the same services through `/mcp`; see [MCP interface](mcp.md) for
tool names, pagination, and structured output.

## Stable journey pagination (bus and train)

The existing `/journeys` and `/train-journeys` requests remain unchanged:
without snapshot parameters they return the full live result and errors.
For a consistent paginated search, add `snapshot=true&limit=50` to the
first request, with the normal origin, destination, date and passenger fields.
New snapshots must start at offset zero.

```sh
curl 'http://127.0.0.1:3000/train-journeys?origin=Roma%20Termini&destination=Paola&date=2026-11-15&snapshot=true&limit=10'
# Copy searchId from the first response; omit the original query parameters:
curl 'http://127.0.0.1:3000/train-journeys?searchId=UUID-FROM-FIRST-RESPONSE&offset=10&limit=10'
```

Snapshot responses include `journeys`, `errors`, `total`, `truncated`,
`searchId`, `createdAt` and `expiresAt`. Increase offset by limit until
truncated is false. Every page retains the original order, prices, nullable
values and partial-provider errors; it performs no new upstream search.
To obtain updated prices or retry failed providers, start a new snapshot.
Do not mix searchId with origin/destination/date/passenger/provider fields.
IDs are bound to bus or train searches, but work across HTTP and MCP in the
same process.

Snapshots expire after five minutes, can be evicted earlier at capacity and
are lost on restart. Unknown/expired/wrong-mode IDs return HTTP 410
`SEARCH_EXPIRED`; restart from the first page rather than merging a new
search into old results. Invalid inputs return 400 `INVALID_INPUT`.
Results larger than 1 MiB cannot be snapshotted (413 `SEARCH_TOO_LARGE`);
narrow the query. At most 32 snapshots are retained per process.
Expiry does not guarantee that a saved fare remains purchasable.

## Combined frontend listener

The Node HTTP listener also serves the built web interface at `/` (and `/index.html`) and its generated JavaScript/CSS at `/assets/`. Static GET/HEAD requests do not consume the API limit. Static file names are restricted to the generated asset directory; source, environment files, source maps and arbitrary fallback paths are not exposed. Missing frontend builds return 404 without disabling the API.

Browser GET aliases `/api/providers`, `/api/train-providers`, `/api/locations`, `/api/train-locations`, `/api/journeys` and `/api/train-journeys` use the same validation, client rate budget, providers and snapshots as the original routes. Query strings and snapshot continuation parameters are preserved. There is no `/api/mcp` alias; MCP remains at `/mcp`. No existing bus/train response contract changed. Vite uses its own proxy only during development/preview.
