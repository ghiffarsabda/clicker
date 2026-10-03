'use strict';

const { loadConfig } = require('./config');
const cmd = require('./commands');
const { log, err } = require('./util');

const VALUE_FLAGS = new Set([
  'profile', 'mode', 'browser', 'user-data-dir', 'source', 'repo', 'branch',
  'out', 'base-url', 'crx-url', 'update-url',
]);
const REPEAT_FLAGS = new Set(['profile']);

function parse(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      let k = a.slice(2);
      let v = true;
      const eq = k.indexOf('=');
      if (eq !== -1) {
        v = k.slice(eq + 1);
        k = k.slice(0, eq);
      } else if (VALUE_FLAGS.has(k) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        v = argv[++i];
      }
      if (REPEAT_FLAGS.has(k)) (flags[k] = flags[k] || []).push(v);
      else flags[k] = v;
    } else {
      flags._.push(a);
    }
  }
  return flags;
}

const HELP = `epm \u2014 Extensions Package Manager

Install, update and seed macros for the Clicker extension across every Chrome
profile. Persistent installs use Chrome's force-install policy; the browser must
be closed only for the session commands (install/update/import).

Usage: epm <command> [options]

Commands:
  pack                 Build a signed .crx + updates.xml for hosting
  policy [install|uninstall|status]   Force-install across every profile (persistent)
  install              Load into every profile for the current session only
  update               git pull, then reload it in every profile
  import <file.json>   Import macros (Backup export) into every profile
  profiles             List detected browsers and profiles
  status               Show where the extension is installed
  keygen               Add a stable "key" to manifest.json (fixes the extension id)
  source [clone|pull|status]   Manage the git checkout
  doctor               Check node, git, browsers, profiles and config

Options:
  --update-url <url>   policy: HTTPS URL of the hosted updates.xml
  --base-url <url>     pack: base URL where the crx + updates.xml will be hosted
  --out <dir>          pack: output directory (default ~/.epm/dist)
  --machine            policy: write machine-wide (Windows HKLM) instead of per-user
  --dry-run            policy: show the change without applying it
  --profile <name>     Limit session commands to a profile (repeatable)
  --mode <m>           import: merge (default) or replace
  --headless           Launch Chrome headless while operating
  --source <path>      Override the local checkout path
  --browser <path>     Override the browser binary
  --user-data-dir <p>  Override the browser user-data directory
  --help, --version
`;

async function main(argv) {
  const opts = parse(argv);
  const command = opts._.shift();

  if (!command || command === 'help' || opts.help) {
    log(HELP);
    return;
  }
  if (command === 'version' || opts.version) {
    log('epm ' + require('../package.json').version);
    return;
  }

  const cfg = loadConfig();
  if (opts.source) cfg.source = opts.source;
  if (opts.repo) cfg.repo = opts.repo;
  if (opts.branch) cfg.branch = opts.branch;
  if (opts.browser) cfg.browser = opts.browser;
  if (opts['user-data-dir']) cfg.userDataDir = opts['user-data-dir'];

  const table = {
    profiles: cmd.cmdProfiles,
    status: cmd.cmdStatus,
    install: cmd.cmdInstall,
    update: cmd.cmdUpdate,
    import: cmd.cmdImport,
    keygen: cmd.cmdKeygen,
    source: cmd.cmdSource,
    doctor: cmd.cmdDoctor,
    pack: cmd.cmdPack,
    policy: cmd.cmdPolicy,
  };

  const fn = table[command];
  if (!fn) {
    err(`unknown command: ${command}`);
    log(HELP);
    process.exitCode = 1;
    return;
  }

  const code = await fn(cfg, opts);
  if (typeof code === 'number') process.exitCode = code;
}

module.exports = { main, parse, HELP };
