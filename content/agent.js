/**
 * Clicker — content agent.
 * Injected on demand into the active tab. Two jobs:
 *   1. Element picking (object detection) — adapted from screenshot-tuif's hit-test.
 *   2. Step execution — replay click / type / press / wait / navigate steps.
 */
(() => {
  if (window.__CLICKER_AGENT__) return;
  window.__CLICKER_AGENT__ = true;

  let picker = null;
  let pickMode = 'click';

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'PING':
        sendResponse({ ok: true });
        return true;
      case 'ARM_PICKER':
        armPicker(msg.mode || 'click');
        sendResponse({ ok: true });
        return true;
      case 'CANCEL_PICKER':
        disarmPicker();
        sendResponse({ ok: true });
        return true;
      case 'EXECUTE_STEP':
        executeStep(msg.step)
          .then((r) => sendResponse(r))
          .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
        return true;
      case 'CANCEL_EXECUTION':
        window.__CLICKER_CANCEL__ = true;
        sendResponse({ ok: true });
        return true;
    }
    return true;
  });

  /* ------------------------------------------------------------------ *
   *  Object detection — the "which element do I click" logic            *
   * ------------------------------------------------------------------ */

  function isVisible(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
  }

  function elementAtPoint(x, y) {
    const stack = document.elementsFromPoint(x, y) || [];
    for (const el of stack) {
      if (!el || !el.tagName) continue;
      if (picker && picker.overlay.contains(el)) continue;
      if (el === document.documentElement || el === document.body) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 6 || r.height < 6) continue;
      return el;
    }
    return null;
  }

  function escapeIdent(value) {
    return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function escapeAttrValue(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function isUnique(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch (_) {
      return false;
    }
  }

  /** Structural fallback: nth-of-type chain, shortened at the nearest unique id. */
  function cssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node.id && isUnique('#' + escapeIdent(node.id))) {
        parts.unshift('#' + escapeIdent(node.id));
        break;
      }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }

  function describe(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? '#' + el.id : '';
    let cls = '';
    if (typeof el.className === 'string' && el.className.trim()) {
      cls = '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
    }
    const text = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return `<${tag}${id}${cls}>${text ? ' "' + text + '"' : ''}`;
  }

  /** Classes that look like transient state rather than identity. */
  const DYNAMIC_CLASS =
    /(^|[-_])(active|selected|open|closed|shown|hidden|disabled|loading|hover|focus|expanded|collapsed|current|checked|entered|leaving)/i;

  function stableClasses(el) {
    if (typeof el.className !== 'string') return [];
    return el.className
      .trim()
      .split(/\s+/)
      .filter((c) => c && c.length < 40 && !DYNAMIC_CLASS.test(c));
  }

  /** Text-independent identity of an element — the thing that survives a label change. */
  function buildSignature(el) {
    const attrs = {};
    for (const a of ['name', 'aria-label', 'title', 'placeholder']) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v && v.length < 60) attrs[a] = v;
    }
    return {
      tag: el.tagName.toLowerCase(),
      classes: stableClasses(el),
      role: el.getAttribute && el.getAttribute('role'),
      type: el.getAttribute && el.getAttribute('type'),
      attrs
    };
  }

  /**
   * Build an ordered list of candidate selectors.
   * Structure-based (text-independent) candidates come first so a control keeps
   * matching when its text changes; text is an opt-in last resort.
   */
  function buildTarget(el) {
    const tag = el.tagName.toLowerCase();
    const signature = buildSignature(el);
    const found = [];
    const seen = new Set();

    const push = (value, kind) => {
      if (!value || seen.has(kind + '|' + value)) return;
      let unique;
      try {
        unique = document.querySelectorAll(value).length === 1;
      } catch (_) {
        return; // invalid selector — drop it
      }
      seen.add(kind + '|' + value);
      found.push({ type: 'css', value, kind, unique });
    };

    if (el.id) push('#' + escapeIdent(el.id), 'struct');

    for (const attr of ['data-testid', 'data-test', 'data-test-id', 'data-cy', 'data-qa', 'data-id']) {
      const v = el.getAttribute && el.getAttribute(attr);
      if (v) push(`[${attr}="${escapeAttrValue(v)}"]`, 'struct');
    }

    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) push(`[aria-label="${escapeAttrValue(aria)}"]`, 'struct');

    if (signature.role) push(`[role="${escapeAttrValue(signature.role)}"]`, 'struct');

    const name = el.getAttribute && el.getAttribute('name');
    if (name) push(`${tag}[name="${escapeAttrValue(name)}"]`, 'struct');

    if (signature.type) push(`${tag}[type="${escapeAttrValue(signature.type)}"]`, 'struct');

    const placeholder = el.getAttribute && el.getAttribute('placeholder');
    if (placeholder) push(`${tag}[placeholder="${escapeAttrValue(placeholder)}"]`, 'struct');

    // Identity by class signature — survives text changes and reordering.
    if (signature.classes.length) {
      push(tag + '.' + signature.classes.map(escapeIdent).join('.'), 'struct');
      for (const cls of signature.classes.slice(0, 3)) push(`${tag}.${escapeIdent(cls)}`, 'struct');
    }

    // Structural position — text-independent, ties things out when nothing else fits.
    const path = cssPath(el);
    if (path) push(path, 'struct');

    const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (text && ['BUTTON', 'A', 'LABEL', 'SUMMARY', 'LI', 'H1', 'H2', 'H3', 'H4', 'SPAN', 'DIV'].includes(el.tagName)) {
      if (!seen.has('text|' + text)) {
        seen.add('text|' + text);
        found.push({ type: 'text', value: text, kind: 'text', unique: false });
      }
    }

    // Text-independent + unique first, then ambiguous structural, then text.
    const rank = (c) => (c.kind === 'text' ? 2 : c.unique ? 0 : 1);
    found.sort((a, b) => rank(a) - rank(b));

    return {
      selector: (found[0] && found[0].value) || path,
      fallbacks: found,
      label: describe(el),
      tag,
      signature
    };
  }

  function findByText(text) {
    const norm = (s) => (s || '').trim().replace(/\s+/g, ' ').toLowerCase();
    const wanted = norm(text);
    if (!wanted) return null;

    const nodes = document.querySelectorAll(
      'button, a, [role="button"], input[type="button"], input[type="submit"], label, summary, li, h1, h2, h3, h4, span'
    );

    let best = null;
    for (const el of nodes) {
      const own = norm(el.innerText || el.textContent);
      if (own === wanted) return el;
      if (own.includes(wanted) && (!best || own.length < best.len)) {
        best = { el, len: own.length };
      }
    }
    return best ? best.el : null;
  }

  /** How well an element matches the recorded text-independent signature. */
  function scoreBySignature(el, sig) {
    if (!sig) return 0;
    let score = 0;
    if (el.tagName.toLowerCase() === sig.tag) score += 1;
    if (sig.role && el.getAttribute('role') === sig.role) score += 2;
    if (sig.type && el.getAttribute('type') === sig.type) score += 1;
    if (sig.classes && sig.classes.length) {
      const cls = new Set(String(el.className || '').split(/\s+/).filter(Boolean));
      score += sig.classes.filter((c) => cls.has(c)).length * 2;
    }
    for (const [k, v] of Object.entries(sig.attrs || {})) {
      if (el.getAttribute(k) === v) score += 1;
    }
    return score;
  }

  /**
   * Last resort: hunt the page for the best structural lookalike of the target.
   * Refuses tag-only matches and ties, rather than clicking a possibly-wrong element.
   */
  function huntBySignature(sig) {
    if (!sig || !sig.tag) return null;

    const scored = Array.from(document.querySelectorAll(sig.tag))
      .filter(isVisible)
      .map((el) => ({ el, score: scoreBySignature(el, sig) }))
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) return null;
    if (scored[0].score < 2) return null; // a bare tag is too weak to act on
    if (scored[1] && scored[1].score === scored[0].score) return null; // ambiguous — refuse
    return scored[0].el;
  }

  function resolveTarget(target, opts = {}) {
    if (!target) return null;

    const candidates =
      Array.isArray(target.fallbacks) && target.fallbacks.length
        ? target.fallbacks
        : [{ type: 'css', value: target.selector, kind: 'struct' }];

    for (const c of candidates) {
      if (!c || !c.value) continue;
      if (c.kind === 'text' && !opts.textMatch) continue; // structure-only unless asked

      if (c.type === 'css') {
        let matches;
        try {
          matches = Array.from(document.querySelectorAll(c.value)).filter(isVisible);
        } catch (_) {
          continue;
        }
        if (matches.length === 1) return matches[0];
        if (matches.length > 1) {
          const scored = matches
            .map((el) => ({ el, score: scoreBySignature(el, target.signature) }))
            .sort((a, b) => b.score - a.score);
          if (scored[0].score > 0 && scored[0].score > (scored[1] ? scored[1].score : 0)) return scored[0].el;
        }
      } else if (c.type === 'text') {
        const el = findByText(c.value);
        if (el && isVisible(el)) return el;
      }
    }

    return huntBySignature(target.signature);
  }

  /* ------------------------------------------------------------------ *
   *  Picker overlay                                                     *
   * ------------------------------------------------------------------ */

  function armPicker(mode) {
    pickMode = mode;
    disarmPicker();

    const overlay = document.createElement('div');
    overlay.id = 'clicker-picker';
    overlay.innerHTML = `
      <div id="clicker-pick-box"></div>
      <div id="clicker-pick-label"></div>
      <div id="clicker-pick-banner">
        <span class="clicker-pick-dot"></span>
        Pick element to <b id="clicker-pick-mode"></b> — click to select, <kbd>Esc</kbd> to cancel
      </div>`;
    document.documentElement.appendChild(overlay);

    const box = overlay.querySelector('#clicker-pick-box');
    const label = overlay.querySelector('#clicker-pick-label');
    overlay.querySelector('#clicker-pick-mode').textContent =
      mode === 'type' ? 'type into' : mode === 'press' ? 'press a key on' : mode === 'scroll' ? 'scroll to' : 'click';

    const onMove = (e) => {
      const el = elementAtPoint(e.clientX, e.clientY);
      if (!el) {
        box.style.display = 'none';
        label.style.display = 'none';
        return;
      }
      const r = el.getBoundingClientRect();
      box.style.display = 'block';
      box.style.left = r.left + 'px';
      box.style.top = r.top + 'px';
      box.style.width = r.width + 'px';
      box.style.height = r.height + 'px';

      label.style.display = 'block';
      label.textContent = describe(el);
      label.style.left = Math.max(6, Math.min(window.innerWidth - 260, r.left)) + 'px';
      label.style.top = (r.top > 28 ? r.top - 24 : r.bottom + 6) + 'px';
    };

    const onMouseDown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const el = elementAtPoint(e.clientX, e.clientY);
      if (!el) return;
      const target = buildTarget(el);
      const modeUsed = pickMode;
      disarmPicker();
      try {
        chrome.runtime.sendMessage({ type: 'ELEMENT_PICKED', mode: modeUsed, target });
      } catch (_) {}
    };

    // Swallow the synthetic click the browser fires after mousedown/mouseup.
    const onClickBlock = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        disarmPicker();
        try {
          chrome.runtime.sendMessage({ type: 'PICK_CANCELLED' });
        } catch (_) {}
      }
    };

    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('click', onClickBlock, true);
    window.addEventListener('keydown', onKeyDown, true);

    picker = { overlay, onMove, onMouseDown, onClickBlock, onKeyDown };
  }

  function disarmPicker() {
    if (!picker) return;
    window.removeEventListener('mousemove', picker.onMove, true);
    window.removeEventListener('mousedown', picker.onMouseDown, true);
    window.removeEventListener('click', picker.onClickBlock, true);
    window.removeEventListener('keydown', picker.onKeyDown, true);
    picker.overlay.remove();
    picker = null;
  }

  /* ------------------------------------------------------------------ *
   *  Step execution                                                     *
   * ------------------------------------------------------------------ */

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function performClick(el) {
    const r = el.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2
    };
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ pointerId: 1, isPrimary: true }, opts)));
    } catch (_) {}
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    if (typeof el.focus === 'function') el.focus();
    try {
      el.dispatchEvent(new PointerEvent('pointerup', Object.assign({ pointerId: 1, isPrimary: true }, opts)));
    } catch (_) {}
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  /** Set value through the native setter so React/Vue controlled inputs notice it. */
  function setNativeValue(el, value) {
    if (el.isContentEditable) {
      if (typeof el.focus === 'function') el.focus();
      el.textContent = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (typeof el.focus === 'function') el.focus();
    if (descriptor && descriptor.set) descriptor.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function performPress(el, key) {
    const target = el || document.activeElement || document.body;
    const base = { key, code: key, bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent('keydown', base));
    target.dispatchEvent(new KeyboardEvent('keypress', base));
    target.dispatchEvent(new KeyboardEvent('keyup', base));
  }

  /* ------------------------------------------------------------------ *
   *  Human-like scrolling                                               *
   * ------------------------------------------------------------------ */

  function windowScroller() {
    const el = document.scrollingElement || document.documentElement;
    return {
      el,
      get: () => window.scrollY,
      max: () => Math.max(0, el.scrollHeight - window.innerHeight),
      set: (y) => window.scrollTo(0, y)
    };
  }

  function containerScroller(el) {
    return {
      el,
      get: () => el.scrollTop,
      max: () => Math.max(0, el.scrollHeight - el.clientHeight),
      set: (y) => {
        el.scrollTop = y;
      }
    };
  }

  function scrollableAncestor(el) {
    let node = el && el.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
      const st = getComputedStyle(node);
      if (/(auto|scroll|overlay)/.test(st.overflowY) && node.scrollHeight > node.clientHeight + 4) return node;
      node = node.parentElement;
    }
    return null;
  }

  /** Fire a wheel event so apps that listen for scrolling react like a real user. */
  function emitWheel(scroller, deltaY) {
    if (!deltaY) return;
    const target = scroller.el || document.scrollingElement;
    try {
      target.dispatchEvent(
        new WheelEvent('wheel', { deltaY, deltaX: 0, deltaMode: 0, bubbles: true, cancelable: true })
      );
    } catch (_) {}
  }

  const rand = (min, max) => min + Math.random() * (max - min);

  /** Cancellable wait, so Stop works during a human's mid-scroll pause. */
  async function pause(ms) {
    const end = performance.now() + ms;
    while (performance.now() < end) {
      if (window.__CLICKER_CANCEL__) return;
      await sleep(Math.min(60, end - performance.now()));
    }
  }

  function ease(style, t) {
    switch (style) {
      case 'in':
        return t * t; // hesitate, then accelerate
      case 'inout':
        return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
      case 'linear':
        return t;
      case 'stutter':
        return Math.ceil(t * 4) / 4; // moves in uneven little steps
      default:
        return 1 - (1 - t) * (1 - t); // 'out' — quick flick, coast to a stop
    }
  }

  /**
   * Plan a gesture: independently randomized flick sizes AND time shares, with
   * the occasional pause. Time shares are normalised to `dur`, so however erratic
   * the pacing looks, the gesture still finishes in the requested time.
   */
  function buildScrollPlan(dist, dur) {
    const viewport = window.innerHeight || 800;

    let n = Math.round(dist / (viewport * rand(0.35, 0.65)));
    n = Math.round(n * rand(0.8, 1.25));
    n = Math.max(3, Math.min(60, n));

    // Flick sizes: heavy-tailed — tiny nudges, normal flicks, and the odd big throw.
    const sizeWeights = [];
    for (let i = 0; i < n; i++) {
      const r = Math.random();
      if (r < 0.15) sizeWeights.push(rand(0.05, 0.2));
      else if (r < 0.75) sizeWeights.push(rand(0.6, 1.2));
      else sizeWeights.push(rand(1.6, 3.0));
    }
    const sizeTotal = sizeWeights.reduce((a, b) => a + b, 0);

    // Time shares: independent of size, so pace and distance don't correlate.
    const timeWeights = [];
    const pauseFractions = [];
    for (let i = 0; i < n; i++) {
      const r = Math.random();
      if (r < 0.2) timeWeights.push(rand(0.3, 0.6)); // quick flick
      else if (r < 0.8) timeWeights.push(rand(0.9, 1.4)); // normal
      else timeWeights.push(rand(1.6, 2.6)); // slow, deliberate
      pauseFractions.push(Math.random() < 0.2 ? rand(0.25, 0.55) : 0);
    }
    const timeTotal = timeWeights.reduce((a, b) => a + b, 0);

    const styles = ['out', 'out', 'out', 'in', 'inout', 'linear', 'stutter'];

    return sizeWeights.map((w, i) => {
      const time = (timeWeights[i] / timeTotal) * dur; // shares sum to dur
      return {
        size: (w / sizeTotal) * dist, // sizes sum to dist
        time,
        move: time * (1 - pauseFractions[i]),
        style: styles[Math.floor(Math.random() * styles.length)]
      };
    });
  }

  /**
   * Scroll a distance the way a person does — erratic flicks of varying size and
   * speed, some jittered, some pausing — but always arriving in `duration` ms.
   */
  async function humanScroll(scroller, delta, duration) {
    const start = scroller.get();
    const end = Math.max(0, Math.min(scroller.max(), start + delta));
    const total = end - start;
    const dist = Math.abs(total);
    if (dist < 1) return;

    const sign = Math.sign(total);
    const dur = duration > 0 ? duration : Math.min(6000, Math.max(220, dist * 0.5));
    const plan = buildScrollPlan(dist, dur);
    const T0 = performance.now();

    let travelled = 0; // px covered so far
    let clock = 0; // ms of the schedule consumed so far

    for (let i = 0; i < plan.length; i++) {
      if (window.__CLICKER_CANCEL__) return;

      const seg = plan[i];
      const from = start + sign * travelled;
      const to = i === plan.length - 1 ? end : from + sign * seg.size; // land exactly
      const segStart = clock;
      clock += seg.time;

      let prev = from;
      for (;;) {
        if (window.__CLICKER_CANCEL__) return;
        const local = performance.now() - T0 - segStart;
        const t = seg.move > 0 ? Math.min(1, local / seg.move) : 1;
        const y = from + (to - from) * ease(seg.style, t);
        scroller.set(y);
        emitWheel(scroller, y - prev);
        prev = y;
        if (t >= 1) break;
        await sleep(rand(7, 26)); // jittered frame cadence
      }

      // Hold the rest of this slot (a pause, and any drift correction), so the
      // whole gesture still ends exactly on time.
      const wait = T0 + clock - performance.now();
      if (wait > 0) await pause(wait);

      travelled += seg.size;
    }

    const remaining = T0 + dur - performance.now();
    if (remaining > 0) await pause(remaining);
  }

  /** Scroll an element into view (centred) using the same human motion. */
  async function scrollToElement(el, duration) {
    const container = scrollableAncestor(el);
    if (container) {
      const er = el.getBoundingClientRect();
      const cr = container.getBoundingClientRect();
      const centre = er.top - cr.top + container.scrollTop - (container.clientHeight - er.height) / 2;
      await humanScroll(containerScroller(container), centre - container.scrollTop, duration);
      return;
    }
    const er = el.getBoundingClientRect();
    const centre = window.scrollY + er.top - (window.innerHeight - er.height) / 2;
    await humanScroll(windowScroller(), centre - window.scrollY, duration);
  }

  async function runScrollStep(step) {
    const duration = Math.max(0, Number(step.duration) || 0);
    if (step.target) {
      const el = resolveTarget(step.target, { textMatch: !!step.textMatch });
      if (!el) throw new Error('Element not found: ' + ((step.target && step.target.selector) || 'unknown'));
      await scrollToElement(el, duration);
      return;
    }
    const scroller = windowScroller();
    const scope = step.scope || (step.toEnd ? 'bottom' : 'amount');

    if (scope === 'bottom' || scope === 'top') {
      const destination = scope === 'bottom' ? scroller.max() : 0;
      await humanScroll(scroller, destination - scroller.get(), duration);
      return;
    }

    const amount = Math.max(1, Number(step.amount) || 600);
    await humanScroll(scroller, (step.direction === 'up' ? -1 : 1) * amount, duration);
  }

  async function executeStep(step) {
    if (!step || !step.action) throw new Error('Invalid step');
    window.__CLICKER_CANCEL__ = false;

    if (step.action === 'wait') {
      await sleep(Math.max(0, Number(step.ms) || 0));
      return { ok: true };
    }
    if (step.action === 'navigate') {
      return { ok: true, deferred: true }; // background performs the navigation
    }
    if (step.action === 'scroll') {
      await runScrollStep(step);
      return { ok: true };
    }

    const el = resolveTarget(step.target, { textMatch: !!step.textMatch });
    if (!el) throw new Error('Element not found: ' + ((step.target && step.target.selector) || 'unknown'));

    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    await sleep(60);

    switch (step.action) {
      case 'click':
        performClick(el);
        break;
      case 'type':
        setNativeValue(el, step.value == null ? '' : String(step.value));
        break;
      case 'press':
        performPress(el, step.key || 'Enter');
        break;
      default:
        throw new Error('Unknown action: ' + step.action);
    }

    return { ok: true, matched: step.target && step.target.selector };
  }
})();
