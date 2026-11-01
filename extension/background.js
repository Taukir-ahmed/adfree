importScripts('detector.js', 'overlay.js');

// CleanPlay v3 - background.js
// Intercepts network requests and scores likely video sources (not resolution)

const store = {}; // tabId -> { urls: [], scored: {} }

// Score a URL — higher = more likely to be the real video
function scoreUrl(url) {
  let score = 0;
  const u = url.toLowerCase();
  const path = u.split('?')[0];

  // Format bonus
  if (path.endsWith('.mp4') || /\/file\/[0-9a-f]{32}$/.test(path)) score += 30;
  else if (path.endsWith('.m3u8') || CleanPlayDetector.isHls(url)) score += 25;
  else if (path.endsWith('.webm')) score += 20;
  else if (path.endsWith('.ts')) score += 5;

  const resMatch = u.match(/[?&]type=m3u8_(?:auto|flv|hls)_[a-z0-9_]*?(\d{3,4})\b/);
  if (resMatch) score += Math.min(4, Math.floor(Number(resMatch[1]) / 360));

  // Penalty for likely ad URLs
  if (/ad[s]?[./]|doubleclick|googlesyndication|adserver|prebid|ima\.|vast|vpaid|adnxs|adsystem|googletagmanager/.test(u)) score -= 100;

  // Penalty for tracking/analytics
  if (/analytics|pixel|beacon|telemetry|heartbeat|ping/.test(u)) score -= 50;

  // Bonus for video CDN patterns
  if (/cdn|stream|video|media|content|hls|vod/.test(u)) score += 10;

  // Bonus for longer paths (real videos have longer tokens)
  const pathLen = path.split('/').filter(Boolean).length;
  if (pathLen >= 3) score += 5;

  // Bonus for token/key params (real video URLs)
  if (/token=|key=|hash=|expires=|sig(?:n)?=|jstoken=/i.test(url)) score += 15;

  // Penalty for very short URLs (likely ad beacons)
  if (url.length < 40) score -= 20;

  return score;
}

function isVideoUrl(url) {
  return !!CleanPlayDetector.normalize(url);
}

function getVideoId(url) {
  return CleanPlayDetector.getVideoId ? CleanPlayDetector.getVideoId(url) : '';
}

function sortUrls(state) {
  const activeId = getVideoId(state.activeUrl);
  state.urls.sort((a, b) => {
    if (state.activeUrl) {
      if (a === state.activeUrl) return -1;
      if (b === state.activeUrl) return 1;
      if (activeId) {
        const aActive = getVideoId(a) === activeId;
        const bActive = getVideoId(b) === activeId;
        if (aActive && !bActive) return -1;
        if (!aActive && bActive) return 1;
      }
    }
    return (state.scores[b] || 0) - (state.scores[a] || 0);
  });
}

function automaticVideo(state) {
  if (!state) return null;
  const activeId = getVideoId(state.activeUrl);
  if (activeId) {
    const activeVerified = state.urls.find(u => getVideoId(u) === activeId && state.scores[u] >= 0 && state.verified?.[u] === true);
    if (activeVerified) return activeVerified;
    if (state.urls.some(u => getVideoId(u) === activeId && state.scores[u] >= 0 && state.verified?.[u] === 'pending')) return null;
    const activeAny = state.urls.find(u => getVideoId(u) === activeId && state.scores[u] >= 0 && state.verified?.[u] !== false);
    if (activeAny) return activeAny;
  }
  const verified = state.urls.find(url => state.scores[url] >= 0 && state.verified?.[url] === true);
  if (verified) return verified;
  if (state.urls.some(url => state.scores[url] >= 0 && state.verified?.[url] === 'pending')) return null;
  return state.urls.find(url => state.scores[url] >= 0 && state.verified?.[url] !== false) || null;
}

