/**
 * Clicker — side panel UI.
 * Owns the macro/step model in chrome.storage.local and drives the background
 * worker for picking and running.
 */

const ACTIONS = {
  click: { label: 'Click', pick: true },
  type: { label: 'Type', pick: true },
  press: { label: 'Key press', pick: true },
  hover: { label: 'Hover', pick: true },
  scan: { label: 'Scan', pick: true },
  if: { label: 'If', pick: false },
  waitChange: { label: 'Wait for change', pick: false },
  wait: { label: 'Wait', pick: false },
  scroll: { label: 'Scroll', pick: false },
  navigate: { label: 'Go to URL', pick: false },
  openTab: { label: 'Open tab', pick: false },
  switchTab: { label: 'Switch tab', pick: false },
  browser: { label: 'Browser', pick: false },
  gamble: { label: 'Gamble', pick: false }
};

/** Order + short labels for the "add step" menus (the top bar and each If branch). */
const ADD_MENU = [
  ['click', 'Click'],
  ['type', 'Type'],
  ['press', 'Key'],
  ['hover', 'Hover'],
  ['scan', 'Scan'],
  ['if', 'If'],
  ['gamble', 'Gamble'],
  ['waitChange', 'Wait change'],
  ['wait', 'Wait'],
  ['scroll', 'Scroll'],
  ['navigate', 'Go to'],
  ['openTab', 'New tab'],
  ['switchTab', 'Switch'],
  ['browser', 'Browser']
];

const CONDITION_TYPES = [
  ['exists', 'Element'],
  ['text', 'Text'],
  ['attr', 'Attribute'],
  ['url', 'Page URL'],
  ['urlChanged', 'URL changed']
];
const CONDITION_OPS = [
  ['is', 'is'],
  ['contains', 'contains'],
  ['starts', 'starts with'],
  ['ends', 'ends with'],
  ['notEmpty', 'not empty'],
  ['regex', 'regex']
];
const CONDITION_STATES = [
  ['visible', 'Visible'],
  ['present', 'Present'],
  ['hidden', 'Hidden']
];

function defaultCondition() {
  return { type: 'exists', state: 'visible', target: null, negate: false };
}

/** One-line summary of an If condition (mirrors the worker's log label). */
function conditionSummary(condition) {
  const c = condition || {};
  const neg = c.negate ? 'not ' : '';
  const target = (c.target && (c.target.label || c.target.selector)) || 'element';
  if (c.type === 'urlChanged') return `${neg}url changed since last loop`;
  if (c.type === 'url') return `${neg}url matches ${c.pattern || '*'}`;
  if (c.type === 'text') return `${neg}${target} text ${c.op || 'contains'} "${c.value || ''}"`;
  if (c.type === 'attr') return `${neg}${target} ${c.attr || 'href'} ${c.op || 'is'} "${c.value || ''}"`;
  return `${neg}${target} is ${c.state || 'visible'}`;
}

/** Browser-wide shortcuts, performed with the real APIs (synthetic keys are ignored by Chrome). */
const BROWSER_COMMANDS = [
  ['newTab', 'New tab (Ctrl+T)'],
  ['closeTab', 'Close tab (Ctrl+W)'],
  ['killOtherTabs', 'Close other tabs'],
  ['reopenTab', 'Reopen closed tab (Ctrl+Shift+T)'],
  ['nextTab', 'Next tab (Ctrl+Tab)'],
  ['prevTab', 'Previous tab (Ctrl+Shift+Tab)'],
  ['duplicateTab', 'Duplicate tab'],
  ['reload', 'Reload (Ctrl+R)'],
  ['hardReload', 'Hard reload (Ctrl+Shift+R)'],
  ['back', 'Back (Alt+Left)'],
  ['forward', 'Forward (Alt+Right)'],
  ['newWindow', 'New window (Ctrl+N)'],
  ['closeWindow', 'Close window (Ctrl+Shift+W)']
];
const BROWSER_LABELS = Object.fromEntries(BROWSER_COMMANDS);
const BROWSER_URL_COMMANDS = ['newTab', 'newWindow'];
const BROWSER_ACTIVATE_COMMANDS = ['newTab', 'duplicateTab', 'reopenTab'];

/** Which panels start collapsed — the settings sit at the bottom and stay out of the way. */
const DEFAULT_COLLAPSED = { add: false, toolbar: true, auto: true, loop: true, tabs: true, data: true, log: false };

const state = {
  macros: [],
  selectedId: null,
  running: false,
  armed: false,
  pickBranch: [],
  pickStepId: null,
  pickSlot: 'target',
  logs: [],
  pendingImport: null,
  dragStepId: null,
  collapsed: Object.assign({}, DEFAULT_COLLAPSED)
};

const $ = (sel) => document.querySelector(sel);
const ui = {};

let persistTimer = null;

document.addEventListener('DOMContentLoaded', init);

async function init() {
  ui.statusDot = $('#status-dot');
  ui.macroSelect = $('#macro-select');
  ui.steps = $('#steps');
  ui.empty = $('#empty-state');
  ui.runBtn = $('#btn-run');
  ui.stopBtn = $('#btn-stop');
  ui.log = $('#log');
  ui.autoToggle = $('#auto-toggle');
  ui.autoFields = $('#auto-fields');
  ui.autoPattern = $('#auto-pattern');
  ui.autoDelay = $('#auto-delay');
  ui.loopToggle = $('#loop-toggle');
  ui.loopFields = $('#loop-fields');
  ui.loopCount = $('#loop-count');
  ui.loopInterval = $('#loop-interval');
  ui.followToggle = $('#follow-toggle');
  ui.exportBtn = $('#btn-export');
  ui.importBtn = $('#btn-import');
  ui.importFile = $('#import-file');
  ui.importChoice = $('#import-choice');
  ui.importInfo = $('#import-info');

  fillAddButtons();
  bindEvents();

  const stored = await chrome.storage.local.get(['macros', 'selectedMacroId', 'ui_collapsed']);
  state.macros = Array.isArray(stored.macros) ? stored.macros : [];
  state.selectedId = stored.selectedMacroId || null;
  state.collapsed = Object.assign({}, DEFAULT_COLLAPSED, stored.ui_collapsed || {});

  if (state.macros.length === 0) {
    const macro = makeMacro('My first macro');
    state.macros.push(macro);
    state.selectedId = macro.id;
    await persist();
  }
  if (!state.macros.some((m) => m.id === state.selectedId)) {
    state.selectedId = state.macros[0].id;
    await persist();
  }

  render();
  applyPanels();
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  log('Ready. Pick an element to start building.', 'dim');

  // A run can still be alive in the worker (started before this panel opened, or a
  // loop). Adopt its state so Stop is available instead of the panel showing idle.
  const syncRun = async () => {
    const status = await chrome.runtime.sendMessage({ type: 'GET_RUN_STATUS' }).catch(() => null);
    if (!status) return;
    if (status.running && !state.running) {
      log(`Already running "${status.name}"${status.auto ? ' (auto)' : ''} — press Stop to end it.`, 'err');
    }
    state.running = !!status.running;
    renderStatus();
  };
  await syncRun();
  window.addEventListener('focus', syncRun);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) syncRun();
  });

  const autos = state.macros.filter((m) => m.auto);
  if (autos.length) log(`Auto mode is on for: ${autos.map((m) => m.name).join(', ')}`, 'dim');
}

/* ---------------------------------------------------------------- *
 *  Model                                                           *
 * ---------------------------------------------------------------- */

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function makeMacro(name) {
  return { id: uid(), name: name || 'Untitled macro', steps: [], createdAt: Date.now() };
}

function currentMacro() {
  return state.macros.find((m) => m.id === state.selectedId) || null;
}

