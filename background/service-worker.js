/**
 * Clicker — background service worker.
 * Routes picker/run requests, owns the run engine, and keeps storage in sync.
 */

const RESTRICTED = /^(chrome|edge|about|chrome-extension|devtools|view-source|data):/i;
const RESTRICTED_HOST = /^https:\/\/chromewebstore\.google\.com/i;

let activeRun = null; // { cancelled, tabId, macroId }

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
    await sleep(Math.min(150, end - Date.now()));
  }
}

function emit(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
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
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content/agent.js'] });
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
  if (activeRun) {
    if (!opts.auto) emit({ type: 'RUN_STATUS', state: 'error', error: 'A macro is already running' });
    return;
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
    windowId: tab.windowId,
    macroId: macro.id,
    history: [tab.id],
    follow: macro.followTabs !== false,
    startedAt: Date.now(),
    stepStartedAt: Date.now(),
    tabUrl: tab.url || ''
  };

  // Loop mode: repeat the whole step list `loopCount` times (0 = until stopped).
  const looping = !!macro.loop;
  const limit = looping ? (Number(macro.loopCount) > 0 ? Number(macro.loopCount) : Infinity) : 1;
  const interval = Math.max(0, Number(macro.loopInterval) || 0);
  const totalLabel = limit === Infinity ? null : limit;

  emit({ type: 'RUN_STATUS', state: 'running', macroId: macro.id, name: macro.name, auto: !!opts.auto, loop: looping });

  try {
    await ensureAgent(tab.id);

    for (let iteration = 1; iteration <= limit; iteration++) {
      if (!activeRun || activeRun.cancelled) throw new Error('Stopped by user');
      if (looping) emit({ type: 'RUN_LOOP', iteration, total: totalLabel });

      for (let i = 0; i < macro.steps.length; i++) {
        if (!activeRun || activeRun.cancelled) throw new Error('Stopped by user');
        const step = macro.steps[i];

        // A previous step may have opened a tab after a delay — move onto it first.
        if (activeRun.follow) await maybeFollowNewTab();

        emit({
          type: 'RUN_PROGRESS',
          index: i,
          total: macro.steps.length,
          action: step.action,
          url: activeRun.tabUrl,
          iteration: looping ? iteration : null,
          iterations: totalLabel
        });
        activeRun.stepStartedAt = Date.now();
        const res = await runStep(step);

        // Catch a tab this step just opened, so the following step can use it.
        const adopted = activeRun.follow ? await maybeFollowNewTab() : null;
        if (step.action === 'click' && activeRun.follow && !adopted && res && res.link) {
          await openLinkFallback(res.link, res.urlBefore);
        }
      }

      if (iteration < limit && interval > 0) await cancellableSleep(interval);
    }

    emit({
      type: 'RUN_STATUS',
      state: 'done',
      name: macro.name,
      auto: !!opts.auto,
      loops: looping ? (limit === Infinity ? '∞' : limit) : 1
    });
  } catch (e) {
    const error = String((e && e.message) || e);
    emit({ type: 'RUN_STATUS', state: 'error', error, cancelled: /Stopped by user/.test(error), auto: !!opts.auto });
  } finally {
    const runTabId = activeRun && activeRun.tabId;
    activeRun = null;
    // Remember where the run ended so its own navigation can't retrigger it.
    if (opts.auto && runTabId) {
      const t = await chrome.tabs.get(runTabId).catch(() => null);
      if (t && t.url) lastAutoRun.set(runTabId, `${macro.id}::${t.url}`);
    }
  }
}

async function runStep(step) {
  const tabId = activeRun && activeRun.tabId;
  if (!tabId) throw new Error('No active tab');

  if (step.action === 'wait') {
    await sleep(Math.max(0, Number(step.ms) || 0));
    return;
  }

  if (step.action === 'navigate') {
    if (!step.url) throw new Error('Navigate step has no URL');
    const before = await chrome.tabs
      .get(tabId)
      .then((t) => t.url || '')
      .catch(() => '');
    await chrome.tabs.update(tabId, { url: step.url });
    await waitForTabComplete(tabId, before);
    await sleep(250);
    await ensureAgent(tabId);
    return;
  }

  if (step.action === 'openTab') {
    if (!step.url) throw new Error('Open tab step has no URL');
    const created = await chrome.tabs.create({ url: step.url, active: step.activate !== false });
    await waitForNewTabUrl(created.id);
    await ensureAgent(created.id);
    adoptTab(created.id);
    return;
  }

  if (step.action === 'switchTab') {
    const target = await resolveSwitchTarget(step);
    if (!target) throw new Error('No matching tab to switch to');
    if (step.activate !== false) await chrome.tabs.update(target.id, { active: true }).catch(() => {});
    adoptTab(target.id);
    await ensureAgent(target.id);
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
    await waitForNewTabUrl(created.id).catch(() => {});
    await ensureAgent(created.id).catch(() => {});
    adoptTab(created.id);
    return;
  }

  await chrome.tabs.update(activeRun.tabId, { url: link.href });
  await waitForTabComplete(activeRun.tabId, urlBefore || '');
  await sleep(250);
  await ensureAgent(activeRun.tabId);
}

