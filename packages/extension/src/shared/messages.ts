import type { ParallelAccount, ParallelAccountStatus, SiteGrant } from './types';

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/** UI / content ⇄ background 的请求协议 */
export type RuntimeRequest =
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
  | { kind: 'data.export' }
  | { kind: 'data.import'; data: DataBackup }
  /* ---- 数据源（本地 ↔ 云端，v3.14）---- */
  | { kind: 'cloud.state' }
  /**
   * @deprecated 手抄授权码那条老路（网页出码 → 人抄进扩展 → device-token）。
   * 端点还在，但**新流程一律走 `cloud.device.*`**（RFC 8628 设备流，见 v3.14.1）。
   */
  | { kind: 'cloud.auth'; code: string }
  /* ---- 云端设备授权（RFC 8628 设备流，v3.14.1）---- */
  /** 起一次设备授权（无凭据）：服务端返回批准页 URL；`deviceCode` 留在 SW 内存里，不回传 */
  | { kind: 'cloud.device.start'; clientName?: string }
  /**
   * 查一次授权状态。**调用方必须按 `interval` 秒调**：这是唯一无需凭据即可调用的端点族，
   * 轮询太密等于给服务端做压测（SW 侧不排程，节拍由页面那一个循环决定）。
   */
  | { kind: 'cloud.device.poll' }
  /** 放弃本次授权：SW 把 `deviceCode` 从内存里丢掉（页面侧同时停掉轮询循环） */
  | { kind: 'cloud.device.cancel' }
  /* ---- 实例状态轮盘（v3.15：Alt+W）---- */
  /**
   * 问「当前页签是不是可操作的对象实例页」。
   * 走 sender.tab（而不是让页面自报）——注入的浮层与目标页签必须是同一个，
   * 由调用方自报 tabId 等于把「操作了哪个页签」交给页面决定。
   */
  | { kind: 'status.context' }
  /** 读状态列表（GetFormInstance → GetListByBasicId 两步链路，在页面主世界执行） */
  | { kind: 'status.load' }
  /** 切状态（点即执行；成功后由 background 延时刷新该页签） */
  | { kind: 'status.change'; code: string; name: string }
  /* ---- 常用页面书签轮盘（v3.16：Alt+1）---- */
  /** 取书签清单（空则回落内置默认；由 background 统一归一化，浮层不自己读 storage） */
  | { kind: 'favorites.list' }
  /** 在新标签页打开某个书签；`baseOrigin` 为空时按当前活动页签的 origin 兜底 */
  | { kind: 'favorites.open'; path: string; baseOrigin?: string };

/**
 * 备份文件结构（v1）。
 *
 * ★ v3.18：**不再包含任何凭据材料**。
 *   旧版带 `cryptoSeed` + 每账号的 AES-GCM `credentials`，而本地凭据存储已废除
 *   （密钥种子与密文同处一台机器，防不住"扩展数据目录被整份拿走"）⇒
 *   那份密文既解不开、也不该再产生。
 *   现在导出的是**配置**（站点 / 标题 / 盒子 / 用户名），换机器时省去重配，但不含秘密。
 */
export interface DataBackup {
  format: 'quicklogin-backup';
  version: 1;
  exportedAt: string;
  /** 授权站点 host 清单 */
  sites: string[];
  boxes: { default?: string; remembered?: string[]; disabled?: string[] };
  accounts: Array<{
    siteHost: string;
    tabName: string;
    box?: string;
    /**
     * ★ v3.18：**只导元数据，不含任何凭据材料**。
     *
     * 旧格式这里是 `credentials: { encryptedUsername, encryptedPassword, iv, ivPassword } | null`
     * 加上顶层的 `cryptoSeed`，导入时现场解密。而本地凭据存储已废除
     * （密钥种子与密文同处一台机器，防不住"扩展数据目录被整份拿走"）⇒
     * 那份密文既解不开、也不该再产生。导出配置，口令留云端。
     */
    username?: string;
  }>;
}

export type RuntimeResponse =
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
  | { kind: 'data.export'; result: Result<DataBackup> }
  | { kind: 'data.import'; result: Result<{ created: number; skipped: number; hosts: string[] }> }
  /* ---- 数据源（本地 ↔ 云端，v3.14）---- */
  | { kind: 'cloud.state'; result: Result<CloudState> }
  | { kind: 'cloud.auth'; result: Result<{ email: string }> }
  /* ---- 云端设备授权（RFC 8628 设备流，v3.14.1）---- */
  | { kind: 'cloud.device.start'; result: Result<CloudDeviceStart> }
  | { kind: 'cloud.device.poll'; result: Result<CloudDevicePoll> }
  | { kind: 'cloud.device.cancel'; result: Result<{ cancelled: boolean }> }
  /* ---- 实例状态轮盘（v3.15：Alt+W）---- */
  | { kind: 'status.context'; result: Result<StatusContext> }
  | { kind: 'status.load'; result: Result<StatusList> }
  | { kind: 'status.change'; result: Result<{ name: string }> }
  /* ---- 常用页面书签轮盘（v3.16：Alt+1）---- */
  | { kind: 'favorites.list'; result: Result<FavoriteItem[]> }
  | { kind: 'favorites.open'; result: Result<{ url: string }> };

/**
 * 实例状态上下文（v3.15）：从**当前活动页签的 URL** 解析出来的可操作对象。
 * `bid` = objectId、`id` = instanceId、`mid` = 菜单 id（用于 `/web/view` 上反查 objectId）。
 */
export interface StatusContext {
  href: string;
  origin: string;
  objectId: string;
  instanceId: string;
  menuId: string;
  /** 是否可以继续查状态（至少要能确定 objectId，或能用 mid 反查） */
  operable: boolean;
  /** 不可操作时的可读原因（浮层空态直接显示它） */
  reason: string;
}

/** 一个实例的生命周期状态列表 */
export interface StatusList {
  /** 生命周期名（可能为空：服务端没给） */
  lifecycleName: string;
  /** 当前状态名（接口字段优先，退回页面 DOM 文字；都读不到为空串） */
  currentName: string;
  statuses: Array<{ id: string; code: string; name: string }>;
}

/** 数据源现状（管理页选择器据此渲染；不回传 token 本身） */
export interface CloudState {
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

/** 常用页面书签条目（v3.16）；`path` 支持相对路径（`/admin/...`）或完整网址 */
export interface FavoriteItem {
  name: string;
  path: string;
}

export type { Result };
