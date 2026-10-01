/**
 * Clicker — side panel UI.
 * Owns the macro/step model in chrome.storage.local and drives the background
 * worker for picking and running.
 */

const ACTIONS = {
  click: { label: 'Click', pick: true },
  type: { label: 'Type', pick: true },
  press: { label: 'Key press', pick: true },
  scan: { label: 'Scan', pick: true },
  wait: { label: 'Wait', pick: false },
  scroll: { label: 'Scroll', pick: false },
  navigate: { label: 'Go to URL', pick: false },
  openTab: { label: 'Open tab', pick: false },
  switchTab: { label: 'Switch tab', pick: false },
  browser: { label: 'Browser', pick: false }
};

/** Browser-wide shortcuts, performed with the real APIs (synthetic keys are ignored by Chrome). */
const BROWSER_COMMANDS = [
  ['newTab', 'New tab (Ctrl+T)'],
  ['closeTab', 'Close tab (Ctrl+W)'],
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

const state = {
  macros: [],
  selectedId: null,
  running: false,
  armed: false,
  replaceStepId: null,
  logs: []
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

  bindEvents();

  const stored = await chrome.storage.local.get(['macros', 'selectedMacroId']);
  state.macros = Array.isArray(stored.macros) ? stored.macros : [];
  state.selectedId = stored.selectedMacroId || null;

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
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  log('Ready. Pick an element to start building.', 'dim');
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

function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persist, 400);
}

function persist() {
  return chrome.storage.local.set({ macros: state.macros, selectedMacroId: state.selectedId });
}

function addStep(step) {
  const macro = currentMacro();
  if (!macro) return;
  macro.steps.push(Object.assign({ id: uid() }, step));
  persist();
  renderSteps();
  renderMacroSelect();
}

function updateStep(stepId, patch) {
  const macro = currentMacro();
  if (!macro) return;
  const step = macro.steps.find((s) => s.id === stepId);
  if (!step) return;
  Object.assign(step, patch);
  schedulePersist();
}

function removeStep(stepId) {
  const macro = currentMacro();
  if (!macro) return;
  macro.steps = macro.steps.filter((s) => s.id !== stepId);
  persist();
  renderSteps();
  renderMacroSelect();
}

function moveStep(stepId, dir) {
  const macro = currentMacro();
  if (!macro) return;
  const idx = macro.steps.findIndex((s) => s.id === stepId);
  const next = idx + dir;
  if (idx === -1 || next < 0 || next >= macro.steps.length) return;
  [macro.steps[idx], macro.steps[next]] = [macro.steps[next], macro.steps[idx]];
  persist();
  renderSteps();
}

/* ---------------------------------------------------------------- *
 *  Events                                                          *
 * ---------------------------------------------------------------- */

function bindEvents() {
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
    btn.addEventListener('click', () => onAddStep(btn.dataset.add));
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
    macro.autoDelay = Number(ui.autoDelay.value) || 0;
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
    macro.loopInterval = Number(ui.loopInterval.value) || 0;
    schedulePersist();
  });

  ui.followToggle.addEventListener('change', () => {
    const macro = currentMacro();
    if (!macro) return;
    macro.followTabs = ui.followToggle.checked;
    persist();
    log(macro.followTabs ? 'Following new tabs.' : 'Staying on the tab the macro started on.');
  });

  $('#btn-clear-log').addEventListener('click', () => {
    state.logs = [];
    renderLog();
  });
}

function onAddStep(action) {
  if (ACTIONS[action] && ACTIONS[action].pick) {
    startPick(action);
    return;
  }
  if (action === 'wait') {
    addStep({ action: 'wait', ms: 1000 });
  } else if (action === 'scroll') {
    addStep({ action: 'scroll', scope: 'amount', direction: 'down', amount: 600, duration: 0 });
  } else if (action === 'openTab') {
    addStep({ action: 'openTab', url: 'https://', activate: true });
    renderSteps();
    const urlInput = ui.steps.querySelector('.step:last-child .step-input');
    if (urlInput) urlInput.focus();
  } else if (action === 'browser') {
    addStep({ action: 'browser', command: 'newTab', url: '', activate: true });
  } else if (action === 'switchTab') {
    addStep({ action: 'switchTab', mode: 'newest', url: '', activate: true });
  } else if (action === 'navigate') {
    addStep({ action: 'navigate', url: 'https://' });
    renderSteps();
    const input = ui.steps.querySelector('.step:last-child .step-input');
    if (input) input.focus();
  }
}

