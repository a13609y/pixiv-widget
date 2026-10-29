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
 * SOURCE         搜索源：第三方代理（默认，支持服务端横竖方筛选）/ 官方网页
 * RATIO          画幅筛选·全局（仅第三方代理有效）：自动 / 横图 / 方图 / 竖图
 * RATIO_SMALL / MEDIUM / LARGE / XLARGE
 *                各尺寸单独的画幅，优先于 RATIO；填「跟随全局」就用 RATIO
 *                （小号 / 中号 / 大号 / 超大号-iPad 各自独立，一个 widget 配置即可）
 *                候选池按「画幅|时段」分槽，不同画幅互不清池、各自保留翻页游标，
 *                history 仍全局共享，跨尺寸依然不会重复出图
 * API_BASE       第三方接口地址，默认 https://api.cocomi.eu.org
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
 * NO_REPEAT      防重复窗口：最近 N 张不重复，超过 N 张才允许重复  默认 30
 * MAX_HISTORY    旧名，等价于 NO_REPEAT（保留兼容）                            默认 120
 * IMAGE_QUALITY  auto（默认，小号 540 / 中大号 1200）| master | thumb
 * IMG_HOST       图床，默认 i.pixiv.re（大陆可用）
 * ASPECT_FIT     auto（默认，按尺寸挑画幅）| off（纯随机）
 * SHOW_INFO      true/false 图上叠加标题作者              默认 true
 * DEBUG          true/false 图左下角显示画幅/搜索次数，排障用  默认 false
 * TEXT_COLOR     叠加文字颜色                           默认 #FFFFFF
 * REQUEST_TIMEOUT 单次请求超时（秒）                      默认 15
 * ================================================================ */

const SCRIPT_VER = 'v4.13';   // 改动脚本时顺手 +1：调试角标第一段就是它，用来确认跑的是新代码

const K = {
  cache: 'sx5_cache_',       // + family
  pool: 'sx5_pool',
  history: 'sx5_history',
  lastShow: 'sx5_lastshow_', // + family
  debug: 'sx5_debug'
};

const DEFAULT_HOST = 'i.pixiv.re';
const FALLBACK_HOSTS = ['i.pixiv.re', 'i.pixiv.nl'];   // i.pixiv.cat 已全站 500，实测 i.pixiv.nl 可用
const PAGE_SIZE = 36;   // Pixiv 网页搜索固定每页 36 条
const MAX_POOL = 240;
const DEEP_MAX_PAGE = 50;   // 「重复即重拉」时最多翻到第几页（代理实测 60 页还有货，这里保守取 50）   // 候选池上限（只存元数据，很小）