/* --- nested step lookup -------------------------------------------------
 * A branch path is [index, 'then'|'else', index, ...]; [] is the root list.
 * ---------------------------------------------------------------------- */

function branchOf(path) {
  const macro = currentMacro();
  if (!macro) return null;
  let list = macro.steps;
  for (let i = 0; i + 1 < path.length; i += 2) {
    const step = list[path[i]];
    if (!step) return null;
    const key = path[i + 1];
    if (!Array.isArray(step[key])) step[key] = [];
    list = step[key];
  }
  return list;
}

/** Steps that own then/else branches the runner recurses into. */
const BRANCH_ACTIONS = { if: true, gamble: true };
const isBranchStep = (step) => !!BRANCH_ACTIONS[step && step.action];

/** Depth-first search for a step (walks into If and Gamble branches). */
function findStep(id, list) {
  const macro = currentMacro();
  const steps = list || (macro ? macro.steps : []);
  for (const step of steps) {
    if (step.id === id) return step;
    if (isBranchStep(step)) {
      const inThen = findStep(id, step.then || []);
      if (inThen) return inThen;
      const inElse = findStep(id, step.else || []);
      if (inElse) return inElse;
    }
  }
  return null;
}

/** The list a step lives in, plus its index there (for move/remove). */
function findLocation(id, list) {
  const macro = currentMacro();
  const steps = list || (macro ? macro.steps : []);
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.id === id) return { list: steps, index: i };
    if (isBranchStep(step)) {
      const inThen = findLocation(id, step.then || []);
      if (inThen) return inThen;
      const inElse = findLocation(id, step.else || []);
      if (inElse) return inElse;
    }
  }
  return null;
}

/** Total steps including those nested in If and Gamble branches. */
function countSteps(list) {
  let n = 0;
  for (const step of list || []) {
    n += 1;
    if (isBranchStep(step)) n += countSteps(step.then) + countSteps(step.else);
  }
  return n;
}

function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persist, 400);
}

function persist() {
  return chrome.storage.local.set({ macros: state.macros, selectedMacroId: state.selectedId });
}

function addStep(step, path) {
  const list = branchOf(path || []);
  if (!list) return null;
  const created = Object.assign({ id: uid() }, step);
  list.push(created);
  persist();
  renderSteps();
  renderMacroSelect();
  updateSummaries();
  return created;
}

function updateStep(stepId, patch) {
  const step = findStep(stepId);
  if (!step) return;
  Object.assign(step, patch);
  schedulePersist();
}

function removeStep(stepId) {
  const loc = findLocation(stepId);
  if (!loc) return;
  loc.list.splice(loc.index, 1);
  persist();
  renderSteps();
  renderMacroSelect();
  updateSummaries();
}

function moveStep(stepId, dir) {
  const loc = findLocation(stepId);
  if (!loc) return;
  const next = loc.index + dir;
  if (next < 0 || next >= loc.list.length) return;
  [loc.list[loc.index], loc.list[next]] = [loc.list[next], loc.list[loc.index]];
  persist();
  renderSteps();
}

/** True when both steps live in the same branch list — dragging stays inside one list. */
function sameList(a, b) {
  const from = findLocation(a);
  const to = findLocation(b);
  return !!(from && to && from.list === to.list);
}

/** Drop a dragged step just before or after a target step in the target's own list. */
function moveStepTo(dragId, targetId, position) {
  if (!dragId || !targetId || dragId === targetId) return false;
  const from = findLocation(dragId);
  const to = findLocation(targetId);
  if (!from || !to || from.list !== to.list) return false;

  const [step] = from.list.splice(from.index, 1);
  let index = to.index;
  if (from.index < to.index) index -= 1; // the list shifted left under us
  if (position === 'after') index += 1;
  to.list.splice(index, 0, step);

  persist();
  renderSteps();
  return true;
}

/** The steps that sit after a container in its own list — the "from below" candidates. */
function stepsBelow(containerId) {
  const loc = findLocation(containerId);
  return loc ? loc.list.slice(loc.index + 1) : [];
}

/** A one-line label for an existing step offered up for reuse. */
function stepMenuLabel(step) {
  const heading = stepHeading(step);
  const target = step.target && (step.target.label || step.target.selector);
  return target ? `${heading.title} — ${target}` : heading.title;
}

/**
 * Move an existing sibling step into one of a container's branches, so a step can
 * be reused instead of being re-built by picking the element all over again.
 */
function moveStepIntoBranch(stepId, containerId, key) {
  const container = findStep(containerId);
  const containerLoc = findLocation(containerId);
  const from = findLocation(stepId);
  if (!container || !containerLoc || !from) return false;
  if (from.list !== containerLoc.list || from.index <= containerLoc.index) return false; // only from below

  const [moved] = from.list.splice(from.index, 1);
  const branch = Array.isArray(container[key]) ? container[key] : (container[key] = []);
  branch.push(moved);
  persist();
  renderSteps();
  return true;
}

/** Move several steps below a container into one branch in a single pass. */
function moveAllIntoBranch(ids, containerId, key) {
  const container = findStep(containerId);
  const containerLoc = findLocation(containerId);
  if (!container || !containerLoc) return 0;

  const branch = Array.isArray(container[key]) ? container[key] : (container[key] = []);
  let moved = 0;
  ids.forEach((id) => {
    const from = findLocation(id);
    if (!from || from.list !== containerLoc.list || from.index <= containerLoc.index) return;
    const [step] = from.list.splice(from.index, 1);
    branch.push(step);
    moved += 1;
  });

  if (moved) {
    persist();
    renderSteps();
  }
  return moved;
}

/** Which side of a row a drop would land on, from the pointer's half of the row. */
function dropPosition(row, event) {
  const rect = row.getBoundingClientRect ? row.getBoundingClientRect() : null;
  if (!rect || typeof event.clientY !== 'number') return 'after';
  return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}

function clearDropMarkers() {
  document.querySelectorAll('.step.drop-before, .step.drop-after').forEach((el) => {
    el.classList.remove('drop-before', 'drop-after');
  });
}

function markDrop(row, position) {
  clearDropMarkers();
  row.classList.add(position === 'before' ? 'drop-before' : 'drop-after');
}

/** Wire a row for drag-to-reorder (the ↑/↓ buttons remain, for keyboard-free use). */
function wireDragToReorder(row, step, body) {
  // Only the row the pointer is directly over acts, so nested rows do not fight their parents.
  const isOwnTarget = (event) => !!(event.target && event.target.closest && event.target.closest('.step') === row);
  const canDrop = () => !!(state.dragStepId && state.dragStepId !== step.id && sameList(state.dragStepId, step.id));

  row.draggable = true;

  row.addEventListener('dragstart', (event) => {
    if (!isOwnTarget(event)) return; // a nested row owns this drag
    // Never hijack a drag that began in this row's fields — inputs need selection and carets.
    if (body.contains(event.target)) {
      event.preventDefault();
      return;
    }
    state.dragStepId = step.id;
    row.classList.add('dragging');
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', step.id);
    }
  });

  row.addEventListener('dragend', (event) => {
    if (!isOwnTarget(event)) return;
    state.dragStepId = null;
    row.classList.remove('dragging');
    clearDropMarkers();
  });

  row.addEventListener('dragover', (event) => {
    if (!isOwnTarget(event) || !canDrop()) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    markDrop(row, dropPosition(row, event));
  });

  row.addEventListener('dragleave', (event) => {
    if (!isOwnTarget(event)) return;
    row.classList.remove('drop-before', 'drop-after');
  });

  row.addEventListener('drop', (event) => {
    if (!isOwnTarget(event) || !canDrop()) return;
    event.preventDefault();
    event.stopPropagation();
    const position = dropPosition(row, event);
    const dragId = state.dragStepId;
    state.dragStepId = null;
    clearDropMarkers();
    moveStepTo(dragId, step.id, position);
  });
}

