const state = {
  config: {
    dataRootPath: '',
    defaultExecutablePath: '',
    proxyApiUrl: '',
    updateManifestUrl: '',
    scripts: [],
    plugins: [],
    browsers: []
  },
  editingBrowserId: '',
  editingScriptId: '',
  activeScriptRunId: '',
  scriptWorker: null,
  runningBrowserIds: new Set(),
  runningStatusTimer: null,
  kernelLookup: {
    found: false,
    candidates: [],
    installing: false,
    installProgress: 0,
    installMessage: '',
    pollingTimer: null
  }
};

const SCRIPT_TOTAL_TIMEOUT_MS = 5 * 60 * 1000;
const CODEFLYING_TEMPLATE_NAME = 'CodeFlying 手动登录自动化';
const CODEFLYING_ASSISTED_TEMPLATE = `// 请填写本轮由你本人授权使用的手机号。脚本不会获取短信验证码。
const phone = '请填写已授权手机号';
const ideas = [
  '设计一个面向独立咖啡店的今日特调推荐应用，支持按天气、预算和口味生成推荐，并以清爽的卡片界面展示。',
  '设计一个城市周末活动规划应用，用户选择预算和兴趣后获得半日路线、交通建议和待办清单。',
  '设计一个宠物健康记录应用，记录疫苗、体重、饮水和散步情况，并生成每周关怀提醒。',
  '设计一个家庭食材管理应用，录入食材保质期后推荐三道可完成的菜谱，并提供购物清单。',
  '设计一个自由职业者项目看板应用，包含客户、报价、任务进度、回款日期和本周优先级。'
];

const clickByText = async (pageId, text) => browserManager.pages.evaluate(
  pageId,
  '(() => { const target = Array.from(document.querySelectorAll("button,a,[role=button]"))'
    + '.find((element) => (element.innerText || element.textContent || "").trim().includes(' + JSON.stringify(text) + '));'
    + 'if (!target) throw new Error("找不到操作入口：" + ' + JSON.stringify(text) + '); target.click(); return true; })()'
);

const browser = await browserManager.browsers.create({
  name: 'CodeFlying 自动化 ' + browserManager.context.iteration,
  startUrl: 'https://codeflying.cgref.cn/s/qyk4vg3k87'
});
await browserManager.browsers.launch(browser.id);
const page = await browserManager.pages.open(browser.id, 'https://codeflying.cgref.cn/s/qyk4vg3k87');

await browserManager.log('第 ' + browserManager.context.iteration + '/' + browserManager.context.count + ' 轮：请在打开的浏览器中自行完成登录，脚本将等待两分钟。');
await browserManager.pages.click(page.id, 'a[href^="/login"]');
await browserManager.pages.delay(page.id, 120000);

await browserManager.pages.goto(page.id, 'https://codeflying.cgref.cn/s/qyk4vg3k87');
const idea = ideas[(browserManager.context.iteration - 1) % ideas.length];
await browserManager.pages.type(page.id, '[placeholder*="输入您想生成的应用"]', idea, true);
await clickByText(page.id, '立即开发');
await browserManager.pages.delay(page.id, 20000);

await clickByText(page.id, '我的应用');
await browserManager.pages.delay(page.id, 1500);
const screenshot = await browserManager.pages.screenshot(page.id, true);

await clickByText(page.id, '设置');
await browserManager.pages.delay(page.id, 1000);
const nickname = await browserManager.pages.evaluate(page.id, '(() => { const input = Array.from(document.querySelectorAll("input")).find((element) => { const hint = [element.name, element.id, element.placeholder, element.getAttribute("aria-label")].filter(Boolean).join(" "); return /昵称|nick(name)?/i.test(hint); }); if (input && input.value) return input.value.trim(); const label = Array.from(document.querySelectorAll("label,span,div")).find((element) => (element.textContent || "").trim() === "昵称"); if (label) { const value = label.parentElement && label.parentElement.querySelector("input"); if (value && value.value) return value.value.trim(); } throw new Error("未找到昵称。请根据登录后的页面结构调整昵称选择器。"); })()');

const result = await browserManager.records.append({ phone, screenshot: screenshot.path, nickname });
await browserManager.log('第 ' + browserManager.context.iteration + ' 轮完成，Excel：' + result.resultsPath);`;

