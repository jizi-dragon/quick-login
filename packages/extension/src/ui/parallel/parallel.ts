import type { EngineAccount, EngineCommand, EngineEvent } from '../../../../shared/nm-protocol';

const statusEl = document.getElementById('engine-status') as HTMLSpanElement;
const accountListEl = document.getElementById('account-list') as HTMLUListElement;
const logListEl = document.getElementById('log-list') as HTMLUListElement;
const createForm = document.getElementById('create-form') as HTMLFormElement;
const fHost = document.getElementById('f-host') as HTMLInputElement;
const fUsername = document.getElementById('f-username') as HTMLInputElement;
const fAlias = document.getElementById('f-alias') as HTMLInputElement;
const fPassword = document.getElementById('f-password') as HTMLInputElement;

let accounts: EngineAccount[] = [];
let engineConnected = false;

/** 向引擎发送指令；返回是否已送达（引擎未装/断连返回 false） */
function sendCommand(cmd: EngineCommand): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { nmBridge: true, direction: 'command', cmd },
      (res: unknown) => {
        resolve((res as { ok?: boolean } | undefined)?.ok === true);
      },
    );
  });
}

function pushLog(text: string): void {
  const li = document.createElement('li');
  const time = new Date().toLocaleTimeString();
  li.textContent = `[${time}] ${text}`;
  logListEl.prepend(li);
  while (logListEl.children.length > 50) {
    logListEl.lastElementChild?.remove();
  }
}

function renderStatus(): void {
  statusEl.textContent = engineConnected ? '引擎已连接' : '引擎未连接';
  statusEl.className = `status-chip ${engineConnected ? 'status-connected' : 'status-disconnected'}`;
}

const STATE_TEXT: Record<EngineAccount['state'], string> = {
  starting: '启动中',
  online: '在线',
  login_failed: '登录失败',
  offline: '离线',
};

function renderAccounts(): void {
  accountListEl.innerHTML = '';
  if (!accounts.length) {
    const li = document.createElement('li');
    li.className = 'account-item';
    li.textContent = '暂无账号。填写上方表单添加。';
    accountListEl.appendChild(li);
    return;
  }
  for (const a of accounts) {
    const li = document.createElement('li');
    li.className = 'card account-item';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const alias = document.createElement('div');
    alias.className = 'alias';
    alias.textContent = a.alias || a.username;
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = `${a.username} · ${a.siteHost}`;
    meta.append(alias, sub);

    const badge = document.createElement('span');
    badge.className = `badge ${a.state}`;
    badge.textContent = STATE_TEXT[a.state];

    const toggle = document.createElement('button');
    toggle.className = 'btn-ghost';
    if (a.state === 'online' || a.state === 'starting') {
      toggle.textContent = '停止';
      toggle.addEventListener('click', () => void sendCommand({ cmd: 'stop', accountId: a.id }));
    } else {
      toggle.textContent = '启动';
      toggle.addEventListener('click', () => void sendCommand({ cmd: 'start', accountId: a.id }));
    }

    const del = document.createElement('button');
    del.className = 'btn-danger';
    del.textContent = '删除';
    del.addEventListener('click', () => {
      if (confirm(`删除账号「${a.alias}」及其登录态？`)) {
        void sendCommand({ cmd: 'delete', accountId: a.id });
      }
    });

    li.append(meta, badge, toggle, del);
    accountListEl.appendChild(li);
  }
}

function handleEvent(event: EngineEvent): void {
  switch (event.event) {
    case 'accounts':
      accounts = event.accounts;
      renderAccounts();
      break;
    case 'state': {
      const acct = accounts.find((x) => x.id === event.accountId);
      if (acct) {
        acct.state = event.state;
        renderAccounts();
      }
      pushLog(`账号 ${event.accountId.slice(0, 8)} ${STATE_TEXT[event.state]}${event.message ? `（${event.message}）` : ''}`);
      break;
    }
    case 'error':
      pushLog(`错误：${event.message}`);
      break;
  }
}

// 监听引擎事件推送
chrome.runtime.onMessage.addListener((msg: unknown) => {
  if (msg && typeof msg === 'object' && (msg as { nmBridge?: boolean }).nmBridge) {
    const ev = (msg as { event?: EngineEvent }).event;
    if (ev) {
      engineConnected = true;
      renderStatus();
      handleEvent(ev);
    }
  }
});

// 引擎断连提示：periodically 探测（list 命令失败即视为断连）
async function probe(): Promise<void> {
  const ok = await sendCommand({ cmd: 'list' });
  engineConnected = ok;
  renderStatus();
}
void probe();
setInterval(() => void probe(), 5000);

createForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const siteHost = fHost.value.trim();
  const username = fUsername.value.trim();
  const alias = fAlias.value.trim() || username;
  const password = fPassword.value;
  if (!siteHost || !username) {
    return;
  }
  void (async () => {
    await sendCommand({ cmd: 'create', siteHost, username, alias, password, start: true });
    fHost.value = '';
    fUsername.value = '';
    fAlias.value = '';
    fPassword.value = '';
  })();
});

void sendCommand({ cmd: 'list' });