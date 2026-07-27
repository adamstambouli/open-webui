# Live Session Widget — Design Notes

How the widget's UI was designed: a sandbox-first process, the principles it converged on, and the bugs the design work surfaced before they shipped.

**Artifacts**

![Final design, all six states (light)](design/showcase-light.png)

- `design/` — screenshots of the final design: [light](design/showcase-light.png), [dark](design/showcase-dark.png), and [the peek popover](design/showcase-peek-popover.png) — for reviewers who don't want to run anything.
- `widget-showcase.html` — the final design, live: one annotated card per state, with working hovers, expand/collapse, themes, and reduced motion. Open from disk.
- `widget-playground.html` — the iteration tool: side-by-side compare columns from the design rounds. Kept as process evidence.
- The HTML files are self-contained (no build, no dependencies) and out of the app bundle.

## Why a sandbox first

The widget has six visual states, three hover surfaces, an expand/collapse, two theme modes, and a reduced-motion mode — roughly 40 combinations. Iterating that inside the running app means one change per generation cycle; iterating in a static sandbox that faithfully replicates the widget's markup, palette, and animation CSS means one change per browser refresh, with every state visible at once. Eleven design rounds happened in an afternoon because the feedback loop was seconds, not minutes. The sandbox uses the app's real grays and its actual shimmer/animation values, so what was approved there is what the component builds.

## Design principles (what the rounds converged on)

1. **The primary line shows the current truth, by priority**: error > reconnecting > current step > footer summary. While reconnecting, the line says only "Reconnecting…" — the connection state is the message; the stalled step label returns with the socket.
2. **Indicator taxonomy — motion has semantics**: spinner = data flowing · blinking amber dot = attempting, no response · static = settled. Under reduced motion everything is static (blinking is motion too) and *text* carries activity ("…" suffix + the screen-reader live region) — sighted-reduced-motion users and screen-reader users get the same signal path.
3. **The hover popover is the collapsed state's window into hidden content.** It never appears while expanded (nothing is hidden), and never repeats what the line already shows (status, elapsed, tokens). Dense, truncating, non-interactive.
4. **The expanded view is the popover's roomy mirror**: same sections in the same order (STEPS → SOURCES → STATUS → ERROR), but interactive — clickable source links, hover previews, info tooltips — with wrapping text and a left rail marking the region off from the streaming answer.
5. **Never claim finished work that isn't.** Only the message's own `done` may show completion — the mock trace finishing early must not flip the widget to "Complete" while the answer still streams (caught live in browser testing: the early version lied by ~30s). Same rule at step level: trace-done-while-generating renders the final step as running; an error marks still-running steps as errored.
6. **Healthy is silent.** Connection state appears on the line only when abnormal; session count only when > 1. Both always have a home in the STATUS section of the detail views.

## Structural systems

- **Marker column**: every row's leading indicator (spinner, dot, citation badge) centers in one fixed 15px slot with a 3px gap, so labels across the primary line, steps, sources, and status all align on a single axis. The expanded view's left rail runs at the slot's center line.
- **Honest numbers**: elapsed time keeps ticking during reconnects (it's wall-clock truth — freezing would require extra state to display a lie) while tokens freeze (nothing is arriving); "~" prefixes the token estimate; counts ≥1k always show one decimal (`5.1k`, `1.0k`) so widths never shift under `tabular-nums`.
- **No fake progress**: the earlier indeterminate progress rail was cut — generative work has no known denominator, and a step-count fraction would move backwards as steps arrive. Working state is carried by the indicator taxonomy instead.

## Bugs the design process caught before they shipped

- **Restart loop** (plan review): "restart when terminal but message not done" loops forever when the mock finishes before the answer. Fixed with edge-triggered restart rules.
- **Early "Complete"** (browser pass): the widget claimed completion when the scripted trace ended, ~30s before the answer did. Fixed with the two-clock rule (principle 5).
- **Error-orphaned steps** (sandbox review): the reducer's error path left a mid-`running` step "in progress" forever under a dead session. Fixed at the reducer with a unit test.
- **Hover-card clipping** (sandbox): a popover inside an `overflow: hidden` (truncating) ancestor is clipped invisible. Rule: hover cards are never descendants of truncating containers.
- **Focus leak** (sandbox): a line-wide `:focus-within` popover trigger fired when a clicked citation badge took focus, popping the row card over the badge's own link. Rule: the popover trigger wraps only the stats/chevron cluster.
- **Ticker drift** (production): a 1Hz `setInterval` drifts against the elapsed clock's second boundaries and occasionally skips a displayed second. Fixed by sampling at 4Hz — one changed number, chosen over a boundary-aligned timer that needed three correctness patches before it was ever written.

## Process

Design rounds ran as: propose in the sandbox → screenshot/critique → fix → repeat, with an adversarial review agent checking each plan revision and a separate implementation session building from the frozen spec. The sequence that produced the current design: bordered card → borderless status line (blend-in) → spinner over shimmer → right-aligned bare stats → citation badges with previews → section structure shared between popover and expanded view → indicator taxonomy → alignment/spacing systems → interaction affordances (whole-row expand, hover lift, external-link hints).
