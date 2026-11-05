import { randomBytes } from "node:crypto";
import { AppError, type Location, type RailSearchInput } from "../domain.ts";
import { offsetRomeDateTime } from "./time.ts";
import type { RailQuote, RailQuoteProvider } from "./provider.ts";
import { TtlCache } from "../cache.ts";
import { responseJson } from "../upstream.ts";

const api = "https://api-biglietti.italotreno.com/api/v1/";

export class ItaloQuoteProvider implements RailQuoteProvider {
  readonly id = "italo" as const;
  readonly #fetch: typeof fetch;
  readonly #cache = new TtlCache<RailQuote[]>(60_000);
  readonly #locations = new TtlCache<Location[]>(3_600_000);
  constructor(fetcher: typeof fetch = fetch) { this.#fetch = fetcher; }

  async searchLocations(query: string): Promise<Location[]> {
    const cached = this.#locations.get(query);
    if (cached !== undefined) return cached;
    const stations = object(await this.request(`${api}stations/list`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ culture: "it-IT" }) }));
    const needle = query.toLocaleLowerCase("it");
    const locations = Object.entries(stations).flatMap(([id, raw]) => {
      const station = object(raw), name = requiredString(station.name);
      return station.isDisabled === true || ![id, `IT::StopPlace:${id}`, name].some((value) => value.toLocaleLowerCase("it").includes(needle)) ? []
        : [{ provider: this.id, id: `IT::StopPlace:${id}`, name, city: name, source: "live" as const, observedAt: new Date().toISOString() }];
    });
    this.#locations.set(query, locations);
    return locations;
  }

  async searchQuotes(input: RailSearchInput): Promise<RailQuote[]> {
    const key = JSON.stringify(input), cached = this.#cache.get(key);
    if (cached !== undefined) return cached;
    const workingId = randomBytes(12).toString("base64url").slice(0, 15);
    const token = await this.login(workingId);
    const headers = { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${token}`, "X-BIG-working-session-id": workingId };
    let bookingId: string | undefined;
    try {
      const stations = object(await this.request(`${api}stations/list`, { method: "POST", headers, body: JSON.stringify({ culture: "it-IT" }) }));
      const origin = stationId(input.origin, stations), destination = stationId(input.destination, stations);
      const operation = object(await this.request(`${api}booking`, { method: "POST", headers, body: JSON.stringify({ isRoundTrip: false, departureStation: origin, arrivalStation: destination, departureDate: input.date, culture: "it-IT", showPrivateOffers: false, showBestPrices: true, adultPassengers: input.adults, youngPassengers: 0, childPassengers: input.children, seniorPassengers: 0, hasPet: false, promoCode: "", promocodeAlias: "", employeeOffer: null, passengersAges: null, portalType: "B2C" }) }));
      const operationId = requiredString(operation.operationId), pollAfter = Math.max(0, Math.min(optionalNumber(operation.pollAfter) ?? 500, 2_000));
      const deadline = Date.now() + Math.max(0, Math.min(optionalNumber(operation.operationTimeout) ?? 20_000, 20_000));
      let result: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 20 && Date.now() < deadline; attempt += 1) {
        if (pollAfter > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(pollAfter, Math.max(0, deadline - Date.now()))));
        if (Date.now() >= deadline) break;
        const response = await this.raw(`${api}booking/status/${encodeURIComponent(operationId)}`, { headers, signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) }, true);
        if (response.status === 202 || response.status >= 500) { await response.body?.cancel(); continue; }
        result = object(await responseJson(response, "Italo quote"));
        break;
      }
      if (result === undefined) throw new AppError("QUOTE_UNAVAILABLE", "Italo quote operation timed out", 503);
      bookingId = optionalString(result.bookingId);
      const quotes = parseQuotes(result, { id: origin, name: requiredString(object(stations[origin]).name) }, { id: destination, name: requiredString(object(stations[destination]).name) }, stations, input.adults + input.children);
      this.#cache.set(key, quotes);
      return quotes;
    } finally {
      await Promise.allSettled([
        ...(bookingId === undefined ? [] : [this.raw(`${api}booking/${encodeURIComponent(bookingId)}`, { method: "DELETE", headers, body: "{}" }).then((response) => response.body?.cancel())]),
        this.raw(`${api}working-sessions`, { method: "DELETE", headers }).then((response) => response.body?.cancel()),
      ]);
    }
  }

  private async login(workingId: string): Promise<string> {
    const response = await this.raw("https://biglietti.italotreno.com/api/login", { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "X-Anonymous-User": "true" }, body: JSON.stringify({ isAnonymous: true, workingId }) });
    await responseJson(response, "Italo anonymous login");
    const token = /(?:^|,)\s*BIGSessionToken=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
    if (token === undefined) throw new AppError("QUOTE_UNAVAILABLE", "Italo anonymous session token was not returned", 503);
    return token;
  }

  private async request(url: string, init: RequestInit): Promise<unknown> { return responseJson(await this.raw(url, init), "Italo quote"); }
  private async raw(url: string, init: RequestInit, allowServerError = false): Promise<Response> {
    let response: Response;
    try { response = await this.#fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000) }); }
    catch { throw new AppError("QUOTE_UNAVAILABLE", "Italo quote request failed", 503); }
    if (response.status === 429) throw new AppError("RATE_LIMITED", "Italo quote rate limit reached", 429);
    if (!response.ok && response.status !== 202 && !(allowServerError && response.status >= 500)) throw new AppError("QUOTE_UNAVAILABLE", `Italo quote returned HTTP ${response.status}`, 503);
    return response;
  }
}

function stationId(value: string, stations: Record<string, unknown>) {
  const code = /(?:^|:)StopPlace:([^:]+)$/.exec(value)?.[1] ?? value;
  if (Object.hasOwn(stations, code) && object(stations[code]).isDisabled !== true) return code;
  const name = value.replace(/\s+\([^)]*\)$/, "");
  const matches = Object.entries(stations).filter(([, raw]) => { const station = object(raw); return station.isDisabled !== true && optionalString(station.name)?.localeCompare(name, undefined, { sensitivity: "accent" }) === 0; });
  if (matches.length !== 1) throw new AppError(matches.length > 1 ? "AMBIGUOUS_LOCATION" : "UNKNOWN_LOCATION", `Italo location ${value} was not resolved exactly`, 400);
  return matches[0][0];
}
function parseQuotes(result: Record<string, unknown>, origin: { id: string; name: string }, destination: { id: string; name: string }, stations: Record<string, unknown>, passengerCount: number): RailQuote[] {
  const observedAt = new Date().toISOString();
  const trip = array(result.trips).map(object).find((value) => value.direction === "forward");
  if (trip === undefined) return [];
  return array(trip.travelSolutions).flatMap((entry) => {
    const journeys = array(object(entry).journeys).map(object);
    const direct = journeys.length === 1 && journeys[0]?.serviceProvider === "ITALO";
    const partnerConnection = journeys.length === 2 && journeys[0]?.serviceProvider === "ITALO" && journeys[1]?.serviceProvider === "TRENITALIA";
    if (!direct && !partnerConnection) throw new AppError("INCOMPATIBLE_RESPONSE", "Unsupported Italo journey structure", 502);
    const parts = journeys.map((journey, index) => {
      const segments = array(journey.segments).map(object);
      if (segments.length !== 1) throw new AppError("INCOMPATIBLE_RESPONSE", "Unsupported Italo connection structure", 502);
      const segment = segments[0]!, trainNumber = requiredString(segment.trainNumber);
      const departure = offsetRomeDateTime(requiredString(segment.std)), arrival = offsetRomeDateTime(requiredString(segment.sta));
      if (!Number.isFinite(Date.parse(departure)) || !Number.isFinite(Date.parse(arrival)) || Date.parse(arrival) < Date.parse(departure)) {
        throw new AppError("INCOMPATIBLE_RESPONSE", "Invalid Italo connection timing", 502);
      }
      const endpoint = (code: unknown, fallback: { id: string; name: string }) => {
        if (code === undefined && direct) return fallback;
        const id = requiredString(code);
        if (!Object.hasOwn(stations, id)) throw new AppError("INCOMPATIBLE_RESPONSE", "Unknown Italo connection station", 502);
        return { id, name: requiredString(object(stations[id]).name) };
      };
      const priced = array(segment.fares).map(object).flatMap((fare) => {
        const passengers = array(fare.paxFares).map(object);
        const total = passengers.reduce((sum, pax) => {
          const amount = optionalNumber(pax.fullPaxDiscountPrice);
          if (amount !== undefined && amount < 0) throw new AppError("INCOMPATIBLE_RESPONSE", "Invalid Italo quote price", 502);
          return sum + (amount ?? Number.NaN);
        }, 0);
        return passengers.length === passengerCount && Number.isFinite(total) && total >= 0 && (optionalNumber(fare.availableCount) ?? 0) >= passengerCount ? [{ total, fare }] : [];
      }).sort((left, right) => left.total - right.total)[0];
      return { priced, leg: { operator: index === 0 ? "italo" as const : "trenitalia" as const, trainNumber,
        origin: endpoint(segment.departureStation, origin), destination: endpoint(segment.arrivalStation, destination), departure, arrival } };
    });
    const first = parts[0]!, last = parts.at(-1)!;
    for (let index = 1; index < parts.length; index += 1) {
      const previous = parts[index - 1]!.leg, next = parts[index]!.leg;
      if (previous.destination.id !== next.origin.id || Date.parse(next.departure) < Date.parse(previous.arrival)) {
        throw new AppError("INCOMPATIBLE_RESPONSE", "Disconnected Italo connection", 502);
      }
    }
    const available = parts.every(({ priced }) => priced !== undefined);
    return [{ trainNumbers: parts.map(({ leg }) => leg.trainNumber), departure: first.leg.departure, arrival: last.leg.arrival, available,
      price: !available ? null : { amount: Math.round(parts.reduce((sum, { priced }) => sum + priced!.total, 0) * 100) / 100, currency: "EUR",
        ...(direct ? { fareName: optionalString(first.priced!.fare.offerType), travelClass: optionalString(first.priced!.fare.productClass) } : {}),
        observedAt, source: partnerConnection ? "Italo booking quote including Trenitalia connection" : "Italo booking quote" },
      observedAt, source: "Italo booking search", legs: parts.map(({ leg }) => leg) }];
  });
}
function object(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AppError("INCOMPATIBLE_RESPONSE", "Incompatible Italo quote response", 502); return value as Record<string, unknown>; }
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw new AppError("INCOMPATIBLE_RESPONSE", "Incompatible Italo quote response", 502); return value; }
function optionalString(value: unknown) { return typeof value === "string" || typeof value === "number" ? String(value) : undefined; }
function requiredString(value: unknown) { const result = optionalString(value); if (result === undefined) throw new AppError("INCOMPATIBLE_RESPONSE", "Missing Italo quote field", 502); return result; }
function optionalNumber(value: unknown) { if (value === undefined || value === null || value === "") return undefined; const result = Number(value); if (!Number.isFinite(result)) throw new AppError("INCOMPATIBLE_RESPONSE", "Invalid Italo quote number", 502); return result; }
