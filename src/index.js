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
    const data = await syncStrava(env, {
      baselinePRs: prev?.personal_records ?? DEFAULT_PRS,
      includePRs,
    });
    await env.STRAVA_KV.put(KV_KEY, JSON.stringify(data));
    console.log(`[scheduled] cron="${event.cron}" prs=${includePRs} wrote ${KV_KEY} at ${data.generated_at}`);
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

async function syncStrava(env, { baselinePRs = DEFAULT_PRS, includePRs = true } = {}) {
  const token = await getAccessToken(env);

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

  const runs = allActivities.filter(
    (a) => a.type === "Run" || a.sport_type === "Run"
  );

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
