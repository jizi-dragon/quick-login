import { okOf, send } from '../send';
import type { Session, SiteGrant } from '../../shared/types';

const siteEl = document.getElementById('site') as HTMLSelectElement;
const createForm = document.getElementById('create') as HTMLFormElement;
const usernameEl = document.getElementById('username') as HTMLInputElement;
const aliasEl = document.getElementById('alias') as HTMLInputElement;
const passwordEl = document.getElementById('password') as HTMLInputElement;
const listEl = document.getElementById('list') as HTMLUListElement;
const emptyEl = document.getElementById('empty') as HTMLParagraphElement;

let sessions: Session[] = [];
let sites: SiteGrant[] = [];

function selectedHost(): string {
  const v = siteEl.value;
  if (!v) {
    return '';
  }
  // siteEl.value 为已规范化的 host，直接返回；兼容用户误粘贴含协议的完整 URL
  const u = new URL(v.includes('://') ? v : `https://${v}`);
  return u.hostname;
}

function render(): void {
  const host = selectedHost();
  const list = sessions.filter((s) => s.siteHost === host);
  listEl.innerHTML = '';
  emptyEl.style.display = list.length ? 'none' : 'block';
  for (const s of list) {
    const li = document.createElement('li');
    li.className = 'card item';

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = s.color;

    const meta = document.createElement('div');
    meta.className = 'meta';
    const alias = document.createElement('div');
    alias.className = 'alias';
    alias.textContent = s.accountAlias || s.name;
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = `${s.name || s.accountAlias} · ${s.siteHost}`;
    meta.append(alias, sub);

    const open = document.createElement('button');
    open.className = 'icon-btn';
    open.textContent = '切换';
    open.addEventListener('click', () => void openSession(s));

    li.append(dot, meta, open);
    listEl.appendChild(li);
  }
}

async function openSession(s: Session): Promise<void> {
  const res = await send({ kind: 'session.open', id: s.id, host: s.siteHost });
  if (res.kind === 'session.open' && res.result.ok) {
    window.close();
  }
}

async function refreshSites(): Promise<void> {
  const res = await send({ kind: 'site.grants.list' });
  if (res.kind !== 'site.grants.list') {
    return;
  }
  sites = okOf(res.result, []);
  siteEl.innerHTML = '';
  for (const g of sites) {
    const opt = document.createElement('option');
    opt.value = g.host;
    opt.textContent = g.host;
    siteEl.appendChild(opt);
  }
}

async function refresh(): Promise<void> {
  const res = await send({ kind: 'session.list' });
  if (res.kind === 'session.list') {
    sessions = okOf(res.result, []);
  }
  render();
}

siteEl.addEventListener('change', render);

createForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const host = selectedHost();
  const username = usernameEl.value.trim();
  const accountAlias = aliasEl.value.trim();
  const password = passwordEl.value;
  if (!host || !username || !accountAlias) {
    return;
  }
  void (async () => {
    const created = await send({
      kind: 'session.openOrCreate',
      host,
      username,
      password,
      accountAlias,
    });
    if (created.kind === 'session.openOrCreate' && created.result.ok) {
      window.close();
    }
    usernameEl.value = '';
    aliasEl.value = '';
    passwordEl.value = '';
  })();
});

void refreshSites().then(refresh);