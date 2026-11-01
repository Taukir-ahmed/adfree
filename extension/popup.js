// popup.js - CleanPlay v3
// Auto-tests URLs and shows only the best one

var tabId = null;
var windowId = null;
var allUrls = [];
var allScores = {};
var bestUrl = null;
var allListOpen = false;
var testRun = 0;
var testingUrls = '';
var userSelectedUrl = null;

// ── helpers ──────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function toast(msg) {
  var t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(function() { t.classList.remove('show'); }, 2200);
}

function getType(url) {
  var u = url.toLowerCase();
  if (u.indexOf('.m3u8') !== -1 || /[?&]type=m3u8_(?!mp3)/.test(u)) return 'm3u8';
  if (u.indexOf('.mp4') !== -1 || /\/file\/[0-9a-f]{32}(?:$|\?)/.test(u)) return 'mp4';
  if (u.indexOf('.webm') !== -1) return 'webm';
  return 'other';
}

function shortUrl(url) {
  try {
    var u = new URL(url);
    var p = u.pathname;
    var fid = u.searchParams.get('fid');
    var type = u.searchParams.get('type');
    if (fid && /\/streaming$/i.test(p)) p += ' (' + (type || fid) + ')';
    if (p.length > 52) p = p.substring(0, 52) + '…';
    return u.hostname + p;
  } catch(e) { return url.substring(0, 55); }
}

// ── test a single URL by loading it in a hidden video ────
// Returns a promise: resolves true if it can play, false otherwise
function testUrl(url) {
  // Native Chromium video cannot verify HLS; retain it as an unverified candidate.
  if (getType(url) === 'm3u8') return Promise.resolve(null);
  return new Promise(function(resolve) {
    var v = document.createElement('video');
    v.muted = true;
    v.preload = 'metadata';
    v.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none';
    document.body.appendChild(v);

    var done = false;
    var timer = setTimeout(function() {
      if (!done) { done = true; cleanup(false); }
    }, 6000); // 6s timeout per URL

    function cleanup(result) {
      clearTimeout(timer);
      v.src = '';
      v.load();
      if (v.parentNode) v.parentNode.removeChild(v);
      resolve(result);
    }

    v.onloadedmetadata = function() {
      if (!done) { done = true; cleanup(true); }
    };

    v.oncanplay = function() {
      if (!done) { done = true; cleanup(true); }
    };

    v.onerror = function() {
      if (!done) { done = true; cleanup(false); }
    };

    v.src = url;
    v.load();
  });
}

// ── test all URLs in score order, find first that plays ──
function autoFindBest(urls) {
  var run = ++testRun;
  testingUrls = JSON.stringify(urls);
  if (!urls || urls.length === 0) {
    setBadge('No videos', false);
    return;
  }

  // If only one URL, trust it directly — no need to test
  if (urls.length === 1) {
    showBest(urls[0]);
    renderAllLinks();
    return;
  }

  // Make the leading candidate usable while optional checks run.
  showBest(urls[0]);
  setBadge('Testing…', 'testing');
  $('testProgress').classList.add('show');
  $('progressFill').style.width = '0%';
  $('testMsg').textContent = 'Testing ' + urls.length + ' URLs…';
  $('empty').style.display = 'none';

  var tested = 0;
  var found = false;

  // Test top 5 by score only (rest shown in "all links")
  var toTest = urls.slice(0, 5);

  function testNext(i) {
    if (run !== testRun) return;
    if (found || i >= toTest.length) {
      $('testProgress').classList.remove('show');
      if (!found) {
        // Nothing played — just show highest scored without testing
        showBest(urls[0]);
        toast('Could not verify — showing best guess');
      }
      renderAllLinks();
      return;
    }

    var url = toTest[i];
    $('testMsg').textContent = 'Testing ' + (i + 1) + ' of ' + toTest.length + '…';
    $('progressFill').style.width = Math.round(((i + 1) / toTest.length) * 100) + '%';

    testUrl(url).then(function(plays) {
      if (run !== testRun) return;
      tested++;
      if (plays !== false && !found) {
        found = true;
        $('testProgress').classList.remove('show');
        showBest(url);
        renderAllLinks();
        toast(plays ? '✓ Video verified' : 'HLS stream found');
      } else {
        testNext(i + 1);
      }
    });
  }

  testNext(0);
}

function showBest(url) {
  $('testProgress').classList.remove('show');
  bestUrl = url;
  var type = getType(url);

  $('bestCard').classList.add('show');
  $('empty').style.display = 'none';
  $('bestType').className = 'tag-' + type;
  $('bestType').textContent = type.toUpperCase();
  $('bestUrl').textContent = shortUrl(url);

  setBadge('Link found ✓', true);
}

function setBadge(text, state) {
  var b = $('badge');
  b.textContent = text;
  b.className = state === true ? 'has' : state === 'testing' ? 'testing' : '';
}

function renderAllLinks() {
  var sec = $('allSection');
  var list = $('allList');
  list.innerHTML = '';

  if (allUrls.length <= 1) { sec.style.display = 'none'; return; }
  sec.style.display = 'block';

  $('allToggle').textContent = (allListOpen ? '▼' : '▶') + ' All detected links (' + allUrls.length + ')';

  allUrls.forEach(function(url, i) {
    var type = getType(url);
    var score = allScores[url] || 0;
    var card = document.createElement('div');
    card.className = 'mini-card';
    card.title = url;
    card.innerHTML =
      '<span class="mini-tag tag-' + type + '">' + type.toUpperCase() + '</span>' +
      '<span class="mini-url"></span>' +
      '<span class="mini-score">score:' + score + '</span>';
    card.querySelector('.mini-url').textContent = shortUrl(url);
    card.addEventListener('click', function() {
      testRun++;
      userSelectedUrl = url;
      $('testProgress').classList.remove('show');
      showBest(url);
      toast('Switched to this URL');
    });
    list.appendChild(card);
  });
}

