---
name: agent-tick
version: 1.3.3
description: "One iteration of the autonomous agent loop: first advance an in-flight PR (address unresolved review threads and resolve them, or merge on the human's lgtm/approval), otherwise pick the next agent-ready issue and implement it into a PR. Watches its own PRs until merged. Driven by /loop. (legiscode)"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Skill
---

# /agent-tick

You are the **implementer** in the local autonomous agent loop (see
`docs/AGENTS.md`). Each invocation does **exactly one unit of work**, then
stops, so `/loop` can drive you.

**Priority: watch your own PRs before starting new ones.** A tick first tries to
advance an in-flight PR (respond to the human's review comments, or merge it
once they say `lgtm`). Only when no open PR needs you do you pick up a new
issue. You **merge only on the human's explicit `lgtm`** — never otherwise.

## 1. Cleanup

For every worktree under `../legiscode-agent-*`: if its PR is merged or closed
(`gh pr view <branch> --json state,mergedAt`), `git worktree remove` it and
delete the local branch. If its issue's PR merged, `gh issue close <N>`.

## 2. Advance an in-flight PR (watch your posted PRs)

List issues you've already shipped, lowest number first:

```bash
gh issue list --label agent-needs-human-review --state open --json number --jq 'sort_by(.number)'
```

For the first such PR, do exactly ONE unit of work, then **stop the tick**.
**Check 2a (merge) FIRST** — an approval means the human accepts the PR as-is,
so merge takes precedence over any still-open threads. Only if there's no
approval do you fall to 2b. Inline comments live in the GraphQL API, **not**
`gh pr view --comments` (issue timeline only). Set `O`/`R` once and reuse:
```bash
O=$(gh repo view --json owner --jq .owner.login); R=$(gh repo view --json name --jq .name)
```

### 2a. Merge on approval — check FIRST, and let it win
Detect approval two ways; **either one counts**, and a timeline `lgtm` is the
normal case (do NOT require a formal GitHub "Approve" review):
```bash
# (1) timeline lgtm comment — how the human usually approves:
gh pr view <P> --json comments --jq '[.comments[]|select(.body|ascii_downcase|test("^lgtm"))][-1].createdAt'
# (2) or a formal Approve review:
gh api repos/$O/$R/pulls/<P>/reviews --jq '[.[]|select(.state=="APPROVED")][-1].submitted_at'
```
If either approval timestamp is **newer than the last commit**
(`gh pr view <P> --json commits --jq '.commits[-1].committedDate'`), AND
`gh pr checks <P>` is all green, AND `mergeable` is `MERGEABLE`, then **MERGE NOW
and stop**:

```bash
git worktree remove ../legiscode-agent-<N> --force
gh pr merge <P> --squash --delete-branch          # squash → one tidy commit per sub-issue
gh issue close <N>
```
Note: under `--permission-mode auto` the classifier blocks `gh pr merge` (an
irreversible shared-repo action). If it's blocked, stop and surface the three
commands for the human to run. For hands-off merging, allow-list
`Bash(gh pr merge *)` (the human's `lgtm` is already the gate).

**The `lgtm` is authoritative.** When it's valid (newer than HEAD + green +
mergeable), do NOT read threads, do NOT "improve" the code, do NOT run 2b — the
human approved *this exact commit*; just merge it. Touching the code now would
push a new commit, make their approval stale, and strand the PR (the failure
this rule exists to prevent). Only a stale approval (a commit landed after it)
sends you to 2b.

### 2b. Otherwise, address unresolved review threads
If not approved, fetch the PR's **unresolved** threads:
```bash
gh api graphql -f query='query($o:String!,$r:String!,$p:Int!){
  repository(owner:$o,name:$r){ pullRequest(number:$p){ reviewThreads(first:100){ nodes{
    id isResolved comments(first:10){ nodes{ author{login} path line body } } } } } } }' \
  -F o=$O -F r=$R -F p=<P> \
  --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved==false)'
```
If any exist:
1. Locate the worktree `../legiscode-agent-<N>` (recreate if missing:
   `git worktree add ../legiscode-agent-<N> agent/issue-<N>`).
