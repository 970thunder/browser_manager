const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('browserManagerApi', {
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  checkUpdate: (manifestUrl) => ipcRenderer.invoke('update:check', manifestUrl),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  rotateProxy: (browserId) => ipcRenderer.invoke('proxy:rotate', browserId),
  pickDirectory: () => ipcRenderer.invoke('dialog:pick-directory'),
  pickExecutable: () => ipcRenderer.invoke('dialog:pick-file'),
  detectLocalKernel: () => ipcRenderer.invoke('kernel:detect-local'),
  getKernelInstallProgress: () => ipcRenderer.invoke('kernel:get-install-progress'),
  launchBrowser: (browserId) => ipcRenderer.invoke('browser:launch', browserId),
  stopBrowser: (browserId) => ipcRenderer.invoke('browser:stop', browserId),
  getRunningBrowserIds: () => ipcRenderer.invoke('browser:list-running-ids'),
  installChromiumKernel: () => ipcRenderer.invoke('kernel:install-chromium')
});