const CODEFLYING_SMS_TEMPLATE = `// 仅用于你有权测试的 CodeFlying 站点。先在“设置 -> 短信测试”中保存易接码 Token 和短信关键词。
const ideas = [
  '设计一个独立咖啡店特调推荐应用，按天气、预算和口味生成推荐卡片。',
  '设计一个城市周末活动规划应用，根据预算和兴趣生成半日路线和待办清单。',
  '设计一个宠物健康记录应用，记录疫苗、体重、饮水和散步提醒。',
  '设计一个家庭食材管理应用，根据保质期推荐菜谱并生成购物清单。',
  '设计一个自由职业者项目看板应用，展示客户、报价、进度和回款日期。'
];

const clickByText = async (pageId, text) => browserManager.pages.evaluate(
  pageId,
  '(() => { const target = Array.from(document.querySelectorAll("button,a,[role=button]"))'
    + '.find((element) => (element.innerText || element.textContent || "").trim().includes(' + JSON.stringify(text) + '));'
    + 'if (!target) throw new Error("找不到操作入口：" + ' + JSON.stringify(text) + '); target.click(); return true; })()'
);
const clickAny = async (pageId, labels) => {
  for (const label of labels) {
    try { return await clickByText(pageId, label); } catch (_) {}
  }
  throw new Error('找不到登录操作按钮。');
};
const fillByHint = async (pageId, value, pattern) => browserManager.pages.evaluate(
  pageId,
  '(() => { const input = Array.from(document.querySelectorAll("input")).find((element) => ' + pattern + '.test([element.name, element.id, element.placeholder, element.getAttribute("aria-label")].filter(Boolean).join(" ")));'
    + 'if (!input) throw new Error("找不到登录输入框"); input.focus(); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; setter.call(input, ' + JSON.stringify(value) + '); input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); return true; })()'
);

const browser = await browserManager.browsers.create({
  name: 'CodeFlying 测试 ' + browserManager.context.iteration,
  startUrl: 'https://codeflying.cgref.cn/s/qyk4vg3k87'
});
await browserManager.browsers.launch(browser.id);
const page = await browserManager.pages.open(browser.id, 'https://codeflying.cgref.cn/s/qyk4vg3k87');
const sms = await browserManager.sms.acquire();
try {
  await clickAny(page.id, ['登录', '登录腾讯文档']);
  await fillByHint(page.id, sms.phone, '/手机|phone/i');
  await clickAny(page.id, ['获取验证码', '发送验证码', '验证码']);
  const verification = await browserManager.sms.waitForCode(sms.phone, { timeoutMs: 120000 });
  await fillByHint(page.id, verification.code, '/验证码|code/i');
  await clickAny(page.id, ['登录', '立即登录']);
  await browserManager.pages.delay(page.id, 3000);

  await browserManager.pages.goto(page.id, 'https://codeflying.cgref.cn/s/qyk4vg3k87');
  try { await clickByText(page.id, '创建应用'); } catch (_) {}
  await browserManager.pages.delay(page.id, 1000);
  const idea = ideas[(browserManager.context.iteration - 1) % ideas.length];
  await browserManager.pages.type(page.id, '[placeholder*="输入您想生成的应用"]', idea, true);
  await clickAny(page.id, ['立即开发', '发送']);
  await browserManager.pages.delay(page.id, 20000);
  await clickByText(page.id, '我的应用');
  await browserManager.pages.delay(page.id, 1500);
  const screenshot = await browserManager.pages.screenshot(page.id, true);
  await clickByText(page.id, '设置');
  await browserManager.pages.delay(page.id, 1000);
  const nickname = await browserManager.pages.evaluate(page.id, '(() => { const input = Array.from(document.querySelectorAll("input")).find((element) => /昵称|nick(name)?/i.test([element.name, element.id, element.placeholder, element.getAttribute("aria-label")].filter(Boolean).join(" "))); if (input && input.value) return input.value.trim(); const label = Array.from(document.querySelectorAll("label,span,div")).find((element) => (element.textContent || "").trim() === "昵称"); const value = label && label.parentElement && label.parentElement.querySelector("input"); if (value && value.value) return value.value.trim(); throw new Error("未找到昵称，请按登录后页面结构调整选择器。"); })()');
  const result = await browserManager.records.append({ phone: sms.phone, screenshot: screenshot.path, nickname });
  await browserManager.log('第 ' + browserManager.context.iteration + ' 轮完成，Excel：' + result.resultsPath);
} finally {
  await browserManager.sms.release(sms.phone).catch((error) => browserManager.log('号码释放失败：' + error.message));
}
`;

const refs = {
  storageSummary: document.getElementById('storageSummary'),
  openSettings: document.getElementById('openSettings'),
  settingsOverlay: document.getElementById('settingsOverlay'),
  closeSettings: document.getElementById('closeSettings'),
  saveSettings: document.getElementById('saveSettings'),
  settingsDataRootPath: document.getElementById('settingsDataRootPath'),
  settingsPickDataRootPath: document.getElementById('settingsPickDataRootPath'),
  settingsProxyApiUrl: document.getElementById('settingsProxyApiUrl'),
  settingsUpdateManifestUrl: document.getElementById('settingsUpdateManifestUrl'),
  settingsSmsToken: document.getElementById('settingsSmsToken'),
  settingsSmsKeyword: document.getElementById('settingsSmsKeyword'),
  settingsSmsPollSeconds: document.getElementById('settingsSmsPollSeconds'),
  smsTestingStatus: document.getElementById('smsTestingStatus'),
  checkUpdate: document.getElementById('checkUpdate'),
  openDownloadPage: document.getElementById('openDownloadPage'),
  updateStatus: document.getElementById('updateStatus'),
  currentVersionText: document.getElementById('currentVersionText'),
  latestVersionText: document.getElementById('latestVersionText'),
  appVersion: document.getElementById('appVersion'),
  browserName: document.getElementById('browserName'),
  enableProxy: document.getElementById('enableProxy'),
  executablePath: document.getElementById('executablePath'),
  detectKernel: document.getElementById('detectKernel'),
  pickExecutablePath: document.getElementById('pickExecutablePath'),
  installKernel: document.getElementById('installKernel'),
  installProgress: document.getElementById('installProgress'),
  installProgressFill: document.getElementById('installProgressFill'),
  installProgressText: document.getElementById('installProgressText'),
  startUrls: document.getElementById('startUrls'),
  saveBrowser: document.getElementById('saveBrowser'),
  resetForm: document.getElementById('resetForm'),
  statusMessage: document.getElementById('statusMessage'),
  browserList: document.getElementById('browserList'),
  browserCount: document.getElementById('browserCount'),
  importScriptFile: document.getElementById('importScriptFile'),
  scriptFileInput: document.getElementById('scriptFileInput'),
  newScript: document.getElementById('newScript'),
  scriptList: document.getElementById('scriptList'),
  scriptName: document.getElementById('scriptName'),
  scriptCode: document.getElementById('scriptCode'),
  scriptRunCount: document.getElementById('scriptRunCount'),
  saveScript: document.getElementById('saveScript'),
  runScript: document.getElementById('runScript'),
  stopScript: document.getElementById('stopScript'),
  deleteScript: document.getElementById('deleteScript'),
  scriptLog: document.getElementById('scriptLog'),
  uploadPlugin: document.getElementById('uploadPlugin'),
  pluginList: document.getElementById('pluginList'),
  pluginApplyHint: document.getElementById('pluginApplyHint')
};

