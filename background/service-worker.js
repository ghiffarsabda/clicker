/**
 * Clicker — background service worker.
 * Routes picker/run requests, owns the run engine, and keeps storage in sync.
 */

const RESTRICTED = /^(chrome|edge|about|chrome-extension|devtools|view-source|data):/i;
const RESTRICTED_HOST = /^https:\/\/chromewebstore\.google\.com/i;

// How long to wait for a new tab the page opened itself to be announced, after a
// click that landed on a link: one that targets a new context gets a real grace,
// a same-context link just enough to catch a fast window.open(). Both end early
// the moment the tab shows up. Ordinary (non-link) clicks don't wait at all — see
// runSteps — so a stray tab the page opens on its own can't be adopted.
const NEW_TAB_GRACE = 1200;
const CLICK_GRACE = 200;
// How long to wait for a followed tab to finish loading before moving on — the next
// step must run on the new page, and pages take longer than the appearance grace.
const NEW_TAB_READY = 10000;
// A tab that still isn't a real page after this long is abandoned, so a broken popup
// can't stall the run forever.
const NEW_TAB_GIVEUP = 15000;

let activeRun = null; // { cancelled, tabId, macroId }

/* ---------------------------------------------------------------- *
 *  Keep-alive                                                      *
 * ---------------------------------------------------------------- *
 * Chrome tears an idle MV3 worker down after ~30s without events, which a long
 * run (or a long Wait/waitChange) blows straight past. A run is held open by:
 *   - a self-ping under 30s, so the worker never goes idle while a run is active;
 *   - a chrome.alarms backstop that survives eviction and wakes the worker;
 *   - heartbeats from the content agent and the side panel (content/agent.js,
 *     sidepanel/sidepanel.js) so another live context can wake it too;
 *   - a persisted run descriptor, so a worker that IS evicted resumes its run
 *     instead of dying silently and leaving the panel stuck on "running".
 * Every path is idempotent and swallows its own errors, so keeping the worker
 * alive can never itself break a run.
 */
const KEEPALIVE_ALARM = 'clicker-keepalive';
const KEEPALIVE_PERIOD_MIN = 0.5; // 30s; Chrome <120 clamps to 1 min — backstop only
const KEEPALIVE_PING_MS = 20000; // comfortably inside Chrome's ~30s idle window
const RUN_STATE_KEY = 'runState'; // session storage, survives a worker restart

let keepAliveTimer = null;
let recovering = false; // guards the worker-start and alarm recovery paths against racing
let stopRequested = false; // a Stop that must survive a worker restart long enough to cancel a persisted run

/** Touching an extension API resets Chrome's idle-shutdown timer. */
function keepAlivePing() {
  try {
    chrome.runtime.getPlatformInfo().catch(() => {});
  } catch (_) {}
}

function startKeepAlive() {
  keepAlivePing();
  try {
    chrome.alarms.create(KEEPALIVE_ALARM, {
      delayInMinutes: KEEPALIVE_PERIOD_MIN,
      periodInMinutes: KEEPALIVE_PERIOD_MIN
    });
  } catch (_) {}
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    if (activeRun) keepAlivePing();
    else stopKeepAlive(); // run ended underneath us — stop pinging
  }, KEEPALIVE_PING_MS);
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
  try {
    chrome.alarms.clear(KEEPALIVE_ALARM);
  } catch (_) {}
}

async function persistRunState() {
  if (!activeRun) return;
  try {
    await chrome.storage.session.set({
      [RUN_STATE_KEY]: {
        macroId: activeRun.macroId,
        name: activeRun.name,
        auto: !!activeRun.auto,
        tabId: activeRun.tabId,
        startTabId: activeRun.startTabId,
        iteration: activeRun.iteration || 0,
        startedAt: activeRun.startedAt
      }
    });
  } catch (_) {}
}

async function clearRunState() {
  try {
    await chrome.storage.session.remove(RUN_STATE_KEY);
  } catch (_) {}
}

async function getRunState() {
  try {
    const stored = await chrome.storage.session.get(RUN_STATE_KEY);
    return stored[RUN_STATE_KEY] || null;
  } catch (_) {
    return null;
  }
}

/**
 * A run was persisted but the worker has no live run: it was evicted mid-run.
 * Pick the loop back up from the next pass. Loops already restart from step 1
 * each pass, and the old pass died with the worker, so this can't double-run.
 */
async function recoverRun() {
  if (activeRun || recovering || stopRequested) return false; // one recovery at a time
  recovering = true;
  try {
    const state = await getRunState();
    // A Stop that woke the worker can land while we were reading — honour it.
    if (!state || !state.macroId || stopRequested) return false;

    const anchor = state.startTabId != null ? state.startTabId : state.tabId;
    const tab = anchor != null ? await chrome.tabs.get(anchor).catch(() => null) : null;
    if (!tab || isRestricted(tab)) {
      await clearRunState(); // nothing left to run on — don't wedge on a ghost run
      return false;
    }

    emit({ type: 'NOTE', text: `Worker restarted — resuming "${state.name || 'macro'}".` });
    runMacro(state.macroId, {
      tabId: anchor,
      auto: !!state.auto,
      resumeFrom: Number(state.iteration) || 0
    });
    return true;
  } finally {
    recovering = false;
  }
}

/* ---------------------------------------------------------------- *
 *  Lifecycle                                                       *
 * ---------------------------------------------------------------- */

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  const { macros } = await chrome.storage.local.get('macros');
  if (!Array.isArray(macros)) await chrome.storage.local.set({ macros: [] });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// The keepalive alarm fires even after the worker was evicted: keep pinging if a
// run is live, otherwise pick a persisted run back up.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm || alarm.name !== KEEPALIVE_ALARM) return;
  if (activeRun) keepAlivePing();
  else recoverRun();
});

