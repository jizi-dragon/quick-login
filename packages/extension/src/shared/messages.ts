import type { ParallelAccount, ParallelAccountStatus, Session, SiteGrant } from './types';

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/** UI / content ⇄ background 的请求协议 */
export type RuntimeRequest =
  | { kind: 'session.list' }
  | { kind: 'session.update'; id: string; patch: Partial<Pick<Session, 'name' | 'accountAlias' | 'color'>> }
  | { kind: 'session.delete'; id: string }
  | { kind: 'session.open'; id: string; host: string }
  | { kind: 'session.openOrCreate'; host: string; username?: string; password?: string; accountAlias?: string }
  | { kind: 'site.grants.list' }
  | { kind: 'site.grant.add'; host: string }
  | { kind: 'par.list' }
  | { kind: 'par.create'; siteHost: string; tabName: string; username: string; password: string; open: boolean; box?: string; scheme?: 'http' | 'https' }
  | { kind: 'par.probeScheme'; host: string }
  | { kind: 'par.update'; id: string; patch: Partial<Pick<ParallelAccount, 'tabName'>> }
  | { kind: 'par.moveBox'; id: string; box: string }
  | { kind: 'par.renameBox'; from: string; to: string }
  | { kind: 'par.deleteBox'; name: string }
  | { kind: 'par.delete'; id: string }
  | { kind: 'par.open'; id: string; forceNewTab?: boolean }
  | { kind: 'par.grantChanged' }
  | { kind: 'ql.diag' }
  | { kind: 'wheel.toggle' }
  | { kind: 'pages.recent' }
  | { kind: 'pages.jump'; url: string }
  | { kind: 'data.export' }
  | { kind: 'data.import'; data: DataBackup }
  /* ---- 数据源（本地 ↔ 云端，v3.14）---- */
  | { kind: 'cloud.state' }
  /**
   * @deprecated 手抄授权码那条老路（网页出码 → 人抄进扩展 → device-token）。
   * 端点还在，但**新流程一律走 `cloud.device.*`**（RFC 8628 设备流，见 v3.14.1）。
   */
  | { kind: 'cloud.auth'; code: string }
  | { kind: 'cloud.migrate' }
  /** 只允许切回本地：切到云端必须走 cloud.migrate（带上传核对），不给"空翻"的后门 */
  | { kind: 'cloud.source.set'; source: 'local' }
  /* ---- 云端设备授权（RFC 8628 设备流，v3.14.1）---- */
  /** 起一次设备授权（无凭据）：服务端返回批准页 URL；`deviceCode` 留在 SW 内存里，不回传 */
  | { kind: 'cloud.device.start'; clientName?: string }
  /**
   * 查一次授权状态。**调用方必须按 `interval` 秒调**：这是唯一无需凭据即可调用的端点族，
   * 轮询太密等于给服务端做压测（SW 侧不排程，节拍由页面那一个循环决定）。
   */
  | { kind: 'cloud.device.poll' }
  /** 放弃本次授权：SW 把 `deviceCode` 从内存里丢掉（页面侧同时停掉轮询循环） */
  | { kind: 'cloud.device.cancel' };

/** 备份文件结构（v1）：种子 + 加密凭证 + 授权站 + 盒子配置（见 tmp 导出脚本） */
export interface DataBackup {
  format: 'quicklogin-backup';
  version: 1;
  exportedAt: string;
  /** 源设备加密种子（导入端用它解密凭证，再以本地种子重加密入库） */
  cryptoSeed: string;
  /** 授权站点 host 清单 */
  sites: string[];
  boxes: { default?: string; remembered?: string[]; disabled?: string[] };
  accounts: Array<{
    siteHost: string;
    tabName: string;
    box?: string;
    credentials: {
      encryptedUsername: string;
      encryptedPassword: string;
      iv: string;
      ivPassword: string;
      encryptedAt?: number;
    } | null;
  }>;
}

