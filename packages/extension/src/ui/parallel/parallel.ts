import type { ParallelAccount, ParallelAccountStatus } from '../../shared/types';
import { EXT_VERSION, LOCAL_KEYS } from '../../shared/constants';
import { send } from '../send';

type BrowserAccount = ParallelAccount & ParallelAccountStatus & { password: boolean };

/* ==================== 浏览器并行账号（唯一模式） ==================== */

const verChip = document.getElementById('ver-chip') as HTMLSpanElement;
verChip.textContent = `v${EXT_VERSION} · 纯浏览器并行`;

const browserListEl = document.getElementById('browser-list') as HTMLUListElement;
const parForm = document.getElementById('par-form') as HTMLFormElement;
const pHostSelect = document.getElementById('p-host') as HTMLSelectElement;
const pTabName = document.getElementById('p-tabname') as HTMLInputElement;
const pUsername = document.getElementById('p-username') as HTMLInputElement;
const pPassword = document.getElementById('p-password') as HTMLInputElement;

/** 有历史记录或站点清单有它时优先预选的默认站点 */
const PREFERRED_HOST = 'tonbridge-config.aksoegmp.com';
/** 记住上次选择站点的 storage.local 键 */
const LAST_HOST_KEY = 'ql:lastParHost';

let browserAccounts: BrowserAccount[] = [];

async function loadBrowserAccounts(): Promise<void> {
  const res = await send({ kind: 'par.list' });
  browserAccounts =
    res.kind === 'par.list' && res.result.ok
      ? (res.result.data as BrowserAccount[])
      : [];
  renderBrowserAccounts();
  // 站点行的「N 个并行账号」依赖本数据；每次刷新后同步重渲染，杜绝计数滞后
  renderSites(grantedHosts);
}

function badgeOf(a: BrowserAccount): { cls: string; text: string } {
  if (a.enforcementOff) {
    return { cls: 'login_failed', text: '未授权 · 已暂停' };
  }
  if (a.hasToken && a.tabIds.length > 0) {
    return { cls: 'online', text: `在线 ×${a.tabIds.length}` };
  }
  if (a.tabIds.length > 0) {
    return { cls: 'starting', text: '待登录' };
  }
  return { cls: 'offline', text: '离线' };
}

function renderBrowserAccounts(): void {
  browserListEl.innerHTML = '';
  if (!browserAccounts.length) {
    const li = document.createElement('li');
    li.className = 'account-item';
    li.textContent = '暂无并行账号。填写上方表单添加，密码将以 AES-GCM 加密存放在本机。';
    browserListEl.appendChild(li);
    return;
  }

  for (const a of browserAccounts) {
    const li = document.createElement('li');
    li.className = 'card account-item par-account';
    li.style.borderLeft = `3px solid ${a.color}`;

    const meta = document.createElement('div');
    meta.className = 'meta';
    const alias = document.createElement('div');
    alias.className = 'alias';
    alias.textContent = a.tabName || a.username;
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = `${a.username} · ${a.siteHost}${a.password ? ' · 已存密码' : ''}`;
    meta.append(alias, sub);

    const badge = document.createElement('span');
    const b = badgeOf(a);
    badge.className = `badge ${b.cls}`;
    badge.textContent = b.text;

    const openBtn = document.createElement('button');
    openBtn.className = 'btn-ghost';
    openBtn.textContent = a.tabIds.length ? '聚焦标签页' : '打开';
    openBtn.addEventListener('click', () => void openAccount(a.id, false));

    const newTabBtn = document.createElement('button');
    newTabBtn.className = 'btn-ghost';
    newTabBtn.textContent = '新标签页';
    newTabBtn.addEventListener('click', () => void openAccount(a.id, true));

    const renameBtn = document.createElement('button');
    renameBtn.className = 'btn-ghost';
    renameBtn.textContent = '改页签名';
    renameBtn.addEventListener('click', () => {
      const next = prompt('新的页签名（该账号标签页的标题）', a.tabName || a.username);
      if (next === null) {
        return;
      }
      void (async () => {
        await send({ kind: 'par.update', id: a.id, patch: { tabName: next.trim() || a.username } });
        await loadBrowserAccounts();
      })();
    });

    const del = document.createElement('button');
    del.className = 'btn-danger';
    del.textContent = '删除';
    del.addEventListener('click', () => {
      if (confirm(`删除账号「${a.tabName || a.username}」？将同时关闭其所有并行标签页。`)) {
        void (async () => {
          await send({ kind: 'par.delete', id: a.id });
          await loadBrowserAccounts();
        })();
      }
    });

    li.append(meta, badge, openBtn, newTabBtn, renameBtn, del);
    browserListEl.appendChild(li);
  }
}