/* ---------------------------------------------------------------- *
 *  Events                                                          *
 * ---------------------------------------------------------------- */

function bindEvents() {
  document.querySelectorAll('.panel').forEach((panel) => {
    const head = panel.querySelector('.panel-head');
    if (head) head.addEventListener('click', () => togglePanel(panel.dataset.panel));
  });

  ui.macroSelect.addEventListener('change', async () => {
    state.selectedId = ui.macroSelect.value;
    await persist();
    render();
  });

  $('#btn-new').addEventListener('click', async () => {
    const name = prompt('Name for the new macro:', 'New macro');
    if (name === null) return;
    const macro = makeMacro(name.trim() || 'Untitled macro');
    state.macros.unshift(macro);
    state.selectedId = macro.id;
    await persist();
    render();
    log(`Created macro "${macro.name}"`, 'ok');
  });

  $('#btn-rename').addEventListener('click', async () => {
    const macro = currentMacro();
    if (!macro) return;
    const name = prompt('Rename macro:', macro.name);
    if (name === null || !name.trim()) return;
    macro.name = name.trim();
    await persist();
    render();
  });

  $('#btn-delete').addEventListener('click', async () => {
    const macro = currentMacro();
    if (!macro) return;
    if (!confirm(`Delete macro "${macro.name}"?`)) return;
    state.macros = state.macros.filter((m) => m.id !== macro.id);
    if (state.macros.length === 0) state.macros.push(makeMacro('My first macro'));
    state.selectedId = state.macros[0].id;
    await persist();
    render();
    log(`Deleted macro "${macro.name}"`);
  });

  document.querySelectorAll('[data-add]').forEach((btn) => {
    btn.addEventListener('click', () => onAddStep(btn.dataset.add, []));
  });

  ui.runBtn.addEventListener('click', runSelected);
  ui.stopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'STOP_MACRO' });
    log('Stop requested…');
  });

  ui.autoToggle.addEventListener('change', () => {
    const macro = currentMacro();
    if (!macro) return;
    macro.auto = ui.autoToggle.checked;
    persist();
    renderAuto();
    renderMacroSelect();
    log(
      macro.auto
        ? `Auto mode ON — "${macro.name}" runs on ${(macro.urlPattern || '').trim() || 'any page'}`
        : `Auto mode off — "${macro.name}"`,
      macro.auto ? 'ok' : ''
    );
  });

  ui.autoPattern.addEventListener('input', () => {
    const macro = currentMacro();
    if (!macro) return;
    macro.urlPattern = ui.autoPattern.value;
    schedulePersist();
  });

  ui.autoDelay.addEventListener('input', () => {
    const macro = currentMacro();
    if (!macro) return;
    macro.autoDelay = secToMs(ui.autoDelay.value);
    schedulePersist();
  });

  ui.loopToggle.addEventListener('change', () => {
    const macro = currentMacro();
    if (!macro) return;
    macro.loop = ui.loopToggle.checked;
    persist();
    renderLoop();
    renderMacroSelect();
    if (macro.loop) {
      const times = Number(macro.loopCount) > 0 ? `${macro.loopCount}×` : 'until you press Stop';
      log(`Loop mode ON — "${macro.name}" repeats ${times}`, 'ok');
    } else {
      log(`Loop mode off — "${macro.name}"`);
    }
  });

  ui.loopCount.addEventListener('input', () => {
    const macro = currentMacro();
    if (!macro) return;
    macro.loopCount = Number(ui.loopCount.value) || 0;
    schedulePersist();
  });

  ui.loopInterval.addEventListener('input', () => {
    const macro = currentMacro();
    if (!macro) return;
    macro.loopInterval = secToMs(ui.loopInterval.value);
    schedulePersist();
  });

  ui.followToggle.addEventListener('change', () => {
    const macro = currentMacro();
    if (!macro) return;
    macro.followTabs = ui.followToggle.checked;
    persist();
    log(macro.followTabs ? 'Following new tabs.' : 'Staying on the tab the macro started on.');
  });

  ui.exportBtn.addEventListener('click', exportMacros);
  ui.importBtn.addEventListener('click', () => {
    hideImportChoice();
    ui.importFile.value = '';
    ui.importFile.click();
  });
  ui.importFile.addEventListener('change', onImportFileChosen);
  document.getElementById('btn-import-replace').addEventListener('click', () => applyImport('replace'));
  document.getElementById('btn-import-merge').addEventListener('click', () => applyImport('merge'));
  document.getElementById('btn-import-cancel').addEventListener('click', () => {
    state.pendingImport = null;
    hideImportChoice();
    log('Import cancelled');
  });

  $('#btn-clear-log').addEventListener('click', () => {
    state.logs = [];
    renderLog();
  });
}

function fillAddButtons() {
  const host = document.getElementById('add-buttons');
  if (!host) return;
  host.innerHTML = '';
  ADD_MENU.forEach(([action, label]) => host.appendChild(addButton(action, label)));
}

function addButton(action, label) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'add-btn small';
  btn.dataset.add = action;
  btn.textContent = label;
  return btn;
}

function focusStepInput(id) {
  if (!id) return;
  const el = document.querySelector(`[data-step-id="${id}"] .step-input`);
  if (el) el.focus();
}

function onAddStep(action, path) {
  const branchPath = path || [];

  if (ACTIONS[action] && ACTIONS[action].pick) {
    startPick(action, { branchPath });
    return;
  }
  if (action === 'if') {
    addStep({ action: 'if', condition: defaultCondition(), then: [], else: [] }, branchPath);
    return;
  }
  if (action === 'gamble') {
    addStep({ action: 'gamble', chance: 50, then: [], else: [] }, branchPath);
    return;
  }
  if (action === 'waitChange') {
    addStep({ action: 'waitChange', watch: 'url', sinceLoop: true, timeout: 20000, interval: 300, optional: false }, branchPath);
    return;
  }
  if (action === 'wait') {
    addStep({ action: 'wait', mode: 'fixed', ms: 1000 }, branchPath);
  } else if (action === 'scroll') {
    addStep({ action: 'scroll', scope: 'amount', direction: 'down', amount: 600, duration: 0 }, branchPath);
  } else if (action === 'openTab') {
    const step = addStep({ action: 'openTab', url: 'https://', activate: true }, branchPath);
    focusStepInput(step && step.id);
  } else if (action === 'browser') {
    addStep({ action: 'browser', command: 'newTab', url: '', activate: true }, branchPath);
  } else if (action === 'switchTab') {
    addStep({ action: 'switchTab', mode: 'newest', urlOp: 'is', url: '', activate: true }, branchPath);
  } else if (action === 'navigate') {
    const step = addStep({ action: 'navigate', url: 'https://' }, branchPath);
    focusStepInput(step && step.id);
  }
}

function startPick(action, opts) {
  const options = opts || {};
  state.pickBranch = options.branchPath || [];
  state.pickStepId = options.stepId || null;
  state.pickSlot = options.slot || 'target';
  state.armed = true;
  renderStatus();
  chrome.runtime.sendMessage({ type: 'ARM_PICKER', mode: action });
  const what = state.pickSlot === 'condition' ? 'test' : ACTIONS[action] ? ACTIONS[action].label.toLowerCase() : 'use';
  log(`Picking element to ${what}… click it on the page.`, 'dim');
}

function runSelected() {
  const macro = currentMacro();
  if (!macro) return;
  if (!macro.steps.length) {
    log('Add at least one step before running.', 'err');
    return;
  }
  chrome.runtime.sendMessage({ type: 'RUN_MACRO', macroId: macro.id });
}