export type RuntimeResponse =
  | { kind: 'session.list'; result: Result<Session[]> }
  | { kind: 'session.update'; result: Result<Session> }
  | { kind: 'session.delete'; result: Result<void> }
  | { kind: 'session.open'; result: Result<{ tabId: number }> }
  | { kind: 'session.openOrCreate'; result: Result<{ tabId: number; sessionId: string; reused: boolean }> }
  | { kind: 'site.grants.list'; result: Result<SiteGrant[]> }
  | { kind: 'site.grant.add'; result: Result<SiteGrant> }
  | { kind: 'par.list'; result: Result<Array<ParallelAccount & ParallelAccountStatus & { password: boolean }>> }
  | { kind: 'par.create'; result: Result<ParallelAccount> }
  | { kind: 'par.probeScheme'; result: Result<'http' | 'https'> }
  | { kind: 'par.update'; result: Result<ParallelAccount> }
  | { kind: 'par.moveBox'; result: Result<ParallelAccount> }
  | { kind: 'par.renameBox'; result: Result<{ moved: number }> }
  | { kind: 'par.deleteBox'; result: Result<{ moved: number }> }
  | { kind: 'par.delete'; result: Result<void> }
  | { kind: 'par.open'; result: Result<{ tabId: number; reused: boolean }> }
  | { kind: 'par.grantChanged'; result: Result<boolean> }
  | { kind: 'ql.diag'; result: Result<Record<string, unknown>> }
  | { kind: 'wheel.toggle'; result: Result<{ opened: boolean }> }
  | { kind: 'pages.recent'; result: Result<RecentPageEntry[]> }
  | { kind: 'pages.jump'; result: Result<{ jumped: boolean }> }
  | { kind: 'data.export'; result: Result<DataBackup> }
  | { kind: 'data.import'; result: Result<{ created: number; skipped: number; hosts: string[] }> }
  /* ---- 数据源（本地 ↔ 云端，v3.14）---- */
  | { kind: 'cloud.state'; result: Result<CloudState> }
  | { kind: 'cloud.auth'; result: Result<{ email: string }> }
  | { kind: 'cloud.migrate'; result: Result<CloudMergeReport> }
  | { kind: 'cloud.source.set'; result: Result<{ source: 'local' | 'cloud' }> }
  /* ---- 云端设备授权（RFC 8628 设备流，v3.14.1）---- */
  | { kind: 'cloud.device.start'; result: Result<CloudDeviceStart> }
  | { kind: 'cloud.device.poll'; result: Result<CloudDevicePoll> }
  | { kind: 'cloud.device.cancel'; result: Result<{ cancelled: boolean }> };

/** 数据源现状（管理页选择器据此渲染；不回传 token 本身） */
export interface CloudState {
  source: 'local' | 'cloud';
  /** 是否已持有云端会话（缺省 false = 需要授权码登录） */
  authorized: boolean;
  /** 已登录账号邮箱（未知时为空串） */
  email: string;
  /**
   * 展示名与头像（来自服务端 `/api/auth/profile` 的同一条 `user`）。
   * ★ 纯展示：取不到就回落邮箱前缀、再回落"已登录云端"。
   * 它们**不参与任何鉴权判断** —— 否则会出现"头像没取到于是登录失败了"。
   */
  displayName: string;
  avatar: string;
  /** 云端服务地址（缺省 = 内置地址） */
  baseUrl: string;
}

/**
 * 设备授权第一拍（`POST /api/auth/device-start`）里**可以出网**的那部分。
 * ★ `deviceCode` 不在这里：它是换令牌的凭据，只活在 SW 内存里（不进 DOM / storage / 日志）。
 */
export interface CloudDeviceStart {
  /** 服务端拼好的完整批准页 URL —— 直接 `chrome.tabs.create` 打开它，**不要自己拼** */
  verificationUrl: string;
  /**
   * 8 位数字授权码，只用于服务端的 `/authorize` 批准页。
   * 页面**不渲染它**：仅用来核对用户在"手动输入 8 位码"兜底入口里敲的码是不是本次会话的。
   */
  userCode: string;
  /** 本次授权的总时长（秒）——页面据此自动停止轮询 */
  expiresIn: number;
  /** 轮询间隔（秒）——**必须遵守** */
  interval: number;
  /** 设备自报的名字（批准页会显示） */
  clientName: string;
}

/**
 * 设备授权一拍的结论。前六个是服务端的语义，`stopped` 是本地加的：
 * 本次会话已被取消 / 已被新的一次授权替换（此时不该再有任何请求）。
 */
export type CloudDevicePoll =
  | { status: 'pending'; interval: number }
  | { status: 'approved'; email: string }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'consumed' }
  | { status: 'unknown' }
  | { status: 'stopped' };

/**
 * 本地 → 云端合并回报（由 background 的 migrateLocalToCloud 产生）。
 * 服务端字段为**如实回报**（created/updated/skipped/conflicts…），扩展自加 missingPassword。
 */
export interface CloudMergeReport {
  /** 本地账号总数（= clientAccountCount，也是两个核对点的比照基准） */
  localCount: number;
  /** 明文口令取不到的账号数（无凭证/解密失败）——它们按空口令上传，必须显式告知用户 */
  missingPassword: number;
  /** 上传的站点数 */
  sites: number;
  /** 服务端如实回报：收到的账号条数（核对点一） */
  received: number;
  /** 云端账号总数（核对点二：snapshot 的 counts.accounts） */
  totalAccounts: number;
  created: number;
  updated: number;
  skipped: number;
  conflicts: number;
}

/** 最近配置页条目（v3.13 收敛：仅记录绑定页签，按 host 分组的 MRU） */
export interface RecentPageEntry {
  url: string;
  pageType: string;
  suffix: string;
  subject: string;
  accountAlias: string;
  ts: number;
}

export type { Result };
