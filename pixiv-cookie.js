// ==UserScript==
// @Name         Pixiv PHPSESSID 自动抓取
// @Platform     Egern
// @Type         http_request
// @Author       Cuttlefish
// @Version      1.3.0
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
    ctx.storage.set(KEY_AT, String(now));
    ctx.storage.set(KEY_SID, sid);   // 先存下来，验证失败也不丢

    const prevSid = ctx.storage.get(KEY_SID) || '';
    const prevState = ctx.storage.get(KEY_STATE) || '';
    const lastCheck = Number(ctx.storage.get(KEY_CHECK) || 0) || 0;
    const sidChanged = prevSid !== sid;

    if (!sidChanged && now - lastCheck < RECHECK_MS) return;

    let state = null;
    let netErr = '';
    try {
      const resp = await ctx.http.get('https://www.pixiv.net/ajax/search/trending/tags?lang=zh', {
        headers: {
          'Cookie': 'PHPSESSID=' + sid,
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

    const changed = sidChanged || prevState !== state;
    if (!changed) return;

    if (state === 'login') {
      ctx.notify({
        title: '🔑 Pixiv 登录态已接管',
        body: '小组件现在会跟随热门搜索，登录态接口已可用',
        sound: false
      });
    } else if (prevState === 'login') {
      ctx.notify({
        title: '🔒 Pixiv 登录态失效',
        body: '会话已过期，请在浏览器重新登录 pixiv.net',
        sound: false
      });
    } else {
      ctx.notify({
        title: '🔒 抓到的是游客 Cookie',
        body: 'MITM 正常，但这个会话未登录。请在浏览器登录 pixiv.net。',
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
