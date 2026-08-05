#!/usr/bin/env node
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const DIST_DIR = path.resolve(__dirname, '..', 'dist');
const OUT_JSON = path.join(DIST_DIR, 'release-manifest.json');
const OUT_MD = path.join(DIST_DIR, 'release-manifest.md');

const isInstaller = (name) => {
  if (name.endsWith('.exe')) return true;
  if (name.endsWith('.dmg')) return true;
  if (name.endsWith('.pkg')) return true;
  if (name.endsWith('.zip')) return true;
  return false;
};

const detectPlatform = (name) => {
  if (name.includes('-win-')) return 'Windows';
  if (name.includes('-mac-')) return 'macOS';
  return 'Unknown';
};

const detectArch = (name) => {
  const m = name.match(/-(win|mac)-([a-z0-9]+)\./i);
  return m ? m[2] : 'unknown';
};

const sha256File = async (filePath) =>
  new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });

const main = async () => {
  await fsp.mkdir(DIST_DIR, { recursive: true });
  const files = await fsp.readdir(DIST_DIR);
  const targets = files.filter((f) => isInstaller(f)).sort();

  const entries = [];
  for (const name of targets) {
    const filePath = path.join(DIST_DIR, name);
    const stat = await fsp.stat(filePath);
    const checksum = await sha256File(filePath);
    entries.push({
      filename: name,
      platform: detectPlatform(name),
      arch: detectArch(name),
      size_bytes: stat.size,
      size_mb: +(stat.size / (1024 * 1024)).toFixed(2),
      sha256: checksum,
      path: filePath
    });
  }

  const json = {
    product: 'BrowserManager',
    version: require(path.resolve(__dirname, '..', 'package.json')).version,
    generated_at: new Date().toISOString(),
    files: entries
  };
  await fsp.writeFile(OUT_JSON, JSON.stringify(json, null, 2), 'utf-8');

  const mdLines = [];
  mdLines.push(`# BrowserManager 发布清单`);
  mdLines.push(`版本：${json.version}`);
  mdLines.push(`生成时间：${json.generated_at}`);
  mdLines.push('');
  mdLines.push('| 平台 | 架构 | 文件 | 大小(MB) | SHA256 |');
  mdLines.push('|---|---|---|---:|---|');
  for (const e of entries) {
    mdLines.push(`| ${e.platform} | ${e.arch} | ${e.filename} | ${e.size_mb} | ${e.sha256} |`);
  }
  mdLines.push('');
  mdLines.push('校验方法（macOS）：`shasum -a 256 <文件名>`');
  mdLines.push('校验方法（Windows）：使用 PowerShell：`Get-FileHash <文件名> -Algorithm SHA256`');
  await fsp.writeFile(OUT_MD, mdLines.join('\n'), 'utf-8');

  console.log(`Generated:\n- ${OUT_JSON}\n- ${OUT_MD}`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
