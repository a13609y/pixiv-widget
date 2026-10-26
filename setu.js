// ==UserScript==
// @Name         Pixiv 每日美图小组件 v4
// @Platform     Egern
// @Type         generic
// @Author       Cuttlefish
// @WebURL       https://www.pixiv.net/
// @Version      4.0.0
// ==/UserScript==

/* ================================================================
 * Pixiv 免登录搜索 + 反代图床的每日美图小组件（单一图源，仅全年龄）
 *
 * 数据链路：
 *   搜索  GET https://www.pixiv.net/ajax/search/artworks/{word}
 *         ?word=..&order=date_d&mode=safe&p=1&s_mode=s_tag&type=all&lang=zh
 *         -> body.illustManga.data，36 条/页，含 id/width/height/tags/userName
 *   图片  把返回的 i.pximg.net 缩略图路径改写后挂到反代域名：
 *         /img-master/..._master1200.jpg （1200px，约 300KB~1.2MB）
 *         /c/540x540_70/..._square1200.jpg （540 方图，约 40KB）
 *         实测反代只白名单 360/540 两档缩略，720 以上返回 403
 *
 * ── 环境变量（全部可选）────────────────────────────────────────
 * KEYWORD        搜索词，标签模糊匹配
 * TAGS           精确标签，多个用 | 或 , 分隔，第一个作为搜索词
 * PIXIV_WORD     搜索词，优先级最高
 * WORD_MODE      s_tag（默认，标签模糊）| s_tag_full（标签精确）| s_tc（标题简介）
 * ORDER          date_d（最新，默认）| popular_d（热门，免登录会退化）
 * TYPE           illust（默认，只要插画）| manga | all
 *                注意：Pixiv 的 type 查询参数实测无效（total 不变），所以是本地按 illustType 过滤
 *                illustType：0 = 插画，1 = 漫画，2 = 动图（一律跳过）
 * MAX_PAGE       游标最多翻到第几页就回卷，默认 3                （见 README「会不会重复」）
 * TRENDING       auto（默认，抓到登录 Cookie 后自动跟随热门搜索词）/ on / off
 * PIXIV_COOKIE   可选，手动填 PHPSESSID；不填则自动读取抓包脚本写入的值
 * EXCLUDE_TAGS   要排除的标签，多个用 | 或 , 分隔（不区分大小写的包含匹配）
 *                例如：漫画|R-18G|原创  —— 命中任意一个就整张跳过
 * AI_MODE        any（默认）| only（只要 AI 生成）| exclude（过滤 AI）
 *                Pixiv 的 aiType：2 = 投稿者标注的 AI 生成，1 = 非 AI/未标注
 * COOLDOWN       每张图展示时长（分钟），0 = 每次刷新换图   默认 30
 * MAX_HISTORY    本地去重条数                            默认 120
 * IMAGE_QUALITY  auto（默认，小号 540 / 中大号 1200）| master | thumb
 * IMG_HOST       图床，默认 i.pixiv.re（大陆可用）
 * ASPECT_FIT     auto（默认，按尺寸挑画幅）| off（纯随机）
 * SHOW_INFO      true/false 图上叠加标题作者              默认 true
 * DEBUG          true/false 图左下角显示画幅/搜索次数，排障用  默认 false
 * TEXT_COLOR     叠加文字颜色                           默认 #FFFFFF
 * REQUEST_TIMEOUT 单次请求超时（秒）                      默认 15
 * ================================================================ */

const K = {
  cache: 'sx5_cache_',       // + family
  pool: 'sx5_pool',
  history: 'sx5_history',
  lastShow: 'sx5_lastshow_', // + family
  debug: 'sx5_debug'
};

const DEFAULT_HOST = 'i.pixiv.re';
const FALLBACK_HOSTS = ['i.pixiv.re', 'i.pixiv.cat'];
const PAGE_SIZE = 36;   // Pixiv 网页搜索固定每页 36 条
const MAX_POOL = 150;   // 候选池上限（只存元数据，很小）

