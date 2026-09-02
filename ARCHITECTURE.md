# Architecture

`strava-worker` is a single Cloudflare Worker that owns everything Strava-related
for the portfolio site: the sync schedule, the Strava secrets, and all derived
data. The portfolio (a Next.js app on Vercel, separate repo) is a thin consumer
that reads one URL — `GET /data` — and never talks to Strava itself.

## Why it exists

The portfolio used to call Strava directly at render time (hourly ISR) and ran a
weekly GitHub Action to refresh personal bests. That coupled slow, rate-limited,
secret-bearing Strava calls to page renders. This Worker decouples them: the
expensive fetch runs on a schedule and writes state; page renders only read that
state.

## The system

```
                         ┌──────────────────────────────────────────────────────┐
                         │                   STRAVA API                           │
                         │   oauth/token · /athlete · /activities · /stats        │
                         │   /activities/{id}  (detail → best_efforts, weekly)    │
                         └───────────────▲──────────────────────────────────────-┘
                                         │  called ONLY from here
                                         │  secrets: CLIENT_ID/SECRET/REFRESH_TOKEN
   ┌─────────────────────────────────────┼─────────────────────────────────────────┐
   │  CLOUDFLARE WORKER  "strava-data"   │      (one script, two entry points)       │
   │                                     │                                           │
   │   ┌─────────────────────────┐  PRODUCER                                         │
   │   │  scheduled(event)       │───────┘                                           │
   │   │  • 15 */3 * * *  stats  │   fetch Strava → compute blob → KV.put("latest")  │
   │   │  • 0 6 * * SUN   +PBs   │──────────────────────────┐                        │
   │   └─────────────────────────┘                          ▼                        │
   │                                          ┌──────────────────────────┐           │
   │                                          │  KV namespace STRAVA_KV  │           │
   │                                          │  key "latest" = { stats, │           │
   │                                          │   personal_records, … }   │           │
   │                                          │  key "monthly" = ledger  │           │
   │                                          └──────────────────────────┘           │
   │   ┌─────────────────────────┐  CONSUMER               │                        │
   │   │  fetch()  GET /data     │◀────────────────────────┘                        │
   │   │                         │   KV.get("latest") → JSON (CORS + cache 300s)     │
   │   └────────────▲────────────┘                                                   │
   └────────────────┼────────────────────────────────────────────────────────────-─┘
                    │  GET /data   (no secrets, can't be rate-limited)
                    │  https://strava-data.strava-data.workers.dev/data
   ┌────────────────┼─────────────────────────────────────────────────────────────┐
   │  PORTFOLIO  (Next.js on Vercel)                                                 │
   │   ┌────────────┴────────────┐        ┌─────────────────────────────┐           │
   │   │  src/lib/strava.js      │        │  src/data/run.json          │           │
   │   │  thin client            │        │  MANUAL config:             │           │
   │   │  fetch(/data,           │        │   training_state, next_race,│           │
   │   │   { revalidate: 3600 }) │        │   per-PR `goal`, PR fallback│           │
   │   └────────────┬────────────┘        └──────────────┬──────────────┘           │
   │                │  live stats + personal_records      │  goal (merged by dist.) │
   │                ▼                                      ▼                          │
   │   ┌─────────────────────────────────────────────────────────────┐             │
   │   │  Server Components:  app/page.js   ·   app/run/page.js        │             │
   │   │  ISR (revalidate 1h) → HTML to the browser                    │             │
   │   └─────────────────────────────────────────────────────────────┘             │
   └────────────────────────────────────────────────────────────────────────────────┘
```

## Two data paths

**Write path — scheduled, slow, secret-holding (PRODUCER).**
A cron trigger invokes `scheduled()`, which refreshes the OAuth token, fetches the
athlete/activities/stats, computes one JSON blob, and writes it to KV under
`"latest"`. This is the only code that touches Strava or reads the secrets.

**Read path — per request, fast, public (CONSUMER).**
`GET /data` invokes `fetch()`, which reads `"latest"` from KV and returns it. No
Strava call, no secrets, can't be rate-limited. The portfolio caches this response
for an hour on top.

KV is the **seam**: the producer writes state, the consumer reads it, and neither
blocks the other.

## Two cadences

The two datasets change at very different rates, so they run on different schedules
(both write the same `"latest"` blob). `scheduled()` branches on `event.cron`:

| Cron | What runs | Cost | Why |
|---|---|---|---|
| `15 */3 * * *` (every 3h, :15) | Live stats only; PRs carried forward from the previous blob | ~4 Strava calls | `recent_activity`, `weekly_km`, streaks etc. change several times a week — they need to be fresh. |
| `0 6 * * SUN` (Sun 06:00 UTC) | Full sync **including** the personal-best walk | ~4 + N detail fetches | `best_efforts` only appear on the *detailed* activity, so PRs need a per-activity fetch — subrequest-heavy, and PBs change rarely. |

The `:15` offset on the frequent run keeps it from colliding with the weekly run at
`:00`. The string that flips on PR computation is `WEEKLY_CRON` in `src/index.js`
and **must match `wrangler.toml`**.

## The monthly ledger (`monthly_km`)

