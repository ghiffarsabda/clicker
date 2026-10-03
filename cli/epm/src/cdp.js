'use strict';

/*
 * Minimal Chrome DevTools Protocol client over the pipe transport.
 *
 * Extensions.loadUnpacked (and the rest of the Extensions domain) is only
 * exposed over `--remote-debugging-pipe` — connecting on a TCP port returns
 * "Method not available" — so EPM always talks to Chrome through fds 3/4,
 * with each message a JSON object terminated by a NUL byte.
 */

const { spawn } = require('child_process');

class MessageDecoder {
  constructor() {
    this._buf = Buffer.alloc(0);
  }

  /** Feed a chunk, return the complete UTF-8 messages it completed. */
  push(chunk) {
    this._buf = Buffer.concat([this._buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    const out = [];
    let i;
    while ((i = this._buf.indexOf(0)) !== -1) {
      out.push(this._buf.subarray(0, i).toString('utf8'));
      this._buf = this._buf.subarray(i + 1);
    }
    return out;
  }
}

class CdpPipe {
  constructor(child) {
    this.child = child;
    this._decoder = new MessageDecoder();
    this._nextId = 1;
    this._pending = new Map();
    const read = child.stdio[4];
    read.on('data', (d) => {
      for (const raw of this._decoder.push(d)) this._onMessage(raw);
    });
    read.on('end', () => this._failAll(new Error('Chrome closed the debug pipe')));
    read.on('error', (e) => this._failAll(e));
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg.id || !this._pending.has(msg.id)) return;
    const p = this._pending.get(msg.id);
    this._pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message + (msg.error.data ? ' \u2014 ' + msg.error.data : '')));
    else p.resolve(msg.result || {});
  }

  _failAll(e) {
    for (const p of this._pending.values()) p.reject(e);
    this._pending.clear();
  }

  send(method, params = {}, timeoutMs = 30000, sessionId = null) {
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => { this._pending.delete(id); reject(new Error(`timed out waiting for ${method}`)); }, timeoutMs)
        : null;
      this._pending.set(id, {
        resolve: (v) => { if (timer) clearTimeout(timer); resolve(v); },
        reject: (e) => { if (timer) clearTimeout(timer); reject(e); },
      });
      try {
        const msg = { id, method, params };
        if (sessionId) msg.sessionId = sessionId;
        this.child.stdio[3].write(JSON.stringify(msg) + '\0');
      } catch (e) {
        if (timer) clearTimeout(timer);
        this._pending.delete(id);
        reject(e);
      }
    });
  }
}

function buildLaunchArgs({ userDataDir, profileDir, headless = false, extraArgs = [] }) {
  const args = [
    `--user-data-dir=${userDataDir}`,
    `--profile-directory=${profileDir}`,
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (headless) args.push('--headless=new');
  args.push(...extraArgs);
  return args;
}

/**
 * Launch Chrome on one profile, wait for the pipe, run fn(cdp), then close it.
 * Chrome enforces a single instance per user-data-dir, so a running browser
 * makes the spawned process exit immediately — reported as a clear error.
 */
async function withChrome(binary, options, fn) {
  const args = buildLaunchArgs(options);
  const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stdio[2].on('data', (d) => { stderr += d; });

  const cdp = new CdpPipe(child);
  let exited = false;
  const exitP = new Promise((resolve) => child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); }));
  const tail = () => {
    const s = stderr.trim();
    return s ? '\n    ' + s.split('\n').slice(-4).join('\n    ') : '';
  };

  try {
    const ready = await Promise.race([
      cdp.send('Browser.getVersion', {}, 20000).then(() => true, () => false),
      exitP.then(() => false),
    ]);
    if (!ready) throw new Error('Chrome did not accept the debug pipe — is it already running? Close Chrome and retry.' + tail());
    return await fn(cdp, child);
  } finally {
    try { if (!exited) await cdp.send('Browser.close', {}, 4000); } catch { /* best effort */ }
    if (!exited) await Promise.race([exitP, new Promise((r) => setTimeout(r, 4000))]);
    if (!exited) { try { child.kill('SIGKILL'); } catch { /* best effort */ } }
  }
}

module.exports = { MessageDecoder, CdpPipe, buildLaunchArgs, withChrome };
