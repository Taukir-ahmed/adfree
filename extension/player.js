// player.js - CleanPlay v3
// Plays direct files + HLS (via hls.js), downloads both.
// HLS download = fetch every segment, stitch into one file.

var v = document.getElementById('v');
var input = document.getElementById('urlInput');
var msg = document.getElementById('msg');
var btnDl = document.getElementById('btnDl');
var dlBox = document.getElementById('dlBox');
var dlFill = document.getElementById('dlFill');
var dlMsg = document.getElementById('dlMsg');
var qualityInfo = document.getElementById('qualityInfo');
var hls = null;
var downloading = false;
var triedUrls = new Set();

function needsCredentials(url) {
  try {
    return !!globalThis.CleanPlayDetector?.isTeraBoxHost?.(new URL(url).hostname);
  } catch (_) { return false; }
}

function getType(url) {
  if (globalThis.CleanPlayDetector?.isHls?.(url)) return 'm3u8';
  var u = url.toLowerCase().split('?')[0];
  if (u.indexOf('.m3u8') !== -1 || /[?&]type=m3u8_(?!mp3)/i.test(url)) return 'm3u8';
  if (u.indexOf('.webm') !== -1) return 'webm';
  if (u.indexOf('.mkv') !== -1) return 'mkv';
  return 'mp4';
}

function updateQualityInfo() {
  const current = v.videoWidth && v.videoHeight ? v.videoWidth + ' × ' + v.videoHeight : '';
  if (hls) {
    const levels = (hls.levels || []).filter(level => level.width > 0 && level.height > 0);
    const highest = levels.reduce((best, level) =>
      !best || level.width * level.height > best.width * best.height ? level : best, null);
    qualityInfo.textContent = (current ? 'Playing: ' + current : 'Waiting for video resolution') +
      ' • Auto quality' +
      (highest ? ' • Highest listed: ' + highest.width + ' × ' + highest.height : '');
  } else {
    qualityInfo.textContent = current ? 'Playing: ' + current + ' • Source quality (no re-encoding)' : 'Waiting for video resolution';
  }
}

function showPlaybackError() {
  qualityInfo.textContent = 'Quality unavailable — video could not be loaded.';
  msg.textContent = 'The stream could not be loaded. Its link may have expired or require playback on the source website.';
  msg.style.display = 'block';
}

function handlePlaybackFailure() {
  var current = (input && input.value && input.value.trim()) || v.src || '';
  if (current) triedUrls.add(current);
  if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function' && current) {
    try {
      chrome.runtime.sendMessage({ type: 'GET_FALLBACK_URLS', url: current }, function(res) {
        var list = (res && Array.isArray(res.urls)) ? res.urls : [];
        var next = list.find(function(u) { return u && !triedUrls.has(u); });
        if (next) {
          triedUrls.add(next);
          input.value = next;
          if (document.documentElement?.dataset.mode !== 'overlay' && typeof history !== 'undefined') {
            try { history.replaceState(null, '', '?src=' + encodeURIComponent(next)); } catch (_) {}
          }
          loadVideo(next);
          return;
        }
        showPlaybackError();
      });
      return;
    } catch (_) {}
  }
  showPlaybackError();
}

v.addEventListener('loadedmetadata', updateQualityInfo);
v.addEventListener('resize', updateQualityInfo);
v.addEventListener('error', handlePlaybackFailure);

function loadVideo(url) {
  if (url) triedUrls.add(url);
  if (globalThis.CleanPlayDetector?.isWatchPage(url)) {
    if (hls) { hls.destroy(); hls = null; }
    v.pause();
    v.removeAttribute('src');
    v.load();
    qualityInfo.textContent = 'This is a watch-page link, not a video file.';
    msg.textContent = 'Return to the source page, refresh it, and choose a newly detected media link.';
    msg.style.display = 'block';
    return;
  }
  v.style.display = 'block';
  msg.style.display = 'none';
  qualityInfo.textContent = 'Loading quality information…';
  if (hls) { hls.destroy(); hls = null; }
  if (getType(url) === 'm3u8' && window.Hls && Hls.isSupported()) {
    hls = new Hls(needsCredentials(url) ? { xhrSetup: function(xhr) { xhr.withCredentials = true; } } : undefined);
    hls.loadSource(url);
    hls.attachMedia(v);
    hls.on(Hls.Events.MANIFEST_PARSED, function() { updateQualityInfo(); v.play().catch(function() {}); });
    hls.on(Hls.Events.ERROR, function(event, data) { if (data.fatal) handlePlaybackFailure(); });
  } else {
    v.src = url;
    v.play().catch(function() {});
  }
  document.title = 'CleanPlay – Playing';
}

function play() {
  var url = input.value.trim();
  if (!url) return;
  loadVideo(url);
  history.replaceState(null, '', '?src=' + encodeURIComponent(url));
}

