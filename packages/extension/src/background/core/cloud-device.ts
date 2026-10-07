import type { CloudDevicePoll, CloudDeviceStart } from '../../shared/messages';
import {
  CLOUD_DEFAULT_BASE_URL,
  anonymousRequest,
  fetchMeEmail,
  invalidateCloudCache,
  setCloudAuth,
} from './cloud-store';

/**
 * 云端账号库的设备授权（**RFC 8628 设备流**，v3.14.1 起取代"网页出码、人抄进应用"）。
 *
 * 三步：
 *   1. `POST /api/auth/device-start` → 服务端给 `deviceCode`（**设备自己留着**）+ `userCode`（给人看的）
 *      + `verificationUrl`（服务端拼好的批准页，设备端**直接打开**，不自己拼）。
 *   2. 浏览器里批准（用户在那边登录并点批准）。
 *   3. `POST /api/auth/device-poll` 按 `interval` 秒问一次：approved → 令牌只发一次。
 *
 * ★★ `deviceCode` 的处置纪律（它等价于一次性凭据）：
 *    - **只活在这个模块的内存里**（`session`），不进 `chrome.storage`、不进 DOM、不进日志、不回传页面；
 *    - 流程走到任何终态（approved / denied / expired / consumed / unknown）或用户取消时，
 *      `session` 一律置 null —— 进程重启就等于忘掉它（这也是服务端 `consumed` 状态存在的原因）。
 *
 * ★ 排程不在这里：`pollDeviceFlow()` 只回答"现在怎么样"，**节拍由页面那一个循环按 `interval` 决定**
 *   （这样"取消后真的不再发请求"是页面侧一个布尔量的事，不需要在这里维护定时器 + 中止逻辑）。
 */

/** 设备自报的名字（批准页会显示它，用户据此确认"是我这台浏览器"） */
export const DEVICE_CLIENT_NAME = 'Chrome 扩展 · QuickLogin';
/** 服务端没给 `interval` 时的兜底秒数（观测到服务端会给，这只是"读不到别拿 0 去压测"的兜底） */
const FALLBACK_INTERVAL_S = 3;

interface DeviceSession {
  /** ★ 凭据：换令牌用的长随机串。只在内存里，绝不外传 */
  deviceCode: string;
  baseUrl: string;
  /** 给人看的 8 位码（只用于服务端批准页 / 页面核对用户手输） */
  userCode: string;
  verificationUrl: string;
  /** 当前轮询间隔（秒），服务端每次回包都可以修订它 */
  interval: number;
  /** 本次授权的绝对过期时刻（`expiresIn` 换算而来，页面侧还会自己再兜一层） */
  expiresAt: number;
}

