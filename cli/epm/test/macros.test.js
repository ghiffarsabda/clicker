'use strict';

const test = require('node:test');
const assert = require('node:assert');
const macros = require('../src/macros');

const sample = { id: 'a1', name: 'Checkout', steps: [{ type: 'click' }] };

test('parseMacroFile accepts export payload, bare array and single macro', () => {
  assert.equal(macros.parseMacroFile(JSON.stringify({ app: 'clicker', version: 1, macros: [sample] })).length, 1);
  assert.equal(macros.parseMacroFile(JSON.stringify([sample])).length, 1);
  assert.equal(macros.parseMacroFile(JSON.stringify(sample)).length, 1);
});

test('parseMacroFile rejects junk and unrelated objects', () => {
  assert.throws(() => macros.parseMacroFile('nope'), /not valid JSON/);
  assert.throws(() => macros.parseMacroFile('{"a":1}'), /expected a Clicker export/);
});

test('parseMacroFile fills missing id, name and steps', () => {
  const m = macros.parseMacroFile(JSON.stringify({ name: 'Only a name' }))[0];
  assert.equal(m.name, 'Only a name');
  assert.ok(m.id);
  assert.deepEqual(m.steps, []);
});

test('mergeMacros keeps everything and re-mints colliding ids', () => {
  const existing = [{ id: 'x', name: 'A', steps: [] }];
  const incoming = [{ id: 'x', name: 'B', steps: [] }, { id: 'y', name: 'C', steps: [] }];
  const out = macros.mergeMacros(existing, incoming);
  assert.equal(out.length, 3);
  assert.equal(out[0].id, 'x');
  assert.notEqual(out[1].id, 'x');
  assert.equal(out[2].id, 'y');
});