function copy() {
  navigator.clipboard.writeText(input.value.trim() || v.src || '');
}

// ── download ─────────────────────────────────────────────
function baseName(url, ext) {
  try {
    var parsed = new URL(url);
    var p = parsed.pathname.split('/').pop() || '';
    if (p === 'streaming' && /^\d+$/.test(parsed.searchParams.get('fid') || '')) {
      return 'terabox-' + parsed.searchParams.get('fid') + '.' + ext;
    }
    p = p.replace(/\.(m3u8|mp4|webm|mkv|ts)$/i, '');
    if (p && /^[\w.-]{1,80}$/.test(p)) return p + '.' + ext;
  } catch (e) {}
  return 'cleanplay-' + Date.now() + '.' + ext;
}

function saveBlob(blob, filename) {
  var blobUrl = URL.createObjectURL(blob);
  chrome.downloads.download({ url: blobUrl, filename: filename }, function() {
    setTimeout(function() { URL.revokeObjectURL(blobUrl); }, 60000);
  });
}

function setProgress(pct, text) {
  dlBox.classList.add('show');
  dlFill.style.width = pct + '%';
  dlMsg.textContent = text;
}

function startDownload() {
  var url = input.value.trim();
  if (!url || downloading) return;
  var type = getType(url);
  if (type === 'm3u8') {
    hlsDownload(url);
  } else {
    chrome.downloads.download({ url: url, filename: baseName(url, type) });
    setProgress(100, 'Download started — check your Downloads bar.');
  }
}

// Fetch + stitch an HLS stream into one playable file
async function hlsDownload(url) {
  downloading = true;
  btnDl.disabled = true;
  try {
    setProgress(0, 'Fetching playlist…');
    var fetchOpts = needsCredentials(url) ? { credentials: 'include' } : undefined;
    var text = await (await fetch(url, fetchOpts)).text();

    // Master playlist? Pick the highest-bandwidth variant.
    if (text.indexOf('#EXT-X-STREAM-INF') !== -1) {
      var lines = text.split(/\r?\n/);
      var best = null, bestBw = -1;
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].indexOf('#EXT-X-STREAM-INF') === 0) {
          var bw = parseInt((lines[i].match(/BANDWIDTH=(\d+)/) || [])[1] || '0', 10);
          for (var j = i + 1; j < lines.length; j++) {
            var l = lines[j].trim();
            if (l && l.charAt(0) !== '#') {
              if (bw >= bestBw) { bestBw = bw; best = l; }
              break;
            }
          }
        }
      }
      if (!best) throw new Error('No quality variant found in playlist');
      url = new URL(best, url).href;
      setProgress(0, 'Fetching quality playlist…');
      text = await (await fetch(url, needsCredentials(url) ? { credentials: 'include' } : undefined)).text();
    }

    // Parse media playlist: segments, init map, encryption keys
    var plines = text.split(/\r?\n/);
    var segs = [];
    var mapUri = null;
    var curKey = null;
    var mediaSeq = 0;
    var isLive = text.indexOf('#EXT-X-ENDLIST') === -1;
    for (var k = 0; k < plines.length; k++) {
      var ln = plines[k].trim();
      if (!ln) continue;
      if (ln.indexOf('#EXT-X-MEDIA-SEQUENCE:') === 0) {
        mediaSeq = parseInt(ln.split(':')[1], 10) || 0;
      } else if (ln.indexOf('#EXT-X-KEY:') === 0) {
        var method = (ln.match(/METHOD=([^,]+)/) || [])[1] || '';
        if (method === 'NONE') curKey = null;
        else curKey = {
          method: method,
          uri: (ln.match(/URI="([^"]+)"/) || [])[1],
          ivHex: (ln.match(/IV=0x([0-9a-fA-F]+)/) || [])[1] || null
        };
      } else if (ln.indexOf('#EXT-X-MAP:') === 0) {
        mapUri = (ln.match(/URI="([^"]+)"/) || [])[1];
      } else if (ln.charAt(0) !== '#') {
        segs.push({ uri: new URL(ln, url).href, key: curKey, seq: mediaSeq + segs.length });
      }
    }
    if (segs.length === 0) throw new Error('No segments found in playlist');
    for (var s = 0; s < segs.length; s++) {
      if (segs[s].key && segs[s].key.method !== 'AES-128') {
        throw new Error(segs[s].key.method + ' encryption (DRM) — cannot download');
      }
    }

    var fmp4 = !!mapUri || /\.m4s(\?|$)/i.test(segs[0].uri);
    var parts = [];
    if (mapUri) {
      setProgress(0, 'Fetching init segment…');
      parts.push(await (await fetch(new URL(mapUri, url).href)).arrayBuffer());
    }

    // Raw TS segments get remuxed into a real MP4 container (repackaging only, no re-encoding)
    var mx = null, mp4Parts = [], mxGotInit = false;
    if (!fmp4 && window.muxjs) {
      mx = new muxjs.mp4.Transmuxer();
      mx.on('data', function(out) {
        if (!mxGotInit && out.initSegment) { mp4Parts.push(out.initSegment); mxGotInit = true; }
        mp4Parts.push(out.data);
      });
    }

    // Cache decryption keys by URI
    var keyCache = {};
    async function getKey(keyUri) {
      var abs = new URL(keyUri, url).href;
      if (!keyCache[abs]) {
        var raw = await (await fetch(abs)).arrayBuffer();
        keyCache[abs] = await crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt']);
      }
      return keyCache[abs];
    }

    function ivFor(seg) {
      var iv = new Uint8Array(16);
      if (seg.key.ivHex) {
        var h = seg.key.ivHex.padStart(32, '0');
        for (var b = 0; b < 16; b++) iv[b] = parseInt(h.substr(b * 2, 2), 16);
      } else {
        // Default IV = segment media sequence number, big-endian
        var n = seg.seq;
        for (var b2 = 15; b2 >= 12; b2--) { iv[b2] = n & 0xff; n = Math.floor(n / 256); }
      }
      return iv;
    }

    for (var idx = 0; idx < segs.length; idx++) {
      var seg = segs[idx];
      var buf = await (await fetch(seg.uri)).arrayBuffer();
      if (seg.key) {
        buf = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivFor(seg) }, await getKey(seg.key.uri), buf);
      }
      if (mx) {
        mx.push(new Uint8Array(buf));
        mx.flush();
        // Keep raw TS as fallback until the remuxer proves it can read this stream
        if (!mxGotInit) parts.push(buf);
      } else {
        parts.push(buf);
      }
      var pct = Math.round(((idx + 1) / segs.length) * 100);
      setProgress(pct, 'Downloading segment ' + (idx + 1) + ' of ' + segs.length + '…' + (isLive ? ' (live stream — saving what is available)' : ''));
    }

    var remuxed = mxGotInit && mp4Parts.length > 0;
    var useMp4 = fmp4 || remuxed;
    var ext = useMp4 ? 'mp4' : 'ts';
    var blob = new Blob(remuxed ? mp4Parts : parts, { type: useMp4 ? 'video/mp4' : 'video/mp2t' });
    saveBlob(blob, baseName(url, ext));
    setProgress(100, '✓ Saved as .' + ext + ' (' + (blob.size / 1048576).toFixed(1) + ' MB)' +
      (useMp4 ? '' : ' — remux failed for this stream; .ts plays in VLC'));
  } catch (e) {
    setProgress(0, '✗ Download failed: ' + e.message);
  }
  downloading = false;
  btnDl.disabled = false;
}

