import { LOCAL_KEYS } from '../../shared/constants';
import type { CloudMergeReport } from '../../shared/messages';
import { db } from '../../storage/db';
import { cloudRequest, fetchAccountCount, invalidateCloudCache } from './cloud-store';
import { credentials } from './credentials';

/**
 * 本地 → 云端一次性合并上传（切数据源时跑一次）。
 *
 * 顺序**不可调换**，两个核对点**不可省略**：
 * 1. 取本地全量 → 2. 逐条取明文口令（取不到的计数上报，账号仍然上传）→ 3. 组装 sites/accounts
 * → 4. `POST /api/vault/merge` → 5. **核对 `received`** → 6. **核对云端账号总数**
 * → 7. 两关都过才写 `ql:dataSource = 'cloud'`。
 *
 * 为什么 5/6 不能省：`HTTP 200` 只说明请求被受理，不说明数据进去了
 * （服务端自己的 merge 说明里就点明了"某条账号因为 site_id 不存在被静默跳过"这种形态）。
 * 核对不过 ⇒ **中止且不改数据源**，本地数据一个字节都没动。
 *
 * ★ 全程**不写不改本地 IndexedDB**：这里对本地库只有一次 `db.accounts.list()`（读），
 *   本地数据原样保留，随时可切回。
 */

interface MergeSitePayload {
  host: string;
  name: string;
  scheme: 'http' | 'https';
  note: string;
}

interface MergeAccountPayload {
  siteHost: string;
  username: string;
  password: string;
  tabName: string;
  box: string;
  scheme: 'http' | 'https' | '';
  updatedAt: number;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** 历史记录没有 updatedAt ⇒ 一律按 createdAt 兜底（合并冲突"新的赢"的裁决依据） */
function effectiveUpdatedAt(updatedAt: unknown, createdAt: unknown): number {
  return num(updatedAt) ?? num(createdAt) ?? 0;
}

export async function migrateLocalToCloud(): Promise<CloudMergeReport> {
  /* ---- 1. 本地全量（只读；一个字节都不改） ---- */
  const local = await db.accounts.list();

  const bad = local.filter((a) => !`${a.siteHost ?? ''}`.trim() || !`${a.username ?? ''}`.trim());
  if (bad.length) {
    const names = bad
      .slice(0, 3)
      .map((a) => a.tabName || a.username || a.id)
      .join('、');
    throw new Error(
      `本地有 ${bad.length} 个账号缺少站点或账号名（${names}${bad.length > 3 ? ' 等' : ''}），` +
        '云端不接受这类记录：请先在本地补全或删除它们。本地数据未动，数据源仍是本地。',
    );
  }

  /* ---- 2 & 3. 明文口令 + 组装载荷 ---- */
  const sites: MergeSitePayload[] = [];
  const siteSeen = new Set<string>();
  const accounts: MergeAccountPayload[] = [];
  let missingPassword = 0;

  for (const account of local) {
    const siteHost = account.siteHost.trim().toLowerCase();
    const scheme: 'http' | 'https' = account.scheme === 'http' ? 'http' : 'https';
    let password = '';
    try {
      if (!account.credentials) {
        throw new Error('无凭证字段');
      }
      password = (await credentials.decryptCredentials(account.credentials)).password;
    } catch {
      // ★ 取不到口令的**计数并上报**（不报的话用户会以为"云端都齐了"）。
      //   账号仍然照传：跳过它会让 received 对不上本地条数，核对点就失去意义。
      missingPassword++;
    }
    if (!siteSeen.has(siteHost)) {
      siteSeen.add(siteHost);
      // scheme 取该 host 下第一个账号的（缺省 https）——与站点 hint 的口径一致
      sites.push({ host: siteHost, name: siteHost, scheme, note: '' });
    }
    accounts.push({
      siteHost,
      username: account.username,
      password,
      tabName: account.tabName || account.username,
      box: (account.box ?? '').trim(),
      scheme: account.scheme === 'http' || account.scheme === 'https' ? account.scheme : '',
      updatedAt: effectiveUpdatedAt(account.updatedAt, account.createdAt),
    });
  }

  /* ---- 4. 上传（空库也照走：0 条一样要过两个核对点，不给"跳过核对"的分支） ---- */
  const resp = asRecord(
    await cloudRequest<unknown>('/api/vault/merge', {
      method: 'POST',
      body: { sites, accounts, clientAccountCount: local.length },
    }),
  );

  /* ---- 5. 核对点一：服务端如实回报的 received 必须等于本地条数 ---- */
  const received = num(resp.received);
  if (received !== local.length) {
    throw new Error(
      `上传未完成，本地数据未动：服务端回报收到 ${received ?? '未知'} 条，本地有 ${local.length} 条。` +
        '数据源仍是本地，可稍后重试。',
    );
  }

  /* ---- 6. 核对点二：云端账号总数必须 ≥ 本地条数 ---- */
  const totalAccounts = await fetchAccountCount();
  if (totalAccounts === undefined || totalAccounts < local.length) {
    throw new Error(
      `上传未确认，本地数据未动：云端账号数 ${totalAccounts ?? '未知'} < 本地 ${local.length} 条。` +
        '数据源仍是本地，可稍后重试。',
    );
  }

  /* ---- 7. 两关都过 ⇒ 才切数据源 ---- */
  await chrome.storage.local.set({ [LOCAL_KEYS.dataSource]: 'cloud' });
  invalidateCloudCache();

  return {
    localCount: local.length,
    missingPassword,
    sites: sites.length,
    received,
    totalAccounts,
    created: num(resp.created) ?? 0,
    updated: num(resp.updated) ?? 0,
    skipped: num(resp.skipped) ?? 0,
    conflicts: num(resp.conflicts) ?? 0,
  };
}
