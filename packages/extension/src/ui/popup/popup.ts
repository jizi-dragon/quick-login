import { EXT_VERSION } from '../../shared/constants';

/**
 * 弹窗 = 轻量启动器（v2.4 起）。
 * 账号管理全部收敛到并行管理页；旧「免密切换会话」UI 已移除。
 */

document.getElementById('ext-version')!.textContent = `QuickLogin v${EXT_VERSION}`;

const grantBtn = document.getElementById('grant-site') as HTMLButtonElement;
const grantHint = document.getElementById('grant-hint') as HTMLParagraphElement;

function openParallelPage(): void {
  chrome.tabs.create({ url: chrome.runtime.getURL('ui/parallel/parallel.html') });
  window.close();
}

async function currentTabHost(): Promise<string | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) {
    return null;
  }
  try {
    const u = new URL(tab.url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.host : null;
  } catch {
    return null;
  }
}

async function refreshGrantState(): Promise<void> {
  const host = await currentTabHost();
  if (!host) {
    grantBtn.disabled = true;
    grantHint.textContent = '当前标签页不是 http/https 站点。';
    return;
  }
  const granted = await chrome.permissions.contains({ origins: [`*://${host}/*`] });
  grantBtn.textContent = granted ? `已授权 ${host}` : `授权当前站点（${host}）`;
  grantBtn.classList.toggle('granted', granted);
  grantHint.textContent = granted
    ? '该站点已可并行多开。去并行管理页添加账号即可。'
    : '授权后扩展才能为该站点改写鉴权头并隔离存储。';
}

grantBtn.addEventListener('click', () => {
  void (async () => {
    const host = await currentTabHost();
    if (!host) {
      return;
    }
    const ok = await chrome.permissions.request({ origins: [`*://${host}/*`] }).catch(() => false);
    if (!ok) {
      return;
    }
    await refreshGrantState();
    openParallelPage();
  })();
});

document.getElementById('open-parallel')!.addEventListener('click', openParallelPage);

/** 轮盘兜底入口：即使快捷键被系统/其他软件占用，也保证能唤起 */
document.getElementById('open-wheel')!.addEventListener('click', () => {
  void chrome.runtime
    .sendMessage({ kind: 'wheel.toggle' })
    .then(() => window.close())
    .catch(() => window.close());
});

void refreshGrantState();
