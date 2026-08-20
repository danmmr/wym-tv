#!/usr/bin/env node
/**
 * Materialize the gitignored config files from their tracked examples.
 *
 * src/config/hosts.data.json and src/config/plex.ts are gitignored on purpose:
 * one is this network's layout, the other may hold a Plex token. But both are
 * imported unconditionally by src/config/hosts.ts and src/api/plex.ts, so
 * without them a fresh clone does not typecheck and most of the test suite
 * cannot even resolve its mocks. "Configure your LAN before `npm test` will
 * run" is a bad first five minutes, and it makes CI impossible without secrets.
 *
 * So: npm runs this on postinstall, and it copies each example into place if
 * and only if the real file is absent. The examples carry placeholder addresses
 * and a placeholder library id, which is enough to compile, test and lint —
 * not to reach anyone's actual Plex server. deploy.sh still refuses to build
 * against them, so there is no way to ship a placeholder build by accident.
 *
 * It never overwrites an existing file, so it is safe on every reinstall.
 */
const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '..', 'src', 'config');

const PAIRS = [
  ['hosts.data.example.json', 'hosts.data.json'],
  ['plex.example.ts', 'plex.ts'],
];

let created = 0;

for (const [exampleName, targetName] of PAIRS) {
  const example = path.join(CONFIG_DIR, exampleName);
  const target = path.join(CONFIG_DIR, targetName);

  if (fs.existsSync(target)) {
    continue;
  }
  if (!fs.existsSync(example)) {
    console.warn(`setup-config: ${exampleName} is missing, cannot create ${targetName}`);
    continue;
  }

  fs.copyFileSync(example, target);
  console.log(`setup-config: created src/config/${targetName} from ${exampleName}`);
  created += 1;
}

if (created > 0) {
  console.log(
    'setup-config: those are PLACEHOLDER addresses — edit them before ./deploy.sh',
  );
}
