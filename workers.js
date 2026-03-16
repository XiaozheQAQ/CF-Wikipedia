/**
 * 中文维基百科镜像站 · Cloudflare Worker · v9
 *
 * ══════════════════════════════════════════════════════════
 *  v9 修复：移动端所有资源加载失败
 * ══════════════════════════════════════════════════════════
 *
 *  v8 的三个叠加 bug：
 *
 *  Bug-1（致命）：?useformat=mobile 触发重定向循环
 *    Wikipedia 对 ?useformat=mobile 的处理：
 *      1. 302 重定向去掉参数，同时响应 Set-Cookie: mf_useformat=true
 *      2. redirect:'follow' 跟随重定向
 *      3. 但跟随时仍携带原始 host:zh.wikipedia.org 头
 *      4. 若重定向目标是 zh.m.wikipedia.org，Host 头不匹配
 *         → 服务端返回异常 → 所有资源引用失效
 *
 *  Bug-2：cacheKey 双 ? 问题
 *    url.search='?a=1' 时拼接 '?__m' → '?a=1?__m' 是破损 URL
 *
 *  Bug-3：CSS 响应未验证 Content-Type
 *    若上游返回 HTML 错误页，buildCSS 把 HTML 当 CSS 处理
 *    → 返回 text/css 的 HTML 内容 → 样式完全失效
 *
 *  v9 修复方案：
 *    ① 完全删除 ?useformat=mobile URL 参数
 *    ② 改用 Cookie: mf_useformat=true 发送给上游
 *       MobileFrontend 直接读 cookie 渲染 Minerva 皮肤
 *       → 零重定向，host 头始终正确，CSS 正常加载
 *    ③ 修复 cacheKey：有 search 时用 & 拼接，无则用 ?
 *    ④ buildCSS 前强制验证 Content-Type 必须含 text/css
 *
 *  架构不变：
 *    · 单一上游 zh.wikipedia.org（CSS/JS/HTML 全部来此）
 *    · redirect:'follow'（正常情况不触发）
 *    · 双层缓存：Cloudflare cf{} 边缘 + Worker Cache API
 *    · UA 池轮换防封禁
 *    · 不注入任何额外 UI
 */

// ── 配置 ──────────────────────────────────────────────────────────────────

const WIKI = 'zh.wikipedia.org';   // 唯一上游

const PROXY_HOSTS = [
  'upload.wikimedia.org',
  'upload.wikipedia.org',
  'bits.wikimedia.org',
  'meta.wikimedia.org',
  'www.wikimedia.org',
  'wikimedia.org',
  'mediawiki.org',
  'www.mediawiki.org',
  'en.wikipedia.org',
  'www.wikipedia.org',
  'commons.wikimedia.org',
  'maps.wikimedia.org',
  'tiles.maps.eox.at',
  'species.wikimedia.org',
  'incubator.wikimedia.org',
];

const BLOCKED_REGIONS = ['KP', 'SY', 'CU', 'IR'];
const BLOCKED_IPS     = [];

const TTL = {
  html:   1800,
  css:    86400,
  static: 604800,
  media:  2592000,
  api:    300,
};

const TIMEOUT_MS = 25000;
const MP         = '/proxy-media/';

/** UA 池（桌面 UA，避免服务端基于 UA 触发移动重定向）*/
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
];

// ── 工具 ──────────────────────────────────────────────────────────────────

function isMobile(ua) {
  return /Mobile|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|webOS/i.test(ua || '');
}

function pickUA(req) {
  const ip   = req.headers.get('cf-connecting-ip') || '0';
  const seed = ip.split('.').reduce((a, b) => a + (parseInt(b, 10) || 0), 0);
  return USER_AGENTS[seed % USER_AGENTS.length];
}

// ── 入口 ──────────────────────────────────────────────────────────────────

addEventListener('fetch', event => {
  event.respondWith(
    handle(event).catch(err => {
      console.error('[mirror]', err);
      return plain('Internal error.', 500);
    })
  );
});

