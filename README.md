# strava-worker

A standalone Cloudflare Worker that syncs Strava data on a schedule and serves it
over HTTP. The portfolio site (separate repo, hosted on Vercel) reads from this
Worker's `/data` endpoint instead of calling Strava directly.

```
  Cron Trigger (Sun 06:00 UTC)            HTTP GET /data
          │                                     │
          ▼                                     ▼
   scheduled() ──fetch Strava──> KV <──read── fetch()
   (PRODUCER)                  (state)        (CONSUMER)
```

**Why this exists:** decouples the slow/rate-limited Strava fetch from page
renders. The portfolio just calls one URL; this Worker owns the Strava secrets
and the sync schedule.

---

## The Worker model in one paragraph

A Worker is an object with handler methods. The runtime calls `fetch()` when an
HTTP request arrives, and `scheduled()` when the Cron Trigger fires. Same code,
two triggers. `env` carries your bindings (`env.STRAVA_KV`) and secrets. That's
the whole model.

---

## Setup (run these in order)

> Steps marked 👤 you run yourself (they need browser auth or print values to
> copy). Everything else is already scaffolded.

### 1. Install deps
```bash
npm install
```

### 2. 👤 Log in to Cloudflare (opens a browser)
```bash
npx wrangler login
```
✅ Checkpoint: `npx wrangler whoami` shows your account.

### 3. 👤 Create the KV namespace
```bash
npx wrangler kv namespace create STRAVA_KV
```
Copy the printed `id` into `wrangler.toml` (replace `REPLACE_WITH_KV_ID`).
🧠 This is the physical store that the cron writes and the fetch reads.

### 4. Run it locally
```bash
npm run dev
```
- Hit `http://localhost:8787/data` → expect a **503** ("no data yet"). Correct!
  The cron hasn't run, so KV is empty.
- Trigger the cron manually. `npm run dev` already passes `--test-scheduled`,
  which exposes the trigger. Either:
    • press the **`s`** key in the terminal running dev, or
    • visit `http://localhost:8787/__scheduled`
  (Without `--test-scheduled` that route doesn't exist — the request falls
  through to `fetch()` and you get the 404. That flag is what registers it.)
- Hit `/data` again → now you get the stub JSON. **You just watched the
  producer→KV→consumer loop work.** That's the checkpoint that matters.

### 5. Add Strava secrets (when wiring the real sync)
```bash
cp .dev.vars.example .dev.vars   # fill in real values for local testing
# for production:
npx wrangler secret put STRAVA_CLIENT_ID
npx wrangler secret put STRAVA_CLIENT_SECRET
npx wrangler secret put STRAVA_REFRESH_TOKEN
```

### 6. Deploy
```bash
npm run deploy
```
Gives you `https://strava-worker.<you>.workers.dev`. Watch live logs with
`npm run tail`.

---

## TODO / next session
- [x] Port the real Strava logic from the portfolio's `src/lib/strava.js` into
      `syncStrava()` in `src/index.js`.
- [x] Deploy. Live at `https://strava-data.strava-data.workers.dev`. Cron is
      `0 6 * * SUN` (Cloudflare's DOW is 1-7 = Sun-Sat; `0` is rejected).
- [x] Set prod secrets (`STRAVA_CLIENT_ID/SECRET/REFRESH_TOKEN`) and seed KV via
      `wrangler dev --remote --test-scheduled`. `/data` serves real data.
- [x] Point the portfolio at `https://strava-data.strava-data.workers.dev/data`
      (`src/lib/strava.js` is now a thin client; no `STRAVA_*` in the portfolio).
- [x] Port the PR/best_efforts logic from `sync-prs.mjs` into the Worker, so
      `/data` also returns `personal_records` + `marathon_pb` (merged over a KV
      baseline). `run.json` keeps only manual config: training_state, next_race,
      and the aspirational `goal` per PR.
- [x] Retire the old `sync-strava-prs.yml` Action + delete `scripts/sync-prs.mjs`.

## Still on you (can't be done from here)
- [ ] Delete `STRAVA_CLIENT_ID/SECRET/REFRESH_TOKEN` from the portfolio's Vercel
      project env vars and from the portfolio repo's GitHub Actions secrets.
- [ ] Commit + push both repos.
