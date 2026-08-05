const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const puppeteer = require('puppeteer-core');
const ExcelJS = require('exceljs');

const MAX_RUNS = 50;
const MAX_SCRIPT_BYTES = 200 * 1024;

const createAutomationService = ({ runsDir, readConfig, writeConfig, createBrowser, launchBrowser, stopBrowser, getRunningBrowser, smsProvider }) => {
  const runs = new Map();
  const connections = new Map();

  const appendLog = async (run, level, message, data) => {
    const record = { at: new Date().toISOString(), level, message: String(message || ''), data: data ?? null };
    run.logs.push(record);
    if (run.logs.length > 400) run.logs.shift();
    await fs.appendFile(run.logPath, `${JSON.stringify(record)}\n`, 'utf-8');
    return record;
  };

  const writeResultsWorkbook = async (run) => {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'BrowserManager';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('结果');
    sheet.columns = [
      { header: '手机号', key: 'phone', width: 18 },
      { header: '截图', key: 'screenshot', width: 54 },
      { header: '昵称', key: 'nickname', width: 24 }
    ];
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    for (const item of run.records) {
      const row = sheet.addRow({ phone: item.phone, screenshot: item.screenshot, nickname: item.nickname });
      const screenshotCell = row.getCell('screenshot');
      screenshotCell.value = { text: item.screenshot, hyperlink: `file:///${item.screenshot.replace(/\\/g, '/')}` };
      screenshotCell.font = { color: { argb: 'FF0563C1' }, underline: true };
    }
    await workbook.xlsx.writeFile(run.resultsPath);
    return run.resultsPath;
  };

  const appendRecord = async (run, payload) => {
    const candidate = payload && typeof payload === 'object' ? payload : {};
    const phone = String(candidate.phone || '').trim();
    const nickname = String(candidate.nickname || '').trim();
    const screenshot = String(candidate.screenshot || '').trim();
    if (!phone || !nickname || !screenshot) throw new Error('结果记录必须包含手机号、截图和昵称。');
    const screenshotPath = path.resolve(screenshot);
    const allowedRoot = `${path.resolve(run.runPath)}${path.sep}`;
    if (!screenshotPath.startsWith(allowedRoot)) throw new Error('截图必须是当前脚本运行生成的文件。');
    await fs.access(screenshotPath);
    const record = { phone, screenshot: screenshotPath, nickname };
    run.records.push(record);
    const resultsPath = await writeResultsWorkbook(run);
    await appendLog(run, 'info', '结果已写入 Excel', { resultsPath, record });
    return { record, resultsPath };
  };

  const assertRun = (runId) => {
    const run = runs.get(String(runId));
    if (!run) throw new Error('脚本运行不存在或已结束。');
    if (run.cancelled) throw new Error('脚本已停止。');
    return run;
  };

  const getConnection = async (browserId) => {
    const active = getRunningBrowser(String(browserId));
    if (!active || !active.cdpUrl) throw new Error('浏览器未运行或 CDP 连接不可用。');
    const cached = connections.get(String(browserId));
    if (cached && cached.connected) return cached;
    const connected = await puppeteer.connect({ browserURL: active.cdpUrl, defaultViewport: null });
    connections.set(String(browserId), connected);
    return connected;
  };

  const getPage = (run, pageId) => {
    const page = run.pages.get(String(pageId));
    if (!page) throw new Error('页面句柄不存在或已失效。');
    return page;
  };

  const startRun = async (scriptId) => {
    const runId = crypto.randomUUID();
    const runPath = path.join(runsDir, runId);
    await fs.mkdir(runPath, { recursive: true });
    const run = {
      id: runId,
      scriptId: String(scriptId),
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: '',
      cancelled: false,
      pages: new Map(),
      records: [],
      logs: [],
      runPath,
      logPath: path.join(runPath, 'trace.jsonl'),
      resultsPath: path.join(runPath, 'results.xlsx')
    };
    runs.set(runId, run);
    await fs.writeFile(path.join(runPath, 'run.json'), JSON.stringify({ id: runId, scriptId: run.scriptId, status: run.status, startedAt: run.startedAt }, null, 2));
    await appendLog(run, 'info', '脚本运行已开始。');
    return { runId, startedAt: run.startedAt };
  };

  const finishRun = async (runId, status = 'completed', detail = '') => {
    const run = runs.get(String(runId));
    if (!run) return { status: 'missing' };
    run.status = run.cancelled ? 'cancelled' : status;
    run.finishedAt = new Date().toISOString();
    if (detail) await appendLog(run, run.status === 'completed' ? 'info' : 'error', detail);
    if (run.records.length > 0) await writeResultsWorkbook(run);
    await fs.writeFile(
      path.join(run.runPath, 'run.json'),
      JSON.stringify({ id: run.id, scriptId: run.scriptId, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt }, null, 2)
    );
    run.pages.clear();
    runs.delete(run.id);
    return { status: run.status, finishedAt: run.finishedAt };
  };

  const cancelRun = async (runId) => {
    const run = runs.get(String(runId));
    if (!run) return { cancelled: false };
    run.cancelled = true;
    await appendLog(run, 'warn', '用户停止了脚本运行。');
    return { cancelled: true };
  };

  const operation = async (runId, method, payload = {}) => {
    const run = assertRun(runId);
    const action = String(method || '');
    await appendLog(run, 'debug', `调用 ${action}`);
    try {
      let result;
      if (action === 'log') {
        result = await appendLog(run, String(payload.level || 'info'), String(payload.message || ''), payload.data);
      } else if (action === 'browsers.list') {
        const config = await readConfig();
        result = config.browsers.map((browser) => ({ id: browser.id, name: browser.name, running: Boolean(getRunningBrowser(browser.id)) }));
      } else if (action === 'browsers.create') {
        result = await createBrowser(payload);
      } else if (action === 'browsers.launch') {
        result = await launchBrowser(String(payload.browserId));
      } else if (action === 'browsers.stop') {
        result = await stopBrowser(String(payload.browserId));
      } else if (action === 'sms.acquire') {
        if (!smsProvider) throw new Error('短信测试服务未配置。');
        result = await smsProvider.acquire(payload);
      } else if (action === 'sms.waitForCode') {
        if (!smsProvider) throw new Error('短信测试服务未配置。');
        const phone = String(payload.phone || '').trim();
        if (!phone) throw new Error('等待验证码需要手机号。');
        const timeoutMs = Math.min(Math.max(Number(payload.timeoutMs) || 120000, 10000), 5 * 60 * 1000);
        const config = await readConfig();
        const configuredInterval = config.smsTesting && config.smsTesting.pollIntervalMs;
        const pollIntervalMs = Math.min(Math.max(Number(payload.pollIntervalMs) || Number(configuredInterval) || 10000, 5000), 30000);
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          assertRun(runId);
          const message = await smsProvider.getMessage({ phone, keyword: payload.keyword });
          if (message) {
            const match = message.match(/(?<!\d)(\d{4,8})(?!\d)/);
            if (!match) throw new Error('已收到短信，但未识别到 4 至 8 位验证码。');
            result = { phone, code: match[1] };
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }
        if (!result) throw new Error('等待短信验证码超时。');
      } else if (action === 'sms.release') {
        if (!smsProvider) throw new Error('短信测试服务未配置。');
        const phone = String(payload.phone || '').trim();
        if (!phone) throw new Error('释放号码需要手机号。');
        await smsProvider.release({ phone });
        result = { phone, released: true };
      } else if (action === 'pages.open') {
        const browserId = String(payload.browserId || '');
        if (!getRunningBrowser(browserId)) await launchBrowser(browserId);
        const browser = await getConnection(browserId);
        const page = await browser.newPage();
        if (payload.url) await page.goto(String(payload.url), { waitUntil: 'domcontentloaded', timeout: Number(payload.timeoutMs) || 30000 });
        const pageId = crypto.randomUUID();
        run.pages.set(pageId, page);
        result = { id: pageId, url: page.url() };
      } else if (action === 'pages.goto') {
        const page = getPage(run, payload.pageId);
        await page.goto(String(payload.url), { waitUntil: 'domcontentloaded', timeout: Number(payload.timeoutMs) || 30000 });
        result = { url: page.url() };
      } else if (action === 'pages.click') {
        const page = getPage(run, payload.pageId);
        await page.waitForSelector(String(payload.selector), { timeout: Number(payload.timeoutMs) || 15000 });
        await page.click(String(payload.selector));
        result = { clicked: true };
      } else if (action === 'pages.type') {
        const page = getPage(run, payload.pageId);
        await page.waitForSelector(String(payload.selector), { timeout: Number(payload.timeoutMs) || 15000 });
        if (payload.clear) {
          await page.$eval(String(payload.selector), (element) => {
            element.focus();
            if ('value' in element) element.value = '';
            else element.textContent = '';
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
          });
        }
        await page.type(String(payload.selector), String(payload.text || ''));
        result = { typed: true };
      } else if (action === 'pages.select') {
        const page = getPage(run, payload.pageId);
        await page.waitForSelector(String(payload.selector), { timeout: Number(payload.timeoutMs) || 15000 });
        result = await page.select(String(payload.selector), ...[].concat(payload.values || []).map(String));
      } else if (action === 'pages.waitFor') {
        const page = getPage(run, payload.pageId);
        await page.waitForSelector(String(payload.selector), { timeout: Number(payload.timeoutMs) || 15000, visible: Boolean(payload.visible) });
        result = { found: true };
      } else if (action === 'pages.delay') {
        const delayMs = Math.min(Math.max(Number(payload.delayMs) || 0, 0), 5 * 60 * 1000);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        assertRun(runId);
        result = { delayed: delayMs };
      } else if (action === 'pages.text') {
        const page = getPage(run, payload.pageId);
        await page.waitForSelector(String(payload.selector), { timeout: Number(payload.timeoutMs) || 15000 });
        result = await page.$eval(String(payload.selector), (element) => element.innerText);
      } else if (action === 'pages.evaluate') {
        const page = getPage(run, payload.pageId);
        const expression = String(payload.expression || '').trim();
        if (!expression) throw new Error('evaluate 需要表达式。');
        result = await page.evaluate((source) => new Function(`"use strict"; return (${source});`)(), expression);
      } else if (action === 'pages.screenshot') {
        const page = getPage(run, payload.pageId);
        const screenshotPath = path.join(run.runPath, `screenshot-${Date.now()}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: payload.fullPage !== false });
        result = { path: screenshotPath };
      } else if (action === 'records.append') {
        result = await appendRecord(run, payload);
      } else if (action === 'records.path') {
        result = { path: run.resultsPath, count: run.records.length };
      } else {
        throw new Error('不支持的脚本 API。');
      }
      await appendLog(run, 'info', `${action} 完成`, result);
      return result;
    } catch (error) {
      await appendLog(run, 'error', `${action} 失败：${error.message || '未知错误'}`);
      throw error;
    }
  };

  const listRuns = async (scriptId) => {
    try {
      const ids = await fs.readdir(runsDir);
      const records = [];
      for (const id of ids.slice(-MAX_RUNS)) {
        try {
          const filePath = path.join(runsDir, id, 'run.json');
          const item = JSON.parse(await fs.readFile(filePath, 'utf-8'));
          if (!scriptId || item.scriptId === String(scriptId)) records.push(item);
        } catch (_) {}
      }
      return records.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    } catch (_) {
      return [];
    }
  };

  const disconnectBrowser = async (browserId) => {
    const connection = connections.get(String(browserId));
    connections.delete(String(browserId));
    if (connection) {
      try {
        await connection.disconnect();
      } catch (_) {}
    }
  };

  return { MAX_SCRIPT_BYTES, startRun, finishRun, cancelRun, operation, listRuns, disconnectBrowser };
};

module.exports = { createAutomationService };
