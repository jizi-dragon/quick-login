import { okOf, send } from '../send';
import type { Session, SiteGrant } from '../../shared/types';

const siteForm = document.getElementById('site-form') as HTMLFormElement;
const siteHostEl = document.getElementById('site-host') as HTMLInputElement;
const siteListEl = document.getElementById('site-list') as HTMLUListElement;
const sessionListEl = document.getElementById('session-list') as HTMLUListElement;

function normalizeHost(raw: string): string | null {
  let host = raw.trim().toLowerCase();
  if (!host) {
    return null;
  }
  if (/^https?:\/\//i.test(host)) {
    host = host.replace(/^https?:\/\//i, '');
  }
  host = host.split('/')[0].split('?')[0].split('#')[0].split(':')[0];
  return host || null;
}

function renderSites(sites: SiteGrant[]): void {
  siteListEl.innerHTML = '';
  for (const g of sites) {
    const li = document.createElement('li');
    li.className = 'card site-item';
    const host = document.createElement('span');
    host.className = 'host';
    host.textContent = g.host;
    const time = document.createElement('span');
    time.className = 'code';
    time.textContent = `授权于 ${new Date(g.grantedAt).toLocaleString()}`;
    li.append(host, time);
    siteListEl.appendChild(li);
  }
  if (!sites.length) {
    const li = document.createElement('li');
    li.className = 'code';
    li.textContent = '尚未添加任何站点。';
    siteListEl.appendChild(li);
  }
}

function renderSessions(sessions: Session[]): void {
  sessionListEl.innerHTML = '';
  for (const s of sessions) {
    const li = document.createElement('li');
    li.className = 'card session-item';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const alias = document.createElement('div');
    alias.className = 'alias';
    alias.textContent = s.accountAlias || s.name;
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = `${s.name} · ${s.siteHost}`;
    meta.append(alias, sub);

    const rename = document.createElement('button');
    rename.className = 'btn-ghost';
    rename.textContent = '改账号名';
    rename.addEventListener('click', () => {
      const next = prompt('账号名（作为标签页标题）', s.accountAlias);
      if (next !== null && next.trim()) {
        void send({ kind: 'session.update', id: s.id, patch: { accountAlias: next.trim(), name: next.trim() } }).then(refresh);
      }
    });

    const open = document.createElement('button');
    open.className = 'btn-ghost';
    open.textContent = '打开';
    open.addEventListener('click', () => void send({ kind: 'session.open', id: s.id, host: s.siteHost }));

    const del = document.createElement('button');
    del.className = 'btn-danger';
    del.textContent = '删除';
    del.addEventListener('click', () => {
      if (confirm(`删除会话「${s.name}」？已打开的标签页不受影响。`)) {
        void send({ kind: 'session.delete', id: s.id }).then(refresh);
      }
    });

    li.append(meta, rename, open, del);
    sessionListEl.appendChild(li);
  }
  if (!sessions.length) {
    const li = document.createElement('li');
    li.className = 'code';
    li.textContent = '暂无会话。在站点内创建后即出现在这里。';
    sessionListEl.appendChild(li);
  }
}

async function refresh(): Promise<void> {
  const [grants, sessions] = await Promise.all([
    send({ kind: 'site.grants.list' }),
    send({ kind: 'session.list' }),
  ]);
  renderSites(grants.kind === 'site.grants.list' ? okOf(grants.result, []) : []);
  renderSessions(sessions.kind === 'session.list' ? okOf(sessions.result, []) : []);
}

siteForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const host = normalizeHost(siteHostEl.value);
  if (!host) {
    return;
  }
  void (async () => {
    await send({ kind: 'site.grant.add', host });
    siteHostEl.value = '';
    await refresh();
  })();
});

void refresh();