const setStatus = (message, type = '') => {
  refs.statusMessage.textContent = message;
  refs.statusMessage.className = `status ${type}`.trim();
};

const toDisplayPath = (value) => {
  if (!value) {
    return '未设置存储目录';
  }
  return value.length > 44 ? `${value.slice(0, 22)}...${value.slice(-18)}` : value;
};

const renderStorageSummary = () => {
  refs.storageSummary.textContent = `数据目录：${toDisplayPath(state.config.dataRootPath)}`;
};

const openSettings = () => {
  refs.settingsOverlay.classList.remove('hidden');
  refs.settingsOverlay.setAttribute('aria-hidden', 'false');
  refs.settingsDataRootPath.value = state.config.dataRootPath || '';
  refs.settingsProxyApiUrl.value = state.config.proxyApiUrl || '';
  refs.settingsUpdateManifestUrl.value = state.config.updateManifestUrl || '';
  refs.settingsSmsToken.value = '';
  window.browserManagerApi.getSmsTestingSettings().then((settings) => {
    refs.settingsSmsKeyword.value = settings.keyword || '';
    refs.settingsSmsPollSeconds.value = String(Math.round((Number(settings.pollIntervalMs) || 10000) / 1000));
    refs.smsTestingStatus.textContent = settings.configured ? 'Token 已加密保存。' : '尚未配置 Token。';
  }).catch((error) => {
    refs.smsTestingStatus.textContent = error.message || '短信测试设置读取失败。';
  });
};

const closeSettings = () => {
  refs.settingsOverlay.classList.add('hidden');
  refs.settingsOverlay.setAttribute('aria-hidden', 'true');
};

const setUpdateStatus = (text) => {
  if (refs.updateStatus) {
    refs.updateStatus.textContent = String(text || '');
  }
};

const renderUpdateInfo = (info) => {
  if (!info) {
    refs.latestVersionText.textContent = '-';
    refs.openDownloadPage.classList.add('hidden');
    return;
  }

  refs.latestVersionText.textContent = info.latestVersion ? `v${info.latestVersion}` : '-';
  const showDownload = Boolean(info.downloadPageUrl);
  refs.openDownloadPage.classList.toggle('hidden', !showDownload);
  refs.openDownloadPage.dataset.url = info.downloadPageUrl || '';
};

const setActiveSettingsTab = (tab) => {
  const items = Array.from(refs.settingsOverlay.querySelectorAll('.nav-item'));
  const tabs = Array.from(refs.settingsOverlay.querySelectorAll('.tab'));
  for (const item of items) {
    item.classList.toggle('active', item.dataset.tab === tab);
  }
  for (const panel of tabs) {
    panel.classList.toggle('active', panel.id === `tab-${tab}`);
  }
};

const renderKernelLookupState = () => {
  if (state.kernelLookup.installing) {
    refs.installProgress.classList.remove('hidden');
    refs.installProgressFill.style.width = `${state.kernelLookup.installProgress}%`;
    refs.installProgressText.textContent = `${state.kernelLookup.installMessage || '正在安装内核...'} ${state.kernelLookup.installProgress}%`;
    refs.installKernel.classList.remove('hidden');
    refs.installKernel.disabled = true;
    refs.detectKernel.disabled = true;
    return;
  }

  refs.installProgress.classList.add('hidden');
  refs.installProgressFill.style.width = '0%';
  refs.installProgressText.textContent = '';
  refs.detectKernel.disabled = false;
  refs.installKernel.disabled = false;

  if (state.kernelLookup.found) {
    refs.installKernel.classList.add('hidden');
  } else {
    refs.installKernel.classList.remove('hidden');
  }
};

const syncRunningStatus = async () => {
  const runningIds = await window.browserManagerApi.getRunningBrowserIds();
  state.runningBrowserIds = new Set(runningIds);
  renderList();
};

const startRunningStatusWatcher = () => {
  if (state.runningStatusTimer) {
    return;
  }
  state.runningStatusTimer = setInterval(async () => {
    try {
      await syncRunningStatus();
    } catch (_) { }
  }, 2200);
};

const stopRunningStatusWatcher = () => {
  if (!state.runningStatusTimer) {
    return;
  }
  clearInterval(state.runningStatusTimer);
  state.runningStatusTimer = null;
};

const syncRunningStatusWatcherWithVisibility = () => {
  if (document.hidden) {
    stopRunningStatusWatcher();
    return;
  }
  startRunningStatusWatcher();
};

const pollInstallProgress = async () => {
  const progress = await window.browserManagerApi.getKernelInstallProgress();
  state.kernelLookup.installing = progress.installing;
  state.kernelLookup.installProgress = Number(progress.progress || 0);
  state.kernelLookup.installMessage = String(progress.message || '');
  renderKernelLookupState();
};

const startInstallProgressPolling = () => {
  if (state.kernelLookup.pollingTimer) {
    clearInterval(state.kernelLookup.pollingTimer);
  }
  state.kernelLookup.pollingTimer = setInterval(async () => {
    try {
      await pollInstallProgress();
    } catch (_) { }
  }, 260);
};

const stopInstallProgressPolling = () => {
  if (state.kernelLookup.pollingTimer) {
    clearInterval(state.kernelLookup.pollingTimer);
    state.kernelLookup.pollingTimer = null;
  }
};

const detectLocalKernel = async (showStatus = true) => {
  const result = await window.browserManagerApi.detectLocalKernel();
  state.kernelLookup.found = result.found;
  state.kernelLookup.candidates = result.candidates || [];
  renderKernelLookupState();

  if (result.preferredPath) {
    refs.executablePath.value = result.preferredPath;
    state.config.defaultExecutablePath = result.preferredPath;
    await persistConfig();
  }

  if (showStatus) {
    if (result.found) {
      setStatus(`已检测到 ${result.candidates.length} 个可用内核，已自动填充路径。`, 'success');
    } else {
      setStatus('未检测到本机可用内核，可点击安装内置 Chromium。', 'error');
    }
  }
};