async function ensureHostPermission(host: string): Promise<boolean> {
  try {
    return await chrome.permissions.request({ origins: [`*://${host}/*`] });
  } catch {
    // 无手势上下文等场景
    return false;
  }
}

async function openAccount(id: string, forceNewTab: boolean): Promise<void> {
  const account = browserAccounts.find((x) => x.id === id);
  if (!account) {
    return;
  }
  if (!(await ensureHostPermission(account.siteHost))) {
    alert(`需要授权访问 ${account.siteHost} 才能改写其请求头。`);
    return;
  }
  const res = await send({ kind: 'par.open', id, forceNewTab });
  if (!res.result.ok) {
    alert(`打开失败：${res.result.error}`);
    return;
  }
  await loadBrowserAccounts();
}

async function createAccount(open: boolean): Promise<void> {
  const siteHost = pHostSelect.value;
  if (!siteHost) {
    alert('请先在下方「站点管理」添加并授权站点，站点下拉才会有可选项。');
    return;
  }
  const tabName = pTabName.value.trim();
  const username = pUsername.value.trim();
  const password = pPassword.value;
  if (!username || !password) {
    return;
  }
  const res = await send({ kind: 'par.create', siteHost, tabName, username, password, open });
  if (!res.result.ok) {
    alert(`添加失败：${res.result.error}`);
    return;
  }
  // 记住本次选择的站点，下次打开默认选中
  await chrome.storage.local.set({ [LAST_HOST_KEY]: siteHost });
  pTabName.value = '';
  pUsername.value = '';
  pPassword.value = '';
  await loadBrowserAccounts();
}

parForm.addEventListener('submit', (e) => {
  e.preventDefault();
  void createAccount(true);
});

document.getElementById('add-only')!.addEventListener('click', () => {
  void createAccount(false);
});

/* ==================== 站点管理（读取真实权限清单） ==================== */

const siteForm = document.getElementById('site-form') as HTMLFormElement;
const sHost = document.getElementById('s-host') as HTMLInputElement;
const siteListEl = document.getElementById('site-list') as HTMLUListElement;

/** 当前真实授权 host 清单（loadSites 维护；渲染与下拉共享） */
let grantedHosts: string[] = [];
/** 手动停用的站点（Chrome 拒绝回收授权时的本地封锁名单） */
let blockedHosts: string[] = [];

function originToHost(origin: string): string | null {
  // 形如 "*://tonbridge-config.aksoegmp.com/*" 或 "https://*.example.com/*"
  const m = /^(?:\*|https?):\/\/([^/]+)(?:\/.*)?$/.exec(origin);
  if (!m) {
    return null;
  }
  // 跳过全通配行（*://*/* 等）：无法归属到具体站点，单独展示无意义
  return m[1] === '*' ? null : m[1];
}

function patternOfHost(host: string): string {
  return `*://${host}/*`;
}

/** 统计某 host 下已有的并行账号数（支持 *.example.com 通配模式粗匹配） */
function countAccountsFor(displayHost: string): number {
  const bare = displayHost.replace(/^\*\./, '');
  return browserAccounts.filter((a) => a.siteHost === displayHost || a.siteHost.endsWith(`.${bare}`)).length;
}

