const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

const CONFIG_FILE_NAME = 'browser-manager.config.json';
const APP_HOME_DIR = path.join(app.getPath('temp'), 'browser-manager-data');
const CHROMIUM_CACHE_DIR = path.join(APP_HOME_DIR, 'chromium-kernel');
const CHROMIUM_META_FILE = path.join(APP_HOME_DIR, 'chromium-meta.json');
const runningBrowsers = new Map();
const DEFAULT_FIRST_TAB_URL = 'https://qifu.baidu.com/?activeKey=SEARCH_IP&trace=apistore_ip_aladdin&activeId=SEARCH_IP_ADDRESS&ip=';
const PROXY_CACHE_TTL_MS = 3 * 60 * 1000;
const kernelInstallState = {
  installing: false,
  progress: 0,
  message: '未开始'
};

app.setPath('userData', APP_HOME_DIR);

const createDefaultConfig = () => ({
  dataRootPath: path.join(APP_HOME_DIR, 'profiles'),
  defaultExecutablePath: '',
  proxyApiUrl: '',
  updateManifestUrl: '',
  browsers: []
});

const getConfigFilePath = () => path.join(app.getPath('userData'), CONFIG_FILE_NAME);

const slugifyName = (name) =>
  String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36);

const generateProfileDirName = (name) => {
  const base = slugifyName(name) || 'browser';
  const suffix = crypto.randomBytes(3).toString('hex');
  return `${base}-${suffix}`;
};

const normalizeConfig = (raw) => {
  const safe = raw && typeof raw === 'object' ? raw : {};
  const browsers = Array.isArray(safe.browsers)
    ? safe.browsers.map((item) => ({
        id: String(item.id || ''),
        name: String(item.name || ''),
        executablePath: String(item.executablePath || ''),
        startUrl: String(item.startUrl || ''),
        startUrlsText: String(item.startUrlsText || item.startUrl || ''),
        profileDirName: String(item.profileDirName || ''),
        enableProxy: Boolean(item.enableProxy),
        proxyCache: item && typeof item === 'object' ? item.proxyCache || null : null,
        proxyRecords: item && typeof item === 'object' ? item.proxyRecords || [] : []
      }))
    : [];

  let proxyApiUrl = String(safe.proxyApiUrl || '');
  if (!proxyApiUrl && Array.isArray(safe.browsers)) {
    for (const item of safe.browsers) {
      const candidate = item && typeof item === 'object' ? String(item.proxyApiUrl || '').trim() : '';
      if (candidate) {
        proxyApiUrl = candidate;
        break;
      }
    }
  }

  return {
    dataRootPath: String(safe.dataRootPath || createDefaultConfig().dataRootPath),
    defaultExecutablePath: String(safe.defaultExecutablePath || ''),
    proxyApiUrl,
    updateManifestUrl: String(safe.updateManifestUrl || ''),
    browsers
  };
};

const validateHttpUrl = (urlText, fieldName) => {
  const text = String(urlText || '').trim();
  if (!text) {
    return '';
  }
  let url;
  try {
    url = new URL(text);
  } catch (_) {
    throw new Error(`${fieldName} 格式不正确。`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${fieldName} 需以 http:// 或 https:// 开头。`);
  }
  return text;
};

const validateUpdateSource = (value) => {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  if (/^github:/i.test(text)) {
    const repo = text.slice('github:'.length).trim();
    if (!/^[^/]+\/[^/]+$/.test(repo)) {
      throw new Error('GitHub 仓库格式不正确，应为 github:owner/repo。');
    }
    return `github:${repo}`;
  }
  return validateHttpUrl(text, '更新源');
};

const getGitHubLatestReleaseApi = (repo) => `https://api.github.com/repos/${repo}/releases/latest`;

const normalizeGitHubVersionTag = (tag) => String(tag || '').trim().replace(/^v/i, '');

const compareVersions = (a, b) => {
  const pa = String(a || '0').split('.').map((n) => Number(n) || 0);
  const pb = String(b || '0').split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
};

const fetchJson = async (urlString, timeoutMs = 12000) => {
  const text = await fetchText(urlString, timeoutMs);
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new Error('更新清单解析失败（不是合法 JSON）。');
  }
};

