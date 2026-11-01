// Injected into the page's isolated world by background.js (chrome.scripting.executeScript
// with `func`), so it is serialized: keep it self-contained and use only browser globals.
//
// The player itself never lives in the page. It runs in an extension-origin iframe inside a
// modal <dialog> that sits in the browser's top layer, so its controls cannot be covered or
// have their clicks caught by page scripts or ad overlays. The page can still touch the host
// element (same DOM), so every tampering path re-asserts the overlay.
function mountCleanPlayOverlay(frameUrl) {
  globalThis.__cleanPlayOverlay?.close();
  function pausePageMedia() {
    try {
      document.querySelectorAll('video, audio').forEach(el => { try { el.pause(); } catch (_) {} });
    } catch (_) {}
  }
  pausePageMedia();
  const frameOrigin = new URL(frameUrl).origin;
  const ticket = new URL(frameUrl).searchParams.get('ticket');
  const host = document.createElement('div');
  host.id = '__cp__';
  // Inline !important beats page stylesheets; `all` blocks inherited styles from reaching the frame.
  const hostStyles = {all:'initial', display:'block', position:'static', visibility:'visible', opacity:'1', 'pointer-events':'auto'};
  const dialogStyles = {
    position:'fixed', inset:'0', margin:'0', padding:'0', border:'0', width:'100vw', height:'100vh',
    'max-width':'none', 'max-height':'none', background:'#050507', overflow:'hidden',
    opacity:'1', visibility:'visible', transform:'none', 'pointer-events':'auto', 'color-scheme':'dark'
  };
  function applyStyles(element, styles) {
    for (const [name, value] of Object.entries(styles)) {
      if (element.style.getPropertyValue(name) !== value || element.style.getPropertyPriority(name) !== 'important') {
        element.style.setProperty(name, value, 'important');
      }
    }
  }
  applyStyles(host, hostStyles);
  // Page scripts cannot reach inside a closed shadow root, so the frame URL (and its ticket) stays private.
  const shadow = host.attachShadow({mode:'closed'});
  const dialog = document.createElement('dialog');
  applyStyles(dialog, dialogStyles);
  shadow.appendChild(dialog);
  const frame = document.createElement('iframe');
  frame.title = 'CleanPlay isolated player';
  frame.allow = 'autoplay; fullscreen; picture-in-picture; clipboard-write';
  frame.allowFullscreen = true;
  frame.setAttribute('autofocus', '');
  frame.style.cssText = 'display:block;width:100%;height:100%;border:0;background:#050507;color-scheme:dark';
  frame.src = frameUrl;
  dialog.appendChild(frame);

  let closed = false;
  let scheduled = false;
  let lastTime = 0;

  function frameIsFullscreen() { return document.fullscreenElement === host; }

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(guardTimer);
    observer.disconnect();
    document.removeEventListener('toggle', onToggle, true);
    document.removeEventListener('fullscreenchange', onFullscreen);
    window.removeEventListener('message', onMessage);
    if (dialog.open) dialog.close();
    host.remove();
    if (globalThis.__cleanPlayOverlay?.close === close) delete globalThis.__cleanPlayOverlay;
    try { chrome.runtime.sendMessage({type:'RELEASE_OVERLAY', ticket}, () => chrome.runtime.lastError); } catch (_) {}
  }

  // Re-showing a modal dialog moves it to the end of the top layer, above anything shown since.
  function show() {
    if (frameIsFullscreen()) return;
    try {
      if (dialog.open) dialog.close();
      dialog.showModal();
      frame.focus();
    } catch (_) {}
  }

  function promote() {
    if (closed || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (closed) return;
      applyStyles(host, hostStyles);
      // Our own style writes must not be observed as tampering.
      observer.takeRecords();
      if (host.parentNode !== document.documentElement) {
        // Re-inserting an iframe reloads it, so resume from the last reported position.
        host.remove();
        const resume = new URL(frameUrl);
        resume.searchParams.set('t', String(Math.floor(lastTime)));
        frame.src = resume.href;
        document.documentElement.appendChild(host);
      }
      show();
    });
  }

  // Anything rendered above the player at these points (a later modal, popover, fullscreen
  // element, even inside a closed shadow root) would receive the user's clicks instead.
  function covered() {
    const w = window.innerWidth, h = window.innerHeight;
    if (document.hidden || !w || !h) return false;
    const points = [[w / 2, h / 2], [w * 0.1, h * 0.1], [w * 0.9, h * 0.1], [w * 0.1, h * 0.9], [w * 0.9, h * 0.9]];
    return points.some(([x, y]) => {
      const element = document.elementFromPoint(x, y);
      return element && element !== host;
    });
  }
  function guard() {
    if (closed) return;
    pausePageMedia();
    if (host.parentNode !== document.documentElement || !dialog.open || (!frameIsFullscreen() && covered())) promote();
  }

  function onToggle(event) {
    if (event.target !== dialog && event.target !== host && event.newState === 'open') promote();
  }
  function onFullscreen() {
    if (!frameIsFullscreen()) promote();
  }
  function onMessage(event) {
    if (closed || event.source !== frame.contentWindow || event.origin !== frameOrigin || !event.data) return;
    if (event.data.type === '__CLEANPLAY_CLOSE_OVERLAY__') close();
    else if (event.data.type === '__CLEANPLAY_PROGRESS__' && Number.isFinite(event.data.time) && event.data.time >= 0) lastTime = event.data.time;
  }
  const observer = new MutationObserver(records => {
    if (closed) return;
    if (host.parentNode !== document.documentElement) { promote(); return; }
    for (const record of records) {
      if (record.target === host) { promote(); return; }
      if (record.target !== dialog && record.attributeName === 'open' && record.target.matches?.('dialog:modal')) { promote(); return; }
    }
  });
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  window.addEventListener('message', onMessage);
  document.addEventListener('toggle', onToggle, true);
  document.addEventListener('fullscreenchange', onFullscreen);
  document.documentElement.appendChild(host);
  show();
  observer.observe(document.documentElement, {childList:true});
  observer.observe(host, {attributes:true});
  observer.observe(document.documentElement, {subtree:true, attributes:true, attributeFilter:['open']});
  const guardTimer = setInterval(guard, 750);
  globalThis.__cleanPlayOverlay = {close};
  return {ok:true};
}