export default async function(ctx) {
  const family = ctx.widgetFamily || 'systemSmall';
  const cfg = readConfig(ctx.env);
  const now = Date.now();

  // Cookie 来源：env 手填优先；否则用 http_request 脚本抓到的「已验证登录态」
  const envCookie = normalizeCookie(String((ctx.env && ctx.env.PIXIV_COOKIE) || ''));
  const autoSid = (ctx.storage.get('pixiv_phpsessid') || '').trim();
  const autoState = ctx.storage.get('pixiv_phpsessid_state') || '';
  cfg.cookie = envCookie || ((autoState === 'login' || autoState === 'unknown') ? autoSid : '');
  cfg.trendingEnabled = cfg.trendingMode === 'on'
    || (cfg.trendingMode === 'auto' && !!cfg.cookie);
  const cooldownMs = cfg.cooldownMin > 0 ? cfg.cooldownMin * 60000 : 0;

  if (family === 'accessoryInline') {
    return { type: 'widget', children: [{ type: 'text', text: 'Pixiv', maxLines: 1 }] };
  }
  if (family === 'accessoryCircular' || family === 'accessoryRectangular') {
    return buildAccessory(ctx, family, cfg);
  }

  // 抓包脚本最后被调用的时间（没有通知也能验证脚本有没有在跑）
  const seenAt = Number(ctx.storage.get('pixiv_seen_at') || 0) || 0;
  const seenText = seenAt
    ? new Date(seenAt).toTimeString().slice(0, 5)
    : '无';

  const cached = readJSON(ctx, K.cache + family);
  const lastShow = Number(ctx.storage.get(K.lastShow + family) || 0) || 0;
  const remaining = cooldownMs - (now - lastShow);

  if (cached && cached.dataUri && remaining > 0) {
    // 只改了「显示标题作者 / 调试角标 / 文字颜色」这类纯排版项时，
    // 不必等换图：把缓存打上新签名并请求 1 分钟后重绘，WidgetKit 很快就会用新样式渲染
    const uiSig = uiSignature(cfg);
    if (cached.uiSig !== uiSig) {
      cached.uiSig = uiSig;
      writeJSON(ctx, K.cache + family, cached);
      return buildWidget(cached, family, cfg, new Date(now + 60 * 1000).toISOString());
    }
    return buildWidget(cached, family, cfg, new Date(now + remaining).toISOString());
  }

  let history = readJSON(ctx, K.history);
  if (!Array.isArray(history)) history = [];
  history = history.filter(x => typeof x === 'string' && x);
  const historySet = new Set(history);

  let pool = readJSON(ctx, K.pool) || {};
  if (!Array.isArray(pool.items)) pool.items = [];
  const sig = signature(cfg);
  // 搜索参数变了、或池子闲置超过 12 小时，都作废重来
  if (pool.sig !== sig || !pool.ts || now - pool.ts > 12 * 3600 * 1000) {
    pool = { items: [], ts: now, page: 1, sig };
  }

  let lastError = '';
  let errorStatus = null;
  let searches = 0;

  // ① 池里按画幅「严格」挑：区间内没有合适的就算没挑到，不再直接退让
  let candidate = pickFromPool(pool, historySet, family, cfg, true);
  if (candidate) {
    pool.ts = now;                 // 只要还在用就续命，避免剩一半被 TTL 丢掉
    writeJSON(ctx, K.pool, pool);
  }

  // ② 池里没有合适画幅 -> 继续往后翻页补货（同一次刷新最多 2 页）
  // 搜索词延迟到真要搜索时再取（否则池里有货也会白拉一次热门标签）
  let word = '';
  let picked = null;

  const barren = pool.barrenAt && now - pool.barrenAt < 6 * 3600 * 1000;
  const hasFresh = () => pool.items.some(it => it && it.url && !historySet.has(it.url));
  while (!candidate && searches < 2) {
    // 池子彻底空了必须补货；池里还有货只是画幅不合，且这个标签已被判定画幅贫瘠，就不再白翻
    if (barren && hasFresh()) break;
    try {
      if (!word) { picked = await pickWord(ctx, cfg); word = picked.word; }
      const res = await searchPixiv(ctx, cfg, pool.page || 1, word);
      searches++;
      pool.items = pool.items.concat(res.items).slice(-MAX_POOL);
      pool.page = res.page;
      pool.ts = now;
      writeJSON(ctx, K.pool, pool);
      candidate = pickFromPool(pool, historySet, family, cfg, true);
    } catch (e) {
      lastError = e.message || '搜索失败';
      errorStatus = e.status || null;
      break;
    }
  }

  // ②b 翻了两页还是没有 -> 记一笔，6 小时内不再为画幅额外翻页
  if (!candidate && searches > 0) {
    pool.barrenAt = now;
    writeJSON(ctx, K.pool, pool);
  }

  // ③ 才退而求其次：池里画幅最接近的新图
  if (!candidate) {
    candidate = pickFromPool(pool, historySet, family, cfg, false);
    if (candidate) writeJSON(ctx, K.pool, pool);
  }

  if (!candidate) {
    const backoff = (errorStatus === 429 || errorStatus === 403) ? 45 : 15;
    if (cached && cached.dataUri) return buildWidget(cached, family, cfg, nextIso(backoff));
    return buildError(lastError || '暂无可用图片', cfg, nextIso(Math.min(backoff, 15)));
  }

  // ── 下载（主选失败降一级，不反复打图床）─────────────────────
  let img = null;
  let blocked = false;
  const tried = [];
  for (const url of candidateSources(candidate, cfg, family)) {
    tried.push(url);
    try {
      img = await download(ctx, url, cfg);
      break;
    } catch (e) {
      lastError = e.message || '下载失败';
      if (e.status === 429 || e.status === 403) { blocked = true; break; }
    }
  }

  if (!img) {
    writeJSON(ctx, K.debug, { at: now, stage: 'image', error: lastError, host: hostOf(tried[0]) });
    if (cached && cached.dataUri) return buildWidget(cached, family, cfg, nextIso(blocked ? 45 : 10));
    return buildError(lastError || '图片下载失败', cfg, nextIso(5));
  }

  const entry = {
    pid: candidate.pid,
    page: candidate.page,
    title: clean(candidate.title),
    author: clean(candidate.author),
    tags: Array.isArray(candidate.tags) ? candidate.tags.slice(0, 8) : [],
    aspect: candidate.__aspect || null,
    searches,
    wordSource: picked ? picked.source : '',
    seenText,
    origin: candidate.url,
    url: img.url,
    dataUri: img.dataUri,
    uiSig: uiSignature(cfg),
    at: now
  };

  writeJSON(ctx, K.cache + family, entry);
  history.push(candidate.url);
  while (history.length > cfg.maxHistory) history.shift();
  writeJSON(ctx, K.history, history);
  ctx.storage.set(K.lastShow + family, String(now));
  writeJSON(ctx, K.debug, {
    at: now,
    pid: entry.pid,
    pool: pool.items.length,
    page: pool.page,
    searches,
    aspect: candidate.__aspect || null,
    ai: !!candidate.ai,
    aiMode: cfg.aiMode,
    word: typeof word === 'string' ? word : '',
    wordSource: picked ? picked.source : '',
    seenText,
    cookie: cfg.cookie ? 'on' : 'off',
    error: lastError || null
  });

  return buildWidget(entry, family, cfg, nextIso(cfg.cooldownMin > 0 ? cfg.cooldownMin : 15));
}

