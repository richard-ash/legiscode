# Design System — LegisCode

## Product Context
- **What this is:** Legislative IDE for reading, analyzing, and understanding municipal code as an interconnected system
- **Who it's for:** Legislative analysts, government staff, policy researchers, city attorneys
- **Space/industry:** GovTech / Legal Tech — competing with Westlaw, LexisNexis, Bloomberg Law, Quorum, FiscalNote
- **Project type:** Desktop-style web application (IDE pattern)
- **Memorable thing:** "I finally understand what this law actually means and what it touches."

## Aesthetic Direction
- **Direction:** Industrial/Utilitarian with Editorial typographic sophistication
- **Decoration level:** Minimal — flat panels, 1px hairline borders, no rounded-card-soup, no box-shadows on panels
- **Mood:** A precision instrument built by someone who understands both code editors and legal text. Serious, dense, function-first, but typographically sophisticated. Not a SaaS dashboard, not a document viewer.
- **Reference sites:** Mockup originated in Claude Design (Apr 2026). Competitive research covered Westlaw, LexisNexis Lexis+, Bloomberg Law, vLex/Vincent, Quorum, FiscalNote, uscode.house.gov.

## Typography
- **Display/Headings:** Source Serif 4 — optical sizing 8–60, variable weight. Legal gravitas without feeling dated. Used for chapter titles (28px/500), section titles via Instrument Sans.
- **Body (legal text):** Source Serif 4 at 14.5px / 1.75 line-height — proportional serif optimized for long-form reading of dense legal text. Default "Readable" mode.
- **Body alternate (Code mode):** JetBrains Mono at 13.5px / 1.75 line-height — user-toggleable for those who prefer the IDE-style reading experience.
- **UI Chrome:** Instrument Sans — sharp, geometric, professional. Used for all navigation, labels, tabs, breadcrumbs, panel headers, buttons. Size range: 10–14px.
- **Code/Data/References:** JetBrains Mono — section numbers (§ 10.04.020), citation chips, line numbers, status badges, tab titles, ordinance numbers. Size range: 9–12px.
- **Loading:** Google Fonts CDN: `family=Instrument+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&family=Source+Serif+4:opsz,wght@8..60,300;8..60,400;8..60,500;8..60,600;8..60,700`
- **Scale:**
  - `--ui-xs: 10px` (badges, micro labels)
  - `--ui-sm: 11.5px` (status bar, breadcrumb, small labels)
  - `--ui: 13px` (default UI text)
  - `--ui-lg: 14px` (prominent UI text)
  - `--body: 14.5px` (legal body text)
  - `--h3: 16px` (section titles)
  - `--h2: 22px` (chapter sub-headings)
  - `--h1: 28px` (chapter headings)
- **Font feature settings:** `"cv11", "ss01", "ss03"` for Instrument Sans. `tabular-nums` on all monospace and data contexts.

## Color

### Approach
Restrained palette with strong semantic colors. The semantic color system is the crown jewel: each color has a specific meaning in the legal context. Background surfaces use neutral dark blue-grays. Color is reserved for meaning, not decoration.

### Dark Mode (default)
```css
/* Surfaces */
--bg-deep:     #0f1118;   /* near-black, title bar, status bar, activity bar */
--bg-base:     #161c26;   /* main content background */
--bg-surface:  #1e2430;   /* panels, left/right sidebars */
--bg-elevated: #262d3b;   /* cards, elevated elements, tooltips */

/* Text */
--text-primary:   #e0e4ec;  /* headings, active items, strong emphasis */
--text-secondary: #a3abba;  /* body text, readable content */
--text-muted:     #6b7588;  /* labels, captions, section headers */
--text-faint:     #4a5268;  /* line numbers, disabled states */

/* Borders */
--border:      #2a3040;
--border-soft: #222838;
--hairline:    rgba(224, 228, 236, 0.06);

/* Primary accent — institutional blue */
--accent:      #4d8bf7;
--accent-soft: color-mix(in oklab, #4d8bf7 18%, transparent);
--accent-hover: #6ea0f9;

/* Semantic: Citations (amber) */
--cite:     #dba13c;
--cite-soft: color-mix(in oklab, #dba13c 14%, transparent);

/* Semantic: Defined terms (green) */
--def:      #5dba7c;
--def-soft: color-mix(in oklab, #5dba7c 12%, transparent);

/* Semantic: Amendments / deletions (rose-red) */
--amend:     #e65472;
--amend-soft: color-mix(in oklab, #e65472 12%, transparent);

/* Semantic: AI / special (mauve) */
--ai:       #9b7fd4;
--ai-soft:  color-mix(in oklab, #9b7fd4 14%, transparent);

/* Semantic: Enacted / positive (same green) */
--enacted:  #5dba7c;

/* Semantic: Warning (same amber) */
--warning:  #dba13c;
```

