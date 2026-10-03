#!/usr/bin/env node
'use strict';

require('../src/cli').main(process.argv.slice(2)).catch((e) => {
  console.error('epm: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
