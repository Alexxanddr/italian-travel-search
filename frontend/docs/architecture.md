# Architecture and UX

## Placement and stack

The frontend lives in `frontend/` inside the API repository, with its own package manifest and lockfile. Root scripts run both toolchains without introducing an npm workspace or changing the backend runtime. TypeScript 5.9, Vite 7.3 and platform DOM APIs suffice for one search page. There is no client runtime library or additional application server. The locked Vite 7.3 line receives important and security fixes under the [Vite support policy](https://vite.dev/releases).

`contracts.ts` re-exports types directly from `../../src/domain.ts` relative to this document (backend 0.3.8, commit `abb56cd` at review). The browser imports no backend runtime. TypeScript now checks consumers against the same domain definitions; review the boundary predicates in `client.ts` when updating the HTTP contract. Provider discovery uses the real `/providers` and `/train-providers` endpoints; provider IDs are not invented. Display-name fallbacks support configured IDs without enabling new transport modes.

## Visual direction

The identity is inspired by Italian transport wayfinding, with restrained route lines and large readable departure times. Use one typographic family: locally installed Avenir Next/Avenir, falling back to Segoe UI and sans-serif. No remote fonts, tracking or image requests are required.

| Token | Value | Purpose |
|---|---|---|
| Navy | `#24445d` | Summary, selected mode, booking actions |
| Blue | `#8fc7f1` | Interactive controls and rail |
| Yellow | `#ffd45a` | Main search action |
| Surface | `#192632` | Form and result rows |
| Ground | `#101923` | Page background |
| Muted | `#a7b9c9` | Supporting text with readable contrast |

Keep content left-aligned; reserve horizontal alignment for time/duration comparison and fares. The initial plan was revised to use transport rows and compact tickets rather than a decorative dashboard. The primary screen now uses one origin/destination/date row in all modes; passengers and supporting explanations are collapsed. Exact provider station IDs and explicit all-stations groups are resolved from HTTP catalogs, keeping cities distinct from individual stations.

```text
Desktop                         Mobile
Brand / short title             Brand / short title
Tutti / Bus / Treni              Tutti / Bus / Treni
From / To / Date / Search        From / To
Collapsed passengers            Date / Search
Persistent route summary        Collapsed passengers
Coverage / suggestions          Persistent route summary
Filters | ordered results       Coverage / suggestions
        | expandable legs       Collapsible filters / results
```

## Screen and state map

1. Initial: empty route fields, Rome's current date, adults/children, no sample journeys.
2. Search: validate, update URL, cancel the old generation and autocomplete, clear previous results and filters, then discover providers for the requested modes.
3. Loading: queue provider-specific snapshot searches with three workers; render each completed page immediately. Already available data is visible while other providers are loading.
4. Results: display loaded/known total, provider completion/errors, all loaded rows and local sorting/filtering. Until all selected providers finish successfully and all pages load, comparison remains explicitly partial.
5. Empty: a fully successful search with no returned journeys is distinct from provider failure and from filters hiding existing results.
6. Failure: preserve successful operators and any valid pages already loaded. Show safe error-code explanations, an explicit restart action and 429 cooldown when returned by HTTP.
7. Expired: remove the affected provider's old snapshot pages, explain cache expiry, retain other operators and require explicit whole-search restart. Restart clears every snapshot before loading new data.

## HTTP and request lifecycle

The browser calls `/api/{providers,train-providers,locations,train-locations,journeys,train-journeys}`. In production, the existing Node server serves built assets and maps these six aliases to its own API handler on the same origin, sharing its snapshots and client rate limiter. Static GET/HEAD requests have separate handling and cannot read arbitrary files. CSP restricts the UI to same-origin resources and connections. The original HTTP endpoints and `/mcp` remain available on the same listener; there is no `/api/mcp` alias. No MCP transport is used by the browser. Vite retains a development-only API proxy.

Each provider's first journey request contains the bus names or resolved provider-specific train IDs, date, passengers, provider, `snapshot=true` and `limit=50`. Each subsequent request contains **only** `searchId`, `offset` and `limit`. Snapshot ID and total must stay identical, page lengths/truncation must agree, and results must belong to that provider. Pages from different snapshots are never merged. All pages load sequentially per provider; local ordering applies to loaded coverage and becomes exhaustive only after successful completion of the selected search.

Rail origin/destination catalogs are loaded once per distinct place and shared across train operators. Exact station names/IDs take priority; only explicit `(Tutte)` or `(Tutte Le Stazioni)` groups can map a city to a group ID. No fuzzy prefix, nearby-station or first-result fallback exists. Resolved rail names appear under search coverage; journey rows retain their actual endpoints.

There is one journey request per provider, not an aggregate request followed by duplicated provider calls. This is the minimum existing API strategy for provider-level progress: aggregate routes await all upstream operators and expose no streaming events. Mode catalogs run in parallel. Concurrency is bounded to three journey requests, including continuations. Autocomplete is debounced by 450 ms after two characters, shares duplicate in-flight queries, caches up to 64 successful lookups in memory and cancels pending requests on submission. The API client also shares completed rail lookups between autocomplete and search resolution for at most one hour, matching the backend catalog cache; failures are not cached. Mode switches invalidate hidden-field suggestions. Search submission ignores a duplicate active query.

Every HTTP request has a 90-second client deadline. AbortController cancels the old browser requests and generation guards discard obsolete responses, even if a transport ignores abort. The current backend does not propagate browser cancellation into already running upstream work: it completes with its own bounded timeouts and caches. There is no automatic retry/fan-out after errors. HTTP 429 honors Retry-After, falling back to 60 seconds; controls show the cooldown. Provider-scoped RATE_LIMITED errors stay visible and are not automatically retried.

Inputs and JSON are untrusted: browser form validation is followed by API response predicates. Numeric prices, offsets, timestamps with explicit timezone (including `+0100`), station names and train legs are checked. External text is escaped before rendering. Booking URLs must be HTTPS without embedded credentials; the link is otherwise used as returned, with no invented query or fare. Booking links open with noopener/noreferrer.

## Accessibility and dates

Forms have labels, native controls, visible focus and a skip link. Autocomplete exposes listbox state and active descendant, supports Up/Down, Enter, Escape and Tab. Progress has a polite live region. Details use native keyboard-operable disclosures. Open trip details and focus on their summary/booking control survive progressive rendering. Mobile filters default closed; desktop filters remain available. No nonessential animation or external media is used.

Use Europe/Rome for calendar dates and displayed clocks; use timestamps/epochs for future-departure comparison and ordering. This preserves both occurrences of a DST fold and skips nonexistent local clock times naturally. Arrival dates are explicit across midnight. Duration is the backend value, not subtraction of formatted clock text. The future-only filter refreshes each minute without moving the requested date.

## Compatible backend improvements, not implemented here

1. Add optional bus `priceBasis` (for example `passenger_total` or `per_person`) and quoted passenger counts, based on verified upstream semantics; add source/observedAt. Until then, bus prices cannot safely join a rail-total ranking or maximum-total filter. Do not simply multiply an undocumented bus fare.
2. Add optional bus `changes` and legs only when actually reported. Absence remains unknown.
3. Propagate request cancellation through service/provider interfaces if upstream work after navigation becomes a material cost. Keep successful caches and best-effort Italo cleanup.
4. Consider a server streaming route only if a larger provider fleet makes independent snapshots too expensive. Existing per-provider snapshot calls need no contract change.
5. If a reverse proxy is introduced later, a trusted edge limiter should distinguish clients. Direct connections to the combined Node listener keep the existing socket-address budget; loading static assets does not consume it. Keep one API replica while snapshots are process-local (32 entries, five minutes, possible early eviction).

There is no promise of global travel-market coverage, fare validity through snapshot expiry, universal exact-name resolution across operators, or ticket coverage for transfers excluded by the provider.

## Backend 0.3.8 integration review

Commit `abb56cd` adds optional `RailLeg.operator` and verified native Italo + Trenitalia partner solutions. The frontend shares and validates that optional operator, labels each leg, and distinguishes booking source from operating carriers in mixed journeys. It displays the returned through price unchanged, including null/unavailable partner quotes. Paola remains an intermediate station when Cosenza is the requested destination. It never constructs or prices a separate connection itself. Unverified upstream shapes still fail explicitly in the backend.