const resetForm = () => {
  state.editingBrowserId = '';
  refs.browserName.value = '';
  refs.executablePath.value = state.config.defaultExecutablePath || '';
  refs.startUrls.value = '';
  refs.enableProxy.checked = false;
  refs.saveBrowser.textContent = '保存配置';
};

const fillForm = (browser) => {
  state.editingBrowserId = browser.id;
  refs.browserName.value = browser.name;
  refs.executablePath.value = browser.executablePath;
  refs.startUrls.value = browser.startUrlsText || browser.startUrl || '';
  refs.enableProxy.checked = Boolean(browser.enableProxy);
  refs.saveBrowser.textContent = '更新配置';
};

const renderList = () => {
  const browsers = state.config.browsers;
  refs.browserCount.textContent = `${browsers.length} 个配置`;

  if (browsers.length === 0) {
    refs.browserList.innerHTML = '<div class="empty">暂无浏览器配置，先在左侧添加一个吧。</div>';
    return;
  }

  refs.browserList.innerHTML = browsers
    .map(
      (browser) => `
      <article class="browser-item" data-id="${browser.id}">
        <div class="browser-head">
          <div class="browser-name">${browser.name}</div>
          <div class="chip ${state.runningBrowserIds.has(browser.id) ? 'chip-running' : ''}">
            ${state.runningBrowserIds.has(browser.id) ? '运行中' : '已停止'}
          </div>
        </div>
        <div class="browser-meta">
          <div>启动页面：${(() => {
          const urls = String(browser.startUrlsText || browser.startUrl || '')
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean);
          if (urls.length === 0) return '未设置';
          return urls.length === 1 ? urls[0] : `${urls[0]}（共 ${urls.length} 个标签页）`;
        })()}</div>
        </div>
        <div class="browser-actions">
          <button class="btn launch ${state.runningBrowserIds.has(browser.id) ? 'stop' : ''}" data-action="${state.runningBrowserIds.has(browser.id) ? 'stop' : 'launch'
        }">
            ${state.runningBrowserIds.has(browser.id) ? '停止' : '启动'}
          </button>
          ${browser.enableProxy
          ? `<button class="btn rotate" data-action="rotate-proxy">换代理</button>`
          : ''
        }
          <button class="btn edit" data-action="edit">编辑</button>
          <button class="btn delete" data-action="delete">删除</button>
        </div>
      </article>
    `
    )
    .join('');
};

const appendScriptLog = (message) => {
  const stamp = new Date().toLocaleTimeString();
  refs.scriptLog.textContent = `${refs.scriptLog.textContent}\n[${stamp}] ${message}`.trim();
  refs.scriptLog.scrollTop = refs.scriptLog.scrollHeight;
};

const resetScriptEditor = () => {
  state.editingScriptId = '';
  refs.scriptName.value = '';
  refs.scriptCode.value = '';
  refs.scriptLog.textContent = '选择或新建一个脚本后运行，执行日志会显示在这里。';
  renderScriptList();
};

const renderScriptList = () => {
  refs.scriptList.replaceChildren();
  const scripts = Array.isArray(state.config.scripts) ? state.config.scripts : [];
  if (scripts.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '暂无脚本';
    refs.scriptList.append(empty);
    return;
  }
  for (const script of scripts) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `script-item ${script.id === state.editingScriptId ? 'active' : ''}`;
    item.dataset.scriptId = script.id;
    const name = document.createElement('div');
    name.className = 'script-item-name';
    name.textContent = script.name;
    const updated = document.createElement('div');
    updated.className = 'script-item-time';
    updated.textContent = script.updatedAt ? new Date(script.updatedAt).toLocaleString() : '未保存';
    item.append(name, updated);
    refs.scriptList.append(item);
  }
};

const fillScriptEditor = (script) => {
  state.editingScriptId = script.id;
  refs.scriptName.value = script.name || '';
  refs.scriptCode.value = script.code || '';
  refs.scriptLog.textContent = '脚本已载入。';
  renderScriptList();
};

const saveCurrentScript = async () => {
  const saved = await window.browserManagerApi.saveScript({
    id: state.editingScriptId,
    name: refs.scriptName.value.trim(),
    code: refs.scriptCode.value
  });
  const scripts = Array.isArray(state.config.scripts) ? state.config.scripts : [];
  const index = scripts.findIndex((item) => item.id === saved.id);
  if (index === -1) scripts.unshift(saved);
  else scripts.splice(index, 1, saved);
  state.config.scripts = scripts;
  state.editingScriptId = saved.id;
  renderScriptList();
  return saved;
};