/* ---------------------------------------------------------------- *
 *  Helpers                                                         *
 * ---------------------------------------------------------------- */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sleep that bails out early when the run is stopped, so Stop feels instant. */
async function cancellableSleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!activeRun || activeRun.cancelled) return;
    await sleep(Math.min(150, Math.max(1, end - Date.now())));
  }
}

function emit(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function currentUrl(tabId) {
  return chrome.tabs
    .get(tabId)
    .then((t) => t.url || '')
    .catch(() => '');
}

/**
 * Timeouts are user-facing: an explicit 0 means "no timeout / wait forever",
 * while missing or blank falls back to the default. (A plain `|| default` would
 * wrongly turn 0 into the default.)
 */
function timeoutValue(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  return Math.max(0, Number(raw) || 0);
}

/**
 * How long a Wait step should actually pause. In "range" mode the duration is
 * picked at random between min and max (either order — they're sorted), so the
 * wait isn't a constant, machine-like delay.
 */
function waitDuration(step) {
  if (step.mode === 'range') {
    const lo0 = Math.max(0, Number(step.min) || 0);
    const hasMax = step.max !== undefined && step.max !== null && step.max !== '';
    const hi0 = hasMax ? Math.max(0, Number(step.max) || 0) : lo0;
    const lo = Math.min(lo0, hi0);
    const hi = Math.max(lo0, hi0);
    return lo + Math.random() * (hi - lo);
  }
  return Math.max(0, Number(step.ms) || 0);
}

/** Format a duration (ms) for humans, in seconds. */
function secs(ms) {
  return `${Math.round(((Number(ms) || 0) / 1000) * 1000) / 1000}s`;
}

function rangeLabel(step) {
  const a = Math.max(0, Number(step.min) || 0);
  const b = Math.max(0, Number(step.max) || 0);
  return `${secs(Math.min(a, b))}\u2013${secs(Math.max(a, b))}`;
}

function isRestricted(tab) {
  if (!tab || !tab.url) return true;
  return RESTRICTED.test(tab.url) || RESTRICTED_HOST.test(tab.url);
}

/** Make sure the content agent is present in the tab. */
async function ensureAgent(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (res && res.ok) return;
  } catch (_) {}

  await chrome.scripting
    .insertCSS({ target: { tabId }, files: ['content/agent.css'] })
    .catch(() => {});
  await chrome.scripting
    .executeScript({ target: { tabId }, files: ['content/agent.js'] })
    .catch(() => {});
}

/**
 * Poll until the tab finished loading away from `previousUrl`, so a fast load
 * (or a redirect) can't be mistaken for the page we were already on.
 */
function waitForTabComplete(tabId, previousUrl = '', timeout = 25000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = async () => {
      let tab = null;
      try {
        tab = await chrome.tabs.get(tabId);
      } catch (_) {}
      if (tab && tab.status === 'complete' && tab.url && tab.url !== previousUrl) return resolve();
      if (Date.now() - started > timeout) return reject(new Error('Navigation timed out'));
      setTimeout(tick, 250);
    };
    setTimeout(tick, 300);
  });
}

/**
 * Wait until the page is fully loaded and quiet: the `load` event has fired and
 * no resource has finished loading for the settle window ("Quiet"). Late images,
 * fonts and XHRs are covered; long-lived connections (websockets, streams) are
 * not resource entries, so they don't hold it up. The page is polled rather than
 * the content agent blocking, so Stop stays responsive and a mid-wait reload
 * (which drops the agent) is handled by re-injecting it.
 */
async function waitForPageLoad(tabId, step) {
  const timeout = timeoutValue(step.timeout, 30000);
  const settle =
    step.settle === undefined || step.settle === null || step.settle === ''
      ? 500
      : Math.max(0, Number(step.settle) || 0);
  const every = Math.max(100, Number(step.interval) || 250);
  const started = Date.now();

  for (;;) {
    if (!activeRun || activeRun.cancelled) throw new Error('Stopped by user');

    let state = null;
    try {
      state = await chrome.tabs.sendMessage(tabId, { type: 'PAGE_LOAD_STATE' });
    } catch (_) {
      // Probably mid-navigation — make sure the agent is there for the next poll.
      await ensureAgent(tabId).catch(() => {});
    }
    if (state && state.ok && state.complete && state.idleMs >= settle) return;

    if (timeout > 0 && Date.now() - started > timeout) {
      if (step.optional) return;
      throw new Error(`Page did not finish loading within ${secs(timeout)}`);
    }
    await cancellableSleep(every);
  }
}

/* ---------------------------------------------------------------- *
 *  Picking                                                         *
 * ---------------------------------------------------------------- */

async function armPicker(mode) {
  const tab = await getActiveTab();
  if (isRestricted(tab)) {
    emit({ type: 'PICK_STATUS', state: 'error', error: 'Cannot pick on this page' });
    return;
  }
  try {
    await ensureAgent(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: 'ARM_PICKER', mode });
    emit({ type: 'PICK_STATUS', state: 'armed', mode });
  } catch (e) {
    emit({ type: 'PICK_STATUS', state: 'error', error: String((e && e.message) || e) });
  }
}

async function cancelPicker() {
  const tab = await getActiveTab();
  if (tab && tab.id) await chrome.tabs.sendMessage(tab.id, { type: 'CANCEL_PICKER' }).catch(() => {});
}

/* ---------------------------------------------------------------- *
 *  Run engine                                                      *
 * ---------------------------------------------------------------- */