function stopRun() {
  if (!activeRun) return;
  activeRun.cancelled = true;
  // Interrupt a long step in progress (e.g. a human-like scroll) right away.
  chrome.tabs.sendMessage(activeRun.tabId, { type: 'CANCEL_EXECUTION' }).catch(() => {});
}

/* ---------------------------------------------------------------- *
 *  Auto mode — run a macro when a matching page finishes loading    *
 * ---------------------------------------------------------------- */

const lastAutoRun = new Map(); // tabId -> `${macroId}::${url}`

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

async function maybeAutoRun(tabId, url) {
  if (!url || RESTRICTED.test(url) || RESTRICTED_HOST.test(url)) return;
  if (activeRun) return; // one run at a time; also blocks self-retrigger mid-run

  const { macros = [] } = await chrome.storage.local.get('macros');
  const macro = macros.find((m) => m.auto && urlMatches(m.urlPattern, url) && m.steps && m.steps.length);
  if (!macro) return;

  const key = `${macro.id}::${url}`;
  if (lastAutoRun.get(tabId) === key) return;
  lastAutoRun.set(tabId, key);

  await sleep(Math.max(0, Number(macro.autoDelay) || 500));
  if (activeRun) return;
  runMacro(macro.id, { tabId, auto: true });
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab && tab.url) maybeAutoRun(tabId, tab.url);
});

chrome.tabs.onRemoved.addListener((tabId) => lastAutoRun.delete(tabId));

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

/** Point the run at a different tab and tell the panel about it. */
function adoptTab(tabId) {
  if (tabId != null) {
    // A tab we deliberately adopted must never be auto-followed again.
    const entry = recentTabs.find((t) => t.id === tabId);
    if (entry) entry.consumed = true;
  }
  if (!activeRun || activeRun.tabId === tabId) return;
  activeRun.tabId = tabId;
  activeRun.history.push(tabId);
  if (activeRun.history.length > 20) activeRun.history.shift();
  chrome.tabs
    .get(tabId)
    .then((t) => {
      activeRun.tabUrl = t.url || activeRun.tabUrl;
      emit({ type: 'TAB_CHANGED', tabId, url: t.url, title: t.title });
    })
    .catch(() => {});
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
 * If a step opened a tab (a click that redirects, window.open, …), move the run
 * onto it so following steps act on the new site.
 *
 * The window is the whole run, not the current step: the tab can appear well
 * after the click handler returns (JS redirects, async handlers), and a later
 * step must still be able to pick it up. This is called before *and* after each
 * step, and is cheap — no sleeping.
 * @returns the tab id that was adopted, or null.
 */
async function maybeFollowNewTab() {
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
  const pick =
    sameWindow.find((t) => t.openerTabId === activeRun.tabId) ||
    candidates.find((t) => t.openerTabId === activeRun.tabId) ||
    (sameWindow.length === 1 ? sameWindow[0] : null) ||
    (candidates.length === 1 ? candidates[0] : null);
  if (!pick) return null;

  pick.consumed = true;

  // A just-opened tab has no URL yet (url:'' / about:blank / chrome://newtab), so
  // wait for it to become a real page BEFORE judging whether it can be scripted —
  // otherwise every fresh tab looks "restricted" and adoption silently fails.
  const loaded = await waitForNewTabUrl(pick.id).catch(() => null);
  if (!loaded || isRestricted(loaded)) return null;

  await ensureAgent(pick.id).catch(() => {});
  adoptTab(pick.id);
  return pick.id;
}

async function resolveSwitchTarget(step) {
  const all = await chrome.tabs.query({ windowId: activeRun.windowId });

  if (step.mode === 'previous') {
    const prevId = activeRun.history[activeRun.history.length - 2];
    return all.find((t) => t.id === prevId) || null;
  }

  const others = all.filter((t) => t.id !== activeRun.tabId && !isRestricted(t));
  if (step.mode === 'url') {
    return others.filter((t) => urlMatches(step.url || '', t.url || ''))[0] || null;
  }
  return others.slice().sort((a, b) => (b.id || 0) - (a.id || 0))[0] || null; // newest
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
