'use strict';

const path = require('path');
const { exists, run } = require('./util');

async function ensureClone(cfg) {
  // An existing directory is used as-is (a working checkout, or a plain folder).
  if (exists(cfg.source)) return { cloned: false, local: !exists(path.join(cfg.source, '.git')) };
  const r = await run('git', ['clone', '--branch', cfg.branch || 'main', cfg.repo, cfg.source]);
  if (r.code !== 0) throw new Error('git clone failed: ' + (r.stderr || '').trim());
  return { cloned: true };
}

async function pull(cfg) {
  const r = await run('git', ['-C', cfg.source, 'pull', '--ff-only']);
  if (r.code !== 0) throw new Error('git pull failed: ' + (r.stderr || '').trim());
  return r.stdout.trim();
}

async function info(cfg) {
  const [head, branch, subject] = await Promise.all([
    run('git', ['-C', cfg.source, 'rev-parse', '--short', 'HEAD']),
    run('git', ['-C', cfg.source, 'rev-parse', '--abbrev-ref', 'HEAD']),
    run('git', ['-C', cfg.source, 'log', '-1', '--pretty=%s']),
  ]);
  return {
    head: (head.stdout || '').trim(),
    branch: (branch.stdout || '').trim(),
    subject: (subject.stdout || '').trim(),
  };
}

module.exports = { ensureClone, pull, info };
