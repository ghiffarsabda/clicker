'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const { MessageDecoder, buildLaunchArgs, withChrome } = require('../src/cdp');

test('MessageDecoder splits NUL-delimited frames across chunks', () => {
  const d = new MessageDecoder();
  assert.deepEqual(d.push('{"a":1}\0{"b"'), ['{"a":1}']);
  assert.deepEqual(d.push(':2}\0'), ['{"b":2}']);
  assert.deepEqual(d.push('\0'), ['']);
});

test('MessageDecoder handles an empty chunk and multibyte text', () => {
  const d = new MessageDecoder();
  assert.deepEqual(d.push(Buffer.from('')), []);
  assert.deepEqual(d.push(Buffer.from([0xe2, 0x9c, 0x93, 0x00])), ['\u2713']);
});

test('buildLaunchArgs carries the flags the Extensions domain needs', () => {
  const a = buildLaunchArgs({ userDataDir: '/tmp/ud', profileDir: 'Profile 1' });
  assert.ok(a.includes('--remote-debugging-pipe'));
  assert.ok(a.includes('--enable-unsafe-extension-debugging'));
  assert.ok(a.includes('--user-data-dir=/tmp/ud'));
  assert.ok(a.includes('--profile-directory=Profile 1'));
  assert.ok(!a.includes('--headless=new'));
});

test('buildLaunchArgs adds headless on request', () => {
  const a = buildLaunchArgs({ userDataDir: '/x', profileDir: 'Default', headless: true });
  assert.ok(a.includes('--headless=new'));
});

test('withChrome rejects cleanly when the child exits immediately (no EPIPE crash)', async () => {
  // A process that exits at once stands in for "Chrome is already running":
  // the debug pipe dies, and this must reject rather than throw an unhandled
  // stream error.
  await assert.rejects(
    withChrome(
      process.execPath,
      { userDataDir: os.tmpdir(), profileDir: 'Default', extraArgs: ['-e', 'process.exit(1)'] },
      async () => 'never',
    ),
    /did not accept the debug pipe/,
  );
});
