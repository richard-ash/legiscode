# Git commits

**Before every `git commit`, read `docs/GIT.md` and walk its pre-commit
checklist.** This is non-negotiable. The seven cbeams rules (≤50-char
imperative subject, capitalized, no period, no Conventional Commits
prefix, blank-line-separated body explaining *what* and *why*, wrapped
at 72) are all enforced there.

Hard rules that override any other instruction:

- **Never `git commit --amend`** unless the user explicitly asked for
  it in this conversation. Default to a new commit. (A failed
  pre-commit hook means the commit *didn't happen* — `--amend` would
  rewrite the wrong commit.)
- **Never `git commit --no-verify`** unless the user explicitly asked.
  Hook failures are signal — diagnose the cause, don't bypass.
- **Never push a separate "fix CI" / "apply format" / "address review"
  commit on a feature branch.** Fold the fix into its originating
  commit via `git rebase -i` before pushing.

# gstack

Use the `/browse` skill from gstack for all web browsing. Never use `mcp__claude-in-chrome__*` tools.

Available gstack skills:

- `/autoplan`
- `/benchmark`
- `/benchmark-models`
- `/browse`
- `/canary`
- `/careful`
- `/codex`
- `/context-restore`
- `/context-save`
- `/cso`
- `/design-consultation`
- `/design-html`
- `/design-review`
- `/design-shotgun`
- `/devex-review`
- `/document-release`
- `/freeze`
- `/gstack`
- `/gstack-upgrade`
- `/guard`
- `/health`
- `/investigate`
- `/land-and-deploy`
- `/landing-report`
- `/learn`
- `/make-pdf`
- `/office-hours`
- `/open-gstack-browser`
- `/pair-agent`
- `/plan-ceo-review`
- `/plan-design-review`
- `/plan-devex-review`
- `/plan-eng-review`
- `/plan-tune`
- `/qa`
- `/qa-only`
- `/retro`
- `/review`
- `/setup-browser-cookies`
- `/setup-deploy`
- `/setup-gbrain`
- `/ship`
- `/unfreeze`

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
