'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pack = require('../src/pack');

test('slug produces a filesystem-safe name', () => {
  assert.equal(pack.slug('Clicker — Macrobat'), 'clicker-macrobat');
  assert.equal(pack.slug(''), 'extension');
});

test('buildUpdateXml carries appid, codebase and version', () => {
  const xml = pack.buildUpdateXml('abcdef', 'https://host/x.crx', '1.2.3');
  assert.match(xml, /<gupdate/);
  assert.match(xml, /appid='abcdef'/);
  assert.match(xml, /codebase='https:\/\/host\/x\.crx'/);
  assert.match(xml, /version='1\.2\.3'/);
});

test('copyTree includes the extension and skips tooling/junk', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'epm-src-'));
  const dst = path.join(src, '..', path.basename(src) + '-out');
  fs.mkdirSync(path.join(src, 'background'));
  fs.mkdirSync(path.join(src, 'cli'));
  fs.mkdirSync(path.join(src, 'node_modules'));
  fs.mkdirSync(path.join(src, '.git'));
  fs.writeFileSync(path.join(src, 'manifest.json'), '{}');
  fs.writeFileSync(path.join(src, 'background', 'sw.js'), '//');
  fs.writeFileSync(path.join(src, 'README.md'), '#');
  fs.writeFileSync(path.join(src, '.gitignore'), '');
  fs.writeFileSync(path.join(src, 'cli', 'x.js'), '//');
  fs.writeFileSync(path.join(src, 'node_modules', 'y.js'), '//');
  fs.writeFileSync(path.join(src, '.git', 'HEAD'), '');
  try {
    pack.copyTree(src, dst);
    const names = fs.readdirSync(dst).sort();
    assert.deepEqual(names, ['background', 'manifest.json']);
    assert.ok(fs.existsSync(path.join(dst, 'background', 'sw.js')));
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dst, { recursive: true, force: true });
  }
});
