#!/usr/bin/env node
const fsp = require('node:fs/promises');
const path = require('node:path');

const DIST_DIR = path.resolve(__dirname, '..', 'dist');

const keepFile = (name) => {
  if (name.endsWith('.exe')) return true;
  if (name.endsWith('.dmg')) return true;
  if (name.endsWith('.pkg')) return true;
  if (name.endsWith('.zip')) return true;
  if (name === 'release-manifest.json') return true;
  if (name === 'release-manifest.md') return true;
  return false;
};

const removePath = async (targetPath) => {
  await fsp.rm(targetPath, { recursive: true, force: true });
};

const main = async () => {
  let entries;
  try {
    entries = await fsp.readdir(DIST_DIR, { withFileTypes: true });
  } catch (_) {
    return;
  }

  const removed = [];
  for (const entry of entries) {
    const fullPath = path.join(DIST_DIR, entry.name);
    if (entry.isFile()) {
      if (!keepFile(entry.name)) {
        await removePath(fullPath);
        removed.push(entry.name);
      }
      continue;
    }

    await removePath(fullPath);
    removed.push(entry.name + path.sep);
  }

  if (removed.length) {
    console.log(`Pruned dist (removed ${removed.length} items)`);
  } else {
    console.log('Pruned dist (nothing to remove)');
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

