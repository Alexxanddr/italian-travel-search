import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApp, createMcpApp } from "../src/app.ts";
import { AppError, type RailJourney } from "../src/domain.ts";
import { ItaloQuoteProvider } from "../src/rail/italo-quote.ts";
import { LiveRailProvider } from "../src/rail/booking.ts";
import { RailSearchService } from "../src/rail/search.ts";
import { SearchSnapshots } from "../src/snapshots.ts";

const input = { origin: "Roma Termini", destination: "Cosenza", date: "2027-01-15", adults: 1, children: 0 };
function fixture() { return JSON.parse(readFileSync(new URL("./fixtures/italo-connection.json", import.meta.url), "utf8")); }
function provider(data = fixture()) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const source = new ItaloQuoteProvider(async (request, init) => {
    const url = String(request); calls.push({ url, init });
    if (url.endsWith("/api/login")) return Response.json({}, { headers: { "set-cookie": "BIGSessionToken=synthetic; Path=/" } });
    if (url.endsWith("stations/list")) return Response.json({ RMT: { name: "Roma Termini" }, PAR: { name: "Paola" }, COZ: { name: "Cosenza" }, OTHER: { name: "Other station" } });
    if (url.endsWith("/booking") && init?.method === "POST") return Response.json({ operationId: "synthetic-operation", pollAfter: 0 }, { status: 202 });
    if (url.includes("booking/status/")) return Response.json(data);
    return Response.json({});
  });
  return { source, calls };
}

test("preserves the official Italo + Trenitalia connection via Paola and prices the whole itinerary", async () => {
  const { source, calls } = provider();
  const rail = new LiveRailProvider(source);
  const journey = (await rail.searchJourneys(input))[0]!;
  assert.equal(journey.destination.name, "Cosenza");
  assert.equal(journey.origin.name, "Roma Termini");
  assert.equal(journey.changes, 1);
  assert.equal(journey.durationMinutes, 225);
  assert.deepEqual(journey.legs.map(leg => [leg.operator, leg.origin.name, leg.destination.name, leg.trainNumber]), [
    ["italo", "Roma Termini", "Paola", "1000"], ["trenitalia", "Paola", "Cosenza", "5000"],
  ]);
  assert.equal(journey.price?.amount, 22.6);
  assert.equal(journey.price?.fareName, undefined);
  assert.match(journey.price!.source, /including Trenitalia connection/);
  assert.equal(journey.available, true);
  assert.match(journey.bookingUrl!, /italotreno/);
  const booking = calls.find(c => c.url.endsWith("/booking") && c.init?.method === "POST")!;
  assert.equal(JSON.parse(String(booking.init!.body)).arrivalStation, "COZ");
  assert.ok(calls.some(c => c.url.endsWith("/synthetic-connection") && c.init?.method === "DELETE"));
  assert.ok(calls.some(c => c.url.endsWith("/working-sessions") && c.init?.method === "DELETE"));
  await rail.searchJourneys(input);
  assert.equal(calls.filter(c => c.url.endsWith("/api/login")).length, 1);
});

test("never substitutes the first-leg price when a connection fare is missing or unavailable", async () => {
  for (const reason of ["missing", "unavailable", "incompletePassengers"]) {
    const data = fixture();
    const fare = data.trips[0].travelSolutions[0].journeys[1].segments[0].fares[0];
    if (reason === "missing") delete fare.paxFares[0].fullPaxDiscountPrice;
    if (reason === "unavailable") fare.availableCount = 0;
    const { source } = provider(data);
    const quotes = await source.searchQuotes({ ...input, adults: reason === "incompletePassengers" ? 2 : 1 });
    assert.equal(quotes[0]!.price, null);
    assert.equal(quotes[0]!.available, false);
    assert.equal(quotes[0]!.legs!.at(-1)!.destination.name, "Cosenza");
  }
});

test("sums the quoted fares for all passengers on both legs", async () => {
  const data = fixture();
  for (const journey of data.trips[0].travelSolutions[0].journeys) journey.segments[0].fares[0].paxFares.push({ fullPaxDiscountPrice: 1.1 });
  assert.equal((await provider(data).source.searchQuotes({ ...input, adults: 2 }))[0]!.price!.amount, 24.8);
});