const workerSource = `
  let pending = new Map();
  let requestId = 0;
  self.fetch = undefined;
  self.XMLHttpRequest = undefined;
  self.WebSocket = undefined;
  self.importScripts = undefined;
  const call = (method, payload) => new Promise((resolve, reject) => {
    const id = String(++requestId);
    pending.set(id, { resolve, reject });
    self.postMessage({ type: 'request', id, method, payload });
  });
  const browserManager = Object.freeze({
    browsers: Object.freeze({
      list: () => call('browsers.list', {}),
      create: (config) => call('browsers.create', config || {}),
      launch: (browserId) => call('browsers.launch', { browserId }),
      stop: (browserId) => call('browsers.stop', { browserId })
    }),
    sms: Object.freeze({
      acquire: (options) => call('sms.acquire', options || {}),
      waitForCode: (phone, options) => call('sms.waitForCode', { phone, ...(options || {}) }),
      release: (phone) => call('sms.release', { phone })
    }),
    pages: Object.freeze({
      open: (browserId, url, timeoutMs) => call('pages.open', { browserId, url, timeoutMs }),
      goto: (pageId, url, timeoutMs) => call('pages.goto', { pageId, url, timeoutMs }),
      click: (pageId, selector, timeoutMs) => call('pages.click', { pageId, selector, timeoutMs }),
      type: (pageId, selector, text, clear, timeoutMs) => call('pages.type', { pageId, selector, text, clear, timeoutMs }),
      select: (pageId, selector, values, timeoutMs) => call('pages.select', { pageId, selector, values, timeoutMs }),
      waitFor: (pageId, selector, visible, timeoutMs) => call('pages.waitFor', { pageId, selector, visible, timeoutMs }),
      delay: (pageId, delayMs) => call('pages.delay', { pageId, delayMs }),
      text: (pageId, selector, timeoutMs) => call('pages.text', { pageId, selector, timeoutMs }),
      evaluate: (pageId, expression) => call('pages.evaluate', { pageId, expression }),
      screenshot: (pageId, fullPage) => call('pages.screenshot', { pageId, fullPage })
    }),
    records: Object.freeze({
      append: (record) => call('records.append', record || {}),
      path: () => call('records.path', {})
    }),
    log: (...values) => call('log', { level: 'info', message: values.map((item) => typeof item === 'string' ? item : JSON.stringify(item)).join(' ') })
  });
  self.onmessage = async (event) => {
    const data = event.data || {};
    if (data.type === 'response') {
      const item = pending.get(data.id);
      if (!item) return;
      pending.delete(data.id);
      data.ok ? item.resolve(data.result) : item.reject(new Error(data.error || '脚本操作失败'));
      return;
    }
    if (data.type === 'run') {
      try {
        const count = Math.min(Math.max(Number(data.runCount) || 1, 1), 5);
        for (let index = 1; index <= count; index += 1) {
          const scopedManager = Object.freeze({ ...browserManager, context: Object.freeze({ iteration: index, count }) });
          const execute = new Function('browserManager', '"use strict"; return (async () => {\\n' + data.code + '\\n})();');
          await execute(scopedManager);
        }
        self.postMessage({ type: 'finished', status: 'completed' });
      } catch (error) {
        self.postMessage({ type: 'finished', status: 'failed', error: error && error.message ? error.message : String(error) });
      }
    }
  };
`;

