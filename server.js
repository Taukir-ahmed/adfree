// CleanPlay Mobile & Desktop Web App Server
// Zero-dependency Node.js HTTP server with TeraBox resolver & HLS proxy
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Readable } = require('node:stream');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.mp4': 'video/mp4'
};

function getLocalIps() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

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

  // Try extracting file_list from inline JSON or script variables
  const listMatch = html.match(/["']file_list["']\s*:\s*(\[\s*\{[\s\S]*?\}\s*\])/);
  if (listMatch) {
    try {
      const parsedList = JSON.parse(listMatch[1]);
      if (Array.isArray(parsedList)) files = parsedList;
    } catch (_) {}
  }

  // If inline file_list was not directly parsed, call the TeraBox share/list API
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

  // Regex fallback scan for fs_id blocks if needed
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

  // Deduplicate by fs_id
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

  // If single file or folder with multiple files
  return {
    ok: true,
    platform: 'terabox',
    title: videoFiles.length === 1 ? videoFiles[0].name : (videoFiles.length + ' videos in folder'),
    count: videoFiles.length,
    files: videoFiles
  };
}

async function verifyHls(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Referer': 'https://www.terabox.app/'
      }
    });
    if (!res.ok) return false;
    const text = await res.text();
    return /#EXTM3U/i.test(text) && /#EXT(?:-X-STREAM-INF|INF)/i.test(text);
  } catch (_) {
    return false;
  }
}

async function handleProxy(req, res, targetUrl) {
  try {
    const parsedTarget = new URL(targetUrl);
    if (!['http:', 'https:'].includes(parsedTarget.protocol)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('Invalid protocol');
    }

    const forwardHeaders = {
      'User-Agent': UA,
      'Referer': parsedTarget.origin + '/',
      'Accept': req.headers['accept'] || '*/*'
    };

    if (req.headers['range']) {
      forwardHeaders['Range'] = req.headers['range'];
    }

    const upstream = await fetch(targetUrl, {
      headers: forwardHeaders
    });

    const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
    const isPlaylist = contentType.includes('mpegurl') ||
      parsedTarget.pathname.endsWith('.m3u8') ||
      /streaming/i.test(parsedTarget.pathname);

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Accept-Ranges': 'bytes'
    };

    if (isPlaylist) {
      const text = await upstream.text();
      // If the response is actually an m3u8 playlist, rewrite the chunk URLs through our proxy
      if (/#EXTM3U/i.test(text)) {
        const lines = text.split('\n');
        const rewritten = lines.map(line => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) return line;
          try {
            const absolute = new URL(trimmed, targetUrl).href;
            return `/api/proxy?url=${encodeURIComponent(absolute)}`;
          } catch (_) {
            return line;
          }
        }).join('\n');

        res.writeHead(upstream.status, {
          ...corsHeaders,
          'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
          'Cache-Control': 'no-cache'
        });
        return res.end(rewritten);
      }
    }

    // Binary / media segments (.ts, .mp4, chunks)
    const forwardResponseHeaders = {
      ...corsHeaders,
      'Content-Type': contentType || 'video/mp2t'
    };
    if (upstream.headers.get('content-length')) {
      forwardResponseHeaders['Content-Length'] = upstream.headers.get('content-length');
    }
    if (upstream.headers.get('content-range')) {
      forwardResponseHeaders['Content-Range'] = upstream.headers.get('content-range');
    }

    res.writeHead(upstream.status, forwardResponseHeaders);
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end('Proxy error: ' + err.message);
  }
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;

  // CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*'
    });
    return res.end();
  }

  // API: Resolve video link
  if (pathname === '/api/resolve') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try { req.body = body ? JSON.parse(body) : {}; } catch (_) { req.body = {}; }
      res.status = function(code) { res.statusCode = code; return res; };
      res.json = function(data) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(data));
        return res;
      };
      res.send = function(data) { res.end(data); return res; };
      const handler = require('./api/resolve.js');
      return handler(req, res);
    });
    return;
  }

  // API: Stream Proxy
  if (pathname === '/api/proxy') {
    req.query = Object.fromEntries(reqUrl.searchParams.entries());
    res.status = function(code) { res.statusCode = code; return res; };
    res.send = function(data) { res.end(data); return res; };
    const handler = require('./api/proxy.js');
    return handler(req, res);
  }

  // Static File Serving
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIps();
  console.log('='.repeat(55));
  console.log('⚡ CleanPlay Web Player is running!');
  console.log(`💻 Local computer:  http://localhost:${PORT}`);
  if (ips.length) {
    for (const ip of ips) {
      console.log(`📱 Mobile phone:    http://${ip}:${PORT}`);
    }
  }
  console.log('='.repeat(55));
});
