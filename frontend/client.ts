import type { Journey, Location, ProviderError, RailJourney } from './contracts.ts';
import { resolveRailLocation, type Mode, type Query, type Trip } from './model.ts';

export type ProviderState = { mode: Mode; provider: string; status: 'queued' | 'loading' | 'complete' | 'error' | 'expired'; trips: Trip[]; total?: number; errors: ProviderError[]; route?: string; createdAt?: string; expiresAt?: string };
export class HttpError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const timestamp = (value: unknown) => text(value) && /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const stop = (value: unknown) => object(value) && text(value.id) && text(value.name);
const price = (value: unknown) => value === null || object(value) && typeof value.amount === 'number' && Number.isFinite(value.amount) && value.amount >= 0 && typeof value.currency === 'string' && /^[A-Z]{3}$/.test(value.currency);
const errorsValid = (value: unknown): value is ProviderError[] => Array.isArray(value) && value.every(e => object(e) && text(e.provider) && text(e.code) && text(e.message));
function journeyValid(value: unknown, mode: Mode): value is Journey | RailJourney {
  if (!object(value) || !text(value.provider) || !stop(value.origin) || !stop(value.destination) || !timestamp(value.departure) || !timestamp(value.arrival) || typeof value.durationMinutes !== 'number' || !Number.isFinite(value.durationMinutes) || value.durationMinutes < 0 || !price(value.price) || !(typeof value.available === 'boolean' || mode === 'train' && value.available === null)) return false;
  if (value.bookingUrl !== undefined && !text(value.bookingUrl)) return false;
  if (mode === 'bus') return text(value.tripId);
  return text(value.journeyId) && typeof value.changes === 'number' && Number.isInteger(value.changes) && value.changes >= 0 &&
    Array.isArray(value.legs) && value.legs.every(l => object(l) && text(l.trainNumber) && (l.operator === undefined || l.operator === 'italo' || l.operator === 'trenitalia') && stop(l.origin) && stop(l.destination) && timestamp(l.departure) && timestamp(l.arrival) && (l.transportMode === undefined || l.transportMode === 'urban_transfer') && (l.includedInPrice === undefined || typeof l.includedInPrice === 'boolean') && (l.description === undefined || typeof l.description === 'string')) &&
    object(value.timetableSource) && text(value.timetableSource.source) && timestamp(value.timetableSource.publishedAt) &&
    (value.price === null || object(value.price) && text(value.price.source) && timestamp(value.price.observedAt)) &&
    (value.warnings === undefined || Array.isArray(value.warnings) && value.warnings.every(w => typeof w === 'string'));
}
export class Api {
  readonly fetcher: typeof fetch;
  blockedUntil = 0;
  readonly #locations = new Map<string, { expires: number; value: { locations: Location[]; errors: ProviderError[] } }>();
  constructor(fetcher: typeof fetch = (input, init) => fetch(input, init)) { this.fetcher = fetcher; }
  async get(path: string, params: URLSearchParams, signal: AbortSignal): Promise<unknown> {
    if (Date.now() < this.blockedUntil) throw new HttpError('RATE_LIMITED');
    const response = await this.fetcher(`/api${path}?${params}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]), headers: { accept: 'application/json' } });
    if (response.status === 429) {
      const retry = response.headers.get('retry-after');
      const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : retry ? (Date.parse(retry) - Date.now()) / 1000 : 60;
      this.blockedUntil = Date.now() + Math.max(1, Number.isFinite(seconds) ? seconds : 60) * 1000;
      throw new HttpError('RATE_LIMITED');
    }
    const data: unknown = await response.json();
    if (object(data) && object(data.error)) throw new HttpError(text(data.error.code) ? data.error.code : 'PROVIDER_UNAVAILABLE');
    if (!response.ok && response.status !== 503) throw new HttpError('PROVIDER_UNAVAILABLE');
    return data;
  }
  async providers(mode: Mode, signal: AbortSignal): Promise<string[]> {
    const data = await this.get(mode === 'bus' ? '/providers' : '/train-providers', new URLSearchParams(), signal);
    if (!object(data) || !Array.isArray(data.providers) || !data.providers.every(p => object(p) && text(p.id))) throw new HttpError('INCOMPATIBLE_RESPONSE');
    return [...new Set(data.providers.map(p => (p as { id: string }).id))];
  }
  async locations(mode: Mode, query: string, signal: AbortSignal): Promise<{ locations: Location[]; errors: ProviderError[] }> {
    const cacheKey = `${mode}:${query.trim().toLocaleLowerCase('it')}`;
    const cached = this.#locations.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.value;
    const data = await this.get(mode === 'bus' ? '/locations' : '/train-locations', new URLSearchParams({ query }), signal);
    if (!object(data) || !Array.isArray(data.locations) || !data.locations.every(l => stop(l) && object(l) && text(l.provider) && text(l.city) && (l.source === 'live' || l.source === 'historical_snapshot')) || !errorsValid(data.errors)) throw new HttpError('INCOMPATIBLE_RESPONSE');
    const result = data as { locations: Location[]; errors: ProviderError[] };
    if (!signal.aborted && !result.errors.length) {
      this.#locations.set(cacheKey, { expires: Date.now() + 3600000, value: result });
      if (this.#locations.size > 64) this.#locations.delete(this.#locations.keys().next().value!);
    }
    return result;
  }
}
export async function runSearch(api: Api, query: Query, signal: AbortSignal, update: (states: ProviderState[]) => void): Promise<void> {
  const states: ProviderState[] = [];
  const modes: Mode[] = query.mode === 'both' ? ['bus', 'train'] : [query.mode];
  await Promise.all(modes.map(async mode => {
    try {
      const providers = await api.providers(mode, signal);
      if (!providers.length) throw new HttpError('COVERAGE_UNAVAILABLE');
      for (const provider of providers) states.push({ mode, provider, status: 'queued', trips: [], errors: [] });
    } catch (error) {
      if (signal.aborted) return;
      states.push({ mode, provider: mode === 'bus' ? 'Bus' : 'Treni', status: 'error', trips: [], errors: [{ provider: mode, code: error instanceof HttpError ? error.code as ProviderError['code'] : 'PROVIDER_UNAVAILABLE', message: 'Catalogo operatori non disponibile' }] });
    }
  }));
  if (signal.aborted) return;
  const emit = () => { if (!signal.aborted) update([...states]); };
  emit();
  const queue = states.filter(s => s.status === 'queued');
  const railLookups = queue.some(s => s.mode === 'train')
    ? Promise.all([...new Set([query.origin.trim(), query.destination.trim()])].map(async value => ({ value, result: await api.locations('train', value, signal) }))).then(results => ({ results, error: undefined }), error => ({ results: [], error }))
    : undefined;
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
    let state: ProviderState | undefined;
    while ((state = queue.shift())) {
      if (signal.aborted) return;
      state.status = 'loading'; emit();
      let id: string | undefined, offset = 0;
      try {
        let origin = query.origin.trim(), destination = query.destination.trim();
        if (state.mode === 'train') {
          const lookup = await railLookups!;
          if (signal.aborted) return;
          if (lookup.error) throw lookup.error;
          const resolve = (value: string) => {
            const result = lookup.results.find(r => r.value === value)!.result;
            const match = resolveRailLocation(result.locations, state!.provider, value);
            if (!match) throw new HttpError(result.errors.find(e => e.provider === state!.provider)?.code ?? 'UNKNOWN_LOCATION');
            return match;
          };
          const from = resolve(origin), to = resolve(destination);
          origin = from.id; destination = to.id; state.route = `${from.name} → ${to.name}`; emit();
        }
        while (true) {
          const params = id ? new URLSearchParams({ searchId: id, offset: String(offset), limit: '50' }) : new URLSearchParams({
            origin, destination,
            date: query.date, adults: String(query.adults), children: String(query.children), provider: state.provider, snapshot: 'true', limit: '50',
          });
          const data = await api.get(state.mode === 'bus' ? '/journeys' : '/train-journeys', params, signal);
          if (signal.aborted) return;
          if (!object(data) || !Array.isArray(data.journeys) || !data.journeys.every(j => journeyValid(j, state!.mode) && j.provider === state!.provider) || !errorsValid(data.errors) || !text(data.searchId) || !timestamp(data.createdAt) || !timestamp(data.expiresAt) || typeof data.total !== 'number' || !Number.isSafeInteger(data.total) || data.total < 0 || typeof data.truncated !== 'boolean' || data.journeys.length > 50 || (id && data.searchId !== id) || (state.total !== undefined && state.total !== data.total) || offset + data.journeys.length > data.total || data.truncated !== (offset + data.journeys.length < data.total) || (data.truncated && data.journeys.length !== 50)) throw new HttpError('INCOMPATIBLE_RESPONSE');
          id = data.searchId; state.total = data.total; state.createdAt = data.createdAt as string; state.expiresAt = data.expiresAt as string;
          state.errors = data.errors; state.trips.push(...data.journeys.map(j => ({ mode: state!.mode, data: j as Journey | RailJourney })));
          offset += data.journeys.length;
          if (!data.truncated) { state.status = state.errors.some(e => e.code !== 'NO_JOURNEYS') ? 'error' : 'complete'; emit(); break; }
          emit();
        }
      } catch (error) {
        if (signal.aborted) return;
        const code = error instanceof HttpError ? error.code as ProviderError['code'] : 'PROVIDER_UNAVAILABLE';
        state.status = code === 'SEARCH_EXPIRED' ? 'expired' : 'error';
        if (code === 'SEARCH_EXPIRED') state.trips = [];
        state.errors = [...state.errors, { provider: state.provider, code, message: 'Ricerca non completata' }]; emit();
      }
    }
  }));
}
export const errorMessage = (code: string) => ({
  NO_JOURNEYS: 'Nessun viaggio restituito per questa tratta e data.', UNKNOWN_LOCATION: 'Località non riconosciuta: usa un nome esatto dai suggerimenti.', AMBIGUOUS_LOCATION: 'Stazione ambigua: scegli una stazione precisa.',
  RATE_LIMITED: 'Limite di richieste raggiunto. Attendi prima di riprovare.', SEARCH_EXPIRED: 'La cache della ricerca è scaduta o non è più disponibile. Riavvia la ricerca: i vecchi risultati di questo operatore sono stati rimossi.',
  SEARCH_TOO_LARGE: 'Troppi risultati per una ricerca salvata. Scegli fermate o stazioni più precise.', INVALID_INPUT: 'Controlla località, data e passeggeri.', INCOMPATIBLE_RESPONSE: 'La risposta non è leggibile. Riprova più tardi.',
} as Record<string, string>)[code] ?? 'Operatore temporaneamente non disponibile. Gli altri risultati restano consultabili.';