// Keep the popup current while lazy players and embedded frames initialize.
var scanning = false;
function applyResults(res) {
  var urls = res && Array.isArray(res.urls) ? res.urls : [];
  var changed = JSON.stringify(urls) !== JSON.stringify(allUrls);
  allUrls = urls;
  allScores = res && res.scores ? res.scores : {};
  renderAllLinks();
  if (!urls.length) {
    testRun++;
    testingUrls = '';
    userSelectedUrl = null;
    bestUrl = null;
    $('bestCard').classList.remove('show');
    $('testProgress').classList.remove('show');
    $('empty').style.display = 'block';
    if (!scanning) setBadge('No link found yet', false);
  } else if (changed || (!bestUrl && testingUrls !== JSON.stringify(urls))) {
    // Preserve explicit choices, but promote better automatic candidates.
    if (userSelectedUrl && urls.includes(userSelectedUrl)) showBest(userSelectedUrl);
    else autoFindBest(urls);
  }
}

var loading = false;
var scanRun = 0;
function load() {
  if (tabId === null || loading) return;
  loading = true;
  var finished = false;
  var timer = setTimeout(function() { finished = true; loading = false; }, 3000);
  chrome.runtime.sendMessage({ type: 'GET_URLS', tabId: tabId }, function(res) {
    var error = chrome.runtime.lastError;
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    loading = false;
    // A missing response is not an empty result: retain the displayed links.
    if (error || !res || !Array.isArray(res.urls)) return;
    applyResults(res);
  });
}

function deepScan() {
  if (tabId === null || scanning) return;
  scanning = true;
  var run = ++scanRun;
  $('btnScan').disabled = true;
  if (!bestUrl) setBadge('Scanning frames…', 'testing');
  load();
  function finish(partial) {
    if (run !== scanRun || !scanning) return;
    scanning = false;
    clearTimeout(timer);
    $('btnScan').disabled = false;
    if (bestUrl) setBadge('Link found ✓', true);
    else setBadge(partial ? 'Scan incomplete' : 'No link found yet', false);
    // Read current data, not a scan snapshot that may already be out of date.
    load();
  }
  // Also recover if the service-worker message itself never gets a response.
  var timer = setTimeout(function() { finish(true); }, 4500);
  chrome.runtime.sendMessage({ type: 'SCAN_PAGE', tabId: tabId }, function(res) {
    var error = chrome.runtime.lastError;
    if (run !== scanRun || !scanning) return;
    finish(!!error || !res || !!res.error || !!res.partial);
  });
}

// ── event listeners ───────────────────────────────────
$('btnPlay').addEventListener('click', function() {
  if (!bestUrl) return;
  if (tabId !== null && chrome.scripting && typeof chrome.scripting.executeScript === 'function') {
    chrome.scripting.executeScript({
      target: { tabId: tabId, allFrames: true },
      func: function() { document.querySelectorAll('video, audio').forEach(function(el) { try { el.pause(); } catch (_) {} }); }
    }).catch(function() {});
  }
  var createOpts = { url: chrome.runtime.getURL('player.html') + '?src=' + encodeURIComponent(bestUrl) };
  if (Number.isInteger(windowId)) createOpts.windowId = windowId;
  chrome.tabs.create(createOpts);
  window.close();
});

$('btnDownload').addEventListener('click', function() {
  if (!bestUrl) return;
  var type = getType(bestUrl);
  if (type === 'm3u8') {
    // Streams must be stitched segment-by-segment — the player tab handles that
    var createOpts = { url: chrome.runtime.getURL('player.html') + '?src=' + encodeURIComponent(bestUrl) + '&dl=1' };
    if (Number.isInteger(windowId)) createOpts.windowId = windowId;
    chrome.tabs.create(createOpts);
    window.close();
  } else {
    var name = 'cleanplay-' + Date.now() + '.' + (type === 'other' ? 'mp4' : type);
    try {
      var p = new URL(bestUrl).pathname.split('/').pop();
      if (p && /\.(mp4|webm|mkv)$/i.test(p)) name = p;
    } catch(e) {}
    chrome.downloads.download({ url: bestUrl, filename: name }, function() {
      if (chrome.runtime.lastError) toast('Download failed: ' + chrome.runtime.lastError.message);
      else toast('Download started ⬇');
    });
  }
});

$('btnOverlay').addEventListener('click', function() {
  if (!bestUrl) return;
  $('btnOverlay').disabled = true;
  chrome.runtime.sendMessage({ type: 'INJECT', tabId: tabId, url: bestUrl }, function(result) {
    $('btnOverlay').disabled = false;
    if (chrome.runtime.lastError || !result || !result.ok) toast('Use Play in new tab for this page');
    else window.close();
  });
});

$('btnCopy').addEventListener('click', function() {
  if (!bestUrl) return;
  navigator.clipboard.writeText(bestUrl).then(function() { toast('Copied ✓'); });
});

$('btnRefresh').addEventListener('click', function() {
  userSelectedUrl = null;
  load();
  deepScan();
});

$('btnScan').addEventListener('click', deepScan);

$('allToggle').addEventListener('click', function() {
  allListOpen = !allListOpen;
  $('allList').className = allListOpen ? 'open' : '';
  $('allToggle').textContent = (allListOpen ? '▼' : '▶') + ' All detected links (' + allUrls.length + ')';
});

// ── init ──────────────────────────────────────────────
chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
  if (tabs && tabs[0]) {
    tabId = tabs[0].id;
    windowId = tabs[0].windowId;
    load();
    deepScan();
    setInterval(load, 1000);
  }
});