async function loadSites(): Promise<void> {
  const all = await chrome.permissions.getAll();
  const blockedStored = await chrome.storage.local.get(LOCAL_KEYS.blockedHosts);
  const blocked = new Set<string>((blockedStored[LOCAL_KEYS.blockedHosts] as string[] | undefined) ?? []);

  grantedHosts = Array.from(
    new Set((all.origins ?? []).map(originToHost).filter((h): h is string => h !== null)),
  ).sort();

  // 名单自愈：浏览器层已无授权的停用条目直接移除
  for (const b of Array.from(blocked)) {
    const still = await chrome.permissions.contains({ origins: [`*://${b}/*`] }).catch(() => false);
    if (!still) {
      blocked.delete(b);
    }
  }
  blockedHosts = Array.from(blocked).sort();
  await chrome.storage.local.set({ [LOCAL_KEYS.blockedHosts]: blockedHosts });

  renderSites(grantedHosts, blockedHosts);
}

function renderSites(hosts: string[], blocked: string[] = []): void {
  siteListEl.innerHTML = '';
  if (!hosts.length && !blocked.length) {
    const li = document.createElement('li');
    li.className = 'account-item';
    li.textContent = '尚无授权站点。用上方表单添加，或在目标站标签页上使用弹窗的「授权当前站点」。';
    siteListEl.appendChild(li);
    return;
  }

  const seen = new Set<string>();
  for (const host of [...hosts, ...blocked]) {
    if (seen.has(host)) {
      continue;
    }
    seen.add(host);
    const isBlocked = !hosts.includes(host) || blocked.includes(host);
    const n = countAccountsFor(host);

    const li = document.createElement('li');
    li.className = 'card account-item';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const alias = document.createElement('div');
    alias.className = 'alias';
    alias.textContent = isBlocked ? `${host}（已停用）` : host;
    if (isBlocked) {
      alias.style.color = '#C2410C';
    }
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = isBlocked
      ? `${n} 个并行账号 · 改头规则已全部暂停`
      : n > 0
        ? `${n} 个并行账号`
        : '该站点暂无并行账号（添加账号后自动更新）';
    meta.append(alias, sub);

    const actionBtn = document.createElement('button');
    actionBtn.className = isBlocked ? 'btn-ghost' : 'btn-danger';
    actionBtn.textContent = isBlocked ? '恢复使用' : '移除授权';
    actionBtn.addEventListener('click', () => {
      if (isBlocked) {
        void unblockHost(host);
        return;
      }
      if (!confirm(`移除对 ${host} 的授权？该站点的鉴权改写将立即失效（浏览器内的登录态不受影响）。`)) {
        return;
      }
      void revokeHost(host);
    });

    li.append(meta, actionBtn);
    siteListEl.appendChild(li);
  }
}

/**
 * 移除某 host 的全部授权（尽力而为）+ 本地停用兜底。
 * Chrome 的 permissions.remove 只能回收「可选授权」，且模式串必须与授予时一致；
 * 若浏览器拒绝（required 权限 / 站点访问模式限制），则把该 host 写入本地停用名单，
 * 后台不再对其安装任何改头规则 —— 效果等价于功能层撤销，且不与 Chrome 的内部状态搏斗。
 */