const runCurrentScript = async () => {
  if (state.activeScriptRunId) return;
  const script = await saveCurrentScript();
  const runCount = Math.min(Math.max(Number(refs.scriptRunCount.value) || 1, 1), 5);
  refs.scriptRunCount.value = String(runCount);
  const run = await window.browserManagerApi.startScriptRun(script.id);
  state.activeScriptRunId = run.runId;
  refs.scriptLog.textContent = `运行 ${script.name}...`;
  refs.runScript.disabled = true;
  refs.stopScript.classList.remove('hidden');
  const worker = new Worker(URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' })));
  state.scriptWorker = worker;
  const timeout = setTimeout(() => {
    finish('failed', '脚本总执行时间超过 5 分钟。');
  }, SCRIPT_TOTAL_TIMEOUT_MS * runCount);
  const finish = async (status, detail = '') => {
    if (!state.activeScriptRunId) return;
    const runId = state.activeScriptRunId;
    state.activeScriptRunId = '';
    clearTimeout(timeout);
    worker.terminate();
    state.scriptWorker = null;
    refs.runScript.disabled = false;
    refs.stopScript.classList.add('hidden');
    await window.browserManagerApi.finishScriptRun(runId, status, detail);
    appendScriptLog(status === 'completed' ? '脚本执行完成。' : `脚本已结束：${detail || status}`);
  };
  worker.onmessage = async (event) => {
    const data = event.data || {};
    if (data.type === 'request') {
      try {
        const result = await window.browserManagerApi.runScriptOperation(run.runId, data.method, data.payload || {});
        worker.postMessage({ type: 'response', id: data.id, ok: true, result });
        if (data.method === 'log') appendScriptLog(String(data.payload && data.payload.message || ''));
        else appendScriptLog(`${data.method} 完成`);
      } catch (error) {
        worker.postMessage({ type: 'response', id: data.id, ok: false, error: error.message || '操作失败' });
        appendScriptLog(`${data.method} 失败：${error.message || '操作失败'}`);
      }
      return;
    }
    if (data.type === 'finished') await finish(data.status, data.error || '');
  };
  worker.onerror = async (event) => finish('failed', event.message || '脚本 Worker 异常');
  worker.postMessage({ type: 'run', code: script.code, runCount });
};

const stopCurrentScript = async () => {
  if (!state.activeScriptRunId) return;
  const runId = state.activeScriptRunId;
  if (state.scriptWorker) state.scriptWorker.terminate();
  state.scriptWorker = null;
  state.activeScriptRunId = '';
  refs.runScript.disabled = false;
  refs.stopScript.classList.add('hidden');
  await window.browserManagerApi.cancelScriptRun(runId);
  await window.browserManagerApi.finishScriptRun(runId, 'cancelled', '用户停止脚本。');
  appendScriptLog('脚本已停止。');
};

const renderPluginList = () => {
  refs.pluginList.replaceChildren();
  const plugins = Array.isArray(state.config.plugins) ? state.config.plugins : [];
  if (plugins.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '暂无插件，上传 Manifest V3 ZIP 后会全局加载。';
    refs.pluginList.append(empty);
    return;
  }
  for (const plugin of plugins) {
    const item = document.createElement('article');
    item.className = 'plugin-item';
    const head = document.createElement('div');
    head.className = 'plugin-item-head';
    const name = document.createElement('div');
    name.className = 'plugin-name';
    if (plugin.iconPath) {
      const icon = document.createElement('img');
      icon.className = 'plugin-icon';
      icon.alt = '';
      icon.src = `file:///${String(plugin.iconPath).replace(/\\/g, '/')}`;
      name.append(icon);
    }
    name.append(document.createTextNode(`${plugin.name} v${plugin.version}`));
    const status = document.createElement('span');
    status.className = `chip ${plugin.enabled ? 'chip-running' : ''}`;
    status.textContent = plugin.enabled ? '已启用' : '已停用';
    head.append(name, status);
    const description = document.createElement('div');
    description.className = 'plugin-description';
    description.textContent = plugin.description || '无描述';
    const meta = document.createElement('div');
    meta.className = 'plugin-meta';
    meta.textContent = `上传于 ${plugin.uploadedAt ? new Date(plugin.uploadedAt).toLocaleString() : '-'}`;
    const actions = document.createElement('div');
    actions.className = 'plugin-item-actions';
    const toggle = document.createElement('button');
    toggle.className = 'btn secondary';
    toggle.dataset.pluginAction = 'toggle';
    toggle.dataset.pluginId = plugin.id;
    toggle.dataset.enabled = String(!plugin.enabled);
    toggle.textContent = plugin.enabled ? '停用' : '启用';
    const remove = document.createElement('button');
    remove.className = 'btn delete';
    remove.dataset.pluginAction = 'remove';
    remove.dataset.pluginId = plugin.id;
    remove.textContent = '删除';
    actions.append(toggle, remove);
    item.append(head, description, meta, actions);
    refs.pluginList.append(item);
  }
};

const refreshPlugins = async () => {
  state.config.plugins = await window.browserManagerApi.listPlugins();
  renderPluginList();
};

const applyPluginChange = async (result) => {
  await refreshPlugins();
  if (!result || !result.requiresRestart) {
    setStatus('插件已保存，新启动的浏览器将自动加载。', 'success');
    return;
  }
  if (!window.confirm('插件变更需要重启全部正在运行的受管浏览器。是否立即重启并全局应用？')) {
    setStatus('插件已保存；运行中的浏览器将在下次启动时加载。', 'success');
    return;
  }
  const applied = await window.browserManagerApi.applyPluginsGlobally();
  await syncRunningStatus();
  if (applied.failures && applied.failures.length) {
    setStatus(`插件已应用，但 ${applied.failures.length} 个浏览器重启失败。`, 'error');
  } else {
    setStatus(`插件已全局应用并重启 ${applied.restarted.length} 个浏览器。`, 'success');
  }
};

const persistConfig = async () => {
  const saved = await window.browserManagerApi.saveConfig(state.config);
  state.config = saved;
  renderStorageSummary();
  renderList();
};

const upsertBrowser = () => {
  const name = refs.browserName.value.trim();
  const executablePath = refs.executablePath.value.trim();
  const startUrlsText = refs.startUrls.value;
  const enableProxy = Boolean(refs.enableProxy.checked);

  if (!name || !executablePath) {
    throw new Error('请填写名称和可执行文件路径。');
  }

  const urls = String(startUrlsText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const url of urls) {
    if (!/^https?:\/\//i.test(url)) {
      throw new Error('启动页面 URL 需以 http:// 或 https:// 开头（每行一个）。');
    }
  }

  const id = state.editingBrowserId || crypto.randomUUID();
  const existingIndex = state.config.browsers.findIndex((item) => item.id === id);
  const existing = existingIndex === -1 ? null : state.config.browsers[existingIndex];
  const payload = {
    ...(existing || {}),
    id,
    name,
    executablePath,
    startUrlsText,
    enableProxy,
    profileDirName: existing ? existing.profileDirName : ''
  };

  if (existingIndex === -1) {
    state.config.browsers.unshift(payload);
  } else {
    state.config.browsers.splice(existingIndex, 1, payload);
  }
};

const handleActionClick = async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const action = target.dataset.action;
  if (!action) {
    return;
  }

  const article = target.closest('.browser-item');
  if (!article) {
    return;
  }

  const browserId = article.getAttribute('data-id');
  const browser = state.config.browsers.find((item) => item.id === browserId);
  if (!browser) {
    setStatus('未找到配置项。', 'error');
    return;
  }

  try {
    if (action === 'edit') {
      fillForm(browser);
      setStatus(`正在编辑：${browser.name}`, 'success');
      return;
    }

    if (action === 'delete') {
      state.config.browsers = state.config.browsers.filter((item) => item.id !== browser.id);
      state.runningBrowserIds.delete(browser.id);
      await persistConfig();
      if (state.editingBrowserId === browser.id) {
        resetForm();
      }
      setStatus(`已删除：${browser.name}`, 'success');
      return;
    }

    if (action === 'launch') {
      const result = await window.browserManagerApi.launchBrowser(browser.id);
      state.runningBrowserIds.add(browser.id);
      renderList();
      const proxyText = result.proxy ? `，代理：${result.proxy}` : '';
      const pluginText = result.extensionLoadNote ? ` ${result.extensionLoadNote}` : '';
      setStatus(`已启动：${browser.name}（目录：${result.profilePath}${proxyText}）${pluginText}`, result.extensionLoadNote ? 'error' : 'success');
      return;
    }

    if (action === 'rotate-proxy') {
      if (!browser.enableProxy) {
        throw new Error('该配置未启用代理。');
      }
      setStatus(`正在更换代理：${browser.name}...`);
      const result = await window.browserManagerApi.rotateProxy(browser.id);
      if (result && result.browser) {
        const idx = state.config.browsers.findIndex((item) => item.id === result.browser.id);
        if (idx !== -1) {
          state.config.browsers.splice(idx, 1, result.browser);
        }
      }
      renderList();
      const hint = state.runningBrowserIds.has(browser.id) ? '（重启后生效）' : '（下次启动生效）';
      setStatus(`已更换代理：${browser.name}，当前：${result.proxy}${hint}`, 'success');
      return;
    }

    if (action === 'stop') {
      await window.browserManagerApi.stopBrowser(browser.id);
      state.runningBrowserIds.delete(browser.id);
      renderList();
      setStatus(`已停止：${browser.name}`, 'success');
    }
  } catch (error) {
    setStatus(error.message || '操作失败，请检查配置。', 'error');
  }
};

