// Vercel Serverless Function: /api/resolve
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

function formatBytes(bytes) {
  if (!bytes || isNaN(bytes)) return '';
  const num = Number(bytes);
  if (num < 1024) return num + ' B';
  if (num < 1024 * 1024) return (num / 1024).toFixed(1) + ' KB';
  if (num < 1024 * 1024 * 1024) return (num / (1024 * 1024)).toFixed(1) + ' MB';
  return (num / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

async function followRedirects(url, maxHops = 5) {
  let current = url;
  for (let i = 0; i < maxHops; i++) {
    try {
      const res = await fetch(current, {
        method: 'HEAD',
        redirect: 'manual',
        headers: { 'User-Agent': UA }
      });
      const loc = res.headers.get('location');
      if (loc && (res.status === 301 || res.status === 302 || res.status === 303 || res.status === 307 || res.status === 308)) {
        current = new URL(loc, current).href;
      } else {
        break;
      }
    } catch (_) {
      break;
    }
  }
  return current;
}

async function resolveTeraBox(targetUrl) {
  const finalUrl = await followRedirects(targetUrl);
  const parsed = new URL(finalUrl);

  const res = await fetch(finalUrl, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });

  const html = await res.text();

  const uk = html.match(/(?:["']?(?:share_)?uk["']?\s*[:=]\s*|mset\(\s*["'](?:share_)?uk["']\s*,\s*)["']?(\d{5,20})["']?/i)?.[1];
  const shareid = html.match(/(?:["']?share_?id["']?\s*[:=]\s*|mset\(\s*["']share_?id["']\s*,\s*)["']?(\d{5,20})["']?/i)?.[1];
  const sign = html.match(/(?:["']?(?:download_)?sign["']?\s*[:=]\s*|mset\(\s*["'](?:download_)?sign["']\s*,\s*)["']([0-9a-zA-Z_-]{6,128})["']/i)?.[1];
  const timestamp = html.match(/(?:["']?timestamp["']?\s*[:=]\s*|mset\(\s*["']timestamp["']\s*,\s*)["']?(\d{9,13})["']?/i)?.[1];
  const jsToken = html.match(/(?:jsToken["']?\s*[:=]\s*["']|fn\s*(?:\(\s*["']|%28%22))([0-9a-fA-F]{16,256})(?:["']|%22)/)?.[1];

  let files = [];

  const listMatch = html.match(/["']file_list["']\s*:\s*(\[\s*\{[\s\S]*?\}\s*\])/);
  if (listMatch) {
    try {
      const parsedList = JSON.parse(listMatch[1]);
      if (Array.isArray(parsedList)) files = parsedList;
    } catch (_) {}
  }

  if ((!files.length || files.length === 0) && uk && shareid) {
    try {
      const apiUrl = `https://${parsed.hostname}/share/list?uk=${uk}&shareid=${shareid}&order=other&desc=1&showempty=0&web=1&page=1&num=100&channel=dubox&clienttype=0&app_id=250528`;
      const apiRes = await fetch(apiUrl, {
        headers: {
          'User-Agent': UA,
          'Referer': finalUrl,
          'Accept': 'application/json'
        }
      });
      if (apiRes.ok) {
        const json = await apiRes.json();
        if (json.list && Array.isArray(json.list)) {
          files = json.list;
        }
      }
    } catch (_) {}
  }

  if (!files.length) {
    for (const match of html.matchAll(/["']?fs_id["']?\s*:\s*["']?(\d{5,20})["']?/gi)) {
      const fid = match[1];
      const start = Math.max(0, html.lastIndexOf('{', match.index));
      const closeBrace = html.indexOf('}', match.index);
      const end = closeBrace !== -1 ? Math.min(html.length, closeBrace + 1) : Math.min(html.length, match.index + 600);
      const chunk = html.slice(start, end);
      const isDir = /["']?isdir["']?\s*:\s*(?:["']?1["']?|true)\b/i.test(chunk);
      if (isDir) continue;
      const fn = chunk.match(/["']?(?:server_filename|path)["']?\s*:\s*["']([^"']+)["']/i)?.[1] || ('Video ' + fid);
      const isVideo = /["']?category["']?\s*:\s*["']?1["']?/i.test(chunk) || /\.(mp4|m3u8|webm|mkv|mov|avi|m4v|flv|ts)$/i.test(fn);
      if (!isVideo) continue;
      const size = chunk.match(/["']?size["']?\s*:\s*["']?(\d+)["']?/i)?.[1];
      files.push({ fs_id: fid, server_filename: fn, size, category: 1 });
    }
  }

  const seenFids = new Set();
  const videoFiles = [];
  for (const item of files) {
    const fid = String(item.fs_id || item.fid || '');
    if (!fid || seenFids.has(fid)) continue;
    seenFids.add(fid);
    const name = String(item.server_filename || item.filename || item.path || ('Video ' + fid));
    const isVideo = String(item.category) === '1' || /\.(mp4|m3u8|webm|mkv|mov|avi|m4v|flv|ts)$/i.test(name);
    if (!isVideo) continue;

    const qualities = {};
    const streamTypes = [
      { name: '1080p', type: 'M3U8_AUTO_1080' },
      { name: '720p',  type: 'M3U8_AUTO_720' },
      { name: '480p',  type: 'M3U8_AUTO_480' },
      { name: '360p',  type: 'M3U8_AUTO_360' }
    ];

    for (const q of streamTypes) {
      if (!uk || !shareid) continue;
      const stream = new URL('/share/streaming', parsed.origin);
      stream.searchParams.set('uk', String(uk));
      stream.searchParams.set('shareid', String(shareid));
      stream.searchParams.set('type', q.type);
      stream.searchParams.set('fid', fid);
      if (sign) stream.searchParams.set('sign', String(sign));
      if (timestamp) stream.searchParams.set('timestamp', String(timestamp));
      if (jsToken) stream.searchParams.set('jsToken', String(jsToken));
      stream.searchParams.set('app_id', '250528');
      stream.searchParams.set('web', '1');
      stream.searchParams.set('clienttype', '0');
      stream.searchParams.set('channel', 'dubox');

      qualities[q.name] = stream.href;
    }

    videoFiles.push({
      fid,
      name,
      sizeFormatted: formatBytes(item.size),
      sizeBytes: item.size || 0,
      qualities
    });
  }

  return {
    ok: true,
    platform: 'terabox',
    title: videoFiles.length === 1 ? videoFiles[0].name : (videoFiles.length + ' videos in folder'),
    count: videoFiles.length,
    files: videoFiles
  };
}

module.exports = async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (_) {}
    }
    const inputUrl = String(body?.url || req.query?.url || '').trim();

    if (!inputUrl) {
      return res.status(400).json({ ok: false, error: 'URL parameter is required' });
    }

    const isTera = /(?:terabox|1024tera|freeterabox|terashare|4funbox|mirrobox|nephobox|momerybox|tibibox|dubox)/i.test(inputUrl);
    if (isTera) {
      const result = await resolveTeraBox(inputUrl);
      if (!result.files.length) {
        return res.status(404).json({ ok: false, error: 'No video files found. The link may have expired or requires login.' });
      }

      for (const file of result.files) {
        file.proxyQualities = {};
        for (const [q, streamUrl] of Object.entries(file.qualities)) {
          file.proxyQualities[q] = `/api/proxy?url=${encodeURIComponent(streamUrl)}`;
        }
        file.defaultStream = file.proxyQualities['720p'] || file.proxyQualities['480p'] || file.proxyQualities['1080p'] || Object.values(file.proxyQualities)[0];
      }

      return res.status(200).json(result);
    }

    if (/\.(mp4|m3u8|webm|mkv)$/i.test(inputUrl) || inputUrl.includes('.m3u8')) {
      const name = inputUrl.split('/').pop().split('?')[0] || 'Direct Video';
      return res.status(200).json({
        ok: true,
        platform: 'direct',
        title: name,
        count: 1,
        files: [{
          fid: 'direct',
          name,
          sizeFormatted: '',
          defaultStream: `/api/proxy?url=${encodeURIComponent(inputUrl)}`,
          proxyQualities: { 'Original': `/api/proxy?url=${encodeURIComponent(inputUrl)}` }
        }]
      });
    }

    return res.status(400).json({ ok: false, error: 'Unsupported link. Please paste a TeraBox share link or direct video URL.' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Failed to resolve link' });
  }
};
