// ==UserScript==
// @name         CleanPlay Mobile & Desktop
// @namespace    https://github.com/Taukir-ahmed/adfree
// @version      1.0
// @description  Ad-free video player for TeraBox, Streamtape, and video streaming sites on Mobile (Safari/Chrome) and Desktop
// @author       CleanPlay
// @match        *://*.terabox.app/*
// @match        *://*.1024terabox.com/*
// @match        *://*.terasharelink.com/*
// @match        *://*.freeterabox.com/*
// @match        *://*.4funbox.com/*
// @match        *://*.mirrobox.com/*
// @match        *://*.nephobox.com/*
// @match        *://*.streamtape.com/*
// @match        *://*.streamta.pe/*
// @match        *://*.strcloud.link/*
// @match        *://*.strtape.cloud/*
// @match        *://*.streamtape.net/*
// @match        *://*.streamtape.to/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function() {
  'use strict';

  if (window.top !== window) return; // Only run in top frame

  const TERABOX_HOST = /(?:^|\.)(?:1024tera(?:box)?|freeterabox|terabox(?:app|link|share|dl)?|terashare(?:link|file)?|terafileshare|4funbox|mirrobox|nephobox|momerybox|tibibox|dubox)\.[a-z.]+$/i;
  const STREAMTAPE_HOST = /(?:^|\.)(?:streamtape|strtape|strtpe|strcloud|tapecontent|streamta\.pe)\.[a-z.]+$/i;

  let discoveredVideos = [];
  let activeIndex = 0;
  let overlayDialog = null;
  let floatingBtn = null;

  function formatBytes(bytes) {
    if (!bytes || isNaN(bytes)) return '';
    const num = Number(bytes);
    if (num < 1024) return num + ' B';
    if (num < 1024 * 1024) return (num / 1024).toFixed(1) + ' KB';
    if (num < 1024 * 1024 * 1024) return (num / (1024 * 1024)).toFixed(1) + ' MB';
    return (num / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  // --- TeraBox Scanner ---
  function scanTeraBox() {
    const found = [];
    const states = [window.locals, window.templateData, window.yunData, window.__INITIAL_STATE__];

    for (const state of states) {
      if (!state || typeof state !== 'object') continue;
      const uk = state.uk || state.share_uk;
      const shareid = state.shareid || state.share_id;
      const sign = state.sign || state.download_sign;
      const timestamp = state.timestamp;
      const jsToken = window.jsToken || state.jsToken;

      let list = state.file_list || state.list;
      if (list && !Array.isArray(list)) list = list.list;
      if (!Array.isArray(list)) continue;

      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        if (Number(item.isdir) === 1) continue;
        const fid = String(item.fs_id || item.fid || '');
        const name = String(item.server_filename || item.path || ('Video ' + fid));
        const isVideo = String(item.category) === '1' || /\.(mp4|m3u8|webm|mkv|mov|avi|m4v|flv|ts)$/i.test(name);
        if (!isVideo || !fid || !uk || !shareid) continue;

        const qualities = {};
        for (const type of ['M3U8_AUTO_1080', 'M3U8_AUTO_720', 'M3U8_AUTO_480', 'M3U8_FLV_264_480', 'M3U8_AUTO_360']) {
          const qName = type.match(/(\d{3,4})$/)?.[1] ? type.match(/(\d{3,4})$/)[1] + 'p' : 'Auto';
          const stream = new URL('/share/streaming', window.location.origin);
          stream.searchParams.set('uk', String(uk));
          stream.searchParams.set('shareid', String(shareid));
          stream.searchParams.set('type', type);
          stream.searchParams.set('fid', fid);
          if (sign) stream.searchParams.set('sign', String(sign));
          if (timestamp) stream.searchParams.set('timestamp', String(timestamp));
          if (jsToken) stream.searchParams.set('jsToken', String(jsToken));
          stream.searchParams.set('app_id', '250528');
          stream.searchParams.set('web', '1');
          stream.searchParams.set('clienttype', '0');
          stream.searchParams.set('channel', 'dubox');
          qualities[qName] = stream.href;
        }

        found.push({
          fid,
          title: name,
          size: formatBytes(item.size),
          qualities,
          defaultUrl: qualities['720p'] || qualities['480p'] || Object.values(qualities)[0]
        });
      }
    }
    return found;
  }

  // --- Streamtape Scanner ---
  function scanStreamtape() {
    const found = [];
    const scriptRegex = /(?:robotlink|videolink|norobotlink|ideoolink|ideoooolink)\S*\.innerHTML\s*=\s*(['"][^'"]*['"](?:\s*\+\s*(?:['"][^'"]*['"]|\([^\)]+\)(?:\.substring\(\d+\))*))+)/gi;
    const html = document.documentElement ? document.documentElement.innerHTML : '';
    let videoUrl = '';

    for (const m of html.matchAll(scriptRegex)) {
      try {
        const evaluated = eval(m[1]);
        if (typeof evaluated === 'string' && evaluated.includes('get_video')) {
          videoUrl = evaluated.startsWith('//') ? 'https:' + evaluated : evaluated;
          break;
        }
      } catch (_) {}
    }

    if (!videoUrl) {
      for (const id of ['robotlink', 'videolink', 'ideoolink', 'norobotlink']) {
        const el = document.getElementById(id);
        const text = el ? (el.textContent || '').trim() : '';
        if (text && text.includes('get_video')) {
          videoUrl = text.startsWith('//') ? 'https:' + text : text;
          break;
        }
      }
    }

    if (videoUrl) {
      if (!videoUrl.includes('stream=')) videoUrl += (videoUrl.includes('?') ? '&' : '?') + 'stream=1';
      const title = (document.title || 'Streamtape Video').replace(/\s*-\s*Streamtape.*$/i, '').trim();
      found.push({
        fid: 'streamtape',
        title,
        size: '',
        qualities: { 'HD': videoUrl },
        defaultUrl: videoUrl
      });
    }

    return found;
  }

  function scan() {
    let videos = [];
    if (TERABOX_HOST.test(window.location.hostname)) {
      videos = scanTeraBox();
    } else if (STREAMTAPE_HOST.test(window.location.hostname)) {
      videos = scanStreamtape();
    }

    // Generic HTML5 video detection fallback
    if (!videos.length) {
      document.querySelectorAll('video, source').forEach(el => {
        const src = el.currentSrc || el.src;
        if (src && !src.startsWith('blob:') && !src.startsWith('data:') && !videos.some(v => v.defaultUrl === src)) {
          videos.push({
            fid: 'video',
            title: document.title || 'Video',
            size: '',
            qualities: { 'Direct': src },
            defaultUrl: src
          });
        }
      });
    }

    if (videos.length) {
      discoveredVideos = videos;
      showFloatingButton(videos.length);
    }
  }

  // --- Floating "CleanPlay" Button on Page ---
  function showFloatingButton(count) {
    if (floatingBtn) {
      floatingBtn.textContent = count > 1 ? `⚡ CleanPlay (${count} videos)` : '⚡ Play Clean';
      return;
    }

    floatingBtn = document.createElement('button');
    floatingBtn.id = '__cleanplay_mobile_btn__';
    floatingBtn.textContent = count > 1 ? `⚡ CleanPlay (${count} videos)` : '⚡ Play Clean';
    floatingBtn.style.cssText = `
      position: fixed !important;
      bottom: 24px !important;
      right: 20px !important;
      z-index: 2147483647 !important;
      background: linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%) !important;
      color: #ffffff !important;
      border: 1px solid rgba(255,255,255,0.3) !important;
      border-radius: 30px !important;
      padding: 12px 20px !important;
      font-size: 15px !important;
      font-weight: 700 !important;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
      box-shadow: 0 8px 24px rgba(109, 40, 217, 0.6) !important;
      cursor: pointer !important;
      display: flex !important;
      align-items: center !important;
      gap: 8px !important;
      transform: scale(1) !important;
      transition: transform 0.2s ease !important;
    `;

    floatingBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPlayer(0);
    });

    document.documentElement.appendChild(floatingBtn);
  }

  // --- Clean Fullscreen Video Player ---
  function openPlayer(index) {
    activeIndex = index;
    const videoData = discoveredVideos[index];
    if (!videoData) return;

    // Pause all page videos and ads
    try {
      document.querySelectorAll('video, audio').forEach(el => { try { el.pause(); } catch (_) {} });
    } catch (_) {}

    if (overlayDialog) {
      overlayDialog.remove();
    }

    overlayDialog = document.createElement('div');
    overlayDialog.id = '__cleanplay_overlay__';
    overlayDialog.style.cssText = `
      position: fixed !important;
      inset: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      background: #000000 !important;
      z-index: 2147483647 !important;
      display: flex !important;
      flex-direction: column !important;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
      color: #ffffff !important;
      overflow: hidden !important;
    `;

    // Header
    const header = document.createElement('div');
    header.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      background: rgba(20, 15, 30, 0.9);
      border-bottom: 1px solid rgba(139, 92, 246, 0.3);
      z-index: 2;
    `;

    const titleDiv = document.createElement('div');
    titleDiv.style.cssText = 'font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: calc(100vw - 120px);';
    titleDiv.textContent = videoData.title;

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕ Close';
    closeBtn.style.cssText = `
      background: rgba(255, 255, 255, 0.15);
      border: 1px solid rgba(255, 255, 255, 0.3);
      color: #ffffff;
      padding: 6px 12px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    `;
    closeBtn.addEventListener('click', () => {
      overlayDialog.remove();
      overlayDialog = null;
    });

    header.appendChild(titleDiv);
    header.appendChild(closeBtn);
    overlayDialog.appendChild(header);

    // Video Player Container
    const playerWrapper = document.createElement('div');
    playerWrapper.style.cssText = 'flex: 1; display: flex; align-items: center; justify-content: center; background: #000; position: relative;';

    const videoEl = document.createElement('video');
    videoEl.controls = true;
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    videoEl.style.cssText = 'width: 100%; height: 100%; max-height: 100%; object-fit: contain;';
    videoEl.src = videoData.defaultUrl;

    playerWrapper.appendChild(videoEl);
    overlayDialog.appendChild(playerWrapper);

    // Folder playlist drawer if multiple videos
    if (discoveredVideos.length > 1) {
      const playlistDrawer = document.createElement('div');
      playlistDrawer.style.cssText = `
        max-height: 220px;
        overflow-y: auto;
        background: #120c1f;
        border-top: 1px solid rgba(139, 92, 246, 0.3);
        padding: 8px;
      `;

      discoveredVideos.forEach((v, i) => {
        const item = document.createElement('div');
        item.style.cssText = `
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 12px;
          margin-bottom: 6px;
          border-radius: 8px;
          background: ${i === activeIndex ? 'rgba(139, 92, 246, 0.3)' : 'rgba(255, 255, 255, 0.05)'};
          border: 1px solid ${i === activeIndex ? '#8b5cf6' : 'transparent'};
          cursor: pointer;
        `;
        item.innerHTML = `
          <span style="font-size: 12px; color: ${i === activeIndex ? '#8b5cf6' : '#888'}; width: 18px;">${i + 1}</span>
          <div style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px;">${v.title}</div>
          <span style="font-size: 11px; color: #aaa;">${v.size || ''}</span>
        `;
        item.addEventListener('click', () => {
          openPlayer(i);
        });
        playlistDrawer.appendChild(item);
      });

      overlayDialog.appendChild(playlistDrawer);

      // Auto play next video in folder when ended
      videoEl.addEventListener('ended', () => {
        if (activeIndex < discoveredVideos.length - 1) {
          openPlayer(activeIndex + 1);
        }
      });
    }

    document.documentElement.appendChild(overlayDialog);
    videoEl.play().catch(() => {});
  }

  // Periodic scanner
  let attempts = 0;
  const timer = setInterval(() => {
    scan();
    if (++attempts >= 20 && discoveredVideos.length) clearInterval(timer);
  }, 1000);

  document.addEventListener('DOMContentLoaded', scan);
  window.addEventListener('load', scan);
  window.addEventListener('message', scan);
})();