/* ============================ 配置 ============================ */

// 手动输入容错：允许直接粘整串 Cookie（含 PHPSESSID= 和其他键），也允许只粘 32 位值
function normalizeCookie(raw) {
  const v = String(raw || '').trim().replace(/^["']|["']$/g, '');
  if (!v) return '';
  const m = /PHPSESSID\s*=\s*([0-9A-Za-z%._-]{8,128})/i.exec(v);
  return m ? m[1] : v.replace(/\s+/g, '');
}

function readConfig(env) {
  const s = (k, d) => {
    const v = env && env[k];
    return v === undefined || v === null || String(v).trim() === '' ? d : String(v).trim();
  };
  const bool = (k, d) => {
    const v = s(k, '');
    if (!v) return d;
    return /^(1|true|yes|on|开)$/i.test(v);
  };
  const int = (k, d, min, max) => {
    const n = parseInt(s(k, ''), 10);
    if (!Number.isFinite(n)) return d;
    return Math.min(max, Math.max(min, n));
  };
  const oneOf = (k, d, allowed) => {
    const v = s(k, d).toLowerCase();
    return allowed.indexOf(v) >= 0 ? v : d;
  };
  const list = (k, max) => s(k, '')
    .split(/[|,，、]/)
    .map(x => x.trim())
    .filter(Boolean)
    .slice(0, max);

  let host = s('IMG_HOST', DEFAULT_HOST)
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '');
  if (!host || host.indexOf('.') < 0) host = DEFAULT_HOST;

  return {
    keyword: s('KEYWORD', ''),
    pixivWord: s('PIXIV_WORD', ''),
    tags: list('TAGS', 10),
    wordMode: oneOf('WORD_MODE', 's_tag', ['s_tag', 's_tag_full', 's_tc']),
    order: oneOf('ORDER', 'date_d', ['date_d', 'popular_d', 'popular_male_d', 'popular_female_d']),
    type: oneOf('TYPE', 'illust', ['illust', 'manga', 'all']),
    maxPage: int('MAX_PAGE', 3, 1, 1000),
    aiMode: oneOf('AI_MODE', 'any', ['any', 'only', 'exclude']),
    excludeTags: list('EXCLUDE_TAGS', 20),
    trendingMode: oneOf('TRENDING', 'auto', ['auto', 'on', 'off']),
    cookie: '',            // 运行时解析：env > 抓包脚本存储
    trendingEnabled: false,
    cooldownMin: int('COOLDOWN', 30, 0, 24 * 60),
    maxHistory: int('MAX_HISTORY', 120, 1, 500),
    quality: oneOf('IMAGE_QUALITY', 'auto', ['auto', 'master', 'thumb']),
    imgHost: host,
    aspectFit: s('ASPECT_FIT', 'auto').toLowerCase() !== 'off',
    showInfo: bool('SHOW_INFO', true),
    debug: bool('DEBUG', false),
    textColor: s('TEXT_COLOR', '#FFFFFF'),
    timeoutMs: int('REQUEST_TIMEOUT', 15, 5, 60) * 1000
  };
}

function uiSignature(cfg) {
  return [cfg.showInfo, cfg.debug, cfg.textColor].join('|');
}

function signature(cfg) {
  return [cfg.keyword, cfg.pixivWord, cfg.tags.join(','), cfg.order, cfg.type, cfg.wordMode, cfg.imgHost, cfg.maxPage, cfg.aiMode, cfg.excludeTags.join(',')].join('|');
}

function nextIso(minutes) {
  return new Date(Date.now() + Math.max(1, minutes) * 60000).toISOString();
}

/* ============================ 搜索 ============================ */

async function searchPixiv(ctx, cfg, page, word) {
  let p = Math.max(1, page | 0);
  // AI 过滤后可能整页都是空的，允许往后多翻 1 页碰运气（最多 2 次请求）
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetchSearchPage(ctx, cfg, word, p);

    const pass = res.items.filter(it => {
      if (cfg.aiMode === 'only' && !it.ai) return false;
      if (cfg.aiMode === 'exclude' && it.ai) return false;
      if (isExcluded(it, cfg.excludeTags)) return false;
      return true;
    });

    if (pass.length > 0) return { items: pass, page: res.page };

    // 本页被过滤光了：往后翻一页再试，翻不动就报错
    if (attempt === 0 && p < res.lastPage) { p = p + 1; continue; }

    let msg = '这一页没有符合条件的作品';
    if (cfg.aiMode === 'only') msg = `「${word}」这一页没有 AI 作品，换个更 AI 向的标签试试（如 AIイラスト）`;
    else if (cfg.excludeTags.length) msg = `这一页的作品都被 EXCLUDE_TAGS 排掉了：${cfg.excludeTags.join('/')}`;
    else if (cfg.type === 'illust') msg = '这一页只有漫画/动图，已按 TYPE=illust 跳过';
    const err = new Error(msg);
    err.status = 200;
    throw err;
  }

  const err = new Error(`「${word}」没有符合条件的作品`);
  err.status = 200;
  throw err;
}