/* ---------------------------------------------------------------- *
 *  Background messages                                             *
 * ---------------------------------------------------------------- */

function onRuntimeMessage(msg) {
  if (!msg || !msg.type) return;

  if (msg.type === 'ELEMENT_PICKED') {
    state.armed = false;
    const action = msg.mode || 'click';
    const stepId = state.pickStepId;
    const slot = state.pickSlot;
    const branchPath = state.pickBranch || [];
    state.pickStepId = null;
    state.pickSlot = 'target';

    if (stepId) {
      const step = findStep(stepId);
      if (step) {
        if (slot === 'condition') {
          step.condition = Object.assign({}, step.condition || defaultCondition(), { target: msg.target });
          log(`Condition target: ${msg.target.label}`, 'ok');
        } else {
          step.target = msg.target;
          log(`Re-picked: ${msg.target.label}`, 'ok');
        }
        persist();
        renderSteps();
        updateSummaries();
      }
    } else {
      const base = { action, target: msg.target };
      if (action === 'type') base.value = '';
      if (action === 'press') base.key = 'Enter';
      if (action === 'hover') base.ms = 1000;
      if (action === 'scan') {
        base.timeout = 10000;
        base.interval = 250;
        base.optional = false;
      }
      addStep(base, branchPath);
      log(`Added ${ACTIONS[action].label} step → ${msg.target.label}`, 'ok');
    }
    renderStatus();

  } else if (msg.type === 'PICK_CANCELLED' || (msg.type === 'PICK_STATUS' && msg.state !== 'armed')) {
    state.armed = false;
    state.pickStepId = null;
    state.pickSlot = 'target';
    renderStatus();
    if (msg.type === 'PICK_STATUS' && msg.error) log(msg.error, 'err');

  } else if (msg.type === 'PICK_STATUS' && msg.state === 'armed') {
    state.armed = true;
    renderStatus();

  } else if (msg.type === 'NOTE') {
    log(msg.text, 'dim');

  } else if (msg.type === 'TAB_CHANGED') {
    const to = hostOf(msg.url);
    if (msg.reason === 'follow') log(`Followed new tab → ${to}`, 'ok');
    else if (msg.reason === 'open') log(`Opened new tab → ${to}`, 'ok');
    else if (msg.from) log(`Switched FROM ${hostOf(msg.from)} TO ${to}`, 'ok');
    else log(`Switched TO ${to}`, 'ok');

  } else if (msg.type === 'RUN_LOOP') {
    log(`Loop ${msg.iteration}${msg.total ? ' of ' + msg.total : ''}`, 'dim');

  } else if (msg.type === 'RUN_LOOP_ERROR') {
    const pass = msg.total ? `${msg.iteration}/${msg.total}` : msg.iteration;
    log(`Pass ${pass} failed — ${msg.error}. Looping again.`, 'err');

  } else if (msg.type === 'BRANCH') {
    log(`${msg.result ? '✓ then' : '✗ else'} — ${msg.label}`, 'dim');

  } else if (msg.type === 'GAMBLE') {
    log(msg.result ? `✓ gamble won — ${msg.chance}%` : `✗ gamble lost — ${msg.chance}%`, 'dim');

  } else if (msg.type === 'RUN_PROGRESS') {
    const tag = msg.iteration ? `[${msg.iteration}${msg.iterations ? '/' + msg.iterations : ''}] ` : '';
    const where = msg.url ? ` · ${hostOf(msg.url)}` : '';
    const indent = msg.depth ? '    '.repeat(msg.depth) : '';
    const label = msg.action === 'browser' && msg.command ? BROWSER_LABELS[msg.command] : ACTIONS[msg.action] ? ACTIONS[msg.action].label : msg.action;
    const detail = msg.label ? ` "${msg.label}"` : '';
    log(`${indent}${tag}Step ${msg.index + 1}/${msg.total} — ${label}${detail}${where}`);

  } else if (msg.type === 'RUN_STATUS') {
    if (msg.state === 'running') {
      state.running = true;
      log(`Running "${msg.name}"${msg.auto ? ' (auto)' : ''}${msg.loop ? ' (looping)' : ''}…`, 'ok');
    } else if (msg.state === 'done') {
      state.running = false;
      const failed = msg.failed ? ` (${msg.failed} pass${msg.failed === 1 ? '' : 'es'} failed)` : '';
      log(
        msg.loops && msg.loops !== 1
          ? `Finished "${msg.name}" after ${msg.loops} loops${failed}.`
          : `Finished "${msg.name}"${failed}.`,
        'ok'
      );
    } else if (msg.state === 'error') {
      state.running = false;
      log(msg.cancelled ? 'Stopped.' : `Error: ${msg.error}`, 'err');
    }
    renderStatus();
  }
}

/* ---------------------------------------------------------------- *
 *  Rendering                                                       *
 * ---------------------------------------------------------------- */

function render() {
  renderMacroSelect();
  renderAuto();
  renderLoop();
  renderTabs();
  renderSteps();
  renderStatus();
  updateSummaries();
}

function applyPanels() {
  document.querySelectorAll('.panel').forEach((panel) => {
    panel.classList.toggle('open', !state.collapsed[panel.dataset.panel]);
  });
}

function togglePanel(key) {
  if (!key) return;
  state.collapsed[key] = !state.collapsed[key];
  applyPanels();
  chrome.storage.local.set({ ui_collapsed: state.collapsed });
}

function updateSummaries() {
  const macro = currentMacro();
  const set = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  if (!macro) return;

  set('sum-auto', macro.auto ? `on · ${(macro.urlPattern || '').trim() || 'any page'}` : 'off');
  set('sum-loop', macro.loop ? `on · ${Number(macro.loopCount) > 0 ? macro.loopCount + '\u00d7' : 'until Stop'}` : 'off');
  set('sum-tabs', macro.followTabs !== false ? 'on' : 'off');
  set('sum-toolbar', `auto ${macro.auto ? 'on' : 'off'} · loop ${macro.loop ? 'on' : 'off'} · tabs ${macro.followTabs !== false ? 'on' : 'off'}`);
  const total = countSteps(macro.steps);
  set('sum-add', total ? `${total} step${total === 1 ? '' : 's'}` : '');
  set('sum-data', `${state.macros.length} macro${state.macros.length === 1 ? '' : 's'}`);

  const logEl = document.getElementById('sum-log');
  if (logEl) logEl.textContent = state.logs.length ? `${state.logs.length} lines` : '';
}

function renderLoop() {
  const macro = currentMacro();
  if (!macro) return;
  ui.loopToggle.checked = !!macro.loop;
  ui.loopCount.value = String(macro.loopCount == null ? 0 : macro.loopCount);
  ui.loopInterval.value = msToSec(macro.loopInterval == null ? 1000 : macro.loopInterval);
  ui.loopFields.style.display = macro.loop ? 'flex' : 'none';
}

function renderTabs() {
  const macro = currentMacro();
  if (!macro) return;
  ui.followToggle.checked = macro.followTabs !== false;
}

function renderAuto() {
  const macro = currentMacro();
  if (!macro) return;
  ui.autoToggle.checked = !!macro.auto;
  ui.autoPattern.value = macro.urlPattern || '';
  ui.autoDelay.value = msToSec(macro.autoDelay == null ? 500 : macro.autoDelay);
  ui.autoFields.style.display = macro.auto ? 'flex' : 'none';
}

