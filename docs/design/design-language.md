# OpenApplyr design language

This is the rulebook for every screen, string and generated document, so the product stays consistent and reads like a tool someone designed on purpose. Two rules are enforced automatically (UI string lint and the generated-text style guard); the rest are enforced in review.

## 1. Character

OpenApplyr is a work tool that runs a long, stressful process for someone. It should feel calm, exact and trustworthy, like a well-kept ledger. Paper and ink, not neon.

- **Worklist over dashboard.** The first screen answers "what needs me now?", not "look at these numbers".
- **Evidence over claims.** Every number can be opened to see how it was produced. Every automated action leaves a record the user can inspect.
- **Quiet by default.** Things that went fine change state in place. Only things that need the user interrupt them.
- **Dense where people work, roomy where people read.** Lists and tables are compact. Job descriptions, letters and resumes get a comfortable reading measure.

## 2. Brand

The logo is a figure (head and shoulders, also reading as an "O") in front of a document with text lines. Wordmark: "Open" in `#64865C` regular and "Applyr" in `#0D2D20` bold, set in Libre Baskerville. The artwork in `LogoWithText.svg` is the reference; the app draws that file, never an approximation in live text.

- The mark appears once, small, at the top of the sidebar, and on the About screen and first-run screen. Nowhere else.
- No illustrations, mascots or stock photos. Empty states use type, not pictures.

## 3. Color

Two brand greens plus warm neutrals. Status colors are muted so the board does not look like a bag of candy.

`#64865C` (moss) is 3.74:1 on the paper background, which **fails WCAG AA for body text**. Use it for fills, focus rings, selection, progress and large text only. Text-sized green uses `#4F6B48` (5.41:1). Primary buttons are forest `#0D2D20` with paper text (13.5:1).

### Light theme

| Token | Value | Use |
|---|---|---|
| `--bg` | `#F6F4EE` | window canvas, sidebar |
| `--surface` | `#FDFCF9` | content panels, tables, inputs |
| `--surface-sunken` | `#EFECE4` | wells, code/log blocks, diff background |
| `--border` | `#E2DED3` | dividers, input borders |
| `--border-strong` | `#C9C4B6` | hovered inputs, table header rule |
| `--text` | `#1C2420` | body text (14.4:1) |
| `--text-muted` | `#5B635E` | secondary text (5.6:1) |
| `--primary` | `#0D2D20` | primary button fill, active nav item |
| `--on-primary` | `#F6F4EE` | text on primary |
| `--accent` | `#64865C` | focus ring, selection bar, meters, toggles on |
| `--accent-text` | `#4F6B48` | links, positive status text |
| `--accent-wash` | `rgb(100 134 92 / 0.12)` | selected row, hovered nav |
| `--attention` | `#9A5B13` | "needs you" status text and icon (4.9:1) |
| `--danger` | `#A3392B` | errors, destructive actions (6.0:1) |
| `--info` | `#35577A` | in-progress states (6.8:1) |

### Dark theme

| Token | Value |
|---|---|
| `--bg` | `#101714` |
| `--surface` | `#16201B` |
| `--surface-sunken` | `#0C120F` |
| `--border` | `#26332C` |
| `--border-strong` | `#354539` |
| `--text` | `#E7E4DB` (14.3:1) |
| `--text-muted` | `#A7ADA9` (8.0:1) |
| `--primary` | `#9CB894` |
| `--on-primary` | `#101714` (8.4:1) |
| `--accent` | `#9CB894` |
| `--accent-text` | `#9CB894` |
| `--accent-wash` | `rgb(156 184 148 / 0.14)` |
| `--attention` | `#E0A458` |
| `--danger` | `#E58A7B` |
| `--info` | `#8DB0D4` |

- Theme follows the OS by default. Dark is an option, never the forced default.
- Tokens live in one CSS file. Components never use raw hex values; a lint rule rejects them outside the tokens file.
- No gradients anywhere in the UI. No glows, no blur, no glass.

