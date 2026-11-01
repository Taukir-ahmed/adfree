(function() {
  'use strict';
  let url = null;
  let busy = false;
  let refreshPending = false;
  let refreshAgain = false;
  let chosen = false;
  let actionTimer;
  let qualities = {};
  const ticket = new URLSearchParams(location.search).get('ticket');
  const detail = document.getElementById('detail');
  const play = document.getElementById('play');
  const newTab = document.getElementById('newTab');
  const sources = document.getElementById('sources');
  const choices = document.getElementById('choices');
  const heading = document.getElementById('heading');
  function buttons() {
    play.disabled = newTab.disabled = busy || !url;
    sources.disabled = busy;
  }
  function describe() {
    const parsed = new URL(url);
    const isHls = parsed.pathname.toLowerCase().endsWith('.m3u8') ||
      /^m3u8_(?!mp3)/i.test(parsed.searchParams.get('type') || '');
    const type = isHls ? 'HLS stream' : 'Video';
    const quality = qualities[url] || ((parsed.searchParams.get('type') || '').match(/(\d{3,4})$/)?.[1] ? (parsed.searchParams.get('type') || '').match(/(\d{3,4})$/)[1] + 'p' : '');
    detail.textContent = (quality ? '✓ ' + quality + ' • ' : '') + type + ' • ' + parsed.hostname;
    detail.title = url;
  }
  sources.addEventListener('change', () => {
    url = sources.value;
    chosen = true;
    describe();
  });
  function refresh() {
    if (busy) return;
    if (refreshPending) { refreshAgain = true; return; }
    refreshPending = true;
    chrome.runtime.sendMessage({type:'GET_AUTO_VIDEO',ticket}, function(result) {
      refreshPending = false;
      if (chrome.runtime.lastError || !result?.url) {
        detail.textContent = 'Link unavailable. Refresh the video page.';
        return;
      }
      qualities = result.qualities || {};
      const urls = [...new Set(result.urls || [result.url])];
      if (!chosen || !urls.includes(url)) { url = result.url; chosen = false; }
      sources.replaceChildren();
      urls.forEach((value, index) => {
        const parsed = new URL(value);
        const option = document.createElement('option');
        option.value = value;
        let name = parsed.pathname.split('/').pop() || 'Video';
        try { name = decodeURIComponent(name); } catch (_) {}
        const q = qualities[value] || ((parsed.searchParams.get('type') || '').match(/(\d{3,4})$/)?.[1] ? (parsed.searchParams.get('type') || '').match(/(\d{3,4})$/)[1] + 'p' : '');
        if (name === 'get_video') name = 'Video ' + parsed.searchParams.get('id');
        else if (name === 'streaming' && parsed.searchParams.get('fid')) {
          name = 'Video ' + parsed.searchParams.get('fid') + (q ? ' (' + q + ')' : '');
        } else if (/^[0-9a-f]{32}$/i.test(name) && parsed.searchParams.get('fid')) {
          name = 'Video ' + parsed.searchParams.get('fid') + (q ? ' (' + q + ')' : '');
        } else if (q) {
          name = name + ' (' + q + ')';
        }
        option.textContent = (index + 1) + '. ' + name.slice(0, 90) + ' • ' + parsed.hostname;
        option.title = value;
        sources.appendChild(option);
      });
      sources.value = url;
      choices.hidden = urls.length < 2;
      heading.textContent = urls.length > 1 ? urls.length + ' video links found' : 'Video found';
      window.parent.postMessage({type:'__CP_PROMPT_SIZE__',multiple:urls.length > 1}, '*');
      describe();
      buttons();
      if (refreshAgain) { refreshAgain = false; refresh(); }
    });
  }
  function failed() {
    clearTimeout(actionTimer);
    busy = false;
    buttons();
    detail.textContent = 'Could not open here. Try New tab.';
  }
  function open(newTab) {
    if (!url || busy) return;
    busy = true; buttons();
    detail.textContent = 'Opening player…';
    actionTimer = setTimeout(failed,5000);
    window.parent.postMessage({type:'__CP_PLAY_PROMPT__',url,newTab}, '*');
  }
  play.addEventListener('click', () => open(true));
  newTab.addEventListener('click', () => open(false));
  document.getElementById('dismiss').addEventListener('click', () => window.parent.postMessage({type:'__CP_DISMISS_PROMPT__'}, '*'));
  window.addEventListener('message', event => {
    if (event.source !== window.parent) return;
    if (event.data?.type === '__CP_REFRESH_PROMPT__') refresh();
    if (event.data?.type === '__CP_PLAY_FAILED__') failed();
  });
  refresh();
})();
