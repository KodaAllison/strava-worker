// ─────────────────────────────────────────────────────────────────────────────
// strava-worker — a single Worker with TWO entry points.
//
// This is THE Cloudflare mental model to internalize: a Worker is just an object
// with handler methods. The runtime decides which one to call based on what
// triggered the invocation:
//
//   • An HTTP request arrives        → the runtime calls  fetch()
//   • The Cron Trigger fires (Sun 6am) → the runtime calls  scheduled()
//
// Same code, same deployment, two doors in. `env` carries your bindings
// (env.STRAVA_KV) and secrets (env.STRAVA_CLIENT_ID, set via `wrangler secret`).
// ─────────────────────────────────────────────────────────────────────────────

const KV_KEY = "latest"; // the single key under which we store the computed blob

// Second KV key: the monthly-volume ledger (running totals + backfill state).
// It is deliberately NOT part of the "latest" blob — "latest" is a rendered
// output that any run may overwrite, whereas this is accumulated state that must
// survive every run. See the "Monthly running volume" section below.
const MONTHLY_KEY = "monthly";

// The cron string (must match wrangler.toml exactly) whose run does the full
// sync including the personal-best walk. Every other trigger refreshes live
// stats only and carries the previous PRs forward unchanged.
const WEEKLY_CRON = "0 6 * * SUN";

