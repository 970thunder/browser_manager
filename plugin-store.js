const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const extract = require('extract-zip');
const yauzl = require('yauzl');

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 5000;
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;

const slugify = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

const hashFile = async (filePath) => {
  const content = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
};

const inspectArchive = (filePath) =>
  new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (openError, archive) => {
      if (openError) {
        reject(new Error('插件包不是可读取的 ZIP 文件。'));
        return;
      }
      let files = 0;
      let uncompressedBytes = 0;
      let manifestFound = false;
      let settled = false;
      const fail = (error) => {
        if (!settled) {
          settled = true;
          archive.close();
          reject(error);
        }
      };
      archive.on('error', () => fail(new Error('插件 ZIP 读取失败。')));
      archive.on('entry', (entry) => {
        if (settled) return;
        const name = entry.fileName;
        const normalized = path.posix.normalize(name);
        if (
          name.startsWith('/') ||
          name.includes('\\') ||
          normalized === '..' ||
          normalized.startsWith('../') ||
          path.posix.isAbsolute(normalized)
        ) {
          fail(new Error('插件 ZIP 含有不安全的文件路径。'));
          return;
        }
        if (!name.endsWith('/')) {
          files += 1;
          uncompressedBytes += Number(entry.uncompressedSize || 0);
          if (files > MAX_FILES || uncompressedBytes > MAX_UNCOMPRESSED_BYTES) {
            fail(new Error('插件包解压后的文件数量或体积超过限制。'));
            return;
          }
          if (name === 'manifest.json') manifestFound = true;
        }
        archive.readEntry();
      });
      archive.on('end', () => {
        if (!settled) {
          settled = true;
          if (!manifestFound) {
            reject(new Error('插件 ZIP 根目录必须包含 manifest.json。'));
            return;
          }
          resolve();
        }
      });
      archive.readEntry();
    });
  });

const readManifest = async (filePath) => {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const manifest = JSON.parse(content.replace(/^\uFEFF/, ''));
    if (!manifest || typeof manifest !== 'object') throw new Error('bad manifest');
    if (Number(manifest.manifest_version) !== 3) {
      throw new Error('仅支持 Manifest V3 插件。');
    }
    if (!String(manifest.name || '').trim() || !String(manifest.version || '').trim()) {
      throw new Error('插件 manifest 缺少 name 或 version。');
    }
    return manifest;
  } catch (error) {
    if (error.message && !['bad manifest'].includes(error.message)) throw error;
    throw new Error('manifest.json 格式无效。');
  }
};

const findIcon = async (manifest, installPath) => {
  const icons = manifest.icons && typeof manifest.icons === 'object' ? manifest.icons : {};
  const candidate = Object.entries(icons)
    .sort((a, b) => Number(b[0]) - Number(a[0]))
    .map(([, value]) => String(value || ''))
    .find(Boolean);
  if (!candidate || candidate.includes('..') || path.isAbsolute(candidate)) return '';
  const iconPath = path.join(installPath, candidate);
  try {
    await fs.access(iconPath);
    return iconPath;
  } catch (_) {
    return '';
  }
};

const createPluginStore = ({ pluginsDir }) => {
  const importArchive = async (archivePath, existingPlugins) => {
    const stats = await fs.stat(archivePath);
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_ARCHIVE_BYTES) {
      throw new Error('插件 ZIP 文件为空或超过 50MB 限制。');
    }
    await inspectArchive(archivePath);
    const hash = await hashFile(archivePath);
    const tempPath = path.join(pluginsDir, `.upload-${crypto.randomUUID()}`);
    await fs.mkdir(pluginsDir, { recursive: true });
    try {
      await extract(archivePath, { dir: tempPath });
      const manifest = await readManifest(path.join(tempPath, 'manifest.json'));
      const pluginId = manifest.key
        ? crypto.createHash('sha256').update(String(manifest.key)).digest('hex').slice(0, 24)
        : slugify(manifest.name);
      if (!pluginId) throw new Error('无法从插件名称生成唯一标识。');
      const previous = Array.isArray(existingPlugins) ? existingPlugins.find((item) => item.id === pluginId) : null;
      if (previous && previous.version === String(manifest.version) && previous.hash === hash) {
        throw new Error('该插件版本已经上传。');
      }
      const installPath = path.join(pluginsDir, pluginId, `${String(manifest.version)}-${hash.slice(0, 12)}`);
      await fs.mkdir(path.dirname(installPath), { recursive: true });
      await fs.rm(installPath, { recursive: true, force: true });
      await fs.rename(tempPath, installPath);
      const iconPath = await findIcon(manifest, installPath);
      return {
        id: pluginId,
        name: String(manifest.name).trim(),
        version: String(manifest.version).trim(),
        description: String(manifest.description || '').trim(),
        enabled: true,
        installPath,
        iconPath,
        hash,
        uploadedAt: new Date().toISOString()
      };
    } catch (error) {
      await fs.rm(tempPath, { recursive: true, force: true });
      throw error;
    }
  };

  const getEnabledPaths = async (plugins) => {
    const result = [];
    for (const plugin of Array.isArray(plugins) ? plugins : []) {
      if (!plugin || !plugin.enabled || !plugin.installPath) continue;
      const relative = path.relative(pluginsDir, plugin.installPath);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`插件“${plugin.name || plugin.id}”的安装目录不在受控插件仓库内。`);
      }
      try {
        await fs.access(path.join(plugin.installPath, 'manifest.json'));
        result.push(plugin.installPath);
      } catch (_) {
        throw new Error(`已启用插件“${plugin.name || plugin.id}”的文件不存在，请重新上传。`);
      }
    }
    return result;
  };

  return { importArchive, getEnabledPaths };
};

module.exports = { createPluginStore };
