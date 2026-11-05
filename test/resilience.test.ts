import assert from "node:assert/strict";
import test from "node:test";
import { TtlCache } from "../src/cache.ts";
import { responseJson } from "../src/upstream.ts";
import { validateSearchInput } from "../src/validation.ts";
import { AppError } from "../src/domain.ts";

test("bounds caches and expires observations", (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const cache = new TtlCache<number>(60, 2);
  cache.set("a", 1); cache.set("b", 2); cache.set("c", 3);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b"), 2);
  context.mock.timers.tick(61);
  assert.equal(cache.get("b"), undefined);
  cache.set("d", 4);
  assert.equal(cache.get("d"), 4);
});

test("cancels oversized streamed responses without exposing upstream data", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new TextEncoder().encode("private-upstream-body")); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(responseJson(response, "synthetic", 10), (error: unknown) => error instanceof AppError && error.code === "INCOMPATIBLE_RESPONSE" && !error.message.includes("private-upstream-body"));
  assert.equal(cancelled, true);
  assert.deepEqual(await responseJson(Response.json({ ok: true }), "synthetic"), { ok: true });
});

test("uses the Italian calendar date at midnight and validates bounded text", () => {
  const input = { origin: "Roma", destination: "Cosenza", date: "2026-10-28" };
  assert.equal(validateSearchInput(input, new Date("2026-10-27T23:30:00Z")).date, input.date);
  assert.throws(() => validateSearchInput({ ...input, date: "2026-10-27" }, new Date("2026-10-27T23:30:00Z")), /on or after today/);
  assert.equal(validateSearchInput({ ...input, date: "2026-10-29" }, new Date("2026-10-27T23:30:00Z")).date, "2026-10-29");
  assert.throws(() => validateSearchInput({ ...input, date: "2027-01-01", origin: "a".repeat(201) }, new Date("2026-10-27T12:00:00Z")), /200 characters/);
});


test("accepts today across Italian midnight and DST boundaries, but rejects past and invalid dates", () => {
  const input = { origin: "Roma", destination: "Cosenza" };
  for (const [now, today, yesterday] of [
    ["2026-11-05T12:00:00Z", "2026-11-05", "2026-11-04"],
    ["2026-11-04T23:00:00Z", "2026-11-05", "2026-11-04"],
    ["2026-07-04T22:00:00Z", "2026-07-05", "2026-07-04"],
    ["2026-03-29T01:30:00Z", "2026-03-29", "2026-03-28"],
    ["2026-10-25T01:30:00Z", "2026-10-25", "2026-10-24"],
  ]) {
    assert.equal(validateSearchInput({ ...input, date: today }, new Date(now!)).date, today);
    assert.throws(() => validateSearchInput({ ...input, date: yesterday }, new Date(now!)), /on or after today/);
  }
  for (const date of ["2027-02-29", "2026-11-31", "2026-13-01", "2026-11-5"]) {
    assert.throws(() => validateSearchInput({ ...input, date }, new Date("2026-11-05T12:00:00Z")), /real date/);
  }
});