async function runMacro(macroId, opts = {}) {
  stopRequested = false; // a fresh run clears a previous Stop
  if (activeRun) {
    // Recover from a wedged run (its tab is gone) instead of refusing forever.
    const alive = await chrome.tabs.get(activeRun.tabId).catch(() => null);
    if (alive) {
      if (!opts.auto) emit({ type: 'RUN_STATUS', state: 'error', error: 'A macro is already running' });
      return;
    }
    activeRun = null;
  }

  const { macros = [] } = await chrome.storage.local.get('macros');
  const macro = macros.find((m) => m.id === macroId);
  if (!macro) {
    emit({ type: 'RUN_STATUS', state: 'error', error: 'Macro not found' });
    return;
  }
  if (!macro.steps || macro.steps.length === 0) {
    emit({ type: 'RUN_STATUS', state: 'error', error: 'Macro has no steps' });
    return;
  }

  const tab = opts.tabId
    ? await chrome.tabs.get(opts.tabId).catch(() => null)
    : await getActiveTab();
  if (isRestricted(tab)) {
    emit({ type: 'RUN_STATUS', state: 'error', error: 'Cannot run on this page' });
    return;
  }

  activeRun = {
    cancelled: false,
    tabId: tab.id,
    startTabId: tab.id, // the tab the run/loop began on — what "ThisURL" means
    windowId: tab.windowId,
    macroId: macro.id,
    name: macro.name,
    auto: !!opts.auto,
    history: [tab.id],
    follow: macro.followTabs !== false,
    blockFollow: false,
    startedAt: Date.now(),
    stepStartedAt: Date.now(),
    tabUrl: tab.url || '',
    thisURL: tab.url || '', // the "ThisURL" token: the page the run started on
    loopMemory: {}
  };

  // Make ThisURL concrete: it is always the page this run started on.
  if (JSON.stringify(macro.steps || []).includes('ThisURL')) {
    emit({ type: 'NOTE', text: `ThisURL = ${tab.url || '(unknown)'}` });
  }

  // Loop mode: repeat the whole step list `loopCount` times (0 = until stopped).
  const looping = !!macro.loop;
  const limit = looping ? (Number(macro.loopCount) > 0 ? Number(macro.loopCount) : Infinity) : 1;
  const interval = Math.max(0, Number(macro.loopInterval) || 0);
  const totalLabel = limit === Infinity ? null : limit;

  emit({ type: 'RUN_STATUS', state: 'running', macroId: macro.id, name: macro.name, auto: !!opts.auto, loop: looping });

  // Hold the worker awake for the whole run and record it, so an eviction can resume.
  startKeepAlive();
  await persistRunState();

  try {
    await ensureAgent(tab.id);

    // loopMemory.url is only filled at the END of each iteration, so the first
    // pass has no "previous loop" to compare against (and proceeds unchanged).
    activeRun.looping = looping;

    // In loop mode a failing step ends that pass instead of aborting the macro —
    // the next pass starts again from step 1 (e.g. a Scan missed and the Click
    // after it had no button to hit yet). Stop still wins.
    let failedPasses = 0;

    // Resuming after an eviction picks up at the next pass; a loop always starts a
    // pass from step 1, so nothing already half-done is repeated.
    const startAt = Math.max(1, (Number(opts.resumeFrom) || 0) + 1);
    for (let iteration = startAt; iteration <= limit; iteration++) {
      if (!activeRun || activeRun.cancelled) throw new Error('Stopped by user');

      // The tab where the run started is the home base for every loop pass
      const startTab = activeRun.startTabId
        ? await chrome.tabs.get(activeRun.startTabId).catch(() => null)
        : null;
      if (!startTab) {
        throw new Error('The start tab was closed — run stopped.');
      }

      // If a previous pass followed another tab, return to the start tab for the new pass
      if (activeRun.tabId !== activeRun.startTabId) {
        adoptTab(activeRun.startTabId, { reason: 'switch', tab: startTab });
        await chrome.tabs.update(activeRun.startTabId, { active: true }).catch(() => {});
        await ensureAgent(activeRun.startTabId).catch(() => {});
      }

      if (looping) emit({ type: 'RUN_LOOP', iteration, total: totalLabel });
      activeRun.iteration = iteration;
      activeRun.loopTotal = totalLabel;
      // Awaited so a slow write can't land after the finally clears it, which would
      // leave a ghost run that resumes after the user pressed Stop.
      await persistRunState();

      try {
        await runSteps(macro.steps, 0);
      } catch (e) {
        const error = String((e && e.message) || e);
        if (!looping || !activeRun || activeRun.cancelled || /Stopped by user/.test(error)) throw e;
        // If the start tab itself is gone, retrying can never succeed
        const startTabAlive = activeRun.startTabId
          ? await chrome.tabs.get(activeRun.startTabId).catch(() => null)
          : null;
        if (!startTabAlive) {
          throw new Error('The start tab was closed — run stopped.');
        }
        failedPasses++;
        emit({ type: 'RUN_LOOP_ERROR', error, iteration, total: totalLabel });
      }

      activeRun.loopMemory.url = await currentUrl(activeRun.startTabId || activeRun.tabId);

      // Return to start tab before interval pause so the page is ready for the next pass
      if (iteration < limit) {
        const currentStartTab = activeRun.startTabId
          ? await chrome.tabs.get(activeRun.startTabId).catch(() => null)
          : null;
        if (currentStartTab && activeRun.tabId !== activeRun.startTabId) {
          adoptTab(activeRun.startTabId, { reason: 'switch', tab: currentStartTab });
          await chrome.tabs.update(activeRun.startTabId, { active: true }).catch(() => {});
          await ensureAgent(activeRun.startTabId).catch(() => {});
        }
        if (interval > 0) await cancellableSleep(interval);
      }
    }

    emit({
      type: 'RUN_STATUS',
      state: 'done',
      name: macro.name,
      auto: !!opts.auto,
      loops: looping ? (limit === Infinity ? '∞' : limit) : 1,
      failed: failedPasses
    });
  } catch (e) {
    const error = String((e && e.message) || e);
    emit({ type: 'RUN_STATUS', state: 'error', error, cancelled: /Stopped by user/.test(error), auto: !!opts.auto });
  } finally {
    stopKeepAlive();
    const runTabId = activeRun && activeRun.tabId;
    activeRun = null;
    await clearRunState();
    // Remember where the run ended — for manual runs too — so its own navigation
    // or a refresh can't retrigger auto mode on the page it landed on.
    if (runTabId) {
      const t = await chrome.tabs.get(runTabId).catch(() => null);
      if (t && t.url) await setAutoRun(runTabId, `${macro.id}::${t.url}`);
    }
  }
}