const parseUpdatePayload = (data) => {
  if (!data || typeof data !== 'object') {
    throw new Error('更新源返回数据不正确。');
  }

  if (data.tag_name) {
    const latestVersion = normalizeGitHubVersionTag(data.tag_name);
    if (!latestVersion) {
      throw new Error('GitHub Release 缺少 tag_name。');
    }
    return {
      latestVersion,
      downloadPageUrl: String(data.html_url || '').trim(),
      notes: String(data.name || data.body || '').trim()
    };
  }

  const latestVersion = String(data.version || '').trim();
  if (!latestVersion) {
    throw new Error('更新清单缺少 version 字段。');
  }
  return {
    latestVersion,
    downloadPageUrl: String(data.downloadPageUrl || '').trim(),
    notes: String(data.notes || '').trim()
  };
};

const fileExists = async (filePath) => {
  if (!filePath) {
    return false;
  }
  try {
    await fs.access(filePath);
    return true;
  } catch (_) {
    return false;
  }
};

const detectDefaultExecutablePath = async () => {
  try {
    const content = await fs.readFile(CHROMIUM_META_FILE, 'utf-8');
    const parsed = JSON.parse(content);
    const executablePath = String(parsed.executablePath || '');
    const exists = await fileExists(executablePath);
    return exists ? executablePath : '';
  } catch (_) {
    return '';
  }
};

const getLocalKernelCandidates = async () => {
  const config = await readConfig();
  const candidates = [];
  const pushCandidate = (name, executablePath, source) => {
    if (!executablePath) {
      return;
    }
    candidates.push({ name, executablePath, source });
  };

  pushCandidate('当前默认路径', config.defaultExecutablePath, 'config');
  const chromiumFromMeta = await detectDefaultExecutablePath();
  pushCandidate('内置 Chromium', chromiumFromMeta, 'bundled');

  if (process.platform === 'darwin') {
    pushCandidate('Google Chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'system');
    pushCandidate('Microsoft Edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'system');
    pushCandidate('Chromium', '/Applications/Chromium.app/Contents/MacOS/Chromium', 'system');
    pushCandidate('Brave Browser', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', 'system');
  } else if (process.platform === 'win32') {
    const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']].filter(
      Boolean
    );
    for (const root of roots) {
      pushCandidate('Google Chrome', path.join(root, 'Google/Chrome/Application/chrome.exe'), 'system');
      pushCandidate('Microsoft Edge', path.join(root, 'Microsoft/Edge/Application/msedge.exe'), 'system');
      pushCandidate('Chromium', path.join(root, 'Chromium/Application/chrome.exe'), 'system');
      pushCandidate('Brave Browser', path.join(root, 'BraveSoftware/Brave-Browser/Application/brave.exe'), 'system');
    }
  } else {
    pushCandidate('Google Chrome', '/usr/bin/google-chrome', 'system');
    pushCandidate('Chromium', '/usr/bin/chromium', 'system');
    pushCandidate('Chromium Browser', '/usr/bin/chromium-browser', 'system');
    pushCandidate('Microsoft Edge', '/usr/bin/microsoft-edge', 'system');
  }

  const deduped = new Map();
  for (const item of candidates) {
    if (!deduped.has(item.executablePath)) {
      deduped.set(item.executablePath, item);
    }
  }

  const existing = [];
  for (const item of deduped.values()) {
    const exists = await fileExists(item.executablePath);
    if (exists) {
      existing.push(item);
    }
  }

  const preferredPath = existing[0] ? existing[0].executablePath : '';
  const hasBundledChromium = existing.some((item) => item.source === 'bundled');
  return {
    found: existing.length > 0,
    preferredPath,
    hasBundledChromium,
    candidates: existing
  };
};

const readConfig = async () => {
  const configPath = getConfigFilePath();
  try {
    const content = await fs.readFile(configPath, 'utf-8');
    const parsed = normalizeConfig(JSON.parse(content));
    if (!parsed.defaultExecutablePath) {
      const detected = await detectDefaultExecutablePath();
      if (detected) {
        parsed.defaultExecutablePath = detected;
        await writeConfig(parsed);
      }
    }
    return parsed;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      const fallback = createDefaultConfig();
      const detected = await detectDefaultExecutablePath();
      fallback.defaultExecutablePath = detected;
      await writeConfig(fallback);
      return fallback;
    }
    throw error;
  }
};

const writeConfig = async (config) => {
  const configPath = getConfigFilePath();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(normalizeConfig(config), null, 2), 'utf-8');
};

