export interface Session {
  id: string;
  /** 会话展示名 */
  name: string;
  /** 账号名/用户名 —— 用作标签页标题 */
  accountAlias: string;
  color: string;
  /** 绑定的站点 host，例如 example.com */
  siteHost: string;
  /** 登录成功后的最终 URL（用于重开时直接打开，避免依赖根地址重定向） */
  lastVisitedUrl?: string;
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

/** chrome.cookies.Cookie 中可用于持久化/重建的字段子集 */
export interface CookieRecord {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** chrono 秒 */
  expirationDate?: number;
  sameSite?: chrome.cookies.SameSiteStatus;
  storeId: string;
  session: boolean;
}

export interface CookieBag {
  sessionId: string;
  host: string;
  cookies: CookieRecord[];
  updatedAt: number;
}

export interface SiteGrant {
  host: string;
  grantedAt: number;
}