// ── init ─────────────────────────────────────────────────
document.getElementById('btnPlay').addEventListener('click', play);
document.getElementById('btnCopy').addEventListener('click', copy);
btnDl.addEventListener('click', startDownload);
input.addEventListener('keydown', function(e) { if (e.key === 'Enter') play(); });

var params = new URLSearchParams(location.search);
if (document.documentElement?.dataset.mode === 'overlay') {
  // A web-accessible page cannot accept arbitrary source/download query parameters.
  v.style.display = 'none';
  input.disabled = true;
  var ticket = params.get('ticket');
  // Set by the mount function when the page forced a reload of this frame.
  var startAt = Number(params.get('t'));
  if (!(startAt > 0) || !isFinite(startAt)) startAt = 0;
  // Messages to the parent are readable by the page, so they never carry the ticket.
  function closeOverlay() { window.parent.postMessage({type:'__CLEANPLAY_CLOSE_OVERLAY__'}, '*'); }
  document.getElementById('btnClose').addEventListener('click', closeOverlay);
  document.addEventListener('keydown', function(event) { if (event.key === 'Escape') closeOverlay(); });
  var reported = -1;
  v.addEventListener('timeupdate', function() {
    var time = Math.floor(v.currentTime);
    if (time === reported) return;
    reported = time;
    window.parent.postMessage({type:'__CLEANPLAY_PROGRESS__', time: time}, '*');
  });
  chrome.runtime.sendMessage({type:'CLAIM_OVERLAY',ticket:ticket}, function(result) {
    if (chrome.runtime.lastError || !result || !result.url) {
      msg.textContent = 'Open this player using CleanPlay’s on-page play button.';
      return;
    }
    input.value = result.url;
    if (startAt) v.addEventListener('loadedmetadata', function() { v.currentTime = startAt; }, {once:true});
    loadVideo(result.url);
  });
} else {
  var src = params.get('src');
  if (src) {
    input.value = src;
    loadVideo(src);
    if (params.get('dl') === '1') startDownload();
  } else {
    v.style.display = 'none';
  }
}
