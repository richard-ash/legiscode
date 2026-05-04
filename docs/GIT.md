# Commit message style

This repo follows the conventions Chris Beams documented in
[How to Write a Git Commit Message](https://cbea.ms/git-commit/). Read that
post once; this file is the working summary.

## The seven rules

1. Separate subject from body with a blank line.
2. Limit the subject line to 50 characters (72 is the hard cap).
3. Capitalize the subject line.
4. Do not end the subject line with a period.
5. Use the imperative mood in the subject line.
6. Wrap the body at 72 characters.
7. Use the body to explain *what* and *why*, not *how*.

## Imperative-mood test

A well-formed subject line completes the sentence:

> *If applied, this commit will _your subject line here_.*

Good: `Refactor citation extractor for clarity`. Bad: `Refactored
citation extractor`. Bad: `Citation extractor refactor`.

## What goes in the body

Code shows *how*. The body explains:

- The problem this commit solves (what was wrong with the previous state).
- Why this approach was chosen over the alternatives.
- Side effects, follow-ups, or caveats a future reader needs.

Skip the body entirely for commits where the subject is self-explanatory
(`Fix typo in section view header`). Don't pad with filler.

If the change has a longer story behind it (a plan, a review, a design
doc), reference the artifact path so a reader can find it without
hunting:

```
See: ~/.gstack/projects/legiscode/richardash-feat-corpus-parser-design-20260430-163525.md
```

## What this repo specifically does NOT do

- **No Conventional Commits prefix.** No `feat:`, `fix:`, `chore:`,
  `refactor:`. The subject is a sentence, not a tag-and-label. The
  commit type is obvious from the diff and the subject.
- **No issue-tracker prefix or trailing JIRA keys** in the subject. If
  you need to reference an issue, do it in a `Resolves:` / `See also:`
  trailer at the bottom of the body.
- **No multi-paragraph "summary" up front.** First line is the subject.
  Period.

## Atomicity

> *If you can't summarize a commit in 50 characters without listing
> three things, it probably wants to be more than one commit.*

Each commit should be a self-contained unit: it builds, it tests, it
makes sense in isolation. A reviewer reading just that commit's diff
should be able to understand both what changed and why without paging
back through earlier commits in the branch.

This does **not** mean "one file per commit." It means: bundle the
files that have to land together for the change to make sense, and
nothing more.

## Worked example (this repo)

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
