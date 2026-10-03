'use strict';

/*
 * Force-install policy. ExtensionInstallForcelist maps a policy slot to
 * "<extension-id>;<update-url>", which makes Chrome install and auto-update the
 * extension in every profile on the machine.
 */

const fs = require('fs');
const path = require('path');
const { exists, run } = require('./util');

const LINUX_DIRS = {
  chrome: '/etc/opt/chrome/policies/managed',
  chromium: '/etc/chromium/policies/managed',
  edge: '/etc/opt/edge/policies/managed',
  brave: '/etc/opt/brave.com/brave/policies/managed',
};
const WIN_KEYS = {
  chrome: 'Google\\Chrome',
  chromium: 'Chromium',
  edge: 'Microsoft\\Edge',
  brave: 'BraveSoftware\\Brave',
};
const MAC_DOMAINS = {
  chrome: 'com.google.Chrome',
  chromium: 'org.chromium.Chromium',
  edge: 'com.microsoft.Edge',
  brave: 'com.brave.Browser',
};

function buildPolicy(id, updateUrl) {
  return { ExtensionInstallForcelist: [`${id};${updateUrl}`] };
}

function installPlan({ id, updateUrl, browserId, machine = false }) {
  const os = process.platform;
  if (os === 'linux') {
    const dir = process.env.EPM_POLICY_DIR || LINUX_DIRS[browserId] || LINUX_DIRS.chrome;
    return [{
      kind: 'file',
      path: path.join(dir, `${id}.json`),
      content: JSON.stringify(buildPolicy(id, updateUrl), null, 2) + '\n',
      needsRoot: !process.env.EPM_POLICY_DIR,
    }];
  }
  if (os === 'win32') {
    return [{
      kind: 'reg',
      hive: machine ? 'HKLM' : 'HKCU',
      key: `Software\\Policies\\${WIN_KEYS[browserId] || WIN_KEYS.chrome}\\ExtensionInstallForcelist`,
      name: '1',
      value: `${id};${updateUrl}`,
    }];
  }
  return [{
    kind: 'defaults',
    domain: MAC_DOMAINS[browserId] || MAC_DOMAINS.chrome,
    key: 'ExtensionInstallForcelist',
    value: `${id};${updateUrl}`,
  }];
}

function uninstallPlan({ id, browserId, machine = false }) {
  const os = process.platform;
  if (os === 'linux') {
    const dir = process.env.EPM_POLICY_DIR || LINUX_DIRS[browserId] || LINUX_DIRS.chrome;
    return [{ kind: 'file', path: path.join(dir, `${id}.json`), remove: true, needsRoot: !process.env.EPM_POLICY_DIR }];
  }
  if (os === 'win32') {
    return [{
      kind: 'reg',
      hive: machine ? 'HKLM' : 'HKCU',
      key: `Software\\Policies\\${WIN_KEYS[browserId] || WIN_KEYS.chrome}\\ExtensionInstallForcelist`,
      name: '1',
      remove: true,
    }];
  }
  return [{
    kind: 'defaults',
    domain: MAC_DOMAINS[browserId] || MAC_DOMAINS.chrome,
    key: 'ExtensionInstallForcelist',
    remove: true,
  }];
}

function describe(step) {
  if (step.kind === 'file') {
    return `${step.remove ? 'remove' : 'write'} ${step.path}`
      + (step.content ? `\n      ${step.content.trim().replace(/\n/g, '\n      ')}` : '')
      + (step.needsRoot ? '  (needs root)' : '');
  }
  if (step.kind === 'reg') {
    return step.remove
      ? `reg delete ${step.hive}\\${step.key} /v ${step.name} /f`
      : `reg add ${step.hive}\\${step.key} /v ${step.name} /t REG_SZ /d "${step.value}" /f`;
  }
  return step.remove
    ? `defaults delete ${step.domain} ${step.key}`
    : `defaults write ${step.domain} ${step.key} -array "${step.value}"`;
}

async function apply(step) {
  if (step.kind === 'file') {
    if (step.remove) {
      if (exists(step.path)) fs.rmSync(step.path);
      return;
    }
    fs.mkdirSync(path.dirname(step.path), { recursive: true });
    fs.writeFileSync(step.path, step.content);
    return;
  }
  if (step.kind === 'reg') {
    if (step.remove) {
      const r = await run('reg', ['delete', `${step.hive}\\${step.key}`, '/v', step.name, '/f']);
      if (r.code !== 0) throw new Error((r.stderr || r.stdout || 'reg delete failed').trim());
      return;
    }
    const r = await run('reg', ['add', `${step.hive}\\${step.key}`, '/v', step.name, '/t', 'REG_SZ', '/d', step.value, '/f']);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || 'reg add failed').trim());
    return;
  }
  if (step.remove) {
    await run('defaults', ['delete', step.domain, step.key]);
    return;
  }
  const r = await run('defaults', ['write', step.domain, step.key, '-array', step.value]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || 'defaults write failed').trim());
}

module.exports = { buildPolicy, installPlan, uninstallPlan, describe, apply, LINUX_DIRS, WIN_KEYS, MAC_DOMAINS };
