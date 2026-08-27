export interface Session {
  id: string;
  /** 会话展示名 */
  name: string;
  /** 账号名/用户名 —— 用作标签页标题 */
  accountAlias: string;
  color: string;
  /** 绑定的站点 host，例如 example.com */
  siteHost: string;
  /** 加密存储的账号密码（可选） */
  credentials?: EncryptedCredentials;
  createdAt: number;
  updatedAt: number;
}

/** 加密后的账号密码 */
export interface EncryptedCredentials {
  /** 加密后的用户名（Base64） */
  encryptedUsername: string;
  /** 加密后的密码（Base64） */
  encryptedPassword: string;
  /** 用户名加密使用的 IV（Base64） */
  iv: string;
  /** 密码加密使用的 IV（Base64） */
  ivPassword: string;
  /** 加密时间戳 */
  encryptedAt: number;
}

export interface SiteGrant {
  host: string;
  grantedAt: number;
}

/**
 * 浏览器并行账号（纯扩展模式，不依赖本地引擎）。
 * 每个账号可打开多个标签页并行在线；页签名用于标签标题展示，可自定义。
 */
export interface ParallelAccount {
  id: string;
  /** 绑定的站点 host */
  siteHost: string;
  /** 自定义页签名 —— 该账号标签页的标题 */
  tabName: string;
  /** 账号名（登录用户名） */
  username: string;
  /** 加密存储的密码等凭证 */
  credentials?: EncryptedCredentials;
  color: string;
  createdAt: number;
  updatedAt: number;
}

/** 并行账号运行时状态（由 background 依据绑定表与 token 快照实时计算） */
export interface ParallelAccountStatus {
  tabIds: number[];
  hasToken: boolean;
  /** 站点授权缺失/被停用：DNR 改头与 Cookie 剥离不生效，功能暂停 */
  enforcementOff?: boolean;
}

/** ISOLATED 桥 → background 的上行载荷 */
export type BridgeUpPayload =
  | { op: 'hello'; url: string }
  | { op: 'storageWrite'; key: string; value: string | null }
  | { op: 'authHeader'; value: string };

/** background → ISOLATED 桥的下行载荷 */
export type BridgeDownPayload =
  /** 绑定账号并附带初始快照种子（token 等，用于壳激活瞬间同步灌入命名空间）；
   *  tabId 供壳做页面层缓存分区（_qlck=t<tabId>，DNR urlTransform Chrome 不支持） */
  | { op: 'bind'; accountId: string; tabId?: number; seed?: Record<string, string> }
  | { op: 'unbound' };
