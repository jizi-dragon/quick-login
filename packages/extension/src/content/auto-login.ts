import { CONTENT_MESSAGE } from '../shared/constants';

/**
 * Auto-Login：自动填充登录表单并提交。
 * 关键事实：密码框位于同源 `srcdoc` iframe 内（class="ant-input"），而 `<all_urls>` 的
 * content script 不会注入 `about:srcdoc` frame，因此不能用「iframe 各填各」模型——
 * 必须由**顶层 frame 直接访问 iframe.contentDocument 填密码**。
 * 顶层 frame：填用户名 + 访问 srcdoc iframe 填密码 + 勾选协议 + 提交登录。
 * 子 frame（若注入，如跨域外链 iframe）：仅兜底填自身 frame 内的密码。
 */
let credentials: { username: string; password: string } | null = null;

function isTopFrame(): boolean {
  return window === window.top;
}

/** 写入值并触发原生 setter + input/change 事件（兼容 React/Ant Design 受控组件）。
 * 密码框位于 iframe 内，需用该 iframe 自身 realm 的构造器触发，跨 realm 才可靠。 */
function setValue(el: HTMLInputElement, value: string, win: Window): void {
  const realm = win as unknown as {
    HTMLInputElement: typeof HTMLInputElement;
    Event: typeof Event;
  };
  const setter = Object.getOwnPropertyDescriptor(realm.HTMLInputElement.prototype, 'value')?.set;
  if (setter) {
    setter.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new realm.Event('input', { bubbles: true }));
  el.dispatchEvent(new realm.Event('change', { bubbles: true }));
}

function fillUsername(): HTMLInputElement | null {
  const field =
    document.querySelector<HTMLInputElement>('input[placeholder="请输入用户名"]') ||
    document.querySelector<HTMLInputElement>('input[type="text"]');
  if (field && credentials) {
    setValue(field, credentials.username, window);
  }
  return field;
}

/** 顶层直接访问 srcdoc/同源 iframe，把密码填进 iframe 内的 password 输入框 */
function fillPasswordInIframes(): HTMLInputElement | null {
  const iframes = document.querySelectorAll<HTMLIFrameElement>('iframe');
  for (const iframe of Array.from(iframes)) {
    try {
      const doc = iframe.contentDocument;
      const win = iframe.contentWindow;
      if (!doc || !win) {
        continue;
      }
      const field =
        doc.querySelector<HTMLInputElement>('input[type="password"]') ||
        doc.querySelector<HTMLInputElement>('input[placeholder*="密码"]') ||
        doc.querySelector<HTMLInputElement>('input[placeholder*="password"]');
      if (field && credentials) {
        setValue(field, credentials.password, win);
      }
      return field;
    } catch {
      // 跨域 iframe 无法从顶层访问；由该 frame 自身注入的 content script 兜底填充
    }
  }
  return null;
}

function checkAgreement(): void {
  const box =
    (document.getElementById('privacyChecked') as HTMLInputElement | null) ||
    Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find((el) =>
      /同意|agree/i.test(`${el.name || ''} ${el.ariaLabel || ''} ${el.labels?.[0]?.textContent || ''}`),
    );
  if (box && !box.checked) {
    box.click();
  }
}

function findSubmit(): HTMLButtonElement | null {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button'));
  return buttons.find((b) => /登录|登\s*录|login|submit/i.test(b.textContent || '')) || null;
}

/** 顶层：填用户名 + 密码（iframe）+ 勾选协议；表单就绪后提交一次 */
function runTopFrameFlow(): void {
  let submitted = false;
  const deadline = Date.now() + 20_000;

  const attempt = () => {
    if (submitted || !credentials) {
      return;
    }
    if (Date.now() > deadline) {
      window.clearInterval(timer);
      return;
    }
    const usernameField = fillUsername();
    const passwordField = fillPasswordInIframes();
    checkAgreement();
    const submit = findSubmit();
    // 用户名、密码、提交按钮三者齐备后，稍等 React 状态落地再提交一次
    if (submit && usernameField && passwordField) {
      window.setTimeout(() => {
        if (!submitted) {
          submit.click();
          submitted = true;
          window.clearInterval(timer);
        }
      }, 400);
    }
  };

  const timer = window.setInterval(attempt, 800);
  attempt();
}

/** 子 frame：仅兜底填自身 frame 内的密码（srcdoc iframe 不注入，此分支主要服务跨域外链 iframe） */
function runIframeFlow(): void {
  if (!credentials) {
    return;
  }
  const field =
    document.querySelector<HTMLInputElement>('input[type="password"]') ||
    document.querySelector<HTMLInputElement>('input[placeholder*="密码"]') ||
    document.querySelector<HTMLInputElement>('input[placeholder*="password"]');
  if (field) {
    setValue(field, credentials.password, window);
  }
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

/** 就绪（document_idle）后主动向 background 索取本次自动登录凭证；失败则轻量重试 */
async function requestCredentials(attempt = 0): Promise<void> {
  if (credentials) {
    return;
  }
  try {
    const res = await chrome.runtime.sendMessage({ type: CONTENT_MESSAGE.autoLoginRequest });
    if (res && typeof res === 'object' && typeof res.username === 'string' && typeof res.password === 'string') {
      credentials = { username: res.username, password: res.password };
      start();
    }
  } catch {
    if (attempt < 3) {
      window.setTimeout(() => void requestCredentials(attempt + 1), 500);
    }
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