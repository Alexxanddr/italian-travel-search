import type { Location } from './contracts.ts';
import { Api, HttpError, errorMessage, runSearch, type ProviderState } from './client.ts';
import { clock, day, duration, filterTrips, locationName, key, money, names, observation, queryString, rail, readQuery, romeDate, safeBookingUrl, sortTrips, suggestions, validQuery, type Filters, type Mode, type Query, type Trip } from './model.ts';

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const escape = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const api = new Api();
const form = $<HTMLFormElement>('#search-form'), filtersForm = $<HTMLFormElement>('#filters');
let active: Query | undefined, states: ProviderState[] = [], controller: AbortController | undefined, generation = 0, running = false;
let lookupController = new AbortController();
const lookupCache = new Map<string, Promise<{ locations: Location[]; errors: import('./contracts.ts').ProviderError[] }>>();
const lookups: Array<{ close: () => void; cancel: () => void }> = [];
const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
function applyMode() {
  const trainOnly = new FormData(form).get('mode') === 'train';
  field('origin').placeholder = trainOnly ? 'Città o stazione' : 'Città di partenza';
  field('destination').placeholder = trainOnly ? 'Città o stazione' : 'Città di arrivo';
}
function fillForm(query: Query) {
  for (const [name, value] of Object.entries(query)) {
    if (name === 'mode') $<HTMLInputElement>(`input[name="mode"][value="${query.mode}"]`).checked = true;
    else field(name).value = String(value);
  }
  applyMode();
}
function fromForm(): Query {
  const data = new FormData(form);
  return { mode: data.get('mode') as Query['mode'], date: field('date').value, adults: Number(field('adults').value), children: Number(field('children').value), origin: field('origin').value, destination: field('destination').value };
}
function setupAutocomplete(input: HTMLInputElement) {
  const options = $<HTMLDivElement>(`#${input.id}-options`), status = $<HTMLElement>(`#${input.id}-status`);
  input.setAttribute('aria-describedby', status.id);
  let timer: ReturnType<typeof setTimeout> | undefined, version = 0, selected = -1, items: string[] = [];
  const close = () => { options.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); selected = -1; };
  const cancel = () => { version++; clearTimeout(timer); close(); status.textContent = ''; };
  lookups.push({ close, cancel });
  const choose = (index: number) => { if (items[index]) { input.value = items[index]!; cancel(); input.focus(); } };
  input.addEventListener('input', () => {
    cancel(); const current = version, query = input.value.trim();
    if (query.length < 2) return;
    status.textContent = 'Ricerca località…';
    timer = setTimeout(async () => {
      const mode = new FormData(form).get('mode') as Query['mode'];
      const cacheKey = `${mode}:${query.toLocaleLowerCase('it')}`;
      try {
        let promise = lookupCache.get(cacheKey);
        if (!promise) {
          const modes: Mode[] = mode === 'both' ? ['bus', 'train'] : [mode];
          promise = Promise.allSettled(modes.map(m => api.locations(m, query, lookupController.signal))).then(results => {
            const successes = results.flatMap(r => r.status === 'fulfilled' ? [r.value] : []);
            if (!successes.length) throw (results[0] as PromiseRejectedResult).reason;
            return { locations: successes.flatMap(r => r.locations), errors: results.flatMap((r, index) => r.status === 'fulfilled' ? r.value.errors : [{ provider: modes[index]!, code: 'PROVIDER_UNAVAILABLE' as const, message: 'Autocomplete unavailable' }]) };
          });
          lookupCache.set(cacheKey, promise);
          if (lookupCache.size > 64) lookupCache.delete(lookupCache.keys().next().value!);
          void promise.then(result => { if (result.errors.length) lookupCache.delete(cacheKey); }, () => lookupCache.delete(cacheKey));
        }
        const result = await promise;
        if (version !== current || input.disabled) return;
        const groups = new Map<string, Set<string>>();
        for (const location of result.locations) {
          const label = mode === 'both' ? locationName(location.name) : location.name;
          if (!groups.has(label)) groups.set(label, new Set());
          groups.get(label)!.add(names[location.provider] ?? location.provider);
        }
        items = [...groups.keys()].sort((a,b) => Number(b.toLocaleLowerCase('it') === query.toLocaleLowerCase('it')) - Number(a.toLocaleLowerCase('it') === query.toLocaleLowerCase('it'))).slice(0, 16);
        options.innerHTML = items.map((name, index) => `<div role="option" id="${input.id}-option-${index}" aria-selected="false" data-index="${index}"><strong>${escape(name)}</strong><small>${escape([...groups.get(name)!].join(', '))}</small></div>`).join('');
        options.hidden = !items.length; input.setAttribute('aria-expanded', String(!!items.length));
        status.textContent = `${items.length ? `${items.length} suggerimenti. Usa le frecce e Invio.` : 'Nessuna località trovata: prova un nome più preciso.'}${result.errors.length ? ' Alcuni operatori non hanno risposto.' : ''}`;
      } catch (error) {
        if (version !== current) return;
        status.textContent = errorMessage(error instanceof HttpError ? error.code : 'PROVIDER_UNAVAILABLE'); close();
      }
    }, 450);
  });
  options.addEventListener('pointerdown', event => { event.preventDefault(); const option = (event.target as Element).closest<HTMLElement>('[data-index]'); if (option) choose(Number(option.dataset.index)); });
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') { cancel(); return; }
    if (options.hidden) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      for (const [index, option] of [...options.children].entries()) option.setAttribute('aria-selected', String(index === selected));
      input.setAttribute('aria-activedescendant', `${input.id}-option-${selected}`); options.children[selected]?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter' && selected >= 0) { event.preventDefault(); choose(selected); }
    else if (event.key === 'Tab') close();
  });
  input.addEventListener('blur', close);
}
for (const name of ['origin', 'destination']) setupAutocomplete(field(name));
for (const radio of form.querySelectorAll('[name="mode"]')) radio.addEventListener('change', () => { lookups.forEach(l => l.cancel()); applyMode(); });
for (const button of form.querySelectorAll<HTMLButtonElement>('[data-swap]')) button.addEventListener('click', () => {
  const a = field('origin'), b = field('destination');
  [a.value, b.value] = [b.value, a.value]; lookups.forEach(l => l.cancel());
});
function readFilters(): Filters {
  const data = new FormData(filtersForm);
  return { mode: data.get('mode') as Filters['mode'], operators: new Set(data.getAll('operator').map(String)), from: String(data.get('from')), to: String(data.get('to')), maxPrice: String(data.get('maxPrice')), currency: String(data.get('currency')), changes: String(data.get('changes')), future: data.has('future') };
}
const trips = () => states.flatMap(s => s.trips);
const coverageComplete = () => !running && states.length > 0 && states.every(s => s.status === 'complete');
function arrival(trip: Trip) {
  return `${clock(trip.data.arrival)}${romeDate(trip.data.arrival) !== romeDate(trip.data.departure) ? ` <small class="arrival-date">${day(trip.data.arrival)}</small>` : ''}`;
}
function renderTrip(trip: Trip): string {
  const data = trip.data, train = rail(trip), booking = safeBookingUrl(data.bookingUrl);
  const carriers = [...new Set(train?.legs.flatMap(l => l.operator ? [names[l.operator]] : []) ?? [])];
  const operatorLabel = carriers.length > 1 ? `${carriers.join(' + ')} · prenotazione ${names[data.provider] ?? data.provider}` : names[data.provider] ?? data.provider;
  const warning = [...(train?.warnings ?? [])];
  if (train?.legs.some(l => l.includedInPrice === false)) warning.push('Trasferimento escluso dal prezzo. Costo aggiuntivo non stimato.');
  const provenance = train ? `${train.price?.source ?? train.timetableSource.source} · osservato il ${observation(train.price?.observedAt ?? train.timetableSource.publishedAt)}` : `${names[data.provider] ?? data.provider} · data di osservazione non fornita dal servizio`;
  const stopLabel = (stop: Trip['data']['origin']) => `${escape(stop.name)}${'address' in stop && stop.address ? `<small>${escape(stop.address)}</small>` : ''}`;
  return `<article class="trip" id="trip-${escape(key(trip))}">
    <div class="trip-heading"><span class="operator">${escape(operatorLabel)}</span><span class="transport ${trip.mode}">${trip.mode === 'bus' ? 'Bus' : 'Treno'}</span><span class="availability ${data.available === false ? 'unavailable' : ''}">${data.available === true ? 'Disponibilità segnalata' : data.available === false ? 'Non disponibile' : 'Disponibilità non confermata'}</span></div>
    <div class="trip-main"><div class="endpoint"><time datetime="${escape(data.departure)}">${clock(data.departure)}</time><span>${stopLabel(data.origin)}</span></div><div class="journey-line"><strong>${duration(data.durationMinutes)}</strong><span aria-hidden="true"></span><small>${train ? train.changes === 0 ? 'Nessun cambio' : `${train.changes} ${train.changes === 1 ? 'cambio' : 'cambi'}` : 'Cambi non dichiarati'}</small></div><div class="endpoint"><time datetime="${escape(data.arrival)}">${arrival(trip)}</time><span>${stopLabel(data.destination)}</span></div><div class="fare"><strong>${escape(money(trip))}</strong><small>${train ? `Totale · adulti ${active!.adults}, bambini ${active!.children}` : 'Base passeggeri non dichiarata'}</small>${booking ? `<a class="booking" href="${escape(booking)}" target="_blank" rel="noopener noreferrer">${data.available === false ? 'Verifica sul sito' : 'Vai al sito ufficiale'} <span aria-hidden="true">↗</span><span class="sr-only"> di ${escape(names[data.provider] ?? data.provider)}, nuova scheda</span></a>` : '<span class="muted">Link non disponibile</span>'}</div></div>
    ${warning.length ? `<div class="warnings" role="note">${[...new Set(warning)].map(w => `<p>${escape(w)}</p>`).join('')}</div>` : ''}
    <details data-trip="${escape(key(trip))}"><summary>Dettagli del viaggio e del prezzo</summary><div class="trip-details">${train ? `<ol class="legs">${train.legs.map((leg, index) => {
      const previous = train.legs[index - 1];
      const wait = previous ? Math.round((Date.parse(leg.departure) - Date.parse(previous.arrival)) / 60000) : 0;
      return `${previous ? `<li class="connection">Cambio: ${wait} min · ${escape(previous.destination.name)}${previous.destination.name !== leg.origin.name ? ` / ${escape(leg.origin.name)}` : ''}</li>` : ''}<li><strong>${leg.transportMode === 'urban_transfer' || leg.trainNumber === 'UB' ? 'Trasferimento urbano' : `${leg.operator ? escape(names[leg.operator]) + ' · ' : ''}Treno ${escape(leg.trainNumber)}`}</strong><p>${escape(leg.origin.name)} (${clock(leg.departure)}, ${day(leg.departure)}) → ${escape(leg.destination.name)} (${clock(leg.arrival)}, ${day(leg.arrival)})</p>${leg.description ? `<p>${escape(leg.description)}</p>` : ''}${leg.includedInPrice === false ? '<p class="excluded">Escluso dal prezzo</p>' : leg.transportMode === 'urban_transfer' && leg.includedInPrice === undefined ? '<p>Inclusione nel prezzo non dichiarata</p>' : ''}</li>`;
    }).join('')}</ol>` : '<p>Il servizio non fornisce il dettaglio delle tratte bus né il numero di cambi.</p>'}<p>${escape(provenance)}</p>${train?.price?.fareName ? `<p>Tariffa comunicata: ${escape(train.price.fareName)}${train.price.travelClass ? ` · ${escape(train.price.travelClass)}` : ''}</p>` : ''}${'fare' in data && data.fare ? `<p>Tariffa comunicata: ${escape(data.fare)}</p>` : ''}<p>Partenza: ${day(data.departure)}. Tutti gli orari sono in Europe/Rome.</p><p>Prezzo e disponibilità possono cambiare. Conferma passeggeri, importi e condizioni sul sito ufficiale.</p></div></details></article>`;
}
function renderComparison() {
  const all = trips(), filtered = filterTrips(all, readFilters()), complete = coverageComplete();
  $('#comparison').hidden = false;
  $('#result-count').textContent = `${filtered.length} ${filtered.length === 1 ? 'soluzione visibile' : 'soluzioni visibili'}`;
  $('#sort-note').textContent = `${complete ? 'Ordinamento su tutti i risultati restituiti.' : 'Confronto parziale: filtri e ordinamento valgono solo sui risultati caricati.'}${$<HTMLSelectElement>('#sort').value === 'price' ? ' Totali treno ordinati per valuta e importo. Bus e prezzi mancanti seguono senza classifica di prezzo.' : ''}`;
  const open = new Set([...document.querySelectorAll<HTMLDetailsElement>('details[data-trip][open]')].map(e => e.dataset.trip));
  const list = $('#trip-list');
  const focused = document.activeElement instanceof HTMLElement && list.contains(document.activeElement) ? document.activeElement : undefined;
  const focusedTrip = focused?.closest('article')?.id;
  const focusedControl = focused?.tagName === 'SUMMARY' ? 'summary' : focused?.closest('a') ? 'a.booking' : undefined;
  list.innerHTML = filtered.length ? sortTrips(filtered, $<HTMLSelectElement>('#sort').value).map(renderTrip).join('') : `<div class="empty"><h3>${all.length ? 'Nessuna soluzione con questi filtri' : running ? 'Stiamo cercando le tue partenze…' : complete ? 'Nessuna disponibilità restituita' : 'La ricerca non è completa'}</h3><p>${all.length ? 'Prova ad ampliare gli orari o ad azzerare i filtri.' : running ? 'Le soluzioni appariranno appena disponibili.' : complete ? 'Prova un’altra data o una tratta diversa.' : 'Gli errori non dimostrano che non esistano viaggi. Controlla gli avvisi e riprova.'}</p></div>`;
  for (const details of list.querySelectorAll<HTMLDetailsElement>('details[data-trip]')) details.open = open.has(details.dataset.trip);
  if (focusedTrip && focusedControl) document.getElementById(focusedTrip)?.querySelector<HTMLElement>(focusedControl)?.focus({ preventScroll: true });
  const picks = suggestions(filtered);
  $('#suggestions').innerHTML = picks.length ? `<div class="suggestion-heading"><h2>Scegli il tuo viaggio</h2><span>${complete ? 'Tra i risultati visibili' : 'Indicazioni provvisorie · confronto incompleto'}</span></div><div class="suggestion-list">${picks.map(p => `<a class="suggestion" href="#trip-${escape(key(p.trip))}"><span>${p.label}</span><strong>${p.label === 'Veloce' ? duration(p.trip.data.durationMinutes) : escape(money(p.trip))}</strong><small>${escape(names[p.trip.data.provider] ?? p.trip.data.provider)} · ${clock(p.trip.data.departure)}</small><p>${p.reason}</p></a>`).join('')}</div><p class="muted">Fino a tre suggerimenti distinti, solo tra soluzioni con disponibilità segnalata. Prezzi confrontati soltanto per totali treno nella stessa valuta, senza trasferimenti esclusi.</p>` : '';
}
function render() {
  if (!active) return;
  const all = trips(), total = states.reduce((n,s) => n + (s.total ?? 0), 0), knownTotals = states.filter(s => s.total !== undefined).length;
  const status = running ? 'Ricerca in corso' : coverageComplete() ? 'Ricerca completata' : 'Ricerca incompleta';
  $('#search-status').textContent = `${status}. ${all.length} risultati caricati su ${total}${knownTotals < states.length ? ' noti; altri totali non ancora disponibili' : ''}.`;
  const container = $('#operator-filters');
  for (const state of states) if (![...container.querySelectorAll<HTMLInputElement>('input')].some(i => i.value === state.provider)) {
    const label = document.createElement('label'); label.className = 'check'; const input = document.createElement('input'); input.type = 'checkbox'; input.name = 'operator'; input.value = state.provider;
    label.append(input, document.createTextNode(names[state.provider] ?? state.provider)); container.append(label);
  }
  const currencies = [...new Set(all.flatMap(t => t.data.price?.currency ?? []))].sort();
  const currency = $<HTMLSelectElement>('[name="currency"]');
  for (const code of currencies) if (![...currency.options].some(o => o.value === code)) currency.add(new Option(code, code));
  $('#coverage').innerHTML = `<details class="coverage" ${states.some(s => s.status === 'error' || s.status === 'expired') ? 'open' : ''}><summary>Copertura della ricerca · ${states.filter(s => s.status === 'complete').length}/${states.length} operatori completati</summary><ul>${states.map(s => `<li><strong>${escape(names[s.provider] ?? s.provider)}</strong>${s.route ? `<p class="resolved-route">${escape(s.route)}</p>` : ''}<span>${s.status === 'queued' ? 'In attesa' : s.status === 'loading' ? 'Caricamento' : s.status === 'expired' ? 'Snapshot scaduto' : s.status === 'error' ? 'Confronto incompleto' : 'Completato'} · ${s.trips.length} / ${s.total ?? '?'} risultati</span>${s.errors.map(e => `<p class="${e.code === 'NO_JOURNEYS' ? '' : 'error'}">${escape(errorMessage(e.code))} <small>(${escape(e.code)})</small></p>`).join('')}${s.createdAt ? `<small>Snapshot creato ${observation(s.createdAt)}; cache fino a ${clock(s.expiresAt!)}. La scadenza non indica la validità commerciale dei prezzi.</small>` : ''}</li>`).join('')}</ul></details>`;
  renderComparison();
}
function updateRateLimit() {
  const remaining = Math.max(0, Math.ceil((api.blockedUntil - Date.now()) / 1000));
  const retry = document.querySelector<HTMLButtonElement>('#restart');
  if (retry) { retry.disabled = !!remaining; retry.textContent = remaining ? `Riprova tra ${remaining} s` : 'Aggiorna ricerca'; }
  const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
  submit.disabled = !!remaining;
  if (remaining) $('#form-error').textContent = `Limite di richieste raggiunto. Riprova tra ${remaining} secondi.`;
  else if ($('#form-error').textContent?.startsWith('Limite di richieste')) $('#form-error').textContent = '';
}
async function search(query: Query, push: boolean) {
  $('#form-error').textContent = '';
  if (!validQuery(query) || !Number.isInteger(query.adults) || query.adults < 1 || query.adults > 9 || !Number.isInteger(query.children) || query.children < 0 || query.children > 9) { $('#form-error').textContent = 'Inserisci località precise, una data valida da oggi in poi e da 1 a 9 adulti, da 0 a 9 bambini.'; return; }
  if (Date.now() < api.blockedUntil) { updateRateLimit(); return; }
  if (running && active && queryString(query) === queryString(active)) return;
  controller?.abort(); const current = ++generation; controller = new AbortController();
  lookups.forEach(l => l.cancel()); lookupController.abort(); lookupController = new AbortController(); lookupCache.clear();
  active = { ...query }; states = []; running = true;
  if (push) history.pushState(null, '', `?${queryString(query)}`);
  $('#initial-state').hidden = true;
  $('#operator-filters').innerHTML = '<legend>Operatori</legend>';
  filtersForm.reset(); (filtersForm.elements.namedItem('future') as HTMLInputElement).checked = query.date === romeDate();
  const route = `${query.origin} → ${query.destination}`;
  const summary = $('#search-summary'); summary.hidden = false;
  summary.innerHTML = `<div><strong>${escape(route)}</strong><span>${day(query.date)} · adulti ${query.adults}, bambini ${query.children} · sola andata</span></div><button type="button" id="restart" class="text-button">Aggiorna ricerca</button>`;
  render(); $('#results').focus({ preventScroll: true });
  await runSearch(api, query, controller.signal, next => { if (generation === current) { states = next; render(); updateRateLimit(); } });
  if (generation === current) { running = false; render(); updateRateLimit(); }
}
form.addEventListener('submit', event => { event.preventDefault(); void search(fromForm(), true); });
$('#search-summary').addEventListener('click', event => { if ((event.target as Element).closest('#restart') && active) void search(active, false); });
filtersForm.addEventListener('input', renderComparison);
filtersForm.addEventListener('reset', () => setTimeout(() => { (filtersForm.elements.namedItem('future') as HTMLInputElement).checked = active?.date === romeDate(); if (active) renderComparison(); }, 0));
$('#sort').addEventListener('change', renderComparison);
window.addEventListener('popstate', () => { const query = readQuery(location.search); fillForm(query); if (validQuery(query)) void search(query, false); else { controller?.abort(); generation++; active = undefined; running = false; states = []; $('#comparison').hidden = true; $('#search-summary').hidden = true; $('#initial-state').hidden = false; for (const id of ['search-status','coverage','suggestions']) $(`#${id}`).innerHTML = ''; } });
fillForm(readQuery(location.search)); field('date').min = romeDate();
$<HTMLDetailsElement>('#filter-panel').open = !matchMedia('(max-width: 700px)').matches;
if (location.search) void search(fromForm(), false);
setInterval(updateRateLimit, 1000);
setInterval(() => { field('date').min = romeDate(); if (active && readFilters().future) renderComparison(); }, 60000);
