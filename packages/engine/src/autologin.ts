import http from 'node:http';
import CDP from 'chrome-remote-interface';

/**
 * 自动登录：CDP 直连实例调试端口，把扩展版已验证的填表逻辑在页面顶层 frame 执行。
 * 填表脚本自包含（无 chrome API 依赖），选择器与扩展 content auto-login.ts 一致。
 */
export interface AutoLoginResult {
  success: boolean;
  reason: 'logged_in' | 'already_authed' | 'timeout' | 'no_page';
  finalUrl: string;
}

function getJson(path: string, port: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
  });
}

/** 找到第一个 page 类 target 的调试端点 */
async function findPageWs(port: number): Promise<string | null> {
  const list = (await getJson('/json/list', port)) as Array<{ type: string; webSocketDebuggerUrl: string }>;
  const page = list.find((t) => t.type === 'page');
  return page?.webSocketDebuggerUrl ?? null;
}

/** 生成在页面 context 执行的填表脚本（幂等 + 节流重试点击，兼容 React 受控组件） */
function loginScript(username: string, password: string): string {
  const u = JSON.stringify(username);
  const p = JSON.stringify(password);
  return `
(() => {
  const setValue = (el, v, win) => {
    const proto = Object.getPrototypeOf(el);
    const d = Object.getOwnPropertyDescriptor(proto, 'value');
    const setter = d && d.set;
    if (setter) { setter.call(el, v); } else { el.value = v; }
    el.dispatchEvent(new win.Event('input', { bubbles: true }));
    el.dispatchEvent(new win.Event('change', { bubbles: true }));
  };
  const uname = document.querySelector('input[placeholder="请输入用户名"]') || document.querySelector('input[type="text"]');
  if (uname) { setValue(uname, ${u}, window); }
  let pwd = null;
  for (const iframe of document.querySelectorAll('iframe')) {
    try {
      const doc = iframe.contentDocument, win = iframe.contentWindow;
      if (!doc || !win) { continue; }
      const f = doc.querySelector('input[type="password"]')
        || doc.querySelector('input[placeholder*="密码"]')
        || doc.querySelector('input[placeholder*="password"]');
      if (f) { setValue(f, ${p}, win); pwd = f; break; }
    } catch (e) {}
  }
  const box = document.getElementById('privacyChecked')
    || Array.from(document.querySelectorAll('input[type="checkbox"]'))
         .find((el) => /同意|agree/i.test((el.name || '') + (el.labels && el.labels[0] ? el.labels[0].textContent : '')));
  if (box && !box.checked) { box.click(); }
  const submit = Array.from(document.querySelectorAll('button'))
    .find((b) => /登录|登\\s*录|login|submit/i.test(b.textContent || ''));
  const disabled = submit ? !!submit.disabled : null;
  // 节流重试：按钮 enabled 且表单齐全时点击；同一按钮 2 秒内不重复点
  const now = Date.now();
  let clicked = false;
  if (submit && uname && pwd && !disabled && (!window.__ql_lastClick || now - window.__ql_lastClick > 2000)) {
    window.__ql_lastClick = now;
    submit.click();
    clicked = true;
  }
  return { url: location.href, hasUser: !!uname, hasPwd: !!pwd, disabled, clicked };
})()
`;
}

/** 登录态三分类：login=在登录页；loading=根地址（正跳转中）；authed=已进入业务页 */
type LoginState = 'login' | 'loading' | 'authed';

function loginState(url: string): LoginState {
  if (/\/login/i.test(url)) {
    return 'login';
  }
  try {
    const path = new URL(url).pathname;
    if (path === '' || path === '/') {
      return 'loading';
    }
  } catch {
    // 非法 URL 视为加载中
    return 'loading';
  }
  return 'authed';
}

export async function autoLogin(
  port: number,
  account: { username: string; password: string },
  timeoutMs = 30_000,
): Promise<AutoLoginResult> {
  const ws = await findPageWs(port);
  if (!ws) {
    return { success: false, reason: 'no_page', finalUrl: '' };
  }

  const client = await CDP({ target: ws });
  const { Runtime } = client;

  try {
    const deadline = Date.now() + timeoutMs;
    let finalUrl = '';

    while (Date.now() < deadline) {
      const res = await Runtime.evaluate({
        expression: loginScript(account.username, account.password),
        returnByValue: true,
      }) as { result?: { value?: { clicked?: boolean; url?: string; disabled?: boolean | null } } };
      const value = res.result?.value ?? {};
      finalUrl = value.url ?? '';

      const state = loginState(finalUrl);
      // 已进入业务页（登录后首页），无论是否由本次提交触发都算成功
      if (state === 'authed') {
        return { success: true, reason: value.clicked ? 'logged_in' : 'already_authed', finalUrl };
      }
      // 仍在登录页或根地址跳转中：继续轮询（填表脚本会持续尝试填充+提交）
      await sleep(800);
    }

    return { success: false, reason: 'timeout', finalUrl };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}