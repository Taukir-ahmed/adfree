// Read existing player state in the page's JS world, without triggering playback.
(function() {
  'use strict';
  if (window.__cleanPlayPageProbe) {
    window.__cleanPlayPageProbe();
    return;
  }
  function scan() {
    const found = new Set();
    const seen = new WeakSet();
    let budget = 500;
    function visit(value, depth) {
      if (--budget < 0 || depth > 6 || value == null) return;
      if (typeof value === 'string') {
        try {
          const url = new URL(value, document.baseURI);
          // The isolated detector validates these bounded source-field values.
          if (/^https?:$/.test(url.protocol) && value.length <= 16384 && found.size < 100) found.add(url.href);
        } catch (_) {}
        return;
      }
      if (typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) value.slice(0, 50).forEach(item => visit(item, depth + 1));
      else {
        // Restrict traversal to source fields, avoiding ad configurations.
        for (const key of ['file', 'src', 'sources', 'playlist', 'contentUrl', 'dlink', 'stream_url', 'fast_stream_url', 'm3u8', '1080p', '720p', '480p', '360p', 'url']) {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (descriptor && 'value' in descriptor) visit(descriptor.value, depth + 1);
        }
      }
    }
    function readField(obj, ...keys) {
      if (!obj || typeof obj !== 'object') return null;
      for (const key of keys) {
        try {
          if (typeof obj.get === 'function') {
            const val = obj.get(key);
            if (val != null && val !== '') return val;
          }
        } catch (_) {}
        const descriptor = Object.getOwnPropertyDescriptor(obj, key);
        if (descriptor && 'value' in descriptor && descriptor.value != null && descriptor.value !== '') {
          return descriptor.value;
        }
      }
      return null;
    }
    function scanTeraBox(state) {
      if (!state || typeof state !== 'object') return;
      const uk = readField(state, 'uk', 'share_uk');
      const shareid = readField(state, 'shareid', 'share_id');
      const sign = readField(state, 'sign', 'download_sign');
      const timestamp = readField(state, 'timestamp');
      const jsToken = typeof window.jsToken === 'string' && window.jsToken ? window.jsToken : readField(state, 'jsToken');
      let list = readField(state, 'file_list', 'list');
      if (list && !Array.isArray(list)) list = readField(list, 'list');
      if (!Array.isArray(list)) return;
      for (const item of list.slice(0, 50)) {
        visit(item, 0);
        if (!item || typeof item !== 'object') continue;
        if (Number(readField(item, 'isdir')) === 1) continue;
        const fid = readField(item, 'fs_id', 'fid');
        const category = readField(item, 'category');
        const name = String(readField(item, 'server_filename', 'path') || '');
        const isVideo = String(category) === '1' || /\.(mp4|m3u8|webm|mkv|mov|avi|m4v|flv|ts)$/i.test(name);
        if (!isVideo || !fid || !uk || !shareid || (!(sign && timestamp) && !jsToken)) continue;
        try {
          const stream = new URL('/share/streaming', document.baseURI);
          stream.searchParams.set('uk', String(uk));
          stream.searchParams.set('shareid', String(shareid));
          stream.searchParams.set('type', 'M3U8_AUTO_1080');
          stream.searchParams.set('fid', String(fid));
          if (sign) stream.searchParams.set('sign', String(sign));
          if (timestamp) stream.searchParams.set('timestamp', String(timestamp));
          if (jsToken) stream.searchParams.set('jsToken', String(jsToken));
          stream.searchParams.set('app_id', '250528');
          stream.searchParams.set('web', '1');
          stream.searchParams.set('clienttype', '0');
          stream.searchParams.set('channel', 'dubox');
          if (found.size < 100) found.add(stream.href);
        } catch (_) {}
      }
    }
    try {
      if (typeof window.jwplayer === 'function') {
        // The no-argument instance covers the common single-player setup.
        const players = [window.jwplayer()];
        document.querySelectorAll('.jwplayer[id]').forEach(el => {
          if (players.length < 20) players.push(window.jwplayer(el.id));
        });
        for (const player of players) {
          try {
            if (player && typeof player.getPlaylist === 'function') visit(player.getPlaylist(), 0);
          } catch (_) {}
        }
      }
    } catch (_) {}
    try {
      if (window.videojs && typeof window.videojs.getPlayers === 'function') {
        for (const player of Object.values(window.videojs.getPlayers()).slice(0, 20)) {
          try {
            if (player && typeof player.currentSources === 'function') visit(player.currentSources(), 0);
          } catch (_) {}
        }
      }
    } catch (_) {}
    try {
      for (const state of [window.locals, window.templateData, window.yunData, window.__INITIAL_STATE__]) {
        scanTeraBox(state);
        if (state && typeof state === 'object') {
          scanTeraBox(readField(state, 'shareInfo', 'fileInfo', 'data'));
        }
      }
    } catch (_) {}
    if (found.size) window.postMessage({ type: '__CLEANPLAY_PLAYER_URLS__', urls: [...found] }, '*');
  }
  window.__cleanPlayPageProbe = scan;
  try {
    const origPush = history.pushState;
    if (typeof origPush === 'function') {
      history.pushState = function() {
        const res = origPush.apply(this, arguments);
        window.postMessage({ type: '__CLEANPLAY_SCAN_PLAYERS__' }, '*');
        return res;
      };
    }
    const origReplace = history.replaceState;
    if (typeof origReplace === 'function') {
      history.replaceState = function() {
        const res = origReplace.apply(this, arguments);
        window.postMessage({ type: '__CLEANPLAY_SCAN_PLAYERS__' }, '*');
        return res;
      };
    }
  } catch (_) {}
  let scheduled = false;
  window.addEventListener('message', function(event) {
    if (event.source !== window || !event.data || event.data.type !== '__CLEANPLAY_SCAN_PLAYERS__' || scheduled) return;
    scheduled = true;
    setTimeout(function() { scheduled = false; scan(); }, 25);
  });
  // Catch asynchronous player setup without permanent polling on every website.
  let attempts = 0;
  const timer = setInterval(function() {
    scan();
    if (++attempts >= 15) clearInterval(timer);
  }, 2000);
  document.addEventListener('DOMContentLoaded', scan, { once: true });
  scan();
})();
