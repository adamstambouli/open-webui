# Design Notes

How the widget's UI was designed: sandbox-first, in the open, with every decision written down.

![Final design, all six states (light)](design/showcase-light.png)

**Artifacts**

- [`design/demo.mp4`](design/demo.mp4) — the feature recorded live, end to end.
- `design/` — screenshots: [light](design/showcase-light.png) · [dark](design/showcase-dark.png) · [peek popover](design/showcase-peek-popover.png).
- `widget-showcase.html` — the final design, live. One annotated card per state, with working hovers, expand/collapse, themes, and reduced motion. Open from disk.
- `widget-playground.html` — the iteration tool: side-by-side compare columns from the design rounds. Kept as process evidence.
- Implementation notes and tradeoffs: [NOTES.md](NOTES.md).

## Why a sandbox first

The widget has six states, three hover surfaces, expand/collapse, two themes, and a reduced-motion mode — around 40 combinations. In the running app, each iteration costs a generation cycle. In a static sandbox with the app's real colors and animation values, it costs a browser refresh, with every state visible at once. The design went through a dozen-plus rounds in an afternoon because feedback took seconds, not minutes.

## Principles

1. **The line shows the current truth, by priority.** Error > reconnecting > current step > footer. While reconnecting, the line says only "Reconnecting…" — the connection is the message. The step label returns with the socket.
2. **Motion has semantics.** Spinner: data flowing. Blinking amber: attempting, no response. Static: settled. Under reduced motion everything stops — blinking is motion too — and text carries activity, the same signal path screen readers use.
3. **The popover is the collapsed state's window.** It shows only what the line hides, never repeats status, elapsed, or tokens, and never appears while expanded. Dense, truncating, non-interactive.
4. **The expanded view is the popover's roomy mirror.** Same sections, same order — STEPS, SOURCES, STATUS, ERROR — but interactive: links, previews, info tooltips, a left rail marking the region off from the answer.
5. **Never claim finished work that isn't.** Only the message's own `done` may show completion. A finished trace with an unfinished answer keeps the last step running; an error settles any step still spinning.
6. **Healthy is silent.** Connection state appears on the line only when something is wrong; session count only above one. Both always have a home in the STATUS section.

## Systems

- **Marker column.** Every leading indicator — spinner, dot, citation badge — centers in one 15px slot with a 3px gap, so labels across all rows share one axis. The expanded view's rail runs under the slot's center line.
- **Honest numbers.** Elapsed keeps ticking through reconnects (time truly passes); tokens freeze (nothing is arriving). Estimates carry `~`. Counts ≥1k always show one decimal (`5.1k`, `1.0k`) so tabular widths never shift.
- **No fake progress.** An indeterminate progress rail was built and then cut: generative work has no denominator, and step-count fractions move backwards as steps arrive. The motion taxonomy carries working state instead.

## Bugs the design process caught

| Bug | Cause | Fix |
| --- | --- | --- |
| Restart loop | "Restart when terminal but not done" re-fires forever once the mock ends before the answer | Restart only on the `done` true→false edge |
| Early "Complete" | Stream end conflated with generation end | Two-clock rule: only `done` claims completion |
| Elapsed snap-back | Elapsed fell back to the stream's end timestamp | Elapsed never reads `finishedAt` |
| Error-orphaned steps | The error path didn't settle running steps | Reducer marks them errored, with end times |
| Clipped hover cards | Absolutely-positioned cards inside `overflow: hidden` ancestors | Render through tippy into `document.body` |
| Popover focus leak | Line-wide `:focus-within` fired when a clicked badge took focus | Trigger scoped to the stats/chevron cluster |
| Skipping timer digits | 1Hz sampling drifts against second boundaries | Sample at 4Hz — one changed number |

## Process

Each round: propose in the sandbox, screenshot, critique, fix. An adversarial review agent checked every plan revision; a separate session implemented from the frozen spec. The path to the final design: bordered card → borderless status line → spinner over shimmer → right-aligned bare stats → citation badges with previews → shared section structure between popover and expanded view → the motion taxonomy → alignment and spacing systems → interaction affordances (whole-row expand, hover lift, external-link hints).