/**
 * Run a list of steps. If steps nest (an If step holds then/else branches),
 * this recurses into whichever branch the condition selects.
 */
async function runSteps(steps, depth) {
  for (let i = 0; i < steps.length; i++) {
    if (!activeRun || activeRun.cancelled) throw new Error('Stopped by user');
    const step = steps[i];

    // A previous step may have opened a tab after a delay — move onto it first,
    // unless we just deliberately moved to a tab (a switch/open) and owe it a step.
    if (activeRun.follow && !activeRun.blockFollow) await maybeFollowNewTab();
    activeRun.blockFollow = false;

    emit({
      type: 'RUN_PROGRESS',
      index: i,
      total: steps.length,
      depth: depth || 0,
      action: step.action,
      command: step.action === 'browser' ? step.command : undefined,
      label: step.label || (step.target && (step.target.label || step.target.selector)) || '',
      url: activeRun.tabUrl,
      iteration: activeRun.looping ? activeRun.iteration : null,
      iterations: activeRun.loopTotal
    });

    activeRun.stepStartedAt = Date.now();
    const res = await runStep(step, depth || 0);

    // Catch a tab this step just opened, so the following step can use it. Only a
    // click that landed on a link can be expected to open a tab — waiting after an
    // ordinary click lets a stray tab the page opens on its own (a popup/ad) be
    // adopted instead of the page we're on. A link that targets a new context gets
    // the longer grace, so its fallback doesn't race the page and open a duplicate.
    const opensTab = step.action === 'click' && res && res.link;
    const grace = !opensTab ? 0 : expectNewTab(step, res) ? NEW_TAB_GRACE : CLICK_GRACE;
    const adopted = activeRun.follow && !activeRun.blockFollow ? await maybeFollowNewTab(grace) : null;
    if (step.action === 'click' && activeRun.follow && !adopted && res && res.link) {
      await openLinkFallback(res.link, res.urlBefore);
    }
  }
}

/** Short human description of an If condition, for the activity log. */
function conditionLabel(condition) {
  const c = condition || {};
  const neg = c.negate ? 'not ' : '';
  const target = (c.target && (c.target.label || c.target.selector)) || 'element';
  if (c.type === 'url') return `${neg}url matches ${c.pattern || '*'}`;
  if (c.type === 'text') return `${neg}${target} text ${c.op || 'contains'} "${c.value || ''}"`;
  if (c.type === 'attr') return `${neg}${target} ${c.attr || 'href'} ${c.op || 'is'} "${c.value || ''}"`;
  return `${neg}${target} is ${c.state || 'visible'}`;
}

/** Success chance (%) of a Gamble step: 0 never runs, 100 always, unset means 50. */
function gambleChance(step) {
  const n = Number(step && step.chance);
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(100, n));
}

/** Evaluate an If condition. URL checks run here; DOM checks run in the page. */
async function evaluateCondition(condition, tabId) {
  if (!condition) return true;

  let raw;
  if (condition.type === 'url') {
    raw = urlMatches(condition.pattern || '', await currentUrl(tabId));
  } else if (condition.type === 'urlChanged') {
    // Compares against the URL remembered from the previous loop iteration.
    const prev = activeRun && activeRun.loopMemory ? activeRun.loopMemory.url : null;
    raw = prev == null ? true : (await currentUrl(tabId)) !== prev;
  } else {
    let res;
    try {
      res = await chrome.tabs.sendMessage(tabId, { type: 'EVALUATE_CONDITION', condition });
    } catch (e) {
      throw new Error('Could not evaluate the condition — the page is unreachable');
    }
    if (!res || !res.ok) throw new Error((res && res.error) || 'Could not evaluate the condition');
    raw = !!res.result;
  }

  return condition.negate ? !raw : raw;
}