async function fetchSearchPage(ctx, cfg, word, p) {
  const qs = [
    `word=${encodeURIComponent(word)}`,
    `order=${cfg.order}`,
    'mode=safe',                        // 固定全年龄
    `p=${p}`,
    `s_mode=${cfg.wordMode}`,
    'type=all',                        // 服务端 type 参数无效，过滤在本地做
    'lang=zh'
  ].join('&');

  const url = `https://www.pixiv.net/ajax/search/artworks/${encodeURIComponent(word)}?${qs}`;
  const resp = await request(ctx, url, {
    'Accept': 'application/json',
    'Referer': 'https://www.pixiv.net/',
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  }, cfg);

  const body = await resp.json().catch(() => null);
  if (!body) {
    const err = new Error('Pixiv 返回无法解析（可能被风控）');
    err.status = 403;
    throw err;
  }
  if (body.error === true) {
    const err = new Error((body.message || '') || 'Pixiv 搜索被拒绝');
    err.status = 403;
    throw err;
  }

  const box = (body.body && body.body.illustManga) || {};
  const raw = Array.isArray(box.data) ? box.data : [];

  const items = raw
    .filter(it => it && it.id && it.url)
    .map(it => ({
      pid: Number(it.id),
      illustType: it.illustType,
      page: `https://www.pixiv.net/artworks/${it.id}`,
      title: it.title,
      author: it.userName,
      tags: it.tags,
      width: it.width,
      height: it.height,
      pageCount: it.pageCount,
      ai: it.aiType === 2,           // 2 = 投稿者标注 AI 生成
      url: String(it.url)
    }))
    .filter(it => /\.(png|jpe?g|gif|webp)$/i.test(it.url.split('?')[0]))
    .filter(it => {
      if (it.illustType === 2) return false;              // 动图是 zip，取不出来
      if (cfg.type === 'illust') return it.illustType === 0;
      if (cfg.type === 'manga') return it.illustType === 1;
      return it.illustType === 0 || it.illustType === 1;
    });

  const total = Number(box.total) || 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // 只在最前面若干页里循环：越深的页作品越旧，回卷点用 MAX_PAGE 卡住
  const lastPage = Math.min(totalPages, cfg.maxPage);

  if (items.length === 0) {
    const err = new Error(p === 1 ? `「${word}」在 Pixiv 没有搜索结果` : '该标签已翻到最后一页');
    err.status = 200;
    throw err;
  }

  return { items, page: p >= lastPage ? 1 : p + 1, lastPage };
}

