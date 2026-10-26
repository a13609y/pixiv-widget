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
 * 只有「值发生变化」时才会验证 + 通知，浏览过程中不会反复打扰。
 * 校验方式：带这个 Cookie 请求热门标签接口，返回 error:false 才算登录态。
 * 全程透传请求，不修改、不阻断。
 * ================================================================ */

const KEY_SID = 'pixiv_phpsessid';
const KEY_AT = 'pixiv_phpsessid_at';
const KEY_STATE = 'pixiv_phpsessid_state';

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

export default async function (ctx) {
  try {
    const raw = ctx.request.headers.get('cookie') || '';
    const m = /(?:^|;\s*)PHPSESSID=([0-9A-Za-z]{16,64})/.exec(raw);
    if (!m) return;                       // 没有会话 ID，直接透传

    const sid = m[1];
    ctx.storage.set(KEY_AT, String(Date.now()));

    if (ctx.storage.get(KEY_SID) === sid) return;   // 没变化，不再打扰

    // 值变了：验证是登录态还是游客态
    let state = 'guest';
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
      if (body && body.error === false) state = 'login';
    } catch (_) {
      // 网络失败不覆盖已有状态，下次再试
      return;
    }

    ctx.storage.set(KEY_SID, sid);
    ctx.storage.set(KEY_STATE, state);

    ctx.notify({
      title: state === 'login' ? 'Pixiv 登录态已接管' : 'Pixiv Cookie 已更新（游客态）',
      body: state === 'login'
        ? '小组件现在可以跟随热门搜索、使用登录态接口'
        : '这是未登录会话，请先在该代理下打开 pixiv.net 登录',
      sound: false
    });
  } catch (_) {}

  return; // 透传原请求
}