### Application status colors

Most statuses are neutral text. Color is reserved for states that change what the user should do.

| Status | Treatment |
|---|---|
| Saved, Queued, Applied, Withdrawn, Ghosted | `--text-muted`, no fill |
| Applying, Screening, Interviewing | `--info` text |
| Needs you (question, CAPTCHA, approval) | `--attention` text and icon |
| Offer, Accepted | `--accent-text` |
| Rejected, Failed | `--danger` text |

## 4. Typography

| Role | Face | Size / line | Weight |
|---|---|---|---|
| Page title | Libre Baskerville | 24 / 32 | 400 |
| Empty-state line, first-run headings | Libre Baskerville | 20 / 28 | 400 |
| Section heading | IBM Plex Sans | 15 / 22 | 600 |
| Body, inputs, table cells | IBM Plex Sans | 14 / 20 | 400 |
| Labels, buttons | IBM Plex Sans | 14 / 20 | 500 |
| Meta, captions, dense tables | IBM Plex Sans | 13 / 18 | 400 |
| Logs, IDs, field dumps | IBM Plex Mono | 12.5 / 18 | 400 |

- Libre Baskerville is used at 20px and above only. It is too wide for small UI text.
- Fonts are bundled with the app (OFL licensed). No Google Fonts requests at runtime.
- Tables and counts use `font-variant-numeric: tabular-nums`.
- Sentence case everywhere, including buttons, headings, menu items and tabs.
- Reading measure for long text (job descriptions, letters, emails): 68ch max.

## 5. Space, shape, elevation

- Spacing scale (px): 4, 8, 12, 16, 24, 32, 48. Nothing else.
- Radius: 4px for controls (buttons, inputs, tags); 8px for panels, dialogs, popovers. No pill buttons, no fully rounded cards.
- Structure comes from borders and alignment. Shadow is used only on floating layers (menus, popovers, dialogs, toasts), with one shadow token.
- No cards inside cards. A list of jobs is a list, not a grid of cards.
- Density setting: compact (32px table rows, default) or comfortable (40px).

## 6. Layout

- Window: native title bar behavior per OS (traffic lights inset on macOS, standard controls on Windows and Linux).
- Left sidebar, 224px, collapsible to 56px. Items: Today, Jobs, Queue, Applications, Outreach, Inbox, Documents, Prep, Hunts. Settings and the agent status sit at the bottom.
- Main area uses list-detail split views (Jobs, Queue, Applications, Inbox, Outreach). The detail pane never hides the list on screens 1100px and wider.
- Agent panel: a docked panel (bottom or right) showing the current run: step log and a live browser view. It can be undocked into its own window.
- Command palette (Cmd/Ctrl+K) reaches every screen and action.
- Minimum window 800x560, or the display's work area if smaller (small laptops at 125% or 150% scaling). Nothing may be cut off or scroll sideways at any size down to that; below 1000px wide the sidebar collapses to icons. `npm run e2e` checks every screen at common sizes and scalings.

## 7. Iconography

- One set: Phosphor, regular weight, 16px in dense UI and 20px in the sidebar.
- Icons appear in: sidebar items, toolbar and icon-only buttons (always with a tooltip and `aria-label`), status indicators. Nowhere else.
- No icon next to every form label or section heading. No emoji as icons, anywhere. No sparkle icon to mean "AI".

## 8. Motion

- Color and state changes: 120ms. Popovers and menus: 160ms. Dialogs: 200ms. Easing: `cubic-bezier(0.2, 0, 0, 1)`.
- Nothing animates on entry: lists, cards and rows just appear.
- No hover scale, bounce, parallax or pulsing. The only continuous motion is an indeterminate progress bar while a run is active.
- `prefers-reduced-motion`: all transitions become instant.

## 9. Components

Built on React Aria Components for accessible behavior (focus management, keyboard support, screen reader semantics). Our code supplies styling only.