function shouldVerifyUrl(url) {
  if (typeof fetch !== 'function') return false;
  try {
    const u = new URL(url);
    if (/^(?:\/openapi)?\/(?:share|sharing|api)\/streaming$/i.test(u.pathname)) return true;
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return false;
    return true;
  } catch (_) { return false; }
}

function extractHlsQuality(text, url) {
  let bestHeight = 0;
  for (const match of String(text || '').matchAll(/RESOLUTION=\d+x(\d+)/gi)) {
    const h = Number(match[1]);
    if (h > bestHeight) bestHeight = h;
  }
  if (bestHeight > 0) return bestHeight + 'p';
  try {
    const type = new URL(url).searchParams.get('type') || '';
    const m = type.match(/(\d{3,4})$/);
    if (m) return m[1] + 'p';
  } catch (_) {}
  return '';
}

function updateBadge(tabId, state) {
  if (!store[tabId] || store[tabId] !== state) return;
  chrome.action.setBadgeText({ text: state.urls.length ? String(state.urls.length) : '', tabId }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#7c3aed', tabId }).catch(() => {});
}

async function verifyCandidate(tabId, url, state) {
  state.verified = state.verified || {};
  state.qualities = state.qualities || {};
  if (state.verified[url]) return;
  state.verified[url] = 'pending';
  try {
    if (CleanPlayDetector.isHls(url)) {
      let res;
      try {
        res = await fetch(url, { credentials: 'include' });
      } catch (_) {
        res = await fetch(url);
      }
      if (store[tabId] !== state) return;
      const text = res.ok ? await res.text() : '';
      if (store[tabId] !== state) return;
      if (res.ok && /#EXTM3U/i.test(text) && /#EXT(?:-X-STREAM-INF|INF)/i.test(text)) {
        state.verified[url] = true;
        const quality = extractHlsQuality(text, url);
        if (quality) state.qualities[url] = quality;
        state.scores[url] = (state.scores[url] || 0) + 120;
        state.urls.sort((a, b) => state.scores[b] - state.scores[a]);
        notifyAutomaticVideo(tabId);
        return;
      }
      // This HLS endpoint did not return a playable playlist.
      state.verified[url] = false;
      state.urls = state.urls.filter(u => u !== url);
      delete state.scores[url];
      updateBadge(tabId, state);
      // If a synthesized TeraBox 1080p stream failed, probe lower TeraBox stream qualities automatically.
      try {
        const parsed = new URL(url);
        if (/^(?:\/openapi)?\/(?:share|sharing|api)\/streaming$/i.test(parsed.pathname) &&
          /^M3U8_AUTO_1080$/i.test(parsed.searchParams.get('type') || '') &&
          !state.teraboxFallbackTried?.[parsed.searchParams.get('fid')]) {
          state.teraboxFallbackTried = state.teraboxFallbackTried || {};
          state.teraboxFallbackTried[parsed.searchParams.get('fid')] = true;
          for (const nextType of ['M3U8_AUTO_720', 'M3U8_AUTO_480', 'M3U8_FLV_264_480', 'M3U8_AUTO_360']) {
            const candidate = new URL(url);
            candidate.searchParams.set('type', nextType);
            addUrls(tabId, [candidate.href]);
          }
          return;
        }
      } catch (_) {}
      notifyAutomaticVideo(tabId);
    } else {
      let res;
      try {
        res = await fetch(url, { headers: { Range: 'bytes=0-1' }, credentials: 'include' });
      } catch (_) {
        res = await fetch(url, { headers: { Range: 'bytes=0-1' } });
      }
      if (store[tabId] !== state) return;
      const contentType = (res.headers?.get?.('content-type') || '').toLowerCase();
      if (res.ok && !/^(?:text\/html|application\/json|text\/plain)/.test(contentType)) {
        state.verified[url] = true;
        state.scores[url] = (state.scores[url] || 0) + 100;
        state.urls.sort((a, b) => state.scores[b] - state.scores[a]);
        notifyAutomaticVideo(tabId);
      } else {
        state.verified[url] = false;
        state.urls = state.urls.filter(u => u !== url);
        delete state.scores[url];
        updateBadge(tabId, state);
        notifyAutomaticVideo(tabId);
      }
    }
  } catch (_) {
    if (store[tabId] !== state) return;
    state.verified[url] = 'unverified';
    notifyAutomaticVideo(tabId);
  }
}

function notifyAutomaticVideo(tabId) {
  const state = store[tabId];
  if (!state || state.autoDismissed) return;
  const auto = automaticVideo(state);
  if (!auto) return;
  if (state.dismissedVideoId && getVideoId(auto) === state.dismissedVideoId) return;
  if (!state.autoTicket) state.autoTicket = crypto.randomUUID();
  chrome.tabs.sendMessage(tabId, {type:'AUTO_VIDEO_AVAILABLE',ticket:state.autoTicket}, {frameId:0}).catch(() => {});
}

function dismissAutomaticVideo(tabId) {
  const state = store[tabId] || (store[tabId] = {urls:[],scores:{}});
  state.autoDismissed = true;
  state.dismissedVideoId = getVideoId(state.activeUrl || automaticVideo(state) || state.urls[0]);
  chrome.tabs.sendMessage(tabId, {type:'HIDE_AUTO_PROMPT'}, {frameId:0}).catch(() => {});
}

function addActiveUrl(tabId, value, fromUser = false) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  const url = CleanPlayDetector.normalize(value);
  if (!url) return;
  const score = scoreUrl(url);
  if (score < 0) {
    addUrls(tabId, [url]);
    return;
  }
  const state = store[tabId] || (store[tabId] = { urls: [], scores: {} });
  state.verified = state.verified || {};
  state.qualities = state.qualities || {};

  if (state.activeUrl === url && state.urls.includes(url)) {
    return;
  }

  const newId = getVideoId(url);
  const prevActiveId = getVideoId(state.activeUrl);
  const isDifferentVideo = newId && (newId !== prevActiveId || !state.activeUrl);

  state.activeUrl = url;

  if (isDifferentVideo) {
    state.autoTicket = crypto.randomUUID();
    if (fromUser) {
      state.autoDismissed = false;
      state.dismissedVideoId = null;
    }
  }

  if (!state.urls.includes(url)) {
    state.urls.unshift(url);
  }

  state.scores[url] = Math.max(state.scores[url] || 0, score + 1000);

  if (newId) {
    for (const other of state.urls) {
      if (other !== url && getVideoId(other) === newId) {
        state.scores[other] = Math.max(state.scores[other] || 0, scoreUrl(other) + 500);
      }
    }
  }

  sortUrls(state);
  const removed = state.urls.splice(30);
  removed.forEach(u => delete state.scores[u]);

  if (shouldVerifyUrl(url) && state.verified[url] !== true) {
    verifyCandidate(tabId, url, state);
  } else {
    notifyAutomaticVideo(tabId);
  }
  updateBadge(tabId, state);
}

