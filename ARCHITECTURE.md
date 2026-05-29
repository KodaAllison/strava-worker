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

## Data ownership

The boundary that keeps the system clean: the Worker owns *what happened*, the
portfolio's `run.json` owns *what's aimed for*.

| Strava facts — Worker owns (`/data`) | Manual config — `run.json` owns |
|---|---|
| `weekly_km`, `ytd_km`, `all_time` | `training_state` |
| `recent_activity`, `weekly_bars` | `next_race` |
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
- **Two cache layers** — KV (written on the cron cadence) and the portfolio's 1h
  `revalidate` — so traffic hits Vercel's cache, then the Worker, and never Strava.

## Technology

| Layer | Tech | Role |
|---|---|---|
| Scheduler | Cloudflare Cron Triggers | Invoke `scheduled()`; two schedules (see above). |
| Compute | Cloudflare Worker (V8 isolate) | One script, two handlers. No Node/filesystem — state lives in KV. |
| State | Workers KV (`STRAVA_KV`) | Read-optimised edge KV; holds the `"latest"` blob and the PR baseline. |
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
