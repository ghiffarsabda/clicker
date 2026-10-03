'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { exists, readJson, which, runSync } = require('./util');

const HOME = os.homedir();
const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';

const LOCAL = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const PF = process.env.ProgramFiles || 'C:\\Program Files';
const PFX = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

const BROWSER_DEFS = [
  {
    id: 'chrome',
    name: 'Google Chrome',
    binaries: WIN
      ? [path.join(LOCAL, 'Google', 'Chrome', 'Application', 'chrome.exe'),
         path.join(PF, 'Google', 'Chrome', 'Application', 'chrome.exe'),
         path.join(PFX, 'Google', 'Chrome', 'Application', 'chrome.exe')]
      : MAC
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : ['google-chrome', 'google-chrome-stable'],
    dataDirs: WIN
      ? [path.join(LOCAL, 'Google', 'Chrome', 'User Data')]
      : MAC
        ? [path.join(HOME, 'Library', 'Application Support', 'Google', 'Chrome')]
        : [path.join(HOME, '.config', 'google-chrome')],
    processNames: WIN ? ['chrome.exe'] : MAC ? ['Google Chrome'] : ['google-chrome', 'google-chrome-stable', 'chrome'],
  },
  {
    id: 'chromium',
    name: 'Chromium',
    binaries: WIN
      ? [path.join(PF, 'Chromium', 'Application', 'chrome.exe')]
      : MAC
        ? ['/Applications/Chromium.app/Contents/MacOS/Chromium']
        : ['chromium', 'chromium-browser'],
    dataDirs: WIN
      ? [path.join(LOCAL, 'Chromium', 'User Data')]
      : MAC
        ? [path.join(HOME, 'Library', 'Application Support', 'Chromium')]
        : [path.join(HOME, '.config', 'chromium')],
    processNames: WIN ? ['chrome.exe'] : MAC ? ['Chromium'] : ['chromium', 'chromium-browser'],
  },
  {
    id: 'edge',
    name: 'Microsoft Edge',
    binaries: WIN
      ? [path.join(PF, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
         path.join(PFX, 'Microsoft', 'Edge', 'Application', 'msedge.exe')]
      : MAC
        ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
        : ['microsoft-edge', 'microsoft-edge-stable'],
    dataDirs: WIN
      ? [path.join(LOCAL, 'Microsoft', 'Edge', 'User Data')]
      : MAC
        ? [path.join(HOME, 'Library', 'Application Support', 'Microsoft Edge')]
        : [path.join(HOME, '.config', 'microsoft-edge')],
    processNames: WIN ? ['msedge.exe'] : MAC ? ['Microsoft Edge'] : ['microsoft-edge'],
  },
  {
    id: 'brave',
    name: 'Brave',
    binaries: WIN
      ? [path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
         path.join(PF, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')]
      : MAC
        ? ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser']
        : ['brave-browser', 'brave'],
    dataDirs: WIN
      ? [path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'User Data')]
      : MAC
        ? [path.join(HOME, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser')]
        : [path.join(HOME, '.config', 'BraveSoftware', 'Brave-Browser')],
    processNames: WIN ? ['brave.exe'] : MAC ? ['Brave Browser'] : ['brave-browser', 'brave'],
  },
];

function resolveBinary(candidates) {
  for (const c of candidates) {
    const p = path.isAbsolute(c) ? (exists(c) ? c : null) : which(c);
    if (p) return p;
  }
  return null;
}

function firstExistingDir(dirs) {
  for (const d of dirs) if (exists(d)) return d;
  return null;
}

function findBrowsers(cfg = {}) {
  if (cfg.browser || cfg.userDataDir) {
    const def = BROWSER_DEFS[0];
    const binary = cfg.browser || resolveBinary(def.binaries);
    const userDataDir = cfg.userDataDir || firstExistingDir(def.dataDirs);
    if (!binary || !userDataDir) return [];
    return [{ id: 'chrome', name: 'Google Chrome (custom)', binary, userDataDir, processNames: def.processNames }];
  }
  const out = [];
  for (const def of BROWSER_DEFS) {
    const binary = resolveBinary(def.binaries);
    const userDataDir = firstExistingDir(def.dataDirs);
    if (binary && userDataDir) out.push({ id: def.id, name: def.name, binary, userDataDir, processNames: def.processNames });
  }
  return out;
}

function profilesFromLocalState(state, userDataDir) {
  const out = [];
  const cache = state && state.profile && state.profile.info_cache;
  if (cache && typeof cache === 'object') {
    for (const dir of Object.keys(cache)) {
      const p = path.join(userDataDir, dir);
      if (!exists(path.join(p, 'Preferences')) && !exists(path.join(p, 'Secure Preferences'))) continue;
      const info = cache[dir] || {};
      out.push({ dir, name: info.name || dir, email: info.user_name || '', path: p });
    }
  }
  if (!out.length) out.push(...scanProfileDirs(userDataDir));
  out.sort((a, b) => (a.dir === 'Default' ? -1 : b.dir === 'Default' ? 1 : a.dir.localeCompare(b.dir)));
  return out;
}

function scanProfileDirs(userDataDir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(userDataDir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name !== 'Default' && !/^Profile \d+$/.test(e.name)) continue;
    const p = path.join(userDataDir, e.name);
    if (!exists(path.join(p, 'Preferences')) && !exists(path.join(p, 'Secure Preferences'))) continue;
    out.push({ dir: e.name, name: e.name, email: '', path: p });
  }
  return out;
}

function listProfiles(userDataDir, stateText) {
  let state = null;
  try {
    state = stateText !== undefined && stateText !== null
      ? JSON.parse(stateText)
      : readJson(path.join(userDataDir, 'Local State'));
  } catch { /* no Local State yet */ }
  return profilesFromLocalState(state, userDataDir);
}

function extensionState(profilePath, extId) {
  for (const file of ['Secure Preferences', 'Preferences']) {
    const p = path.join(profilePath, file);
    if (!exists(p)) continue;
    let json;
    try { json = readJson(p); } catch { continue; }
    const s = json && json.extensions && json.extensions.settings && json.extensions.settings[extId];
    if (s) {
      return {
        present: true,
        enabled: s.state === 1 || s.enabled === true,
        version: s.manifest && s.manifest.version,
        path: s.path,
        file,
      };
    }
  }
  return { present: false };
}

function isRunning(browser) {
  const names = browser.processNames || [];
  if (!names.length) return false;
  if (WIN) {
    const r = runSync('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true });
    const out = (r.stdout || '').toLowerCase();
    return names.some((n) => out.includes(`"${n.toLowerCase()}"`));
  }
  const r = runSync('ps', ['-A', '-o', 'comm=']);
  const running = new Set((r.stdout || '').split('\n').map((s) => path.basename(s.trim())));
  return names.some((n) => running.has(n));
}

module.exports = {
  BROWSER_DEFS, findBrowsers, profilesFromLocalState, scanProfileDirs,
  listProfiles, extensionState, isRunning,
};
