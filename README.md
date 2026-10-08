# Clicker — Macrobat

Build custom macros that automate repetitive tasks in the browser. Pick the elements you want
to act on directly on the page, chain them into steps, and replay the macro on demand.

Element picking reuses the `document.elementsFromPoint` hit-test logic from
[screenshot-tuif](https://github.com/ghiffarsabda/screenshot-tuif) — the same "which element is
under the cursor" approach — and turns it into durable selectors that survive reloads.

## Features

- **Visual step builder** — no scripting. Click `Click` / `Type` / `Key`, then pick the target
  element on the page. Reorder steps with the `↑` / `↓` buttons or by **dragging a step card up or
  down** (drag from the step's header — its name and fields stay selectable). Dragging works inside
  the current list, so a step nested in an If or Gamble branch reorders within that branch.
- **Text-independent targeting** — an element is identified by its *structure*, not its label:
  `id` → `data-testid`/`data-*` → `aria-label` → `role`/`type`/`name`/`placeholder` → class
  signature → structural position. A button whose text rotates (`"do this"` → `"do that"`) keeps
  matching as long as the element is there. Text matching is opt-in per step (`also match by
  text`), and if every selector goes stale the player hunts the page for the closest structural
  lookalike — refusing tag-only or ambiguous matches rather than clicking the wrong element.
- **Step types** — `Click`, `Type` (React/Vue-safe native value set), `Key press`, `Hover` (move
  onto an element and hold), `Scan` (wait for an element), `If` (branches), `Gamble` (chance-based
  gate), `Wait for change`, `Wait` (fixed, random range, or until the page loads), `Scroll`
  (human-like), `Go to URL` (navigates in place), `Open tab`, `Switch tab`, `Browser` (browser-wide
  shortcuts).
- **Multi-tab** — a step that opens a tab (a click that redirects, `window.open`, or an `Open tab`
  step) moves the rest of the macro onto that new tab, so you can click on site A and continue
  scrolling on site B.
- **Manual run + shortcuts** — start a macro from the panel or a keyboard shortcut.
- **Auto mode** — bind a macro to a URL pattern and it runs by itself whenever a matching page
  finishes loading. No clicking Run.
- **Loop mode** — repeat a macro `N` times, or endlessly until you press Stop, with a delay
  between passes. A pass that hits a failing step is abandoned and the next pass starts again from
  step 1, so a hunting loop keeps going instead of stopping. Macros with it on show a `↻` in the
  list.
- **Collapsible side panel** — `Add step`, `Toolbar`, and the `Activity` log fold away. The
  `Toolbar` is itself an accordion holding `Auto mode`, `Loop mode` and `Follow new tabs`, so those
  three collapse into one. Every header shows a live summary while folded
  (`auto off · loop off · tabs on`, `on · example.com`, `4 steps`), the settings sit below the step
  list so the steps keep the room, and your open/closed state is remembered.
- **Name any step** — every step has a `Name` field. Type one and it becomes the step's title in
  the list; the action it performs stays visible underneath, so `refill the cart` still reads as
  `Click`. Leave it blank and the step keeps its plain action name. Names are cosmetic — they are
  kept in exports too.
- **Gamble** — a step that rolls the dice. Give it a chance and the steps you put inside it only
  run that often; the rest of the macro carries on either way. See below.
- **Export / import** — the `Backup` panel saves every macro (with its settings and nested steps)
  to a dated JSON file, and imports one back — either **replacing** everything or **merging** into
  what you already have.
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

Stop is honoured mid-pass and mid-wait. If a step fails, that pass ends there and the loop goes
straight to the next one, starting again from step 1 — so a `Scan → Click` pair that sometimes
finds no button simply keeps looking. The run ends when the loop count is reached or you press
**Stop**. Every loop iteration is anchored to the initial tab where the run started: if previous
steps followed or opened other tabs, the run returns to the start tab for the next pass, closed
secondary tabs auto-recover back to the start tab without throwing "tab not found" crashes, and
a closed secondary tab does not stall the loop. The background worker is held awake for the whole
run (self-ping, page/panel heartbeats, and an alarm backstop), and if Chrome ever evicts it anyway
the run is resumed on its start tab. Combine with **Auto mode** for continuous background automation
on a matching page —
keep the panel open so the activity log and Stop are at hand.

## Hover step

The **Hover** step moves the pointer onto a picked element and holds it there for **Hold** seconds
(default 1 s) before carrying on — for menus, submenus and tooltips that only appear on hover.

- **Hold** — how long to stay on the element, in seconds. `0` just fires the hover and moves on.
- Pick the element to hover the same way as a click (structure-based targeting and the
  `also match by text` toggle both apply).

It dispatches `pointerover`/`pointerenter`, `mouseover`/`mouseenter` and `mousemove` on the
element, which is what JavaScript menus listen for. Pure CSS `:hover` styling does **not** trigger,
because a page cannot be told where the real cursor is. The hover is left in place afterwards (no
mouse-out is sent), so a revealed menu stays open for the next step, and **Stop** cuts the hold
short.

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
  Newest/previous look across **all windows**, and if the newest tab is already the one you're on,
  the step simply stays put instead of failing.

Turn **Follow new tabs** off if you want every step pinned to the starting tab. Tabs that can't be
scripted (`chrome://`, the Web Store, other extensions) are never adopted.

Two things to know when a tab doesn't move the run:

- A synthetic click carries **no user activation**, so a page's own `window.open()` is blocked by the
  popup blocker and no window/tab appears. The extension records the URL the link asked for (even
  when it's a JS `window.open` on a button, via a hook in the page's own world) and opens it itself
  in a **new tab** — logged as *"Opened … in a new tab (the page's own popup was blocked)"*. It never
  hijacks the page you're on to do it, so a following **Switch tab → Newest** finds it.
- The activity log prints **"Tab → host"** whenever the run moves, so you can see which tab each
  step actually ran on.

## Wait step

The **Wait** step pauses the macro, in one of three modes:

- **Fixed** — pause exactly `Sec` seconds.
- **Random range** — pause a random time between `Min` and `Max` seconds (uniform), so the timing
  isn't a constant, machine-like delay. The chosen value is written to the activity log
  (`Waited 0.812s (random 0.5s–1.5s)`).
- **Page load** — wait until the page is fully loaded and settles: the `load` event has fired **and**
  no resource has finished loading for **Quiet** seconds (default `0.5 s`), so slow images, fonts
  and late XHRs are all in before the next step. **Timeout** (default `30 s`; `0` = forever) gives
  up — or, with **optional** ticked, continues anyway. Long-lived connections like websockets are not
  resource entries, so they don't hold it up. Handy right after a step that navigates.

Either order works for Min/Max (they're sorted); Min alone is a fixed pause, Max alone spans
`0…Max`. A long wait can be interrupted with **Stop**.

> **Units**: every number field shows its unit right next to the value — `s` for seconds,
> `px` for scroll distance, `×` for loop count (e.g. `5 s`, `600 px`, `3 ×`). Times are edited in
> **seconds** (decimals allowed, e.g. `0.25`) and stored internally in milliseconds, so existing
> macros keep working.

## Waiting for the page to change

For loops that should not re-run until the page actually moves on:

- **Wait for change** step — polls until something changes, then continues.
  - `Watch`: **Page URL** or **Element text** (pick an element; its text is compared).
  - **since last loop** (URL only) — the baseline is the URL remembered from the *previous loop
    iteration*, so this is exactly *"if the URL is still the same as last time, wait until it
    changes"*. Unticked, the baseline is the URL when the step starts.
  - `Timeout` (default 20s) and `Every` (poll interval, default 0.3s). **`0` means wait forever**
    (until Stop). `optional` continues instead of erroring.
- **If → URL changed** condition — true when the URL differs from the previous loop iteration
  (the first pass counts as changed, so it always proceeds). Use it to guard a whole branch.

Loop memory is per-run and only filled at the **end** of each iteration, so the first pass has
nothing to compare against.

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

An If's branches can also adopt steps that already sit below the If, the same way a Gamble does —
see *Reuse steps that are already there* above.

## Gamble (chance)

A **Gamble** step flips a weighted coin and only runs the steps you put inside it when the coin
lands your way — so a macro can sometimes do nothing at all, and sometimes do the work. Put every
step of a macro inside a Gamble and the whole run is a chance.

- **Chance** is a percentage (`0`–`100`). `30` means the steps inside run about 3 times in 10.
  `100` always runs them, `0` never does, and a step added fresh starts at `50`.
- Its two branches are **Succeeds** (the coin landed your way) and **Fails** (it didn't). Anything
  can go in either, including more Gambles, Ifs and other steps — nesting works to any depth.
- **Leave Fails empty** for a plain "maybe skip this" gate: those steps simply don't happen and the
  macro continues with the next step. Fill it in to have something else happen instead.
- **Reuse steps that are already there.** Open a branch's `+ add step` menu and, under
  *or move one from below*, every step sitting below the Gamble is listed — click one (or
  **move all N**) to move it inside instead of picking the element all over again. The step keeps its
  target, and nothing is duplicated: it simply moves into the branch.
- **Only the steps inside are affected.** Everything before and after a Gamble always runs, so you
  can gate one fragile part of a macro rather than the whole thing.
- The roll is **fresh every time the step is reached**, so in **Loop mode** each pass gambles
  again — 30% over 10 loops is roughly 3 runs.

The activity log reports each roll with its odds: `✓ gamble won — 30%` or `✗ gamble lost — 30%`.

## Elements that come and go (whack-a-mole)

Some buttons aren't on the page when the macro arrives. Two ways to wait for them — both check
immediately, then keep re-checking:

- **Scan step** — poll for a picked element until it appears. `Timeout` (seconds, default 10s;
  **`0` = forever**) and `Every` (poll interval, default 0.25s). It errors if the element never
  shows up, unless **optional** is ticked, in which case the run continues (handy inside a loop
  that keeps hunting).
- **`Scan`** on a `Click` / `Type` / `Key` step — that step retries *its own* element for the
  given seconds before failing. `0` (the default) still retries briefly (~1.5s) so a momentary miss
  doesn't fail the pass.

Resolution stays strict: when several elements match, it acts only if the recorded role/label — or a
single enabled candidate among otherwise-identical controls — isolates one, and otherwise refuses
rather than click the wrong control. The reason for a refusal is written to the activity log.

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

## Backup: export / import

The **Backup** panel moves your macros between machines or keeps a copy safe.

- **Export** downloads `clicker-macros-YYYY-MM-DD_HHMM.json` containing every macro — steps,
  branches, and per-macro settings (auto, loop, follow-tabs, delays).
- **Import** reads such a file (or a bare array of macros, or a single macro) and asks what to do:
  **replace all** or **merge** them in alongside your existing macros. Merging re-mints any
  colliding macro ids, so nothing is overwritten. `cancel` abandons the import, and a malformed
  file is rejected without touching your macros.

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
