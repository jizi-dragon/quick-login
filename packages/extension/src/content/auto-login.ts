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

function fillUsername(): boolean {
  const field =
    document.querySelector<HTMLInputElement>('input[placeholder="请输入用户名"]') ||
    document.querySelector<HTMLInputElement>('input[type="text"]');
  if (field && credentials && field.value !== credentials.username) {
    setValue(field, credentials.username, window);
    return true;
  }
  return Boolean(field);
}

/** 顶层直接访问 srcdoc/同源 iframe，把密码填进 iframe 内的 password 输入框 */
function fillPasswordInIframes(): boolean {
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
      if (field && credentials && field.value !== credentials.password) {
        // 值为空/被框架重渲染清掉时才回填（防御 srcdoc 重渲染清值）
        setValue(field, credentials.password, win);
      }
      return Boolean(field);
    } catch {
      // 跨域 iframe 无法从顶层访问；由该 frame 自身注入的 content script 兜底填充
    }
  }
  return false;
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

/** 顶层：填用户名 + 密码（iframe）+ 勾选协议；自愈式提交（v3.10.5）。
 *  首次点击可能落在框架未就绪/表单状态未落地的时刻而「无反应」——点击后仍在登录页
 *  就重填再点（最多 4 次）；用户一旦手动改写凭据字段立即让位，绝不与用户抢表单。
 *  接管判定只认凭据输入框：勾选协议是自动流程自身动作（其 input 事件 isTrusted 可为
 *  true，Chrome 对扩展上下文的 element.click() 如此），绝不能当成用户键入。 */
function runTopFrameFlow(): void {
  const deadline = Date.now() + 30_000;
  let attempts = 0;
  let lastClickAt = 0;
  let userTouched = false;
  let absentStreak = 0;

  /** 用户已改写字段值（trusted 键入或手动清空）= 接管；预期值非空才可比对 */
  const detectUserEdit = (el: HTMLInputElement | null, expected: string): void => {
    if (el && expected && el.value && el.value !== expected) {
      userTouched = true;
    }
  };

  // 用户手动键入凭据字段 = 接管（勾选框/协议等其它 input 不算）
  window.addEventListener(
    'input',
    (e) => {
      const t = e.target as HTMLInputElement | null;
      if (e.isTrusted && t instanceof HTMLInputElement && (t.type === 'text' || t.type === 'password' || t.type === '')) {
        userTouched = true;
        console.debug('[ql-auto] user edits credentials field, stand down');
      }
    },
    { capture: true },
  );

  const timer = window.setInterval(attempt, 800);

  function attempt(): void {
    if (userTouched || !credentials || Date.now() > deadline) {
      window.clearInterval(timer);
      return;
    }
    const submit = findSubmit();
    if (!submit) {
      // 登录成功跳转后按钮消失；点击过至少一次即认为流程已交付
      if (attempts > 0 && ++absentStreak >= 2) {
        window.clearInterval(timer);
      }
      return;
    }
    absentStreak = 0;
    // 先检测用户是否已改写凭据（覆盖 srcdoc iframe 密码框等无事件通道的场景），再决定是否回填
    detectUserEdit(
      document.querySelector<HTMLInputElement>('input[placeholder="请输入用户名"]') ||
        document.querySelector<HTMLInputElement>('input[type="text"]'),
      credentials.username,
    );
    if (userTouched) {
      window.clearInterval(timer);
      return;
    }
    fillUsername();
    fillPasswordInIframes();
    checkAgreement();
    if ((submit as HTMLButtonElement).disabled) {
      return; // 表单校验未过（按钮禁用），等待
    }
    const now = Date.now();
    if (lastClickAt && now - lastClickAt < 3500) {
      return; // 点击观察期：给登录请求时间，避免连点
    }
    if (attempts >= 4) {
      window.clearInterval(timer);
      return;
    }
    attempts++;
    lastClickAt = now;
    window.setTimeout(() => {
      if (userTouched) {
        return; // 点击落地前用户已接管
      }
      fillUsername();
      fillPasswordInIframes();
      checkAgreement();
      findSubmit()?.click();
    }, 500);
  }

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