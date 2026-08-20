---
name: koder-ticket
description: Read, add, edit, and move tickets on Koda's personal kanban board (Koder). Use whenever Koda asks to file/track/log a ticket or todo on "the board", "koder", or "my kanban" — or asks to look at, pick up, or work on tickets for a project (e.g. "grab a ticket from holitrackr and work on it").
---

# Work with tickets on the Koder board

Koda's kanban board syncs through a small API. Use the bundled CLI,
`koder-ticket.sh`, which sits in the same folder as this SKILL.md:

```bash
# In a repo checkout (including cloud/mobile sessions):
KT=".claude/skills/koder-ticket/koder-ticket.sh"
# On Koda's PC, from any directory:
KT="$HOME/.claude/skills/koder-ticket/koder-ticket.sh"

bash "$KT" <command>
```

It needs only `bash`, `curl`, and `node` — all present in cloud sandboxes and
on Koda's PC.

## Credentials

The CLI needs `KODER_API` and `KODER_TOKEN` — from the environment, or from a
`.koder.env` file next to the script (exists only on Koda's PC; never
committed). In a cloud or mobile session they must come from the environment
settings: if they're missing, stop and tell Koda to add both variables to the
session's environment configuration — don't guess values or hunt for them.

## Commands

**List tickets** (one per line: `id | column | priority | [project] title`):

```bash
bash "$KT" list --project holitrackr --column todo
```

Both filters optional. Project ids are Koda's repo names (e.g. `holitrackr`,
`SART`, `strava-worker`, `koder`). Columns: `backlog`, `todo`, `doing`,
`review`, `done`.

**Add a ticket:**

```bash
bash "$KT" "Fix flaky auth test" \
  --project holitrackr --column backlog --priority med \
  --note "test_login_retry intermittently fails; suspect clock mock."
```

Defaults: column `backlog`, priority `med`, project unassigned. When working
inside one of Koda's repos, default `--project` to that repo's name.

**Move a ticket:**

```bash
bash "$KT" move t_abc123_x1y2z doing
```

**Edit a ticket** — fix a title, note, priority, project or column after the
fact. Pass any subset of the options; anything you leave out stays as it is:

```bash
bash "$KT" edit t_abc123_x1y2z \
  --title "Fix flaky auth test in CI" --priority high \
  --note "Only fails on the Windows runner; clock mock is the suspect."
```

At least one option is required. An empty value clears the field: `--note ""`
wipes the note, `--project ""` unassigns the ticket. Use this instead of
re-filing a ticket when the wording or metadata is wrong — re-filing loses the
id other work already refers to. `--column` does the same thing as `move`.

## The "pick up work" workflow

When Koda says "look at the tickets on X and work on one":

1. `list --project X --column todo` (fall back to `--column backlog` if empty)
2. Pick the highest-priority ticket you can actually complete; tell Koda which
   and why before starting
3. Move it to `doing`
4. Do the work in the project repo, then commit, push, and open a PR
5. Once the PR is up, move the ticket to `review` — **not** `done`. `done` is
   reserved for after merge; a ticket in `done` should always mean the work
   actually shipped. Koda (or another agent given the review) merges the PR
   and moves the card to `done`.

If you had to stop partway, move the ticket back to `todo` and add a new
ticket noting remaining work.

## Conventions

- Titles short and imperative; context goes in `--note`
- New work → `backlog`; things Koda will do next → `todo`
- One ticket per distinct piece of work; don't bundle

## Fallback: raw API

If the CLI can't run, call the API directly with the same `KODER_API` /
`KODER_TOKEN` values; all requests need `Authorization: Bearer $KODER_TOKEN`.

```bash
curl -sS -H "Authorization: Bearer $KODER_TOKEN" "${KODER_API%/}/tickets?project=holitrackr"
curl -sS -X POST -H "Authorization: Bearer $KODER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"...","project":"...","column":"backlog"}' "${KODER_API%/}/tickets"
curl -sS -X PATCH -H "Authorization: Bearer $KODER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"column":"doing"}' "${KODER_API%/}/tickets/<id>"
curl -sS -X PATCH -H "Authorization: Bearer $KODER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"Better title","priority":"high"}' "${KODER_API%/}/tickets/<id>"
```

Full API docs live in the koder repo: `server/README.md`.

## Maintenance (for agents editing this skill)

This folder is a synced copy. The master lives in the koder repo
(`.claude/skills/koder-ticket/SKILL.md`; the CLI's source of truth is
`scripts/koder-ticket.sh` there). Edit it there, then run
`scripts/sync-skill.sh` to propagate to `~/.claude/skills/` and the other
repos — never edit a copy in place.
