// ==UserScript==
// @Name         Pixiv PHPSESSID 自动抓取
// @Platform     Egern
// @Type         http_request
// @Author       Cuttlefish
// @Version      1.6.0
// ==/UserScript==

/* ================================================================
 * 作用：在 Egern 代理下浏览 pixiv.net 时，自动从请求头 Cookie 里
 *       提取 PHPSESSID 并写入持久化存储，供「Pixiv 每日美图」小组件使用。
 *
 * 存储键：
 *   pixiv_phpsessid        32 位十六进制会话 ID
 *   pixiv_phpsessid_at     最近一次见到它的时间戳
 *   pixiv_phpsessid_state  login / guest
 *   pixiv_phpsessid_check  上次校验时间（10 分钟复验一次）
 *   pixiv_mitm_seen        拦截到「不带 Cookie 的请求」时打点，用来判断 MITM 是否生效
 *
 * 三种通知：
 *   ✅ MITM 已生效      —— 说明脚本确实被调用，但这条请求没带 Cookie
 *   🔒 游客态 / 失效
 *   🔑 登录态已接管
 * ================================================================ */

const KEY_SID = 'pixiv_phpsessid';
const KEY_AT = 'pixiv_phpsessid_at';
const KEY_STATE = 'pixiv_phpsessid_state';
const KEY_CHECK = 'pixiv_phpsessid_check';
const KEY_SEEN = 'pixiv_mitm_seen';
const RECHECK_MS = 10 * 60 * 1000;

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