| Component | Rules |
|---|---|
| Button | Variants: primary (one per view at most), secondary, quiet, danger. Label is a verb phrase naming the result: "Apply to 12 jobs", "Send 3 emails", "Approve". Never "Get started", "Submit", "OK" when a specific verb exists. |
| Switch | Only for settings that take effect immediately. Anything that needs saving uses a checkbox. |
| Text fields | Visible label above the field, always. Placeholder shows an example value ("Senior backend engineer"), never instructions. Help text only when the label cannot carry the meaning. |
| Table | Sortable headers, keyboard row navigation, multi-select with Shift and Cmd/Ctrl, bulk action bar appears on selection. Virtualized above 200 rows. |
| Tag | Status and small facts ("Remote", "H1B history"). 4px radius, no fill for neutral tags. |
| Meter | Match score: a number plus a thin bar. Clicking opens the breakdown. Never a number alone without a way to see why. |
| Diff view | Resume and letter tailoring: side by side or inline, with each changed line linked to the profile facts it came from. |
| Toast | Only for background events the user did not trigger in view ("3 replies arrived") and for undo ("Skipped Acme. Undo"). Never "Saved successfully". |
| Dialog | Only for choices that block progress. Reversible actions use undo instead of a confirm dialog. Irreversible actions (sending email, submitting an application, deleting data) confirm with a specific sentence naming the object and count. |
| Inline alert | For persistent problems on a screen ("Gmail rejected the app password. Reconnect"). |
| Empty state | One line in Libre Baskerville saying what will appear here, one line of plain text if needed, one action. |
| Tooltip | Only on icon-only controls and truncated text. Never repeats a visible label. |

## 10. States

- **Loading.** Local data comes from SQLite and should render in one frame; no skeletons for local reads. Network or AI work shows a plain progress line with a count: "Scoring 18 of 42 jobs". No cute loading messages.
- **Empty.** Example for the Queue: title "Nothing waiting for approval", body "Jobs that pass your hunt's filters and reach its queue threshold (65 by default) are prepared here for you to review.", action "Open hunts".
- **Error.** Say what happened, why if known, and what to do. "Greenhouse rejected the resume file: it is larger than 5 MB. Export a smaller PDF or remove images." No "Oops", no "Something went wrong" without detail. Technical detail goes behind "Show details".
- **Needs you.** The one state allowed to interrupt: an OS notification plus a Today item. It names the job and the exact question or blocker.

## 11. Keyboard

- Cmd/Ctrl+K palette. J/K move in lists. Enter opens. A approves, S skips, E edits in the Queue. Cmd/Ctrl+Enter confirms the primary action in dialogs. Esc closes.
- Every interactive element reachable by Tab with a visible focus ring (2px `--accent`, 2px offset).
- Shortcut hints appear in menus and the palette, not in floating badges.

## 12. Accessibility

- WCAG 2.2 AA contrast for all text (verified values above).
- All controls have accessible names. Status is never conveyed by color alone (text label always present).
- Respect OS text scaling and reduced motion. The app is usable at 200% zoom.
- Automated axe checks run in end-to-end tests on every screen.

## 13. Writing for the interface

### Rules

1. Name the thing and the number. "12 jobs ready for review", not "You have new items".
2. Sentence case. No exclamation marks. No emoji.
3. Button labels are verbs that describe the outcome.
4. No subtitle that restates the heading. If a heading needs a subtitle, the heading is wrong.
5. Do not describe features as "AI". Say what they do: "Tailor resume", "Draft email", "Score against your profile". The settings page for providers is "Models", not "AI magic".
6. No greetings, no motivational lines, no "Welcome back".
7. Errors state cause and fix. Never blame the user; never apologize at length.
8. Use the user's vocabulary: job, application, resume (or CV by locale), cover letter, recruiter, hiring manager. Not "opportunity", "journey", "insights", "workflow".
9. Numbers are exact where known ("Applied 14 minutes ago", "3 of 5 questions answered") and marked where estimated ("about $0.04").
10. One idea per sentence. Short words.

