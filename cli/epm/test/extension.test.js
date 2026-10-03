'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const ext = require('../src/extension');

test('extensionIdFromKey returns 32 chars in a-p and is deterministic', () => {
  const { publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const key = Buffer.from(publicKey).toString('base64');
  const id = ext.extensionIdFromKey(key);
  assert.equal(id.length, 32);
  assert.match(id, /^[a-p]{32}$/);
  assert.equal(id, ext.extensionIdFromKey(key));
});

test('extensionIdFromKey matches the SHA-256 nibble mapping', () => {
  const der = Buffer.from('clicker test vector');
  const hash = crypto.createHash('sha256').update(der).digest();
  let expected = '';
  for (let i = 0; i < 16; i++) {
    expected += String.fromCharCode(97 + (hash[i] >> 4));
    expected += String.fromCharCode(97 + (hash[i] & 0x0f));
  }
  assert.equal(ext.extensionIdFromKey(der.toString('base64')), expected);
});

test('extensionIdFromKey rejects an empty key', () => {
  assert.throws(() => ext.extensionIdFromKey(''), /empty/);
});