async function runStep(step, depth) {
  let tabId = activeRun && activeRun.tabId;
  if (!tabId) throw new Error('No active tab');

  // Verify the tab is alive. If a secondary/followed tab vanished, self-heal back to the start tab
  const alive = await chrome.tabs.get(tabId).catch(() => null);
  if (!alive) {
    const startTab = activeRun.startTabId ? await chrome.tabs.get(activeRun.startTabId).catch(() => null) : null;
    if (startTab) {
      adoptTab(activeRun.startTabId, { reason: 'switch', tab: startTab });
      await chrome.tabs.update(activeRun.startTabId, { active: true }).catch(() => {});
      await ensureAgent(activeRun.startTabId).catch(() => {});
      tabId = activeRun.startTabId;
    } else {
      throw new Error('The tab was closed — run stopped.');
    }
  }

  if (step.action === 'if') {
    const ok = await evaluateCondition(step.condition, tabId);
    emit({ type: 'BRANCH', result: ok, label: conditionLabel(step.condition) });
    await runSteps(ok ? step.then || [] : step.else || [], (depth || 0) + 1);
    return;
  }

  if (step.action === 'gamble') {
    // Rolled fresh every time the step is reached, so a loop gambles each pass.
    const chance = gambleChance(step);
    const won = Math.random() * 100 < chance;
    emit({ type: 'GAMBLE', result: won, chance });
    await runSteps(won ? step.then || [] : step.else || [], (depth || 0) + 1);
    return;
  }

  if (step.action === 'wait') {
    if (step.mode === 'load') {
      await waitForPageLoad(tabId, step);
      return;
    }
    const ms = waitDuration(step);
    if (step.mode === 'range') emit({ type: 'NOTE', text: `Waited ${secs(ms)} (random ${rangeLabel(step)})` });
    await cancellableSleep(ms); // Stop works during a (possibly long) wait
    return;
  }

  if (step.action === 'navigate') {
    const url = withThisURL(step.url);
    if (!url) throw new Error('Navigate step has no URL');
    const before = await chrome.tabs
      .get(tabId)
      .then((t) => t.url || '')
      .catch(() => '');
    await chrome.tabs.update(tabId, { url });
    await waitForTabComplete(tabId, before);
    await sleep(250);
    await ensureAgent(tabId);
    activeRun.tabUrl = await currentUrl(tabId);
    return;
  }

  if (step.action === 'openTab') {
    const url = withThisURL(step.url);
    if (!url) throw new Error('Open tab step has no URL');
    const created = await chrome.tabs.create({ url, active: step.activate !== false });
    const loaded = await waitForNewTabUrl(created.id);
    await ensureAgent(created.id);
    adoptTab(created.id, { reason: 'open', tab: loaded });
    return;
  }

  if (step.action === 'switchTab') {
    const target = await resolveSwitchTarget(step);
    if (!target) {
      // "Switch to ThisURL" when that page no longer has a tab (the start tab was
      // navigated away or closed): go back there by navigating instead of aborting
      // the pass with "no matching tab".
      if (String(step.url || '').includes('ThisURL') && step.urlOp !== 'isnot' && activeRun.thisURL) {
        emit({ type: 'NOTE', text: 'Returned to ThisURL (no tab had it open — loaded it).' });
        const before = await currentUrl(tabId);
        await chrome.tabs.update(tabId, { url: activeRun.thisURL });
        await waitForTabComplete(tabId, before).catch(() => {});
        await sleep(250);
        await ensureAgent(tabId);
        activeRun.tabUrl = await currentUrl(tabId);
        return;
      }
      throw new Error('No matching tab to switch to');
    }
    if (step.activate !== false) await chrome.tabs.update(target.id, { active: true }).catch(() => {});
    adoptTab(target.id, { reason: 'switch', tab: target });
    await ensureAgent(target.id);
    return;
  }

  if (step.action === 'waitChange') {
    await runWaitChange(step, tabId);
    return;
  }

  if (step.action === 'browser') {
    await runBrowserCommand(step);
    return;
  }

  await ensureAgent(tabId);

  const urlBefore =
    step.action === 'click'
      ? await chrome.tabs
          .get(tabId)
          .then((t) => t.url || '')
          .catch(() => '')
      : '';

  let res;
  try {
    res = await chrome.tabs.sendMessage(tabId, { type: 'EXECUTE_STEP', step });
  } catch (e) {
    throw new Error('Could not reach the page — it may have navigated, closed, or reloaded');
  }
  if (!res || !res.ok) throw new Error((res && res.error) || `Step failed: ${step.action}`);
  return Object.assign({}, res, { urlBefore });
}

/**
 * A synthetic click carries no user activation, so a page's own window.open()
 * can be blocked by the popup blocker and no tab ever appears. If the click was
 * on a link and nothing happened, open it ourselves — that is what makes
 * "click on site A, continue on site B" reliable.
 */
async function openLinkFallback(link, urlBefore) {
  const current = await chrome.tabs.get(activeRun.tabId).catch(() => null);
  if (!current) return;
  if (urlBefore && current.url !== urlBefore) return; // the page navigated on its own
  if (current.status === 'loading') return; // a navigation is already under way

  emit({ type: 'NOTE', text: `Opened ${link.href} directly (the page's own popup was blocked)` });

  if (link.target === '_blank') {
    const created = await chrome.tabs.create({ url: link.href, active: true });
    const loaded = await waitForNewTabUrl(created.id).catch(() => null);
    await ensureAgent(created.id).catch(() => {});
    adoptTab(created.id, { reason: 'open', tab: loaded || created });
    return;
  }

  await chrome.tabs.update(activeRun.tabId, { url: link.href }).catch(() => {});
  await waitForTabComplete(activeRun.tabId, urlBefore || '');
  await sleep(250);
  await ensureAgent(activeRun.tabId);
  activeRun.tabUrl = await currentUrl(activeRun.tabId);
}

function stopRun() {
  // Stop must also cancel a run that was evicted and now exists only as persisted
  // state — otherwise waking the worker to press Stop would resume it instead.
  stopRequested = true;
  stopKeepAlive();
  clearRunState();
  if (!activeRun) return;
  activeRun.cancelled = true;
  // Interrupt a long step in progress (e.g. a human-like scroll) right away.
  chrome.tabs.sendMessage(activeRun.tabId, { type: 'CANCEL_EXECUTION' }).catch(() => {});
}

/** Snapshot of the current run, so a panel that opens mid-run can show Stop. */
async function runStatus() {
  if (activeRun) return { running: true, name: activeRun.name, auto: !!activeRun.auto, macroId: activeRun.macroId };
  // The worker may have just restarted for an evicted run — report it from the
  // persisted descriptor so Stop stays reachable and the panel isn't falsely idle.
  const state = await getRunState();
  if (state && state.macroId) return { running: true, name: state.name, auto: !!state.auto, macroId: state.macroId };
  return { running: false };
}

/* ---------------------------------------------------------------- *
 *  Auto mode — run a macro when a matching page finishes loading    *
 * ---------------------------------------------------------------- */

/**
 * Which macro last ran on which tab+URL, to stop auto mode retriggering itself
 * (and re-firing on a refresh). Kept in session storage, not memory: an MV3
 * worker is evicted often, and a lost guard is exactly what let a refresh look
 * like a new page and start the macro again.
 */
const AUTO_RUNS_KEY = 'autoRuns'; // { [tabId]: `${macroId}::${url}` }

async function getAutoRuns() {
  try {
    const stored = await chrome.storage.session.get(AUTO_RUNS_KEY);
    return stored[AUTO_RUNS_KEY] || {};
  } catch (_) {
    return {};
  }
}

