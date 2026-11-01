// One lightweight, non-modal prompt in the top document. Its buttons are isolated from page ads.
(function() {
  'use strict';
  // Check the page host, not the media host: these sites often use separate CDNs.
  // This also applies when a manual scan injects this script again.
  const hostname = window.location.hostname.toLowerCase().replace(/\.$/, '');
  const excludedSites = ['youtube.com', 'youtu.be', 'youtube-nocookie.com', 'x.com', 'twitter.com'];
  if (excludedSites.some(site => hostname === site || hostname.endsWith('.' + site))) return;
  if (window.top !== window || globalThis.__cleanPlayPrompt) return;
  let host, panel, frame, ticket;
  let dismissed = false;
  let rootObserver;
  const origin = new URL(chrome.runtime.getURL('auto-prompt.html')).origin;
  function hide() {
    dismissed = true;
    rootObserver?.disconnect();
    host?.remove();
    host = panel = frame = null;
  }
  function show(nextTicket) {
    if (nextTicket && nextTicket !== ticket) {
      dismissed = false;
    }
    if (dismissed || globalThis.__cleanPlayOverlay) return;
    if (document.hidden || !document.documentElement) { ticket = nextTicket; return; }
    if (frame && ticket === nextTicket) {
      frame.contentWindow.postMessage({type:'__CP_REFRESH_PROMPT__'}, origin);
      return;
    }
    ticket = nextTicket;
    host?.remove();
    host = document.createElement('div');
    host.id = '__cleanplay_prompt__';
    host.style.setProperty('all','initial','important');
    const shadow = host.attachShadow({mode:'closed'});
    panel = document.createElement('div');
    panel.popover = 'manual';
    panel.style.cssText = 'position:fixed;inset:auto 16px 16px auto;margin:0;padding:0;border:0;width:min(340px,calc(100vw - 32px));height:154px;background:transparent;overflow:hidden;color-scheme:dark';
    frame = document.createElement('iframe');
    frame.title = 'CleanPlay video found';
    frame.style.cssText = 'display:block;width:100%;height:100%;border:0;background:transparent;color-scheme:dark';
    frame.src = chrome.runtime.getURL('auto-prompt.html') + '?ticket=' + encodeURIComponent(ticket);
    panel.appendChild(frame);
    shadow.appendChild(panel);
    document.documentElement.appendChild(host);
    panel.showPopover(); // Top layer without making the page inert or taking keyboard focus.
  }
  chrome.runtime.onMessage.addListener(function(msg) {
    if (msg?.type === 'AUTO_VIDEO_AVAILABLE') show(msg.ticket);
    if (msg?.type === 'HIDE_AUTO_PROMPT') hide();
  });
  window.addEventListener('message', function(event) {
    if (!frame || event.source !== frame.contentWindow || event.origin !== origin) return;
    if (event.data?.type === '__CP_PROMPT_SIZE__') {
      panel.style.height = event.data.multiple === true ? '210px' : '154px';
    }
    if (event.data?.type === '__CP_DISMISS_PROMPT__') {
      hide();
      chrome.runtime.sendMessage({type:'AUTO_DISMISS'}, () => chrome.runtime.lastError);
    }
    if (event.data?.type === '__CP_PLAY_PROMPT__') {
      try {
        document.querySelectorAll('video, audio').forEach(el => { try { el.pause(); } catch (_) {} });
      } catch (_) {}
      const activeFrame = frame;
      chrome.runtime.sendMessage({type:'AUTO_PLAY',url:event.data.url,newTab:event.data.newTab === true}, function(result) {
        const error = chrome.runtime.lastError;
        if (!error && result?.ok) hide();
        else activeFrame.contentWindow?.postMessage({type:'__CP_PLAY_FAILED__'}, origin);
      });
    }
  });
  function ready() {
    if (ticket) show(ticket);
    chrome.runtime.sendMessage({type:'AUTO_READY'}, () => chrome.runtime.lastError);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && ticket && !host) show(ticket); });
  document.addEventListener('click', function(event) {
    if (event.target && event.target.closest && event.target.closest('#__cleanplay_prompt__')) return;
    dismissed = false;
  }, true);
  if (!document.documentElement) {
    rootObserver = new MutationObserver(() => {
      if (document.documentElement) { rootObserver.disconnect(); ready(); }
    });
    rootObserver.observe(document,{childList:true});
  }
  globalThis.__cleanPlayPrompt = {hide};
  ready();
})();