async function request(ctx, url, headers, cfg) {
  if (cfg.cookie && !headers['Cookie']) headers['Cookie'] = 'PHPSESSID=' + cfg.cookie;
  let resp;
  try {
    resp = await ctx.http.get(url, { headers, timeout: cfg.timeoutMs });
  } catch (e) {
    const err = new Error('网络不可达 / 超时');
    err.status = 0;
    throw err;
  }
  const st = resp.status || 0;
  if (st === 429) {
    const err = new Error('请求过于频繁，已自动退避');
    err.status = 429;
    throw err;
  }
  if (st === 403) {
    const err = new Error('被 Pixiv 风控拦截（403）');
    err.status = 403;
    throw err;
  }
  if (st >= 400) {
    const err = new Error(`HTTP ${st}`);
    err.status = st;
    throw err;
  }
  return resp;
}

/* ======================= 画幅匹配 / 选图 ======================= */

function targetAspect(family) {
  switch (family) {
    case 'systemMedium': return 2.1;
    case 'systemExtraLarge': return 2.0;
    case 'systemLarge': return 0.95;
    case 'systemSmall': return 1.0;
    default: return 1.0;
  }
}

// 画幅档位：按「优先顺序」排，前面的档位有货就不看后面的
// 中号/超大号：横图 → 方图/近方图 → 其余（宁可方图也不要竖图）
// 小号/大号：方图 → 近方图 → 其余
function aspectTiers(family) {
  switch (family) {
    case 'systemMedium':
    case 'systemExtraLarge':
      return [[1.4, 99], [0.85, 1.4]];
    default:
      return [[0.8, 1.25], [0.62, 1.45]];
  }
}