export default {
  // ── Entry point #1: HTTP ────────────────────────────────────────────────
  // The data CONSUMER side. Your portfolio (still on Vercel) calls GET /data
  // and gets back whatever the cron last computed. This handler does no Strava
  // work at all — it just serves what's already in KV. Fast, can't be rate
  // limited, needs no Strava secrets.
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/data") {
      const data = await env.STRAVA_KV.get(KV_KEY, "json");
      if (!data) {
        return Response.json(
          { error: "No data yet — the cron hasn't run. Trigger it manually to seed KV." },
          { status: 503 }
        );
      }
      return Response.json(data, {
        headers: {
          // The portfolio lives on a different origin, so the browser needs
          // permission to read this response. (Server-side fetches from the
          // portfolio don't strictly need this, but it makes the endpoint
          // usable from client code too.)
          "Access-Control-Allow-Origin": "*",
          // Let the edge cache the response briefly so bursts of traffic don't
          // all hit the Worker. Data only changes weekly, so this is generous.
          "Cache-Control": "public, max-age=300",
        },
      });
    }

    return new Response("strava-worker is alive. Try GET /data", { status: 404 });
  },

  // ── Entry point #2: Cron ────────────────────────────────────────────────
  // The data PRODUCER side. Fires on the schedule in wrangler.toml. It fetches
  // from Strava, computes the stats, and writes the result to KV. The fetch()
  // handler above then serves that result until the next run.
  //
  // ctx.waitUntil keeps the Worker alive until the async work finishes — without
  // it, the runtime might tear down before the KV write completes.
  async scheduled(event, env, ctx) {
    // Await the work directly: the runtime keeps a cron invocation alive until
    // scheduled() resolves. (ctx.waitUntil is for backgrounding work past a
    // fetch() response — here it would let the handler return before the KV
    // write finished, and the run would be cancelled mid-flight.)
    //
    // Only the weekly trigger walks personal bests (it's subrequest-heavy). Every
    // other (3-hourly) trigger refreshes live stats and carries the previous PRs
    // forward. We reuse the last run's PRs as the merge baseline so older PBs +
    // curated notes survive; on the very first run KV is empty → DEFAULT_PRS.
    const includePRs = event.cron === WEEKLY_CRON;
    const prev = await env.STRAVA_KV.get(KV_KEY, "json");

    // One token for the whole run. It used to be minted inside syncStrava, but
    // the monthly ledger below is a second producer that needs the same token —
    // minting it once here keeps us to a single OAuth refresh per invocation.
    const token = await getAccessToken(env);

    // The monthly series is its own producer with its own KV key, so a bad day
    // on that side can't cost us the live stats: if it throws we log it and
    // carry the previous run's series forward unchanged. (Its own KV write is
    // all-or-nothing, so a failure mid-backfill leaves the ledger untouched
    // rather than half-written — the next cron simply retries.)
    const monthly_km = await syncMonthlyKm(env, token).catch((err) => {
      console.error(`[scheduled] monthly_km failed: ${err.message} — carrying the previous series forward`);
      return prev?.monthly_km ?? [];
    });

    const stats = await syncStrava(env, {
      token,
      baselinePRs: prev?.personal_records ?? DEFAULT_PRS,
      includePRs,
    });
    const data = { ...stats, monthly_km };

    await env.STRAVA_KV.put(KV_KEY, JSON.stringify(data));
    console.log(
      `[scheduled] cron="${event.cron}" prs=${includePRs} months=${monthly_km.length} wrote ${KV_KEY} at ${data.generated_at}`
    );
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// syncStrava — the real sync, ported from the portfolio's src/lib/strava.js.
//
// Two changes vs the original: (1) secrets come from `env`, not `process.env`,
// because Workers have no process global; (2) the `unstable_cache` wrapper is
// GONE — in Next it was the caching layer, but here cron+KV IS the cache, so the
// wrapper has no job. The activity math below is unchanged.
// ─────────────────────────────────────────────────────────────────────────────

const STRAVA_API = "https://www.strava.com/api/v3";

async function getAccessToken(env) {
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
      refresh_token: env.STRAVA_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Strava token refresh failed: ${res.status}`);
  const { access_token } = await res.json();
  return access_token;
}

// The single definition of "does this count as running", shared by every
// aggregation in this file so that weekly_bars and monthly_km can never disagree
// about what a month contained.
//
// Strava reports BOTH fields: `type` is the legacy coarse bucket and
// `sport_type` the modern granular one. A trail run comes back as
// type="Run" / sport_type="TrailRun", so checking either field keeps trail runs
// in the mileage while still excluding the hikes, swims, Hyrox and weight
// training that share the account.
export function isRun(activity) {
  return activity.type === "Run" || activity.sport_type === "Run";
}

function paceString(movingTimeSec, distanceM) {
  const secPerKm = movingTimeSec / (distanceM / 1000);
  const mins = Math.floor(secPerKm / 60);
  const secs = Math.round(secPerKm % 60).toString().padStart(2, "0");
  return `${mins}:${secs}`;
}

function classifyRun(activity) {
  if (activity.workout_type === 2) return "long";
  if (activity.workout_type === 3) return "tempo";
  if (activity.distance >= 15000) return "long";
  const paceSecPerKm = activity.moving_time / (activity.distance / 1000);
  if (paceSecPerKm < 270) return "tempo"; // faster than 4:30/km
  return "easy";
}

// Returns the Monday of the ISO week containing `date`, as a UTC midnight Date.
function isoWeekMonday(date) {
  const d = new Date(date);
  const day = (d.getUTCDay() + 6) % 7; // 0=Mon
  d.setUTCDate(d.getUTCDate() - day);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// ─────────────────────────────────────────────────────────────────────────────
// Personal records (PRs). Ported from the portfolio's old scripts/sync-prs.mjs —
// the GitHub Action we retired. Strava only exposes `best_efforts` on the DETAILED
// activity, and flags pr_rank === 1 on the one holding the current all-time PR. So
// we detail-fetch recent qualifying runs and look for that flag.
//
// We do NOT rediscover all-time PBs every run. Instead we MERGE newly-found PRs
// over a baseline (the previous KV blob, falling back to DEFAULT_PRS). That keeps
// older PBs + their curated notes, and keeps the per-run subrequest count small.
// ─────────────────────────────────────────────────────────────────────────────
const PR_DISTANCE_MAP = { "5k": "5K", "10k": "10K", "half-marathon": "Half", "marathon": "Marathon" };
const PR_ORDER = ["5K", "10K", "Half", "Marathon"];
// Min activity distance (m) that could contain each PR — skip detail fetches for shorter runs.
const PR_MIN_DIST = { "5K": 4800, "10K": 9800, "Half": 20800, "Marathon": 41800 };
const PR_LOOKBACK_DAYS = 90;

// Seed used the first time the Worker runs, before KV holds any PRs. These are the
// curated all-time PBs/notes lifted from the portfolio's old src/data/run.json.
const DEFAULT_PRS = [
  { distance: "5K",       time: "23:28",   date: "2024-10-25", note: "Afternoon Run" },
  { distance: "10K",      time: "51:18",   date: "2025-02-19", note: "Morning Run" },
  { distance: "Half",     time: "1:55:06", date: "2025-11-16", note: "Alton Towers Half" },
  { distance: "Marathon", time: "4:11:11", date: "2025-03-16", note: "Barcelona Marathon" },
];

function secondsToTime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

// Detail-fetch recent qualifying runs and collect Strava-flagged PRs (pr_rank===1).
// `runs` is reused from syncStrava's 112-day list, so this adds only detail calls.
async function findPRs(runs, token) {
  const minTarget = Math.min(...Object.values(PR_MIN_DIST));
  const cutoff = Date.now() - PR_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const candidates = runs.filter(
    (a) => a.distance >= minTarget && new Date(a.start_date).getTime() >= cutoff
  );

  const found = {}; // label → { time, date, note }
  const BATCH = 5;  // small batches keep us friendly to Strava's rate limit
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = await Promise.all(
      candidates.slice(i, i + BATCH).map((a) =>
        fetch(`${STRAVA_API}/activities/${a.id}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null)
      )
    );
    for (const detail of batch) {
      if (!detail?.best_efforts) continue;
      for (const effort of detail.best_efforts) {
        const label = PR_DISTANCE_MAP[effort.name?.toLowerCase()];
        if (!label || effort.pr_rank !== 1 || found[label]) continue;
        found[label] = {
          time: secondsToTime(effort.elapsed_time),
          date: effort.start_date.slice(0, 10),
          note: detail.name ?? "",
        };
      }
    }
  }
  return found;
}