async function setAutoRun(tabId, key) {
  try {
    const runs = await getAutoRuns();
    runs[tabId] = key;
    await chrome.storage.session.set({ [AUTO_RUNS_KEY]: runs });
  } catch (_) {}
}

async function forgetAutoRun(tabId) {
  try {
    const runs = await getAutoRuns();
    if (runs[tabId] === undefined) return;
    delete runs[tabId];
    await chrome.storage.session.set({ [AUTO_RUNS_KEY]: runs });
  } catch (_) {}
}

function escapeRegExp(s) {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/** Glob-ish match: `*` is a wildcard; a bare host like "example.com" matches anywhere. */
function urlMatches(pattern, url) {
  const p = (pattern || '').trim();
  if (!p) return true;
  let glob = p;
  if (!glob.includes('://') && !glob.includes('*')) glob = '*' + glob + '*';
  const rx = new RegExp('^' + glob.split('*').map(escapeRegExp).join('.*') + '$');
  return rx.test(url);
}

/**
 * The "ThisURL" token in any URL field stands for the page the run started on, so
 * a macro that clicks through to another site can switch or navigate back to it.
 * e.g. `ThisURL` (exact), `ThisURL*` (it and anything under it).
 */
function withThisURL(text) {
  if (!text || !activeRun || !activeRun.thisURL) return text;
  return String(text).split('ThisURL').join(activeRun.thisURL);
}

async function maybeAutoRun(tabId, url) {
  if (!url || RESTRICTED.test(url) || RESTRICTED_HOST.test(url)) return;
  if (activeRun) return; // one run at a time; also blocks self-retrigger mid-run

  const { macros = [] } = await chrome.storage.local.get('macros');
  const macro = macros.find((m) => m.auto && urlMatches(m.urlPattern, url) && m.steps && m.steps.length);
  if (!macro) return;

  const key = `${macro.id}::${url}`;
  const runs = await getAutoRuns();
  if (runs[tabId] === key) return; // already fired for this tab + URL
  await setAutoRun(tabId, key);

  await sleep(Math.max(0, Number(macro.autoDelay) || 500));
  if (activeRun) return;
  runMacro(macro.id, { tabId, auto: true });
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab && tab.url) maybeAutoRun(tabId, tab.url);
});

chrome.tabs.onRemoved.addListener((tabId) => forgetAutoRun(tabId));

/* ---------------------------------------------------------------- *
 *  Multi-tab control                                               *
 * ---------------------------------------------------------------- */

const recentTabs = []; // tabs observed as they are created

chrome.tabs.onCreated.addListener((tab) => {
  if (!tab || tab.id == null) return;
  recentTabs.push({
    id: tab.id,
    openerTabId: tab.openerTabId,
    windowId: tab.windowId,
    time: Date.now(),
    consumed: false
  });
  if (recentTabs.length > 40) recentTabs.splice(0, recentTabs.length - 40);
});

/** Mark a tab as already used so auto-follow never adopts it. */
function markConsumed(tabId) {
  const entry = recentTabs.find((t) => t.id === tabId);
  if (entry) entry.consumed = true;
}

/**
 * Point the run at a different tab and tell the panel about it. `opts.reason`
 * labels the move in the activity log ('switch' | 'open' | 'follow'); passing the
 * Tab in `opts.tab` emits that line straight away, in order, instead of after an
 * extra async round-trip (which is what made the log look like it lagged).
 */
function adoptTab(tabId, opts = {}) {
  if (tabId != null) markConsumed(tabId);
  if (!activeRun || activeRun.tabId === tabId) return;
  const from = activeRun.tabUrl || '';
  activeRun.tabId = tabId;
  activeRun.blockFollow = true; // the tab we just moved to gets the next step to itself
  activeRun.history.push(tabId);
  if (activeRun.history.length > 20) activeRun.history.shift();

  const report = (tab) => {
    if (!activeRun) return;
    activeRun.windowId = tab.windowId; // the new tab may live in another window
    activeRun.tabUrl = tab.url || activeRun.tabUrl;
    emit({ type: 'TAB_CHANGED', tabId, url: tab.url, title: tab.title, from, reason: opts.reason || 'switch' });
  };
  if (opts.tab) report(opts.tab);
  else chrome.tabs.get(tabId).then(report).catch(() => {});
}

/** Wait for a freshly opened tab to finish loading a real page. */
async function waitForNewTabUrl(tabId, timeout = 25000) {
  const started = Date.now();
  for (;;) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && tab.status === 'complete' && tab.url && !/^(about:blank|chrome:\/\/newtab)/i.test(tab.url)) {
      return tab;
    }
    if (Date.now() - started > timeout) throw new Error('New tab did not finish loading');
    await sleep(250);
  }
}

/**
 * The best tab to adopt right now: one created since the run began that we have
 * not used yet, preferring the tab whose opener is the tab we're on. Returns the
 * record (not yet marked consumed) or null.
 */
function followCandidate() {
  if (!activeRun || !activeRun.follow) return null;
  const since = activeRun.startedAt || 0;

  const candidates = recentTabs.filter(
    (t) =>
      !t.consumed &&
      t.time >= since &&
      t.id !== activeRun.tabId &&
      !activeRun.history.includes(t.id) // never yank back to a tab we already used
  );
  if (!candidates.length) return null;

  const sameWindow = candidates.filter((t) => t.windowId === activeRun.windowId);
  return (
    sameWindow.find((t) => t.openerTabId === activeRun.tabId) ||
    candidates.find((t) => t.openerTabId === activeRun.tabId) ||
    (sameWindow.length === 1 ? sameWindow[0] : null) ||
    (candidates.length === 1 ? candidates[0] : null)
  );
}

