/**
 * DNR session 规则管理 —— 「多平面隔离」的网络平面 v4。
 *
 * 每个绑定标签页维护三条 session 规则：
 *  1) AUTH 规则：Authorization → set 'Bearer <token>'（token 可能为 null：未捕获前不装）；
 *  2) COOKIE 规则：Cookie 请求头 → remove（与 token 无关，绑定即装）；
 *  3) CACHE 规则（v3.3 新增）：GET 接口查询串追加 `_qlck=t<tabId>` —— 把共享 HTTP 缓存
 *     按标签页硬性分区。实测发现低代码平台把权限/菜单等敏感接口做成可缓存响应，
 *     而浏览器 HTTP 缓存按 URL 存取且全 profile 共享：第一个登录账号的响应会被后续
 *     不同账号直接命中（不出网），造成「普通用户获得管理员权限」或反向剥离。
 *     追加常量参数后同一标签缓存键稳定、跨标签必然不同，泄漏源被切断；服务端对
 *     未知 query 参数通常忽略，POST 不在范围内不受影响。
 *
 * 页面存储层继续由 MAIN 壳虚拟化；目标站为无状态 JWT 设计（DESIGN.md §3）。
 */

/** AUTH 规则 id 区间 */
const AUTH_BASE = 100_000;
/** COOKIE 规则 id 区间 */
const COOKIE_BASE = 200_000;
/** CACHE 分区规则 id 区间 */
const CACHE_BASE = 300_000;

/** 缓存分区开关（如服务端对未知 query 参数敏感可置 false 快速回退） */
const CACHE_PARTITION_ENABLED = true;

interface RuleMeta {
  authId?: number;
  cookieId?: number;
  cacheId?: number;
  /** 当前 AUTH 规则的 token；null 表示未装 AUTH 规则 */
  token: string | null;
}

const installed = new Map<number, RuleMeta>();

let nextAuthId = AUTH_BASE;
let nextCookieId = COOKIE_BASE;
let nextCacheId = CACHE_BASE;

const ALL_MATCH_TYPES: chrome.declarativeNetRequest.ResourceType[] = [
  'main_frame',
  'sub_frame',
  'xmlhttprequest',
  'websocket',
  'script',
  'stylesheet',
  'image',
  'font',
  'media',
  'other',
] as chrome.declarativeNetRequest.ResourceType[];

function asRule(raw: unknown): chrome.declarativeNetRequest.Rule {
  return raw as unknown as chrome.declarativeNetRequest.Rule;
}

function buildAuthRule(ruleId: number, host: string, tabId: number, token: string): chrome.declarativeNetRequest.Rule {
  return asRule({
    id: ruleId,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'Authorization', operation: 'set', value: `Bearer ${token}` }],
    },
    condition: {
      // API 调用、WS 握手，以及 iframe 内嵌文档（低代码平台的「管理端」控制台常以
      // iframe 承载：只带命名空间存储、无 Bearer 的子框架会被服务端当匿名拒入）
      resourceTypes: ['xmlhttprequest', 'websocket', 'sub_frame'],
      requestDomains: [host],
      tabIds: [tabId],
    },
  });
}

function buildCookieStripRule(ruleId: number, host: string, tabId: number): chrome.declarativeNetRequest.Rule {
  return asRule({
    id: ruleId,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'Cookie', operation: 'remove' }],
    },
    condition: {
      // 全类型剥离：jar 对绑定标签完全隐身（页面读取走 Cookie 袋虚拟化）
      resourceTypes: ALL_MATCH_TYPES,
      requestDomains: [host],
      tabIds: [tabId],
    },
  });
}

/** 缓存分区：GET 接口追加 _qlck=t<tabId>，把共享 HTTP 缓存按标签硬性分区 */
function buildCachePartitionRule(ruleId: number, host: string, tabId: number): chrome.declarativeNetRequest.Rule {
  return asRule({
    id: ruleId,
    priority: 1,
    action: {
      type: 'redirect',
      redirect: {
        urlTransform: {
          queryTransform: {
            setParams: { _qlck: `t${tabId}` },
          },
        },
      },
    },
    condition: {
      resourceTypes: ['xmlhttprequest'],
      // 仅 GET 可被缓存；POST/PUT 等写操作不分区
      requestMethods: ['GET'],
      requestDomains: [host],
      tabIds: [tabId],
    },
  });
}