function promoteActiveFid(tabId, fid) {
  if (!Number.isInteger(tabId) || tabId < 0 || !fid) return;
  const state = store[tabId];
  if (!state || !Array.isArray(state.urls)) return;
  const targetId = 'fid:' + String(fid).split('-').pop();
  const match = state.urls.find(u => getVideoId(u) === targetId);
  state.autoDismissed = false;
  state.dismissedVideoId = null;
  if (match) {
    addActiveUrl(tabId, match, true);
  }
}

function addUrls(tabId, values) {
  if (!Number.isInteger(tabId) || tabId < 0 || !Array.isArray(values)) return;
  const state = store[tabId] || (store[tabId] = { urls: [], scores: {} });
  state.verified = state.verified || {};
  state.qualities = state.qualities || {};
  const previous = state.urls.join('\n');
  const toVerify = [];
  for (const value of values.slice(0, 100)) {
    const url = CleanPlayDetector.normalize(value);
    if (!url || state.urls.includes(url) || state.verified[url] === false) continue;
    state.scores[url] = scoreUrl(url);
    state.urls.push(url);
    if (shouldVerifyUrl(url) && !state.verified[url]) {
      state.verified[url] = 'pending';
      toVerify.push(url);
    }
  }
  sortUrls(state);
  const removed = state.urls.splice(30);
  removed.forEach(url => delete state.scores[url]);
  if (state.urls.join('\n') === previous) return;
  for (const url of toVerify) {
    if (state.urls.includes(url)) {
      delete state.verified[url];
      verifyCandidate(tabId, url, state);
    }
  }
  notifyAutomaticVideo(tabId);
  updateBadge(tabId, state);
}