const ensureUniqueProfileDirName = (browsers) => {
  const taken = new Set();
  return browsers.map((browser) => {
    const normalized = { ...browser };
    if (!normalized.profileDirName) {
      normalized.profileDirName = generateProfileDirName(normalized.name);
    }
    while (taken.has(normalized.profileDirName)) {
      normalized.profileDirName = generateProfileDirName(normalized.name);
    }
    taken.add(normalized.profileDirName);
    return normalized;
  });
};

const createWindow = () => {
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 640,
    title: '浏览器多开管理器',
    backgroundColor: '#d8e3f4',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.loadFile(path.join(__dirname, 'index.html'));
};

const validateBrowser = (browser) => {
  const candidate = browser && typeof browser === 'object' ? browser : {};
  const normalized = {
    id: String(candidate.id || '').trim(),
    name: String(candidate.name || '').trim(),
    executablePath: String(candidate.executablePath || '').trim(),
    startUrlsText: String(candidate.startUrlsText || candidate.startUrl || '')
      .replace(/\r\n/g, '\n')
      .trim(),
    profileDirName: String(candidate.profileDirName || '').trim(),
    enableProxy: Boolean(candidate.enableProxy),
    proxyCache: candidate && typeof candidate === 'object' ? candidate.proxyCache || null : null,
    proxyRecords: candidate && typeof candidate === 'object' ? candidate.proxyRecords || [] : []
  };

  if (!normalized.profileDirName) {
    normalized.profileDirName = generateProfileDirName(normalized.name);
  }

  if (!normalized.id || !normalized.name || !normalized.executablePath) {
    throw new Error('浏览器配置不完整：名称、可执行路径为必填项。');
  }

  if (normalized.startUrlsText) {
    const urls = normalized.startUrlsText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    for (const urlText of urls) {
      if (!/^https?:\/\//i.test(urlText)) {
        throw new Error('启动页面地址需以 http:// 或 https:// 开头（每行一个）。');
      }
      try {
        const url = new URL(urlText);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          throw new Error('bad protocol');
        }
      } catch (_) {
        throw new Error('启动页面地址格式不正确（每行一个）。');
      }
    }
  }

  return normalized;
};

const parseStartUrlsText = (startUrlsText) =>
  String(startUrlsText || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

const normalizeProxyCache = (proxyCache) => {
  if (!proxyCache || typeof proxyCache !== 'object') {
    return null;
  }
  const proxyServer = String(proxyCache.proxyServer || '').trim();
  const display = String(proxyCache.display || '').trim();
  const fetchedAt = Number(proxyCache.fetchedAt || 0);
  const apiUrl = String(proxyCache.apiUrl || '').trim();
  if (!proxyServer || !display || !Number.isFinite(fetchedAt) || fetchedAt <= 0) {
    return null;
  }
  return { proxyServer, display, fetchedAt, apiUrl };
};

const normalizeProxyRecords = (records) => {
  const list = Array.isArray(records) ? records : [];
  const normalized = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const display = String(item.display || '').trim();
    const proxyServer = String(item.proxyServer || '').trim();
    const fetchedAt = Number(item.fetchedAt || 0);
    if (!display || !proxyServer || !Number.isFinite(fetchedAt) || fetchedAt <= 0) {
      continue;
    }
    normalized.push({ display, proxyServer, fetchedAt });
  }
  normalized.sort((a, b) => b.fetchedAt - a.fetchedAt);
  return normalized.slice(0, 50);
};

