// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for the monthly_km aggregation.
//
// These run on plain Node (`npm test` → `node --test`), NOT in the Workers
// runtime, and they never touch Strava: the KV binding is a small in-memory
// object and `globalThis.fetch` is stubbed with an activity fixture. That's
// enough, because everything under test is ordinary JS — the only Worker-shaped
// dependencies are `env.STRAVA_KV.get/put` and `fetch`.
// ─────────────────────────────────────────────────────────────────────────────

import test from "node:test";
import assert from "node:assert/strict";

import {
  syncMonthlyKm,
  tallyMonths,
  toMonthlySeries,
  monthSpan,
  isRun,
} from "../src/index.js";

// ── Fixtures / doubles ───────────────────────────────────────────────────────

let nextId = 1;
function activity(startDate, km, extra = {}) {
  return {
    id: nextId++,
    start_date: `${startDate}T08:00:00Z`,
    distance: km * 1000,
    type: "Run",
    sport_type: "Run",
    ...extra,
  };
}

const epoch = (iso) => Math.floor(new Date(iso).getTime() / 1000);

// Stands in for the STRAVA_KV binding: one key, JSON in and out.
function fakeKV(initial) {
  let store = initial === undefined ? null : JSON.stringify(initial);
  return {
    async get(_key, type) {
      if (store === null) return null;
      return type === "json" ? JSON.parse(store) : store;
    },
    async put(_key, value) {
      store = value;
    },
    raw: () => (store === null ? null : JSON.parse(store)),
  };
}

// Stands in for Strava's /athlete/activities: honours per_page/before/after and
// returns newest-first, exactly like the real endpoint.
function stubStrava(activities, { failOnCall } = {}) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    calls.push(Object.fromEntries(u.searchParams));
    if (failOnCall === calls.length) return { ok: false, status: 500 };

    const before = Number(u.searchParams.get("before"));
    const after = u.searchParams.has("after")
      ? Number(u.searchParams.get("after"))
      : -Infinity;
    const perPage = Number(u.searchParams.get("per_page"));

    const page = activities
      .filter((a) => {
        const t = epoch(a.start_date);
        return t < before && t > after;
      })
      .sort((x, y) => epoch(y.start_date) - epoch(x.start_date))
      .slice(0, perPage);

    return { ok: true, json: async () => page };
  };
  return calls;
}

// ── The zero-fill contract — the whole reason this field exists ──────────────

test("every month from the first run to now is present, gaps included", () => {
  const totals = tallyMonths([
    activity("2024-02-11", 10),
    activity("2024-02-25", 15.1),
    // March + April: nothing at all (an injury layoff)
    activity("2024-05-04", 8),
  ]);

  const series = toMonthlySeries(totals, new Date("2024-06-15T00:00:00Z"));

  assert.deepEqual(
    series.map((m) => m.month),
    ["2024-02", "2024-03", "2024-04", "2024-05", "2024-06"]
  );
  assert.deepEqual(series[1], { month: "2024-03", km: 0, runs: 0 });
  assert.deepEqual(series[2], { month: "2024-04", km: 0, runs: 0 });
  // The current month counts even with no runs in it yet.
  assert.deepEqual(series.at(-1), { month: "2024-06", km: 0, runs: 0 });
});

test("months are oldest first and km is rounded to 1dp like weekly_km", () => {
  const totals = tallyMonths([
    activity("2024-02-11", 10.04),
    activity("2024-02-25", 15.09),
  ]);
  const series = toMonthlySeries(totals, new Date("2024-02-28T00:00:00Z"));
  assert.deepEqual(series, [{ month: "2024-02", km: 25.1, runs: 2 }]);
});

test("an empty ledger produces an empty series, not a run of zero months", () => {
  assert.deepEqual(toMonthlySeries({}, new Date("2024-06-15T00:00:00Z")), []);
});

test("monthSpan crosses year boundaries", () => {
  assert.deepEqual(monthSpan("2024-11", "2025-02"), [
    "2024-11",
    "2024-12",
    "2025-01",
    "2025-02",
  ]);
  assert.deepEqual(monthSpan("2025-03", "2025-03"), ["2025-03"]);
  assert.deepEqual(monthSpan("2025-04", "2025-03"), []);
});

// ── What counts as a run ─────────────────────────────────────────────────────

test("only runs are counted — hikes, swims and gym work are not mileage", () => {
  const totals = tallyMonths([
    activity("2024-02-11", 10),
    activity("2024-02-12", 12, { type: "Hike", sport_type: "Hike" }),
    activity("2024-02-13", 2, { type: "Swim", sport_type: "Swim" }),
    activity("2024-02-14", 5, { type: "Workout", sport_type: "Workout" }),
    activity("2024-02-15", 8, { type: "WeightTraining", sport_type: "WeightTraining" }),
  ]);
  assert.deepEqual(toMonthlySeries(totals, new Date("2024-02-28T00:00:00Z")), [
    { month: "2024-02", km: 10, runs: 1 },
  ]);
});