async function revokeHost(displayHost: string): Promise<void> {
  const all = await chrome.permissions.getAll();
  const raws = (all.origins ?? []).filter((o) => originToHost(o) === displayHost);
  const errors: string[] = [];

  for (const raw of raws) {
    try {
      const okc = await chrome.permissions.remove({ origins: [raw] });
      if (!okc) {
        errors.push(`浏览器拒绝移除：${raw}`);
      }
    } catch (e) {
      errors.push(`${raw} → ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 校验真实残留；仍有覆盖（含通配）→ 记入本地停用名单，保证「移除」在功能上必然生效
  const leftover = ((await chrome.permissions.getAll()).origins ?? []).filter(
    (o) => originToHost(o) === displayHost || o.includes('*://*/*'),
  );
  const stillCovers = leftover.length > 0;

  const blockedStored = await chrome.storage.local.get(LOCAL_KEYS.blockedHosts);
  const blocked = new Set<string>((blockedStored[LOCAL_KEYS.blockedHosts] as string[] | undefined) ?? []);

  if (stillCovers) {
    blocked.add(displayHost);
    await chrome.storage.local.set({ [LOCAL_KEYS.blockedHosts]: Array.from(blocked).sort() });
    alert(
      `「${displayHost}」已在 QuickLogin 中停用（改头规则立即失效）。\n\n` +
        `浏览器底层授权未能回收：\n${errors.join('\n') || '(无明细)'}\n\n` +
        `如需彻底回收浏览器层权限：chrome://extensions → 详情 → 网站访问权限 → 手动收窄。`,
    );
  } else if (blocked.has(displayHost)) {
    blocked.delete(displayHost);
    await chrome.storage.local.set({ [LOCAL_KEYS.blockedHosts]: Array.from(blocked).sort() });
  }

  await send({ kind: 'par.grantChanged' });
  await loadSites();
  await fillSiteOptions();
  await loadBrowserAccounts();
}

/** 恢复此前手动停用的站点（仅解除 QuickLogin 内部封锁） */
async function unblockHost(host: string): Promise<void> {
  const stored = await chrome.storage.local.get(LOCAL_KEYS.blockedHosts);
  const blocked = new Set<string>((stored[LOCAL_KEYS.blockedHosts] as string[] | undefined) ?? []);
  blocked.delete(host);
  await chrome.storage.local.set({ [LOCAL_KEYS.blockedHosts]: Array.from(blocked).sort() });
  await send({ kind: 'par.grantChanged' });
  await Promise.all([loadSites(), fillSiteOptions(), loadBrowserAccounts()]);
}

/** 新增账号表单的站点下拉：数据源 = 已授权站点清单；默认记住上次选择 */
async function fillSiteOptions(): Promise<void> {
  pHostSelect.innerHTML = '';

  if (!grantedHosts.length) {
    const empty = document.createElement('option');
    empty.value = '';
    empty.disabled = true;
    empty.selected = true;
    empty.textContent = '（暂无已授权站点 —— 请在下方「站点管理」添加）';
    pHostSelect.append(empty);
    return;
  }

  for (const h of grantedHosts) {
    const opt = document.createElement('option');
    opt.value = h;
    opt.textContent = h;
    pHostSelect.append(opt);
  }

  const stored = await chrome.storage.local.get(LAST_HOST_KEY);
  const last = stored[LAST_HOST_KEY] as string | undefined;
  const preferred =
    last && grantedHosts.includes(last)
      ? last
      : grantedHosts.includes(PREFERRED_HOST)
        ? PREFERRED_HOST
        : grantedHosts[0];
  pHostSelect.value = preferred;
}

siteForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const host = sHost.value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!host) {
    return;
  }
  void (async () => {
    const ok = await chrome.permissions.request({ origins: [patternOfHost(host)] }).catch(() => false);
    if (!ok) {
      alert(`未完成授权：${host}`);
      return;
    }
    sHost.value = '';
    await send({ kind: 'par.grantChanged' });
    await loadSites();
    await fillSiteOptions();
  })();
});

/* ==================== 启动装载 ==================== */

// 顺序敏感：先账号、再站点（保证首帧的「N 个并行账号」基于已加载的账号集），最后填下拉
void (async () => {
  await loadBrowserAccounts();
  await loadSites();
  await fillSiteOptions();
})();

// 轻量轮询：绑定/在线状态/计数可能被后台事件改变（标签关闭、token 捕获）
setInterval(() => void loadBrowserAccounts(), 3000);
