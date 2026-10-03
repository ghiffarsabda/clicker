'use strict';

const os = require('os');
const path = require('path');
const { exists, readJson, expandHome } = require('./util');

const EPM_DIR = path.join(os.homedir(), '.epm');
const CONFIG_PATH = path.join(EPM_DIR, 'config.json');

const DEFAULT_CONFIG = {
  repo: 'https://github.com/ghiffarsabda/clicker.git',
  branch: 'main',
  source: path.join(EPM_DIR, 'clicker'),
  browser: null,
  userDataDir: null,
};

function loadConfig() {
  const cfg = { ...DEFAULT_CONFIG };
  if (exists(CONFIG_PATH)) {
    let parsed;
    try { parsed = readJson(CONFIG_PATH); }
    catch (e) { throw new Error('config.json is not valid JSON: ' + e.message); }
    Object.assign(cfg, parsed);
  }
  if (cfg.source) cfg.source = expandHome(cfg.source);
  if (cfg.browser) cfg.browser = expandHome(cfg.browser);
  if (cfg.userDataDir) cfg.userDataDir = expandHome(cfg.userDataDir);
  return cfg;
}

module.exports = { EPM_DIR, CONFIG_PATH, DEFAULT_CONFIG, loadConfig };
