// ==UserScript==
// @Name         Pixiv Cookie 定时检测
// @Platform     Egern
// @Type         schedule
// @Author       Cuttlefish
// @Version      1.1.0
// ==/UserScript==

/* ================================================================
 * 每小时跑一次：拿本地存下的 Cookie 试一次热搜接口
 *   成功 → 状态记 login
 *   失败 → 状态记 guest，并（若开启通知）弹一条「登录态失效」
 *          点击通知直接打开 https://www.pixiv.net/ 去重新登录
 *
 * 环境变量：
 *   NOTIFY   开启（默认）/ 关闭   —— 只控制通知，检测照跑
 *
 * 说明：
 *   - 网络异常（断网、超时）不判定为失效，避免误报
 *   - 通知最多 6 小时一次，不会每小时轰炸
 * ================================================================ */

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const NOTIFY_GAP = 6 * 3600 * 1000;

export default async function (ctx) {
  const raw = String((ctx.env && ctx.env.NOTIFY) || '开启').trim();
  const notifyOn = !/^(关闭|off|false|0|no)$/i.test(raw);

  const full = (ctx.storage.get('pixiv_cookie_full') || '').trim();
  const sid = (ctx.storage.get('pixiv_phpsessid') || '').trim();
  const header = full || (sid ? 'PHPSESSID=' + sid : '');
  if (!header) return { note: 'no-cookie' };

  let ok = false;
  let detail = '';
  try {
    const resp = await ctx.http.get('https://www.pixiv.net/ajax/user/self?lang=zh', {
      headers: {
        'Cookie': header,
        'Referer': 'https://www.pixiv.net/',
        'User-Agent': UA,
        'Accept': 'application/json'
      },
      timeout: 10000
    });
    const body = await resp.json().catch(() => null);
    // userData 有对象 = 登录；null = 游客。比热搜接口可靠
    ok = !!(body && body.userData);
    if (!ok) detail = body ? 'guest' : 'unparsable';
  } catch (e) {
    // 网络问题不算失效，直接结束，不改状态
    ctx.storage.set('pixiv_check_net_err', String(Date.now()));
    return { note: 'network' };
  }

  ctx.storage.set('pixiv_check_at', String(Date.now()));
  ctx.storage.set('pixiv_phpsessid_state', ok ? 'login' : 'guest');

  if (!ok && notifyOn) {
    const last = Number(ctx.storage.get('pixiv_expire_notify') || 0) || 0;
    if (Date.now() - last > NOTIFY_GAP) {
      ctx.storage.set('pixiv_expire_notify', String(Date.now()));
      ctx.notify({
        title: '🔒 Pixiv 登录态失效',
        body: '会话已不是登录状态（userData 为空），点这里打开 pixiv.net 重新登录',
        sound: false,
        action: { type: 'openUrl', url: 'https://www.pixiv.net/' }
      });
    }
  }

  return { login: ok, detail };
}
