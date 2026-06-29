---
name: decompose
version: 1.0.0
description: "Break a high-level epic GitHub issue into ~500-LOC vertical sub-issues tagged for the autonomous agent loop, and create its feature branch. (legiscode)"
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
---

# /decompose `<epic-issue#>`

You are the **planner** in the local autonomous agent loop (see
`docs/AGENTS.md`). Turn one epic issue into a queue of small, independently
shippable sub-issues that `/agent-tick` will implement. Run labels setup first
if missing: `scripts/agent-setup.sh`.

## Steps

1. **Read the epic.** `gh issue view <E> --comments`. Understand the goal and
   any prior discussion. If it's already decomposed (has an "Agent sub-tasks"
   comment), stop and say so.

2. **Plan vertical slices.** Apply the same rigor as `/plan`. Each sub-task:
   - is a **vertical slice** — a thin end-to-end piece that works on its own,
     **not** a horizontal layer (schema-first, then UI later). Horizontal /
     foundational-first splitting is the #1 failure mode of this loop; a slice
     that has no consumer yet does not count as done.
   - targets **~500 LOC** of diff. Bigger → split; trivial → merge with a
     neighbor.
   - names the files it will touch and a concrete acceptance check (a test, a
     command output, a visible behavior).
   - declares ordering only when real: `Depends on #X` if it cannot land until
     X lands. Prefer independence so slices can run in parallel.

3. **Show the plan** to the user as a numbered list (title + scope + files +
   acceptance + any dependency). **Wait for an explicit lgtm.** Do not create
   issues before approval.

4. **On lgtm, create the feature branch and sub-issues:**
   ```bash
   git branch agent/epic-<E> main
   git push -u origin agent/epic-<E>
   ```
   Then for each slice, in dependency order so issue numbers reflect ordering:
   ```bash
   gh issue create --label agent-ready \
     --title "<slice title>" \
     --body $'Part of #<E>\nDepends on #<X>   # omit if none\n\n## Scope\n<what to build>\n\n## Files\n<paths>\n\n## Acceptance\n<concrete check>'
   ```
   Capture each new issue number; rewrite any `Depends on` placeholders to the
   real numbers with `gh issue edit`.

5. **Record on the epic** so GitHub is the memory:
   ```bash
   gh issue comment <E> --body $'## Agent sub-tasks\nFeature branch: `agent/epic-<E>`\n- #<n1> <title>\n- #<n2> <title> (depends on #<n1>)\n...'
   ```

6. Tell the user to start the loop: `/loop 15m /agent-tick` (see
   `docs/AGENTS.md`).

## Notes

- The epic itself is **not** labeled `agent-ready` — only the sub-issues are.
  Label the epic `epic`.
- Sub-issue bodies are the agent's brief; be specific. The agent inherits the
  repo `CLAUDE.md` and `docs/GIT.md`, so don't restate commit/test rules.