chrome.webRequest.onBeforeRequest.addListener(function(details) {
  if (details.tabId < 0) return;
  if (details.type === 'main_frame') {
    // Reset before the new document starts reporting early discoveries.
    store[details.tabId] = { urls: [], scores: {} };
    dropOverlay(details.tabId);
    chrome.action.setBadgeText({ text: '', tabId: details.tabId }).catch(() => {});
  } else if (details.type !== 'sub_frame' && isVideoUrl(details.url)) {
    addActiveUrl(details.tabId, details.url);
  }
}, { urls: ['<all_urls>'] });

chrome.tabs.onRemoved.addListener(function(tabId) {
  delete store[tabId];
  dropOverlay(tabId);
});

const scanJobs = new Map();

function boundedInjection(options, tabId, state) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ status: 'timeout' }), 3000);
    Promise.resolve().then(() => chrome.scripting.executeScript({
      ...options, injectImmediately: true
    })).then(results => {
      // A late result from a previous navigation must not restore old links.
      if (store[tabId] === state) {
        for (const frame of results || []) addUrls(tabId, frame.result);
      }
      clearTimeout(timer);
      resolve({ status: 'complete' });
    }, () => {
      clearTimeout(timer);
      resolve({ status: 'unavailable' });
    });
  });
}

function scanPage(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) return Promise.reject(new Error('Invalid tab'));
  if (scanJobs.has(tabId)) return scanJobs.get(tabId);
  const state = store[tabId] || (store[tabId] = { urls: [], scores: {} });
  // Main-page discovery must not wait for an ad iframe or optional page-world probe.
  const job = Promise.all([
    boundedInjection({ target: { tabId, frameIds: [0] }, files: ['detector.js', 'auto-prompt.js', 'content.js'] }, tabId, state),
    boundedInjection({ target: { tabId, allFrames: true }, files: ['detector.js', 'content.js'] }, tabId, state),
    boundedInjection({ target: { tabId, allFrames: true }, world: 'MAIN', files: ['page-probe.js'] }, tabId, state)
  ]).then(results => ({
    ...(store[tabId] || { urls: [], scores: {} }),
    partial: results.some(result => result.status !== 'complete')
  })).finally(() => {
    if (scanJobs.get(tabId) === job) scanJobs.delete(tabId);
  });
  scanJobs.set(tabId, job);
  return job;
}

// ticket -> { tabId, url }. A ticket is the only way the overlay frame learns what to play, so a
// web page embedding the web-accessible overlay.html itself gets nothing. It stays valid while the
// overlay is mounted: the page can force the frame to reload by removing the host element, and the
// reloaded frame must be able to claim again.
const overlayTickets = new Map();
const overlayPage = () => chrome.runtime.getURL('overlay.html');

function dropOverlay(tabId) {
  for (const [key, entry] of overlayTickets) {
    if (entry.tabId === tabId) overlayTickets.delete(key);
  }
}

