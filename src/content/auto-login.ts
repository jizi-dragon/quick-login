import { CONTENT_MESSAGE } from '../shared/constants';

/**
 * Auto-Login：自动填充登录表单并提交。
 * 以 all_frames 注入——用户名与「登录」按钮通常在顶层 frame，密码框常位于内嵌 iframe。
 * 各 frame 独立请求同一份凭证，并在各自 frame 内填充对应字段：
 *   顶层 frame：填用户名 + 勾选协议 + 触发登录提交
 *   子 iframe：  填密码
 */
let credentials: { username: string; password: string } | null = null;

function isTopFrame(): boolean {
  return window === window.top;
}

/** 在当前 frame 内按占位符/可访问名查找输入框 */
function findInput(regex: RegExp): HTMLInputElement | null {
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input'));
  return (
    inputs.find((el) => regex.test(`${el.placeholder || ''} ${el.ariaLabel || ''} ${el.name || ''}`)) ||
    inputs.find((el) => {
      const label = el.labels?.[0]?.textContent || '';
      return regex.test(`${el.placeholder || ''} ${el.ariaLabel || ''} ${label}`);
    }) ||
    null
  );
}

/** 查找「登录」按钮 */
function findSubmit(): HTMLButtonElement | null {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button'));
  return buttons.find((b) => /登录|登\s*录|login|submit/i.test(b.textContent || '')) || null;
}

/** 写入值并触发原生 setter + input/change 事件（兼容 React/Vue 受控组件） */
function setValue(el: HTMLInputElement, value: string): void {
  const proto = Object.getPrototypeOf(el);
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) {
    setter.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function fillUsername(): boolean {
  const field = findInput(/请输入用户名|用户名|user(name)?/i);
  if (field && credentials) {
    setValue(field, credentials.username);
    return true;
  }
  return false;
}

function fillPassword(): boolean {
  const field = findInput(/请输入密码|密码|pass(word)?/i);
  if (field && credentials) {
    setValue(field, credentials.password);
    return true;
  }
  return false;
}

function checkAgreement(): void {
  const box = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find((el) =>
    /同意|agree/i.test(`${el.name || ''} ${el.ariaLabel || ''} ${el.labels?.[0]?.textContent || ''}`),
  );
  if (box && !box.checked) {
    box.click();
  }
}

/** 顶层 frame：填用户名 + 勾选协议 + 提交；轮询多次以等待子 iframe 密码填充完毕 */
function runTopFrameFlow(): void {
  let submitted = false;
  let tries = 0;
  const MAX_TRIES = 20;

  const attempt = () => {
    if (submitted || !credentials || tries >= MAX_TRIES) {
      if (tries >= MAX_TRIES) {
        window.clearInterval(timer);
      }
      return;
    }
    tries += 1;
    fillUsername();
    checkAgreement();
    const submit = findSubmit();
    // 找到登录按钮后，稍作停顿再提交，给 iframe frame 留出填充密码的时间窗
    if (submit) {
      window.setTimeout(() => {
        if (!submitted) {
          submit.click();
          submitted = true;
          window.clearInterval(timer);
        }
      }, 1200);
    }
  };

  const timer = window.setInterval(attempt, 1000);
  attempt();
}

/** 子 iframe frame：只负责填密码 */
function runIframeFlow(): void {
  if (!credentials) {
    return;
  }
  const timer = window.setInterval(() => {
    if (fillPassword()) {
      window.clearInterval(timer);
    }
  }, 500);
  fillPassword();
  window.setTimeout(() => window.clearInterval(timer), 10_000);
}

function start(): void {
  if (!credentials) {
    return;
  }
  if (isTopFrame()) {
    runTopFrameFlow();
  } else {
    runIframeFlow();
  }
}

/** 内容脚本就绪（document_idle）后主动向 background 索取本次自动登录凭证 */
async function requestCredentials(): Promise<void> {
  try {
    const res = await chrome.runtime.sendMessage({ type: CONTENT_MESSAGE.autoLoginRequest });
    if (res && typeof res === 'object' && typeof res.username === 'string' && typeof res.password === 'string') {
      credentials = { username: res.username, password: res.password };
      start();
    }
  } catch {
    // background 未就绪或不支持，忽略；由后台主动下发（sb:autoLogin）覆盖
  }
}

chrome.runtime.onMessage.addListener((msg: unknown) => {
  if (
    msg &&
    typeof msg === 'object' &&
    (msg as { type?: string }).type === CONTENT_MESSAGE.autoLogin &&
    typeof (msg as { username?: string }).username === 'string' &&
    typeof (msg as { password?: string }).password === 'string'
  ) {
    credentials = {
      username: (msg as { username: string }).username,
      password: (msg as { password: string }).password,
    };
    start();
  }
});

void requestCredentials();