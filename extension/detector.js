// Shared, side-effect-free URL extraction for the worker and content scripts.
(function(root) {
  'use strict';
  if (root.CleanPlayDetector) return;
  const MEDIA_PATH = /\.(mp4|m3u8|webm|mkv)$/i;
  const TERABOX_HOST = /(?:^|\.)(?:1024tera(?:box)?|freeterabox|terabox(?:app|link|share|dl)?|terashare(?:link|file)?|terafileshare|4funbox|mirrobox|nephobox|momerybox|tibibox|dubox)\.[a-z.]+$/i;
  const MAX_TEXT = 512 * 1024;
  function isWatchPage(value, base) {
    try {
      const url = new URL(value, base);
      // A filename after /v/<id>/ is still an HTML watch page on these hosts.
      if (/(?:^|\.)(?:streamtape|strtape|strtpe|strcloud|tapecontent)\.[a-z.]+$/i.test(url.hostname) &&
        /^\/(?:v|e)\//i.test(url.pathname)) return true;
      // TeraBox share and file-list routes are HTML watch pages, not direct streams.
      if (TERABOX_HOST.test(url.hostname) &&
        (/^\/(?:s\/|sharing\/(?:link|embed)|wap\/share\/|main\b)/i.test(url.pathname) || url.searchParams.has('surl'))) return true;
      return false;
    } catch (_) { return false; }
  }
  function isTeraBoxHost(hostname) {
    return TERABOX_HOST.test(String(hostname || ''));
  }
  function isHls(value, base) {
    try {
      const url = new URL(value, base);
      return /\.m3u8$/i.test(url.pathname) ||
        (/^(?:\/openapi)?\/(?:share|sharing|api)\/streaming$/i.test(url.pathname) &&
          /^M3U8_(?:AUTO|FLV|HLS)(?:_[A-Z0-9_]+)?$/i.test(url.searchParams.get('type') || '') &&
          !/^M3U8_(?:SUBTITLE|MP3)/i.test(url.searchParams.get('type') || ''));
    } catch (_) { return false; }
  }
  function getVideoId(url) {
    if (!url || typeof url !== 'string') return '';
    try {
      const u = new URL(url);
      const fid = u.searchParams.get('fid');
      if (fid) {
        const pureFid = fid.split('-').pop();
        if (pureFid) return 'fid:' + pureFid;
      }
      const id = u.searchParams.get('id');
      if (id) return 'id:' + id;
      return u.origin + u.pathname.toLowerCase();
    } catch (_) {
      return url.split('?')[0].toLowerCase();
    }
  }
  function normalize(value, base) {
    if (typeof value !== 'string' || value.length > 16384) return null;
    value = value.trim();
    // Reject whole HTML/config snippets before URL() treats them as relative paths.
    if (/[\s"'<>`\\]/.test(value)) return null;
    try {
      const url = new URL(value, base);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
      if (isWatchPage(url.href)) return null;
      // Some hosts serve signed MP4 files through an endpoint without a file suffix.
      const signedVideo = url.pathname === '/get_video' &&
        ['id', 'token', 'expires', 'ip'].every(key => !!url.searchParams.get(key)) &&
        /^\d+$/.test(url.searchParams.get('expires'));
      // TeraBox serves HLS playlists from /share/streaming or /api/streaming with type=M3U8_*.
      const teraboxStream = /^(?:\/openapi)?\/(?:share|sharing|api)\/streaming$/i.test(url.pathname) &&
        /^M3U8_(?:AUTO|FLV|HLS)(?:_[A-Z0-9_]+)?$/i.test(url.searchParams.get('type') || '') &&
        !/^M3U8_(?:SUBTITLE|MP3)/i.test(url.searchParams.get('type') || '') &&
        ((['uk', 'shareid', 'fid'].every(key => /^\d+$/.test(url.searchParams.get(key) || ''))) ||
          (!!url.searchParams.get('path') && !!(url.searchParams.get('access_tokens') || url.searchParams.get('access_token'))));
      // TeraBox direct file links (dlink) use /file/<md5> with signed fid and expiration parameters.
      const teraboxDirect = TERABOX_HOST.test(url.hostname) &&
        /^\/file\/[0-9a-f]{32}$/i.test(url.pathname) &&
        /^\d+(?:-\d+)*$/.test(url.searchParams.get('fid') || '') &&
        !!url.searchParams.get('sign') &&
        /^\d+$/.test(url.searchParams.get('expires') || url.searchParams.get('dstime') || url.searchParams.get('time') || '');
      if (!MEDIA_PATH.test(url.pathname) && !signedVideo && !teraboxStream && !teraboxDirect) return null;
      // On TeraBox hosts, bare unsigned filenames come from file_list metadata (server_filename/path), not media streams.
      if (TERABOX_HOST.test(url.hostname) && !teraboxStream && !teraboxDirect &&
        !(/\.m3u8$/i.test(url.pathname) || url.searchParams.has('sign') || url.searchParams.has('token'))) {
        return null;
      }
      // Fragments are not sent to media servers.
      url.hash = '';
      return url.href;
    } catch (_) { return null; }
  }
  function decodeText(text) {
    return text.slice(0, MAX_TEXT)
      .replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\x([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\\//g, '/')
      .replace(/&amp;|&#0*38;|&#x0*26;/gi, '&')
      .replace(/&quot;|&#0*34;/gi, '"')
      .replace(/&#0*39;|&apos;/gi, "'");
  }
  // Decode only string literals from the common Dean Edwards packer.
  // Never eval(), Function(), or execute any downloaded page code.
  function readLiteral(literal) {
    return literal.slice(1, -1).replace(/\\(?:u([0-9a-f]{4})|x([0-9a-f]{2})|(\r?\n)|([\s\S]))/gi,
      (_, unicode, hex, newline, char) => {
        if (unicode || hex) return String.fromCharCode(parseInt(unicode || hex, 16));
        if (newline) return '';
        return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' })[char] ?? char;
      });
  }
  function unpack(text) {
    if (!/eval\s*\(\s*function\s*\(/.test(text)) return [];
    const decoded = [];
    const invocation = /\}\s*\(\s*('(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*")\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*('(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*")\s*\.\s*split\s*\(\s*['"]\|['"]\s*\)/g;
    let match;
    while (decoded.length < 8 && (match = invocation.exec(text)) !== null) {
      const radix = Number(match[2]), count = Number(match[3]);
      if (radix < 2 || radix > 62 || count > 10000) continue;
      const payload = readLiteral(match[1]);
      const dictionary = readLiteral(match[4]).split('|');
      if (dictionary.length < count) continue;
      const words = new Map();
      function token(number) {
        const digit = number % radix;
        const character = digit < 36 ? digit.toString(36) : String.fromCharCode(digit + 29);
        return (number >= radix ? token(Math.floor(number / radix)) : '') + character;
      }
      for (let i = 0; i < count; i++) if (dictionary[i]) words.set(token(i), dictionary[i]);
      let budget = MAX_TEXT;
      let oversized = false;
      const result = payload.replace(/\b[0-9a-zA-Z]+\b/g, word => {
        const replacement = words.get(word) || word;
        budget -= replacement.length;
        if (budget < 0) { oversized = true; return ''; }
        return replacement;
      });
      if (!oversized && result.length <= MAX_TEXT) decoded.push(result);
    }
    return decoded;
  }
  function extractTeraBox(decoded, base, add) {
    let origin = null;
    try {
      const baseUrl = new URL(base);
      if (TERABOX_HOST.test(baseUrl.hostname)) origin = baseUrl.origin;
    } catch (_) {}
    if (!origin) {
      const hostMatch = decoded.match(/https?:\/\/([a-z0-9.-]+)/i);
      if (hostMatch && TERABOX_HOST.test(hostMatch[1])) origin = hostMatch[0];
    }
    if (!origin) return;
    const uk = decoded.match(/(?:["']?(?:share_)?uk["']?\s*[:=]\s*|mset\(\s*["'](?:share_)?uk["']\s*,\s*)["']?(\d{5,20})["']?/i)?.[1];
    const shareid = decoded.match(/(?:["']?share_?id["']?\s*[:=]\s*|mset\(\s*["']share_?id["']\s*,\s*)["']?(\d{5,20})["']?/i)?.[1];
    if (!uk || !shareid) return;
    const sign = decoded.match(/(?:["']?(?:download_)?sign["']?\s*[:=]\s*|mset\(\s*["'](?:download_)?sign["']\s*,\s*)["']([0-9a-zA-Z_-]{6,128})["']/i)?.[1];
    const timestamp = decoded.match(/(?:["']?timestamp["']?\s*[:=]\s*|mset\(\s*["']timestamp["']\s*,\s*)["']?(\d{9,13})["']?/i)?.[1];
    const jsToken = decoded.match(/(?:jsToken["']?\s*[:=]\s*["']|fn\s*(?:\(\s*["']|%28%22))([0-9a-fA-F]{16,256})(?:["']|%22)/)?.[1];
    if (!(sign && timestamp) && !jsToken) return;
    for (const match of decoded.matchAll(/["']?fs_id["']?\s*:\s*["']?(\d{5,20})["']?/gi)) {
      const fid = match[1];
      const start = Math.max(0, decoded.lastIndexOf('{', match.index));
      const closeBrace = decoded.indexOf('}', match.index);
      const end = closeBrace !== -1 ? Math.min(decoded.length, closeBrace + 1) : Math.min(decoded.length, match.index + 600);
      const chunk = decoded.slice(start, end);
      if (/["']?isdir["']?\s*:\s*(?:["']?1["']?|true)\b/i.test(chunk)) continue;
      const isVideo = /["']?category["']?\s*:\s*["']?1["']?(?:\s*[,}])/i.test(chunk) ||
        /["']?(?:server_filename|path)["']?\s*:\s*["'][^"']+\.(?:mp4|m3u8|webm|mkv|mov|avi|m4v|flv|ts)["']/i.test(chunk);
      if (!isVideo) continue;
      const stream = new URL('/share/streaming', origin);
      stream.searchParams.set('uk', uk);
      stream.searchParams.set('shareid', shareid);
      stream.searchParams.set('type', 'M3U8_AUTO_1080');
      stream.searchParams.set('fid', fid);
      if (sign) stream.searchParams.set('sign', sign);
      if (timestamp) stream.searchParams.set('timestamp', timestamp);
      if (jsToken) stream.searchParams.set('jsToken', jsToken);
      stream.searchParams.set('app_id', '250528');
      stream.searchParams.set('web', '1');
      stream.searchParams.set('clienttype', '0');
      stream.searchParams.set('channel', 'dubox');
      add(stream.href);
    }
  }
  function extract(text, base, depth = 0, budget = { blocks: 16 }) {
    if (typeof text !== 'string') return [];
    const found = new Set();
    function add(value) {
      const url = normalize(value, base);
      if (url && found.size < 100) found.add(url);
    }
    const decoded = decodeText(text);
    add(decoded);
    // Absolute URLs and protocol-relative URLs in HTML or JavaScript.
    for (const match of decoded.matchAll(/(?:https?:)?\/\/[^\s"'<>\\`]+/gi)) add(match[0]);
    // Quoted relative sources in player configs and lazy-load attributes.
    for (const match of decoded.matchAll(/["'`]([^"'`\s<>]+)["'`]/g)) add(match[1]);
    extractTeraBox(decoded, base, add);
    // Some hosts hide player setup inside packed inline scripts.
    if (depth < 3) {
      for (const script of unpack(text.slice(0, MAX_TEXT))) {
        if (--budget.blocks < 0) break;
        for (const url of extract(script, base, depth + 1, budget)) add(url);
      }
    }
    return [...found];
  }
  root.CleanPlayDetector = Object.freeze({ normalize, extract, isWatchPage, isHls, isTeraBoxHost, getVideoId });
})(globalThis);
