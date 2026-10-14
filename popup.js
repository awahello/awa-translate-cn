/**
 * Awa自动翻译中文 - popup 逻辑
 * Copyright © Awa · www.akkdiy.cn
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    siteHost: $('siteHost'),
    stateText: $('stateText'),
    countText: $('countText'),
    dot: $('statusDot'),
    btnTranslate: $('btnTranslate'),
    btnRestore: $('btnRestore'),
    chkAuto: $('chkAuto'),
    chkSite: $('chkSite'),
  };

  const STATE_TEXT = {
    idle: '等待检测',
    off: '全局自动翻译已关闭',
    'off-site': '本网站已关闭自动翻译',
    'already-cjk': '本页已是中文，无需翻译',
    translating: '正在翻译为中文…',
    translated: '已翻译为中文',
    restored: '已恢复原文',
    error: '翻译失败（可重试）',
  };
  const STATE_DOT = {
    idle: 'dot-idle',
    off: 'dot-off',
    'off-site': 'dot-off',
    'already-cjk': 'dot-off',
    translating: 'dot-run',
    translated: 'dot-ok',
    restored: 'dot-off',
    error: 'dot-err',
  };

  function sendToTab(tabId, msg) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, msg, (resp) => {
        if (chrome.runtime.lastError) resolve({ __err: chrome.runtime.lastError.message });
        else resolve(resp || { __err: '无响应' });
      });
    });
  }

  function getActiveTab() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (chrome.runtime.lastError || !tabs || !tabs.length) resolve(null);
        else resolve(tabs[0]);
      });
    });
  }

  function inject(tabId) {
    return new Promise((resolve) => {
      chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['content.js'] }, () => {
        if (chrome.runtime.lastError) resolve(false);
        else resolve(true);
      });
    });
  }

  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(
        { autoEnabled: true, disabledSites: [], targetLang: 'zh-CN' },
        (cfg) => resolve(cfg)
      );
    });
  }

  function save(patch) {
    return new Promise((resolve) => chrome.storage.sync.set(patch, resolve));
  }

  async function refresh() {
    const tab = await getActiveTab();
    const cfg = await loadSettings();

    els.chkAuto.checked = !!cfg.autoEnabled;
    const host = tab && tab.url ? hostOf(tab.url) : '';
    els.siteHost.textContent = host || '—';
    els.chkSite.checked = !host || (cfg.disabledSites || []).indexOf(host) === -1;
    els.chkSite.disabled = !host;

    if (!tab || !/^https?:/i.test(tab.url || '')) {
      setStateText('当前页面不支持翻译', 'dot-off', '—');
      return;
    }

    let resp = await sendToTab(tab.id, { type: 'awa-get-state' });
    if (resp.__err) {
      // 页面可能在扩展安装前打开，尝试注入内容脚本
      const ok = await inject(tab.id);
      await new Promise((r) => setTimeout(r, 150));
      resp = ok ? await sendToTab(tab.id, { type: 'awa-get-state' }) : resp;
    }

    if (resp.__err) {
      setStateText('请刷新页面后重试', 'dot-err', '—');
      return;
    }

    const st = resp.status || 'idle';
    els.countText.textContent = (resp.translated || 0) + ' 处';
    setStateText(STATE_TEXT[st] || st, STATE_DOT[st] || 'dot-idle', null);
    els.chkAuto.checked = !!resp.autoEnabled;
    els.chkSite.checked = !resp.siteDisabled;
  }

  function setStateText(text, dotClass, count) {
    els.stateText.textContent = text;
    els.dot.className = 'dot ' + (dotClass || 'dot-idle');
    if (count) els.countText.textContent = count;
  }

  function hostOf(url) {
    try { return new URL(url).hostname; } catch (e) { return ''; }
  }

  // ---------- 事件 ----------
  els.btnTranslate.addEventListener('click', async () => {
    const tab = await getActiveTab();
    if (!tab) return;
    els.stateText.textContent = '正在翻译…';
    els.dot.className = 'dot dot-run';
    await sendToTab(tab.id, { type: 'awa-translate-now' });
    setTimeout(refresh, 400);
  });

  els.btnRestore.addEventListener('click', async () => {
    const tab = await getActiveTab();
    if (!tab) return;
    await sendToTab(tab.id, { type: 'awa-restore' });
    setTimeout(refresh, 200);
  });

  els.chkAuto.addEventListener('change', async () => {
    const on = els.chkAuto.checked;
    await save({ autoEnabled: on });
    const tab = await getActiveTab();
    if (tab) await sendToTab(tab.id, { type: 'awa-reload-cfg' });
    setTimeout(refresh, 250);
  });

  els.chkSite.addEventListener('change', async () => {
    const on = els.chkSite.checked;
    const cfg = await loadSettings();
    const tab = await getActiveTab();
    const host = tab && tab.url ? hostOf(tab.url) : '';
    if (!host) return;
    let list = (cfg.disabledSites || []).slice();
    if (on) list = list.filter((h) => h !== host);
    else if (list.indexOf(host) === -1) list.push(host);
    await save({ disabledSites: list });
    if (tab) await sendToTab(tab.id, { type: 'awa-reload-cfg' });
    setTimeout(refresh, 250);
  });

  refresh();
})();
