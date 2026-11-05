# Binario · Italian Travel Search Web

The Italian-language frontend for [Italian Travel Search](https://github.com/Alexxanddr/italian-travel-search). Search one-way bus and train journeys, compare actual stops and times, inspect observed fares, and continue on the official operator's website.

The frontend lives in `frontend/` in the same repository as the API and shares its HTTP domain types. It keeps its own development dependencies and static build. No additional database, AI model, authentication or booking system is included. Production runs in the existing backend image and Node process: it serves static assets at `/` and browser API aliases at `/api/*` on the same port as the HTTP and MCP interfaces. No NGINX or second container is used. The browser never calls providers or MCPHub.

## Run locally

Use Node.js **22.18+** (24 LTS is used in the Docker build) and npm. From the repository root, install both dependency sets and start the backend:

```sh
npm ci
npm ci --prefix frontend
npm start
```

From the repository root, in a second terminal:

```sh
cp frontend/.env.example frontend/.env.local
npm run web:dev
```

Open **http://127.0.0.1:5173**. The only configuration is `API_ORIGIN` in the ignored `frontend/.env.local`, defaulting to `http://127.0.0.1:3000`. It must be an HTTP(S) origin without a path or credentials. Restart Vite after changing it. This is a server-side proxy setting, never a `VITE_*` browser variable. No API key, MCP URL, provider credential or secret is needed.

For a local production build preview (with the same development proxy):

```sh
npm run web:build
npm --prefix frontend run preview
# http://127.0.0.1:4173
```

Vite preview is for local review, not production hosting. See [Docker and deployment](docs/deployment.md) for the combined image and its verification commands.

## Search and compare

- The default “Tutti” search needs only one origin, one destination and a date. Bus-only and train-only tabs use the same compact form. Passenger counts default to one adult and zero children and can be changed in the collapsed “Passeggeri” control. The interface uses a dark navy theme throughout. Autocomplete combines the relevant bus and rail HTTP catalogs; the total search shows explicit all-stations entries as city names. Rail requests resolve exact names or explicit all-stations groups to each provider’s returned ID. No arbitrary main station or nearby city is substituted; unsupported/ambiguous localities remain explicit provider errors.
- Choose today or a future calendar date in Europe/Rome, 1–9 adults and 0–9 children. Same-day searches enable “Solo partenze future”; switching it off retains the requested date and performs no new search.
- Results arrive by operator, with at most three journey requests in flight. Every snapshot page is loaded automatically. The interface reports loaded/total counts and errors. A failed or partially loaded search is never called an exhaustive absence of journeys.
- Compare by departure or duration; filter by mode, operator, time, known changes and comparable train totals. “No operator selected” means all operators. Mobile filters are collapsible.
- Price sorting groups **known rail totals by currency**. Bus fares and missing fares follow without a price ranking. No currency conversion is performed. A bus fare's passenger basis is not declared in the current API, so a cross-mode cheapest-fare claim would be misleading. Bus amounts are shown exactly as supplied, marked “Base passeggeri non dichiarata”.
- Rail totals show requested adults and children. Missing prices read “Non disponibile”, never zero. Availability is provider-reported, not guaranteed. Expand details for source/observation, all rail legs, operating carriers, connections and dates. Native Italo + Trenitalia connections are labeled with both operators and Italo as the booking source, preserving the through total and actual Cosenza destination. Excluded transfers are flagged next to the fare; UB is urban transport, not a train.
- Up to three distinct suggestions use the visible, available results. Cheapest/balance require rail totals in one currency and no explicitly excluded transfers. Fastest uses reported duration. Balance equally weights normalized price and duration. Loading or errors keep suggestions explicitly provisional; there is no claim to the cheapest trip in the market.
- Search parameters are stored in a shareable URL and restored with browser Back/Forward. New URLs use `origin` and `destination`; legacy mode-specific URL fields are still read (combined legacy URLs use their bus route). No names, contact details or secrets are requested.

## Verification

All automated tests are offline and use synthetic fixtures. Browser requests to nonlocal origins are blocked in the test harness. Install the test browser once:

```sh
cd frontend
npx playwright install chromium
cd ..
npm run check:all
npm audit --prefix frontend --audit-level=high
```

`npm run web:check` from the repository root runs frontend unit/client tests, strict TypeScript checking, a production build, and Chromium tests for desktop and an emulated mobile viewport. No live provider is contacted. `npm run check:all` also builds/checks the backend before exercising its compiled production server. The frontend production browser suite needs the root dependencies and backend build; use the root command for a clean checkout. Browser traces and screenshots are ignored. See [verification coverage](docs/verification.md).

Manual live checks must remain limited and be recorded under ignored `frontend/docs/private/`; never commit live responses or describe synthetic fixtures as live prices. Opening a populated share URL starts a new search; refreshing the development page can do the same.

## Project map

| File | Purpose |
|---|---|
| `index.html`, `styles.css` | Semantic search page, responsive visual system |
| `main.ts` | Autocomplete, URL/form lifecycle, rendering, focus and filters |
| `client.ts` | Same-origin HTTP, validation, provider concurrency and stable pagination |
| `model.ts` | Rome dates, fare comparisons, filters and suggestions |
| `contracts.ts` | Type-only re-export of `../src/domain.ts` |
| `vite.config.ts` | Development and preview proxy |
| `../Dockerfile`, `../src/web.ts` | One production image/process for static assets, HTTP API and MCP |
| `test/` | Synthetic fixtures, unit and browser tests |

See [architecture and UX](docs/architecture.md) for state transitions, integration constraints and compatible backend improvements. No backend contracts were changed. Flights, BlaBlaCar, accounts, payment, internal booking, live train boards and seat selection are outside this version.