// Merge found PRs over a baseline, preserving older PBs and curated notes.
function mergePRs(baseline, found) {
  return baseline
    .map((existing) => {
      const pr = found[existing.distance];
      if (!pr) return existing;
      if (pr.time === existing.time && pr.date === existing.date) return existing;
      return { distance: existing.distance, time: pr.time, date: pr.date, note: pr.note || existing.note };
    })
    .sort((a, b) => PR_ORDER.indexOf(a.distance) - PR_ORDER.indexOf(b.distance));
}

async function syncStrava(env, { token: sharedToken, baselinePRs = DEFAULT_PRS, includePRs = true } = {}) {
  // scheduled() mints one token for the whole run and passes it in; the fallback
  // keeps this function usable on its own (e.g. from a one-off script).
  const token = sharedToken ?? (await getAccessToken(env));

  // 112 days covers 16 full weeks
  const windowStart = Math.floor((Date.now() - 112 * 24 * 60 * 60 * 1000) / 1000);

  const [athleteRes, activitiesRes] = await Promise.all([
    fetch(`${STRAVA_API}/athlete`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    fetch(`${STRAVA_API}/athlete/activities?per_page=200&after=${windowStart}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  ]);

  if (!athleteRes.ok) throw new Error(`Strava athlete fetch failed: ${athleteRes.status}`);
  if (!activitiesRes.ok) throw new Error(`Strava activities fetch failed: ${activitiesRes.status}`);

  const athlete = await athleteRes.json();
  const allActivities = await activitiesRes.json();

  const statsRes = await fetch(`${STRAVA_API}/athletes/${athlete.id}/stats`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!statsRes.ok) throw new Error(`Strava stats fetch failed: ${statsRes.status}`);
  const stats = await statsRes.json();

  const runs = allActivities.filter(isRun);

  // ── Current week (Mon–Sun) ────────────────────────────────────────────────
  const now = new Date();
  const weekStart = isoWeekMonday(now);
  const weekly_km =
    Math.round(
      runs
        .filter((a) => new Date(a.start_date) >= weekStart)
        .reduce((sum, a) => sum + a.distance / 1000, 0) * 10
    ) / 10;

  // ── YTD + all-time from athlete stats ────────────────────────────────────
  const ytd_km = Math.round((stats.ytd_run_totals?.distance ?? 0) / 1000);
  const ytd_runs = stats.ytd_run_totals?.count ?? 0;
  const all_time = {
    runs: stats.all_run_totals?.count ?? 0,
    km: Math.round((stats.all_run_totals?.distance ?? 0) / 1000),
    elevation_m: Math.round(stats.all_run_totals?.elevation_gain ?? 0),
  };

  // ── Recent activity log — newest first, up to 8 ──────────────────────────
  const recent_activity = [...runs]
    .sort((a, b) => new Date(b.start_date) - new Date(a.start_date))
    .slice(0, 8)
    .map((a) => ({
      date: a.start_date.slice(0, 10),
      distance_km: Math.round((a.distance / 1000) * 10) / 10,
      pace: paceString(a.moving_time, a.distance),
      type: classifyRun(a),
      elev_m: Math.round(a.total_elevation_gain),
      hr: a.has_heartrate ? Math.round(a.average_heartrate) : null,
    }));

  // ── Weekly training load — last 16 weeks, oldest first ───────────────────
  const weekMap = new Map(); // key: monday ISO string → km total
  for (const run of runs) {
    const mon = isoWeekMonday(run.start_date).toISOString().slice(0, 10);
    weekMap.set(mon, (weekMap.get(mon) ?? 0) + run.distance / 1000);
  }

  const thisWeekMon = isoWeekMonday(now);
  const weekly_bars = Array.from({ length: 16 }, (_, i) => {
    const mon = new Date(thisWeekMon);
    mon.setUTCDate(mon.getUTCDate() - (15 - i) * 7);
    const key = mon.toISOString().slice(0, 10);
    const label = mon.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    const km = Math.round((weekMap.get(key) ?? 0) * 10) / 10;
    return { label, km };
  });

  // avg km over the 15 completed weeks (excludes the current in-progress week)
  const completedWeeks = weekly_bars.slice(0, -1);
  const avg_weekly_km =
    Math.round(
      (completedWeeks.reduce((sum, w) => sum + w.km, 0) / completedWeeks.length) * 10
    ) / 10;

  // ── Streak / rest / longest — from the 112-day window ────────────────────
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const dayKm = new Array(112).fill(0);
  for (const run of runs) {
    const runDay = new Date(run.start_date);
    runDay.setUTCHours(0, 0, 0, 0);
    const daysAgo = Math.round((todayStart - runDay) / (24 * 60 * 60 * 1000));
    const idx = 111 - daysAgo;
    if (idx >= 0 && idx < 112) dayKm[idx] += run.distance / 1000;
  }

  let streak = 0;
  let i = 111;
  if (dayKm[i] === 0) i--;
  while (i >= 0 && dayKm[i] > 0) { streak++; i--; }

  const rest_days = dayKm.filter((km) => km === 0).length;
  const longest_km = Math.max(...dayKm).toFixed(1);

  // ── Personal records ─────────────────────────────────────────────────────────
  // The weekly run walks best_efforts and merges any newly-set PRs over the
  // baseline. Frequent (live-stats) runs skip the walk entirely and carry the
  // baseline forward unchanged — keeping them cheap and fast.
  const personal_records = includePRs
    ? mergePRs(baselinePRs, await findPRs(runs, token))
    : baselinePRs;
  const marathon_pb = personal_records.find((p) => p.distance === "Marathon")?.time ?? null;

  return {
    generated_at: new Date().toISOString(),
    weekly_km,
    avg_weekly_km,
    ytd_km,
    ytd_runs,
    all_time,
    recent_activity,
    weekly_bars,
    streak,
    rest_days,
    longest_km,
    personal_records,
    marathon_pb,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Monthly running volume — the full-history series behind the homepage trace.
//
// Everything above works off a rolling 112-day window, which is all the live
// stats need. This series is different in kind: it starts at the first run ever
// and never forgets, so it can't be recomputed from a window on each run.
//
// It is therefore AGGREGATED ON WRITE into its own KV key and only *rendered*
// into the "latest" blob — the page fetches ~2 KB and does no arithmetic. The
// ledger lives under MONTHLY_KEY rather than inside "latest" because "latest" is
// disposable output that any run overwrites, while this is accumulated state
// that has to survive every run.
//
// Two modes, chosen by what's already in KV:
//
//   COLD — no ledger, or one written by an older schema → BACKFILL.
//     /athlete/activities has no history limit, so we page backwards with a
//     `before` cursor until Strava hands back an empty page. The whole account
//     is ~244 activities ≈ 3 requests at 100/page, against a limit of 200 per
//     15 minutes. This runs once, not on every cron.
//
//   WARM — ledger present and complete → TAIL.
//     One request for everything since the start of the month the high-water
//     mark falls in. Those months are then re-tallied from scratch rather than
//     added to, which makes the update IDEMPOTENT: a retry, a distance
//     corrected after the fact, or an activity deleted in Strava all land
//     correctly, and nothing can be double-counted at the `after` boundary
//     (whose inclusivity Strava does not document).
//
// The KV write happens once, at the end, with the complete ledger. A failure
// part-way through the backfill therefore leaves the previous ledger (or no
// ledger at all) untouched — never a permanently half-written series — and the
// next cron simply retries.
// ─────────────────────────────────────────────────────────────────────────────

// Bump when the stored shape changes: an older version reads as COLD and is
// re-backfilled rather than mis-parsed.
const MONTHLY_STATE_VERSION = 1;
const ACTIVITY_PAGE_SIZE = 100; // Strava allows up to 200; 100 keeps responses small
const MAX_ACTIVITY_PAGES = 50;  // safety valve (5,000 activities) so a paging bug can't loop

// Reads the ledger, brings it up to date, writes it back, and returns the dense
// series that goes into the "latest" blob.
async function syncMonthlyKm(env, token, now = new Date()) {
  const state = await env.STRAVA_KV.get(MONTHLY_KEY, "json");
  const warm =
    state?.version === MONTHLY_STATE_VERSION &&
    state.backfill_complete === true &&
    typeof state.last_activity_at === "number" &&
    !!state.totals;

  let totals;
  let activities;

  if (warm) {
    // Anchor the request at the first of the month the high-water mark sits in,
    // so every month the window touches is covered end to end — that is what
    // makes replacing those months (rather than adding to them) safe.
    const anchor = startOfMonthEpoch(state.last_activity_at);
    activities = await fetchActivities(token, { after: anchor });

    // Clear every month the window can touch before re-tallying. The far end is
    // normally the current month; taking the later of that and the newest month
    // actually fetched means a future-dated activity gets its month reset too,
    // rather than being added on top of a total we never cleared.
    const from = monthKey(new Date(anchor * 1000));
    const to = activities.reduce(
      (latest, a) => (a.start_date.slice(0, 7) > latest ? a.start_date.slice(0, 7) : latest),
      monthKey(now)
    );

    totals = { ...state.totals };
    for (const month of monthSpan(from, to)) delete totals[month];
    tallyMonths(activities, totals);
  } else {
    activities = await fetchActivities(token);
    totals = tallyMonths(activities, {});
  }

  // High-water mark = newest activity seen, of ANY type. It only decides where
  // the next tail starts, and a non-run is just as good a floor as a run — while
  // ignoring non-runs here would re-walk months we have already settled.
  const last_activity_at =
    activities.reduce(
      (max, a) => Math.max(max, epochSeconds(a.start_date)),
      warm ? state.last_activity_at : 0
    ) || Math.floor(now.getTime() / 1000);

  await env.STRAVA_KV.put(
    MONTHLY_KEY,
    JSON.stringify({
      version: MONTHLY_STATE_VERSION,
      backfill_complete: true,
      last_activity_at,
      totals,
      updated_at: now.toISOString(),
    })
  );

  const series = toMonthlySeries(totals, now);
  console.log(
    `[monthly] ${warm ? "tail" : "backfill"} fetched=${activities.length} months=${series.length} mark=${last_activity_at}`
  );
  return series;
}

// Page through /athlete/activities newest-first behind a `before` cursor.
// Pass `after` (epoch seconds) to bound how far back we walk; omit it and we
// walk the entire history, which is exactly what the backfill wants.
async function fetchActivities(token, { after } = {}) {
  const all = [];
  const seen = new Set();
  let before = Math.floor(Date.now() / 1000) + 60; // cushion for clock skew

  for (let page = 0; page < MAX_ACTIVITY_PAGES; page++) {
    const params = new URLSearchParams({
      per_page: String(ACTIVITY_PAGE_SIZE),
      before: String(before),
    });
    if (after !== undefined) params.set("after", String(after));

    const res = await fetch(`${STRAVA_API}/athlete/activities?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Strava activities fetch failed: ${res.status}`);

    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) return all; // empty page = end of history

    // Strava does not document whether `before` is inclusive, so dedupe by id: a
    // boundary activity repeating across pages is then harmless, and a page that
    // adds nothing new tells us the cursor has stopped making progress.
    let added = 0;
    for (const activity of batch) {
      if (seen.has(activity.id)) continue;
      seen.add(activity.id);
      all.push(activity);
      added++;
    }
    if (added === 0) return all;
    if (batch.length < ACTIVITY_PAGE_SIZE) return all; // short page = last page

    // The oldest activity in this page becomes the next cursor.
    before = batch.reduce((min, a) => Math.min(min, epochSeconds(a.start_date)), Infinity);
  }

  throw new Error(`Strava activity paging exceeded ${MAX_ACTIVITY_PAGES} pages`);
}

// Sum runs into { "YYYY-MM": { m, runs } }, mutating and returning `into` so the
// warm path can tally straight onto a copy of the stored ledger.
//
// Metres are stored UNROUNDED and only rounded on the way out — rounding each
// activity first would let a month's total drift by a few hundred metres.
function tallyMonths(activities, into = {}) {
  for (const activity of activities) {
    if (!isRun(activity)) continue;
    // start_date is ISO-8601 in UTC, so slicing it is the same UTC bucketing the
    // week and day grids above use — the series cannot disagree with weekly_bars
    // about which month a run landed in.
    const month = activity.start_date.slice(0, 7);
    const bucket = (into[month] ??= { m: 0, runs: 0 });
    bucket.m += activity.distance;
    bucket.runs += 1;
  }
  return into;
}

// Expand the sparse ledger into a DENSE, oldest-first array with no holes: every
// calendar month from the first run to the current month gets a record, and a
// month without runs is an explicit { km: 0, runs: 0 }.
//
// This is the whole point of the field. The consumer plots the array
// positionally, so a missing month would not render as a gap — the x-axis would
// silently close up and a two-month injury layoff would vanish from the curve.
//
// km is rounded to 1dp to match weekly_km / weekly_bars.
function toMonthlySeries(totals, now = new Date()) {
  const months = Object.keys(totals).sort();
  if (months.length === 0) return [];

  // Normally the last month IS the current one; the comparison only matters if a
  // future-dated activity ever sneaks in, which would otherwise truncate it.
  const current = monthKey(now);
  const newest = months[months.length - 1];
  const end = newest > current ? newest : current;

  return monthSpan(months[0], end).map((month) => {
    const bucket = totals[month];
    return {
      month,
      km: bucket ? Math.round((bucket.m / 1000) * 10) / 10 : 0,
      runs: bucket ? bucket.runs : 0,
    };
  });
}

// Every "YYYY-MM" from `first` to `last` inclusive. Plain integer arithmetic
// rather than Date stepping, which trips over month lengths.
function monthSpan(first, last) {
  const months = [];
  let [year, month] = first.split("-").map(Number);
  const [lastYear, lastMonth] = last.split("-").map(Number);

  while (year < lastYear || (year === lastYear && month <= lastMonth)) {
    months.push(`${year}-${String(month).padStart(2, "0")}`);
    if (++month > 12) {
      month = 1;
      year++;
    }
  }
  return months;
}

// "YYYY-MM" for a Date, in UTC.
function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Midnight UTC on the 1st of the month containing `epochSec`, as epoch seconds.
function startOfMonthEpoch(epochSec) {
  const d = new Date(epochSec * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
}

function epochSeconds(isoDate) {
  return Math.floor(new Date(isoDate).getTime() / 1000);
}

// Exported for the unit tests in test/ — the Worker runtime only ever uses the
// default export at the top of the file.
export { syncMonthlyKm, fetchActivities, tallyMonths, toMonthlySeries, monthSpan };
