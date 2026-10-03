'use strict';

/*
 * Macro-file handling. Mirrors the shapes the extension's Backup panel accepts:
 * a full export payload ({ app:'clicker', macros:[...] }), a bare array of
 * macros, or a single macro object.
 */

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function sanitizeMacro(raw) {
  const m = { ...raw };
  m.id = typeof m.id === 'string' && m.id ? m.id : uid();
  m.name = typeof m.name === 'string' && m.name ? m.name : 'Imported macro';
  if (!Array.isArray(m.steps)) m.steps = [];
  if (typeof m.createdAt !== 'number') m.createdAt = Date.now();
  return m;
}

function parseMacroFile(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('that file is not valid JSON');
  }
  let list;
  if (Array.isArray(data)) list = data;
  else if (data && Array.isArray(data.macros)) list = data.macros;
  else if (data && typeof data === 'object' && (Array.isArray(data.steps) || typeof data.name === 'string')) list = [data];
  else throw new Error('expected a Clicker export, an array of macros, or a single macro');
  return list.map(sanitizeMacro);
}

/** Merge incoming macros into existing ones, re-minting any colliding ids. */
function mergeMacros(existing, incoming) {
  const taken = new Set(existing.map((m) => m.id));
  const out = existing.slice();
  for (const macro of incoming) {
    const copy = taken.has(macro.id) ? { ...macro, id: uid() } : macro;
    taken.add(copy.id);
    out.push(copy);
  }
  return out;
}

module.exports = { uid, sanitizeMacro, parseMacroFile, mergeMacros };