const bindEvents = () => {
  refs.openSettings.addEventListener('click', () => {
    openSettings();
    setActiveSettingsTab('storage');
  });

  refs.storageSummary.addEventListener('click', () => {
    openSettings();
    setActiveSettingsTab('storage');
  });

  refs.closeSettings.addEventListener('click', () => {
    closeSettings();
  });

  refs.settingsOverlay.addEventListener('click', (event) => {
    if (event.target === refs.settingsOverlay) {
      closeSettings();
    }
  });

  refs.settingsOverlay.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    if (target.classList.contains('nav-item')) {
      const tab = target.dataset.tab;
      if (tab) {
        setActiveSettingsTab(tab);
      }
    }
  });

  const linkPurchaseProxy = document.getElementById('linkPurchaseProxy');
  if (linkPurchaseProxy) {
    linkPurchaseProxy.addEventListener('click', (e) => {
      e.preventDefault();
      window.browserManagerApi.openExternal('http://www.91http.com/user/reg?ref=invite&invite_id=116904');
    });
  }

  refs.settingsPickDataRootPath.addEventListener('click', async () => {
    const selected = await window.browserManagerApi.pickDirectory();
    if (!selected) {
      return;
    }
    refs.settingsDataRootPath.value = selected;
  });

  refs.saveSettings.addEventListener('click', async () => {
    state.config.dataRootPath = refs.settingsDataRootPath.value.trim();
    state.config.proxyApiUrl = refs.settingsProxyApiUrl.value.trim();
    state.config.updateManifestUrl = refs.settingsUpdateManifestUrl.value.trim();
    try {
      await persistConfig();
      const smsSettings = await window.browserManagerApi.saveSmsTestingSettings({
        token: refs.settingsSmsToken.value,
        keyword: refs.settingsSmsKeyword.value,
        pollIntervalMs: Math.min(Math.max(Number(refs.settingsSmsPollSeconds.value) || 10, 5), 30) * 1000
      });
      refs.smsTestingStatus.textContent = smsSettings.configured ? 'Token 已加密保存。' : '尚未配置 Token。';
      closeSettings();
      setStatus('设置已保存。', 'success');
    } catch (error) {
      setStatus(error.message || '保存设置失败。', 'error');
    }
  });

  refs.checkUpdate.addEventListener('click', async () => {
    refs.checkUpdate.disabled = true;
    setUpdateStatus('正在检查更新...');
    try {
      const info = await window.browserManagerApi.checkUpdate(refs.settingsUpdateManifestUrl.value.trim());
      refs.currentVersionText.textContent = info.currentVersion ? `v${info.currentVersion}` : '-';
      renderUpdateInfo(info);
      if (info.hasUpdate) {
        setUpdateStatus(`发现新版本 v${info.latestVersion}${info.notes ? `：${info.notes}` : ''}`);
      } else {
        setUpdateStatus('当前已是最新版本。');
      }
    } catch (error) {
      renderUpdateInfo(null);
      setUpdateStatus(error.message || '检查更新失败。');
    } finally {
      refs.checkUpdate.disabled = false;
    }
  });

  refs.openDownloadPage.addEventListener('click', async () => {
    const url = refs.openDownloadPage.dataset.url;
    if (!url) {
      return;
    }
    try {
      await window.browserManagerApi.openExternal(url);
    } catch (error) {
      setUpdateStatus(error.message || '打开下载页面失败。');
    }
  });

  refs.pickExecutablePath.addEventListener('click', async () => {
    const selected = await window.browserManagerApi.pickExecutable();
    if (!selected) {
      return;
    }
    refs.executablePath.value = selected;
    state.config.defaultExecutablePath = selected;
  });

  refs.detectKernel.addEventListener('click', async () => {
    try {
      await detectLocalKernel(true);
    } catch (error) {
      setStatus(error.message || '内核查询失败。', 'error');
    }
  });

  refs.installKernel.addEventListener('click', async () => {
    state.kernelLookup.installing = true;
    state.kernelLookup.installProgress = 1;
    state.kernelLookup.installMessage = '准备安装环境...';
    renderKernelLookupState();
    startInstallProgressPolling();
    try {
      const result = await window.browserManagerApi.installChromiumKernel();
      refs.executablePath.value = result.executablePath;
      state.config.defaultExecutablePath = result.executablePath;
      await persistConfig();
      await pollInstallProgress();
      await detectLocalKernel(false);
      setStatus('Chromium 内核安装成功，已自动填入可执行路径。', 'success');
    } catch (error) {
      setStatus(error.message || 'Chromium 内核安装失败。', 'error');
    } finally {
      stopInstallProgressPolling();
      state.kernelLookup.installing = false;
      renderKernelLookupState();
    }
  });

  refs.saveBrowser.addEventListener('click', async () => {
    try {
      upsertBrowser();
      state.config.defaultExecutablePath = refs.executablePath.value.trim() || state.config.defaultExecutablePath;
      await persistConfig();
      const actionText = state.editingBrowserId ? '更新' : '新增';
      resetForm();
      setStatus(`${actionText}配置成功。`, 'success');
    } catch (error) {
      setStatus(error.message || '保存失败。', 'error');
    }
  });

  refs.resetForm.addEventListener('click', () => {
    resetForm();
    setStatus('已清空表单。');
  });

  refs.browserList.addEventListener('click', handleActionClick);

  if (false) refs.importScriptFile.addEventListener('click', () => {
    state.editingScriptId = '';
    refs.scriptName.value = 'CodeFlying 易接码自动化测试';
    refs.scriptCode.value = CODEFLYING_SMS_TEMPLATE;
    refs.scriptRunCount.value = '1';
    refs.scriptLog.textContent = '已载入示例。请先填写已授权手机号；登录步骤需要在浏览器窗口中由你自行完成。';
    renderScriptList();
  });

  const importScriptFile = async (file) => {
    if (!file) return;
    const fileName = String(file.name || '');
    if (!/\.(js|mjs)$/i.test(fileName)) throw new Error('只支持 .js 或 .mjs 脚本文件。');
    if (file.size > 200 * 1024) throw new Error('脚本文件不能超过 200KB。');
    const code = await file.text();
    if (!code.trim()) throw new Error('脚本文件为空。');
    const saved = await window.browserManagerApi.saveScript({
      name: fileName.replace(/\.(js|mjs)$/i, '') || '导入脚本',
      code
    });
    state.config.scripts = [saved, ...(state.config.scripts || []).filter((item) => item.id !== saved.id)];
    fillScriptEditor(saved);
    appendScriptLog(`已导入并保存：${fileName}`);
    setStatus(`脚本已导入：${saved.name}`, 'success');
  };
  refs.importScriptFile.addEventListener('click', () => refs.scriptFileInput.click());
  refs.scriptFileInput.addEventListener('change', async () => {
    try {
      await importScriptFile(refs.scriptFileInput.files && refs.scriptFileInput.files[0]);
    } catch (error) {
      setStatus(error.message || '脚本导入失败。', 'error');
    } finally {
      refs.scriptFileInput.value = '';
    }
  });
  refs.scriptCode.addEventListener('dragover', (event) => {
    event.preventDefault();
    refs.scriptCode.classList.add('drop-target');
  });
  refs.scriptCode.addEventListener('dragleave', () => refs.scriptCode.classList.remove('drop-target'));
  refs.scriptCode.addEventListener('drop', async (event) => {
    event.preventDefault();
    refs.scriptCode.classList.remove('drop-target');
    try {
      await importScriptFile(event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0]);
    } catch (error) {
      setStatus(error.message || '脚本导入失败。', 'error');
    }
  });

  refs.newScript.addEventListener('click', () => {
    resetScriptEditor();
    refs.scriptName.focus();
  });

  refs.scriptList.addEventListener('click', (event) => {
    const target = event.target.closest('[data-script-id]');
    if (!target) return;
    const script = (state.config.scripts || []).find((item) => item.id === target.dataset.scriptId);
    if (script) fillScriptEditor(script);
  });

  refs.saveScript.addEventListener('click', async () => {
    try {
      const script = await saveCurrentScript();
      setStatus(`脚本已保存：${script.name}`, 'success');
    } catch (error) {
      setStatus(error.message || '脚本保存失败。', 'error');
    }
  });

  refs.runScript.addEventListener('click', async () => {
    try {
      await runCurrentScript();
    } catch (error) {
      setStatus(error.message || '脚本运行失败。', 'error');
      refs.runScript.disabled = false;
      refs.stopScript.classList.add('hidden');
    }
  });

  refs.stopScript.addEventListener('click', async () => {
    try {
      await stopCurrentScript();
    } catch (error) {
      setStatus(error.message || '停止脚本失败。', 'error');
    }
  });

  refs.deleteScript.addEventListener('click', async () => {
    if (!state.editingScriptId) return;
    if (!window.confirm('确定删除当前脚本吗？')) return;
    try {
      await window.browserManagerApi.removeScript(state.editingScriptId);
      state.config.scripts = (state.config.scripts || []).filter((item) => item.id !== state.editingScriptId);
      resetScriptEditor();
      setStatus('脚本已删除。', 'success');
    } catch (error) {
      setStatus(error.message || '删除脚本失败。', 'error');
    }
  });

  refs.uploadPlugin.addEventListener('click', async () => {
    refs.uploadPlugin.disabled = true;
    try {
      const result = await window.browserManagerApi.uploadPlugin();
      if (!result || result.cancelled) return;
      await applyPluginChange(result);
    } catch (error) {
      setStatus(error.message || '插件上传失败。', 'error');
    } finally {
      refs.uploadPlugin.disabled = false;
    }
  });

  refs.pluginList.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-plugin-action]');
    if (!target) return;
    try {
      if (target.dataset.pluginAction === 'toggle') {
        const result = await window.browserManagerApi.setPluginEnabled(target.dataset.pluginId, target.dataset.enabled === 'true');
        await applyPluginChange(result);
      }
      if (target.dataset.pluginAction === 'remove') {
        if (!window.confirm('仅可删除已停用的插件。是否继续？')) return;
        await window.browserManagerApi.removePlugin(target.dataset.pluginId);
        await refreshPlugins();
        setStatus('插件已删除。', 'success');
      }
    } catch (error) {
      setStatus(error.message || '插件操作失败。', 'error');
    }
  });
};