async function handle(event) {
  const req    = event.request;
  const url    = new URL(req.url);
  const myHost = url.hostname;
  const ua     = req.headers.get('user-agent') || '';
  const mobile = isMobile(ua);

  // 地理/IP 封锁
  const region = (req.headers.get('cf-ipcountry') || '').toUpperCase();
  const cip    = req.headers.get('cf-connecting-ip') || '';
  if (BLOCKED_REGIONS.includes(region) || (BLOCKED_IPS.length && BLOCKED_IPS.includes(cip)))
    return plain('Access denied.', 403);

  // 特殊路径
  if (url.pathname === '/robots.txt')
    return plain('User-agent: *\nDisallow: /\n', 200, 'text/plain;charset=UTF-8');
  if (url.pathname === '/favicon.ico')
    return simpleFetch('https://' + WIKI + '/static/favicon/wikipedia.ico');
  if (req.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: corsH() });
  if (url.pathname === '/health')
    return plain('OK', 200);

  // 只读镜像
  const action = url.searchParams.get('action') || '';
  if (['edit', 'submit', 'login', 'purge'].includes(action) ||
      /^\/wiki\/Special:(UserLogin|CreateAccount|Watchlist|Preferences|Contributions)/.test(url.pathname))
    return plain('Read-only mirror.', 403);

  const { type, upURL } = classify(url);

  // Cache API（Range 请求与媒体不走应用层缓存）
  const cache   = caches.default;
  const ckey    = makeCacheKey(type, url, mobile);
  const isRange = req.headers.has('range');

  if (!isRange && type !== 'media') {
    const hit = await cache.match(ckey);
    if (hit) {
      const h = new Headers(hit.headers);
      h.set('x-cache', 'HIT');
      return new Response(hit.body, { status: hit.status, headers: h });
    }
  }

  const upRes = await fetchUpstream(upURL, req, type, mobile);
  if (!upRes) return plain('Gateway error.', 502);

  const ct  = upRes.headers.get('content-type') || '';
  const st  = upRes.status;

  let res;
  if (type === 'html' && st < 400 && ct.includes('text/html')) {
    res = buildHTML(upRes, myHost, url, mobile);
  } else if (ct.includes('text/css')) {
    // ★ Bug-3 修复：严格验证 Content-Type，HTML 错误页不当 CSS 处理
    res = await buildCSS(upRes, myHost);
  } else {
    res = pass(upRes, type);
  }

  if (st === 200 && !isRange && type !== 'media')
    event.waitUntil(cache.put(ckey, res.clone()));

  return res;
}

// ── 路由分类（统一上游，URL 不做移动端改动）─────────────────────────────────
//
//  移动端皮肤切换完全通过 cookie 实现（见 fetchUpstream）
//  URL 层面移动/桌面完全一致，规避一切重定向风险

function classify(url) {
  const p = url.pathname, s = url.search;

  if (p.startsWith(MP)) {
    const rest  = p.slice(MP.length);
    const slash = rest.indexOf('/');
    const host  = slash === -1 ? rest : rest.slice(0, slash);
    const fp    = slash === -1 ? '/' : rest.slice(slash);
    return { type: 'media', upURL: mkURL('https', host, fp, s) };
  }

  if (p.startsWith('/w/api.php') || p.startsWith('/api/rest_v1/') || p.startsWith('/api/rest_v0/'))
    return { type: 'api', upURL: mkURL('https', WIKI, p, s) };

  if (p.startsWith('/w/load.php') || /\.css(\?|$)/i.test(p))
    return { type: 'css', upURL: mkURL('https', WIKI, p, s) };

  if (p.startsWith('/static/') ||
      p.startsWith('/w/resources/') ||
      p.startsWith('/w/extensions/') ||
      p.startsWith('/w/skins/') ||
      /\.(js|woff2?|ttf|otf|eot|ico|svg|png|jpg|jpeg|gif|webp|avif|mp4|ogv|oga|flac|ogg|wav|mp3|pdf)(\?|$)/i.test(p))
    return { type: 'static', upURL: mkURL('https', WIKI, p, s) };

  // /w/index.php 是 MediaWiki 主入口，可能返回搜索页、历史页等完整 HTML 页面
  // 必须走 html 分支才能注入 mf_useformat cookie 和 viewport
  // （action=raw 等返回非 HTML 内容时，handle() 里的 ct 检查会走 pass() 透传，安全）
  if (p.startsWith('/w/index.php'))
    return { type: 'html', upURL: mkURL('https', WIKI, p, s) };

  return { type: 'html', upURL: mkURL('https', WIKI, p, s) };
}