export default async function (ctx) {
  try {
    // 抓取开关：关闭后完全不动存储、不发通知，只透传
    const sw = String((ctx.env && ctx.env.AUTO_CAPTURE) || '开启').trim();
    if (/^(关闭|off|false|0|no)$/i.test(sw)) return;

    // Cookie 头可能被合并成一条（; 或 , 或空格分隔），先 getAll 再拼
    let raw = '';
    try {
      const all = ctx.request.headers.getAll ? ctx.request.headers.getAll('cookie') : null;
      if (Array.isArray(all) && all.length) raw = all.join('; ');
    } catch (_) {}
    if (!raw) raw = ctx.request.headers.get('cookie') || '';

    const now = Date.now();
    ctx.storage.set('pixiv_seen_at', String(now));

    const m = /(?:^|[;,\s])\s*PHPSESSID\s*=\s*([0-9A-Za-z%._-]{8,128})/i.exec(raw);
    const url = String((ctx.request && ctx.request.url) || '');

    // 首次运行自检：把「看到了什么」直接告诉你，不依赖是否抓到
    if (!ctx.storage.get(KEY_SEEN)) {
      ctx.storage.set(KEY_SEEN, String(now));
      const names = raw
        .split(/[;,\s]+/)
        .map(x => x.split('=')[0])
        .filter(Boolean)
        .slice(0, 12);
      ctx.notify({
        title: m ? '🔑 已抓到 PHPSESSID' : (raw ? '⚠️ Cookie 里没有 PHPSESSID' : '✅ MITM 生效但无 Cookie 头'),
        body: 'cookie头=' + (raw ? raw.length + '字符' : '无') +
              ' | 键: ' + (names.length ? names.join(',') : '无') +
              ' | ' + url.replace('https://www.pixiv.net', '').slice(0, 40),
        sound: false
      });
    }

    if (!m) return;

    const sid = m[1];

    // 先读旧值再写，否则 prevSid 永远等于 sid，sidChanged 永远是 false（通知永远不触发）
    const prevSid = ctx.storage.get(KEY_SID) || '';
    const prevState = ctx.storage.get(KEY_STATE) || '';
    const lastCheck = Number(ctx.storage.get(KEY_CHECK) || 0) || 0;
    const sidChanged = prevSid !== sid;

    ctx.storage.set(KEY_AT, String(now));
    ctx.storage.set(KEY_SID, sid);

    // 经验值：登录态 Cookie 通常上千字符，游客态只有几百
    const logged = raw.length >= 1000;
    const prevFull = (ctx.storage.get('pixiv_cookie_full') || '').length;

    // 短的（游客）不覆盖之前的长 Cookie，避免把登录态冲掉
    if (logged || prevFull < 1000) {
      if (raw && raw.length < 6000) ctx.storage.set('pixiv_cookie_full', raw);
    }

    if (!sidChanged && now - lastCheck < RECHECK_MS) return;

    let state = null;
    let netErr = '';
    try {
      const resp = await ctx.http.get('https://www.pixiv.net/ajax/search/trending/tags?lang=zh', {
        headers: {
          'Cookie': raw,
          'Referer': 'https://www.pixiv.net/',
          'User-Agent': UA,
          'Accept': 'application/json'
        },
        timeout: 8000
      });
      const body = await resp.json().catch(() => null);
      if (body) state = body.error === false ? 'login' : 'guest';
    } catch (e) {
      netErr = String((e && e.message) || e || '网络错误');
    }

    if (!state) {
      // 验证失败：保留 Cookie，标成 unknown，让小组件可以试着用；每 30 分钟最多提示一次
      const lastWarn = Number(ctx.storage.get('pixiv_verify_warn') || 0) || 0;
      if (!prevState) ctx.storage.set(KEY_STATE, 'unknown');
      if (now - lastWarn > 30 * 60 * 1000) {
        ctx.storage.set('pixiv_verify_warn', String(now));
        ctx.notify({
          title: '⚠️ 抓到 Cookie，但验证失败',
          body: netErr.slice(0, 120) + '（Cookie 已保存，稍后自动重试）',
          sound: false
        });
      }
      return;
    }

    ctx.storage.set(KEY_CHECK, String(now));
    if (!state) return;

    ctx.storage.set(KEY_SID, sid);
    ctx.storage.set(KEY_STATE, state);
    ctx.storage.set(KEY_SEEN, String(now));

    // 通知：只要抓到「新的 Cookie」就提示，不再依赖验证结果
    // （Cloudflare 会让只带 PHPSESSID 的验证请求误判为游客，但 Cookie 本身可用）
    if (sidChanged) {
      const lastNotify = Number(ctx.storage.get('pixiv_notify_at') || 0) || 0;
      const important = logged && prevFull < 1000;   // 首次从游客升级到登录态，一定要提示
      if (important || now - lastNotify > 60 * 60 * 1000) {
        ctx.storage.set('pixiv_notify_at', String(now));
        ctx.notify({
          title: logged ? '🔑 已抓到 Pixiv Cookie' : '🔒 抓到的是游客 Cookie',
          body: '长度 ' + raw.length + ' 字符' +
                (logged ? ' · 已存入，小组件可用' : ' · 太短，已跳过（保留之前的登录 Cookie）') +
                (state === 'login' ? ' · 验证：登录态正常' : ''),
          sound: false
        });
      }
    } else if (state === 'login' && prevState !== 'login') {
      ctx.notify({
        title: '🔑 Pixiv 登录态已接管',
        body: '小组件现在会跟随热门搜索',
        sound: false
      });
    } else if (prevState === 'login' && state === 'guest') {
      ctx.notify({
        title: '🔒 Pixiv 登录态失效',
        body: '会话已过期，请在浏览器重新登录 pixiv.net',
        sound: false
      });
    }
  } catch (e) {
    try {
      const now = Date.now();
      const last = Number(ctx.storage.get('pixiv_err_at') || 0) || 0;
      if (now - last > 10 * 60 * 1000) {
        ctx.storage.set('pixiv_err_at', String(now));
        ctx.notify({ title: '❌ 抓取脚本报错', body: String((e && e.message) || e).slice(0, 140), sound: false });
      }
    } catch (_) {}
  }

  return;
}
