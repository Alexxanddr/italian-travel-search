import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Api as HttpApi, HttpError, runSearch, type ProviderState } from '../client.ts';
import { bus, page, query, train, railLocations, connection } from './fixtures.ts';
class Api extends HttpApi {
  override async locations(_mode: import('../model.ts').Mode, value: string) { return railLocations(value); }
}
const json = (data: unknown, status = 200) => Response.json(data, { status });
const urlOf = (input: Parameters<typeof fetch>[0]) => new URL(String(input), 'http://local');
test('loads more than 50 from the same snapshot; continuation has only ID offset limit', async () => {
  const requests: URL[] = [], updates: number[] = [], journeys = Array.from({ length: 53 }, (_,i) => train(i));
  const api = new Api(async input => {
    const url = urlOf(input); requests.push(url);
    return json(url.pathname.endsWith('providers') ? { providers: [{ id: 'trenitalia' }] } : page(journeys, Number(url.searchParams.get('offset') ?? 0)));
  });
  let states: ProviderState[] = [];
  await runSearch(api, { ...query, mode: 'train' }, new AbortController().signal, s => { states = s; updates.push(s[0]!.trips.length); });
  assert.equal(states[0]!.trips.length, 53); assert.equal(states[0]!.status, 'complete'); assert(updates.includes(50));
  const first = requests[1]!, continuation = requests[2]!;
  assert.equal(first.searchParams.get('snapshot'), 'true'); assert.equal(first.searchParams.get('adults'), '2');
  assert.deepEqual([...continuation.searchParams.keys()].sort(), ['limit','offset','searchId']); assert.equal(continuation.searchParams.get('offset'), '50');
});
test('bus and rail providers progress independently, without duplicate aggregate queries', async () => {
  let release!: () => void; const barrier = new Promise<void>(r => { release = r; });
  let states: ProviderState[] = []; const observed: string[] = [];
  const api = new Api(async input => {
    const url = urlOf(input);
    if (url.pathname.endsWith('providers')) return json({ providers: [{ id: url.pathname.includes('train') ? 'trenitalia' : 'itabus' }] });
    if (url.pathname.includes('train')) await barrier;
    return json(page([url.pathname.includes('train') ? train() : bus()]));
  });
  const running = runSearch(api, query, new AbortController().signal, s => { states = s; observed.push(s.map(v => `${v.provider}:${v.trips.length}`).join(',')); });
  await new Promise(r => setTimeout(r, 20));
  assert(states.some(s => s.provider === 'itabus' && s.trips.length === 1)); assert(states.some(s => s.provider === 'trenitalia' && s.status === 'loading'));
  release(); await running; assert.equal(states.flatMap(s => s.trips).length, 2); assert(observed.length > 3);
});
test('expiry discards only affected snapshot; successful operators survive', async () => {
  const journeys = Array.from({ length: 51 }, (_,i) => train(i));
  const api = new Api(async input => {
    const url = urlOf(input);
    if (url.pathname.endsWith('providers')) return json({ providers: [{ id: url.pathname.includes('train') ? 'trenitalia' : 'itabus' }] });
    if (url.searchParams.has('searchId')) return json({ error: { code: 'SEARCH_EXPIRED' } }, 410);
    return json(page(url.pathname.includes('train') ? journeys : [bus()]));
  });
  let states: ProviderState[] = [];
  await runSearch(api, query, new AbortController().signal, s => { states = s; });
  assert.equal(states.find(s => s.provider === 'trenitalia')!.status, 'expired'); assert.equal(states.find(s => s.provider === 'trenitalia')!.trips.length, 0);
  assert.equal(states.find(s => s.provider === 'itabus')!.trips.length, 1);
});
test('partial pages retain data and explicitly reject a different snapshot or total', async () => {
  for (const mismatch of ['id','total']) {
    const journeys = Array.from({ length: 51 }, (_,i) => train(i)); let states: ProviderState[] = [];
    const api = new Api(async input => {
      const url = urlOf(input);
      if (url.pathname.endsWith('providers')) return json({ providers: [{ id: 'trenitalia' }] });
      const result = page(journeys, Number(url.searchParams.get('offset') ?? 0));
      if (url.searchParams.has('searchId')) { if (mismatch === 'id') result.searchId += 'bad'; else result.total++; }
      return json(result);
    });
    await runSearch(api, { ...query, mode: 'train' }, new AbortController().signal, s => { states = s; });
    assert.equal(states[0]!.status, 'error'); assert.equal(states[0]!.trips.length, 50); assert.equal(states[0]!.errors[0]!.code, 'INCOMPATIBLE_RESPONSE');
  }
});
test('503 provider errors are readable; successful empty response is distinguished', async () => {
  for (const code of ['QUOTE_UNAVAILABLE', 'NO_JOURNEYS']) {
    let states: ProviderState[] = [];
    const api = new Api(async input => urlOf(input).pathname.endsWith('providers') ? json({ providers: [{ id: 'itabus' }] }) : json({ ...page([]), errors: [{ provider: 'itabus', code, message: 'Synthetic' }] }, code === 'NO_JOURNEYS' ? 200 : 503));
    await runSearch(api, { ...query, mode: 'bus' }, new AbortController().signal, s => { states = s; });
    assert.equal(states[0]!.status, code === 'NO_JOURNEYS' ? 'complete' : 'error');
  }
});
test('rate limit cooldown honors Retry-After and prevents automatic retries', async () => {
  let calls = 0;
  const api = new Api(async () => { calls++; return new Response(null, { status: 429, headers: { 'Retry-After': '75' } }); });
  await assert.rejects(api.get('/providers', new URLSearchParams(), new AbortController().signal), HttpError);
  assert(api.blockedUntil > Date.now() + 74000);
  await assert.rejects(api.get('/providers', new URLSearchParams(), new AbortController().signal), HttpError); assert.equal(calls, 1);
});
test('abort stops pagination and suppresses late responses even when transport ignores cancellation', async () => {
  let release!: () => void; const barrier = new Promise<void>(r => { release = r; }); let emits = 0;
  const controller = new AbortController();
  const api = new Api(async input => {
    if (urlOf(input).pathname.endsWith('providers')) return json({ providers: [{ id: 'itabus' }] });
    await barrier; return json(page([bus()]));
  });
  const running = runSearch(api, { ...query, mode: 'bus' }, controller.signal, () => emits++);
  await new Promise(r => setTimeout(r, 10)); controller.abort(); const before = emits; release(); await running; assert.equal(emits, before);
});
test('malformed fare is rejected at the HTTP boundary rather than shown as zero', async () => {
  let states: ProviderState[] = [];
  const api = new Api(async input => urlOf(input).pathname.endsWith('providers') ? json({ providers: [{ id: 'itabus' }] }) : json(page([{ ...bus(), price: { amount: null, currency: 'EUR' } } as never])));
  await runSearch(api, { ...query, mode: 'bus' }, new AbortController().signal, s => { states = s; });
  assert.equal(states[0]!.trips.length, 0); assert.equal(states[0]!.errors[0]!.code, 'INCOMPATIBLE_RESPONSE');
});
test('accepts both extended and basic numeric timezone offsets returned by bus HTTP API', async () => {
  let states: ProviderState[] = [];
  const api = new Api(async input => urlOf(input).pathname.endsWith('providers') ? json({ providers: [{ id: 'itabus' }] }) : json(page([{ ...bus(), departure: '2027-01-15T22:00:00+0100', arrival: '2027-01-16T05:00:00+0100' }])));
  await runSearch(api, { ...query, mode: 'bus' }, new AbortController().signal, s => { states = s; });
  assert.equal(states[0]!.trips.length, 1); assert.equal(states[0]!.status, 'complete');
});
test('provider fan-out never exceeds three journey requests and each provider is called once', async () => {
  let active = 0, peak = 0;
  const called: string[] = [];
  const api = new Api(async input => {
    const url = urlOf(input);
    if (url.pathname.endsWith('providers')) return json({ providers: url.pathname.includes('train') ? [{ id: 'trenitalia' }, { id: 'italo' }] : ['itabus','salemi','federico','marinobus','flixbus'].map(id => ({ id })) });
    const provider = url.searchParams.get('provider')!;
    called.push(provider); active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    return json(page([provider === 'trenitalia' || provider === 'italo' ? train(0, provider) : bus(0, provider)]));
  });
  await runSearch(api, query, new AbortController().signal, () => {});
  assert.equal(peak, 3); assert.equal(called.length, 7); assert.equal(new Set(called).size, 7);
});

