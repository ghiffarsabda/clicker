'use strict';

/*
 * Packaging: stage a clean copy of the extension, let Chrome sign a .crx with
 * the key that matches manifest.json's `key` (so the CRX id equals the policy
 * id), and emit the update manifest Chrome's policy force-install consumes.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { exists, run } = require('./util');

const SKIP_DIRS = new Set(['.git', '.github', '.commandcode', 'node_modules', 'cli', 'dist']);
const SKIP_FILES = new Set(['.gitignore', 'package.json', 'package-lock.json']);
const SKIP_EXT = new Set(['.md', '.zip', '.crx', '.pem', '.log']);

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const name = entry.name;
    if (name.startsWith('.')) continue;
    const from = path.join(src, name);
    const to = path.join(dst, name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      copyTree(from, to);
    } else if (entry.isFile()) {
      if (SKIP_FILES.has(name) || SKIP_EXT.has(path.extname(name).toLowerCase())) continue;
      fs.copyFileSync(from, to);
    }
  }
}

function slug(name) {
  return String(name || 'extension').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'extension';
}

function buildUpdateXml(id, crxUrl, version) {
  return `<?xml version='1.0' encoding='UTF-8'?>\n`
    + `<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>\n`
    + `  <app appid='${id}'>\n`
    + `    <updatecheck codebase='${crxUrl}' version='${version}' />\n`
    + `  </app>\n`
    + `</gupdate>\n`;
}

async function buildCrx({ chrome, source, keyPath, outDir, name, version }) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'epm-pack-'));
  try {
    copyTree(source, stage);
    const r = await run(chrome, [
      `--pack-extension=${stage}`,
      `--pack-extension-key=${keyPath}`,
      '--no-message-box',
    ], { timeout: 120000 });
    const produced = stage + '.crx';
    if (!exists(produced)) {
      throw new Error('Chrome did not produce a .crx' + (r.stderr ? ': ' + r.stderr.trim() : ''));
    }
    fs.mkdirSync(outDir, { recursive: true });
    const crxName = `${slug(name)}-${version}.crx`;
    const crxPath = path.join(outDir, crxName);
    fs.copyFileSync(produced, crxPath);
    return { crxPath, crxName };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(stage + '.crx', { force: true });
  }
}

module.exports = { copyTree, slug, buildUpdateXml, buildCrx };