const fetchText = async (urlString, timeoutMs = 12000) =>
  new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch (_) {
      reject(new Error('代理 API 链接格式不正确。'));
      return;
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      reject(new Error('代理 API 链接需使用 http 或 https。'));
      return;
    }

    const requester = url.protocol === 'https:' ? https : http;
    const req = requester.request(
      url,
      {
        method: 'GET',
        headers: {
          'user-agent': 'BrowserManager/1.0'
        }
      },
      (res) => {
        const statusCode = res.statusCode || 0;
        if (statusCode < 200 || statusCode >= 300) {
          res.resume();
          reject(new Error(`代理 API 请求失败：HTTP ${statusCode}`));
          return;
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      }
    );

    req.on('error', () => reject(new Error('代理 API 请求失败，请检查网络或链接是否可访问。')));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout'));
      reject(new Error('代理 API 请求超时。'));
    });
    req.end();
  });

const inferProxySchemeFromApiUrl = (proxyApiUrl) => {
  try {
    const url = new URL(proxyApiUrl);
    const protocol = String(url.searchParams.get('protocol') || '').trim().toLowerCase();
    if (protocol === '2' || protocol === 'socks' || protocol === 'socks5') {
      return 'socks5';
    }
  } catch (_) {}
  return 'http';
};

const parseProxyText = (text, proxyApiUrl) => {
  const raw = String(text || '').trim();
  if (!raw) {
    throw new Error('代理 API 返回为空。');
  }

  const firstToken = raw.split(/\s+/)[0].trim();
  if (!firstToken) {
    throw new Error('代理 API 返回为空。');
  }

  let first = firstToken;
  for (const sep of ['|', ',', ';']) {
    const idx = first.indexOf(sep);
    if (idx > 0) {
      first = first.slice(0, idx);
    }
  }

  first = first.trim();
  if (!first) {
    throw new Error('代理 API 返回为空。');
  }

  if (first.includes('://')) {
    try {
      const url = new URL(first);
      if (url.username || url.password) {
        return { proxyServer: `${url.protocol}//${url.hostname}:${url.port}`, display: `${url.hostname}:${url.port}`, requiresAuth: true };
      }
      return { proxyServer: first, display: first, requiresAuth: false };
    } catch (_) {
      return { proxyServer: first, display: first, requiresAuth: false };
    }
  }

  const scheme = inferProxySchemeFromApiUrl(proxyApiUrl);

  if (first.includes('@')) {
    const atIndex = first.lastIndexOf('@');
    const authPart = first.slice(0, atIndex);
    const hostPart = first.slice(atIndex + 1);
    const authPieces = authPart.split(':');
    const hostPieces = hostPart.split(':');
    const host = hostPieces[0];
    const portTextMatch = String(hostPieces[1] || '').match(/^\d{1,5}/);
    const port = portTextMatch ? Number(portTextMatch[0]) : NaN;
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error('代理端口不正确。');
    }
    const username = authPieces[0] || '';
    const password = authPieces[1] || '';
    return {
      proxyServer: `${scheme}://${host}:${port}`,
      display: `${host}:${port}`,
      requiresAuth: Boolean(username && password)
    };
  }

  const parts = first.split(':');
  if (parts.length < 2) {
    throw new Error(`代理格式不正确：${firstToken.slice(0, 60)}`);
  }

  const host = parts[0];
  const portTextMatch = String(parts[1] || '').match(/^\d{1,5}/);
  const port = portTextMatch ? Number(portTextMatch[0]) : NaN;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('代理端口不正确。');
  }

  const username = parts.length >= 4 ? String(parts[2] || '') : '';
  const password = parts.length >= 4 ? String(parts[3] || '') : '';

  return {
    proxyServer: `${scheme}://${host}:${port}`,
    display: `${host}:${port}`,
    requiresAuth: Boolean(username && password)
  };
};

ipcMain.handle('app:get-info', async () => ({
  name: app.getName(),
  version: app.getVersion()
}));

ipcMain.handle('config:get', async () => readConfig());

ipcMain.handle('config:save', async (_, config) => {
  const normalized = normalizeConfig(config);
  normalized.proxyApiUrl = validateHttpUrl(normalized.proxyApiUrl, '代理 API 链接');
  normalized.updateManifestUrl = validateUpdateSource(normalized.updateManifestUrl);
  normalized.browsers = ensureUniqueProfileDirName(normalized.browsers).map(validateBrowser);
  await writeConfig(normalized);
  return normalized;
});

