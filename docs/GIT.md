# Commit message style

This repo follows the conventions Chris Beams documented in
[How to Write a Git Commit Message](https://cbea.ms/git-commit/). Read
that post once; this file is the working summary and the **pre-commit
checklist** every commit must pass.

> **Agents and humans: walk the checklist below before every
> `git commit`. No commit ships without it. If you can't tick a box,
> fix the commit — not the checklist.**

A `commit-msg` hook at `.githooks/commit-msg` enforces the mechanical
rules below (subject length, capitalization, trailing period,
Conventional Commits prefix, blank-line separator, body wrap). Activate
it once per clone with:

```
mise run git:install-hooks
```

The hook does **not** check imperative mood, scope, or body content —
those are still on you. Walk the full checklist anyway.

---

## Pre-commit checklist

### 1. Scope — is this one commit?

- [ ] The change is **one self-contained unit**: it builds, it tests, it
      makes sense on its own.
- [ ] You can describe it without using "and" (or a comma-separated
      list of unrelated things). If you can't, split it.
- [ ] No unrelated edits, no drive-by formatting, no stray debug code
      staged. Run `git diff --cached` to confirm.
- [ ] No secrets, no generated artifacts (`dist/`, `out/`,
      `node_modules/`, lockfile churn you didn't intend) staged.

### 2. Subject line — all seven must be true

- [ ] **≤ 50 characters** (72 is the absolute hard cap; over 50 means
      try harder before reaching for the cap).
- [ ] **Capitalized** first letter.
- [ ] **No trailing period.**
- [ ] **Imperative mood.** Completes the sentence:
      *"If applied, this commit will ______."*
      Good: `Refactor citation extractor for clarity`.
      Bad: `Refactored citation extractor` / `Citation extractor refactor`.
- [ ] **No Conventional Commits prefix.** Not `feat:`, not `fix:`, not
      `chore:`, not `refactor:`. The subject is a sentence, not a tag.
- [ ] **No issue-tracker key in the subject** (no `[LC-123]`, no
      `JIRA-42:`). Use a `Resolves:` / `See also:` trailer in the body
      if you need to reference one.
- [ ] **Reads as one sentence**, not a label or fragment.

### 3. Body — required unless the subject is genuinely self-explanatory

A trivial commit (`Fix typo in section view header`) can ship with no
body. Anything else needs one.

- [ ] **Blank line** between subject and body.
- [ ] **Wrapped at 72 columns.** Git does not wrap for you.
- [ ] Explains **what changed and why**, not *how* (the diff shows how).
- [ ] Names the **prior state** and what was wrong with it, when
      relevant. ("X was doing Y, which broke Z because…")
- [ ] Names **why this approach** over the alternatives, when the
      choice wasn't obvious.
- [ ] Calls out **side effects, follow-ups, or caveats** a future
      reader needs.
- [ ] Does **not** list which files were touched (the diff does that).
- [ ] Does **not** reference the current task / PR / caller ("added
      for the X flow", "used by Y") — that belongs in the PR
      description and rots with the codebase.
- [ ] If a plan, review, or design doc drove this change, includes a
      `See: <path>` trailer so a reader can find it.

### 4. Final pass before `git commit`

- [ ] Re-read `git diff --cached`. Does the message match what's
      actually staged?
- [ ] Are you about to `--amend`? **Only if the user explicitly asked
      for it.** Default to a new commit; pre-commit-hook failure means
      the commit didn't happen, so `--amend` would rewrite the wrong
      commit.
- [ ] Are you about to pass `--no-verify`? **Only if the user
      explicitly asked.** Hook failures are signal — fix the cause.
- [ ] If this is a mid-PR fix to an earlier commit on the same
      branch, fold it via `git rebase -i` into the originating
      commit. Never push a standalone "fix CI" / "apply format"
      commit.

---

## Reference material

### Imperative-mood test

A well-formed subject completes:

> *If applied, this commit will _your subject line here_.*

| Good                                | Bad                              |
| ----------------------------------- | -------------------------------- |
| Refactor citation extractor         | Refactored citation extractor    |
| Add zod validators at FS boundary   | Added some validators            |
| Remove deprecated parser fallback   | Citation extractor refactor      |
| Release version 1.0.0               | More fixes                       |

### What goes in the body

Code shows *how*. The body explains:

- The problem this commit solves (what was wrong with the previous
  state).
- Why this approach was chosen over alternatives.
- Side effects, follow-ups, or caveats a future reader needs.

If the change has a longer story behind it (a plan, a review, a design
doc), reference the artifact path so a reader can find it without
hunting:

```
See: ~/.gstack/projects/legiscode/richardash-feat-corpus-parser-design-20260430-163525.md
```

### What this repo specifically does NOT do

- **No Conventional Commits prefix.** No `feat:`, `fix:`, `chore:`,
  `refactor:`. The subject is a sentence, not a tag-and-label. The
  commit type is obvious from the diff and the subject.
- **No issue-tracker prefix or trailing JIRA keys** in the subject. If
  you need to reference an issue, do it in a `Resolves:` / `See also:`
  trailer at the bottom of the body.
- **No multi-paragraph "summary" up front.** First line is the subject.
  Period.
- **No "fix CI" / "apply format" / "address review" follow-up
  commits.** Fold them into the originating commit via interactive
  rebase before pushing.

### Atomicity

> *If you can't summarize a commit in 50 characters without listing
> three things, it probably wants to be more than one commit.*

Each commit should be a self-contained unit: it builds, it tests, it
makes sense in isolation. A reviewer reading just that commit's diff
should be able to understand both what changed and why without paging
back through earlier commits in the branch.

This does **not** mean "one file per commit." It means: bundle the
files that have to land together for the change to make sense, and
nothing more.

### Worked example (this repo)

```
Establish module data model with zod validators

Replace the empty interface stubs from feat/repo-baseline with zod
schemas and ship runtime validators at every filesystem read boundary.
The schemas (SectionFile, ManifestFile, ReferencesFile,
DefinitionsFile, CorpusMeta, Citation, OrdinanceFile, TextDiff) are the
single source of truth: TS types are derived via z.infer, so the
type/validator drift class is closed.

Validators reject malformed input with messages that name the offending
field (formatZodError), so a missing-required-field bug surfaces with
"snapshot_at: required" instead of an opaque parser error.

zod ships as a runtime dependency (production .dmg/.exe imports it from
src/types/validate/); cheerio, tsx, and nock are devDeps. Node 24 LTS
in mise.toml; @types/node aligned.

See: ~/.gstack/projects/legiscode/richardash-feat-corpus-parser-design-20260430-163525.md
```

Subject is 47 characters, imperative, capitalized, no period. The body
explains what changed and why; it doesn't list which files were
touched (the diff does that).