function startPick(action, replaceStepId = null) {
  state.replaceStepId = replaceStepId;
  state.armed = true;
  renderStatus();
  chrome.runtime.sendMessage({ type: 'ARM_PICKER', mode: action });
  log(`Picking element to ${ACTIONS[action].label.toLowerCase()}… click it on the page.`, 'dim');
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

    if (state.replaceStepId) {
      updateStep(state.replaceStepId, { target: msg.target });
      log(`Re-picked: ${msg.target.label}`, 'ok');
      state.replaceStepId = null;
      persist();
      renderSteps();
    } else {
      const base = { action, target: msg.target };
      if (action === 'type') base.value = '';
      if (action === 'press') base.key = 'Enter';
      if (action === 'scan') {
        base.timeout = 10000;
        base.interval = 250;
        base.optional = false;
      }
      addStep(base);
      log(`Added ${ACTIONS[action].label} step → ${msg.target.label}`, 'ok');
    }
    renderStatus();

  } else if (msg.type === 'PICK_CANCELLED' || (msg.type === 'PICK_STATUS' && msg.state !== 'armed')) {
    state.armed = false;
    state.replaceStepId = null;
    renderStatus();
    if (msg.type === 'PICK_STATUS' && msg.error) log(msg.error, 'err');

  } else if (msg.type === 'PICK_STATUS' && msg.state === 'armed') {
    state.armed = true;
    renderStatus();

  } else if (msg.type === 'NOTE') {
    log(msg.text, 'dim');

  } else if (msg.type === 'TAB_CHANGED') {
    log(`Tab → ${hostOf(msg.url)}`, 'ok');

  } else if (msg.type === 'RUN_LOOP') {
    log(`Loop ${msg.iteration}${msg.total ? ' of ' + msg.total : ''}`, 'dim');

  } else if (msg.type === 'RUN_PROGRESS') {
    const tag = msg.iteration ? `[${msg.iteration}${msg.iterations ? '/' + msg.iterations : ''}] ` : '';
    const where = msg.url ? ` · ${hostOf(msg.url)}` : '';
    const label = msg.action === 'browser' && msg.command ? BROWSER_LABELS[msg.command] : ACTIONS[msg.action] ? ACTIONS[msg.action].label : msg.action;
    log(`${tag}Step ${msg.index + 1}/${msg.total} — ${label}${where}`);

  } else if (msg.type === 'RUN_STATUS') {
    if (msg.state === 'running') {
      state.running = true;
      log(`Running "${msg.name}"${msg.auto ? ' (auto)' : ''}${msg.loop ? ' (looping)' : ''}…`, 'ok');
    } else if (msg.state === 'done') {
      state.running = false;
      log(msg.loops && msg.loops !== 1 ? `Finished "${msg.name}" after ${msg.loops} loops.` : `Finished "${msg.name}".`, 'ok');
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
}

function renderLoop() {
  const macro = currentMacro();
  if (!macro) return;
  ui.loopToggle.checked = !!macro.loop;
  ui.loopCount.value = String(macro.loopCount == null ? 0 : macro.loopCount);
  ui.loopInterval.value = String(macro.loopInterval == null ? 1000 : macro.loopInterval);
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
  ui.autoDelay.value = String(macro.autoDelay == null ? 500 : macro.autoDelay);
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

  steps.forEach((step, idx) => {
    ui.steps.appendChild(buildStepRow(step, idx, steps.length));
  });
}

function buildStepRow(step, idx, total) {
  const row = document.createElement('div');
  row.className = 'step';

  const head = document.createElement('div');
  head.className = 'step-head';

  const index = document.createElement('span');
  index.className = 'step-index';
  index.textContent = String(idx + 1);

  const action = document.createElement('span');
  action.className = 'step-action';
  action.textContent = (ACTIONS[step.action] && ACTIONS[step.action].label) || step.action;

  const tools = document.createElement('div');
  tools.className = 'step-tools';
  tools.appendChild(toolBtn('↑', 'Move up', () => moveStep(step.id, -1), idx === 0));
  tools.appendChild(toolBtn('↓', 'Move down', () => moveStep(step.id, 1), idx === total - 1));
  tools.appendChild(toolBtn('✕', 'Delete step', () => removeStep(step.id)));

  head.appendChild(index);
  head.appendChild(action);
  head.appendChild(tools);
  row.appendChild(head);

  const body = document.createElement('div');
  body.className = 'step-body';

  if (step.action === 'click' || step.action === 'type' || step.action === 'press') {
    body.appendChild(buildTargetBlock(step));
    body.appendChild(matchModeRow(step));
    body.appendChild(
      fieldRow('Scan ms', numberInput(step.scanMs || 0, (v) => updateStep(step.id, { scanMs: v })))
    );
  } else if (step.action === 'scan') {
    body.appendChild(buildTargetBlock(step));
    body.appendChild(matchModeRow(step));
    body.appendChild(
      fieldRow('Timeout', numberInput(step.timeout == null ? 10000 : step.timeout, (v) => updateStep(step.id, { timeout: v })))
    );
    body.appendChild(
      fieldRow('Every', numberInput(step.interval == null ? 250 : step.interval, (v) => updateStep(step.id, { interval: v })))
    );
    body.appendChild(checkboxRow('optional', step.optional === true, (v) => updateStep(step.id, { optional: v })));
  }

  if (step.action === 'type') {
    body.appendChild(fieldRow('Value', textInput(step.value || '', (v) => updateStep(step.id, { value: v }))));
  } else if (step.action === 'press') {
    body.appendChild(fieldRow('Key', textInput(step.key || 'Enter', (v) => updateStep(step.id, { key: v }))));
  } else if (step.action === 'wait') {
    body.appendChild(
      fieldRow('ms', numberInput(step.ms || 0, (v) => updateStep(step.id, { ms: v })))
    );
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
      body.appendChild(fieldRow('Px', numberInput(step.amount == null ? 600 : step.amount, (v) => updateStep(step.id, { amount: v }))));
    }

    body.appendChild(
      fieldRow('Time', numberInput(step.duration == null ? 0 : step.duration, (v) => updateStep(step.id, { duration: v })))
    );
    if (step.target) body.appendChild(matchModeRow(step));
  } else if (step.action === 'navigate') {
    body.appendChild(fieldRow('URL', textInput(step.url || '', (v) => updateStep(step.id, { url: v }))));
  } else if (step.action === 'openTab') {
    body.appendChild(fieldRow('URL', textInput(step.url || '', (v) => updateStep(step.id, { url: v }))));
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
      body.appendChild(fieldRow('URL', textInput(step.url || '', (v) => updateStep(step.id, { url: v }))));
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
      body.appendChild(fieldRow('URL', textInput(step.url || '', (v) => updateStep(step.id, { url: v }))));
    }
    body.appendChild(checkboxRow('activate', step.activate !== false, (v) => updateStep(step.id, { activate: v })));
  }

  row.appendChild(body);
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
  repick.addEventListener('click', () => startPick(step.action, step.id));
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
  pick.addEventListener('click', () => startPick('scroll', step.id));
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

function numberInput(value, onChange) {
  const input = document.createElement('input');
  input.className = 'step-input';
  input.type = 'number';
  input.min = '0';
  input.step = '100';
  input.value = String(value);
  input.addEventListener('input', () => onChange(Number(input.value) || 0));
  return input;
}

function renderStatus() {
  ui.statusDot.classList.toggle('running', state.running);
  ui.statusDot.classList.toggle('armed', state.armed && !state.running);

  ui.runBtn.disabled = state.running;
  ui.stopBtn.disabled = !state.running;
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

function log(text, kind) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  state.logs.push({
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
    text,
    kind: kind || ''
  });
  if (state.logs.length > 300) state.logs.shift();
  renderLog();
}

function renderLog() {
  ui.log.innerHTML = '';
  for (const entry of state.logs) {
    const line = document.createElement('div');
    line.className = 'log-line' + (entry.kind ? ' ' + entry.kind : '');

    const time = document.createElement('span');
    time.className = 't';
    time.textContent = entry.time;

    line.appendChild(time);
    line.appendChild(document.createTextNode(entry.text));
    ui.log.appendChild(line);
  }
  ui.log.scrollTop = ui.log.scrollHeight;
}
