/**
 * 日志的强制打码通道。
 *
 * # 为什么必须有这个文件
 *
 * 本扩展**持有用户在各平台的真实口令**（填表要用）。所以"口令不入日志"这条
 * 必须是**结构**，不是纪律 —— 纪律会被忘，而凭据泄露的代价极高。
 *
 * 改造前（2026-10-09 之前）本仓有 **3 处 `console.*`，没有任何 logger 抽象**。
 * 3 处看起来"没用凭据"，但：
 *   · `console.debug('[ql-auto] submit rejected', { errorSeen })` 这种**对象直传**
 *     是典型形态 —— 今天 `errorSeen` 里只有计数，明天有人往里塞一个
 *     `{ username, password }` 做"排障方便"，就落盘了，**而没有任何东西会拦住**。
 *   · 没有统一出口 ⇒ 无法回答"日志里到底有没有凭据"这个问题。
 *
 * # 与服务端的不同
 *
 * 服务端（`akso-vault`）的落盘通道是日志文件，所以打码挂在 `logging.Formatter`
 * 上（写出去之前那一步）。本扩展**没有文件系统**（MV3 的 SW 会被随时终止），
 * 所以出口有两个：
 *   ① `console`（开发者工具）—— 主要出口；
 *   ② `chrome.storage.local` 的诊断环形缓冲 —— 用户不打开 DevTools 时唯一能取到的证据。
 * 两者都只经由本模块的 `log()` 输出 ⇒ 打码仍然只有一个地方。
 *
 * # 判据
 *
 * `tools/verify/log-redaction.mjs`：跑真实的 `redact()`，并在源码上断言
 * **除本模块外零 `console.*`**。
 */

/**
 * 打码占位符。
 *
 * ★ 与服务端保持一致（`«已打码»`），这样两端的日志贴在一起看时不会混淆。
 * ★ 注意：占位符里**含 `a` 这个字符**（"打码"的拼音），所以测试里
 *   **不能**用 `assert !out.includes('a')` 来判断单字符凭据是否被打掉 ——
 *   那会因为占位符本身而失败，看起来像"漏打码，其实是打码成功了"。
 */
export const REDACTED = '«已打码»';

/**
 * 打码规则。**顺序有意义**，从上到下依次应用。
 *
 * ★ 每条规则旁边的注释都记录了一个**实测踩过的**边界，不要凭直觉"简化"它们。
 */
const RULES: Array<{ name: string; re: RegExp; to: string }> = [
  // ① 带引号的值：`"password": "xxx"` / `token: 'xxx'`（JSON 风格最常见）
  //    ★ 键名两侧允许引号：`"secret": "xxx"` 里 `secret` 后面跟的是 `"`
  //      而不是 `:`。早先只写 `(key)(\s*[:=])` 会在这种写法上**完全失配**。
  //    ★ 值下限是 **1 个字符**：一个 `password="a"` 的短口令**仍然是口令**。
  //      早先写 `{3,}` 是为了"怕误伤"，结果短口令完全不打码 ——
  //      误伤的代价（多打几个字符）与漏掉的代价（口令泄露）根本不对称。
  {
    name: '引号值',
    re: new RegExp(
      String.raw`\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key` +
        String.raw`|private[_-]?key|fernet[_-]?key|client[_-]?secret|encKey|plain|code|otp)` +
        String.raw`\b(["']?\s*[:=]\s*)(["'])(.{1,}?)\3`,
      'gi',
    ),
    to: `$1$2$3${REDACTED}$3`,
  },
  // ② 无引号的值：`password=xxx` / `token: xxx`
  //    ★ 值用**贪婪** `[^\s,;'"]+`，不是懒惰。懒惰 + 零宽前瞻会只吃 3 个字符
  //      就满足条件 ⇒ `token=abcdef` 变成 `token=«已打码»def`：
  //      **看起来生效了、其实没打干净**，比完全没生效更危险。
  //    ★ 值字符类排除引号，让带引号的走 ① —— 否则两条规则职责重叠，
  //      日后改 ① 会被 ② 静默接管，而没人知道是哪条在起作用。
  {
    name: '键值对',
    re: new RegExp(
      String.raw`\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key` +
        String.raw`|private[_-]?key|fernet[_-]?key|client[_-]?secret|encKey|plain|code|otp)` +
        String.raw`\b(\s*[:=]\s*)([^\s,;'"]+)`,
      'gi',
    ),
    to: `$1$2${REDACTED}`,
  },
  // ③ Authorization 头 —— 会话令牌就是从这里出去的
  {
    name: 'Authorization',
    re: /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    to: `$1 ${REDACTED}`,
  },
  // ④ URL 查询串里的敏感参数（设备流的 device_code / user_code 也在其中）
  {
    name: 'URL 查询串',
    re: /([?&](?:token|code|password|pwd|key|secret|device_code|user_code)=)[^&\s"']+/gi,
    to: `$1${REDACTED}`,
  },
  // ⑤ Fernet 密钥：base64url 编码的 32 字节 = 44 字符，末尾一个 '='
  //    服务端把 `fernetKey` 下发给客户端用于解 passwordEnc。
  { name: 'Fernet 密钥', re: /\b[A-Za-z0-9_-]{43}=/g, to: REDACTED },
  // ⑥ 裸的长十六进制串（≥32）：设备码哈希 / 会话令牌哈希的常见形状。
  //    ★ 这条**宁可过度**：它也打掉不含凭据的 id。
  //      取舍理由 —— 打掉一个 id 只是"这条日志稍难读"，
  //      漏掉一个令牌是"真实口令泄露"。代价不对称，所以选宽的那边。
  { name: '长十六进制串', re: /\b[0-9a-fA-F]{32,}\b/g, to: REDACTED },
];

/**
 * 把文本里的凭据形状替换掉。
 *
 * ★ 这是个**纯函数**，可以被单独测试 —— 这很重要：
 *   打码逻辑如果只能在"真的打了一条日志"时才能验证，那它基本不会被验证。
 */
export function redact(input: string): string {
  if (!input) return input;
  let out = input;
  for (const rule of RULES) {
    rule.re.lastIndex = 0; // 带 g 的正则是有状态的，复用前必须复位
    out = out.replace(rule.re, rule.to);
  }
  return out;
}

/** 已经打码过的占位符本身不该被二次处理（`«已打码»` 里的中文不会被规则命中，但显式保证）。 */
export const REDACTION_RULES = RULES.map((r) => r.name);
