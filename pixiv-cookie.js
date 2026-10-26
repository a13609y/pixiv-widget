// ==UserScript==
// @Name         Pixiv PHPSESSID 自动抓取
// @Platform     Egern
// @Type         http_request
// @Author       Cuttlefish
// @Version      1.0.0
// ==/UserScript==

/* ================================================================
 * 作用：在 Egern 代理下浏览 pixiv.net 时，自动从请求头 Cookie 里
 *       提取 PHPSESSID 并写入持久化存储，供「Pixiv 每日美图」小组件使用。
 *
 * 存储键：
 *   pixiv_phpsessid        32 位十六进制会话 ID
 *   pixiv_phpsessid_at     最近一次见到它的时间戳（毫秒）
 *   pixiv_phpsessid_state  login / guest
 *
 * 每次浏览都会读取；Cookie 没变时每 10 分钟复验一次，只有「状态变化」才通知。
 * 校验方式：带这个 Cookie 请求热门标签接口，返回 error:false 才算登录态。
 * 全程透传请求，不修改、不阻断。
 * ================================================================ */

const KEY_SID = 'pixiv_phpsessid';
const KEY_AT = 'pixiv_phpsessid_at';
const KEY_STATE = 'pixiv_phpsessid_state';
const KEY_CHECK = 'pixiv_phpsessid_check';   // 上次校验时间
const RECHECK_MS = 10 * 60 * 1000;           // 10 分钟复验一次

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

export default async function (ctx) {
  try {
    const raw = ctx.request.headers.get('cookie') || '';
    const m = /(?:^|;\s*)PHPSESSID=([0-9A-Za-z]{16,64})/.exec(raw);
    if (!m) return;                       // 没有会话 ID，直接透传

    const sid = m[1];
    const now = Date.now();
    ctx.storage.set(KEY_AT, String(now));

    const prevSid = ctx.storage.get(KEY_SID) || '';
    const prevState = ctx.storage.get(KEY_STATE) || '';
    const lastCheck = Number(ctx.storage.get(KEY_CHECK) || 0) || 0;
    const sidChanged = prevSid !== sid;

    // 没换过、且刚验过 -> 静默透传（避免每次请求都打一次接口）
    if (!sidChanged && now - lastCheck < RECHECK_MS) return;

    // 验证是登录态还是游客态
    let state = null;
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
    } catch (_) {
      return; // 网络失败，保持原状态，下次再验
    }

    ctx.storage.set(KEY_CHECK, String(now));
    if (!state) return;

    ctx.storage.set(KEY_SID, sid);
    ctx.storage.set(KEY_STATE, state);

    // 只有状态发生变化才通知
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
        body: '请在代理开启时用 Safari 登录 pixiv.net 一次',
        sound: false
      });
    }
  } catch (_) {}

  return; // 透传原请求
}