/**
 * If a step opened a tab (a click that redirects, window.open, …), move the run
 * onto it so following steps act on the new site.
 *
 * `waitMs` is a grace for a tab the page opens itself: the browser announces it a
 * beat after the click handler returns, so a caller that expects a tab passes a
 * grace instead of a single look.
 *
 * Once a candidate exists we wait for it to finish LOADING (up to NEW_TAB_READY)
 * and adopt it, so the next step runs on the new page rather than the old one. A
 * picked tab is only marked consumed once it is actually adopted, so a tab that is
 * still loading is retried by the next check instead of being dropped.
 * @returns the tab id that was adopted, or null.
 */
async function maybeFollowNewTab(waitMs = 0) {
  const deadline = Date.now() + waitMs;

  for (;;) {
    if (!activeRun || !activeRun.follow) return null;

    const pick = followCandidate();
    if (pick) {
      if (Date.now() - (pick.time || 0) > NEW_TAB_GIVEUP) {
        markConsumed(pick.id); // never became a real page — stop chasing it
      } else {
        const loaded = await waitForNewTabUrl(pick.id, NEW_TAB_READY).catch(() => null);
        if (loaded && !isRestricted(loaded)) {
          markConsumed(pick.id);
          await ensureAgent(pick.id).catch(() => {});
          adoptTab(pick.id, { reason: 'follow', tab: loaded });
          return pick.id;
        }
      }
    }

    if (Date.now() >= deadline) return null;
    await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
  }
}

/** True when a click may open a tab in a new context (target _blank / named). */
function expectNewTab(step, res) {
  if (step.action !== 'click' || !res || !res.link) return false;
  const target = res.link.target || '';
  return !!target && !/^_(self|top|parent)$/i.test(target);
}

async function resolveSwitchTarget(step) {
  if (step.mode === 'url') {
    // Search every window, not just the run's: a tab the page opened can live in
    // another one, and matching a URL is meant to land on it wherever it is.
    const isNot = step.urlOp === 'isnot';
    const pattern = withThisURL(step.url || '');
    const matches = (t) => {
      const m = urlMatches(pattern, t.url || '');
      return isNot ? !m : m;
    };
    const tabs = await chrome.tabs.query({});
    const others = tabs.filter((t) => t.id !== activeRun.tabId && !isRestricted(t));

    // "ThisURL" means the tab the run started on, so match it by id, not by URL: that
    // tab's URL may have changed since (redirect, hash, SPA), and a URL match would
    // then find nothing and abort the pass ("no matching tab to switch to").
    if (String(step.url || '').includes('ThisURL') && activeRun.startTabId != null) {
      if (!isNot) {
        const startTab = others.find((t) => t.id === activeRun.startTabId);
        if (startTab) return startTab;
      } else {
        const notStart = others.find((t) => t.id !== activeRun.startTabId);
        if (notStart) return notStart;
      }
    }

    // Prefer another tab. Failing that, the tab we are already on counts if it
    // satisfies the match — "IS NOT google" while already on the other site
    // should stay put, not abort the macro for lack of a target.
    const other = others.find(matches);
    if (other) return other;
    const here = tabs.find((t) => t.id === activeRun.tabId);
    return here && !isRestricted(here) && matches(here) ? here : null;
  }

  const all = await chrome.tabs.query({ windowId: activeRun.windowId });

  if (step.mode === 'previous') {
    const prevId = activeRun.history[activeRun.history.length - 2];
    return all.find((t) => t.id === prevId) || null;
  }

  const others = all.filter((t) => t.id !== activeRun.tabId && !isRestricted(t));
  return others.slice().sort((a, b) => (b.id || 0) - (a.id || 0))[0] || null; // newest
}

/* ---------------------------------------------------------------- *
 *  Browser-wide commands (Ctrl+T, Ctrl+W, …)                       *
 * ---------------------------------------------------------------- */

/**
 * Browser shortcuts can't be faked from a page — Chrome ignores synthetic key
 * events for its own shortcuts. So each one is performed with the real API.
 */