test('unified city search uses provider-specific all-stations IDs and keeps native partner legs', async () => {
  const requests: URL[] = []; let states: ProviderState[] = [];
  const api = new HttpApi(async input => {
    const url = urlOf(input); requests.push(url);
    if (url.pathname.endsWith('locations')) return json(railLocations(url.searchParams.get('query')!));
    if (url.pathname.endsWith('providers')) return json({providers:[{id:url.pathname.includes('train') ? 'italo' : 'itabus'}]});
    return json(page([url.pathname.includes('train') ? connection() : bus()]));
  });
  await api.locations('train', 'Roma', new AbortController().signal);
  await runSearch(api, query, new AbortController().signal, s=>{states=s;});
  assert.equal(requests.find(r=>r.pathname.endsWith('/train-journeys'))!.searchParams.get('origin'), 'italo:Roma');
  assert.equal(requests.find(r=>r.pathname.endsWith('/journeys'))!.searchParams.get('origin'), 'Roma');
  assert.equal(requests.filter(r=>r.pathname.endsWith('locations')).length, 2);
  const result=states.find(s=>s.provider==='italo')!;
  assert.equal(result.status,'complete');
  assert.equal((result.trips[0]!.data as import('../contracts.ts').RailJourney).legs[1]!.operator,'trenitalia');
  assert.match(result.route!,/Roma \(Tutte\) → Cosenza/);
});
