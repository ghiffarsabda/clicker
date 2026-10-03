'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const policy = require('../src/policy');

test('buildPolicy maps id + update url into ExtensionInstallForcelist', () => {
  assert.deepEqual(policy.buildPolicy('abc', 'https://host/updates.xml'), {
    ExtensionInstallForcelist: ['abc;https://host/updates.xml'],
  });
});

test('installPlan targets the backend for this OS', () => {
  const args = { id: 'abc', updateUrl: 'https://host/updates.xml', browserId: 'chrome' };
  if (process.platform === 'win32') {
    const step = policy.installPlan(args)[0];
    assert.equal(step.kind, 'reg');
    assert.equal(step.hive, 'HKCU');
    assert.match(step.key, /Google\\Chrome\\ExtensionInstallForcelist/);
    assert.equal(step.value, 'abc;https://host/updates.xml');
  } else if (process.platform === 'darwin') {
    const step = policy.installPlan(args)[0];
    assert.equal(step.kind, 'defaults');
    assert.equal(step.domain, 'com.google.Chrome');
  } else {
    process.env.EPM_POLICY_DIR = '/tmp/epm-policy-test';
    const step = policy.installPlan(args)[0];
    delete process.env.EPM_POLICY_DIR;
    assert.equal(step.kind, 'file');
    assert.equal(step.path, '/tmp/epm-policy-test/abc.json');
    assert.equal(step.needsRoot, false);
    assert.deepEqual(JSON.parse(step.content), policy.buildPolicy('abc', args.updateUrl));
  }
});

test('describe renders for each backend', () => {
  assert.match(policy.describe({ kind: 'file', path: '/x/y.json', content: '{}' }), /write \/x\/y\.json/);
  assert.match(policy.describe({ kind: 'reg', hive: 'HKCU', key: 'K', name: '1', value: 'v' }), /reg add HKCU\\K/);
  assert.match(policy.describe({ kind: 'defaults', domain: 'com.google.Chrome', key: 'ExtensionInstallForcelist', value: 'v' }), /defaults write com\.google\.Chrome/);
});

test('apply writes a linux policy file and uninstall removes it', async () => {
  if (process.platform === 'win32' || process.platform === 'darwin') return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epm-pol-'));
  process.env.EPM_POLICY_DIR = dir;
  try {
    const step = policy.installPlan({ id: 'abc', updateUrl: 'https://h/u.xml', browserId: 'chrome' })[0];
    await policy.apply(step);
    const written = JSON.parse(fs.readFileSync(step.path, 'utf8'));
    assert.deepEqual(written, { ExtensionInstallForcelist: ['abc;https://h/u.xml'] });

    const rm = policy.uninstallPlan({ id: 'abc', browserId: 'chrome' })[0];
    await policy.apply(rm);
    assert.equal(fs.existsSync(step.path), false);
  } finally {
    delete process.env.EPM_POLICY_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
