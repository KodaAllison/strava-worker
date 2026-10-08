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

### Refs vs ids

Every ticket has two names:

- The **ref** — `KODER-8CDA` — is printed on the card on Koda's board.
- The **id** — `t_msa7ti8f_08cda` — is the internal key.

**Always quote the ref when you tell Koda about a ticket.** An id means
nothing to someone looking at the board; the ref is right there on the card.
Use the id in notes that cross-reference other tickets, where precision beats
readability. `move`, `edit`, `delete`, and `close` accept either.

**List tickets** (one per line: `ref | id | column | priority | [project] title`):

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

**Move a ticket** (by ref or id):

```bash
bash "$KT" move KODER-8CDA doing
```

**Edit a ticket** — fix a title, note, priority, project or column after the
fact. Pass any subset of the options; anything you leave out stays as it is:

```bash
bash "$KT" edit KODER-8CDA \
  --title "Fix flaky auth test in CI" --priority high \
  --note "Only fails on the Windows runner; clock mock is the suspect."
```

At least one option is required. An empty value clears the field: `--note ""`
wipes the note, `--project ""` unassigns the ticket. Use this instead of
re-filing a ticket when the wording or metadata is wrong — re-filing loses the
id other work already refers to. `--column` does the same thing as `move`.

A ref is a truncation of the id, so it can in principle match two tickets. The
server refuses that with a 409 listing both ids rather than patching one at
random — pass the id when it happens.

**Delete abandoned or superseded work** (by ref or id):

```bash
bash "$KT" delete KODER-8CDA
```

This is a hard delete, not a completion transition. Use it only when the work
is no longer wanted; move shipped work to `done`. `close` is an exact alias for
`delete` and has the same hard-delete semantics. A retained board snapshot can
still restore the ticket for a limited time. Missing tickets return an error,
so a retry cannot silently create another revision.

## The "pick up work" workflow

When Koda says "look at the tickets on X and work on one":

1. `list --project X --column todo` (fall back to `--column backlog` if empty)
2. Pick the highest-priority ticket you can actually complete; tell Koda which
   and why before starting — **by ref**, so it's findable on the board
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

`GET /tickets` returns each ticket's `ref` alongside its fields, and
`PATCH /tickets/:id` takes a ref in place of an id — so the raw API gives you
the same two names the CLI does.

```bash
curl -sS -H "Authorization: Bearer $KODER_TOKEN" "${KODER_API%/}/tickets?project=holitrackr"
curl -sS -X POST -H "Authorization: Bearer $KODER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"...","project":"...","column":"backlog"}' "${KODER_API%/}/tickets"
curl -sS -X PATCH -H "Authorization: Bearer $KODER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"column":"doing"}' "${KODER_API%/}/tickets/KODER-8CDA"
curl -sS -X PATCH -H "Authorization: Bearer $KODER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"Better title","priority":"high"}' "${KODER_API%/}/tickets/<id>"
curl -sS -X DELETE -H "Authorization: Bearer $KODER_TOKEN" \
  "${KODER_API%/}/tickets/KODER-8CDA"
```

Full API docs live in the koder repo: `server/README.md`.

## Maintenance (for agents editing this skill)

This folder is a synced copy. The master lives in the koder repo
(`.claude/skills/koder-ticket/SKILL.md`; the CLI's source of truth is
`scripts/koder-ticket.sh` there). Edit it there, then run
`scripts/sync-skill.sh` to propagate to `~/.claude/skills/` and the other
repos — never edit a copy in place.
