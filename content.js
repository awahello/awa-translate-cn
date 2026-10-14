/**
 * Awa自动翻译中文 - content script
 * 自动检测网页文字并翻译成中文（简体），保留原文可一键恢复。
 * Copyright © Awa · www.akkdiy.cn
 */
(function () {
  'use strict';

  if (!/^https?:$/.test(location.protocol)) return;

  // ---------- 状态 ----------
  const originalMap = new WeakMap(); // Text 节点 -> 原始完整文本
  const attrMap = new WeakMap();     // 元素 -> { 属性名: 原始值 }
  const state = {
    status: 'idle', // idle|off|off-site|already-cjk|translating|translated|restored|error
    translated: 0,
    cfg: null,
    siteKey: '',
  };
  // 翻译任务代号：每次开始翻译递增；点击「原文」时递增以取消进行中的翻译
  let runId = 0;
  // 用户是否手动点了「原文」（点了之后不再自动翻译，除非再点「中文」）
  let userRestored = false;

  const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;
  const HAS_LETTER_RE = /[A-Za-z\u00c0-\u024f\u0400-\u04ff\u0600-\u06ff\u0900-\u097f\u3040-\u30ff\uac00-\ud7af]/;
  const SKIP_SELECTOR =
    'script,style,noscript,template,textarea,select,option,code,pre,kbd,samp,canvas,svg,math,[translate="no"],[data-awa-skip]';

  // ---------- 工具 ----------
  function cjkRatio(text) {
    const stripped = text.replace(/\s+/g, '');
    if (!stripped) return 0;
    const cjk = (text.match(CJK_RE) || []).length;
    return cjk / stripped.length;
  }

  function sendMessage(msg) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) { done = true; reject(new Error('timeout')); }
      }, 25000);
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve(resp);
        });
      } catch (e) {
        if (!done) { done = true; clearTimeout(timer); reject(e); }
      }
    });
  }

  function loadCfg() {
    const defaults = {
      autoEnabled: true,
      disabledSites: [],
      targetLang: 'zh-CN',
    };
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get(defaults, (cfg) => {
          if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);
          resolve(Object.assign({}, defaults, cfg));
        });
      } catch (e) {
        resolve(defaults);
      }
    });
  }

  function siteKey() {
    try { return window.top.location.hostname; }
    catch (e) { return location.hostname; }
  }

  function visible(el) {
    try {
      const cs = getComputedStyle(el);
      if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false;
      return el.getClientRects().length > 0;
    } catch (e) { return false; }
  }

  function shouldSkipTextNode(node) {
    const p = node.parentElement;
    if (!p) return true;
    if (p.closest && p.closest(SKIP_SELECTOR)) return true;
    if (p.isContentEditable) return true;
    if (originalMap.has(node)) return true;
    if (!visible(p)) return true;
    const t = node.data;
    if (!t || t.trim().length < 2) return true;
    if (!HAS_LETTER_RE.test(t)) return true;       // 纯数字/符号不翻译
    if (cjkRatio(t) > 0.4) return true;            // 本身已是中文
    return false;
  }

  const ATTRS = ['alt', 'title', 'placeholder', 'aria-label'];

  function collect(root, caps) {
    const nodes = [], texts = [], attrs = [];
    if (root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          return shouldSkipTextNode(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        },
      });
      let cur;
      while ((cur = walker.nextNode()) && nodes.length < caps) {
        nodes.push(cur);
        texts.push(cur.data.replace(/\s+/g, ' ').trim());
      }
      let els = [];
      try { els = root.querySelectorAll('[alt],[title],[placeholder],[aria-label]'); } catch (e) { /* frame? */ }
      for (const el of els) {
        if (attrs.length >= 30) break;
        if (!visible(el) || el.isContentEditable) continue;
        const m = attrMap.get(el);
        for (const a of ATTRS) {
          if (attrs.length >= 30) break;
          if (!el.hasAttribute(a) || (m && m[a])) continue;
          const v = (el.getAttribute(a) || '').replace(/\s+/g, ' ').trim();
          if (v.length < 2 || !HAS_LETTER_RE.test(v) || cjkRatio(v) > 0.4) continue;
          attrs.push({ el, attr: a, text: v });
        }
      }
    }
    return { nodes, texts, attrs };
  }

  function applyNodes(nodes, texts, translations) {
    for (let i = 0; i < nodes.length; i++) {
      const t = translations && translations[i];
      const node = nodes[i];
      if (!t) continue;
      const raw = node.data;
      const m = raw.match(/^(\s*)[\s\S]*?(\s*)$/);
      const lead = m ? m[1] : '';
      const tail = m ? m[2] : '';
      if (!originalMap.has(node)) originalMap.set(node, raw);
      node.data = lead + t + tail;
      state.translated++;
    }
  }

  function applyAttrs(list, translations) {
    for (let i = 0; i < list.length; i++) {
      const t = translations && translations[i];
      if (!t) continue;
      const item = list[i];
      let m = attrMap.get(item.el);
      if (!m) { m = {}; attrMap.set(item.el, m); }
      if (!(item.attr in m)) m[item.attr] = item.el.getAttribute(item.attr);
      item.el.setAttribute(item.attr, t);
      state.translated++;
    }
  }

  async function processBatch(batch, id) {
    const CHUNK = 40;
    for (let i = 0; i < batch.nodes.length; i += CHUNK) {
      if (id !== undefined && id !== runId) return; // 任务已被取消（用户点了原文）
      const cn = batch.nodes.slice(i, i + CHUNK);
      const ct = batch.texts.slice(i, i + CHUNK);
      try {
        const resp = await sendMessage({
          type: 'awa-translate',
          texts: ct,
          targetLang: state.cfg.targetLang,
        });
        if (resp && resp.ok && (id === undefined || id === runId)) applyNodes(cn, ct, resp.translations);
      } catch (e) { /* 超时等错误：保留原文 */ }
    }
    for (let i = 0; i < batch.attrs.length; i += CHUNK) {
      if (id !== undefined && id !== runId) return; // 任务已被取消（用户点了原文）
      const ca = batch.attrs.slice(i, i + CHUNK);
      try {
        const resp = await sendMessage({
          type: 'awa-translate',
          texts: ca.map((a) => a.text),
          targetLang: state.cfg.targetLang,
        });
        if (resp && resp.ok && (id === undefined || id === runId)) applyAttrs(ca, resp.translations);
      } catch (e) { break; }
    }
    updatePill();
  }

  function restore() {
    // 取消进行中的翻译任务，防止恢复原文后被后续翻译再次覆盖
    runId++;
    userRestored = true;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let cur, n = 0;
    while ((cur = walker.nextNode())) {
      const raw = originalMap.get(cur);
      if (raw !== undefined) {
        cur.data = raw;
        originalMap.delete(cur);
        n++;
      }
    }
    document.body.querySelectorAll('[alt],[title],[placeholder],[aria-label]').forEach((el) => {
      const m = attrMap.get(el);
      if (m) {
        for (const a in m) el.setAttribute(a, m[a]);
        attrMap.delete(el);
      }
    });
    state.status = 'restored';
    state.translated = 0;
    updatePill();
    return n;
  }

  // ---------- 悬浮控制条 ----------
  const pillEls = {};
  function ensurePill() {
    if (pillEls.pill) return pillEls.pill;
    if (window.top !== window.self) return null; // iframe 不显示
    const pill = document.createElement('div');
    pill.id = 'awa-pill';
    pill.innerHTML =
      '<span class="awa-dot" id="awa-dot"></span>' +
      '<span class="awa-text" id="awa-text">Awa 翻译中…</span>' +
      '<button class="awa-btn awa-on" id="awa-zh" type="button">中文</button>' +
      '<button class="awa-btn" id="awa-orig" type="button">原文</button>' +
      '<span class="awa-close" id="awa-close" title="收起">×</span>';
    (document.body || document.documentElement).appendChild(pill);
    pillEls.pill = pill;
    pillEls.dot = pill.querySelector('#awa-dot');
    pillEls.text = pill.querySelector('#awa-text');
    pill.querySelector('#awa-zh').addEventListener('click', () => {
      if (state.status !== 'translating') translatePage();
    });
    pill.querySelector('#awa-orig').addEventListener('click', restore);
    pill.querySelector('#awa-close').addEventListener('click', () => {
      pill.style.display = 'none';
    });
    return pill;
  }

  function updatePill() {
    if (!pillEls.pill && state.status !== 'idle') ensurePill();
    if (!pillEls.pill) return;
    const dot = pillEls.dot, text = pillEls.text;
    let color = '#1a73e8', label = '';
    switch (state.status) {
      case 'off': color = '#9aa0a6'; label = 'Awa：未开启自动翻译'; pillEls.pill.style.display = 'none'; break;
      case 'off-site': color = '#9aa0a6'; label = 'Awa：本网站已关闭自动翻译'; pillEls.pill.style.display = 'none'; break;
      case 'already-cjk': color = '#9aa0a6'; label = 'Awa：本页已是中文'; pillEls.pill.style.display = 'none'; break;
      case 'idle': pillEls.pill.style.display = 'none'; break;
      case 'translating': color = '#f9ab00'; label = 'Awa 正在翻译为中文…（已译 ' + state.translated + ' 处）'; pillEls.pill.style.display = ''; break;
      case 'translated': color = '#188038'; label = 'Awa 已翻译为中文（已译 ' + state.translated + ' 处）'; pillEls.pill.style.display = ''; break;
      case 'restored': color = '#9aa0a6'; label = 'Awa：已显示原文'; pillEls.pill.style.display = ''; break;
      case 'error': color = '#d93025'; label = 'Awa：翻译失败，点击"中文"重试'; pillEls.pill.style.display = ''; break;
      default: label = '';
    }
    dot.style.background = color;
    text.textContent = label;
  }

  // ---------- 动态内容监听 ----------
  let obsTimer = null;
  function observe() {
    const obs = new MutationObserver(() => {
      if (state.status !== 'translated' && state.status !== 'translating') return;
      if (obsTimer) return;
      obsTimer = setTimeout(async () => {
        obsTimer = null;
        if (state.status !== 'translated') return;
        const batch = collect(document.body, 200);
        if (batch.nodes.length || batch.attrs.length) {
          const id = runId;
          state.status = 'translating';
          updatePill();
          await processBatch(batch, id);
          if (id !== runId) return; // 已被取消
          state.status = 'translated';
          updatePill();
        }
      }, 600);
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }

  // ---------- 主流程 ----------
  async function translatePage() {
    if (state.status === 'translating' || state.status === 'off' ||
        state.status === 'off-site' || state.status === 'already-cjk') return;
    const id = ++runId;
    userRestored = false; // 用户手动点击了「中文」，恢复自动翻译
    state.status = 'translating';
    updatePill();
    ensurePill();
    let ok = false;
    try {
      const first = collect(document.body, 400);
      await processBatch(first, id);
      ok = true;
      // 二次扫描，捕获延迟加载的内容
      setTimeout(async () => {
        if (id !== runId || state.status !== 'translated') return;
        const more = collect(document.body, 300);
        if (more.nodes.length || more.attrs.length) {
          state.status = 'translating';
          updatePill();
          await processBatch(more, id);
          if (id !== runId) return; // 已被取消
          state.status = 'translated';
          updatePill();
        }
      }, 1200);
    } catch (e) {
      ok = false;
    }
    if (id !== runId) return; // 任务已被取消（用户在翻译过程中点了原文）
    state.status = ok ? 'translated' : 'error';
    updatePill();
  }

  async function rerun() {
    state.cfg = await loadCfg();
    state.siteKey = siteKey();
    const siteDisabled = (state.cfg.disabledSites || []).indexOf(state.siteKey) !== -1;
    if (!state.cfg.autoEnabled) { state.status = 'off'; updatePill(); return; }
    if (siteDisabled) { state.status = 'off-site'; updatePill(); return; }
    if (!document.body) { state.status = 'idle'; updatePill(); return; }
    // 用户手动点过「原文」后，不再自动翻译，除非再点「中文」
    if (userRestored) { state.status = 'restored'; updatePill(); return; }
    const sample = (document.body.innerText || '').slice(0, 4000);
    if (cjkRatio(sample) > 0.5) { state.status = 'already-cjk'; updatePill(); return; }
    ensurePill();
    observe();
    await translatePage();
  }

  // ---------- popup 通信 ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return undefined;
    switch (msg.type) {
      case 'awa-get-state':
        sendResponse({
          ok: true,
          status: state.status,
          translated: state.translated,
          siteKey: state.siteKey,
          targetLang: state.cfg ? state.cfg.targetLang : 'zh-CN',
          autoEnabled: !!(state.cfg && state.cfg.autoEnabled),
          siteDisabled: !!(state.cfg && (state.cfg.disabledSites || []).indexOf(state.siteKey) !== -1),
        });
        return true;
      case 'awa-translate-now':
        translatePage().then(() => sendResponse({ ok: true, status: state.status }));
        return true;
      case 'awa-restore':
        sendResponse({ ok: true, count: restore() });
        return true;
      case 'awa-reload-cfg':
        rerun().then(() => sendResponse({ ok: true }));
        return true;
      default:
        return undefined;
    }
  });

  // ---------- 启动 ----------
  rerun();

  // SPA 页面地址变化时重新处理
  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    if (state.status === 'restored' || state.status === 'off' || state.status === 'off-site') return;
    rerun();
  }, 2000);
})();