ipcMain.handle('shell:open-external', async (_, urlText) => {
  const url = validateHttpUrl(urlText, '链接');
  await shell.openExternal(url);
  return true;
});

ipcMain.handle('update:check', async (_, manifestUrl) => {
  const config = await readConfig();
  const source = validateUpdateSource(manifestUrl || config.updateManifestUrl);
  if (!source) {
    throw new Error('请先填写更新源（github:owner/repo 或一个 JSON 地址）。');
  }

  const url = /^github:/i.test(source) ? getGitHubLatestReleaseApi(source.slice('github:'.length)) : source;
  const data = await fetchJson(url, 15000);
  const parsed = parseUpdatePayload(data);
  const latestVersion = parsed.latestVersion;
  const currentVersion = app.getVersion();
  const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;
  const downloadPageUrl = parsed.downloadPageUrl ? validateHttpUrl(parsed.downloadPageUrl, '下载页 URL') : '';
  const notes = String(parsed.notes || '').trim();
  return {
    currentVersion,
    latestVersion,
    hasUpdate,
    downloadPageUrl,
    notes
  };
});

ipcMain.handle('dialog:pick-directory', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return '';
  }

  return result.filePaths[0];
});

ipcMain.handle('dialog:pick-file', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return '';
  }

  return result.filePaths[0];
});

ipcMain.handle('kernel:install-chromium', async () => {
  if (kernelInstallState.installing) {
    throw new Error('正在安装内核，请稍候。');
  }
  kernelInstallState.installing = true;
  kernelInstallState.progress = 4;
  kernelInstallState.message = '准备安装环境...';
  const browsersApi = await import('@puppeteer/browsers');
  const platform = browsersApi.detectBrowserPlatform();
  if (!platform) {
    kernelInstallState.installing = false;
    kernelInstallState.progress = 0;
    kernelInstallState.message = '当前系统不支持';
    throw new Error('当前系统暂不支持自动安装 Chromium 内核。');
  }

  const buildId = await browsersApi.resolveBuildId(browsersApi.Browser.CHROMIUM, platform, 'latest');
  try {
    kernelInstallState.progress = 12;
    kernelInstallState.message = '开始下载 Chromium 内核...';
    const installed = await browsersApi.install({
      browser: browsersApi.Browser.CHROMIUM,
      buildId,
      cacheDir: CHROMIUM_CACHE_DIR,
      platform,
      downloadProgressCallback: (downloadedBytes, totalBytes) => {
        if (!totalBytes) {
          return;
        }
        const ratio = downloadedBytes / totalBytes;
        kernelInstallState.progress = Math.max(12, Math.min(96, Math.round(ratio * 84 + 12)));
        kernelInstallState.message = '正在下载 Chromium 内核...';
      }
    });

    kernelInstallState.progress = 97;
    kernelInstallState.message = '写入配置...';
    await fs.mkdir(path.dirname(CHROMIUM_META_FILE), { recursive: true });
    await fs.writeFile(
      CHROMIUM_META_FILE,
      JSON.stringify({ executablePath: installed.executablePath }, null, 2),
      'utf-8'
    );

    const config = await readConfig();
    config.defaultExecutablePath = installed.executablePath;
    await writeConfig(config);
    kernelInstallState.progress = 100;
    kernelInstallState.message = '安装完成';

    return {
      executablePath: installed.executablePath
    };
  } catch (error) {
    kernelInstallState.progress = 0;
    kernelInstallState.message = '安装失败';
    throw error;
  } finally {
    kernelInstallState.installing = false;
  }
});

ipcMain.handle('kernel:detect-local', async () => {
  const result = await getLocalKernelCandidates();
  if (result.preferredPath) {
    const config = await readConfig();
    if (config.defaultExecutablePath !== result.preferredPath) {
      config.defaultExecutablePath = result.preferredPath;
      await writeConfig(config);
    }
  }
  return result;
});

ipcMain.handle('kernel:get-install-progress', async () => ({ ...kernelInstallState }));

