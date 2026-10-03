'use strict';

const fs = require('fs');
const path = require('path');
const { head, ok, warn, err, dim, exists, which, runSync, expandHome } = require('./util');
const { CONFIG_PATH, EPM_DIR } = require('./config');
const chrome = require('./chrome');
const { withChrome } = require('./cdp');
const ext = require('./extension');
const source = require('./source');
const macros = require('./macros');
const pack = require('./pack');
const policy = require('./policy');

function pickBrowser(cfg) {
  const browsers = chrome.findBrowsers(cfg);
  if (!browsers.length) {
    throw new Error('no Chrome/Chromium browser found — set "browser" and "userDataDir" in ' + CONFIG_PATH);
  }
  return browsers[0];
}

function targets(cfg, opts) {
  const browser = pickBrowser(cfg);
  const all = chrome.listProfiles(browser.userDataDir);
  if (!all.length) throw new Error('no Chrome profiles found in ' + browser.userDataDir);
  let chosen = all;
  if (opts.profile && opts.profile.length) {
    const wanted = opts.profile.map((s) => s.toLowerCase());
    chosen = all.filter((p) => wanted.includes(p.dir.toLowerCase()) || wanted.includes(p.name.toLowerCase()));
    const missing = wanted.filter((w) => !all.some((p) => p.dir.toLowerCase() === w || p.name.toLowerCase() === w));
    if (missing.length) throw new Error('no such profile: ' + missing.join(', '));
  }
  return { browser, all, chosen };
}

function extIdFor(cfg) {
  if (!exists(path.join(cfg.source, 'manifest.json'))) return null;
  const { json } = ext.readManifest(cfg.source);
  return json.key ? ext.extensionIdFromKey(json.key) : null;
}

function samePath(a, b) {
  const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(a) === norm(b);
}

/** Run `fn(cdp, profile)` against every selected profile, one Chrome at a time. */
async function eachProfile(cfg, opts, fn) {
  const { browser, chosen } = targets(cfg, opts);
  // An explicit --user-data-dir is an isolated instance; only the real profile
  // needs Chrome fully closed (Chrome allows one instance per user-data-dir).
  if (!cfg.userDataDir && chrome.isRunning(browser)) {
    throw new Error(`${browser.name} is running — quit it (including background/tray) and retry`);
  }
  const results = [];
  for (const profile of chosen) {
    dim(`\u2192 ${profile.dir} (${profile.name})`);
    try {
      const result = await withChrome(
        browser.binary,
        { userDataDir: browser.userDataDir, profileDir: profile.dir, headless: !!opts.headless },
        (cdp) => fn(cdp, profile),
      );
      results.push({ profile, ok: true, result });
      ok(`${profile.dir}: done`);
    } catch (e) {
      results.push({ profile, ok: false, error: e.message });
      err(`${profile.dir}: ${e.message}`);
    }
  }
  return { browser, results };
}

async function findExtension(cdp, extId, sourcePath) {
  const { extensions = [] } = await cdp.send('Extensions.getExtensions');
  if (extId) {
    const byId = extensions.find((e) => e.id === extId);
    if (byId) return byId;
  }
  return extensions.find((e) => e.path && samePath(e.path, sourcePath)) || null;
}

function extensionPagePath(dir) {
  try {
    const { json } = ext.readManifest(dir);
    return (json.side_panel && json.side_panel.default_path)
      || (json.options_ui && json.options_ui.page)
      || json.options_page
      || 'sidepanel/sidepanel.html';
  } catch {
    return 'sidepanel/sidepanel.html';
  }
}

/*
 * The Extensions domain storage commands resolve the browser context from the
 * target the session is attached to; a browser-level target has none ("No
 * associated browser context"). Attaching to a page of the extension itself
 * gives the handler a context that can reach the extension's storage.
 */
