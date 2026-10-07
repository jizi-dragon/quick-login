import { EXT_VERSION } from '../../shared/constants';

/**
 * 弹窗 = 品牌入口 + 实时统计 + 唯一主操作（v3.8 起）。
 * 轮盘统一走快捷键（Alt+Q）；站点授权在并行管理页完成。
 */

document.getElementById('ext-version')!.textContent = `v${EXT_VERSION}`;

function openParallelPage(): void {
  chrome.tabs.create({ url: chrome.runtime.getURL('ui/parallel/parallel.html') });
  window.close();
}

document.getElementById('open-parallel')!.addEventListener('click', openParallelPage);

/* ---- 云端账号库（Akso Vault） ----
 * 登录、注册与账号管理**都在浏览器官网上完成**，扩展只负责把用户送过去。
 * ★ 扩展刻意**不内置登录表单**：口令一旦流经扩展的 DOM，就多了一个必须被信任的界面，
 *   而扩展的职责是"执行面"，不是"凭据收集面"。
 * ⚠️ 地址暂时写死；接入服务器时应改为可配置（见项目根的 EXTENSION-SPLIT-PLAN §7）。
 */
const VAULT_URL = 'https://www.dragonrain.top:8443/';

function openVault(): void {
  chrome.tabs.create({ url: VAULT_URL });
  window.close();
}

document.getElementById('open-vault')?.addEventListener('click', openVault);

/* ---- 实时统计：账号 / 在线 / 授权站点 ---- */
function setStat(id: string, value: string | number): void {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = String(value);
  }
}

void (async () => {
  try {
    const res = (await chrome.runtime.sendMessage({ kind: 'par.list' })) as
      | { kind: 'par.list'; result: { ok: boolean; data?: Array<{ tabIds?: number[] }> } }
      | undefined;
    const accounts = res?.result?.ok && Array.isArray(res.result.data) ? res.result.data : [];
    setStat('stat-accounts', accounts.length);
    setStat('stat-online', accounts.filter((a) => (a.tabIds?.length ?? 0) > 0).length);
  } catch {
    setStat('stat-accounts', '—');
    setStat('stat-online', '—');
  }
  try {
    const all = await chrome.permissions.getAll();
    const hosts = new Set<string>();
    for (const o of all.origins ?? []) {
      const m = /^(?:\*|https?):\/\/([^/]+)(?:\/.*)?$/.exec(o);
      if (m && m[1] !== '*') {
        hosts.add(m[1]);
      }
    }
    setStat('stat-sites', hosts.size);
  } catch {
    setStat('stat-sites', '—');
  }
})();