ipcMain.handle('browser:launch', async (_, browserId) => {
  const browserIdText = String(browserId);
  if (runningBrowsers.has(browserIdText)) {
    const active = runningBrowsers.get(browserIdText);
    return {
      profilePath: active.profilePath,
      launched: true,
      running: true
    };
  }

  const config = await readConfig();
  const browser = config.browsers.find((item) => item.id === browserIdText);

  if (!browser) {
    throw new Error('未找到对应浏览器配置。');
  }

  const validBrowser = validateBrowser(browser);
  const profilePath = path.join(config.dataRootPath, validBrowser.profileDirName);

  await fs.mkdir(profilePath, { recursive: true });
  const exists = await fileExists(validBrowser.executablePath);
  if (!exists) {
    throw new Error('可执行文件不存在，请重新选择或安装 Chromium 内核。');
  }

  const args = [`--user-data-dir=${profilePath}`];
  let usedProxy = '';
  if (validBrowser.enableProxy) {
    if (!config.proxyApiUrl) {
      throw new Error('未配置全局代理 API 链接，请先在设置中填写。');
    }
    const cache = normalizeProxyCache(validBrowser.proxyCache);
    const now = Date.now();
    const cacheValid =
      cache &&
      now - cache.fetchedAt < PROXY_CACHE_TTL_MS &&
      (!cache.apiUrl || cache.apiUrl === config.proxyApiUrl);

    let selectedProxy = cacheValid ? cache : null;
    if (!selectedProxy) {
      const proxyText = await fetchText(config.proxyApiUrl);
      const parsed = parseProxyText(proxyText, config.proxyApiUrl);
      if (parsed.requiresAuth) {
        throw new Error(
          '当前版本暂不支持带账号密码的代理（会导致浏览器提示 ERR_NO_SUPPORTED_PROXIES）。请在代理接口中关闭账号密码返回（不要带 pw=1），或改用 IP 白名单鉴权。'
        );
      }

      selectedProxy = {
        proxyServer: parsed.proxyServer,
        display: parsed.display,
        fetchedAt: now,
        apiUrl: config.proxyApiUrl
      };

      const records = normalizeProxyRecords(validBrowser.proxyRecords);
      records.unshift({ display: parsed.display, proxyServer: parsed.proxyServer, fetchedAt: now });

      const idx = config.browsers.findIndex((item) => item.id === validBrowser.id);
      if (idx !== -1) {
        const next = { ...config.browsers[idx], proxyCache: selectedProxy, proxyRecords: records };
        config.browsers.splice(idx, 1, next);
        await writeConfig(config);
      }
    }

    usedProxy = selectedProxy.display;
    args.push(`--proxy-server=${selectedProxy.proxyServer}`);
  }
  const userUrls = parseStartUrlsText(validBrowser.startUrlsText);
  const launchUrls = [DEFAULT_FIRST_TAB_URL, ...userUrls.filter((url) => url !== DEFAULT_FIRST_TAB_URL)];
  args.push(...launchUrls);

  const child = spawn(validBrowser.executablePath, args, {
    detached: true,
    stdio: 'ignore'
  });

  runningBrowsers.set(browserIdText, {
    pid: child.pid,
    profilePath
  });
  child.once('exit', () => {
    runningBrowsers.delete(browserIdText);
  });
  child.unref();

  return {
    profilePath,
    launched: true,
    running: true,
    proxy: usedProxy
  };
});

const killProcessTree = async (pid) => {
  if (!pid) {
    return;
  }

  if (process.platform === 'win32') {
    await new Promise((resolve, reject) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f']);
      killer.once('error', reject);
      killer.once('exit', (code) => {
        if (code === 0 || code === 128 || code === 255) {
          resolve();
          return;
        }
        reject(new Error('停止进程失败'));
      });
    });
    return;
  }

  process.kill(-pid, 'SIGTERM');
};

ipcMain.handle('browser:stop', async (_, browserId) => {
  const browserIdText = String(browserId);
  const item = runningBrowsers.get(browserIdText);
  if (!item) {
    return { stopped: true, running: false };
  }

  await killProcessTree(item.pid);
  runningBrowsers.delete(browserIdText);
  return { stopped: true, running: false };
});

ipcMain.handle('browser:list-running-ids', async () => Array.from(runningBrowsers.keys()));

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