async function updateRules(removeRuleIds: number[], addRules: chrome.declarativeNetRequest.Rule[]): Promise<void> {
  if (!removeRuleIds.length && !addRules.length) {
    return;
  }
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
}

export const tabRules = {
  /**
   * 设置/更新某绑定标签页的网络平面规则。
   * - COOKIE 剥离规则与 CACHE 分区规则绑定即装；
   * - token 非 null 时装/换 AUTH 规则；null 时摘除。
   */
  async applyBinding(host: string, tabId: number, token: string | null): Promise<void> {
    const meta: RuleMeta = installed.get(tabId) ?? { token: null };

    const removes: number[] = [];
    const adds: chrome.declarativeNetRequest.Rule[] = [];

    // COOKIE 剥离规则
    if (meta.cookieId === undefined) {
      meta.cookieId = nextCookieId++;
      adds.push(buildCookieStripRule(meta.cookieId, host, tabId));
    }

    // CACHE 分区规则
    if (CACHE_PARTITION_ENABLED && meta.cacheId === undefined) {
      meta.cacheId = nextCacheId++;
      adds.push(buildCachePartitionRule(meta.cacheId, host, tabId));
    }

    // AUTH 规则
    if (token === null) {
      if (meta.authId !== undefined) {
        removes.push(meta.authId);
        meta.authId = undefined;
      }
      meta.token = null;
    } else if (meta.token !== token) {
      if (meta.authId !== undefined) {
        removes.push(meta.authId);
      }
      meta.authId = meta.authId ?? nextAuthId++;
      adds.push(buildAuthRule(meta.authId, host, tabId, token));
      meta.token = token;
    }

    await updateRules(removes, adds);
    installed.set(tabId, meta);
  },

  /** 标签关闭 / 解绑：摘除其全部规则 */
  async clearTab(tabId: number): Promise<void> {
    const meta = installed.get(tabId);
    if (!meta) {
      return;
    }
    const removes: number[] = [];
    if (meta.cookieId !== undefined) {
      removes.push(meta.cookieId);
    }
    if (meta.authId !== undefined) {
      removes.push(meta.authId);
    }
    if (meta.cacheId !== undefined) {
      removes.push(meta.cacheId);
    }
    try {
      if (removes.length) {
        await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: removes });
      }
    } catch {
      // 忽略
    }
    installed.delete(tabId);
  },

  /**
   * SW 冷启动恢复：persisted 提供 tabId → { host, token|null }，
   * 与浏览器内现存 session 规则做差集同步（孤儿清理 + 缺失重建）。
   */
  async restore(persisted: Map<number, { host: string; token: string | null }>): Promise<void> {
    let existing: chrome.declarativeNetRequest.Rule[] = [];
    try {
      existing = await chrome.declarativeNetRequest.getSessionRules();
    } catch {
      existing = [];
    }

    // 孤儿清理：本扩展区间内、不属于当前意图集的规则
    const desiredTabs = new Set(persisted.keys());
    const removals: number[] = [];
    for (const rule of existing) {
      const inOurs = rule.id >= AUTH_BASE;
      const orphans = (rule.condition.tabIds ?? []).every((t) => !desiredTabs.has(t));
      if (inOurs && orphans) {
        removals.push(rule.id);
      }
    }
    if (removals.length) {
      try {
        await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: removals });
      } catch {
        // 忽略
      }
    }

    nextAuthId = Math.max(
      AUTH_BASE,
      ...existing.filter((r) => r.id >= AUTH_BASE && r.id < COOKIE_BASE).map((r) => r.id + 1),
      AUTH_BASE,
    );
    nextCookieId = Math.max(
      COOKIE_BASE,
      ...existing.filter((r) => r.id >= COOKIE_BASE && r.id < CACHE_BASE).map((r) => r.id + 1),
      COOKIE_BASE,
    );
    nextCacheId = Math.max(
      CACHE_BASE,
      ...existing.filter((r) => r.id >= CACHE_BASE).map((r) => r.id + 1),
      CACHE_BASE,
    );

    installed.clear();
    for (const [tabId, info] of persisted) {
      await this.applyBinding(info.host, tabId, info.token ?? null);
    }
  },
};