// ── 上游请求 ──────────────────────────────────────────────────────────────
//
//  ★ Bug-1 修复核心：
//    移动端 HTML 请求注入 Cookie: mf_useformat=true
//    MobileFrontend 直接读此 cookie 渲染 Minerva 皮肤
//    完全不触发任何服务端重定向，host 头始终是 zh.wikipedia.org

async function fetchUpstream(upURL, req, type, mobile) {
  const upHost = new URL(upURL).hostname;
  const h = new Headers();

  h.set('host',                      upHost);
  h.set('referer',                   'https://' + upHost + '/');
  h.set('origin',                    'https://' + upHost);
  h.set('user-agent',                pickUA(req));
  h.set('accept',
    type === 'html'
      ? 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
      : type === 'css'
        ? 'text/css,*/*;q=0.1'
        : '*/*');
  h.set('accept-language',  req.headers.get('accept-language') || 'zh-CN,zh;q=0.9,en;q=0.8');
  h.set('accept-encoding',  'gzip, deflate, br');
  h.set('sec-ch-ua',        '"Chromium";v="124","Google Chrome";v="124"');
  h.set('sec-ch-ua-mobile', '?0');
  h.set('sec-ch-ua-platform', '"Windows"');
  h.set('sec-fetch-dest',   type === 'html' ? 'document' : type === 'media' ? 'audio' : 'empty');
  h.set('sec-fetch-mode',   type === 'html' ? 'navigate' : 'cors');
  h.set('sec-fetch-site',   'none');
  h.set('sec-fetch-user',   '?1');
  h.set('upgrade-insecure-requests', '1');

  // ★ 移动端 HTML：注入 mf_useformat=true cookie
  //   效果：MobileFrontend 直接返回 Minerva 皮肤，无重定向
  //   原有 cookie 保留（用于维基登录态等）
  const existingCookie = req.headers.get('cookie') || '';
  let cookieStr = existingCookie;
  if (mobile && type === 'html') {
    const mfCookie = 'mf_useformat=true';
    cookieStr = cookieStr
      ? (cookieStr.includes('mf_useformat') ? cookieStr : cookieStr + '; ' + mfCookie)
      : mfCookie;
  }
  if (cookieStr) h.set('cookie', cookieStr);

  if (req.headers.has('range')) h.set('range', req.headers.get('range'));

  const opts = {
    method:   req.method === 'HEAD' ? 'HEAD' : 'GET',
    headers:  h,
    redirect: 'follow',
    cf: {
      cacheEverything: type !== 'html' && type !== 'api',
      cacheTtl:        TTL[type] ?? TTL.html,
      // ★ HTML 移动/桌面 cf 缓存 key 分离（cookie 不同，内容不同）
      cacheKey: upURL + (mobile && type === 'html' ? '#m' : ''),
    },
  };

  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const r     = await fetch(upURL, { ...opts, signal: ctrl.signal });
    clearTimeout(timer);
    return r;
  } catch (_) {
    try { return await fetch(upURL, opts); } catch (__) { return null; }
  }
}

// ── HTML 流式改写 ──────────────────────────────────────────────────────────