function pickByAspect(items, family, aspectFit, strict) {
  if (!items || items.length === 0) return null;
  if (!aspectFit) return items[Math.floor(Math.random() * items.length)];

  const target = targetAspect(family);
  const tiers = aspectTiers(family);
  const scored = items.map(it => {
    const ar = (it.width && it.height) ? it.width / it.height : 0;
    return { it, ar, score: ar > 0 ? Math.abs(Math.log(ar / target)) : 1 };
  });

  // 找第一个有货的档位
  let base = null;
  let tierIdx = 0;
  for (let i = 0; i < tiers.length; i++) {
    const t = scored.filter(x => x.ar >= tiers[i][0] && x.ar <= tiers[i][1]);
    if (t.length) { base = t; tierIdx = i; break; }
  }
  if (!base) { base = scored; tierIdx = tiers.length; }

  // strict：只认第一档（横图），没有就换页再找，不往下将就
  if (strict && tierIdx > 0) return null;

  base.sort((a, b) => a.score - b.score);
  const limit = Math.max(0.1, base[0].score + 0.15);
  const head = base.filter(x => x.score <= limit).slice(0, 3);
  const picked = head[Math.floor(Math.random() * head.length)];

  picked.it.__aspect = {
    target,
    ar: picked.ar ? +picked.ar.toFixed(2) : null,
    band: tierIdx === 0 ? 'in' : (tierIdx === 1 ? 'near' : 'relaxed')
  };
  return picked.it;
}

function pickFromPool(pool, historySet, family, cfg, strict) {
  if (!pool || !Array.isArray(pool.items) || pool.items.length === 0) return null;
  const fresh = pool.items.filter(it => it && it.url && !historySet.has(it.url));
  if (fresh.length === 0) return null;

  const picked = pickByAspect(fresh, family, cfg.aspectFit, strict);
  if (!picked) return null;
  pool.items = pool.items.filter(it => it !== picked);
  return picked;
}

/* ========================= 搜索词 / 热门 ===================== */

async function pickWord(ctx, cfg) {
  const explicit = cfg.pixivWord || cfg.tags[0] || cfg.keyword;
  if (explicit) return { word: explicit, source: 'config' };

  if (cfg.trendingEnabled) {
    const tags = await trendingTags(ctx, cfg);
    if (tags.length) {
      return { word: tags[Math.floor(Math.random() * tags.length)], source: 'trending' };
    }
  }
  return { word: 'オリジナル', source: 'default' };
}

// 热门搜索词：登录态才有数据，缓存 6 小时
async function trendingTags(ctx, cfg) {
  const cache = readJSON(ctx, 'sx5_trending');
  if (cache && Array.isArray(cache.tags) && cache.tags.length
      && Date.now() - cache.at < 6 * 3600 * 1000) {
    return cache.tags;
  }
  try {
    const resp = await request(ctx, 'https://www.pixiv.net/ajax/search/trending/tags?lang=zh', {
      'Accept': 'application/json',
      'Referer': 'https://www.pixiv.net/',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    }, cfg);
    const body = await resp.json().catch(() => null);
    if (!body || body.error !== false) return [];
    const tags = ((body.body && body.body.trendTags) || [])
      .map(t => t && t.tag)
      .filter(t => typeof t === 'string' && t);
    if (tags.length) writeJSON(ctx, 'sx5_trending', { at: Date.now(), tags });
    return tags;
  } catch (_) {
    return [];
  }
}

/* ========================= 标签排除 ========================= */

