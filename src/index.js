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
    ctx.waitUntil(
      (async () => {
        const data = await syncStrava(env);
        await env.STRAVA_KV.put(KV_KEY, JSON.stringify(data));
        console.log(`[scheduled] wrote ${KV_KEY} at ${data.generated_at}`);
      })()
    );
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// syncStrava — STUB for now, so the Worker runs end-to-end without secrets.
//
// NEXT STEP (next session): port the real logic from the portfolio's
// src/lib/strava.js — the OAuth token refresh + the activity math. We keep it
// stubbed here so you can prove the wiring (cron → KV → fetch) works in
// isolation before adding the complexity of real API calls + secrets. Debug one
// new thing at a time: that's the lesson.
// ─────────────────────────────────────────────────────────────────────────────
async function syncStrava(env) {
  // TODO: replace with real Strava fetch using:
  //   env.STRAVA_CLIENT_ID, env.STRAVA_CLIENT_SECRET, env.STRAVA_REFRESH_TOKEN
  return {
    _stub: true,
    generated_at: new Date().toISOString(),
    weekly_km: 0,
    note: "stub data — real Strava sync not wired yet",
  };
}
