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

  activeRun = { cancelled: false, tabId: tab.id, macroId: macro.id };

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
        emit({
          type: 'RUN_PROGRESS',
          index: i,
          total: macro.steps.length,
          action: step.action,
          iteration: looping ? iteration : null,
          iterations: totalLabel
        });
        await runStep(tab.id, step);
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

async function runStep(tabId, step) {
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

  let res;
  try {
    res = await chrome.tabs.sendMessage(tabId, { type: 'EXECUTE_STEP', step });
  } catch (e) {
    throw new Error('Could not reach the page — it may have navigated or reloaded');
  }
  if (!res || !res.ok) throw new Error((res && res.error) || `Step failed: ${step.action}`);
}

function stopRun() {
  if (activeRun) activeRun.cancelled = true;
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