2. For each unresolved thread, either **fix it**, or **consciously decline** it
   (e.g. a "fine today" nit). Resolution state is the signal — author doesn't
   matter (a thread may be your own `/code-review` finding or the human's note).
3. If you fixed anything: re-run the green-gate (`make format && make ci`, see
   step 8), **fold into the originating commit via rebase**, force-push.
4. **Reply on each thread (what you did, or why you declined), then resolve it**
   so it can't re-trigger next tick. A reasoned decline counts as handled — the
   human reopens the thread if they disagree. Never resolve a thread you haven't
   replied to.
   ```bash
   gh api graphql -f query='mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ isResolved } } }' -F id=<threadId>
   ```
5. Summarize: `gh pr comment <P> --body "🤖 Addressed N threads; re-review."`

If neither 2a nor 2b applies (no approval, no unresolved threads — the PR is just
waiting on the human), leave it and check the next in-flight PR. **If you
advanced any PR, you are done — exit.** Only continue to step 3 when no in-flight
PR was actionable.

## 3. Pick the next issue

```bash
gh issue list --label agent-ready --state open --json number,title,body --jq 'sort_by(.number)'
```
Choose the **lowest-numbered** issue whose every `Depends on #X` is closed.
Skip ones labeled `agent-blocked`. **If none qualify, stop — say "no ready
issues" and exit.**

## 4. Read the memory

`gh issue view <N> --comments`. The full thread is the agent's memory: if this
issue was **reset** (previously attempted, then relabeled `agent-ready`), a
prior `🤖` comment and the user's guidance are here. Learn from it — do not
repeat the failed approach.

## 5. Claim it

```bash
gh issue edit <N> --remove-label agent-ready --add-label agent-working
gh issue comment <N> --body "🤖 starting on \`agent/issue-<N>\`"
```

## 6. Make a worktree off the feature branch

Parse `Part of #<E>` from the issue body → feature branch `agent/epic-<E>`.
```bash
git fetch origin
git worktree add ../legiscode-agent-<N> -b agent/issue-<N> origin/agent/epic-<E>
```
Do all subsequent work inside `../legiscode-agent-<N>`. Run `make install` there
if node_modules isn't linked.

## 7. Implement the vertical slice

Build exactly what the issue's Scope/Acceptance describe — a thin end-to-end
piece, not a horizontal layer. You inherit the repo `CLAUDE.md` and
`docs/GIT.md`, so cbeams commits, the pre-commit checklist, hermetic tests, and
"feature works end-to-end before merge" all apply. Add the acceptance check as a
test where it makes sense. Keep the diff near ~500 LOC; if the issue is bigger
than it looked, comment on it and split rather than ballooning.

## 8. Pass the gates CI will run — BEFORE shipping

CI runs the same checks as `make ci` (typecheck, lint, **format-check**, test).
A red PR burns a whole review round, so clear them *here*, not on the PR:

```bash
make format      # auto-fix formatting first — the most common miss
make ci           # install + typecheck + lint + format-check + test
```
Fix whatever fails and re-run `make ci` until it passes clean. Do this **before
you commit** (or fold the formatting fix into your commit via rebase) so the
shipped commit is already green. Do **not** run `/ship` while `make ci` is red.

Skip the Electron e2e here — `make test-e2e` is slow and flaky on CI; the
deterministic gates above are what a tick must guarantee. If you cannot get
`make ci` green, do not ship: follow "If something goes wrong" and mark the
issue `agent-blocked`.

## 9. Open the PR against the feature branch

Run `/ship` from the worktree. `/ship` targets the PR's base or the default
branch, so afterward **force the base to the feature branch**:
```bash
gh pr edit <P> --base agent/epic-<E>
gh pr edit <P> --body "$(gh pr view <P> --json body --jq .body)

Closes #<N>"
```
(Belt-and-suspenders: if `/ship` already opened against `agent/epic-<E>`, the
edit is a no-op.)

## 10. Self-review

```
/code-review --comment
```
This spawns independent reviewer agents (adversarial oversight) that post inline
review threads. For each real finding, **fold the fix into the originating
commit via rebase**, force-push, and **resolve that thread** (the GraphQL
mutation from step 2a). Hand off with **no fixed-but-unresolved threads** —
leave a thread open only if you consciously declined it (reply with why). Repeat
at most **2 rounds**, then move on.

## 11. Hand off to the watch loop

```bash
gh issue edit <N> --remove-label agent-working --add-label agent-needs-human-review
gh issue comment <N> --body "🤖 PR ready for review: <PR-URL>. Comment changes, or \`lgtm\` to merge."
```
Stop. You are NOT done with this PR — a later tick (step 2) will pick it back up
to address your review comments or merge it once you `lgtm`.

## If something goes wrong

If you cannot complete the issue (ambiguous spec, blocked on a decision, tests
won't pass): relabel `agent-working` → `agent-blocked`, comment what's blocking
with as much detail as you have, leave the worktree for inspection, and stop.
Never force a merge or fake a passing test to get unblocked. Never merge a PR
without a fresh `lgtm` and green CI.
