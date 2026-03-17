const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

const CONFIG_FILE_NAME = 'browser-manager.config.json';
const APP_HOME_DIR = path.join(app.getPath('temp'), 'browser-manager-data');
const CHROMIUM_CACHE_DIR = path.join(APP_HOME_DIR, 'chromium-kernel');
const CHROMIUM_META_FILE = path.join(APP_HOME_DIR, 'chromium-meta.json');
const runningBrowsers = new Map();
const kernelInstallState = {
  installing: false,
  progress: 0,
  message: '未开始'
};

app.setPath('userData', APP_HOME_DIR);

const createDefaultConfig = () => ({
  dataRootPath: path.join(APP_HOME_DIR, 'profiles'),
  defaultExecutablePath: '',
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
        profileDirName: String(item.profileDirName || '')
      }))
    : [];

  return {
    dataRootPath: String(safe.dataRootPath || createDefaultConfig().dataRootPath),
    defaultExecutablePath: String(safe.defaultExecutablePath || ''),
    browsers
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
    startUrl: String(candidate.startUrl || '').trim(),
    profileDirName: String(candidate.profileDirName || '').trim()
  };

  if (!normalized.profileDirName) {
    normalized.profileDirName = generateProfileDirName(normalized.name);
  }

  if (!normalized.id || !normalized.name || !normalized.executablePath) {
    throw new Error('浏览器配置不完整：名称、可执行路径为必填项。');
  }

  if (normalized.startUrl && !/^https?:\/\//i.test(normalized.startUrl)) {
    throw new Error('启动页面地址需以 http:// 或 https:// 开头。');
  }

  return normalized;
};

ipcMain.handle('config:get', async () => readConfig());

ipcMain.handle('config:save', async (_, config) => {
  const normalized = normalizeConfig(config);
  normalized.browsers = ensureUniqueProfileDirName(normalized.browsers).map(validateBrowser);
  await writeConfig(normalized);
  return normalized;
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
  if (validBrowser.startUrl) {
    args.push(validBrowser.startUrl);
  }

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
    running: true
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
