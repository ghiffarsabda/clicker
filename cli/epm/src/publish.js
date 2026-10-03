'use strict';

/*
 * Release plumbing: bump the version, commit it, and push the signed CRX +
 * update manifest to the distribution repo so Chrome's force-install policy
 * picks the new version up.
 */

const fs = require('fs');
const path = require('path');
const { exists, run } = require('./util');

function deriveBaseUrl(distRepo) {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(distRepo || '');
  return m ? `https://${m[1]}.github.io/${m[2]}` : null;
}

function bumpVersion(version, kind = 'patch') {
  const parts = String(version || '0.0.0').split('.').map((n) => parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  if (kind === 'major') { parts[0] += 1; parts[1] = 0; parts[2] = 0; }
  else if (kind === 'minor') { parts[1] += 1; parts[2] = 0; }
  else { parts[2] += 1; }
  return parts.slice(0, 3).join('.');
}

async function gitIdentity() {
  const n = await run('git', ['config', '--global', 'user.name']);
  const e = await run('git', ['config', '--global', 'user.email']);
  return {
    name: (n.stdout || '').trim() || 'epm',
    email: (e.stdout || '').trim() || 'epm@local',
  };
}

/** Commit only `paths` (so unrelated working-tree edits are never swept in). */
async function commitPaths(dir, paths, message) {
  const id = await gitIdentity();
  await run('git', ['-C', dir, 'add', '--', ...paths]);
  const staged = await run('git', ['-C', dir, 'diff', '--cached', '--name-only', '--', ...paths]);
  if (!(staged.stdout || '').trim()) return false;
  const c = await run('git', [
    '-C', dir, '-c', `user.name=${id.name}`, '-c', `user.email=${id.email}`,
    'commit', '-m', message,
  ]);
  if (c.code !== 0) throw new Error('git commit failed in ' + dir + ': ' + (c.stderr || '').trim());
  return true;
}

async function pushRepo(dir) {
  const p = await run('git', ['-C', dir, 'push']);
  if (p.code !== 0) throw new Error('git push failed in ' + dir + ': ' + (p.stderr || '').trim());
}

async function syncDistRepo(distRepo, localDir, files, message) {
  if (!exists(path.join(localDir, '.git'))) {
    fs.mkdirSync(path.dirname(localDir), { recursive: true });
    const r = await run('git', ['clone', distRepo, localDir]);
    if (r.code !== 0) throw new Error('git clone ' + distRepo + ' failed: ' + (r.stderr || '').trim());
  } else {
    const r = await run('git', ['-C', localDir, 'pull', '--ff-only']);
    if (r.code !== 0) throw new Error('git pull failed in ' + localDir + ': ' + (r.stderr || '').trim());
  }
  for (const [name, src] of Object.entries(files)) fs.copyFileSync(src, path.join(localDir, name));
  const committed = await commitPaths(localDir, ['.'], message);
  await pushRepo(localDir);
  return committed;
}

module.exports = { deriveBaseUrl, bumpVersion, commitPaths, pushRepo, syncDistRepo };
