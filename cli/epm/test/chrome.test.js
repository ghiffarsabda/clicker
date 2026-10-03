'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const chrome = require('../src/chrome');

function tmpProfile(name) {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'epm-'));
  const p = path.join(ud, name);
  fs.mkdirSync(p);
  fs.writeFileSync(path.join(p, 'Preferences'), '{}');
  return { ud, p };
}

test('listProfiles reads info_cache and filters to real profile dirs', () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'epm-'));
  for (const dir of ['Default', 'Profile 1', 'NotAProfile']) {
    fs.mkdirSync(path.join(ud, dir));
    fs.writeFileSync(path.join(ud, dir, 'Preferences'), '{}');
  }
  const state = {
    profile: {
      info_cache: {
        Default: { name: 'Person 1', user_name: 'a@b.c' },
        'Profile 1': { name: 'Work' },
      },
    },
  };
  const list = chrome.listProfiles(ud, JSON.stringify(state));
  assert.deepEqual(list.map((p) => p.dir), ['Default', 'Profile 1']);
  assert.equal(list[0].name, 'Person 1');
  assert.equal(list[0].email, 'a@b.c');
  assert.equal(list[1].name, 'Work');
});

test('listProfiles falls back to scanning when there is no Local State', () => {
  const { ud } = tmpProfile('Profile 2');
  const list = chrome.listProfiles(ud, 'not json');
  assert.deepEqual(list.map((p) => p.dir), ['Profile 2']);
});

test('extensionState reads an installed extension from Secure Preferences', () => {
  const { p } = tmpProfile('Default');
  fs.writeFileSync(path.join(p, 'Secure Preferences'), JSON.stringify({
    extensions: { settings: { abc: { state: 1, path: '/x', manifest: { version: '1.2.3' } } } },
  }));
  const st = chrome.extensionState(p, 'abc');
  assert.equal(st.present, true);
  assert.equal(st.enabled, true);
  assert.equal(st.version, '1.2.3');
  assert.equal(chrome.extensionState(p, 'zzz').present, false);
});