async function withExtensionSession(cdp, extId, pagePath, fn) {
  const { targetId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/${pagePath}` });
  let sessionId = null;
  try {
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
    await new Promise((r) => setTimeout(r, 500)); // let the page's renderer come up
    return await fn(sessionId);
  } finally {
    try { if (sessionId) await cdp.send('Target.detachFromTarget', { sessionId }); } catch { /* ignore */ }
    try { await cdp.send('Target.closeTarget', { targetId }); } catch { /* ignore */ }
  }
}

async function cmdProfiles(cfg) {
  const browsers = chrome.findBrowsers(cfg);
  if (!browsers.length) {
    err('No Chrome/Chromium browser found.');
    return 1;
  }
  const extId = extIdFor(cfg);
  for (const b of browsers) {
    head(b.name);
    dim(`binary:   ${b.binary}`);
    dim(`profiles: ${b.userDataDir}`);
    const profiles = chrome.listProfiles(b.userDataDir);
    if (!profiles.length) { warn('no profiles found'); continue; }
    for (const p of profiles) {
      const st = extId ? chrome.extensionState(p.path, extId) : { present: false };
      const tag = st.present ? (st.enabled ? 'installed' : 'disabled') : '\u2014';
      const label = p.email ? `${p.name} <${p.email}>` : p.name;
      ok(`${p.dir.padEnd(12)} ${label}  [${tag}]`);
    }
  }
  if (extId) dim(`extension id: ${extId}`);
  else warn('no stable extension id yet — run `epm keygen`');
  return 0;
}

async function cmdStatus(cfg) {
  const browser = pickBrowser(cfg);
  const extId = extIdFor(cfg);
  head(`${browser.name} \u2014 ${browser.userDataDir}`);
  const profiles = chrome.listProfiles(browser.userDataDir);
  if (!profiles.length) { warn('no profiles found'); return 1; }
  for (const p of profiles) {
    const st = extId ? chrome.extensionState(p.path, extId) : { present: false };
    if (st.present) ok(`${p.dir.padEnd(12)} v${st.version || '?'} ${st.enabled ? 'enabled' : 'disabled'}`);
    else dim(`${p.dir.padEnd(12)} not installed`);
  }
  if (!extId) warn('run `epm keygen` to establish a stable extension id');
  return 0;
}

async function cmdInstall(cfg, opts) {
  await source.ensureClone(cfg);
  const { json } = ext.readManifest(cfg.source);
  if (!json.key) warn('manifest.json has no "key" — the extension id differs per machine. Run `epm keygen` first for a stable id.');
  const src = fs.realpathSync(cfg.source);

  head(`Installing ${json.name || 'extension'} into ${targets(cfg, opts).chosen.length} profile(s)`);
  const { results } = await eachProfile(cfg, opts, async (cdp) => {
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: src });
    return id;
  });
  const good = results.filter((r) => r.ok);
  head(`Installed into ${good.length}/${results.length} profile(s)`);
  for (const r of good) dim(`${r.profile.dir.padEnd(12)} id=${r.result}`);
  return good.length ? 0 : 1;
}

async function cmdUpdate(cfg, opts) {
  await source.ensureClone(cfg);
  if (!exists(path.join(cfg.source, '.git'))) throw new Error('source is not a git checkout: ' + cfg.source);

  const before = await source.info(cfg).catch(() => ({}));
  await source.pull(cfg);
  const after = await source.info(cfg).catch(() => ({}));
  head('Source updated');
  dim(`${before.head || '?'} \u2192 ${after.head || '?'}  (${after.subject || 'up to date'})`);

  const src = fs.realpathSync(cfg.source);
  const { results } = await eachProfile(cfg, opts, async (cdp) => {
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: src });
    return id;
  });
  const good = results.filter((r) => r.ok);
  head(`Reloaded in ${good.length}/${results.length} profile(s)`);
  return good.length ? 0 : 1;
}

async function cmdImport(cfg, opts) {
  const file = opts._[0];
  if (!file) throw new Error('usage: epm import <file.json> [--mode merge|replace]');
  const mode = String(opts.mode || 'merge').toLowerCase();
  if (mode !== 'merge' && mode !== 'replace') throw new Error('--mode must be "merge" or "replace"');
  if (!exists(file)) throw new Error('no such file: ' + file);

  const incoming = macros.parseMacroFile(fs.readFileSync(file, 'utf8'));
  await source.ensureClone(cfg);
  const src = fs.realpathSync(cfg.source);
  const extId = extIdFor(cfg);

  head(`Importing ${incoming.length} macro(s) \u2014 mode: ${mode}`);
  const pagePath = extensionPagePath(cfg.source);
  const { results } = await eachProfile(cfg, opts, async (cdp) => {
    let id = extId;
    if (!id) {
      const found = await findExtension(cdp, null, src);
      id = found ? found.id : (await cdp.send('Extensions.loadUnpacked', { path: src })).id;
    }

    const write = (targetId) => withExtensionSession(cdp, targetId, pagePath, async (sessionId) => {
      const { data = {} } = await cdp.send('Extensions.getStorageItems', {
        id: targetId, storageArea: 'local', keys: ['macros', 'selectedMacroId'],
      }, 30000, sessionId);
      const existing = Array.isArray(data.macros) ? data.macros : [];
      const next = mode === 'replace' ? incoming : macros.mergeMacros(existing, incoming);

      const values = { macros: next };
      if (!data.selectedMacroId && next.length) values.selectedMacroId = next[0].id;
      await cdp.send('Extensions.setStorageItems', { id: targetId, storageArea: 'local', values }, 30000, sessionId);
      return { id: targetId, before: existing.length, total: next.length };
    });

    try {
      return await write(id);
    } catch (e) {
      // Not installed in this profile (policy not applied yet) — load it for this run.
      const { id: loaded } = await cdp.send('Extensions.loadUnpacked', { path: src });
      return await write(loaded);
    }
  });

  const good = results.filter((r) => r.ok);
  head(`Imported into ${good.length}/${results.length} profile(s)`);
  for (const r of good) dim(`${r.profile.dir.padEnd(12)} ${r.result.before} \u2192 ${r.result.total} macro(s)`);
  return good.length ? 0 : 1;
}

async function cmdKeygen(cfg, opts) {
  await source.ensureClone(cfg);
  const r = ext.generateKey(cfg.source, { force: !!opts.force });
  head('Extension key written');
  dim(`manifest:     ${path.join(cfg.source, 'manifest.json')}`);
  dim(`private key:  ${r.keyPath}  (keep safe; used to pack a .crx)`);
  dim(`extension id: ${r.id}`);
  warn('The extension id changed — run `epm install` to load it in every profile, then re-import macros.');
  return 0;
}

async function cmdSource(cfg, opts) {
  const sub = opts._[0] || 'status';
  if (sub === 'clone') {
    const r = await source.ensureClone(cfg);
    ok(r.cloned ? 'cloned to ' + cfg.source : 'source already present at ' + cfg.source);
    return 0;
  }
  if (sub === 'pull') {
    const out = await source.pull(cfg);
    ok(out || 'already up to date');
    return 0;
  }
  if (sub !== 'status') throw new Error('usage: epm source [clone|pull|status]');
  if (!exists(path.join(cfg.source, '.git'))) { warn('not cloned: ' + cfg.source); return 0; }
  const i = await source.info(cfg);
  ok(`${cfg.source} @ ${i.branch} ${i.head} \u2014 ${i.subject}`);
  return 0;
}

async function cmdDoctor(cfg) {
  head('Environment');
  dim('node:   ' + process.version);
  const git = which('git');
  if (git) dim('git:    ' + (runSync('git', ['--version']).stdout || '').trim());
  else warn('git not found — install git (needed to clone/update the source)');
  dim('config: ' + CONFIG_PATH + (exists(CONFIG_PATH) ? '' : '  (defaults in use; not written yet)'));

  head('Config');
  for (const [k, v] of Object.entries(cfg)) dim(`${k}: ${v === null ? '(auto)' : v}`);

  head('Browsers');
  const browsers = chrome.findBrowsers(cfg);
  if (!browsers.length) warn('none found');
  for (const b of browsers) {
    dim(`${b.name}: ${b.binary}`);
    dim(`  profiles dir: ${b.userDataDir}  (${chrome.listProfiles(b.userDataDir).length} profile(s))`);
  }

  head('Source');
  if (exists(path.join(cfg.source, 'manifest.json'))) {
    const { json } = ext.readManifest(cfg.source);
    dim('path:            ' + cfg.source);
    dim('manifest:        v' + (json.version || '?') + '  ' + (json.name || ''));
    dim('git checkout:    ' + (exists(path.join(cfg.source, '.git')) ? 'yes' : 'no'));
    if (json.key) dim('extension id:    ' + ext.extensionIdFromKey(json.key));
    else warn('no "key" in manifest.json — run `epm keygen` for a stable id');
  } else {
    warn('source not cloned yet (' + cfg.source + ') — `epm install` will clone it');
  }
  return 0;
}

async function cmdPack(cfg, opts) {
  await source.ensureClone(cfg);
  const { json } = ext.readManifest(cfg.source);
  if (!json.key) throw new Error('manifest.json has no "key" — run `epm keygen` first');
  const keyPath = path.join(EPM_DIR, 'key.pem');
  if (!exists(keyPath)) throw new Error('private key not found at ' + keyPath + ' — run `epm keygen`');

  const browser = pickBrowser(cfg);
  const outDir = opts.out ? expandHome(opts.out) : path.join(EPM_DIR, 'dist');
  const { crxPath, crxName } = await pack.buildCrx({
    chrome: browser.binary,
    source: cfg.source,
    keyPath,
    outDir,
    name: json.name,
    version: json.version,
  });

  const id = ext.extensionIdFromKey(json.key);
  const base = opts['base-url'] ? String(opts['base-url']).replace(/\/+$/, '') : null;
  const crxUrl = opts['crx-url'] || (base ? `${base}/${crxName}` : `https://REPLACE-WITH-HOST/${crxName}`);
  const updatesPath = path.join(outDir, 'updates.xml');
  fs.writeFileSync(updatesPath, pack.buildUpdateXml(id, crxUrl, json.version));

  head('Packed');
  dim(`crx:          ${crxPath}`);
  dim(`updates.xml:  ${updatesPath}`);
  dim(`extension id: ${id}`);
  if (!base && !opts['crx-url']) warn('no --base-url given — update.xml has a placeholder codebase');
  head('Next');
  dim('1. Host both files over HTTPS (e.g. GitHub Pages or a release asset).');
  dim(`2. epm policy install --update-url ${base ? base + '/updates.xml' : '<https url of updates.xml>'}`);
  return 0;
}

async function cmdPolicy(cfg, opts) {
  const sub = opts._[0] || 'status';
  const browser = pickBrowser(cfg);
  const id = extIdFor(cfg);
  if (!id) throw new Error('no extension id — run `epm keygen` and `epm pack` first');
  const machine = !!opts.machine;
  const dry = !!opts['dry-run'] || sub === 'print';

  if (sub === 'install' || sub === 'uninstall') {
    const updateUrl = opts['update-url'];
    if (sub === 'install' && !updateUrl) throw new Error('usage: epm policy install --update-url <https URL of updates.xml>');
    const steps = sub === 'install'
      ? policy.installPlan({ id, updateUrl, browserId: browser.id, machine })
      : policy.uninstallPlan({ id, browserId: browser.id, machine });

    head(`${sub === 'install' ? 'Installing' : 'Removing'} policy — ${browser.name}`);
    for (const step of steps) {
      if (dry) { dim(policy.describe(step)); continue; }
      try {
        await policy.apply(step);
        ok(policy.describe(step).split('\n')[0]);
      } catch (e) {
        err(policy.describe(step).split('\n')[0] + ' — ' + e.message);
        if (step.needsRoot) warn('that location needs root; re-run with sudo');
        return 1;
      }
    }
    if (!dry && sub === 'install') dim('Restart Chrome — every profile installs it and keeps it.');
    return 0;
  }

  if (sub !== 'status') throw new Error('usage: epm policy [install|uninstall|status]');

  head(`Policy — ${browser.name} (id ${id})`);
  for (const step of policy.uninstallPlan({ id, browserId: browser.id, machine })) {
    if (step.kind === 'file' && exists(step.path)) {
      ok(step.path);
      try { dim(fs.readFileSync(step.path, 'utf8').trim()); } catch { /* ignore */ }
    } else if (step.kind === 'file') {
      dim(step.path + '  (not present)');
    } else {
      dim('target: ' + policy.describe(step));
    }
  }
  return 0;
}

module.exports = {
  cmdProfiles, cmdStatus, cmdInstall, cmdUpdate, cmdImport, cmdKeygen, cmdSource, cmdDoctor,
  cmdPack, cmdPolicy,
};
