// Starts before playback and runs independently inside each embedded frame.
(function() {
  'use strict';
  if (globalThis.__cleanPlayContent) {
    return globalThis.__cleanPlayContent.scan(true);
  }
  const detector = globalThis.CleanPlayDetector;
  const urls = new Set();
  const pending = new Set();
  let flushTimer = null;
  let scanTimer = null;
  let stopped = false;
  const scriptCache = new WeakMap();
  const selector = '#robotlink, #norobotlink, #videolink, #ideoolink, #ideoooolink, a[href], area[href], video, source, script:not([src]), [data-src], [data-source], [data-file], [data-video], [data-video-src], [data-url], [data-setup], [data-config], [itemprop="contentUrl"], meta[property^="og:video"]';
  const attributes = ['src', 'href', 'data-src', 'data-source', 'data-file', 'data-video', 'data-video-src', 'data-url', 'data-setup', 'data-config', 'content'];
  function collect(text) {
    const direct = detector.normalize(text, document.baseURI);
    for (const url of direct ? [direct] : detector.extract(text, document.baseURI)) {
      if (urls.has(url) || urls.size >= 100) continue;
      urls.add(url);
      pending.add(url);
    }
    if (pending.size && !flushTimer && !stopped) flushTimer = setTimeout(flush, 20);
  }
  function flush() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (!pending.size || stopped) return;
    const batch = [...pending];
    pending.clear();
    try {
      chrome.runtime.sendMessage({ type: 'DISCOVERED_URLS', urls: batch }, function() {
        // Extension reload invalidates old content scripts.
        if (chrome.runtime.lastError) stopped = true;
      });
    } catch (_) { stopped = true; }
  }
  function inspect(el) {
    if (!el || el.nodeType !== 1) return;
    if (el.matches('#robotlink, #norobotlink, #videolink, #ideoolink, #ideoooolink')) {
      // Read the finished URL after the site's own scripts assemble it.
      collect(el.textContent || '');
    }
    if (el.matches('video, source')) {
      collect(el.currentSrc || '');
      collect(el.src || '');
    }
    if (el.matches('script:not([src])')) {
      const text = el.textContent || '';
      const cached = scriptCache.get(el);
      if (!cached || cached.text !== text || cached.base !== document.baseURI) {
        scriptCache.set(el, {text,base:document.baseURI});
        collect(text);
      }
    }
    for (const name of attributes) {
      const value = el.getAttribute(name);
      // A link target must itself be media. Do not extract a video-looking
      // substring from a watch-page query, redirect, or javascript: handler.
      if (name === 'href') {
        const url = detector.normalize(value, document.baseURI);
        if (url) collect(url);
        continue;
      }
      if (value) collect(value);
    }
  }
  function inspectTree(node) {
    if (!node || !node.querySelectorAll) return;
    inspect(node);
    node.querySelectorAll(selector).forEach(inspect);
  }
  function scan(replay) {
    inspectTree(document);
    performance.getEntriesByType('resource').forEach(entry => collect(entry.name));
    if (replay) for (const url of urls) pending.add(url);
    flush();
    // The page probe reads existing player configuration; it never clicks ads.
    window.postMessage({ type: '__CLEANPLAY_SCAN_PLAYERS__' }, '*');
    return [...urls];
  }
  globalThis.__cleanPlayContent = { scan };
  const roots = new Set();
  const observer = new MutationObserver(function(records) {
    for (const record of records) {
      if (record.type === 'childList') {
        record.addedNodes.forEach(node => {
          const target = node.nodeType === 3 ? node.parentElement : node;
          if (target && roots.size < 200) roots.add(target);
        });
      } else if (roots.size < 200) {
        roots.add(record.type === 'characterData' ? record.target.parentElement : record.target);
      }
    }
    if (!scanTimer) scanTimer = setTimeout(function() {
      scanTimer = null;
      roots.forEach(inspectTree);
      roots.clear();
      window.postMessage({type:'__CLEANPLAY_SCAN_PLAYERS__'}, '*');
    }, 40);
  });
  observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: attributes });
  function findClickedFid(target) {
    let cur = target;
    for (let i = 0; i < 6 && cur && cur !== document.body; i++) {
      for (const attr of ['data-fid', 'data-fs-id', 'data-fsid', 'data-id', 'data-file-id']) {
        const val = cur.getAttribute?.(attr);
        if (val && /^\d{10,25}$/.test(val)) return val;
      }
      if (cur.tagName === 'A' && cur.href) {
        try {
          const u = new URL(cur.href, document.baseURI);
          const fid = u.searchParams.get('fid') || u.searchParams.get('fs_id');
          if (fid && /^\d{10,25}$/.test(fid)) return fid;
        } catch (_) {}
      }
      cur = cur.parentElement;
    }
    return null;
  }
  document.addEventListener('click', function(event) {
    if (event.target && event.target.closest && (event.target.closest('#__cleanplay_prompt__') || event.target.closest('#__cp__'))) return;
    const fid = findClickedFid(event.target);
    try {
      if (fid) {
        chrome.runtime.sendMessage({ type: 'ACTIVE_FID', fid }, () => {
          if (chrome.runtime.lastError) {}
        });
      } else {
        chrome.runtime.sendMessage({ type: 'PAGE_INTERACTION' }, () => {
          if (chrome.runtime.lastError) {}
        });
      }
    } catch (_) {}
    setTimeout(() => scan(false), 200);
    setTimeout(() => scan(false), 800);
  }, true);
  window.addEventListener('popstate', () => {
    try {
      chrome.runtime.sendMessage({ type: 'PAGE_INTERACTION' }, () => {
        if (chrome.runtime.lastError) {}
      });
    } catch (_) {}
    setTimeout(() => scan(false), 200);
    setTimeout(() => scan(false), 800);
  });
  window.addEventListener('hashchange', () => {
    try {
      chrome.runtime.sendMessage({ type: 'PAGE_INTERACTION' }, () => {
        if (chrome.runtime.lastError) {}
      });
    } catch (_) {}
    setTimeout(() => scan(false), 200);
    setTimeout(() => scan(false), 800);
  });
  function handleMediaActivity(event) {
    if (event.target && event.target.matches && event.target.matches('video, audio')) {
      inspect(event.target);
      try {
        const entries = performance.getEntriesByType('resource');
        for (let i = entries.length - 1; i >= Math.max(0, entries.length - 15); i--) {
          const norm = detector.normalize(entries[i].name, document.baseURI);
          if (norm && (detector.isHls(norm) || detector.isDirectVideo(norm))) {
            chrome.runtime.sendMessage({ type: 'ACTIVE_VIDEO', url: norm }, () => {
              if (chrome.runtime.lastError) {}
            });
            break;
          }
        }
      } catch (_) {}
      window.postMessage({ type: '__CLEANPLAY_SCAN_PLAYERS__' }, '*');
    }
  }
  document.addEventListener('play', handleMediaActivity, true);
  document.addEventListener('playing', handleMediaActivity, true);
  document.addEventListener('loadstart', handleMediaActivity, true);
  try {
    const resources = new PerformanceObserver(function(list) {
      list.getEntries().forEach(entry => {
        collect(entry.name);
        const norm = detector.normalize(entry.name, document.baseURI);
        if (norm && (detector.isHls(norm) || detector.isDirectVideo(norm))) {
          try {
            chrome.runtime.sendMessage({ type: 'ACTIVE_VIDEO', url: norm }, () => {
              if (chrome.runtime.lastError) {}
            });
          } catch (_) {}
        }
      });
    });
    resources.observe({ type: 'resource', buffered: true });
  } catch (_) { /* The initial resource scan remains available. */ }
  window.addEventListener('message', function(event) {
    if (event.source !== window || !event.data || event.data.type !== '__CLEANPLAY_PLAYER_URLS__') return;
    // Page messages are untrusted: accept only bounded, recognized media URLs.
    if (!Array.isArray(event.data.urls)) return;
    event.data.urls.slice(0, 100).forEach(value => {
      const url = detector.normalize(value, document.baseURI);
      if (url) collect(url);
    });
  });
  document.addEventListener('load', event => {
    if (event.target.tagName === 'SCRIPT') window.postMessage({type:'__CLEANPLAY_SCAN_PLAYERS__'}, '*');
  }, true);
  document.addEventListener('loadedmetadata', event => inspect(event.target), true);
  document.addEventListener('DOMContentLoaded', () => scan(false), { once: true });
  window.addEventListener('pageshow', () => scan(true));
  return scan(false);
})();
