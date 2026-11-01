// Vercel Serverless Function: /api/proxy
const { Readable } = require('node:stream');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Accept-Ranges', 'bytes');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const targetUrl = req.query?.url;
  if (!targetUrl) {
    return res.status(400).send('Missing url parameter');
  }

  try {
    const parsedTarget = new URL(targetUrl);
    if (!['http:', 'https:'].includes(parsedTarget.protocol)) {
      return res.status(400).send('Invalid protocol');
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

    if (isPlaylist) {
      const text = await upstream.text();
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

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        return res.status(upstream.status).send(rewritten);
      }
    }

    // Media chunk streaming (.ts, .mp4, etc.)
    res.setHeader('Content-Type', contentType || 'video/mp2t');
    if (upstream.headers.get('content-length')) {
      res.setHeader('Content-Length', upstream.headers.get('content-length'));
    }
    if (upstream.headers.get('content-range')) {
      res.setHeader('Content-Range', upstream.headers.get('content-range'));
    }

    res.status(upstream.status);
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    return res.status(502).send('Proxy error: ' + err.message);
  }
};