const bootstrap = async () => {
  try {
    const appInfo = await window.browserManagerApi.getAppInfo();
    if (refs.appVersion) {
      refs.appVersion.textContent = appInfo && appInfo.version ? `v${appInfo.version}` : '';
    }
    if (refs.currentVersionText) {
      refs.currentVersionText.textContent = appInfo && appInfo.version ? `v${appInfo.version}` : '-';
    }

    const [config, runningBrowserIds] = await Promise.all([
      window.browserManagerApi.getConfig(),
      window.browserManagerApi.getRunningBrowserIds()
    ]);
    state.config = config;
    state.runningBrowserIds = new Set(runningBrowserIds);
    refs.executablePath.value = config.defaultExecutablePath || '';
    renderStorageSummary();
    renderList();
    renderScriptList();
    renderPluginList();
    resetForm();
    await detectLocalKernel(false);
    renderKernelLookupState();
    syncRunningStatusWatcherWithVisibility();
    document.addEventListener('visibilitychange', syncRunningStatusWatcherWithVisibility);
    window.addEventListener('focus', syncRunningStatusWatcherWithVisibility);
    window.addEventListener('blur', syncRunningStatusWatcherWithVisibility);
    setStatus('已加载配置。', 'success');
  } catch (error) {
    setStatus(error.message || '初始化失败。', 'error');
  }
};

bindEvents();
bootstrap();
