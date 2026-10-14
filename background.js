/**
 * Awa自动翻译中文 - background service worker
 * 负责调用 Google 翻译免费接口执行翻译，带缓存与并发控制。
 * Copyright © Awa · www.akkdiy.cn
 */
'use strict';

const DEFAULT_TARGET = 'zh-CN';
const MAX_CACHE = 3000;
const POOL_SIZE = 5;

// 免费接口链：依次尝试，全部失败才报错
const ENDPOINTS = [
  (q, tl) =>
    'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=' +
    tl + '&dt=t&q=' + encodeURIComponent(q),
  (q, tl) =>
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' +
    tl + '&dt=t&q=' + encodeURIComponent(q),
  (q, tl) =>
    'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(q) +
    '&langpair=Autodetect|' + tl,
];

const memCache = new Map();

async function cacheGet(key) {
  if (memCache.has(key)) return memCache.get(key);
  try {
    const obj = await chrome.storage.session.get(key);
    if (obj && typeof obj[key] === 'string') {
      memCache.set(key, obj[key]);
      return obj[key];
    }
  } catch (e) { /* ignore */ }
  return null;
}

async function cacheSet(key, value) {
  memCache.set(key, value);
  if (memCache.size > MAX_CACHE) {
    memCache.delete(memCache.keys().next().value);
  }
  try {
    await chrome.storage.session.set({ [key]: value });
  } catch (e) { /* quota exceeded -> memory only */ }
}

function parseTranslation(data) {
  try {
    if (typeof data === 'string') data = JSON.parse(data);
    if (data && Array.isArray(data.sentences)) {
      return data.sentences.map((s) => s.trans || '').join('') || null;
    }
    if (data && data.responseData && data.responseData.translatedText) {
      return data.responseData.translatedText;
    }
    if (Array.isArray(data)) {
      // Google single 格式，兼容一层/两层嵌套：
      // [[["译文","原文",...], ...], ...] 或 [["译文","原文",...], ...]
      let top = [];
      if (Array.isArray(data[0])) {
        top = typeof data[0][0] === 'string' ? data : data[0];
      }
      const parts = [];
      for (const seg of top) {
        const pair = Array.isArray(seg) && Array.isArray(seg[0]) ? seg[0] : seg;
        if (Array.isArray(pair) && typeof pair[0] === 'string') parts.push(pair[0]);
      }
      return parts.join('') || null;
    }
  } catch (e) { /* fallthrough */ }
  return null;
}

async function translateOne(q, tl) {
  const key = tl + '|' + q;
  const cached = await cacheGet(key);
  if (cached) return cached;

  let lastErr = null;
  for (const build of ENDPOINTS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const resp = await fetch(build(q, tl));
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const text = await resp.text();
        const out = parseTranslation(text);
        if (out && out.trim() && out.trim() !== q.trim()) {
          await cacheSet(key, out);
          return out;
        }
        throw new Error('empty result');
      } catch (e) {
        lastErr = e;
      }
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
  }
  console.warn('[Awa翻译] 翻译失败:', lastErr && lastErr.message, q.slice(0, 40));
  return null;
}

// 简易并发池，避免同时请求过多被限流
const pool = { running: 0, queue: [] };
function pump() {
  while (pool.running < POOL_SIZE && pool.queue.length) {
    const task = pool.queue.shift();
    pool.running++;
    task.fn().then(task.resolve, task.reject).finally(() => {
      pool.running--;
      pump();
    });
  }
}
function enqueue(fn) {
  return new Promise((resolve, reject) => {
    pool.queue.push({ fn, resolve, reject });
    pump();
  });
}

async function translateBatch(texts, tl) {
  const uniq = [];
  const seen = new Set();
  for (const t of texts) {
    const k = (t || '').trim();
    if (k && !seen.has(k)) {
      seen.add(k);
      uniq.push(k);
    }
  }
  const results = await Promise.all(uniq.map((q) => enqueue(() => translateOne(q, tl))));
  const map = new Map();
  uniq.forEach((q, i) => map.set(q, results[i]));
  return texts.map((t) => {
    const r = map.get((t || '').trim());
    return r || null;
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return undefined;

  if (msg.type === 'awa-translate') {
    const texts = Array.isArray(msg.texts) ? msg.texts : [];
    const tl = msg.targetLang || DEFAULT_TARGET;
    (async () => {
      try {
        const out = [];
        const CHUNK = 40;
        for (let i = 0; i < texts.length; i += CHUNK) {
          const slice = texts.slice(i, i + CHUNK);
          const res = await translateBatch(slice, tl);
          for (let j = 0; j < res.length; j++) out.push(res[j]);
        }
        sendResponse({ ok: true, translations: out });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message) });
      }
    })();
    return true; // 异步响应
  }

  if (msg.type === 'awa-clear-cache') {
    memCache.clear();
    chrome.storage.session.clear().catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  return undefined;
});
