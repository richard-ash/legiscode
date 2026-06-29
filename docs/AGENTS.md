# Autonomous agent loop

A local version of the Wood/Last working style: you plan and review; agents do
the typing. High-level tasks become small PRs you merge in ~500-LOC pieces.
Everything runs on your machine via gstack `/loop` — no VM, no Linear, no cloud
CI. GitHub Issues are the task queue **and** the memory.

## Roles

- **You** — write epic issues, approve decompositions, review the small PRs
  (comment for changes, or `lgtm` to approve), ship finished feature branches
  to `main`.
- **`/decompose`** (planner) — turns one epic into ~500-LOC vertical sub-issues
  and creates the feature branch.
- **`/agent-tick`** (implementer) — one unit of work per tick. It **watches its
  own PRs**: first it advances an in-flight PR (addresses your review comments,
  or **merges it once you comment `lgtm`** + CI is green), and only if none need
  it does it pick the next ready issue and implement it. Driven by `/loop`.

**Two ways to run ticks:**

- **`make agent-tick` (headless, recommended).** Runs `claude -p` with
  `--permission-mode auto`, so the auto-mode classifier approves the tick's
  routine `gh`/`git`/`pnpm` commands without a prompt (a headless process can't
  answer one) while still blocking dangerous actions. This is the path that
  gets the **model split**: the implementer runs on **Sonnet** (a pre-scoped
  ~500-LOC sub-issue is its sweet spot; `make agent-tick MODEL=opus` to bump a
  hard one). A full tick takes several minutes — don't wrap it in a short
  `timeout`. For continuous operation, loop it: `while make agent-tick; do :; done`.
- **`/loop 15m /agent-tick` (in-session).** Runs in your Claude session on the
  session model (not Sonnet); you approve actions as they come. Use this when
  you want to watch ticks closely.

`make decompose` plans on your default (stronger) model regardless.

## One-time setup

```bash
scripts/agent-setup.sh        # create the GitHub labels (idempotent)
```
The headless `make agent-tick` path needs no permission setup for the implement
→ ship → review cycle — `auto` mode classifies each command. The **one
exception is merging**: `auto` blocks `gh pr merge` (irreversible, shared repo),
so a merge-on-`lgtm` tick will stop and surface the merge commands for you to
run. For hands-off merging, allow-list `Bash(gh pr merge *)` — your `lgtm` is
already the human gate.

The **in-session `/loop`** path benefits from an allow-list so it stops
re-prompting; add these once if you use it (Claude Code → `/permissions`, or
`.claude/settings.local.json`):

```
Bash(gh issue *)   Bash(gh label *)   Bash(git worktree *)
Bash(git push *)   Bash(git branch *)   Bash(gh pr merge *)
Bash(scripts/agent-setup.sh)
Skill(decompose)   Skill(agent-tick)   Skill(code-review)   Skill(loop)
```

## The loop

1. **Write an epic.** `make epic` (or `make epic title="…"`) — opens an issue
   labeled `epic` for the high-level goal.
2. **Decompose.** `make decompose issue=<epic#>` (or `/decompose <epic#>` inside
   a Claude session) → review the proposed slices → lgtm. It creates
   `agent/epic-<N>` and the `agent-ready` sub-issues.
3. **Run a tick:** `make agent-tick` (headless, Sonnet) — repeat or wrap in
   `while make agent-tick; do :; done` for continuous; or `/loop 15m /agent-tick`
   in a Claude session. Each tick produces a PR labeled
   `agent-needs-human-review`. (See the two-ways note above.)
4. **Review each small PR** as it appears (this is the part you stay in control
   of). Either:
   - **comment changes** — a later tick addresses them in the same PR, re-runs
     the green-gate, force-pushes, and replies; or
   - **comment `lgtm`** — a later tick merges it into the feature branch (CI
     green required), deletes the branch, and closes the issue.
   Keep the loop running (`while make agent-tick; do :; done`) so it picks these
   up; merge-on-`lgtm` only happens on a tick *after* your comment.
5. **Finish the feature.** When all sub-PRs are merged into `agent/epic-<N>`,
   check out the branch, test it end-to-end, then `/ship` it to `main` normally.

## Branch + PR shape

```
main
└── agent/epic-12              # one feature branch per epic
    ├── agent/issue-13  → PR (base: agent/epic-12)  → you `lgtm` → agent merges
    ├── agent/issue-14  → PR (base: agent/epic-12)  → you `lgtm` → agent merges
    └── ...                    # then /ship agent/epic-12 → main
```

## Resetting a task

If an issue goes off the rails: comment your guidance, then relabel it
`agent-ready` (remove `agent-working`/`agent-blocked`). On the next tick the
agent re-reads the full issue thread — including its prior failed attempt and
your note — and tries again, better.

## Running 2–4 in parallel (optional)

`/agent-tick` works one issue per invocation, so a single `/loop` is serial. To
work several at once (independent worktrees), start additional `/loop
/agent-tick` sessions. No scheduler is built — keep it to what you can review.

## Why it's lazy

Nothing here is new machinery: the queue is GitHub Issues, the runtime is the
Claude you're already running, the reviewer is `/code-review`, the PR maker is
`/ship`, the scheduler is `/loop`. The two skills are just orchestration glue.
See `~/.claude/skills/decompose/` and `~/.claude/skills/agent-tick/`.