function renderMacroSelect() {
  ui.macroSelect.innerHTML = '';
  for (const macro of state.macros) {
    const opt = document.createElement('option');
    opt.value = macro.id;
    opt.textContent = `${macro.auto ? '⚡' : ''}${macro.loop ? '↻' : ''}${macro.auto || macro.loop ? ' ' : ''}${macro.name} (${macro.steps.length})`;
    if (macro.id === state.selectedId) opt.selected = true;
    ui.macroSelect.appendChild(opt);
  }
}

function renderSteps() {
  const macro = currentMacro();
  const steps = macro ? macro.steps : [];
  ui.steps.innerHTML = '';

  if (steps.length === 0) {
    ui.empty.style.display = 'block';
    return;
  }
  ui.empty.style.display = 'none';
  ui.steps.appendChild(renderStepList(steps, []));
}

function renderStepList(list, path) {
  const wrap = document.createElement('div');
  wrap.className = 'step-list';
  list.forEach((step, idx) => wrap.appendChild(buildStepRow(step, idx, list.length, path)));
  return wrap;
}

/** One branch (then/else) of an If step, with its own add-step menu. */
function buildBranch(step, childPath, key, title) {
  const list = Array.isArray(step[key]) ? step[key] : (step[key] = []);

  const wrap = document.createElement('div');
  wrap.className = 'branch';

  const head = document.createElement('div');
  head.className = 'branch-head';

  const label = document.createElement('span');
  label.className = 'branch-title';
  label.textContent = title;

  const count = document.createElement('span');
  count.className = 'branch-count';
  count.textContent = list.length ? `${list.length}` : 'empty';

  const picker = document.createElement('div');
  picker.className = 'branch-picker';

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'branch-add';
  add.textContent = '+ add step';
  add.addEventListener('click', () => {
    picker.style.display = picker.style.display === 'flex' ? 'none' : 'flex';
  });

  ADD_MENU.forEach(([action, actionLabel]) => {
    const btn = addButton(action, actionLabel);
    btn.addEventListener('click', () => {
      picker.style.display = 'none';
      onAddStep(action, childPath);
    });
    picker.appendChild(btn);
  });

  /* Reuse a step that already exists below instead of building it again. */
  const below = stepsBelow(step.id);
  if (below.length) {
    const divider = document.createElement('div');
    divider.className = 'branch-sub';
    divider.textContent = 'or move one from below';
    picker.appendChild(divider);

    below.forEach((candidate) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'add-btn small move-from-below';
      btn.dataset.moveStep = candidate.id;
      btn.textContent = stepMenuLabel(candidate);
      btn.title = 'Move this existing step in here, instead of adding a new one';
      btn.addEventListener('click', () => {
        picker.style.display = 'none';
        moveStepIntoBranch(candidate.id, step.id, key);
      });
      picker.appendChild(btn);
    });

    if (below.length > 1) {
      const all = document.createElement('button');
      all.type = 'button';
      all.className = 'add-btn small move-from-below';
      all.dataset.moveAll = '1';
      all.textContent = `move all ${below.length}`;
      all.title = 'Move every step below into this branch';
      all.addEventListener('click', () => {
        picker.style.display = 'none';
        moveAllIntoBranch(below.map((s) => s.id), step.id, key);
      });
      picker.appendChild(all);
    }
  }

  head.appendChild(label);
  head.appendChild(count);
  head.appendChild(add);
  wrap.appendChild(head);
  wrap.appendChild(picker);
  wrap.appendChild(renderStepList(list, childPath));
  return wrap;
}

/** Editor for an If step's condition. */
function buildConditionEditor(step) {
  const cond = step.condition || (step.condition = defaultCondition());

  const wrap = document.createElement('div');
  wrap.className = 'condition';

  const commit = (patch) => {
    Object.assign(cond, patch);
    persist();
    renderSteps();
    updateSummaries();
  };

  wrap.appendChild(
    fieldRow('Type', selectInput(CONDITION_TYPES, cond.type || 'exists', (v) => commit({ type: v })))
  );

  if (cond.type === 'url') {
    wrap.appendChild(
      fieldRow('Pattern', textInput(cond.pattern || '', (v) => { cond.pattern = v; schedulePersist(); }))
    );
  } else if (cond.type === 'urlChanged') {
    const hint = document.createElement('div');
    hint.className = 'target-label';
    hint.textContent = 'True when the URL differs from the previous loop iteration.';
    wrap.appendChild(hint);
  } else {
    const target = document.createElement('div');
    target.className = 'target';

    if (cond.target) {
      const labelEl = document.createElement('div');
      labelEl.className = 'target-label';
      labelEl.title = cond.target.label || '';
      labelEl.textContent = cond.target.label || cond.target.selector || 'element';

      const selector = document.createElement('div');
      selector.className = 'selector';
      selector.textContent = cond.target.selector || '(no selector)';

      target.appendChild(labelEl);
      target.appendChild(selector);
    } else {
      const hint = document.createElement('div');
      hint.className = 'target-label';
      hint.textContent = 'No element picked yet.';
      target.appendChild(hint);
    }

    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'repick-btn';
    pick.textContent = cond.target ? 're-pick element' : 'pick element…';
    pick.addEventListener('click', () => startPick('if', { stepId: step.id, slot: 'condition' }));
    target.appendChild(pick);

    wrap.appendChild(target);
  }

  if (cond.type === 'exists') {
    wrap.appendChild(
      fieldRow('State', selectInput(CONDITION_STATES, cond.state || 'visible', (v) => commit({ state: v })))
    );
  }

  if (cond.type === 'text' || cond.type === 'attr') {
    if (cond.type === 'attr') {
      wrap.appendChild(
        fieldRow('Attr', textInput(cond.attr || 'href', (v) => { cond.attr = v; schedulePersist(); }))
      );
    }
    wrap.appendChild(
      fieldRow(
        'Op',
        selectInput(CONDITION_OPS, cond.op || (cond.type === 'text' ? 'contains' : 'is'), (v) => commit({ op: v }))
      )
    );
    wrap.appendChild(
      fieldRow('Value', textInput(cond.value || '', (v) => { cond.value = v; schedulePersist(); }))
    );
    wrap.appendChild(checkboxRow('case', !!cond.caseSensitive, (v) => commit({ caseSensitive: v })));
  }

  wrap.appendChild(checkboxRow('not', !!cond.negate, (v) => commit({ negate: v })));
  return wrap;
}

