// CleanPlay Web - Client Application
(function() {
  'use strict';

  // DOM Elements
  const urlInput = document.getElementById('urlInput');
  const pasteBtn = document.getElementById('pasteBtn');
  const fetchBtn = document.getElementById('fetchBtn');
  const statusMessage = document.getElementById('statusMessage');

  const playerCard = document.getElementById('playerCard');
  const videoPlayer = document.getElementById('videoPlayer');
  const playerLoader = document.getElementById('playerLoader');
  const videoTitle = document.getElementById('videoTitle');
  const videoSizeBadge = document.getElementById('videoSizeBadge');
  const qualitySelect = document.getElementById('qualitySelect');
  const copyStreamBtn = document.getElementById('copyStreamBtn');
  const downloadBtn = document.getElementById('downloadBtn');

  const playlistCard = document.getElementById('playlistCard');
  const playlistTitle = document.getElementById('playlistTitle');
  const playlistCount = document.getElementById('playlistCount');
  const playlistContainer = document.getElementById('playlistContainer');

  const recentsCard = document.getElementById('recentsCard');
  const recentsList = document.getElementById('recentsList');
  const clearRecentsBtn = document.getElementById('clearRecentsBtn');

  let currentFiles = [];
  let currentIndex = 0;
  let currentFile = null;
  let currentStreamUrl = '';
  let hlsInstance = null;

  // Status message helper
  function setStatus(text, type = 'info') {
    if (!text) {
      statusMessage.hidden = true;
      statusMessage.textContent = '';
      statusMessage.className = 'status-msg';
      return;
    }
    statusMessage.hidden = false;
    statusMessage.textContent = text;
    statusMessage.className = `status-msg ${type}`;
  }

  // Paste from clipboard
  pasteBtn.addEventListener('click', async () => {
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText();
        if (text) {
          urlInput.value = text.trim();
          fetchAndPlay();
          return;
        }
      }
    } catch (_) {}
    urlInput.focus();
  });

  // Enter key trigger
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      fetchAndPlay();
    }
  });

  // Fetch button trigger
  fetchBtn.addEventListener('click', fetchAndPlay);

  async function fetchAndPlay() {
    const url = urlInput.value.trim();
    if (!url) {
      setStatus('Please enter or paste a video link.', 'error');
      urlInput.focus();
      return;
    }

    setStatus('⚡ Resolving video streams…', 'info');
    fetchBtn.disabled = true;

    try {
      const res = await fetch('/api/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Could not resolve stream');
      }

      currentFiles = data.files || [];
      if (!currentFiles.length) {
        throw new Error('No videos found in this link.');
      }

      setStatus('');
      saveRecent(url, data.title || currentFiles[0].name);

      // Render playlist if multiple videos exist (folder)
      if (currentFiles.length > 1) {
        playlistCard.hidden = false;
        playlistTitle.textContent = `📁 ${data.title || 'Folder Videos'}`;
        playlistCount.textContent = `${currentFiles.length} videos`;
        renderPlaylist();
      } else {
        playlistCard.hidden = true;
      }

      // Play first video
      playVideoAt(0);

    } catch (err) {
      setStatus(`❌ ${err.message}`, 'error');
    } finally {
      fetchBtn.disabled = false;
    }
  }

  function renderPlaylist() {
    playlistContainer.innerHTML = '';
    currentFiles.forEach((file, index) => {
      const item = document.createElement('div');
      item.className = `playlist-item ${index === currentIndex ? 'active' : ''}`;
      item.innerHTML = `
        <span class="item-index">${index + 1}</span>
        <div class="item-details">
          <div class="item-name" title="${file.name}">${file.name}</div>
          <div class="item-meta">${file.sizeFormatted || 'Video stream'}</div>
        </div>
        <span class="item-play-icon">▶</span>
      `;
      item.addEventListener('click', () => {
        playVideoAt(index);
      });
      playlistContainer.appendChild(item);
    });
  }

  function updatePlaylistHighlight() {
    const items = playlistContainer.querySelectorAll('.playlist-item');
    items.forEach((item, index) => {
      if (index === currentIndex) {
        item.classList.add('active');
        item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else {
        item.classList.remove('active');
      }
    });
  }

  function playVideoAt(index) {
    if (index < 0 || index >= currentFiles.length) return;
    currentIndex = index;
    currentFile = currentFiles[index];
    updatePlaylistHighlight();

    playerCard.hidden = false;
    videoTitle.textContent = currentFile.name;
    videoSizeBadge.textContent = currentFile.sizeFormatted || '';

    // Populate qualities
    qualitySelect.innerHTML = '';
    const qualities = currentFile.proxyQualities || {};
    const qualityKeys = Object.keys(qualities);

    if (qualityKeys.length) {
      qualityKeys.forEach(q => {
        const option = document.createElement('option');
        option.value = qualities[q];
        option.textContent = q;
        qualitySelect.appendChild(option);
      });
    }

    const initialStream = currentFile.defaultStream || Object.values(qualities)[0];
    qualitySelect.value = initialStream;

    loadStream(initialStream);

    // Scroll player into view on mobile
    if (window.innerWidth < 768) {
      playerCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function loadStream(streamUrl) {
    if (!streamUrl) return;
    currentStreamUrl = streamUrl;
    playerLoader.hidden = false;

    // Direct / proxy URL
    const fullUrl = new URL(streamUrl, window.location.origin).href;
    downloadBtn.href = fullUrl;
    downloadBtn.setAttribute('download', currentFile?.name || 'video.mp4');

    const prevTime = videoPlayer.currentTime;
    const isHls = streamUrl.includes('.m3u8') || streamUrl.includes('streaming');

    if (hlsInstance) {
      hlsInstance.destroy();
      hlsInstance = null;
    }

    // 1. Mobile Safari Native HLS Check
    if (videoPlayer.canPlayType('application/vnd.apple.mpegurl')) {
      videoPlayer.src = streamUrl;
      videoPlayer.addEventListener('loadedmetadata', () => {
        playerLoader.hidden = true;
        if (prevTime > 0) videoPlayer.currentTime = prevTime;
        videoPlayer.play().catch(() => {});
      }, { once: true });
    } 
    // 2. HLS.js for Android Chrome / Desktop browsers
    else if (isHls && window.Hls && Hls.isSupported()) {
      hlsInstance = new Hls({
        enableWorker: true,
        lowLatencyMode: true
      });
      hlsInstance.loadSource(streamUrl);
      hlsInstance.attachMedia(videoPlayer);
      hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
        playerLoader.hidden = true;
        if (prevTime > 0) videoPlayer.currentTime = prevTime;
        videoPlayer.play().catch(() => {});
      });
      hlsInstance.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          playerLoader.hidden = true;
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              hlsInstance.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hlsInstance.recoverMediaError();
              break;
            default:
              hlsInstance.destroy();
              break;
          }
        }
      });
    } 
    // 3. Standard HTML5 direct media (.mp4, etc.)
    else {
      videoPlayer.src = streamUrl;
      videoPlayer.addEventListener('loadedmetadata', () => {
        playerLoader.hidden = true;
        if (prevTime > 0) videoPlayer.currentTime = prevTime;
        videoPlayer.play().catch(() => {});
      }, { once: true });
    }
  }

  // Switch quality without losing playback position
  qualitySelect.addEventListener('change', () => {
    loadStream(qualitySelect.value);
  });

  // Copy Stream URL
  copyStreamBtn.addEventListener('click', async () => {
    if (!currentStreamUrl) return;
    const fullUrl = new URL(currentStreamUrl, window.location.origin).href;
    try {
      await navigator.clipboard.writeText(fullUrl);
      const originalText = copyStreamBtn.textContent;
      copyStreamBtn.textContent = '✅ Copied!';
      setTimeout(() => { copyStreamBtn.textContent = originalText; }, 2000);
    } catch (_) {
      prompt('Copy stream URL:', fullUrl);
    }
  });

  // Autoplay next video in folder when current ends
  videoPlayer.addEventListener('ended', () => {
    if (currentIndex < currentFiles.length - 1) {
      playVideoAt(currentIndex + 1);
    }
  });

  videoPlayer.addEventListener('playing', () => {
    playerLoader.hidden = true;
  });

  videoPlayer.addEventListener('waiting', () => {
    playerLoader.hidden = false;
  });

  // Recent Links Storage
  const RECENTS_KEY = 'cleanplay_web_recents';

  function getRecents() {
    try {
      return JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]');
    } catch (_) {
      return [];
    }
  }

  function saveRecent(url, title) {
    let recents = getRecents();
    recents = recents.filter(item => item.url !== url);
    recents.unshift({ url, title, time: Date.now() });
    recents = recents.slice(0, 8);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(recents));
    renderRecents();
  }

  function renderRecents() {
    const recents = getRecents();
    if (!recents.length) {
      recentsCard.hidden = true;
      return;
    }
    recentsCard.hidden = false;
    recentsList.innerHTML = '';
    recents.forEach(item => {
      const li = document.createElement('li');
      li.textContent = `${item.title} • ${item.url}`;
      li.title = item.url;
      li.addEventListener('click', () => {
        urlInput.value = item.url;
        fetchAndPlay();
      });
      recentsList.appendChild(li);
    });
  }

  clearRecentsBtn.addEventListener('click', () => {
    localStorage.removeItem(RECENTS_KEY);
    renderRecents();
  });

  renderRecents();
})();