async function openOverlay(tabId, value) {
  const url = CleanPlayDetector.normalize(value);
  if (!Number.isInteger(tabId) || tabId < 0 || !url) throw new Error('Invalid video or tab');
  dropOverlay(tabId);
  const ticket = crypto.randomUUID();
  overlayTickets.set(ticket, {tabId, url});
  try {
    await chrome.scripting.executeScript({
      target:{tabId,frameIds:[0]}, injectImmediately:true,
      func:mountCleanPlayOverlay,
      args:[overlayPage()+'?ticket='+encodeURIComponent(ticket)]
    });
    dismissAutomaticVideo(tabId);
    return {ok:true};
  } catch (error) { overlayTickets.delete(ticket); throw error; }
}

chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.type === 'PAGE_INTERACTION') {
    if (sender.tab && Number.isInteger(sender.tab.id)) {
      const state = store[sender.tab.id];
      if (state) state.autoDismissed = false;
    }
    sendResponse({ok:true});
    return false;
  }
  if (msg.type === 'ACTIVE_FID') {
    if (sender.tab && Number.isInteger(sender.tab.id) && msg.fid) {
      promoteActiveFid(sender.tab.id, msg.fid);
    }
    sendResponse({ok:true});
    return false;
  }
  if (msg.type === 'ACTIVE_VIDEO') {
    if (sender.tab && Number.isInteger(sender.tab.id) && msg.url) {
      const state = store[sender.tab.id];
      if (state) {
        const vidId = getVideoId(msg.url);
        if (vidId && state.dismissedVideoId && vidId !== state.dismissedVideoId) {
          state.autoDismissed = false;
          state.dismissedVideoId = null;
        }
      }
      addActiveUrl(sender.tab.id, msg.url, true);
    }
    sendResponse({ok:true});
    return false;
  }
  if (msg.type === 'AUTO_READY') {
    if (sender.tab && sender.frameId === 0) notifyAutomaticVideo(sender.tab.id);
    sendResponse({ok:true});
    return false;
  }
  if (msg.type === 'GET_AUTO_VIDEO') {
    const state = store[sender.tab?.id];
    const ownFrame = typeof sender.url === 'string' && sender.url.split('?')[0] === chrome.runtime.getURL('auto-prompt.html');
    if (state && ownFrame && sender.frameId > 0 && typeof msg.ticket === 'string' && state.autoTicket === msg.ticket && !state.autoDismissed) {
      const autoUrl = automaticVideo(state);
      const activeId = state.activeUrl ? getVideoId(state.activeUrl) : '';
      const eligible = state.urls.filter(url => state.scores[url] >= 0 && state.verified?.[url] !== false);
      const activeEligible = activeId ? eligible.filter(url => getVideoId(url) === activeId) : eligible;
      const targetUrls = (activeId && activeEligible.length) ? activeEligible : eligible;
      const verifiedUrls = targetUrls.filter(url => state.verified?.[url] === true);
      sendResponse({
        url: autoUrl,
        urls: verifiedUrls.length ? verifiedUrls : targetUrls,
        qualities: state.qualities || {}
      });
    } else sendResponse({error:'Prompt no longer available'});
    return false;
  }
  if (msg.type === 'GET_FALLBACK_URLS') {
    const current = CleanPlayDetector.normalize(msg.url);
    const fallbacks = [];
    for (const state of Object.values(store)) {
      if (!state || !Array.isArray(state.urls)) continue;
      if (!current || state.urls.includes(current)) {
        for (const u of state.urls) {
          if (u !== current && state.scores[u] >= 0 && state.verified?.[u] !== false && !fallbacks.includes(u)) {
            fallbacks.push(u);
          }
        }
      }
    }
    sendResponse({ urls: fallbacks });
    return false;
  }
  if (msg.type === 'AUTO_DISMISS') {
    if (sender.tab && sender.frameId === 0) dismissAutomaticVideo(sender.tab.id);
    sendResponse({ok:true});
    return false;
  }
  if (msg.type === 'AUTO_PLAY') {
    // The top content script forwards clicks only from its own extension-origin prompt frame.
    // Carry the displayed URL so a sleeping/restarted worker cannot lose an already found video.
    const url = CleanPlayDetector.normalize(msg.url);
    if (!sender.tab || sender.frameId !== 0 || !url) {
      sendResponse({error:'Invalid video'});
      return false;
    }
    const tabId = sender.tab.id;
    const createOpts = { url: chrome.runtime.getURL('player.html') + '?src=' + encodeURIComponent(url) };
    if (Number.isInteger(sender.tab.windowId)) createOpts.windowId = sender.tab.windowId;
    const action = msg.newTab === true
      ? chrome.tabs.create(createOpts).then(() => ({ok:true}))
      : openOverlay(tabId,url);
    action.then(result => {
      dismissAutomaticVideo(tabId);
      sendResponse(result);
    }, () => sendResponse({error:'Could not open player'}));
    return true;
  }
  if (msg.type === 'DISCOVERED_URLS') {
    // Content scripts cannot choose another tab or invoke player/download actions.
    if (sender.tab && Number.isInteger(sender.tab.id)) addUrls(sender.tab.id, msg.urls);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'CLAIM_OVERLAY') {
    // Only our own overlay page, embedded as a child frame of the tab the ticket was issued for.
    const entry = overlayTickets.get(msg.ticket);
    const ownFrame = typeof sender.url === 'string' && sender.url.split('?')[0] === overlayPage();
    if (entry && ownFrame && sender.tab?.id === entry.tabId && sender.frameId > 0) sendResponse({url:entry.url});
    else sendResponse({error:'Open the player from CleanPlay again.'});
    return false;
  }
  if (msg.type === 'RELEASE_OVERLAY') {
    // Sent by the mount function in the page's top frame when the overlay closes.
    const entry = overlayTickets.get(msg.ticket);
    if (entry && sender.tab?.id === entry.tabId && sender.frameId === 0) overlayTickets.delete(msg.ticket);
    sendResponse({ok:true});
    return false;
  }
  if (sender.tab && msg.type !== 'DOWNLOAD') return false;

  if (msg.type === 'GET_URLS') {
    const state = store[msg.tabId] || { urls: [], scores: {} };
    sendResponse(state);
    return false;
  }

  if (msg.type === 'ADD_URLS') {
    addUrls(msg.tabId, msg.urls);
    sendResponse(store[msg.tabId] || { urls: [], scores: {} });
    return false;
  }

  if (msg.type === 'SCAN_PAGE') {
    scanPage(msg.tabId).then(sendResponse, () => sendResponse({
      error: 'Cannot scan this page. Open a regular video website and refresh it.',
      ...(store[msg.tabId] || { urls: [], scores: {} })
    }));
    return true;
  }

  if (msg.type === 'INJECT') {
    openOverlay(msg.tabId, msg.url).then(sendResponse, () => sendResponse({error:'Cannot open the on-page player. Use Play in new tab.'}));
    return true;
  }

  if (msg.type === 'DOWNLOAD') {
    const url = msg.url || '';
    const path = url.toLowerCase().split('?')[0];
    if (path.indexOf('.m3u8') !== -1 || CleanPlayDetector.isHls(url)) {
      // Streams need the player tab's segment stitcher
      const createOpts = { url: chrome.runtime.getURL('player.html') + '?src=' + encodeURIComponent(url) + '&dl=1' };
      if (Number.isInteger(sender.tab?.windowId)) createOpts.windowId = sender.tab.windowId;
      chrome.tabs.create(createOpts);
    } else {
      let name = 'cleanplay-' + Date.now() + '.mp4';
      try {
        const p = new URL(url).pathname.split('/').pop();
        if (p && /\.(mp4|webm|mkv)$/i.test(p)) name = p;
      } catch (e) {}
      chrome.downloads.download({ url: url, filename: name });
    }
  }
  return true;
});