### Light Mode
```css
--bg-deep:     #e8eaef;
--bg-base:     #fafbfc;
--bg-surface:  #f0f2f5;
--bg-elevated: #ffffff;

--text-primary:   #1a1d24;
--text-secondary: #4a5060;
--text-muted:     #8892a2;
--text-faint:     #b0b8c4;

--border:      #d0d5dd;
--border-soft: #e0e4ea;
--hairline:    rgba(26, 29, 36, 0.06);

--accent:      #2b6cb0;
--accent-soft: color-mix(in oklab, #2b6cb0 12%, transparent);

--cite:    #b8860b;
--def:     #2d8a52;
--amend:   #c9304a;
--ai:      #7c5cbf;
```

### Semantic Color Usage
| Color | Token | Meaning | UI Elements |
|-------|-------|---------|-------------|
| Amber | `--cite` | Cross-references, citations | Inline citation text, hover previews, citation chips, source pills |
| Green | `--def` | Definitions, enacted, additions | Defined terms (italic + dashed underline), inline additions, positive status |
| Rose-red | `--amend` | Amendments, deletions, conflicts | Strikethrough text, amendment banners, conflict badges, danger buttons |
| Mauve | `--ai` | AI-generated content | AI chat avatar, AI panel indicators |
| Blue | `--accent` | Navigation, active states, links | Active tree items, selected tabs, primary buttons, section number accents |

### Dark Mode Strategy
Dark mode is the default. This is a deliberate departure from legal industry convention (every tool defaults to white/paper). Rationale:
1. Reinforces the "this is a new kind of legal tool" positioning
2. Reduces eye strain for users in extended reading sessions
3. Makes semantic colors pop against neutral dark backgrounds
4. Aligns with the IDE metaphor (developers prefer dark mode)

Light mode is fully supported via a `.light-mode` class toggle.

## Spacing
- **Base unit:** 4px
- **Density:** Comfortable (VS Code / Linear-like, not cramped, not spacious)
- **Scale:** 2xs(2) xs(4) sm(8) md(12) lg(16) xl(24) 2xl(32) 3xl(48) 4xl(64)
- **Key dimensions:**
  - Title bar height: 34px
  - Tab bar height: 34px
  - Tree row height: 24px
  - Status bar height: 24px
  - Activity bar width: 44px
  - Left panel width: 240px (collapsible)
  - Right panel width: 320px (collapsible)
  - Center max-width: 820px

## Layout
- **Approach:** Three-panel IDE (grid-disciplined)
- **Structure:** Activity bar | Left panel | Center document | Right panel
- **Borders:** 1px solid `--border-soft` between all panels. No panel border-radius.
- **Max content width:** 820px (centered in the document panel with padding)
- **Border radius:**
  - Panels: 0 (flat edges)
  - Interactive elements (buttons, inputs): 2–4px
  - Badges, status chips: 2px
  - Tooltips, popovers: 6px
  - Avatars: 3px
  - Dots (status indicators): 50%

## Motion
- **Approach:** Minimal-functional
- **Easing:** enter(ease-out) exit(ease-in) move(ease-in-out)
- **Duration:** micro(50ms) short(120ms) medium(200ms)
- **What gets motion:**
  - Chevron rotation in tree views (120ms)
  - Hover state transitions (50ms)
  - Panel collapse/expand (200ms)
  - Tooltip appear/disappear (120ms)
- **What doesn't get motion:**
  - Tab switching (instant)
  - Panel tab switching (instant)
  - Tree item selection (instant)
  - No spring animations, no bouncing, no decorative motion

## Interaction Patterns

### Citation hover (amber)
Amber-colored text with underline. On hover: shows a tooltip with the cited section's title, excerpt, and "Go to definition" action. `Cmd+click` navigates to the cited section.

### Defined term hover (green)
Green italic text with dashed underline. On hover: shows definition tooltip with the term's legal definition and first-use location.

### Inline amendments (red/green)
Struck-through text in muted color with red strikethrough decoration + green addition text with green background tint. Shows proposed changes inline within the current text.

### Amendment banner
Rose-red left-border banner above affected sections. Shows ordinance number, description of proposed change, and "View Diff" action.

### Line gutter
Monospace line numbers (JetBrains Mono, 11px, faint color) in a 40px gutter to the left of body text. Enables precise reference to specific lines in legal text.

### Minimap
44px-wide minimap on the right edge of the document panel. Shows structural overview with colored indicators for headings (blue), amendments (red), and citations (amber).

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-23 | Initial design system created | Created by /design-consultation based on Claude Design mockups and competitive research |
| 2026-04-23 | Dark mode as default | Deliberate departure from legal industry convention to reinforce "law as code" positioning |
| 2026-04-23 | Source Serif 4 for body text (not JetBrains Mono) | Comprehension clarity is the memorable thing; proportional serif is more readable for long-form legal text |
| 2026-04-23 | Instrument Sans replaces Inter | Inter is overused; Instrument Sans has sharper character for a precision instrument |
| 2026-04-23 | Own palette replaces Catppuccin Mocha | LegisCode needs its own visual identity, not another project's color scheme |
| 2026-04-23 | Reading mode toggle (serif default / mono optional) | Respects both the comprehension-clarity direction and users who prefer the IDE aesthetic |