export default async function(ctx) {
  const family = ctx.widgetFamily || 'systemSmall';
  const cfg = readConfig(ctx.env, family);
  const now = Date.now();

  // Cookie 来源：手填 > 抓包脚本存下的整串 > 抓到的单值
  // 不再根据「验证结果」决定用不用：验证受 Cloudflare 影响会误判
  const envRaw = normalizeCookie(String((ctx.env && ctx.env.PIXIV_COOKIE) || ''));
  const autoFull = (ctx.storage.get('pixiv_cookie_full') || '').trim();
  const autoSid = (ctx.storage.get('pixiv_phpsessid') || '').trim();
  const autoHeader = autoFull || (autoSid ? 'PHPSESSID=' + autoSid : '');
  if (cfg.cookieMode === 'manual') {
    cfg.cookieHeader = envRaw || autoHeader;
    cfg.cookieFrom = envRaw ? 'manual' : (autoHeader ? 'auto' : '');
  } else if (cfg.cookieMode === 'auto') {
    cfg.cookieHeader = autoHeader || envRaw;
    cfg.cookieFrom = autoHeader ? 'auto' : (envRaw ? 'manual' : '');
  } else {                       // 只用自动
    cfg.cookieHeader = autoHeader;
    cfg.cookieFrom = autoHeader ? 'auto' : '';
  }
  cfg.cookie = !!cfg.cookieHeader;
  // 服务端已经按画幅筛过了（代理模式 + 指定画幅），本地就别再挑，否则会白翻页
  if (cfg.source === 'proxy' && cfg.ratio) cfg.aspectFit = false;

  cfg.trendingEnabled = cfg.trendingMode === 'on'
    || (cfg.trendingMode === 'auto' && !!cfg.cookie);
  const cooldownMs = cfg.cooldownMin > 0 ? cfg.cooldownMin * 60000 : 0;
  // 整次渲染的时间预算：Egern 给的 60s 里留 15s 余量，超了就不再发新请求
  cfg.deadline = now + 45 * 1000;

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
  // 缓存要跟着搜索/画幅参数走：改了「画幅·中号」这类设置必须立刻生效，不能等冷却结束
  const sig = signature(cfg);
  const stale = !cached || cached.sig !== sig;

  if (cached && cached.dataUri && remaining > 0 && !stale) {
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
  // 统一成作品 id：旧版存的是图片 URL，这里就地迁移（URL 会因图床/代理差异对不上，去重会漏）
  history = history.map(x => (typeof x === 'number' ? x : pidFromUrl(x))).filter(x => Number(x) > 0);
  const historySet = new Set(history.map(String));

  // 候选池按「画幅 + 时段」分槽：不同尺寸各配一个画幅时互不清池，
  // 各自保留自己的翻页游标和 6 小时抑制标记；history 仍全局共享，防重复不受影响
  const poolKey = K.pool + '|' + (cfg.ratio || 'auto') + '|' + (cfg.period || 'all');
  let pool = readJSON(ctx, poolKey) || {};
  if (!Array.isArray(pool.items)) pool.items = [];
  // 搜索参数变了、或池子闲置超过 12 小时，都作废重来
  const poolTtlMs = cfg.poolTtlH > 0 ? cfg.poolTtlH * 3600 * 1000 : Infinity;
  const poolAge = now - (pool.createdAt || pool.ts || now);
  const poolIdle = now - (pool.ts || 0);
  const sigChanged = pool.sig !== sig;
  if (sigChanged || !pool.ts || poolAge > poolTtlMs || poolIdle > poolTtlMs) {
    // 配置变了 → 从第 1 页重来；只是到期（POOL_TTL）→ 丢掉缓存但保留翻页进度和搜索词，
    // 否则刚重建就要从第 1 页慢慢爬，而前几页全是看过的，会白等好几轮
    const prev = pool || {};
    pool = {
      items: [],
      ts: now,
      createdAt: now,
      page: sigChanged ? 1 : (prev.page || 1),
      sig
    };
    if (!sigChanged && prev.word) pool.word = prev.word;
  }

  let lastError = '';
  let errorStatus = null;
  let searches = 0;

  // ① 池里按画幅「严格」挑：区间内没有合适的就算没挑到，不再直接退让
  let candidate = pickFromPool(pool, historySet, family, cfg, true);
  if (candidate) {
    pool.ts = now;                 // 只要还在用就续命，避免剩一半被 TTL 丢掉
    writeJSON(ctx, poolKey, pool);
  }

  // ② 池里没有合适画幅 -> 继续往后翻页补货（同一次刷新最多 2 页）
  // 搜索词延迟到真要搜索时再取（否则池里有货也会白拉一次热门标签）
  let word = '';
  let picked = null;

  const barren = pool.barrenAt && now - pool.barrenAt < 6 * 3600 * 1000;
  const hasFresh = () => pool.items.some(it => it && it.url && !historySet.has(String(it.pid)));

  // 池里还有货，但全都在防重复窗口内
  const allSeen = pool.items.length > 0 && !hasFresh();
  const seenRecently = pool.allSeenAt && now - pool.allSeenAt < 6 * 3600 * 1000;
  while (!candidate && searches < 2) {
    // 池子彻底空了必须补货；池里还有货只是画幅不合，且这个标签已被判定画幅贫瘠，就不再白翻
    if (barren && hasFresh()) break;
    // 全部看过了、而且刚搜过 -> 不重复消耗请求，直接交给下面的随机兜底
    if (allSeen && seenRecently) break;
    try {
      if (!word) {
        // 池子已经有词就沿用，别每次刷新换一个热门标签把池子搅浑
        if (pool.word) { word = pool.word; picked = { source: 'pool' }; }
        else { picked = await pickWord(ctx, cfg); word = picked.word; pool.word = word; }
      }
      const res = await searchAny(ctx, cfg, pool.page || 1, word);
      searches++;
      const have = new Set(pool.items.map(it => String(it.pid)));
      const added = res.items.filter(it => it && it.pid && !have.has(String(it.pid)));
      pool.items = pool.items.concat(added).slice(-cfg.poolSize);
      pool.page = res.page;
      pool.ts = now;
      writeJSON(ctx, poolKey, pool);
      candidate = pickFromPool(pool, historySet, family, cfg, true);
      // 这一页全是看过的：别再白翻下一页，直接交给随机兜底
      if (!candidate && !pool.items.some(it => it && it.url && !historySet.has(String(it.pid)))) break;
    } catch (e) {
      lastError = e.message || '搜索失败';
      errorStatus = e.status || null;
      break;
    }
  }

  // ②b 翻了两页还是没有 -> 记一笔，6 小时内不再为画幅额外翻页
  if (!candidate && searches > 0) {
    pool.barrenAt = now;
    writeJSON(ctx, poolKey, pool);
  }

  // ③ 退而求其次：池里画幅最接近的「没看过」的图
  if (!candidate) {
    candidate = pickFromPool(pool, historySet, family, cfg, false);
    if (candidate) writeJSON(ctx, poolKey, pool);
  }

  // ③b 池里的图全看过了：按 ON_REPEAT 决定继续往后翻页拿新作品，还是直接轮播旧图
  if (!candidate && cfg.onRepeat === 'refetch') {
    for (let i = 0; i < 2 && !candidate; i++) {
      if (cfg.deadline && Date.now() > cfg.deadline - 6000) break;   // 别把整轮拖过小组件超时
      try {
        if (!word) {
          if (pool.word) { word = pool.word; picked = { source: 'pool' }; }
          else { picked = await pickWord(ctx, cfg); word = picked.word; pool.word = word; }
        }
        const res = await searchAny(ctx, cfg, pool.page || 1, word, true);   // deep：不回卷
        searches++;
        const have = new Set(pool.items.map(it => String(it.pid)));
        const added = res.items.filter(it => it && it.pid && !have.has(String(it.pid)));
        pool.items = pool.items.concat(added).slice(-cfg.poolSize);
        pool.page = res.page;
        pool.ts = now;
        pool.barrenAt = 0;             // 又能翻页了，撤销之前「画幅贫瘠」的抑制
        writeJSON(ctx, poolKey, pool);
        candidate = pickFromPool(pool, historySet, family, cfg, true);
        if (!added.length && res.items.length === 0) break;   // 后面真的没货了
      } catch (e) {
        lastError = e.message || '搜索失败';
        errorStatus = e.status || null;
        break;
      }
    }
  }

  // ④ 整个池子都在防重复窗口内 -> 按规则随机重复一张（并记下时间，6 小时内不再反复搜）
  if (!candidate) {
    candidate = pickAnyFromPool(pool, history, cfg.ratio);
    if (candidate) {
      pool.allSeenAt = now;
      writeJSON(ctx, poolKey, pool);
    }
  }

  if (!candidate) {
    const backoff = (errorStatus === 429 || errorStatus === 403) ? 45 : 15;
    if (cached && cached.dataUri) return buildWidget(cached, family, cfg, nextIso(backoff));
    return buildError(lastError || '暂无可用图片', cfg, nextIso(Math.min(backoff, 15)));
  }

  // ── 原创/同人校准 ─────────────────────────────────────────────
  // 第三方代理不给 isOriginal，只能按标签猜（没打标签的原创会漏）。
  // 选了筛选就补一次作品详情查询确认；查不到（风控/超时）就沿用标签判断，不阻塞
  if (candidate && cfg.originalMode !== 'any' && typeof candidate.isOriginal !== 'boolean') {
    let ok = false;
    for (let i = 0; i < 4 && candidate; i++) {
      const pid = candidate.pid;
      try {
        const r = await request(ctx, `https://www.pixiv.net/ajax/illust/${pid}`, {
          'Accept': 'application/json',
          'Referer': 'https://www.pixiv.net/',
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
        }, cfg);
        const b = await r.json().catch(() => null);
        const flag = b && b.error === false && b.body ? b.body.isOriginal : null;
        if (typeof flag !== 'boolean') {
          // 接口没给字段：退回标签判断，宁可少出图也别把同人当原创放出去
          ok = cfg.originalMode === 'only' ? isOriginalWork(candidate) : !isOriginalWork(candidate);
          break;
        }
        candidate.isOriginal = flag;
        if ((cfg.originalMode === 'only') === flag) { ok = true; break; }
      } catch (e) {
        // 风控/超时：同样退回标签判断，不把整轮拖死
        ok = cfg.originalMode === 'only' ? isOriginalWork(candidate) : !isOriginalWork(candidate);
        break;
      }
      historySet.add(String(pid));                            // 这张不符合，拉黑后重挑
      candidate = pickFromPool(pool, historySet, family, cfg, true) || pickAnyFromPool(pool, history, cfg.ratio);
    }
    if (!ok) candidate = null;                                // 一张都不符合：宁可留旧图
  }

  if (!candidate) {
    if (cached && cached.dataUri) return buildWidget(cached, family, cfg, nextIso(10));
    return buildError('没有符合「原创 / 同人」筛选的作品', cfg, nextIso(15));
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
    repeat: !!candidate.__repeat,
    aspect: candidate.__aspect || null,
    searches,
    wordSource: picked ? picked.source : '',
    seenText,
    origin: candidate.url,
    url: img.url,
    dataUri: img.dataUri,
    uiSig: uiSignature(cfg),
    sig,
    sortWarn: cfg.source === 'proxy' && cfg.order === 'popular_d' && cfg.cookie,   // 已改走网页排序
    sortDegraded: cfg.order === 'popular_d' && !cfg.cookie,                        // 未登录，两个源都排不出热度
    proxyWarn: (() => {
      try {
        const r = JSON.parse(ctx.storage.get('pixiv_proxy_err') || 'null');
        return !!(r && r.at && now - r.at < 10 * 60 * 1000);
      } catch (e) { return false; }
    })(),
    at: now
  };

  writeJSON(ctx, K.cache + family, entry);
  const hp = history.indexOf(candidate.pid);
  if (hp >= 0) history.splice(hp, 1);   // 轮转：重新展示的图挪到队尾
  history.push(candidate.pid);
  while (history.length > cfg.maxHistory) history.shift();
  writeJSON(ctx, K.history, history);
  ctx.storage.set(K.lastShow + family, String(now));
  writeJSON(ctx, K.debug, {
    at: now,
    pid: entry.pid,
    pool: pool.items.length,
    page: pool.page,
    searches,
    repeat: !!candidate.__repeat,
    aspect: candidate.__aspect || null,
    ai: !!candidate.ai,
    aiMode: cfg.aiMode,
    word: typeof word === 'string' ? word : '',
    wordSource: picked ? picked.source : '',
    seenText,
    cookie: cfg.cookie ? 'on' : 'off',
    cookieFrom: cfg.cookieFrom || '',
    error: lastError || null
  });

  return buildWidget(entry, family, cfg, nextIso(cfg.cooldownMin > 0 ? cfg.cooldownMin : 15));
}

/* ============================ 配置 ============================ */

// 手动输入容错：
//   整串 Cookie（含 = 或 ;）→ 原样透传，保留 cf_clearance 等风控 Cookie
//   只粘了 32 位值          → 补上 PHPSESSID=
function normalizeCookie(raw) {
  const v = String(raw || '').trim().replace(/^["']|["']$/g, '');
  if (!v) return '';
  if (v.indexOf('=') >= 0 || v.indexOf(';') >= 0) return v;
  return 'PHPSESSID=' + v.replace(/\s+/g, '');
}

// 模块设置里的选项是中文标签，这里映射回内部值；同时兼容旧的英文值
const VALUE_MAP = {
  order: {
    '最新发布': 'date_d', 'date_d': 'date_d', 'date_desc': 'date_d',
    '人气最高': 'popular_d', 'popular_d': 'popular_d'
  },
  type: {
    '只要插画': 'illust', 'illust': 'illust',
    '只要漫画': 'manga', 'manga': 'manga',
    '插画+漫画': 'all', 'all': 'all'
  },
  ai: {
    '不筛选': 'any', 'any': 'any',
    '只要AI生成': 'only', 'only': 'only',
    '排除AI生成': 'exclude', 'exclude': 'exclude'
  },
  trending: {
    '自动': 'auto', 'auto': 'auto',
    '总是使用': 'on', 'on': 'on',
    '关闭': 'off', 'off': 'off'
  },
  quality: {
    '自动': 'auto', 'auto': 'auto',
    '高清1200': 'master', 'master': 'master',
    '省流540': 'thumb', 'thumb': 'thumb'
  },
  aspect: {
    '自动匹配': 'auto', 'auto': 'auto',
    '纯随机': 'off', 'off': 'off'
  },
  source: {
    '第三方代理': 'proxy', 'proxy': 'proxy',
    '官方网页': 'web', 'web': 'web'
  },
  r18: {
    '排除R18': 'none', '排除': 'none', 'false': 'none', 'off': 'none', '关闭': 'none',
    '只要R18': 'only', 'only': 'only',
    '全部': 'all', '允许R18': 'all', '允许': 'all', 'true': 'all', 'on': 'all', '开启': 'all'
  },
  cookieSource: {
    '手动优先': 'manual', 'manual': 'manual',
    '自动优先': 'auto', 'auto': 'auto',
    '只用自动': 'auto_only', 'auto_only': 'auto_only'
  },
  period: {
    '不限': '', 'day': 'day', 'week': 'week', 'month': 'month',
    'half_year': 'half_year', 'year': 'year',
    '一天内': 'day', '一周内': 'week', '一个月内': 'month', '半年内': 'half_year', '一年内': 'year'
  },
  original: {
    '不筛选': 'any', 'any': 'any',
    '只要原创': 'only', 'only': 'only',
    '只要同人': 'fan', 'fan': 'fan', '排除原创': 'fan'
  },
  ratio: {
    '自动': '', '全部': '', 'landscape': 'landscape', 'square': 'square', 'portrait': 'portrait',
    '横图': 'landscape', '方图': 'square', '竖图': 'portrait'
  }
};

// 分尺寸画幅：「跟随全局」（默认）表示回落到底部的 RATIO 那一栏
const RATIO_BY_FAMILY = {
  systemSmall: 'RATIO_SMALL',
  systemMedium: 'RATIO_MEDIUM',
  systemLarge: 'RATIO_LARGE',
  systemExtraLarge: 'RATIO_XLARGE'
};
VALUE_MAP.ratioOverride = Object.assign({ '跟随全局': '', '跟随': '', 'global': '' }, VALUE_MAP.ratio);

function pickMapped(raw, map, def) {
  const v = String(raw || '').trim();
  if (!v) return def;
  return map[v] || map[v.toLowerCase()] || def;
}

function readConfig(env, family) {
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

  const poolSize = int('POOL_SIZE', MAX_POOL, 60, 2000);

  let host = s('IMG_HOST', DEFAULT_HOST)
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '');
  if (!host || host.indexOf('.') < 0) host = DEFAULT_HOST;

  return {
    source: pickMapped(s('SOURCE', '第三方代理'), VALUE_MAP.source, 'proxy'),
    ratio: (() => {
      const ownKey = RATIO_BY_FAMILY[family] || '';
      const own = ownKey ? pickMapped(s(ownKey, '跟随全局'), VALUE_MAP.ratioOverride, '') : '';
      return own || pickMapped(s('RATIO', '自动'), VALUE_MAP.ratio, '');
    })(),
    period: pickMapped(s('PERIOD', '不限'), VALUE_MAP.period, ''),
    cookieMode: pickMapped(s('COOKIE_SOURCE', '手动优先'), VALUE_MAP.cookieSource, 'manual'),
    r18Mode: pickMapped(s('R18', '排除R18'), VALUE_MAP.r18, 'none'),
    apiBase: s('API_BASE', 'https://api.cocomi.eu.org').replace(/\/+$/, ''),
    keyword: s('KEYWORD', ''),
    pixivWord: s('PIXIV_WORD', ''),
    tags: list('TAGS', 10),
    wordMode: oneOf('WORD_MODE', 's_tag', ['s_tag', 's_tag_full', 's_tc']),
    order: pickMapped(s('ORDER', 'date_d'), VALUE_MAP.order, 'date_d'),
    type: pickMapped(s('TYPE', '只要插画'), VALUE_MAP.type, 'illust'),
    maxPage: int('MAX_PAGE', 3, 1, 1000),
    aiMode: pickMapped(s('AI_MODE', '不筛选'), VALUE_MAP.ai, 'any'),
    originalMode: pickMapped(s('ORIGINAL', '不筛选'), VALUE_MAP.original, 'any'),
    excludeTags: list('EXCLUDE_TAGS', 20),
    trendingMode: pickMapped(s('TRENDING', '自动'), VALUE_MAP.trending, 'auto'),
    cookie: '',            // 运行时解析：env > 抓包脚本存储
    trendingEnabled: false,
    cooldownMin: int('COOLDOWN', 30, 0, 24 * 60),
    poolSize,   // 候选池最多存多少条（只影响缓存，不影响每次翻页取多少）
    // 池子闲置多久后作废重建（0 = 永不）；一直在用（每次挑图都会续 ts）不会重建
    poolTtlH: (() => {
      const raw = s('POOL_TTL', '12');
      if (/不限|永不|never/i.test(raw)) return 0;
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? Math.min(720, Math.max(1, n)) : 12;
    })(),
    // 池子全看过时：refetch = 继续往后翻页拿新作品；repeat = 直接轮播旧图
    onRepeat: /重复旧图|repeat/i.test(s('ON_REPEAT', '重新拉取')) ? 'repeat' : 'refetch',
    // 「永不再重」= 记住 2000 张；其余按数值。默认 100（原来 30，四个尺寸一分就没剩多少）
    maxHistory: (() => {
      let cap;
      const raw = s('NO_REPEAT', '');
      if (/永不再重|永久|forever/i.test(raw)) cap = 2000;
      else cap = int('NO_REPEAT', int('MAX_HISTORY', 100, 1, 2000), 1, 2000);
      // 窗口至少要能装下整个候选池，否则「池子还没走完就有图掉出窗口」→ 提前复现
      return Math.max(cap, poolSize);
    })(),
    quality: pickMapped(s('IMAGE_QUALITY', '自动'), VALUE_MAP.quality, 'auto'),
    imgHost: host,
    aspectFit: pickMapped(s('ASPECT_FIT', '自动匹配'), VALUE_MAP.aspect, 'auto') !== 'off',
    // 标题、作者分开控制；两个都没填时沿用旧的 SHOW_INFO
    showTitle: bool('SHOW_TITLE', bool('SHOW_INFO', true)),
    showAuthor: bool('SHOW_AUTHOR', bool('SHOW_INFO', true)),
    debug: bool('DEBUG', false),
    textColor: s('TEXT_COLOR', '#FFFFFF'),
    timeoutMs: int('REQUEST_TIMEOUT', 15, 5, 60) * 1000
  };
}

function uiSignature(cfg) {
  return [cfg.showTitle, cfg.showAuthor, cfg.debug, cfg.textColor].join('|');
}

function signature(cfg) {
  return [cfg.keyword, cfg.pixivWord, cfg.tags.join(','), cfg.order, cfg.type, cfg.wordMode, cfg.imgHost, cfg.maxPage, cfg.aiMode, cfg.originalMode, cfg.excludeTags.join(','), cfg.source, cfg.ratio, cfg.period, cfg.apiBase, cfg.r18Mode].join('|');
}

function nextIso(minutes) {
  return new Date(Date.now() + Math.max(1, minutes) * 60000).toISOString();
}

/* ============================ 搜索 ============================ */

async function searchPixiv(ctx, cfg, page, word, deep) {
  let p = Math.max(1, page | 0);
  // AI 过滤后可能整页都是空的，允许往后多翻 1 页碰运气（最多 2 次请求）
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetchSearchPage(ctx, cfg, word, p, deep);

    const pass = applyFilters(res.items, cfg);

    if (pass.length > 0) return { items: pass, page: res.page };

    // 本页被过滤光了：往后翻一页再试，翻不动就报错
    if (attempt === 0 && p < res.lastPage) { p = p + 1; continue; }

    let msg = '这一页没有符合条件的作品';
    if (cfg.r18Mode === 'only' && cfg.source !== 'proxy') {
      msg = '网页端未登录拿不到 R18：请改用第三方代理，或登录后保存 Cookie';
    }
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

// 时段 → 起始日期（官方网页搜索用 scd 参数，实测有效）
function periodStart(period) {
  const days = { day: 1, week: 7, month: 30, half_year: 180, year: 365 }[period] || 0;
  if (!days) return '';
  const d = new Date(Date.now() - days * 24 * 3600 * 1000);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

async function searchAny(ctx, cfg, page, word, deep) {
  // 代理固定 content_type=illust（要漫画只能走网页）；且实测它忽略 sort，
  // 选了「人气最高」时先打代理只会拿到最新，直接改走网页搜索
  const proxyUsable = cfg.source === 'proxy' && cfg.type !== 'manga'
    && !(cfg.order === 'popular_d' && cfg.cookie);   // 未登录时网页也排不出热度，留在代理保住服务端画幅筛选
  if (proxyUsable) {
    try {
      return await searchProxy(ctx, cfg, page, word, deep);
    } catch (e) {
      // 第三方接口挂了就退回官方网页搜索，不让小组件空着
      ctx.storage.set('pixiv_proxy_err', JSON.stringify({ at: Date.now(), msg: String((e && e.message) || e).slice(0, 120) }));
    }
  }
  return await searchPixiv(ctx, cfg, page, word, deep);
}

// 第三方 Pixiv 代理（hibiapi 系）：服务端支持 ratio_pattern 横竖方筛选
async function searchProxy(ctx, cfg, page, word, deep) {
  const p = Math.max(1, page | 0);
  const qs = [
    'word=' + encodeURIComponent(word),
    'page=' + p,
    'content_type=illust',
    'sort=' + (cfg.order === 'popular_d' ? 'popular_desc' : 'date_desc')
  ];
  if (cfg.ratio) qs.push('ratio_pattern=' + cfg.ratio);
  if (cfg.period) qs.push('duration=within_last_' + cfg.period);

  const resp = await request(ctx, cfg.apiBase + '/api/pixiv/search?' + qs.join('&'), {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1 PixivViewer/1'
  }, cfg);

  const body = await resp.json().catch(() => null);
  if (!body || !Array.isArray(body.illusts)) {
    throw new Error('代理接口返回异常');
  }

  const items = body.illusts
    .filter(it => it && it.id && it.width && it.height && it.type !== 'ugoira')
    .map(it => {
      const urls = it.image_urls || {};
      const user = it.user || {};
      const tags = Array.isArray(it.tags)
        ? it.tags.map(t => (t && (t.name || t.translated_name)) || '').filter(Boolean)
        : [];
      return {
        pid: it.id,
        page: `https://www.pixiv.net/artworks/${it.id}`,
        title: it.title,
        author: user.name || user.account || '',
        tags,
        width: it.width,
        height: it.height,
        pageCount: it.page_count,
        ai: it.illust_ai_type === 2,
        r18: it.x_restrict === 1 || it.x_restrict === 2 || it.restrict === 1,
        url: urls.square_medium || urls.medium || urls.large || ''
      };
    })
    .filter(it => it.url && /\.(png|jpe?g|gif|webp)$/i.test(it.url.split('?')[0]))
    .filter(it => {
      if (cfg.type === 'illust') return true;      // 接口已按 content_type=illust 过滤
      if (cfg.type === 'manga') return false;
      return true;
    });

  const passed = applyFilters(items, cfg);
  if (passed.length === 0) throw new Error('代理接口没有符合条件的结果');

  const lastPage = Math.min(cfg.maxPage, DEEP_MAX_PAGE);
  // deep：池子看光了就继续往后翻拿新作品，而不是回卷到第 1 页重看一遍
  const next = deep ? Math.min(DEEP_MAX_PAGE, p + 1) : (p >= lastPage ? 1 : p + 1);
  return { items: passed, page: next };
}

async function fetchSearchPage(ctx, cfg, word, p, deep) {
  const qs = [
    `word=${encodeURIComponent(word)}`,
    `order=${cfg.order}`,
    cfg.r18Mode === 'none' ? 'mode=safe' : 'mode=all',  // 排除时只取全年龄
    `p=${p}`,
    `s_mode=${cfg.wordMode}`,
    'type=all',                        // 服务端 type 参数无效，过滤在本地做
    'lang=zh'
  ];
  if (cfg.period) qs.push('scd=' + periodStart(cfg.period));

  const joined = qs.join('&');

  const url = `https://www.pixiv.net/ajax/search/artworks/${encodeURIComponent(word)}?${joined}`;
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
      isOriginal: it.isOriginal === true,   // pixiv 官方的「原创」标记，网页搜索里直接有
      r18: it.xRestrict === 1 || it.xRestrict === 2,
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
  const lastPage = Math.min(totalPages, deep ? Math.max(cfg.maxPage, 30) : cfg.maxPage);

  if (items.length === 0) {
    const err = new Error(p === 1 ? `「${word}」在 Pixiv 没有搜索结果` : '该标签已翻到最后一页');
    err.status = 200;
    throw err;
  }

  const nextPage = deep ? p + 1 : (p >= lastPage ? 1 : p + 1);
  return { items, page: nextPage, lastPage };
}

// 剩余预算：总时限内单次请求最多等 cfg.timeoutMs，预算快用完就缩短，避免整轮超时
function budgetMs(cfg, def) {
  const left = cfg.deadline ? cfg.deadline - Date.now() : def;
  return Math.max(2500, Math.min(def, left));
}

async function request(ctx, url, headers, cfg) {
  if (cfg.cookieHeader && !headers['Cookie']) headers['Cookie'] = cfg.cookieHeader;
  let resp;
  try {
    resp = await ctx.http.get(url, { headers, timeout: budgetMs(cfg, cfg.timeoutMs) });
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

// 显式指定画幅时的目标比例 / 判定：只要用户选了画幅，本地必须兜住，
// 不能因为「代理挂了退回网页搜索」就把方图塞给中号
const RATIO_TARGET = { landscape: 1.78, square: 1.0, portrait: 0.65 };

function arOf(it) {
  return (it && it.width && it.height) ? it.width / it.height : 0;
}

function matchesRatio(it, ratio) {
  const ar = arOf(it);
  if (!ar) return false;
  if (ratio === 'landscape') return ar >= 1.4;
  if (ratio === 'portrait') return ar < 0.85;
  return ar >= 0.85 && ar < 1.4;   // square
}

// 选了画幅就用画幅定目标，别再按「这个尺寸长什么样」猜（网页模式/Debug 一致）
function bandsFor(ratio) {
  if (ratio === 'landscape') return [[1.4, 99], [0.62, 1.45]];
  if (ratio === 'portrait') return [[0, 0.85], [0.62, 1.45]];
  if (ratio === 'square') return [[0.85, 1.4], [0.62, 1.45]];
  return null;
}

function pickByAspect(items, family, aspectFit, strict, ratio) {
  if (!items || items.length === 0) return null;
  const target = (ratio && RATIO_TARGET[ratio]) || targetAspect(family);

  if (!aspectFit) {
    // 指定了画幅就按「离该画幅最近」挑（服务端已筛过时等价于随机，兜底时能挡住方图）
    if (ratio && RATIO_TARGET[ratio]) {
      const t2 = RATIO_TARGET[ratio];
      const ranked = items
        .map(it => ({ it, score: arOf(it) > 0 ? Math.abs(Math.log(arOf(it) / t2)) : 9 }))
        .sort((a, b) => a.score - b.score)
        .slice(0, 3);
      const best = ranked[Math.floor(Math.random() * ranked.length)].it;
      best.__aspect = { target, ar: +arOf(best).toFixed(2) || null, band: 'ratio' };
      return best;
    }
    const pick = items[Math.floor(Math.random() * items.length)];
    const ar = arOf(pick);
    pick.__aspect = { target, ar: ar ? +ar.toFixed(2) : null, band: 'skip' };
    return pick;
  }

  const tiers = bandsFor(ratio) || aspectTiers(family);
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

// 池内全部都在防重复窗口内时用：忽略历史，随机取一张并标记「重复」
// 池里的图全在防重复窗口内时：挑「最久没出现过」的那张，形成轮转而不是随机重复
function pickAnyFromPool(pool, history, ratio) {
  if (!pool || !Array.isArray(pool.items) || pool.items.length === 0) return null;
  let items = pool.items;
  if (ratio) {
    const ok = items.filter(it => it && matchesRatio(it, ratio));
    if (!ok.length) return null;      // 池子里没有这个画幅的旧图，就别拿别的将就
    items = ok;
  }
  const rank = new Map();
  (history || []).forEach((pid, i) => rank.set(String(pid), i));
  let best = null;
  let bestRank = Infinity;
  for (const it of items) {
    if (!it || !it.url) continue;
    const r = rank.has(String(it.pid)) ? rank.get(String(it.pid)) : -1;
    if (r < bestRank) { bestRank = r; best = it; }
  }
  if (!best) best = items[0];
  best.__repeat = true;
  return best;
}

function pickFromPool(pool, historySet, family, cfg, strict) {
  if (!pool || !Array.isArray(pool.items) || pool.items.length === 0) return null;
  let fresh = pool.items.filter(it => it && it.url && !historySet.has(String(it.pid)));
  if (fresh.length === 0) return null;

  // 选了画幅：先在「实际画幅符合」的条目里挑；严格模式下没有就返回 null 让外层再翻页
  if (cfg.ratio) {
    const ok = fresh.filter(it => matchesRatio(it, cfg.ratio));
    if (!ok.length) return null;      // 指定了画幅就绝不跨画幅将就（哪怕是非严格模式）
    fresh = ok;
  }

  const picked = pickByAspect(fresh, family, cfg.aspectFit, strict, cfg.ratio);
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

/* ========================= 作品过滤 ========================= */

// AI 与排除标签统一在这里处理：两个搜索源都要经过
// 判断是不是「原创」作品：
//   网页搜索直接带 isOriginal 字段（准确）；
//   第三方代理没有这个字段，只能退回「オリジナル」标签近似 —— 会漏掉没打标签的原创
function isOriginalWork(it) {
  if (typeof it.isOriginal === 'boolean') return it.isOriginal;
  const tags = Array.isArray(it.tags) ? it.tags : [];
  return tags.some(t => /オリジナル/i.test(String(t)) || String(t).trim() === '原创');
}

function applyFilters(items, cfg) {
  return items.filter(it => {
    // 第三方接口无视 mode/r18 参数，只能本地按 x_restrict 排
    if (cfg.r18Mode === 'none' && it.r18) return false;
    if (cfg.r18Mode === 'only' && !it.r18) return false;
    // 有 isOriginal 字段就直接按字段判（网页模式）
    // 没有字段（代理）：只要同人先用标签粗筛；只要原创则放行，交给后面的详情补查，
    // 否则「没打标签的原创」会被标签提前丢掉，永远找不回来
    if (cfg.originalMode === 'only') {
      if (typeof it.isOriginal === 'boolean' && !it.isOriginal) return false;
    } else if (cfg.originalMode === 'fan') {
      if (isOriginalWork(it)) return false;
    }
    if (cfg.aiMode === 'only' && !it.ai) return false;
    if (cfg.aiMode === 'exclude' && it.ai) return false;
    if (isExcluded(it, cfg.excludeTags)) return false;
    return true;
  });
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
// 从图片 URL 里抠作品 id（旧版 history 存的是 URL，迁移要用）
function pidFromUrl(u) {
  const m = /(\d+)_p\d+/.exec(String(u || ''));
  return m ? Number(m[1]) : 0;
}

function imageStem(rawUrl) {
  const m = /^https?:\/\/[^/]+(\/.*)$/.exec(String(rawUrl || ''));
  if (!m) return null;
  let path = m[1];
  path = path.replace(/^\/c\/[^/]+\//, '/');   // 去掉 CDN 的 /c/250x250_80_a2/
  path = path.replace('/img-original/', '/img-master/');
  path = path.replace('/custom-thumb/', '/img-master/'); // 自定义缩略图的作品，原图仍在 img-master
  // 连扩展名一起留下：png 作品拼成 .jpg 会 404（pixiv 的 1200 档后缀跟原图一致）
  const fm = /^(.*_p\d+?)(?:_square1200|_master1200|_custom1200)?\.(png|jpe?g|gif|webp)$/i.exec(path);
  return fm ? { stem: fm[1], ext: fm[2].toLowerCase() } : null;
}

function hostOf(url) {
  const m = /^https?:\/\/([^/]+)/.exec(String(url || ''));
  return m ? m[1] : '';
}

function candidateSources(item, cfg, family) {
  const info = imageStem(item.url);
  if (!info) return [item.url]; // 推不出来就直连原地址

  // 原图后缀优先，再退回 jpg/png（有些作品的 1200 档只在其中一种后缀下存在）
  const exts = [info.ext].concat(['jpg', 'png'].filter(e => e !== info.ext));
  const hosts = [cfg.imgHost].concat(FALLBACK_HOSTS.filter(h => h !== cfg.imgHost));
  const master = [];
  const square = [];
  for (const h of hosts) {
    for (const e of exts) master.push(`https://${h}${info.stem}_master1200.${e}`);
    square.push(`https://${h}/c/540x540_70${info.stem}_square1200.jpg`);
  }

  const quality = cfg.quality === 'auto'
    ? (family === 'systemSmall' ? 'thumb' : 'master')
    : cfg.quality;

  // 中号/大号绝不拿方图打头：_square1200 是 1200 的方裁图，等比只有 _master1200
  return quality === 'thumb'
    ? square.concat(master.slice(0, 2))
    : master.slice(0, 3).concat(square.slice(0, 1));
}

async function download(ctx, url, cfg) {
  let resp;
  try {
    resp = await ctx.http.get(url, {
      headers: { 'Referer': 'https://www.pixiv.net/', 'User-Agent': 'Egern/PixivWidget 4.0' },
      timeout: budgetMs(cfg, cfg.timeoutMs)
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
  const looksImage = (bytes[0] === 0xff && bytes[1] === 0xd8)      // jpeg
    || (bytes[0] === 0x89 && bytes[1] === 0x50)                    // png
    || (bytes[0] === 0x47 && bytes[1] === 0x49)                    // gif
    || (bytes[8] === 0x57 && bytes[9] === 0x45);                   // webp
  if (bytes.byteLength < 1024 || !looksImage) {
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
  const children = [];
  const lines = [];

  const showTitle = cfg.showTitle && entry && entry.title;
  const showAuthor = cfg.showAuthor && !isSmall && entry && entry.author;

  if (showTitle || showAuthor) {
    if (showTitle) {
      lines.push({
        type: 'text',
        text: entry.title,
        font: { size: isSmall ? 'caption1' : 'subheadline', weight: 'bold' },
        textColor: cfg.textColor,
        maxLines: 1,
        minScale: 0.7
      });
    }
    if (showAuthor) {
      lines.push({
        type: 'text',
        text: `@${entry.author}`,
        font: { size: 'caption2' },
        textColor: 'rgba(255,255,255,0.78)',
        maxLines: 1,
        minScale: 0.75
      });
    }
  }

  // 调试角标独立于「显示标题作者」：以前它嵌在 SHOW_INFO 里，
  // 一关掉标题角标就跟着消失，看起来像开关失效
  if (cfg.debug) {
    const asp = entry.aspect || {};
    lines.push({
      type: 'text',
      text: `${SCRIPT_VER} ${cfg.cookie ? '🔑' : '🔒'} ${cfg.ratio || '自动'} ${asp.ar || '-'}/${asp.target || '-'} · ${asp.band || '无'}${entry.repeat ? ' · ♻重复' : ''}${entry.proxyWarn ? ' · ⚠代理回退' : ''}${entry.sortWarn ? ' · ↗网页排序' : ''}${entry.sortDegraded ? ' · ⚠无人气排序' : ''} · ${entry.wordSource || '-'} · 拦截${entry.seenText || '无'}`,
      font: { size: 'caption2' },
      textColor: 'rgba(255,255,255,0.55)',
      maxLines: 1
    });
  }

  if (lines.length) {
    children.push({ type: 'spacer' });
    // 关键：渐变挂在一个「行栈」上，行栈里塞一个弹性 spacer，
    // 行栈就会被撑到整宽，渐变才能铺满左右边缘；
    // 如果直接把渐变挂在文字列上，列栈只有内容宽度，左右会突然断掉。
    children.push({
      type: 'stack',
      direction: 'row',
      alignItems: 'end',
      gap: 0,
      padding: [32, 12, 10, 12],       // 上方 32pt 全部用于渐变过渡，避免一刀切
      backgroundGradient: {
        type: 'linear',
        // 四段缓入：0 → 0.08 → 0.42 → 0.86，比两段 0→0.78 平滑得多
        colors: ['rgba(0,0,0,0)', 'rgba(0,0,0,0.08)', 'rgba(0,0,0,0.42)', 'rgba(0,0,0,0.86)'],
        stops: [0, 0.3, 0.62, 1],
        startPoint: { x: 0.5, y: 0 },
        endPoint: { x: 0.5, y: 1 }
      },
      children: [
        {
          type: 'stack',
          direction: 'column',
          alignItems: 'start',
          gap: 2,
          children: lines
        },
        { type: 'spacer' }
      ]
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