/** Clamp a Gamble chance to a whole 0-100; anything unusable means 50. */
function normalizeChance(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Header detail for a Gamble step, e.g. "30% chance". */
function gambleSummary(step) {
  return `${normalizeChance(step.chance)}% chance`;
}

/** A step's header text: a custom name replaces the action title, which stays visible as the detail. */
function stepHeading(step) {
  const actionName = (ACTIONS[step.action] && ACTIONS[step.action].label) || step.action;
  const name = typeof step.label === 'string' ? step.label.trim() : '';
  const detail = [
    name ? actionName : '',
    step.action === 'if' ? conditionSummary(step.condition) : '',
    step.action === 'gamble' ? gambleSummary(step) : '',
    step.action === 'switchTab' && step.mode === 'url'
      ? `${step.urlOp === 'isnot' ? 'IS NOT' : 'IS'} ${step.url || '*'}`
      : ''
  ]
    .filter(Boolean)
    .join(' · ');
  return { title: name || actionName, detail, custom: !!name };
}

/** The Chance field of a Gamble step: how often its Succeeds branch runs. */
function buildGambleEditor(step, applyHeading) {
  const wrap = document.createElement('div');
  wrap.className = 'gamble';

  wrap.appendChild(
    fieldRow(
      'Chance',
      numberField(
        normalizeChance(step.chance),
        '%',
        (v) => {
          updateStep(step.id, { chance: normalizeChance(v) });
          applyHeading();
        },
        { min: 0, max: 100, step: 1 }
      )
    )
  );

  const hint = hintSpan('run the steps below this often — otherwise they are skipped');
  hint.style.textTransform = 'none';
  wrap.appendChild(hint);
  return wrap;
}

/** The per-step Name field — renames the step without hiding what it actually does. */
function buildNameRow(step, applyHeading) {
  const input = textInput(step.label || '', (v) => {
    updateStep(step.id, { label: v });
    applyHeading();
  });
  input.placeholder = (ACTIONS[step.action] && ACTIONS[step.action].label) || step.action;
  return fieldRow('Name', input);
}

function buildStepRow(step, idx, total, path) {
  const row = document.createElement('div');
  row.className = 'step';
  row.dataset.stepId = step.id;

  const head = document.createElement('div');
  head.className = 'step-head';

  const index = document.createElement('span');
  index.className = 'step-index';
  index.textContent = String(idx + 1);

  const heading = stepHeading(step);

  const action = document.createElement('span');
  action.className = 'step-action' + (heading.custom ? ' custom' : '');
  action.textContent = heading.title;
  action.title = heading.title;

  const sub = document.createElement('span');
  sub.className = 'step-sub';
  sub.textContent = heading.detail;
  sub.title = heading.detail;
  sub.style.display = heading.detail ? '' : 'none';

  /** Re-read the step and patch the header in place (no re-render, so focus survives). */
  const applyHeading = () => {
    const next = stepHeading(step);
    action.textContent = next.title;
    action.title = next.title;
    action.classList.toggle('custom', next.custom);
    sub.textContent = next.detail;
    sub.title = next.detail;
    sub.style.display = next.detail ? '' : 'none';
  };

  const tools = document.createElement('div');
  tools.className = 'step-tools';
  tools.appendChild(toolBtn('↑', 'Move up', () => moveStep(step.id, -1), idx === 0));
  tools.appendChild(toolBtn('↓', 'Move down', () => moveStep(step.id, 1), idx === total - 1));
  tools.appendChild(toolBtn('✕', 'Delete step', () => removeStep(step.id)));

  head.appendChild(index);
  head.appendChild(action);
  head.appendChild(sub);
  head.appendChild(tools);
  row.appendChild(head);

  const body = document.createElement('div');
  body.className = 'step-body';

  if (step.action === 'if' || step.action === 'gamble') {
    body.appendChild(step.action === 'if' ? buildConditionEditor(step) : buildGambleEditor(step, applyHeading));
    body.appendChild(buildBranch(step, path.concat([idx, 'then']), 'then', step.action === 'if' ? 'Then' : 'Succeeds'));
    body.appendChild(buildBranch(step, path.concat([idx, 'else']), 'else', step.action === 'if' ? 'Else' : 'Fails'));
  } else if (step.action === 'waitChange') {
    const watch = step.watch || 'url';
    body.appendChild(
      fieldRow(
        'Watch',
        selectInput(
          [
            ['url', 'Page URL'],
            ['element', 'Element text']
          ],
          watch,
          (v) => {
            updateStep(step.id, { watch: v });
            persist();
            renderSteps();
          }
        )
      )
    );

    if (watch === 'element') {
      body.appendChild(buildTargetBlock(step));
      body.appendChild(matchModeRow(step));
    } else {
      body.appendChild(checkboxRow('since last loop', step.sinceLoop !== false, (v) => updateStep(step.id, { sinceLoop: v })));
    }

    const changeTimeout = fieldRow(
      'Timeout',
      secondsField(step.timeout == null ? 20000 : step.timeout, (ms) => updateStep(step.id, { timeout: ms }))
    );
    changeTimeout.appendChild(hintSpan('0 = forever'));
    body.appendChild(changeTimeout);
    body.appendChild(
      fieldRow('Every', secondsField(step.interval == null ? 300 : step.interval, (ms) => updateStep(step.id, { interval: ms })))
    );
    body.appendChild(checkboxRow('optional', step.optional === true, (v) => updateStep(step.id, { optional: v })));
  } else if (step.action === 'click' || step.action === 'type' || step.action === 'press' || step.action === 'hover') {
    body.appendChild(buildTargetBlock(step));
    body.appendChild(matchModeRow(step));
    if (step.action !== 'hover') {
      body.appendChild(
        fieldRow('Scan', secondsField(step.scanMs || 0, (ms) => updateStep(step.id, { scanMs: ms })))
      );
    }
  } else if (step.action === 'scan') {
    body.appendChild(buildTargetBlock(step));
    body.appendChild(matchModeRow(step));
    const scanTimeout = fieldRow(
      'Timeout',
      secondsField(step.timeout == null ? 10000 : step.timeout, (ms) => updateStep(step.id, { timeout: ms }))
    );
    scanTimeout.appendChild(hintSpan('0 = forever'));
    body.appendChild(scanTimeout);
    body.appendChild(
      fieldRow('Every', secondsField(step.interval == null ? 250 : step.interval, (ms) => updateStep(step.id, { interval: ms })))
    );
    body.appendChild(checkboxRow('optional', step.optional === true, (v) => updateStep(step.id, { optional: v })));
  }

  if (step.action === 'type') {
    body.appendChild(fieldRow('Value', textInput(step.value || '', (v) => updateStep(step.id, { value: v }))));
  } else if (step.action === 'press') {
    body.appendChild(fieldRow('Key', textInput(step.key || 'Enter', (v) => updateStep(step.id, { key: v }))));
  } else if (step.action === 'hover') {
    body.appendChild(
      fieldRow('Hold', secondsField(step.ms == null ? 1000 : step.ms, (ms) => updateStep(step.id, { ms })))
    );
  } else if (step.action === 'wait') {
    const mode = step.mode === 'range' ? 'range' : step.mode === 'load' ? 'load' : 'fixed';
    body.appendChild(
      fieldRow(
        'Mode',
        selectInput(
          [
            ['fixed', 'Fixed'],
            ['range', 'Random range'],
            ['load', 'Page load']
          ],
          mode,
          (v) => {
            const patch = { mode: v };
            if (v === 'load') {
              if (step.timeout == null) patch.timeout = 30000;
              if (step.settle == null) patch.settle = 500;
            }
            updateStep(step.id, patch);
            persist();
            renderSteps();
          }
        )
      )
    );

    if (mode === 'range') {
      body.appendChild(
        fieldRow('Min', secondsField(step.min == null ? 500 : step.min, (ms) => updateStep(step.id, { min: ms })))
      );
      body.appendChild(
        fieldRow('Max', secondsField(step.max == null ? 1500 : step.max, (ms) => updateStep(step.id, { max: ms })))
      );
      const hint = hintSpan('random between Min and Max');
      hint.style.textTransform = 'none';
      body.appendChild(hint);
    } else if (mode === 'load') {
      const loadTimeout = fieldRow(
        'Timeout',
        secondsField(step.timeout == null ? 30000 : step.timeout, (ms) => updateStep(step.id, { timeout: ms }))
      );
      loadTimeout.appendChild(hintSpan('0 = forever'));
      body.appendChild(loadTimeout);

      const quiet = fieldRow(
        'Quiet',
        secondsField(step.settle == null ? 500 : step.settle, (ms) => updateStep(step.id, { settle: ms }))
      );
      const quietHint = hintSpan('no new loads for this long');
      quietHint.style.textTransform = 'none';
      quiet.appendChild(quietHint);
      body.appendChild(quiet);

      body.appendChild(checkboxRow('optional', step.optional === true, (v) => updateStep(step.id, { optional: v })));
    } else {
      body.appendChild(
        fieldRow('Sec', secondsField(step.ms || 0, (ms) => updateStep(step.id, { ms })))
      );
    }
  } else if (step.action === 'scroll') {
    body.appendChild(buildScrollTarget(step));
    body.appendChild(
      fieldRow(
        'Mode',
        selectInput(
          [
            ['amount', 'By amount'],
            ['bottom', 'To bottom'],
            ['top', 'To top']
          ],
          step.scope || (step.toEnd ? 'bottom' : 'amount'),
          (v) => {
            updateStep(step.id, { scope: v });
            persist();
            renderSteps();
          }
        )
      )
    );

    if ((step.scope || 'amount') === 'amount') {
      body.appendChild(
        fieldRow(
          'Dir',
          selectInput(
            [
              ['down', 'Down'],
              ['up', 'Up']
            ],
            step.direction || 'down',
            (v) => updateStep(step.id, { direction: v })
          )
        )
      );
      body.appendChild(fieldRow('Px', numberField(step.amount == null ? 600 : step.amount, 'px', (v) => updateStep(step.id, { amount: v }))));
    }

    body.appendChild(
      fieldRow('Time', secondsField(step.duration == null ? 0 : step.duration, (ms) => updateStep(step.id, { duration: ms })))
    );
    if (step.target) body.appendChild(matchModeRow(step));
  } else if (step.action === 'navigate') {
    body.appendChild(urlField(step));
  } else if (step.action === 'openTab') {
    body.appendChild(urlField(step));
    body.appendChild(checkboxRow('activate', step.activate !== false, (v) => updateStep(step.id, { activate: v })));
  } else if (step.action === 'browser') {
    const command = step.command || 'newTab';
    body.appendChild(
      fieldRow(
        'Cmd',
        selectInput(BROWSER_COMMANDS, command, (v) => {
          updateStep(step.id, { command: v });
          persist();
          renderSteps();
        })
      )
    );
    if (BROWSER_URL_COMMANDS.includes(command)) {
      body.appendChild(urlField(step));
    }
    if (BROWSER_ACTIVATE_COMMANDS.includes(command)) {
      body.appendChild(checkboxRow('activate', step.activate !== false, (v) => updateStep(step.id, { activate: v })));
    }
  } else if (step.action === 'switchTab') {
    body.appendChild(
      fieldRow(
        'To',
        selectInput(
          [
            ['newest', 'Newest tab'],
            ['previous', 'Previous tab'],
            ['url', 'By URL']
          ],
          step.mode || 'newest',
          (v) => {
            updateStep(step.id, { mode: v });
            persist();
            renderSteps();
          }
        )
      )
    );
    if ((step.mode || 'newest') === 'url') {
      body.appendChild(
        fieldRow(
          'Match',
          selectInput(
            [
              ['is', 'IS'],
              ['isnot', 'IS NOT']
            ],
            step.urlOp || 'is',
            (v) => updateStep(step.id, { urlOp: v })
          )
        )
      );
      body.appendChild(urlField(step));
    }
    body.appendChild(checkboxRow('activate', step.activate !== false, (v) => updateStep(step.id, { activate: v })));
  }

  body.appendChild(buildNameRow(step, applyHeading));

  row.appendChild(body);
  wireDragToReorder(row, step, body);
  return row;
}

function buildTargetBlock(step) {
  const wrap = document.createElement('div');
  wrap.className = 'target';

  if (step.target) {
    const label = document.createElement('div');
    label.className = 'target-label';
    label.title = step.target.label || '';
    label.textContent = step.target.label || step.target.selector || 'element';

    const selector = document.createElement('div');
    selector.className = 'selector';
    selector.title = step.target.selector || '';
    selector.textContent = step.target.selector || '(no selector)';

    wrap.appendChild(label);
    wrap.appendChild(selector);
  } else {
    const missing = document.createElement('div');
    missing.className = 'target-label';
    missing.textContent = 'No element picked';
    wrap.appendChild(missing);
  }

  const repick = document.createElement('button');
  repick.className = 'repick-btn';
  repick.textContent = 're-pick element';
  repick.addEventListener('click', () => startPick(step.action, { stepId: step.id }));
  wrap.appendChild(repick);

  return wrap;
}

function buildScrollTarget(step) {
  const wrap = document.createElement('div');
  wrap.className = 'target';

  if (step.target) {
    const label = document.createElement('div');
    label.className = 'target-label';
    label.title = step.target.label || '';
    label.textContent = step.target.label || step.target.selector || 'element';

    const selector = document.createElement('div');
    selector.className = 'selector';
    selector.textContent = step.target.selector || '(no selector)';

    wrap.appendChild(label);
    wrap.appendChild(selector);
  } else {
    const hint = document.createElement('div');
    hint.className = 'target-label';
    hint.textContent = 'Scroll the page, or pick an element to scroll to:';
    wrap.appendChild(hint);
  }

  const pick = document.createElement('button');
  pick.className = 'repick-btn';
  pick.textContent = step.target ? 're-pick element' : 'scroll to element…';
  pick.addEventListener('click', () => startPick('scroll', { stepId: step.id }));
  wrap.appendChild(pick);

  if (step.target) {
    const clear = document.createElement('button');
    clear.className = 'repick-btn';
    clear.textContent = 'clear (scroll by amount)';
    clear.addEventListener('click', () => {
      updateStep(step.id, { target: null });
      persist();
      renderSteps();
    });
    wrap.appendChild(clear);
  }

  return wrap;
}

function matchModeRow(step) {
  const row = document.createElement('div');
  row.className = 'field-row';

  const label = document.createElement('span');
  label.className = 'field-label';
  label.textContent = 'Match';

  const wrap = document.createElement('label');
  wrap.className = 'checkbox-inline';
  wrap.title = 'Off = match by structure (id, classes, position) so a changing label still matches. On = text is also used.';

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!step.textMatch;
  cb.addEventListener('change', () => {
    updateStep(step.id, { textMatch: cb.checked });
    log(cb.checked ? 'Matching by text as well as structure.' : 'Matching by structure only (ignores text).');
  });

  const text = document.createElement('span');
  text.textContent = 'also match by text';

  wrap.appendChild(cb);
  wrap.appendChild(text);
  row.appendChild(label);
  row.appendChild(wrap);
  return row;
}

function toolBtn(text, title, onClick, disabled) {
  const btn = document.createElement('button');
  btn.className = 'tool-btn';
  btn.textContent = text;
  btn.title = title;
  btn.disabled = !!disabled;
  btn.addEventListener('click', onClick);
  return btn;
}

function hintSpan(text) {
  const span = document.createElement('span');
  span.className = 'field-label';
  span.textContent = text;
  return span;
}

/** A URL field that also accepts the ThisURL token (the page the macro started on). */
function urlField(step) {
  const wrap = document.createElement('div');
  wrap.className = 'url-field';

  const hint = document.createElement('div');
  hint.className = 'field-hint';

  // When the field uses the token, show what it currently resolves to (the page a
  // run started on if you pressed Run now), so it isn't a mystery.
  const refreshHint = (value) => {
    if (!String(value || '').includes('ThisURL')) {
      hint.textContent = 'ThisURL = the page the run starts on';
      return;
    }
    hint.textContent = 'ThisURL = …';
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(([t]) => {
        hint.textContent = `ThisURL = ${(t && t.url) || 'the page the run starts on'}`;
      })
      .catch(() => {
        hint.textContent = 'ThisURL = the page the run starts on';
      });
  };

  const input = textInput(step.url || '', (v) => {
    updateStep(step.id, { url: v });
    refreshHint(v);
  });

  wrap.appendChild(fieldRow('URL', input));
  wrap.appendChild(hint);
  refreshHint(step.url);
  return wrap;
}

/* Times are stored in milliseconds but shown/edited in seconds. */
function msToSec(value) {
  const seconds = (Number(value) || 0) / 1000;
  return String(Math.round(seconds * 1000) / 1000);
}

function secToMs(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
}

/** A number input with its unit shown right after it, e.g. "5 s" or "600 px". */
function numberField(value, unit, onChange, opts) {
  const options = opts || {};
  const wrap = document.createElement('div');
  wrap.className = 'num-field';

  const input = document.createElement('input');
  input.className = 'step-input';
  input.type = 'number';
  input.min = String(options.min == null ? 0 : options.min);
  if (options.max != null) input.max = String(options.max);
  input.step = String(options.step == null ? 1 : options.step);
  input.value = String(value);
  input.addEventListener('input', () => onChange(Number(input.value) || 0));
  wrap.appendChild(input);

  if (unit) {
    const suffix = document.createElement('span');
    suffix.className = 'num-suffix' + (unit === '%' ? ' tight' : '');
    suffix.textContent = unit;
    wrap.appendChild(suffix);
  }
  return wrap;
}

/** A duration field: edited in seconds, reported in milliseconds. */
function secondsField(valueMs, onChangeMs, unit) {
  return numberField(msToSec(valueMs), unit || 's', (seconds) => onChangeMs(secToMs(seconds)), { min: 0, step: 0.1 });
}

function fieldRow(labelText, input) {
  const row = document.createElement('div');
  row.className = 'field-row';

  const label = document.createElement('span');
  label.className = 'field-label';
  label.textContent = labelText;

  row.appendChild(label);
  row.appendChild(input);
  return row;
}

function textInput(value, onChange) {
  const input = document.createElement('input');
  input.className = 'step-input';
  input.type = 'text';
  input.value = value;
  input.addEventListener('input', () => onChange(input.value));
  return input;
}

function checkboxRow(labelText, checked, onChange) {
  const row = document.createElement('div');
  row.className = 'field-row';

  const label = document.createElement('span');
  label.className = 'field-label';
  label.textContent = labelText;

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!checked;
  cb.style.accentColor = '#22c55e';
  cb.addEventListener('change', () => onChange(cb.checked));

  row.appendChild(label);
  row.appendChild(cb);
  return row;
}

function selectInput(options, value, onChange) {
  const select = document.createElement('select');
  select.className = 'step-input';
  for (const [val, label] of options) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = label;
    if (val === value) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

function renderStatus() {
  ui.statusDot.classList.toggle('running', state.running);
  ui.statusDot.classList.toggle('armed', state.armed && !state.running);

  ui.runBtn.disabled = state.running;
  // Never lock Stop out: a run started elsewhere must always be stoppable.
  ui.stopBtn.disabled = false;
}

/* ---------------------------------------------------------------- *
 *  Log                                                             *
 * ---------------------------------------------------------------- */

function hostOf(url) {
  try {
    return new URL(url).host || url;
  } catch (_) {
    return url || 'new tab';
  }
}

/** One rendered activity-log line. */
function buildLogLine(entry) {
  const line = document.createElement('div');
  line.className = 'log-line' + (entry.kind ? ' ' + entry.kind : '');
  const time = document.createElement('span');
  time.className = 't';
  time.textContent = entry.time;
  line.appendChild(time);
  line.appendChild(document.createTextNode(entry.text));
  return line;
}

function log(text, kind) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const entry = {
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
    text,
    kind: kind || ''
  };
  state.logs.push(entry);
  // Append just the new line rather than rebuilding the whole list — a busy loop
  // emits hundreds of entries, and the full innerHTML rebuild was the lag.
  if (state.logs.length > 300) {
    state.logs.shift();
    if (ui.log.firstElementChild) ui.log.removeChild(ui.log.firstElementChild);
  }
  ui.log.appendChild(buildLogLine(entry));
  ui.log.scrollTop = ui.log.scrollHeight;
  updateSummaries();
}

/* ------------------------------------------------------------------ *
 *  Export / import                                                    *
 * ------------------------------------------------------------------ */

const EXPORT_VERSION = 1;

function fileStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Save text as a file. Falls back to a data: URL if blob URLs aren't available. */
function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  let url = '';
  try {
    url = URL.createObjectURL(blob);
  } catch (_) {}
  const link = document.createElement('a');
  link.href = url || 'data:application/json;charset=utf-8,' + encodeURIComponent(text);
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  if (url) setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function exportPayload() {
  return {
    app: 'clicker',
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    selectedMacroId: state.selectedId,
    macros: state.macros
  };
}

function exportMacros() {
  downloadText(`clicker-macros-${fileStamp()}.json`, JSON.stringify(exportPayload(), null, 2));
  log(`Exported ${state.macros.length} macro${state.macros.length === 1 ? '' : 's'}`, 'ok');
}

function sanitizeSteps(list) {
  return (Array.isArray(list) ? list : []).map((raw) => {
    const step = Object.assign({}, raw);
    step.id = typeof step.id === 'string' && step.id ? step.id : uid();
    if (isBranchStep(step)) {
      if (step.action === 'if') step.condition = step.condition || defaultCondition();
      if (step.action === 'gamble') step.chance = normalizeChance(step.chance);
      step.then = sanitizeSteps(step.then);
      step.else = sanitizeSteps(step.else);
    }
    return step;
  });
}

function sanitizeMacro(raw) {
  const macro = Object.assign({}, raw);
  macro.id = typeof macro.id === 'string' && macro.id ? macro.id : uid();
  macro.name = typeof macro.name === 'string' && macro.name ? macro.name : 'Imported macro';
  macro.steps = sanitizeSteps(macro.steps);
  if (typeof macro.createdAt !== 'number') macro.createdAt = Date.now();
  return macro;
}

/** Accepts an export payload, a bare array of macros, or a single macro. */
function parseMacroFile(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    throw new Error('that file is not valid JSON');
  }
  const list = Array.isArray(data)
    ? data
    : data && Array.isArray(data.macros)
      ? data.macros
      : data && typeof data === 'object' && (data.steps || data.name)
        ? [data]
        : null;

  if (!list || !list.length) throw new Error('no macros found in that file');
  return list.map(sanitizeMacro);
}