/** 当前这次设备授权；null = 没有进行中的会话（凭据已从内存丢掉） */
let session: DeviceSession | null = null;

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** 读一个"秒数"字段；读不到/不合理就退到 `fallback`（绝不返回 0：那等于把服务端当压测靶子） */
function seconds(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/** 起一次设备授权。**先丢掉上一次会话**：重试就是重新 device-start，绝不复用旧 deviceCode */
export async function startDeviceFlow(clientName: string = DEVICE_CLIENT_NAME): Promise<CloudDeviceStart> {
  session = null;

  const data = asRecord(
    await anonymousRequest<unknown>('/api/auth/device-start', {
      method: 'POST',
      body: { clientName },
    }),
  );

  const deviceCode = str(data.deviceCode) || str(data.device_code);
  const userCode = str(data.userCode) || str(data.user_code);
  const verificationUrl = str(data.verificationUrl) || str(data.verification_uri);
  const expiresIn = seconds(data.expiresIn ?? data.expires_in, 600);
  const interval = seconds(data.interval, FALLBACK_INTERVAL_S);

  if (!deviceCode || !verificationUrl) {
    // 半截响应不能留下来：没有 deviceCode 就换不到令牌，没有 URL 用户就没法批准
    throw new Error('云端未返回完整的设备授权信息（deviceCode / verificationUrl 缺失），请重新发起');
  }
  if (!/^https?:\/\//i.test(verificationUrl)) {
    // 地址不由我们拼、也不该盲开：非 http(s) 一律拒（避免把用户送去 file:// 之类的地方）
    throw new Error('云端返回的批准页地址不是 http(s)，已中止（未打开任何页面）');
  }

  session = {
    deviceCode,
    baseUrl: CLOUD_DEFAULT_BASE_URL,
    userCode,
    verificationUrl,
    interval,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  return {
    verificationUrl,
    userCode,
    expiresIn,
    interval,
    clientName: str(data.clientName) || clientName,
  };
}

/**
 * 问一次授权状态（**调用方按 `interval` 秒调**）。
 * 终态一律顺手把 `session` 丢掉；approved 时把令牌落进 `chrome.storage.local`（页面/管理页刷新即可见）。
 */
export async function pollDeviceFlow(): Promise<CloudDevicePoll> {
  const current = session;
  if (!current) {
    throw new Error('设备授权会话已结束（已取消 / 已超时 / 已批准过），请重新发起登录');
  }
  if (Date.now() >= current.expiresAt) {
    session = null;
    return { status: 'expired' };
  }

  const data = asRecord(
    await anonymousRequest<unknown>(
      '/api/auth/device-poll',
      { method: 'POST', body: { deviceCode: current.deviceCode } },
      current.baseUrl,
    ),
  );

  // ★ 请求期间用户可能点了「取消」（或又发起了一次），那时这个会话已经不是"当前"的了：
  //   此时**什么都不能写**（尤其不能把令牌落盘）—— 否则"取消"就成了摆设。
  if (session !== current) {
    return { status: 'stopped' };
  }

  const nextInterval = seconds(data.interval, current.interval);
  current.interval = nextInterval;
  const status = str(data.status).toLowerCase();

  if (status === 'approved') {
    const token = str(data.token) || str(asRecord(data.session).token);
    if (!token) {
      session = null;
      throw new Error('服务端已批准，但没有下发令牌：请重新发起登录');
    }
    const fernetKey = str(data.fernetKey) || str(asRecord(data.user).fernetKey);
    const user = asRecord(data.user);
    let email = str(data.email) || str(user.email);
    // 展示名与头像：**同一条 user 里就有**，顺手存下来 —— 不存的话界面只能显示邮箱
    const displayName = str(user.displayName);
    const avatar = str(user.avatar);
    const baseUrl = current.baseUrl;
    session = null;
    await setCloudAuth({ baseUrl, token, fernetKey, email, displayName, avatar });
    // 换了会话就丢掉上一个会话的快照缓存：新登录的账号**绝不能**读到旧会话的列表
    invalidateCloudCache();
    if (!email) {
      // 邮箱只为界面显示"已登录谁"；取不到不影响可用性，也不该让登录失败
      email = await fetchMeEmail();
      if (email) {
        await setCloudAuth({ baseUrl, token, fernetKey, email, displayName, avatar });
      }
    }
    return { status: 'approved', email };
  }

  if (status === 'pending') {
    return { status: 'pending', interval: nextInterval };
  }

  // 终态：凭据用完即弃
  session = null;
  if (status === 'denied' || status === 'expired' || status === 'consumed' || status === 'unknown') {
    return { status };
  }
  // 不认识的 status 不当成 pending 轮询下去（那会一直问到超时），也不瞎猜语义
  throw new Error(`设备授权返回了未知状态「${status || '(空)'}」：已停止轮询，请重新发起登录`);
}

/** 放弃本次授权：`deviceCode` 从内存丢掉。返回是否真的丢掉了一个会话（便于界面/诊断分辨） */
export function cancelDeviceFlow(): boolean {
  const had = session !== null;
  session = null;
  return had;
}
