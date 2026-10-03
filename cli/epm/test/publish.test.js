'use strict';

const test = require('node:test');
const assert = require('node:assert');
const publish = require('../src/publish');

test('deriveBaseUrl turns a GitHub repo into its Pages URL', () => {
  assert.equal(publish.deriveBaseUrl('https://github.com/ghiffarsabda/clicker-epm.git'), 'https://ghiffarsabda.github.io/clicker-epm');
  assert.equal(publish.deriveBaseUrl('git@github.com:owner/repo.git'), 'https://owner.github.io/repo');
  assert.equal(publish.deriveBaseUrl('https://github.com/owner/repo'), 'https://owner.github.io/repo');
  assert.equal(publish.deriveBaseUrl('https://gitlab.com/x/y.git'), null);
  assert.equal(publish.deriveBaseUrl(null), null);
});

test('bumpVersion increments the right part', () => {
  assert.equal(publish.bumpVersion('1.16.2', 'patch'), '1.16.3');
  assert.equal(publish.bumpVersion('1.16.2', 'minor'), '1.17.0');
  assert.equal(publish.bumpVersion('1.16.2', 'major'), '2.0.0');
  assert.equal(publish.bumpVersion('1.2', 'patch'), '1.2.1');
  assert.equal(publish.bumpVersion('1', 'major'), '2.0.0');
});
