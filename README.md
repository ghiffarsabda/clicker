# Clicker — Chrome Macro Builder

Build custom macros that automate repetitive tasks in the browser. Pick the elements you want
to act on directly on the page, chain them into steps, and replay the macro on demand.

Element picking reuses the `document.elementsFromPoint` hit-test logic from
[screenshot-tuif](https://github.com/ghiffarsabda/screenshot-tuif) — the same "which element is
under the cursor" approach — and turns it into durable selectors that survive reloads.

## Features

- **Visual step builder** — no scripting. Click `Click` / `Type` / `Key`, then pick the target
  element on the page. Reorder and delete steps freely.
- **Text-independent targeting** — an element is identified by its *structure*, not its label:
  `id` → `data-testid`/`data-*` → `aria-label` → `role`/`type`/`name`/`placeholder` → class
  signature → structural position. A button whose text rotates (`"do this"` → `"do that"`) keeps
  matching as long as the element is there. Text matching is opt-in per step (`also match by
  text`), and if every selector goes stale the player hunts the page for the closest structural
  lookalike — refusing tag-only or ambiguous matches rather than clicking the wrong element.
- **Step types** — `Click`, `Type` (React/Vue-safe native value set), `Key press`, `Scan`
  (wait for an element), `If` (branches), `Wait (ms)`, `Scroll` (human-like), `Go to URL`
  (navigates in place), `Open tab`, `Switch tab`, `Browser` (browser-wide shortcuts).
- **Multi-tab** — a step that opens a tab (a click that redirects, `window.open`, or an `Open tab`
  step) moves the rest of the macro onto that new tab, so you can click on site A and continue
  scrolling on site B.
- **Manual run + shortcuts** — start a macro from the panel or a keyboard shortcut.
- **Auto mode** — bind a macro to a URL pattern and it runs by itself whenever a matching page
  finishes loading. No clicking Run.
- **Loop mode** — repeat a macro `N` times, or endlessly until you press Stop, with a delay
  between passes. Macros with it on show a `↻` in the list.
- **Collapsible side panel** — `Add step`, `Toolbar`, and the `Activity` log fold away. The
  `Toolbar` is itself an accordion holding `Auto mode`, `Loop mode` and `Follow new tabs`, so those
  three collapse into one. Every header shows a live summary while folded
  (`auto off · loop off · tabs on`, `on · example.com`, `4 steps`), the settings sit below the step
  list so the steps keep the room, and your open/closed state is remembered.
- **Activity log** — per-step progress and errors.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (`clicker/`).
4. Click the Clicker toolbar icon (or press `Alt+Shift+M`) to open the side panel.

## Use

1. Open the side panel, name your macro (or create a new one with `+`).
2. Click **Click** (or **Type**/**Key**), then click the element on the page you want the macro
   to act on. `Esc` cancels picking.
3. Fill in any fields — text to type, key to press, wait duration, target URL.
4. Hit **Run** (`Alt+Shift+R`), or **Stop** to abort mid-run.

## Auto mode

Turn on **Auto mode** for a macro and it runs automatically whenever a page matching its URL
pattern finishes loading — you never press Run.

- **URL pattern** — glob-ish. `*` is a wildcard. A bare host like `example.com` matches anywhere
  on that site; leave it blank to run on every page.
  - `https://example.com/checkout/*`
  - `*://*.internal.tool/*`
  - `example.com`
- **Delay (ms)** — wait after load before running, so single-page apps can finish rendering
  (default 500ms).

Loop guards: only one macro runs at a time, a run will not retrigger itself on the page it
navigates to, and a macro fires at most once per (tab, URL). Macros with auto mode on show a
`⚡` in the macro list.

## Loop mode

Turn on **Loop mode** to repeat the whole step list:

- **Times** — how many passes. `0` means loop until you press **Stop** (or `Alt+Shift+R` again).
- **Every (ms)** — pause between passes (e.g. wait for the page to settle).

Stop is honoured mid-pass and mid-wait, and a failing step aborts the loop instead of spinning
forever. Combine with **Auto mode** for continuous background automation on a matching page —
keep the panel open so the activity log and Stop are at hand.

## Scroll step

The **Scroll** step moves the page like a person would, not with one instant jump:

- **Mode** — `By amount` (scroll `up`/`down` by a pixel distance), `To bottom` (run to the end of
  the page, however long it is), or `To top`.
- **Time** — duration in ms (`0` = auto, scaled to distance).
- **scroll to element…** — optionally pick an element instead; the page scrolls until it is
  centred (handles nested scroll containers too).

The motion is randomised so no two scrolls feel the same: each gesture is planned as a series of
flicks with independently random **sizes** (tiny nudges, normal flicks, occasional big throws) and
independent random **timing** (quick, normal, or slow and deliberate), some using distinct motion
profiles — ease-out, ease-in, ease-in-out, linear, and a stuttery stepwise one — with jittered
frame cadence and the occasional mid-scroll pause. The time shares are normalised, so however
erratic the pacing, the gesture still finishes in the requested duration. Every frame dispatches a
real `wheel` event, distance is clamped to the page bounds, the flick count is capped so a very
long page can't spin for minutes, and Stop interrupts a scroll mid-flight.

## Multiple tabs

A macro is not stuck on the tab it started on. Three things move it around:

- **Follow new tabs** (on by default) — after every step, if that step opened a tab (a click that
  redirects to a new tab, `window.open`, a form that targets `_blank`), the run adopts it. So:
  click a button on site A → site B opens → the next step (scroll, click, …) acts on B.
- **Open tab** step — open a URL in a fresh tab and continue there.
- **Switch tab** step — move to the **newest** tab, back to the **previous** tab (the run keeps a
  tab history), or to whichever tab matches a **URL** pattern. Each has an `activate` toggle.

Turn **Follow new tabs** off if you want every step pinned to the starting tab. Tabs that can't be
scripted (`chrome://`, the Web Store, other extensions) are never adopted.

Two things to know when a tab doesn't move the run:

- A synthetic click carries **no user activation**, so a page's own `window.open()` can be blocked
  by the popup blocker and no tab ever appears. When a click was on a link and nothing happened,
  the worker opens the link itself — logged as *"Opened … directly (the page's own popup was
  blocked)"*.
- The activity log prints **"Tab → host"** whenever the run moves, so you can see which tab each
  step actually ran on.

## If / Then / Else

An **If** step holds a condition and two branches. It runs the **then** steps when the condition
holds and the **else** steps when it doesn't; either branch can contain any steps, including more
Ifs (nesting works to any depth). Add steps to a branch with its `+ add step` button.

Conditions:

| Type | Tests |
|---|---|
| **Element** | the picked element is `visible` / `present` / `hidden` |
| **Text** | its text `is` / `contains` / `starts with` / `ends with` / `not empty` / `regex` a value |
| **Attribute** | an attribute (or `value` for an input) compared the same way |
| **Page URL** | the tab's URL matches a wildcard pattern (`*/checkout/*`, `example.com`, …) |

Tick **not** to invert any condition, and **case** to make text comparisons case-sensitive.
The activity log reports which branch was taken, and nested steps are indented.

## Elements that come and go (whack-a-mole)

Some buttons aren't on the page when the macro arrives. Two ways to wait for them — both check
immediately, then keep re-checking:

- **Scan step** — poll for a picked element until it appears. `Timeout` (ms, default 10000) and
  `Every` (poll interval, default 250). It errors if the element never shows up, unless
  **optional** is ticked, in which case the run continues (handy inside a loop that keeps hunting).
- **`Scan ms`** on a `Click` / `Type` / `Key` step — that step retries *its own* element for the
  given time before failing. `0` (the default) keeps the old fail-fast behaviour.

Pair a Scan with a loop for a recurring hunt: `Scan(optional) → Click → Wait` around the whole
thing, looping until you press Stop.

## Browser commands

The **Browser** step performs browser-wide shortcuts. They are done with the real APIs rather than
synthetic key events, because Chrome ignores untrusted events for its own shortcuts:

| Command | Shortcut |
|---|---|
| New tab | `Ctrl+T` (optional URL + activate) |
| Close tab | `Ctrl+W` |
| Reopen closed tab | `Ctrl+Shift+T` |
| Next tab / Previous tab | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Duplicate tab | — |
| Reload / Hard reload | `Ctrl+R` / `Ctrl+Shift+R` |
| Back / Forward | `Alt+Left` / `Alt+Right` |
| New window / Close window | `Ctrl+N` / `Ctrl+Shift+W` |

Tab-creating and tab-moving commands move the run with them, so a following step acts on the new
tab (or the surviving one after a close). Closing the last tab or window stops the macro with a
clear error rather than failing silently.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Alt+Shift+M` | Open the macro builder (side panel) |
| `Alt+Shift+R` | Run the selected macro |
| `Alt+Shift+E` | Pick an element (click) for the selected macro |

Shortcuts are rebindable at `chrome://extensions/shortcuts`.

## Project layout

```
manifest.json              MV3 manifest
background/service-worker.js   routing, storage, run engine, shortcuts
content/agent.js           on-demand injected: picker + step executor
content/agent.css          picker overlay styles
sidepanel/                 macro/step builder UI
```

## How running works

The background worker drives the sequence on the active tab: `wait` sleeps, `navigate` updates
the tab and waits for load, and every other step is sent to the page's content agent, which
resolves the target, scrolls it into view, and dispatches the action. Runs stop on the first
failing step; the page can be navigated mid-macro and the agent re-injects itself automatically.

## Notes & limits

- Pages like `chrome://`, the Chrome Web Store, and other extension pages cannot be scripted.
- Macros run on the tab that is active when you press Run.
- A macro that navigates needs its later steps' selectors to exist on the destination page.
