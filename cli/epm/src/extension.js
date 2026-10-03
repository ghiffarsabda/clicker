'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EPM_DIR } = require('./config');

function readManifest(dir) {
  const p = path.join(dir, 'manifest.json');
  if (!fs.existsSync(p)) throw new Error('no manifest.json in ' + dir);
  let json;
  try { json = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { throw new Error('manifest.json is not valid JSON: ' + e.message); }
  return { path: p, json };
}

/**
 * Chrome derives an unpacked extension's id from the SHA-256 of the DER
 * SubjectPublicKeyInfo it was signed with: take the first 16 bytes and map
 * every nibble 0..15 to 'a'..'p'. The same `key` in manifest.json therefore
 * yields the same id on every profile and machine.
 */
function extensionIdFromKey(keyBase64) {
  const der = Buffer.from(String(keyBase64), 'base64');
  if (!der.length) throw new Error('manifest "key" is empty');
  const hash = crypto.createHash('sha256').update(der).digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (hash[i] >> 4));
    id += String.fromCharCode(97 + (hash[i] & 0x0f));
  }
  return id;
}

/**
 * Generate an RSA key pair, write the public half into manifest.json's `key`,
 * and keep the private half for future .crx packing. Returns the new id.
 */
function generateKey(dir, { force = false } = {}) {
  const { path: manifestPath, json } = readManifest(dir);
  if (json.key && !force) {
    throw new Error('manifest.json already has a "key" (pass --force to replace it, which changes the extension id)');
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const key = Buffer.from(publicKey).toString('base64');
  json.key = key;
  fs.writeFileSync(manifestPath, JSON.stringify(json, null, 2) + '\n');

  const keyPath = path.join(EPM_DIR, 'key.pem');
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, privateKey, { mode: 0o600 });

  return { id: extensionIdFromKey(key), key, keyPath };
}

module.exports = { readManifest, extensionIdFromKey, generateKey };
