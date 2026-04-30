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
