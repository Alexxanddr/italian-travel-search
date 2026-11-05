import type { Journey, Location, RailJourney, SearchInput } from './contracts.ts';

export type Mode = 'bus' | 'train';
export type Trip = { mode: Mode; data: Journey | RailJourney };
export type Query = SearchInput & { mode: 'both' | Mode };
export const locationName = (name: string) => name.replace(/\s*\(\s*tutte(?:\s+le\s+stazioni)?\s*\)\s*$/i, '').trim();
export function resolveRailLocation(locations: Location[], provider: string, query: string): Location | undefined {
  const normalized = query.trim().toLocaleLowerCase('it');
  const candidates = locations.filter(l => l.provider === provider);
  const exact = candidates.filter(l => l.id === query || l.name.toLocaleLowerCase('it') === normalized);
  if (exact.length === 1) return exact[0];
  const city = candidates.filter(l => locationName(l.name).toLocaleLowerCase('it') === normalized);
  return city.length === 1 ? city[0] : undefined;
}
export const names: Record<string, string> = { itabus: 'Itabus', salemi: 'Autoservizi Salemi', federico: 'Autolinee Federico', marinobus: 'MarinoBus', flixbus: 'FlixBus', trenitalia: 'Trenitalia', italo: 'Italo' };
const parts = (value: string | number | Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
export const romeDate = (value: string | number | Date = Date.now()) => parts(value);
export const clock = (value: string) => new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
export const day = (value: string) => new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value.length === 10 ? `${value}T12:00:00+01:00` : value));
export const observation = (value: string) => `${day(value)}, ${clock(value)}`;
export const duration = (minutes: number) => `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
export const rail = (trip: Trip): RailJourney | undefined => trip.mode === 'train' ? trip.data as RailJourney : undefined;
export const key = (trip: Trip) => `${trip.mode}:${trip.data.provider}:${'journeyId' in trip.data ? trip.data.journeyId : trip.data.tripId}`;
export function money(trip: Trip): string {
  const price = trip.data.price;
  return price === null ? 'Non disponibile' : `${new Intl.NumberFormat('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(price.amount)} ${price.currency}`;
}
export function safeBookingUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}
export function readQuery(search: string, now = Date.now()): Query {
  const params = new URLSearchParams(search);
  const count = (name: string, min: number) => { const n = Number(params.get(name) ?? min); return Number.isInteger(n) && n >= min && n <= 9 ? n : min; };
  const date = params.get('date') ?? romeDate(now);
  const mode = params.get('mode');
  return { mode: mode === 'bus' || mode === 'train' ? mode : 'both', date, adults: count('adults', 1), children: count('children', 0),
    origin: (params.get('origin') ?? params.get(mode === 'train' ? 'trainOrigin' : 'busOrigin') ?? '').slice(0, 200),
    destination: (params.get('destination') ?? params.get(mode === 'train' ? 'trainDestination' : 'busDestination') ?? '').slice(0, 200) };
}
export function queryString(query: Query): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    params.set(name, String(value));
  }
  return params.toString();
}
export function validQuery(query: Query, now = Date.now()): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(query.date)) return false;
  const time = Date.parse(`${query.date}T12:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== query.date || query.date < romeDate(now)) return false;
  return !!(query.origin.trim() && query.destination.trim());
}
export type Filters = { mode: 'all' | Mode; operators: Set<string>; from: string; to: string; maxPrice: string; currency: string; changes: string; future: boolean };
export function filterTrips(trips: Trip[], filters: Filters, now = Date.now()): Trip[] {
  return trips.filter(trip => {
    const data = trip.data, price = data.price, changes = rail(trip)?.changes;
    const departure = clock(data.departure);
    return (filters.mode === 'all' || trip.mode === filters.mode) && (!filters.operators.size || filters.operators.has(data.provider)) &&
      (!filters.future || Date.parse(data.departure) > now) && (!filters.from || departure >= filters.from) && (!filters.to || departure <= filters.to) &&
      (!filters.maxPrice || (price !== null && price.currency === filters.currency && rail(trip) !== undefined && price.amount <= Number(filters.maxPrice))) &&
      (!filters.changes || (changes !== undefined && changes <= Number(filters.changes)));
  });
}
export function sortTrips(trips: Trip[], sort: string): Trip[] {
  return [...trips].sort((a, b) => {
    if (sort === 'price') {
      // Bus fares have no passenger basis in the HTTP contract; never rank them against rail totals.
      const pa = rail(a)?.price, pb = rail(b)?.price;
      if (!pa || !pb) return Number(!pa) - Number(!pb) || a.data.provider.localeCompare(b.data.provider) || Date.parse(a.data.departure) - Date.parse(b.data.departure);
      return pa.currency.localeCompare(pb.currency) || pa.amount - pb.amount || Date.parse(a.data.departure) - Date.parse(b.data.departure);
    }
    return (sort === 'duration' ? a.data.durationMinutes - b.data.durationMinutes : Date.parse(a.data.departure) - Date.parse(b.data.departure)) || key(a).localeCompare(key(b));
  });
}
export function suggestions(trips: Trip[]): Array<{ trip: Trip; label: string; reason: string }> {
  const available = trips.filter(t => t.data.available === true);
  const priced = available.filter(t => rail(t)?.price && !rail(t)?.legs.some(l => l.includedInPrice === false));
  const currencies = new Set(priced.map(t => t.data.price!.currency));
  const comparable = currencies.size === 1 ? priced : [];
  const cheap = sortTrips(comparable, 'price')[0], fast = sortTrips(available, 'duration')[0];
  const output: Array<{ trip: Trip; label: string; reason: string }> = [];
  if (cheap) output.push({ trip: cheap, label: 'Economico', reason: 'Totale ferroviario più basso nel confronto visibile, stessa valuta.' });
  if (fast && !output.some(x => key(x.trip) === key(fast))) output.push({ trip: fast, label: 'Veloce', reason: 'Durata minore tra le soluzioni disponibili nel confronto visibile.' });
  if (comparable.length > 2) {
    const minPrice = Math.min(...comparable.map(t => t.data.price!.amount)), maxPrice = Math.max(...comparable.map(t => t.data.price!.amount));
    const minDuration = Math.min(...comparable.map(t => t.data.durationMinutes)), maxDuration = Math.max(...comparable.map(t => t.data.durationMinutes));
    const score = (t: Trip) => (t.data.price!.amount - minPrice) / (maxPrice - minPrice || 1) + (t.data.durationMinutes - minDuration) / (maxDuration - minDuration || 1);
    const balance = [...comparable].sort((a,b) => score(a) - score(b))[0]!;
    if (!output.some(x => key(x.trip) === key(balance))) output.push({ trip: balance, label: 'Buon compromesso', reason: 'Prezzo e durata hanno lo stesso peso, normalizzati sul confronto ferroviario visibile.' });
  }
  return output;
}