function buildHTML(res, myHost, reqUrl, mobile) {
  const headers = buildHeaders(res.headers, 'html');

  const fn   = clientScript.toString();
  const body = fn.slice(fn.indexOf('{') + 1, fn.lastIndexOf('}'));

  const headInject = [
    // viewport（移动端，覆盖 Minerva 皮肤自带的 viewport 以确保 viewport-fit）
    mobile
      ? '<meta name="viewport" content="width=device-width,initial-scale=1,minimum-scale=1,viewport-fit=cover">'
      : '',
    '<link rel="preconnect" href="https://' + myHost + '" crossorigin>',
    '<meta name="referrer" content="no-referrer">',
    '<script>(function(){',
    'var __H__='  + JSON.stringify(myHost)     + ';',
    'var __MP__=' + JSON.stringify(MP)          + ';',
    'var __PH__=' + JSON.stringify(PROXY_HOSTS) + ';',
    body,
    '})();</script>',
  ].join('');

  return new HTMLRewriter()
    .on('head', { element(el) { el.prepend(headInject, { html: true }); } })

    // viewport：移动端确保有正确的 viewport（Minerva 已有，此处是保险）
    .on('meta[name="viewport"]', {
      element(el) {
        if (mobile)
          el.setAttribute('content',
            'width=device-width,initial-scale=1,minimum-scale=1,viewport-fit=cover');
      }
    })

    // script src：禁用 TimedMediaHandler，改写其余
    .on('script[src]', {
      element(el) {
        const src = el.getAttribute('src') || '';
        if (/TimedMediaHandler|MediaWikiPlayer|ext\.tmh/i.test(src)) { el.remove(); return; }
        el.setAttribute('src', rewriteURL(src, myHost));
      }
    })

    // 链接改写
    .on('a[href]',              new AttrH('href',   myHost))
    .on('area[href]',           new AttrH('href',   myHost))
    .on('link[href]',           new AttrH('href',   myHost))
    .on('link[rel="preload"]',  new AttrH('href',   myHost))
    .on('link[rel="prefetch"]', new AttrH('href',   myHost))

    // 图片（含 data-src/data-srcset 懒加载 → 折叠菜单图片）
    .on('img',    new ImgH(myHost))
    .on('source', new SrcH(myHost))

    // 音视频
    .on('video', new MediaH(myHost))
    .on('audio', new MediaH(myHost))

    // SVG sprite
    .on('use',   new SvgH(myHost))
    .on('image', new SvgH(myHost))

    // 内联 CSS（url() 改写 → 图标修复关键路径）
    .on('style',   new StyleH(myHost))
    .on('[style]', new InlineStyleH(myHost))

    // TimedMediaHandler JSON 属性
    .on('[data-mw-tmh]',       new JsonH('data-mw-tmh',       myHost))
    .on('[data-mw]',           new JsonH('data-mw',           myHost))
    .on('[data-videopayload]', new JsonH('data-videopayload', myHost))
    .on('[data-resource]',     new JsonH('data-resource',     myHost))

    // 表单
    .on('form[action]', new AttrH('action', myHost))

    // meta 修正
    .on('meta[property="og:url"]', {
      element(el) { el.setAttribute('content', 'https://' + myHost + reqUrl.pathname); }
    })
    .on('meta[http-equiv="refresh"]', {
      element(el) {
        const c = el.getAttribute('content') || '';
        el.setAttribute('content', rewriteURL(c, myHost));
      }
    })
    .on('link[rel="canonical"]', {
      element(el) {
        el.setAttribute('href', 'https://' + myHost + reqUrl.pathname + reqUrl.search);
      }
    })
    .on('link[rel="dns-prefetch"]', {
      element(el) {
        const href = el.getAttribute('href') || '';
        if (PROXY_HOSTS.some(ph => href.includes(ph)) || href.includes('wikipedia')) el.remove();
      }
    })
    .on('.mw-tmh-player,figure.mw-tmh-player', {
      element(el) { el.setAttribute('data-tmh-native', '1'); }
    })

    .transform(new Response(res.body, { status: res.status, headers }));
}

// ── CSS 正文改写 ───────────────────────────────────────────────────────────
//  ★ Bug-3 修复：调用前已在 handle() 验证 Content-Type 含 text/css
//  对全文执行 url() + @import 改写（搜索/汉堡图标修复关键路径）

async function buildCSS(res, myHost) {
  const text    = await res.text();
  const fixed   = rewriteCSS(text, myHost);
  const headers = buildHeaders(res.headers, 'css');
  headers.set('content-type', 'text/css; charset=UTF-8');
  headers.delete('content-encoding'); // fetch 已解压，删除防止长度不匹配
  return new Response(fixed, { status: res.status, headers });
}

// ── HTMLRewriter 处理器 ────────────────────────────────────────────────────

class AttrH {
  constructor(a, h) { this.a = a; this.h = h; }
  element(el) {
    const v = el.getAttribute(this.a);
    if (v) el.setAttribute(this.a, rewriteURL(v, this.h));
  }
}

class ImgH {
  constructor(h) { this.h = h; }
  element(el) {
    for (const a of ['src','data-src','data-lazy-src','data-original',
                     'data-zoom-src','data-hi-res-src','lowsrc']) {
      const v = el.getAttribute(a);
      if (v) el.setAttribute(a, rewriteURL(v, this.h));
    }
    for (const a of ['srcset','data-srcset']) {
      const v = el.getAttribute(a);
      if (v) el.setAttribute(a, rewriteSrcset(v, this.h));
    }
    // 不强制注入 loading="lazy"：
    // Wikipedia 自身已对需要懒加载的图片设置该属性；
    // 强制注入会导致折叠区图片在 display:none 容器中被浏览器推迟加载，
    // 展开后部分移动端浏览器不重新触发 intersection → 图片永远不显示。
    if (!el.getAttribute('decoding')) el.setAttribute('decoding', 'async');
  }
}