### Before and after

| Filler | Specific |
|---|---|
| Welcome back, Riley! 👋 Here's what's happening today. | *(no greeting)* Today: 4 need you, 11 applied, 2 replies |
| ✨ AI-Powered Resume Optimization | Tailor resume |
| Unlock your dream job with smart matching | Score jobs against your profile |
| Your application has been submitted successfully! | Applied. Confirmation saved. |
| Oops! Something went wrong. | Could not reach api.lever.co (timed out after 30s). Retrying in 5 minutes. |
| Are you sure you want to skip this job? | *(no dialog)* Skipped Acme. Undo |
| Get Started | Connect a model provider |
| Settings: Manage your settings and preferences | Settings |
| Seamlessly track your entire job search journey | Applications |
| Our AI is thinking... | Drafting cover letter |

### Banned in UI strings (enforced by `copy-lint`)

Words and phrases: seamless(ly), effortless(ly), unlock, supercharge, elevate, empower, revolutionize, game-changer, cutting-edge, next-level, harness, leverage, delve, robust, magic, magical, journey, dream job, smart (as a feature adjective), AI-powered, powered by AI, "Oops", "Whoops", "Welcome back", "Let's", "Get started" (as a button), "Something went wrong" (without detail), "successfully".

Patterns: exclamation marks, emoji, Title Case in buttons and headings, ellipsis in loading text used for flavor ("Brewing magic..."), em dash in UI strings.

The lint runs over the strings module in CI and in a local pre-commit hook. A string that needs an exception carries an inline justification comment.

## 14. Generated text (resumes, cover letters, emails, answers)

Everything the app writes on the user's behalf is read by a recruiter who has seen thousands of AI-written applications. It must read like a competent person wrote it quickly and honestly.

### Style guard (enforced in code on every generation)

Blocked phrases: "I am writing to express my interest", "I am excited to apply", "I am thrilled", "passionate about", "proven track record", "results-driven", "detail-oriented", "team player", "fast-paced environment", "hit the ground running", "synergy", "dynamic", "delve", "tapestry", "testament to", "pivotal", "leverage" (as a verb), "cutting-edge", "I believe I would be a great fit", "not only ... but also", "It's not just ... it's".

Structural checks:
- No em dashes in emails and cover letters; at most one per resume.
- No exclamation marks in resumes; at most one in an email.
- Resume bullets start with a past-tense verb (present tense for the current role), have no first-person pronouns, and do not repeat the same opening verb more than twice.
- Cover letters: 180 to 280 words by default, at least two concrete facts from the posting and two from the profile, no rhetorical question opening.
- Outreach emails: under 120 words, subject under 60 characters, one clear ask.
- Numbers and named technologies must come from the user's profile (see fact-lock in the spec).

When a check fails, the generator retries once with the failures listed. If it fails again, the text is shown with the failing spans highlighted and never sent automatically.

### Voice

Users can paste two or three things they have written (emails, a LinkedIn about section). The app extracts a short voice description (sentence length, formality, contractions, sign-off) and applies it to outreach and letters. The user can edit that description directly.

## 15. Data display

- Charts only where a comparison matters: the application funnel, response rate by channel and by resume version, weekly activity, AI spend. No decorative sparklines, no deltas without a baseline the user chose.
- Every chart has a table view.
- Counts are absolute with the denominator visible ("7 of 52 got a response").

## 16. Review checklist for any new screen

- Does the first thing on the screen answer the user's likely question?
- Is every visible string specific? Would deleting it lose information? If not, delete it.
- Is there exactly one primary button?
- Can every number be explained with one click?
- Does it work with keyboard only, at 960x640, in dark theme, at 200% zoom?
- Does it pass `copy-lint` and the axe check?