// 作品任一标签包含排除词就整张跳过（不区分大小写）
function isExcluded(item, excludes) {
  if (!excludes || excludes.length === 0) return false;
  const tags = Array.isArray(item.tags) ? item.tags : [];
  for (const kw of excludes) {
    const q = kw.toLowerCase();
    for (const t of tags) {
      if (String(t).toLowerCase().indexOf(q) >= 0) return true;
    }
  }
  return false;
}

/* ========================= 图片地址推导 ======================= */

// 从缩略图 URL 取出 /img-master/... 主干，再拼 1200 / 540 两档
function imageStem(rawUrl) {
  const m = /^https?:\/\/[^/]+(\/.*)$/.exec(String(rawUrl || ''));
  if (!m) return null;
  let path = m[1];
  path = path.replace(/^\/c\/[^/]+\//, '/');   // 去掉 CDN 的 /c/250x250_80_a2/
  path = path.replace('/img-original/', '/img-master/');
  path = path.replace('/custom-thumb/', '/img-master/'); // 自定义缩略图的作品，原图仍在 img-master
  const fm = /^(.*_p\d+?)(?:_square1200|_master1200|_custom1200)?\.(?:png|jpe?g|gif|webp)$/i.exec(path);
  return fm ? fm[1] : null;
}

function hostOf(url) {
  const m = /^https?:\/\/([^/]+)/.exec(String(url || ''));
  return m ? m[1] : '';
}

function candidateSources(item, cfg, family) {
  const stem = imageStem(item.url);
  if (!stem) return [item.url]; // 推不出来就直连原地址

  const hosts = [cfg.imgHost].concat(FALLBACK_HOSTS.filter(h => h !== cfg.imgHost));
  const master = hosts.map(h => `https://${h}${stem}_master1200.jpg`);
  const square = hosts.map(h => `https://${h}/c/540x540_70${stem}_square1200.jpg`);

  const quality = cfg.quality === 'auto'
    ? (family === 'systemSmall' ? 'thumb' : 'master')
    : cfg.quality;

  return quality === 'thumb'
    ? square.concat(master.slice(0, 1))
    : master.concat(square.slice(0, 1));
}

async function download(ctx, url, cfg) {
  let resp;
  try {
    resp = await ctx.http.get(url, {
      headers: { 'Referer': 'https://www.pixiv.net/', 'User-Agent': 'Egern/PixivWidget 4.0' },
      timeout: cfg.timeoutMs
    });
  } catch (e) {
    const err = new Error('图片下载超时');
    err.status = 0;
    throw err;
  }

  const status = resp.status || 0;
  if (status === 429) {
    const err = new Error('图床限流');
    err.status = 429;
    throw err;
  }
  if (status >= 400) {
    const err = new Error(`图片 HTTP ${status}`);
    err.status = status;
    throw err;
  }

  const buf = await resp.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (bytes.byteLength < 1024) {
    const err = new Error('图片内容异常');
    err.status = 0;
    throw err;
  }

  const mime = detectMime(bytes, resp.headers);
  return { url, dataUri: `data:${mime};base64,${toBase64(bytes)}` };
}

function detectMime(bytes, headers) {
  const h = headers || {};
  const ct = (h['content-type'] || h['Content-Type'] || '').toLowerCase();
  if (ct.startsWith('image/')) return ct.split(';')[0].trim();
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
  if (bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp';
  return 'image/jpeg';
}

function toBase64(bytes) {
  const CHUNK = 0x2000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, bytes.length);
    let part = '';
    for (let j = i; j < end; j++) part += String.fromCharCode(bytes[j]);
    bin += part;
  }
  return btoa(bin);
}

/* ============================ 渲染 ============================ */