class SrcH {
  constructor(h) { this.h = h; }
  element(el) {
    for (const a of ['src','data-src']) {
      const v = el.getAttribute(a);
      if (v) el.setAttribute(a, rewriteURL(v, this.h));
    }
    for (const a of ['srcset','data-srcset']) {
      const v = el.getAttribute(a);
      if (v) el.setAttribute(a, rewriteSrcset(v, this.h));
    }
  }
}

class MediaH {
  constructor(h) { this.h = h; }
  element(el) {
    for (const a of ['src','poster','data-src']) {
      const v = el.getAttribute(a);
      if (v) el.setAttribute(a, rewriteURL(v, this.h));
    }
    el.setAttribute('controls', '');
    el.removeAttribute('autoplay');
    if (!el.getAttribute('preload')) el.setAttribute('preload', 'metadata');
    el.setAttribute('playsinline', '');
    el.setAttribute('webkit-playsinline', '');
  }
}

class SvgH {
  constructor(h) { this.h = h; }
  element(el) {
    for (const a of ['href','xlink:href','src']) {
      const v = el.getAttribute(a);
      if (v) el.setAttribute(a, rewriteURL(v, this.h));
    }
  }
}

class StyleH {
  constructor(h) { this.h = h; this._b = ''; }
  text(chunk) {
    this._b += chunk.text;
    if (chunk.lastInTextNode) {
      chunk.replace(rewriteCSS(this._b, this.h), { html: false });
      this._b = '';
    } else {
      chunk.remove();
    }
  }
}

class InlineStyleH {
  constructor(h) { this.h = h; }
  element(el) {
    const v = el.getAttribute('style');
    if (v) { const f = rewriteCSS(v, this.h); if (f !== v) el.setAttribute('style', f); }
  }
}

class JsonH {
  constructor(a, h) { this.a = a; this.h = h; }
  element(el) {
    const v = el.getAttribute(this.a);
    if (!v) return;
    const f = rewriteRaw(v, this.h);
    if (f !== v) el.setAttribute(this.a, f);
  }
}

// ── URL 改写（预编译正则，覆盖 zh/zh.m 两个域名及所有代理域名）────────────────

const _ZH_M = /https?:\/\/zh\.m\.wikipedia\.org/g;
const _ZH   = /https?:\/\/zh\.wikipedia\.org/g;