function hideImportChoice() {
  ui.importChoice.style.display = 'none';
  ui.importInfo.textContent = '';
}

function onImportFileChosen() {
  const file = ui.importFile.files && ui.importFile.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    try {
      state.pendingImport = parseMacroFile(String(reader.result));
      const n = state.pendingImport.length;
      ui.importInfo.textContent = `${n} macro${n === 1 ? '' : 's'} ready`;
      ui.importChoice.style.display = 'flex';
      log(`Read ${n} macro(s) from ${file.name}`);
    } catch (err) {
      state.pendingImport = null;
      hideImportChoice();
      log(`Import failed — ${err.message}`, 'err');
    }
  };
  reader.onerror = () => log('Import failed — could not read that file', 'err');
  reader.readAsText(file);
}

async function applyImport(mode) {
  const incoming = state.pendingImport || [];
  state.pendingImport = null;
  hideImportChoice();
  if (!incoming.length) return;

  if (mode === 'replace') {
    state.macros = incoming;
    state.selectedId = incoming[0].id;
    log(`Replaced all macros with ${incoming.length} imported macro(s)`, 'ok');
  } else {
    const taken = new Set(state.macros.map((m) => m.id));
    for (const macro of incoming) {
      if (taken.has(macro.id)) macro.id = uid();
      state.macros.push(macro);
      taken.add(macro.id);
    }
    log(`Merged in ${incoming.length} macro(s)`, 'ok');
  }

  await persist();
  render();
}

function renderLog() {
  ui.log.innerHTML = '';
  for (const entry of state.logs) ui.log.appendChild(buildLogLine(entry));
  ui.log.scrollTop = ui.log.scrollHeight;
}