function buildWidget(entry, family, cfg, refreshAfter) {
  const isSmall = family === 'systemSmall';
  const showInfo = cfg.showInfo && entry && (entry.title || entry.author);
  const children = [];

  if (showInfo) {
    const lines = [];
    if (entry.title) {
      lines.push({
        type: 'text',
        text: entry.title,
        font: { size: isSmall ? 'caption1' : 'subheadline', weight: 'bold' },
        textColor: cfg.textColor,
        maxLines: 1,
        minScale: 0.7
      });
    }
    if (!isSmall && entry.author) {
      lines.push({
        type: 'text',
        text: `@${entry.author}`,
        font: { size: 'caption2' },
        textColor: 'rgba(255,255,255,0.78)',
        maxLines: 1,
        minScale: 0.75
      });
    }
    if (cfg.debug && entry.aspect) {
      lines.push({
        type: 'text',
        text: `${cfg.cookie ? '🔑' : '🔒'} ${entry.aspect.ar || '-'}/${entry.aspect.target} · ${entry.aspect.band} · ${entry.wordSource || '-'} · 拦截${entry.seenText || seenText}`,
        font: { size: 'caption2' },
        textColor: 'rgba(255,255,255,0.55)',
        maxLines: 1
      });
    }

    children.push({ type: 'spacer' });
    children.push({
      type: 'stack',
      direction: 'column',
      alignItems: 'start',
      gap: 2,
      padding: [10, 12],
      backgroundGradient: {
        type: 'linear',
        colors: ['rgba(0,0,0,0)', 'rgba(0,0,0,0.78)'],
        startPoint: { x: 0.5, y: 0 },
        endPoint: { x: 0.5, y: 1 }
      },
      children: lines
    });
  }

  const node = {
    type: 'widget',
    refreshAfter,
    padding: 0,
    backgroundImage: entry.dataUri,
    children
  };
  if (entry.page) node.url = entry.page;
  return node;
}

function buildAccessory(ctx, family, cfg) {
  const cached = readJSON(ctx, K.cache + 'systemSmall') || readJSON(ctx, K.cache + 'systemMedium');
  const has = cached && cached.dataUri;

  if (family === 'accessoryCircular') {
    if (has) {
      return {
        type: 'widget',
        padding: 0,
        ...(cached.page ? { url: cached.page } : {}),
        children: [{
          type: 'image',
          src: cached.dataUri,
          resizeMode: 'cover',
          width: 60,
          height: 60,
          borderRadius: 'auto'
        }]
      };
    }
    return { type: 'widget', children: [{ type: 'image', src: 'sf-symbol:photo.artframe', width: 28, height: 28 }] };
  }

  const title = (cached && cached.title) || 'Pixiv';
  const author = (cached && cached.author) ? `@${cached.author}` : '等待刷新';
  return {
    type: 'widget',
    padding: 0,
    ...(cached && cached.page ? { url: cached.page } : {}),
    children: [{
      type: 'stack',
      direction: 'column',
      alignItems: 'start',
      gap: 1,
      children: [
        { type: 'text', text: title, font: { size: 'caption1', weight: 'semibold' }, maxLines: 1, minScale: 0.7 },
        { type: 'text', text: author, font: { size: 'caption2' }, opacity: 0.7, maxLines: 1 }
      ]
    }]
  };
}

function buildError(message, cfg, refreshAfter) {
  return {
    type: 'widget',
    refreshAfter,
    backgroundColor: '#1C1C1E',
    padding: 16,
    gap: 8,
    url: 'https://www.pixiv.net/',
    children: [
      { type: 'image', src: 'sf-symbol:exclamationmark.triangle.fill', color: '#FF9F0A', width: 24, height: 24 },
      { type: 'text', text: '加载失败', font: { size: 'headline', weight: 'bold' }, textColor: '#FFFFFF' },
      { type: 'text', text: message, font: { size: 'caption1' }, textColor: 'rgba(255,255,255,0.6)', maxLines: 3 },
      { type: 'spacer' },
      { type: 'text', text: '轻点打开 Pixiv', font: { size: 'caption2' }, textColor: 'rgba(255,255,255,0.35)', maxLines: 1 }
    ]
  };
}

/* ============================ 工具 ============================ */

function readJSON(ctx, key) {
  try {
    const raw = ctx.storage.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function writeJSON(ctx, key, value) {
  try {
    ctx.storage.set(key, JSON.stringify(value));
  } catch (_) {}
}

function clean(s) {
  return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
}
