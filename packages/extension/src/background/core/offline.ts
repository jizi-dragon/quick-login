/**
 * 离线错误 —— **单独一个模块，为了让 `cloud-store` 与 `parallel-store` 都能用**。
 *
 * # 为什么值得单独一个类型
 *
 * "离线"与"服务端 500"、"登录过期"是三件完全不同的事，而它们都长着同一张
 * `Error` 的脸。区分它们决定了**读路径敢不敢回落、写路径该说什么话**：
 *
 * | 情况 | 读路径 | 写路径 | 界面该说的话 |
 * |---|---|---|---|
 * | 网络不通/超时（本类） | **回落到只读副本** | 拒绝 | "离线，这是上次的副本" |
 * | 401 令牌过期 | **不回落**（回落会让用户以为"还能用"而不去重新登录） | 拒绝 | "登录已过期，请重新登录" |
 * | 403 未授权 host | 不回落 | 拒绝 | "还没授权访问云端地址" |
 * | 5xx / 格式错 | 不回落 | 拒绝 | 服务端的问题 |
 *
 * ★ 放在独立文件是为了**避开循环依赖**：`cloud-store`（HTTP 层，抛它）与
 *   `parallel-store`（门面，判它）互相 import，而 ES 模块的循环在
 *   `iife` 打包下不会报错，只会在运行时给出 `undefined` —— 那时 `instanceof`
 *   永远为 false，**回落静默失效**（表现是"离线时列表空了"）。
 */

export class OfflineError extends Error {
  readonly code = 'offline';
  readonly isOfflineError = true;
  constructor(action: string) {
    super(`离线：${action}需要连接云端。当前显示的是上次同步的只读副本。`);
    this.name = 'OfflineError';
  }
}

/**
 * 判定。**只看标记字段，不用 `instanceof`**。
 *
 * ★ 理由：跨 realm / 跨打包边界时 `instanceof` 会失败（两个模块各自持有一份类定义），
 *   而失败方式是**静默的 false** —— 离线回落不生效，用户看到空列表。
 *   标记字段没有这个问题。
 */
export function isOfflineError(e: unknown): e is OfflineError {
  return Boolean(
    e && typeof e === 'object' && (e as { isOfflineError?: boolean }).isOfflineError === true,
  );
}