test("rejects disconnected, overlapping and unverified partner solutions, with cleanup and partial results", async () => {
  for (const reason of ["gap", "overlap", "operator", "station", "segments", "backwards", "negativePrice"]) {
    const data = fixture();
    const partner = data.trips[0].travelSolutions[0].journeys[1];
    if (reason === "negativePrice") partner.segments[0].fares[0].paxFares[0].fullPaxDiscountPrice = -1;
    if (reason === "gap") partner.segments[0].departureStation = "OTHER";
    if (reason === "station") partner.segments[0].arrivalStation = "UNKNOWN";
    if (reason === "overlap") partner.segments[0].std = "2027-01-15T10:59:00";
    if (reason === "backwards") partner.segments[0].sta = "2027-01-15T10:00:00";
    if (reason === "operator") partner.serviceProvider = "UNVERIFIED";
    if (reason === "segments") partner.segments.push(partner.segments[0]);
    const { source, calls } = provider(data);
    await assert.rejects(source.searchQuotes(input), (error: unknown) => error instanceof AppError && error.code === "INCOMPATIBLE_RESPONSE");
    assert.ok(calls.some(c => c.url.endsWith("/working-sessions") && c.init?.method === "DELETE"));
    const healthy = (await new LiveRailProvider(provider().source).searchJourneys(input)).map(j => ({ ...j, provider: "trenitalia" as const }));
    const result = await new RailSearchService([new LiveRailProvider(source), { id: "trenitalia", searchLocations: async () => [], searchJourneys: async () => healthy }]).searchJourneys(input);
    assert.equal(result.journeys.length, 1);
    assert.equal(result.errors[0]?.provider, "italo");
  }
});

test("preserves partner operators, Cosenza, total fare and changes through HTTP/MCP snapshots", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse("2027-01-14T12:00:00Z") });
  const snapshots = new SearchSnapshots();
  const rail = new LiveRailProvider(provider().source);
  const app = createMcpApp({ providers: [], railProviders: [rail], railLiveProviders: [], snapshots });
  const httpApp = createApp([], [rail], [], snapshots);
  const client = new Client({ name: "connection-test", version: "1.0.0" });
  context.after(async () => { await client.close(); await app.close(); });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), { fetch: (url, init) => app.fetch(new Request(url, init)) }));
  const result = await client.callTool({ name: "search_train_journeys", arguments: { ...input, snapshot: true, limit: 1 } });
  assert.notEqual(result.isError, true);
  const first = result.structuredContent as { journeys: RailJourney[]; searchId: string };
  assert.equal(first.journeys[0]!.legs[1]!.operator, "trenitalia");
  assert.equal(first.journeys[0]!.destination.name, "Cosenza");
  assert.equal(first.journeys[0]!.price!.amount, 22.6);
  assert.match(JSON.stringify(result.content), /via Paola/);
  const http = await httpApp(new Request(`http://localhost/train-journeys?searchId=${first.searchId}&offset=0&limit=1`));
  assert.equal(http.status, 200);
  assert.deepEqual((await http.json() as { journeys: RailJourney[] }).journeys, first.journeys);
  const fresh = await httpApp(new Request(`http://localhost/train-journeys?${new URLSearchParams({ origin: input.origin, destination: input.destination, date: input.date })}`));
  assert.equal((await fresh.json() as { journeys: RailJourney[] }).journeys[0]!.legs[1]!.operator, "trenitalia");
});


test("preserves an overnight official connection and its waiting time", async () => {
  const data = fixture();
  const journeys = data.trips[0].travelSolutions[0].journeys;
  journeys[0].segments[0].std = "2027-01-15T20:00:00";
  journeys[0].segments[0].sta = "2027-01-15T23:50:00";
  journeys[1].segments[0].std = "2027-01-16T00:10:00";
  journeys[1].segments[0].sta = "2027-01-16T00:40:00";
  const journey = (await new LiveRailProvider(provider(data).source).searchJourneys(input))[0]!;
  assert.equal(journey.arrival, "2027-01-16T00:40:00+01:00");
  assert.equal(journey.durationMinutes, 280);
  assert.equal(journey.changes, 1);
});
