'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const WIN = process.platform === 'win32';

const log = (...a) => console.log(...a);
const ok = (m) => console.log('  \u2713 ' + m);
const warn = (m) => console.log('  ! ' + m);
const err = (m) => console.error('  \u2717 ' + m);
const head = (m) => console.log('\n' + m);
const dim = (m) => console.log('    ' + m);

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function which(cmd) {
  if (path.isAbsolute(cmd)) return exists(cmd) ? cmd : null;
  const exts = WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  const dirs = (process.env.PATH || '').split(WIN ? ';' : ':');
  const names = (WIN && !/\.[a-z0-9]+$/i.test(cmd)) ? exts.map((e) => cmd + e) : [cmd];
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d || '.', n);
      if (exists(p)) return p;
    }
  }
  return null;
}

function run(cmd, args = [], opts = {}) {
  const { timeout = 0, ...spawnOpts } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...spawnOpts });
    let stdout = '';
    let stderr = '';
    let timer = null;
    if (timeout) timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, timeout);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function runSync(cmd, args = [], opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}

module.exports = {
  WIN, log, ok, warn, err, head, dim,
  exists, readJson, expandHome, which, run, runSync,
};