Every aggregate above is computed from a rolling 112-day window, which is all the
live stats need. `monthly_km` — the full-history series the homepage hero plots —
is different in kind: it starts at the first run ever and never forgets, so it
can't be recomputed from a window on each run. It gets its own KV key,
`"monthly"`, holding running totals plus the sync's own bookkeeping:

```json
{ "version": 1, "backfill_complete": true, "last_activity_at": 1756540800,
  "totals": { "2024-02": { "m": 25143.2, "runs": 5 } }, "updated_at": "…" }
```

Why a second key rather than a field on `"latest"`: `"latest"` is disposable
*output* that any run overwrites, while this is accumulated *state* that has to
survive every run. Metres are stored unrounded and only rounded (to 1dp, matching
`weekly_km`) when the series is rendered into `"latest"`, so totals can't drift.

Two modes, chosen by what's in KV:

| Mode | When | What it does | Cost |
|---|---|---|---|
| **Backfill** | No ledger, or one from an older `version` | Pages backwards with a `before` cursor until Strava returns an empty page | ~3 requests for the whole account (~244 activities at 100/page) |
| **Tail** | Ledger present and complete | Re-fetches from the 1st of the month `last_activity_at` falls in, then **replaces** those months rather than adding to them | 1 request |

The tail re-tallies instead of accumulating so the update is idempotent: a retry,
a distance corrected after the fact, or an activity deleted in Strava all land
correctly, and nothing can be double-counted at the `after` boundary (whose
inclusivity Strava doesn't document). Anchoring at the start of the month is what
makes that safe — every month the window touches is covered end to end.

The KV write happens once, at the end, with the complete ledger, so a failure
part-way through the backfill leaves the previous ledger untouched rather than a
permanently half-written series. And because the monthly sync is a *separate*
producer, `scheduled()` catches its errors and carries the previous series
forward — a bad day on the monthly side can't cost us the live stats.

The array itself is **dense**: every calendar month from the first run to the
current one is present, and a month with no runs is an explicit
`{ "km": 0, "runs": 0 }`. The consumer plots it positionally, so a missing month
wouldn't render as a gap — the x-axis would silently close up and a two-month
injury layoff would vanish from the curve.

## Data ownership

The boundary that keeps the system clean: the Worker owns *what happened*, the
portfolio's `run.json` owns *what's aimed for*.

| Strava facts — Worker owns (`/data`) | Manual config — `run.json` owns |
|---|---|
| `weekly_km`, `ytd_km`, `all_time` | `training_state` |
| `recent_activity`, `weekly_bars` | `next_race` |
| `monthly_km` (full history, dense) | |
| `streak`, `rest_days`, `longest_km` | `goal` (per PR — the target time) |
| `personal_records` (time/date/note) | `personal_records` (offline fallback only) |
| `marathon_pb` | |

`run/page.js` reads facts from `/data` and **merges the manual `goal` back on by
distance**. `personal_records` is also kept in `run.json` purely as a fallback if
the Worker is unreachable.

## Key design decisions

- **`scheduled()` `await`s the work directly** rather than wrapping it in
  `ctx.waitUntil()` — otherwise the handler returns early and the run is cancelled
  before the KV write completes.
- **PRs merge over a KV baseline** (seeded from the original `run.json` via
  `DEFAULT_PRS`), so older PBs and curated notes persist across runs instead of
  being recomputed from scratch — and it keeps the weekly run's subrequest count
  bounded.
- **`monthly_km` aggregates on write** into its own KV key (see above), so the
  page fetches ~2 KB and does no arithmetic — and a full-history series never has
  to be recomputed from a 112-day window it can't see past.
- **Two cache layers** — KV (written on the cron cadence) and the portfolio's 1h
  `revalidate` — so traffic hits Vercel's cache, then the Worker, and never Strava.

## Technology

| Layer | Tech | Role |
|---|---|---|
| Scheduler | Cloudflare Cron Triggers | Invoke `scheduled()`; two schedules (see above). |
| Compute | Cloudflare Worker (V8 isolate) | One script, two handlers. No Node/filesystem — state lives in KV. |
| State | Workers KV (`STRAVA_KV`) | Read-optimised edge KV; holds the `"latest"` blob (incl. the PR baseline) and the `"monthly"` ledger. |
| Secrets | `wrangler secret` | Encrypted, prod-only, surfaced as `env.*`. (`.dev.vars` is local only.) |
| Source | Strava REST + OAuth refresh-token flow | `best_efforts`/`pr_rank` only on the detailed activity. |
| Tooling | Wrangler | Deploy, secrets/KV, and `wrangler dev --remote --test-scheduled` to fire crons on demand. |
| Consumer | Next.js (App Router) on Vercel | Server Components render the pages; native `fetch` `revalidate` caching. |

## Local development

```bash
npm run dev            # local fetch() + scheduled() against a simulated KV
# fire a specific schedule against the LIVE KV + secrets:
npx wrangler dev --remote --test-scheduled
#   then GET /__scheduled?cron=15+*/3+*+*+*   → stats-only path
#        GET /__scheduled?cron=0+6+*+*+SUN     → full path incl. PR walk
```