const _HREG = PROXY_HOSTS.map(ph => ({
  full: new RegExp('https?://' + ph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
  rel:  new RegExp('//'        + ph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
  rep:  MP + ph,
}));

function rewriteURL(url, host) {
  if (!url) return url;
  const u = url.trim();
  if (/^(data:|blob:|javascript:|#|mailto:|tel:)/.test(u)) return u;
  let s = u.startsWith('//') ? 'https:' + u : u;
  s = s.replace(_ZH_M, 'https://' + host).replace(_ZH, 'https://' + host);
  for (const { full, rel, rep } of _HREG) {
    const r = 'https://' + host + rep;
    s = s.replace(full, r).replace(rel, r);
  }
  return s;
}

function rewriteRaw(raw, host) {
  let s = raw.replace(_ZH_M, 'https://' + host).replace(_ZH, 'https://' + host);
  for (const { full, rel, rep } of _HREG) {
    const r = 'https://' + host + rep;
    s = s.replace(full, r).replace(rel, r);
    try {
      s = s.replace(new RegExp(rel.source.replace(/\//g, '\\\\/'), 'g'), r.replace(/\//g, '\\/'));
    } catch (_) {}
  }
  return s;
}

function rewriteSrcset(srcset, host) {
  return srcset.replace(/(\S+)(\s+[\d.]+[wx])?/g, (_, u, d) => rewriteURL(u, host) + (d || ''));
}

function rewriteCSS(css, host) {
  let o = css.replace(/url\(\s*(["']?)([^)"'\s]+)\1\s*\)/g,
    (_, q, u) => 'url(' + q + rewriteURL(u.trim(), host) + q + ')');
  o = o.replace(/@import\s+(["'])([^"']+)\1/g,
    (_, q, u) => '@import ' + q + rewriteURL(u.trim(), host) + q);
  return o;
}

// ── 客户端修复脚本（函数体提取注入）──────────────────────────────────────────
//  注入变量：__H__ __MP__ __PH__

function clientScript() {
  /* eslint-disable no-undef */
  var H  = __H__;
  var MP = __MP__;
  var PH = __PH__;

  var RE_ZH_M = new RegExp('https?://zh\\.m\\.wikipedia\\.org', 'g');
  var RE_ZH   = new RegExp('https?://zh\\.wikipedia\\.org',     'g');

  function esc(s) { return s.replace(/[-[\]/{}()*+?.\\^$|]/g, '\\$&'); }
  var HR = PH.map(function(h) {
    return {
      full: new RegExp('https?://' + esc(h), 'g'),
      rel:  new RegExp('//'         + esc(h), 'g'),
      rep:  'https://' + H + MP + h,
    };
  });

  function fix(s) {
    if (!s || typeof s !== 'string') return s;
    if (/^(data:|blob:|javascript:|#|mailto:|tel:)/.test(s)) return s;
    if (s.indexOf('//') === 0) s = 'https:' + s;
    s = s.replace(RE_ZH_M, 'https://' + H).replace(RE_ZH, 'https://' + H);
    for (var i = 0; i < HR.length; i++)
      s = s.replace(HR[i].full, HR[i].rep).replace(HR[i].rel, HR[i].rep);
    return s;
  }

  function fixSS(s) {
    return s.replace(/(\S+)(\s+[\d.]+[wx])?/g, function(_, u, d) { return fix(u) + (d || ''); });
  }

  function fixCSS(s) {
    return s.replace(/url\(\s*(["']?)([^)"']+)\1\s*\)/g,
      function(_, q, u) { return 'url(' + q + fix(u.trim()) + q + ')'; });
  }

  function fixJ(s) {
    if (!s || typeof s !== 'string') return s;
    s = s.replace(RE_ZH_M, 'https://' + H).replace(RE_ZH, 'https://' + H);
    for (var i = 0; i < HR.length; i++)
      s = s.replace(HR[i].full, HR[i].rep).replace(HR[i].rel, HR[i].rep);
    return s;
  }

  var ATTRS  = ['src','data-src','href','srcset','data-srcset','data-lazy-src',
                'data-original','data-zoom-src','data-hi-res-src','lowsrc',
                'poster','action','xlink:href'];
  var JATTRS = ['data-mw-tmh','data-mw','data-videopayload','data-resource'];

  function fixEl(el) {
    for (var i = 0; i < ATTRS.length; i++) {
      try {
        var v = el.getAttribute(ATTRS[i]); if (!v) continue;
        var f = (ATTRS[i] === 'srcset' || ATTRS[i] === 'data-srcset') ? fixSS(v) : fix(v);
        if (f !== v) el.setAttribute(ATTRS[i], f);
      } catch (e) {}
    }
    for (var j = 0; j < JATTRS.length; j++) {
      try {
        var jv = el.getAttribute(JATTRS[j]); if (!jv) continue;
        var jf = fixJ(jv); if (jf !== jv) el.setAttribute(JATTRS[j], jf);
      } catch (e) {}
    }
    try {
      var st = el.getAttribute('style');
      if (st) { var sf = fixCSS(st); if (sf !== st) el.setAttribute('style', sf); }
    } catch (e) {}
  }

  // 原生播放器替换 TimedMediaHandler
  function injectPlayer(container) {
    try {
      var sources = container.querySelectorAll('source');
      if (!sources.length || container.querySelector('[data-np]')) return;
      var isAudio = false, list = [];
      sources.forEach(function(s) {
        var src = fix(s.getAttribute('src') || ''), type = s.getAttribute('type') || '';
        if (!src) return;
        list.push({ src: src, type: type });
        if (/\.(oga|ogg|flac|mp3|wav|opus)(\?|$)/i.test(src) || /audio/i.test(type)) isAudio = true;
      });
      if (!list.length) return;
      var el = document.createElement(isAudio ? 'audio' : 'video');
      el.setAttribute('controls', ''); el.setAttribute('preload', 'metadata');
      el.setAttribute('playsinline', ''); el.setAttribute('webkit-playsinline', '');
      el.setAttribute('data-np', '1');
      el.style.cssText = 'width:100%;max-width:100%;display:block;margin:4px 0';
      list.forEach(function(item) {
        var s = document.createElement('source');
        s.setAttribute('src', item.src);
        if (item.type) s.setAttribute('type', item.type);
        el.appendChild(s);
      });
      container.insertBefore(el, container.firstChild);
    } catch (e) {}
  }

  var SEL = 'img,source,video,audio,use,image,link[href],a[href],'
          + '[data-mw-tmh],[data-mw],[data-videopayload],.mw-tmh-player';

  function scan() {
    try {
      document.querySelectorAll(SEL).forEach(function(el) {
        fixEl(el);
        if (el.classList && el.classList.contains('mw-tmh-player')) injectPlayer(el);
      });
    } catch (e) {}
    try {
      document.querySelectorAll('style').forEach(function(el) {
        if (el._f) return; el._f = 1;
        var t = el.textContent, f = fixCSS(t); if (f !== t) el.textContent = f;
      });
    } catch (e) {}
    try {
      document.querySelectorAll('link[rel="stylesheet"]').forEach(function(l) {
        if (l._f) return; l._f = 1;
        var hv = l.getAttribute('href') || '', fv = fix(hv);
        if (fv !== hv) l.setAttribute('href', fv);
      });
    } catch (e) {}
  }

  // MutationObserver：处理折叠菜单展开后动态插入的图片/媒体
  try {
    new MutationObserver(function(ms) {
      ms.forEach(function(m) {
        m.addedNodes.forEach(function(n) {
          if (n.nodeType !== 1) return;
          try { fixEl(n); } catch (e) {}
          try {
            if (n.classList && n.classList.contains('mw-tmh-player')) injectPlayer(n);
          } catch (e) {}
          try { n.querySelectorAll(SEL).forEach(function(c) { fixEl(c); }); } catch (e) {}
        });
        if (m.type === 'attributes') { try { fixEl(m.target); } catch (e) {} }
      });
    }).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['src','href','data-src','data-srcset','data-mw-tmh','data-mw'],
    });
  } catch (e) {}

  document.addEventListener('DOMContentLoaded', scan, { once: true, passive: true });
  window.addEventListener('load', scan, { once: true, passive: true });

  // 拦截 fetch
  try {
    var _f = window.fetch;
    window.fetch = function(input, init) {
      try {
        if (typeof input === 'string') { input = fix(input); }
        else if (input && input.url) {
          var fu = fix(input.url);
          if (fu !== input.url)
            input = new Request(fu, { method: input.method, headers: input.headers,
              body: input.body, mode: input.mode, credentials: input.credentials,
              cache: input.cache, redirect: input.redirect });
        }
      } catch (e) {}
      return _f.call(this, input, init);
    };
  } catch (e) {}

  // 拦截 XHR
  try {
    var _xo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function() {
      try { arguments[1] = fix(String(arguments[1])); } catch (e) {}
      return _xo.apply(this, arguments);
    };
  } catch (e) {}

  // 拦截 HTMLMediaElement.src setter
  try {
    ['HTMLAudioElement','HTMLVideoElement','HTMLMediaElement'].forEach(function(n) {
      var p = window[n] && window[n].prototype; if (!p) return;
      var d = Object.getOwnPropertyDescriptor(p, 'src');
      if (d && d.set) Object.defineProperty(p, 'src', {
        set: function(v) { d.set.call(this, fix(String(v || ''))); },
        get: function()  { return d.get ? d.get.call(this) : ''; },
        configurable: true,
      });
    });
  } catch (e) {}

  // 拦截 Audio()
  try {
    var _A = window.Audio;
    if (_A) {
      window.Audio = function(s) { return new _A(s ? fix(String(s)) : undefined); };
      window.Audio.prototype = _A.prototype;
    }
  } catch (e) {}

  // 拦截 createElement（动态音视频）
  try {
    var _ce = document.createElement.bind(document);
    document.createElement = function(tag) {
      var el = _ce(tag), lt = (tag || '').toLowerCase();
      if (lt === 'audio' || lt === 'video') {
        var _sa = el.setAttribute.bind(el);
        el.setAttribute = function(name, val) {
          if (name === 'src' || name === 'data-src') val = fix(String(val || ''));
          return _sa(name, val);
        };
      }
      return el;
    };
  } catch (e) {}

  // 拦截 HTMLImageElement.src setter
  try {
    var _id = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    if (_id && _id.set) Object.defineProperty(HTMLImageElement.prototype, 'src', {
      set: function(v) { _id.set.call(this, fix(String(v || ''))); },
      get: function()  { return _id.get ? _id.get.call(this) : ''; },
      configurable: true,
    });
  } catch (e) {}

  // 劫持 mw.config（修正页面 JS 里的域名引用）
  try {
    var _mw = window.mw;
    function pMw(mw) {
      if (!mw || !mw.config) return;
      try { mw.config.set('wgServer', 'https://' + H); } catch (e) {}
      try { mw.config.set('wgUploadPath', 'https://' + H + MP + 'upload.wikimedia.org'); } catch (e) {}
    }
    if (_mw) { pMw(_mw); }
    else {
      Object.defineProperty(window, 'mw', {
        set: function(v) {
          _mw = v;
          Object.defineProperty(window, 'mw', { value: v, writable: true, configurable: true });
          try { pMw(v); } catch (e) {}
        },
        get: function() { return _mw; },
        configurable: true,
      });
    }
  } catch (e) {}
}

// ── 响应头 ────────────────────────────────────────────────────────────────

function buildHeaders(upH, type) {
  const h = new Headers(upH);
  h.set('access-control-allow-origin',   '*');
  h.set('access-control-allow-methods',  'GET, HEAD, OPTIONS');
  h.set('access-control-allow-headers',  'Content-Type, Range');
  h.set('access-control-expose-headers', 'Content-Length, Content-Range, Accept-Ranges');
  h.delete('content-security-policy');
  h.delete('content-security-policy-report-only');
  h.delete('clear-site-data');
  h.delete('x-frame-options');
  h.delete('content-length');

  const ttl = TTL[type] ?? TTL.html;
  switch (type) {
    case 'media':
      h.set('cache-control', 'public, max-age=' + ttl + ', immutable');
      h.set('accept-ranges', 'bytes');
      break;
    case 'css':
    case 'static':
      h.set('cache-control', 'public, max-age=' + ttl + ', immutable');
      break;
    case 'html':
      h.set('cache-control',
        'public, max-age=' + ttl + ', stale-while-revalidate=86400, stale-if-error=604800');
      break;
    case 'api':
      h.set('cache-control', 'public, max-age=' + ttl + ', must-revalidate');
      break;
    default:
      h.set('cache-control', 'public, max-age=' + ttl);
  }

  h.set('vary',                   'Accept-Encoding');
  h.set('x-content-type-options', 'nosniff');
  h.set('x-cache',                'MISS');
  h.set('timing-allow-origin',    '*');
  h.delete('server');
  h.delete('cf-ray');
  h.delete('cf-cache-status');
  return h;
}

function pass(res, type) {
  return new Response(res.body, { status: res.status, headers: buildHeaders(res.headers, type) });
}

// ── 工具函数 ──────────────────────────────────────────────────────────────

// ★ Bug-2 修复：正确拼接移动端 cache key，不产生双 ?
function makeCacheKey(type, url, mobile) {
  // 仅 HTML 类型需要区分移动/桌面（CSS/JS/图片内容相同）
  const mobileSuffix = (mobile && type === 'html')
    ? (url.search ? '&__m=1' : '?__m=1')
    : '';
  return new Request(
    'https://x.cache/' + type + url.pathname + url.search + mobileSuffix,
    { method: 'GET' }
  );
}

function mkURL(proto, host, path, search) {
  if (!path) path = '/';
  if (!path.startsWith('/')) path = '/' + path;
  path = path.replace(/[\x00-\x1f\x7f]/g, '');
  try {
    return new URL(proto + '://' + host + path + (search || '')).toString();
  } catch (_) {
    try { return new URL(proto + '://' + host + encodeURI(path) + (search || '')).toString(); }
    catch (__) { return proto + '://' + host + '/'; }
  }
}

async function simpleFetch(url) {
  try { return await fetch(url, { cf: { cacheEverything: true, cacheTtl: 86400 } }); }
  catch (_) { return plain('', 404); }
}

function corsH() {
  return {
    'access-control-allow-origin':  '*',
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    'access-control-allow-headers': 'Content-Type, Range',
  };
}

function plain(body, status = 200, ct = 'text/plain;charset=UTF-8') {
  return new Response(body, { status, headers: { 'content-type': ct, ...corsH() } });
}
