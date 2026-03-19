const state = {
  config: {
    dataRootPath: '',
    defaultExecutablePath: '',
    proxyApiUrl: '',
    browsers: []
  },
  editingBrowserId: '',
  runningBrowserIds: new Set(),
  kernelLookup: {
    found: false,
    candidates: [],
    installing: false,
    installProgress: 0,
    installMessage: '',
    pollingTimer: null
  }
};

const refs = {
  storageSummary: document.getElementById('storageSummary'),
  openSettings: document.getElementById('openSettings'),
  settingsOverlay: document.getElementById('settingsOverlay'),
  closeSettings: document.getElementById('closeSettings'),
  saveSettings: document.getElementById('saveSettings'),
  settingsDataRootPath: document.getElementById('settingsDataRootPath'),
  settingsPickDataRootPath: document.getElementById('settingsPickDataRootPath'),
  settingsProxyApiUrl: document.getElementById('settingsProxyApiUrl'),
  browserName: document.getElementById('browserName'),
  enableProxy: document.getElementById('enableProxy'),
  executablePath: document.getElementById('executablePath'),
  detectKernel: document.getElementById('detectKernel'),
  pickExecutablePath: document.getElementById('pickExecutablePath'),
  installKernel: document.getElementById('installKernel'),
  installProgress: document.getElementById('installProgress'),
  installProgressFill: document.getElementById('installProgressFill'),
  installProgressText: document.getElementById('installProgressText'),
  startUrl: document.getElementById('startUrl'),
  saveBrowser: document.getElementById('saveBrowser'),
  resetForm: document.getElementById('resetForm'),
  statusMessage: document.getElementById('statusMessage'),
  browserList: document.getElementById('browserList'),
  browserCount: document.getElementById('browserCount')
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
};

const closeSettings = () => {
  refs.settingsOverlay.classList.add('hidden');
  refs.settingsOverlay.setAttribute('aria-hidden', 'true');
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
  setInterval(async () => {
    try {
      await syncRunningStatus();
    } catch (_) {}
  }, 1200);
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
    } catch (_) {}
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
  refs.startUrl.value = '';
  refs.enableProxy.checked = false;
  refs.saveBrowser.textContent = '保存配置';
};

const fillForm = (browser) => {
  state.editingBrowserId = browser.id;
  refs.browserName.value = browser.name;
  refs.executablePath.value = browser.executablePath;
  refs.startUrl.value = browser.startUrl || '';
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
          <div>启动页面：${browser.startUrl || '未设置'}</div>
        </div>
        <div class="browser-actions">
          <button class="btn launch ${state.runningBrowserIds.has(browser.id) ? 'stop' : ''}" data-action="${
            state.runningBrowserIds.has(browser.id) ? 'stop' : 'launch'
          }">
            ${state.runningBrowserIds.has(browser.id) ? '停止' : '启动'}
          </button>
          <button class="btn edit" data-action="edit">编辑</button>
          <button class="btn delete" data-action="delete">删除</button>
        </div>
      </article>
    `
    )
    .join('');
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
  const startUrl = refs.startUrl.value.trim();
  const enableProxy = Boolean(refs.enableProxy.checked);

  if (!name || !executablePath) {
    throw new Error('请填写名称和可执行文件路径。');
  }

  if (startUrl && !/^https?:\/\//i.test(startUrl)) {
    throw new Error('启动页面 URL 需以 http:// 或 https:// 开头。');
  }

  const payload = {
    id: state.editingBrowserId || crypto.randomUUID(),
    name,
    profileDirName: '',
    executablePath,
    startUrl,
    enableProxy
  };

  const existingIndex = state.config.browsers.findIndex((item) => item.id === payload.id);
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
      setStatus(`已启动：${browser.name}（目录：${result.profilePath}${proxyText}）`, 'success');
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
    try {
      await persistConfig();
      closeSettings();
      setStatus('设置已保存。', 'success');
    } catch (error) {
      setStatus(error.message || '保存设置失败。', 'error');
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
};

const bootstrap = async () => {
  try {
    const [config, runningBrowserIds] = await Promise.all([
      window.browserManagerApi.getConfig(),
      window.browserManagerApi.getRunningBrowserIds()
    ]);
    state.config = config;
    state.runningBrowserIds = new Set(runningBrowserIds);
    refs.executablePath.value = config.defaultExecutablePath || '';
    renderStorageSummary();
    renderList();
    resetForm();
    await detectLocalKernel(false);
    renderKernelLookupState();
    startRunningStatusWatcher();
    setStatus('已加载配置。', 'success');
  } catch (error) {
    setStatus(error.message || '初始化失败。', 'error');
  }
};

bindEvents();
bootstrap();