async function runBrowserCommand(step) {
  const tabId = activeRun.tabId;
  const command = step.command || 'newTab';
  const activate = step.activate !== false;
  const url = step.url && step.url.trim() ? withThisURL(step.url.trim()) : undefined;

  switch (command) {
    case 'newTab': {
      const created = await chrome.tabs.create({ url, active: activate });
      markConsumed(created.id);
      if (activate) {
        adoptTab(created.id, { reason: 'open', tab: created });
        await ensureAgent(created.id).catch(() => {});
      }
      return;
    }

    case 'closeTab': {
      const windowId = activeRun.windowId;
      await chrome.tabs.remove(tabId).catch(() => {});
      await sleep(200);
      const [next] = await chrome.tabs.query({ active: true, windowId });
      if (!next) throw new Error('Closed the last tab — nothing left to run on');
      adoptTab(next.id, { reason: 'switch', tab: next });
      await ensureAgent(next.id).catch(() => {});
      return;
    }

    case 'killOtherTabs': {
      const current = await chrome.tabs.get(tabId).catch(() => null);
      if (!current) return;
      const others = await chrome.tabs.query({ windowId: current.windowId });
      const ids = others.filter((t) => t.id !== tabId).map((t) => t.id);
      if (ids.length) {
        await chrome.tabs.remove(ids).catch(() => {});
        // Drop them from the follow tracker too: a dead tab id would otherwise make
        // auto-follow spin until waitForNewTabUrl times out.
        for (const id of ids) {
          const idx = recentTabs.findIndex((r) => r.id === id);
          if (idx !== -1) recentTabs.splice(idx, 1);
        }
      }
      await ensureAgent(tabId).catch(() => {});
      return;
    }

    case 'reopenTab': {
      const session = await chrome.sessions.restore().catch(() => null);
      const restored = session && session.tab;
      if (restored) {
        markConsumed(restored.id);
        adoptTab(restored.id, { reason: 'open', tab: restored });
        await ensureAgent(restored.id).catch(() => {});
      }
      return;
    }

    case 'nextTab':
    case 'prevTab': {
      const tabs = await chrome.tabs.query({ windowId: activeRun.windowId });
      if (tabs.length < 2) return;
      const idx = tabs.findIndex((t) => t.id === tabId);
      const target = tabs[(idx + (command === 'nextTab' ? 1 : -1) + tabs.length) % tabs.length];
      await chrome.tabs.update(target.id, { active: true }).catch(() => {});
      adoptTab(target.id, { reason: 'switch', tab: target });
      await ensureAgent(target.id).catch(() => {});
      return;
    }

    case 'duplicateTab': {
      const dup = await chrome.tabs.duplicate(tabId).catch(() => null);
      if (!dup) return;
      markConsumed(dup.id);
      if (activate) {
        adoptTab(dup.id, { reason: 'open', tab: dup });
        await ensureAgent(dup.id).catch(() => {});
      }
      return;
    }

    case 'reload':
    case 'hardReload': {
      const before = await chrome.tabs
        .get(tabId)
        .then((t) => t.url || '')
        .catch(() => '');
      await chrome.tabs.reload(tabId, { bypassCache: command === 'hardReload' }).catch(() => {});
      await sleep(400);
      await waitForTabComplete(tabId, '').catch(() => {});
      await ensureAgent(tabId).catch(() => {});
      activeRun.tabUrl = before || activeRun.tabUrl;
      return;
    }

    case 'back':
    case 'forward': {
      const go = command === 'back' ? chrome.tabs.goBack : chrome.tabs.goForward;
      await go(tabId).catch(() => {}); // no history => harmless no-op
      await sleep(400);
      await waitForTabComplete(tabId, '').catch(() => {});
      await ensureAgent(tabId).catch(() => {});
      activeRun.tabUrl = await currentUrl(tabId);
      return;
    }

    case 'newWindow': {
      const win = await chrome.windows.create({ url }).catch(() => null);
      if (!win) return;
      const tab = (win.tabs && win.tabs[0]) || (await chrome.tabs.query({ windowId: win.id }))[0];
      if (!tab) return;
      markConsumed(tab.id);
      adoptTab(tab.id, { reason: 'open', tab });
      await ensureAgent(tab.id).catch(() => {});
      return;
    }

    case 'closeWindow': {
      await chrome.windows.remove(activeRun.windowId).catch(() => {});
      await sleep(250);
      const [next] = await chrome.tabs.query({ active: true });
      if (!next) throw new Error('Closed the last window — nothing left to run on');
      adoptTab(next.id, { reason: 'switch', tab: next });
      await ensureAgent(next.id).catch(() => {});
      return;
    }

    default:
      throw new Error('Unknown browser command: ' + command);
  }
}

/** Read an element's text from the page (for wait-for-change on text). */
async function readTargetText(tabId, step) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, {
      type: 'READ_TEXT',
      target: step.target,
      textMatch: !!step.textMatch
    });
    return res && res.ok ? String(res.text == null ? '' : res.text) : '';
  } catch (_) {
    return '';
  }
}

/**
 * Wait until something changes — the page URL, or a picked element's text.
 * With `sinceLoop` the baseline is the value from the previous loop iteration,
 * which is how you say "if it's still the same page as last time, wait".
 */
async function runWaitChange(step, tabId) {
  const timeout = timeoutValue(step.timeout, 20000);
  const indefinite = timeout <= 0; // 0 = wait until it changes (or Stop)
  const every = Math.max(100, Number(step.interval) || 300);
  const watchUrl = (step.watch || 'url') === 'url';

  const read = () => (watchUrl ? currentUrl(tabId) : readTargetText(tabId, step));

  const baseline =
    watchUrl && step.sinceLoop && activeRun.loopMemory.url ? activeRun.loopMemory.url : await read();

  const started = Date.now();
  for (;;) {
    if (!activeRun || activeRun.cancelled) throw new Error('Stopped by user');

    if ((await read()) !== baseline) return;

    if (indefinite) {
      await sleep(every);
      continue;
    }

    const left = timeout - (Date.now() - started);
    if (left <= 0) {
      if (step.optional) return;
      throw new Error(watchUrl ? `URL did not change within ${secs(timeout)}` : `Text did not change within ${secs(timeout)}`);
    }
    await sleep(Math.min(every, Math.max(1, left)));
  }
}

/* ---------------------------------------------------------------- *
 *  Message router                                                  *
 * ---------------------------------------------------------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'ARM_PICKER':
      armPicker(msg.mode || 'click');
      sendResponse({ ok: true });
      return true;
    case 'CANCEL_PICKER':
      cancelPicker();
      sendResponse({ ok: true });
      return true;
    case 'RUN_MACRO':
      runMacro(msg.macroId);
      sendResponse({ ok: true });
      return true;
    case 'STOP_MACRO':
      stopRun();
      sendResponse({ ok: true });
      return true;
    case 'GET_RUN_STATUS':
      runStatus().then(sendResponse);
      return true;
    case 'KEEPALIVE':
      sendResponse({ ok: true, running: !!activeRun });
      return true;
    case 'ELEMENT_PICKED':
      cancelPicker();
      sendResponse({ ok: true });
      return true;
    case 'PICK_CANCELLED':
      sendResponse({ ok: true });
      return true;
    default:
      return;
  }
});

/* ---------------------------------------------------------------- *
 *  Keyboard shortcuts                                              *
 * ---------------------------------------------------------------- */

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'run-selected-macro') {
    const { selectedMacroId } = await chrome.storage.local.get('selectedMacroId');
    if (selectedMacroId) runMacro(selectedMacroId);
    else emit({ type: 'RUN_STATUS', state: 'error', error: 'No macro selected' });
  } else if (command === 'arm-picker') {
    armPicker('click');
  }
});

// Worker start: if a run was persisted, the previous worker was evicted mid-run.
// Recover it instead of leaving the panel stuck on "running" with nothing alive.
recoverRun();