test("trail runs count, matching the predicate the other aggregations use", () => {
  // Strava sends type="Run" / sport_type="TrailRun" for these.
  assert.equal(isRun({ type: "Run", sport_type: "TrailRun" }), true);
  assert.equal(isRun({ type: "Hike", sport_type: "Hike" }), false);
});

// ── Backfill (cold KV) ───────────────────────────────────────────────────────

test("a cold ledger backfills the whole history, paging until Strava runs dry", async () => {
  // 250 activities across 2024 → 3 pages at 100/page.
  const activities = Array.from({ length: 250 }, (_, i) => {
    const day = new Date(Date.UTC(2024, 0, 1 + i));
    return activity(day.toISOString().slice(0, 10), 5);
  });
  const calls = stubStrava(activities);
  const env = { STRAVA_KV: fakeKV() };

  const series = await syncMonthlyKm(env, "tok", new Date("2024-09-15T00:00:00Z"));

  assert.equal(calls.length, 3, "3 pages at 100 per page");
  assert.ok(calls.every((c) => c.after === undefined), "backfill is unbounded");

  const state = env.STRAVA_KV.raw();
  assert.equal(state.backfill_complete, true);
  assert.equal(state.version, 1);
  assert.equal(state.last_activity_at, epoch(activities.at(-1).start_date));

  // Jan–Sep 2024, dense, and the totals add up to 250 runs × 5 km.
  assert.deepEqual(
    series.map((m) => m.month),
    monthSpan("2024-01", "2024-09")
  );
  assert.equal(
    series.reduce((sum, m) => sum + m.runs, 0),
    250
  );
  assert.equal(
    Math.round(series.reduce((sum, m) => sum + m.km, 0)),
    1250
  );
});

test("a backfill that fails part-way leaves KV untouched rather than half-written", async () => {
  const activities = Array.from({ length: 250 }, (_, i) => {
    const day = new Date(Date.UTC(2024, 0, 1 + i));
    return activity(day.toISOString().slice(0, 10), 5);
  });
  stubStrava(activities, { failOnCall: 2 });
  const env = { STRAVA_KV: fakeKV() };

  await assert.rejects(
    () => syncMonthlyKm(env, "tok", new Date("2024-09-15T00:00:00Z")),
    /activities fetch failed: 500/
  );
  assert.equal(env.STRAVA_KV.raw(), null, "no partial ledger was written");
});

// ── Tail (warm KV) ───────────────────────────────────────────────────────────

test("a warm ledger tails with one bounded request and stays idempotent", async () => {
  const activities = [
    activity("2024-01-10", 10),
    activity("2024-01-20", 10),
    activity("2024-03-05", 12), // February is empty on purpose
  ];
  const now = new Date("2024-03-20T00:00:00Z");

  const firstCalls = stubStrava(activities);
  const env = { STRAVA_KV: fakeKV() };
  const first = await syncMonthlyKm(env, "tok", now);
  assert.equal(firstCalls.length, 1, "one short page ends the backfill");

  // Second run: nothing new happened. Same answer, one bounded request.
  const secondCalls = stubStrava(activities);
  const second = await syncMonthlyKm(env, "tok", now);

  assert.equal(secondCalls.length, 1);
  assert.equal(
    Number(secondCalls[0].after),
    epoch("2024-03-01T00:00:00Z"),
    "the tail is anchored at the start of the high-water mark's month"
  );
  assert.deepEqual(second, first, "re-running must not double-count");
  assert.deepEqual(second, [
    { month: "2024-01", km: 20, runs: 2 },
    { month: "2024-02", km: 0, runs: 0 },
    { month: "2024-03", km: 12, runs: 1 },
  ]);
});

test("the tail picks up new runs and re-tallies the month it reopens", async () => {
  const activities = [activity("2024-03-05", 12)];
  const env = { STRAVA_KV: fakeKV() };

  stubStrava(activities);
  await syncMonthlyKm(env, "tok", new Date("2024-03-10T00:00:00Z"));

  // A new run lands later in the SAME month. Because the tail re-fetches from
  // the 1st, the 5th's run must survive rather than be replaced by the new one.
  activities.push(activity("2024-03-25", 8));
  stubStrava(activities);
  const series = await syncMonthlyKm(env, "tok", new Date("2024-03-26T00:00:00Z"));

  assert.deepEqual(series, [{ month: "2024-03", km: 20, runs: 2 }]);
});

test("a ledger from an older schema version is re-backfilled, not trusted", async () => {
  const activities = [activity("2024-03-05", 12)];
  const calls = stubStrava(activities);
  const env = {
    STRAVA_KV: fakeKV({
      version: 0,
      backfill_complete: true,
      last_activity_at: epoch("2024-03-05T08:00:00Z"),
      totals: { "2024-03": { m: 999000, runs: 99 } },
    }),
  };

  const series = await syncMonthlyKm(env, "tok", new Date("2024-03-10T00:00:00Z"));

  assert.equal(calls[0].after, undefined, "unbounded → full backfill");
  assert.deepEqual(series, [{ month: "2024-03", km: 12, runs: 1 }]);
  assert.equal(env.STRAVA_KV.raw().version, 1);
});
