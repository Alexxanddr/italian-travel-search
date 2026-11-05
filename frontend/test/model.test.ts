import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clock, day, filterTrips, money, queryString, readQuery, romeDate, safeBookingUrl, resolveRailLocation, locationName, sortTrips, suggestions, validQuery, type Filters } from '../model.ts';
import { bus, query, train, trip, railLocations } from './fixtures.ts';
const defaults: Filters = { mode: 'all', operators: new Set(), from: '', to: '', maxPrice: '', currency: 'EUR', changes: '', future: false };
test('Rome calendar and DST folds/gaps use explicit instants, independent of host timezone', () => {
  assert.equal(romeDate('2026-11-05T23:30:00Z'), '2026-11-06');
  assert.equal(clock('2027-03-28T01:30:00Z'), '03:30');
  assert.equal(clock('2027-10-31T00:30:00Z'), '02:30');
  assert.equal(clock('2027-10-31T01:30:00Z'), '02:30');
  const a = trip({ ...bus(), departure: '2027-10-31T02:30:00+02:00' });
  const b = trip({ ...bus(1), departure: '2027-10-31T02:30:00+01:00' });
  assert.equal(sortTrips([b,a], 'departure')[0], a);
  assert.equal(romeDate(bus().arrival), '2027-01-16');
  assert.match(day(bus().arrival), /16 gen 2027/);
});
test('today is accepted in Rome, invalid and past dates rejected without shifting input', () => {
  const now = Date.parse('2026-11-05T23:30:00Z');
  assert(validQuery({ ...query, date: '2026-11-06' }, now));
  assert(!validQuery({ ...query, date: '2026-11-05' }, now));
  assert(!validQuery({ ...query, date: '2027-02-30' }, now));
  assert(!validQuery({ ...query, origin: '' }, now));
  assert(validQuery({ ...query, mode: 'bus' }, now));
});
test('share URL round trips modes, exact stops and passengers without hidden route fields', () => {
  assert.deepEqual(readQuery(queryString(query)), query);
  assert(!queryString({ ...query, mode: 'bus' }).includes('trainOrigin'));
  assert.equal(readQuery('?adults=99&children=-1').adults, 1);
});
test('null fares never become zero, HTTPS booking URLs only', () => {
  assert.equal(money(trip({ ...bus(), price: null })), 'Non disponibile');
  assert.equal(money(trip({ ...bus(), price: { amount: 0, currency: 'EUR' } })), '0,00 EUR');
  for (const value of ['javascript:alert(1)', '//evil.test', 'https://user:secret@example.com', 'http://example.com']) assert.equal(safeBookingUrl(value), undefined);
  assert.equal(safeBookingUrl('https://www.italotreno.com/'), 'https://www.italotreno.com/');
});
test('future filter uses instants and toggles without mutating the requested date', () => {
  const a = trip({ ...bus(), departure: '2027-01-15T10:00:00+01:00' });
  const b = trip({ ...bus(1), departure: '2027-01-15T15:00:00+01:00' });
  const now = Date.parse('2027-01-15T12:00:00+01:00');
  assert.deepEqual(filterTrips([a,b], { ...defaults, future: true }, now), [b]);
  assert.equal(filterTrips([a,b], defaults, now).length, 2);
  assert.equal(query.date, '2027-01-15');
});
test('filters preserve unknown bus changes; price compares only known same-currency rail totals', () => {
  const a = trip(bus()), b = trip(train()), c = trip({ ...train(1), price: { ...train(1).price!, currency: 'USD' } });
  assert.deepEqual(filterTrips([a,b,c], { ...defaults, changes: '0' }), [b,c]);
  assert.deepEqual(filterTrips([a,b,c], { ...defaults, maxPrice: '100' }), [b]);
  assert.deepEqual(filterTrips([a,b,c], { ...defaults, operators: new Set(['itabus']) }), [a]);
  assert.deepEqual(filterTrips([a,b], { ...defaults, mode: 'train', from: '13:00', to: '15:00' }), [b]);
  assert.equal(sortTrips([a,c,b], 'price')[0], b);
});
test('recommendations are distinct, available and refuse incomparable currencies or excluded transfers', () => {
  const a = trip(train()), b = trip({ ...train(1), durationMinutes: 200, price: { ...train(1).price!, amount: 90 } });
  const c = trip({ ...train(2), durationMinutes: 220, price: { ...train(2).price!, amount: 60 } });
  const picks = suggestions([a,b,c,trip({ ...bus(), available: false })]);
  assert.equal(picks.length, 3); assert.equal(picks[0]!.trip, a); assert.equal(picks[2]!.trip, c);
  assert(!suggestions([a,trip({ ...train(3), price: { ...train(3).price!, currency: 'USD' } })]).some(p => p.label === 'Economico'));
  assert(!suggestions([trip({ ...train(), legs: [{ ...train().legs[0]!, includedInPrice: false }] })]).some(p => p.label === 'Economico'));
});

test('city resolution uses only exact station or explicit all-stations catalog entries', () => {
  const locations = [...railLocations('Roma').locations, ...railLocations('Cosenza').locations];
  assert.equal(resolveRailLocation(locations, 'italo', 'Roma')?.name, 'Roma (Tutte)');
  assert.equal(resolveRailLocation(locations, 'trenitalia', 'Roma')?.name, 'Roma ( Tutte Le Stazioni )');
  assert.equal(resolveRailLocation(locations, 'italo', 'Cosenza')?.name, 'Cosenza');
  assert.equal(resolveRailLocation(locations, 'italo', 'Paola'), undefined);
  assert.equal(resolveRailLocation([{...locations[0]!,name:'Roma Termini'}], 'trenitalia', 'Roma'), undefined);
  assert.equal(locationName('Rende (Cosenza Nord)'), 'Rende (Cosenza Nord)');
  assert.equal(readQuery('?mode=train&trainOrigin=Roma+Termini&trainDestination=Cosenza').origin, 'Roma Termini');
});
