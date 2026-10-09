/**
 * 验收：日志打码通道（`src/shared/redact.ts` + `src/shared/log.ts`）。
 *
 * 两侧都要验：
 *   · **漏**（false negative）⇒ 凭据真的进了 DevTools / 诊断缓冲，最严重的失败；
 *   · **过度**（false positive）⇒ 正常信息被打掉，日志失去价值，
 *     于是有人会去把打码关掉 —— 那是**下一条**泄露路径。
 *
 * ★ 这个脚本**必须能红**。改完打码规则后如果它仍然全绿，先怀疑它没在验东西。
 *
 * 跑法：node tools/verify/verify-log-redaction.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// ★ 仓库根：tools/verify/ 往上两层。少一层会静默指向 tools/（AGENTS.md 规则 15）
const ROOT = resolve(HERE, '..', '..');
const SRC = join(ROOT, 'packages', 'extension', 'src');

// 直接把 TS 源当文本读进来太脆（要剥类型）。改用 esbuild 现场转译，
// 它与真实构建用同一个编译器 ⇒ 验的就是将要发布的那份代码。
//
// ★ 用 iife + globalName 而不是 format:'esm'：esm 产物导出来时拿不到命名导出
//   （实测 `redact is not a function`）。iife 把导出挂到一个名字上，
//   再用 `new Function` 求值取回来 —— 不依赖 Node 的模块解析，也就不用引 `vm`。
const esbuild = await import('esbuild');
const REDACT_TS = join(SRC, 'shared', 'redact.ts');
const LOG_TS = join(SRC, 'shared', 'log.ts');

const bundle = await esbuild.build({
  entryPoints: [LOG_TS],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: '__qlLog',
  target: 'chrome110',
  platform: 'browser',
  logLevel: 'silent',
});
const code = bundle.outputFiles[0].text;
const mod = new Function(`${code}\nreturn __qlLog;`)();
const { redact, REDACTED, formatArgs, getLogger, setLogLevel, drain, clearBuffer } = mod;
void formatArgs; // 目前只用它做内部拼接，保留解构以便后续加用例

const results = [];
function check(label, ok, detail = '') {
  results.push(ok);
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
}

// ---------------------------------------------------------------- ① 必须打掉
console.log('\n=== 1. 必须被打掉的（漏了就是凭据外泄）===');
const SECRETS = [
  ['等号赋值', 'password=Liyulong0901', 'Liyulong0901'],
  ['冒号赋值', 'token: abcdef1234567890', 'abcdef1234567890'],
  ['大写键名', 'PASSWORD=hunter2xyz', 'hunter2xyz'],
  ['连字符键名', 'api-key=sk-abcdefghijklmn', 'sk-abcdefghijklmn'],
  ['下划线键名', 'private_key=secretvalue', 'secretvalue'],
  // ★ 下面几条是实测踩过的边界，都曾经**完全绕过**打码
  ['JSON 键名带引号', '"secret": "s3cr3t-value-here"', 's3cr3t-value-here'],
  ['整个 JSON 对象', '{"password": "p@ss", "token": "t0k3n9x"}', 'p@ss'],
  ['JSON 第二个键', '{"password": "p@ss", "token": "t0k3n9x"}', 't0k3n9x'],
  ['单引号包键名', "secret='x'", 'x'],
  ['Bearer 头', 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def', 'eyJhbGciOiJIUzI1NiJ9'],
  ['Basic 头', 'Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA'],
  ['设备流 device_code', 'GET /device-token?device_code=9f8e7d6c5b4a', '9f8e7d6c5b4a'],
  ['设备流 user_code', 'GET /approve?user_code=WXYZ-1234', 'WXYZ-1234'],
  ['Fernet 密钥', 'fernetKey = dGhpcy1pcy1hLWZha2UtMzJieXRlLWtleS1mb3ItdGVzdA==',
    'dGhpcy1pcy1hLWZha2UtMzJieXRlLWtleS1mb3ItdGVzdA=='],
  ['裸长十六进制', 'hash 8f14e45fceea167a5a36dedd4bea2543 end',
    '8f14e45fceea167a5a36dedd4bea2543'],
  ['平台的 encKey', 'encKey: 3c9909afec25354d551dae21590bb26e', '3c9909afec25354d551dae21590bb26e'],
];
for (const [label, sample, secret] of SECRETS) {
  const out = redact(sample);
  check(`${label}: ${sample.slice(0, 46)}`, !out.includes(secret), `-> ${out.slice(0, 58)}`);
}

// ★ 单字符凭据要**单独**断言：不能查"这个字符在不在结果里" ——
//   占位符 `«已打码»` **本身就含 `a`**（"打码"的拼音），
//   于是 `!out.includes('a')` 会因占位符而失败，看起来像漏打码，其实是打码成功了。
{
  const out = redact('password="a"');
  check('单字符短口令（单独断言，避开占位符里的 a）',
    out === `password="${REDACTED}"`, `-> ${out}`);
}

// ---------------------------------------------------------------- ② 不该打掉
console.log('\n=== 2. 不该被打掉的（过度匹配会让日志失去价值）===');
const KEEP = [
  'user@example.com',
  '115.231.78.4:44791',
  'GET /api/vault/snapshot HTTP/1.1 200 OK',
  'ql:auto-login',
  '账号 42 个，站点 7 个',
  '9f2c1b3a-4d5e-6f70-8192-a3b4c5d6e7f8',
  '2026-10-09 13:08:19.123',
  'status=active',
  'tabId=12345 frameId=0',
];
for (const sample of KEEP) {
  const out = redact(sample);
  check(`${sample.slice(0, 46)}`, out === sample, out === sample ? '' : `-> ${out}`);
}

// ---------------------------------------------------------------- ③ 幂等
console.log('\n=== 3. 幂等（Formatter / sink 可能被复用多层）===');
{
  const once = redact('password=abc12345');
  check('打两次与打一次相同', redact(once) === once, `${once} -> ${redact(once)}`);
}

// ---------------------------------------------------------------- ④ log() 端到端
console.log('\n=== 4. log() 的端到端（对象序列化 + 打码）===');
{
  clearBuffer();
  setLogLevel('debug');
  const captured = [];
  const realConsole = { ...console };
  for (const m of ['debug', 'info', 'warn', 'error']) console[m] = (...a) => captured.push(a.join(' '));

  const lg = getLogger('test');
  lg.info('password=%s', 'Liyulong0901');
  lg.warn('token=abcdef1234567890');
  // ★ 对象直传 —— 这正是"今天只有计数、明天塞进口令"的那个形态
  lg.error('submit rejected', { username: 'alice', password: 'sup3rs3cret', attempts: 3 });
  lg.debug('正常信息：user@example.com tabId=42');

  for (const m of ['debug', 'info', 'warn', 'error']) console[m] = realConsole[m];

  const joined = captured.join('\n');
  check('log() 里的分隔参数口令被打掉', !joined.includes('Liyulong0901'));
  check('log() 里的 token 被打掉', !joined.includes('abcdef1234567890'));
  check('★ 对象里的 password 被打掉（对象直传路径）', !joined.includes('sup3rs3cret'));
  check('对象的其它字段仍可读（没被整个吞掉）', joined.includes('alice') && joined.includes('attempts'));
  check('正常信息保留', joined.includes('user@example.com') && joined.includes('tabId=42'));
  check('命名空间前缀存在', joined.includes('ql:test'));

  const buf = drain();
  check('环形缓冲里也没有凭据', !JSON.stringify(buf).includes('sup3rs3cret'));
  check('环形缓冲真的收到了记录', buf.length >= 4, `${buf.length} 条`);
  check('缓冲里的 msg 已打码', buf.every((r) => !r.msg.includes('Liyulong0901')));
}

// ---------------------------------------------------------------- ⑤ 结构化：绕不过去
console.log('\n=== 5. 结构：除 log.ts 外不许直接调 console ===');
{
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!name.endsWith('.ts')) continue;
      if (full === LOG_TS) continue;                       // 唯一允许的地方
      const text = readFileSync(full, 'utf8');
      text.split('\n').forEach((line, i) => {
        // 只看**代码**：跳过整行注释
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (/\bconsole\s*\.\s*(log|info|warn|error|debug)\b/.test(line)) {
          offenders.push(`${full.replace(ROOT + '\\', '').replace(ROOT + '/', '')}:${i + 1}`);
        }
      });
    }
  };
  walk(SRC);
  check(
    '源码里零裸 console.*（log.ts 除外）',
    offenders.length === 0,
    offenders.length ? `命中 ${offenders.length} 处：${offenders.join(', ')}` : '',
  );
}

// ---------------------------------------------------------------- ⑥ 闭环：日志必须有人读
console.log('\n=== 6. 闭环：`shared/log.ts` 的产出必须有消费者 ===');
{
  // ★ 这一节是"零裸 console"的**对偶**，两者缺一不可：
  //
  //   | 判据 | 防的是 |
  //   |---|---|
  //   | 零裸 console | 绕开通道**写**出去（凭据外泄） |
  //   | 有人 `drain()` | 写进通道**没人读**（等于没有日志） |
  //
  // 实测发现（2026-10-09）：`drain()` 的调用点是**零** ——
  // `shared/log.ts` 只被 `content/auto-login.ts` import（取 `getLogger`），
  // 而环形缓冲是**纯内存**的。于是日志只出现在 DevTools 控制台，
  // **诊断包里一条都没有**，SW 一被回收就永远看不到了。
  // 那不是"日志少"，是**日志系统没闭环**。
  const consumers = [];
  const walk2 = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walk2(full); continue; }
      if (!name.endsWith('.ts') || full === LOG_TS) continue;
      const text = readFileSync(full, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (/\bdrain\s*\(/.test(line)) {
          consumers.push(`${full.replace(ROOT + '\\', '').replace(ROOT + '/', '')}:${i + 1}`);
        }
      });
    }
  };
  walk2(SRC);
  check('`drain()` 至少有一个消费者（否则日志没人读）', consumers.length > 0,
    consumers.length ? consumers.join(', ') : '★ 零调用点');

  // 消费者必须是**能带上诊断包**的那条路：`ql.diag` handler。
  const sw = readFileSync(join(SRC, 'background', 'service-worker.ts'), 'utf8');
  const diagCase = /case 'ql\.diag'[\s\S]*?return \{ kind: 'ql\.diag'/.exec(sw);
  check('`ql.diag` handler 把日志缓冲带上（诊断包才拿得到）',
    !!diagCase && /out\.logs\s*=\s*drain\(\)/.test(diagCase[0]));

  // 前端诊断包必须**收**它（否则 handler 带了也没人写进文件）
  const panel = readFileSync(join(SRC, 'ui', 'parallel', 'parallel.ts'), 'utf8');
  const bundle = /const bundle = \{[\s\S]*?\n    \};/.exec(panel);
  check('诊断包的 bundle 里含 `appLogs`', !!bundle && /appLogs\s*:/.test(bundle[0]));
  check('诊断包的 bundle 里含 `logLevel`', !!bundle && /logLevel\s*:/.test(bundle[0]));

  // ★ 判据自身的前提：确认我读到了那两段代码（见 PITFALLS #13 —— 取不到时代码
  //   会静默返回空串、断言恒假，而报错读起来像"被测代码有问题"）
  check('判据前提：确实取到了 `ql.diag` 的 case 块', !!diagCase);
  check('判据前提：确实取到了诊断包的 bundle 块', !!bundle);
}

// ---------------------------------------------------------------- 工具

/**
 * 剥掉**注释**与**字符串字面量**后的代码。
 *
 * ## ★ 为什么每个"结构判据"都要先用它（本仓第四次踩同一个坑）
 *
 * 我曾在代码旁写"这里原先写的是 `diag(...)`"来解释降级原因 ——
 * 而裸的 `/\bdiag\s*\(/` **命中了那句注释**，判据假红。
 * 同一个坑的历史：`urlTransform`（PITFALLS #1）、`RETURNING`（#14）、
 * `is_admin`（akso-vault #19）。规律：**「解释为什么不用 X」的文本必然包含 X。**
 *
 * ⇒ 判据只看**运行时会执行的东西**。
 *   ★ 顺序要紧：**先剥字符串再剥行注释**，否则 `'//'` 这种字面量会把后面的
 *     真代码当注释吃掉（反向失效，那是更坏的一类）。
 */
const stripLiterals = (code) => code
  .replace(/\/\*[\s\S]*?\*\//g, ' ')                       // ① 块注释
  .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')                // ② 模板串
  .replace(/'(?:\\[\s\S]|[^'\\\n])*'/g, "''")              // ③ 单引号串
  .replace(/"(?:\\[\s\S]|[^"\\\n])*"/g, '""')              // ④ 双引号串
  .replace(/\/\/[^\n]*/g, ' ');                            // ⑤ 行注释（必须在字符串之后）

// ---------------------------------------------------------------- ⑦ 三通道分工
console.log('\n=== 7. 三通道分工：`diag()` 不许写在热路径上 ===');
{
  // ## 为什么需要这一节
  //
  // `ql:diag` 是 **环形 60** 的 `storage.local` 缓冲，而写它的调用点有 **45 个**
  // （`tab-rules.ts` 5 + `parallel-session.ts` 40）。也就是说它的容量是**稀缺资源**。
  //
  // 实测发现（2026-10-09）：`parallel-session.ts` 的 `isEnforceable()` **缓存命中**
  // 那一支在**每次调用**时都写一条 `diag()` —— 而它在每一次导航 / 每一次请求判定上
  // 都会被调用。后果不是"日志多"，而是**把有用的日志挤掉**：
  // `tab-rules.ts` 的 `addRule #N 失败`（DNR 规则装不上 —— 历史上整个网络平面
  // 因此一起死过）会在几秒内被"缓存命中"刷出缓冲。
  //
  // ⇒ 这是一条**设计规则**，不是风格偏好：
  //
  //   | 通道 | 存储 | 谁该用 |
  //   |---|---|---|
  //   | `log.debug()` | 内存环形 200 + DevTools | **热路径**（默认 `info` 级 ⇒ 生产静默、零存储开销） |
  //   | `diag()` | `storage.local` 环形 60 | **罕见但关键**：失败 / 降级 / 状态跃迁 |
  //   | `forensics()` | `storage.local` 环形 120 | **结构化事件**（可按字段过滤、进诊断包） |
  const ps = readFileSync(join(SRC, 'background', 'core', 'parallel-session.ts'), 'utf8');

  // 取指定函数体（跳过参数表再配平 —— 见 PITFALLS #13，别从签名开头数花括号）
  const bodyOf = (src, name) => {
    const head = new RegExp(
      `(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`,
    ).exec(src);
    if (!head) return null;
    let depth = 0;
    let bodyStart = -1;
    for (let j = src.indexOf('(', head.index); j < src.length; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') {
        depth--;
        if (depth === 0) {
          const brace = src.indexOf('{', j);
          if (brace < 0) return null;
          bodyStart = brace;
          break;
        }
      }
    }
    if (bodyStart < 0) return null;
    let d = 0;
    for (let j = bodyStart; j < src.length; j++) {
      if (src[j] === '{') d++;
      else if (src[j] === '}') { d--; if (d === 0) return src.slice(bodyStart, j + 1); }
    }
    return null;
  };

  const enfBody = bodyOf(ps, 'isEnforceable');
  check('判据前提：确实取到了 `isEnforceable` 的函数体', enfBody !== null);

  const enfCode = enfBody ? stripLiterals(enfBody) : '';

  // ★★ 判据必须落在**那个具体分支**上，不能落在整个函数体上。
  //
  // 第一版写的是"整个 `isEnforceable` 里没有 `diag()`" —— 实测**假红**，
  // 而且假红得**很有道理**：函数里另外两处 `diag()`（停用名单 / 授权实查）
  // **每个 host 只走一次**（之后进 `enforcement` 缓存）⇒ 它们根本不是热路径，
  // 留在 `diag()` 里是对的（它们是"罕见但关键"：网络平面能否执行的判定依据）。
  //
  // 真正每次调用都会走到的是**缓存命中**那一支。⇒ 只断言它。
  // （教训：判据的范围要按**代码的真实控制流**划，不能按"我改过这个函数"划。）
  const quickReturn = /if\s*\(\s*cached\s*!==\s*undefined\s*\)\s*\{([\s\S]*?)\n\s*\}/.exec(enfCode);
  check('判据前提：确实取到了 `isEnforceable` 的缓存命中分支', quickReturn !== null);
  const branch = quickReturn ? quickReturn[1] : '';
  check(
    '缓存命中分支（真热路径）里没有 `diag()` —— 它每次调用都会走到',
    !!quickReturn && !/\bdiag\s*\(/.test(branch),
    /\bdiag\s*\(/.test(branch) ? '★ 热路径又在写 storage 缓冲了' : '',
  );
  check('缓存命中分支有 `log.debug` 轨迹（降级不是删掉）', /log\.debug\(/.test(branch));

  // 反向：`diag()` 必须**仍然**用在罕见失败面（否则这次"降级"被误读成"日志都该删"）
  check('`diag()` 仍被用于罕见失败面（未被一刀切删掉）',
    /\bvoid diag\(/.test(stripLiterals(ps)));

  // 三通道的命名空间前缀必须一致（都经 `getLogger`，不直接 console）
  check('`parallel-session` 模块取 logger 走 `getLogger`',
    /getLogger\('parallel-session'\)/.test(ps));
}

// ---------------------------------------------------------------- ⑧ 离线判定只有一处
console.log('\n=== 8. 离线判定：`OfflineError` / `isOfflineError` 只有一处声明 ===');
{
  // ## 为什么这条值得单列
  //
  // 实测（2026-10-09）：`parallel-store.ts` **自己又定义了一份** `OfflineError`
  // 与 `isOfflineError`（与 `offline.ts` 逐字相同的第二个副本）。
  //
  // 它当时**没有**出问题 —— 因为判定看的是**标记字段**
  // （`e.isOfflineError === true`）而不是 `instanceof`，所以两份类定义的实例互相认得。
  //
  // ★ 但这正是 `offline.ts` 文件头警告过的形态：只要有人把判定
  //   "顺手改成 `instanceof`"（那看起来是**更正规**的写法），
  //   离线回落就会**静默失效** —— 表现是"离线时列表空了"，而不是任何报错。
  //   ⇒ 一个类型只有一处声明，是这条静默失效路径的**唯一**结构性防线。
  //
  // ★ 顺带钉住"判定必须用标记字段"：那是让两份定义也能互通的**唯一**原因，
  //   也是跨打包边界（esbuild `iife`）仍然正确的原因。
  const walkTypes = [];
  const walkDir = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walkDir(full); continue; }
      if (name.endsWith('.ts')) walkTypes.push(full);
    }
  };
  walkDir(SRC);

  const classDefs = [];
  const fnDefs = [];
  for (const f of walkTypes) {
    const code = stripLiterals(readFileSync(f, 'utf8'));
    const rel = f.replace(ROOT + '\\', '').replace(ROOT + '/', '');
    if (/export\s+class\s+OfflineError\b/.test(code)) classDefs.push(rel);
    if (/export\s+function\s+isOfflineError\s*\(/.test(code)) fnDefs.push(rel);
  }

  check('`OfflineError` 类只声明一处', classDefs.length === 1,
    classDefs.length === 1 ? classDefs[0] : `★ ${classDefs.length} 处：${classDefs.join(', ')}`);
  check('`isOfflineError` 只声明一处', fnDefs.length === 1,
    fnDefs.length === 1 ? fnDefs[0] : `★ ${fnDefs.length} 处：${fnDefs.join(', ')}`);

  // 判定必须用**标记字段**，不能用 `instanceof`
  const offlineSrc = readFileSync(join(SRC, 'background', 'core', 'offline.ts'), 'utf8');
  const fnBody = /export\s+function\s+isOfflineError[\s\S]*?\n\}/.exec(stripLiterals(offlineSrc));
  check('判据前提：取到了 `isOfflineError` 的函数体', fnBody !== null);
  check('判定用标记字段（`isOfflineError === true`），**不用** `instanceof`',
    !!fnBody && /isOfflineError\s*===\s*true/.test(fnBody[0]) && !/instanceof/.test(fnBody[0]));

  // 离线回落的分支必须有日志（否则"为什么离线还能看/为什么改不了"无从查起）
  const psrc = stripLiterals(readFileSync(join(SRC, 'background', 'core', 'parallel-store.ts'), 'utf8'));
  check('离线回落分支有日志（`log.warn` 出现在 loadSnapshot 附近）',
    /log\.warn\([^)]*离线[\s\S]{0,200}?loadSnapshot\(/.test(psrc)
    || /loadSnapshot\(\)[\s\S]{0,120}?log\.warn\(/.test(psrc));
}

// ---------------------------------------------------------------- ⑨ SW 入口不静默
console.log('\n=== 9. SW 入口：消息分流不许静默落空 ===');
{
  // ## 这一节防的是什么
  //
  // 实测（2026-10-09）：`service-worker.ts` 的 `dispatch()` 的 switch **没有 `default`**。
  //
  // 后果很隐蔽：一个未知（拼错 / 已删 / UI 与 SW **版本不匹配**）的 `kind`
  // 让 switch 静默落空，而 `dispatch()` 的返回类型是 `Promise<RuntimeResponse>`
  // ⇒ TypeScript 认为**一定有返回值** ⇒ `undefined` 静默流向 `sendResponse(undefined)`。
  // UI 侧拿到 `undefined`，一句"点了没反应"背后**没有任何线索**，
  // 而 `fail()`（所有 handler 失败的收口）当时也**完全静默**。
  //
  // ⇒ 三件事一起钉住：① 有 `default`；② `default` 与 `fail` 都记日志；
  //   ③ `dispatch` 的 case 与消息契约**同步**（那是"两处声明同一事实"，
  //      不一致时的失败形态正是上面那个静默落空）。
  // ★★ 这里的**剥离范围**踩了两个坑，都值得记：
  //
  //   ① `@ts-expect-error` **本身是注释** ⇒ 在 `stripLiterals` 之后**查不到**。
  //      它必须去**原始**源码里找。
  //   ② 契约里的 `kind: 'par.list'` —— 那个 `'par.list'` **是字符串字面量**，
  //      被剥成 `''` ⇒ 提取到 **0 个 kind**。
  //      而 `[...].every()` 对**空集合返回 true** ⇒ "契约同步"那条判据
  //      会**退化成永远绿**（正是 akso-vault PITFALLS #10 那个形态：
  //      `check_deps.mjs` 的检查数掉到 0 而它打印「检查 0 处」看起来完全正常）。
  //
  //   ⇒ 规则：**"剥注释"只用于"怕被自己的解释性文字弄红"的断言**；
  //     凡是要**读字符串字面量的内容**的断言，必须用**原始**源码。
  //     并且对"集合可能为空"的判据一律加**自证前提**。
  const swSrc = readFileSync(join(SRC, 'background', 'service-worker.ts'), 'utf8');
  const swCode = stripLiterals(swSrc);

  // dispatch 的函数体：结构（有 default / 有 log.error）用剥过的版本，
  // 但 `@ts-expect-error` 要从**原始**里取对应区间。
  const dispatchBody = /async function dispatch\(req: RuntimeRequest\)[\s\S]*?\n\}/.exec(swCode);
  check('判据前提：取到了 `dispatch` 的函数体', dispatchBody !== null);
  const d = dispatchBody ? dispatchBody[0] : '';

  check('`dispatch` 有 `default` 分支（未知 kind 不再静默落空）', /^\s*default:\s*\{/m.test(d));
  check('`default` 分支记了日志', /default:\s*\{[\s\S]{0,400}?log\.error\(/.test(d));

  // ★ 用**原始**源码取 default 分支那一段，再找注释
  const rawDispatch = /async function dispatch\(req: RuntimeRequest\)[\s\S]*?\n  \}\n\}/.exec(swSrc);
  const rawDefault = (rawDispatch ? rawDispatch[0] : '').split(/^\s*default:\s*\{/m)[1] ?? '';
  check('`default` 用 `@ts-expect-error` 显式标注类型逃逸',
    /@ts-expect-error/.test(rawDefault));
  check('判据前提：确实取到了 `default` 分支的原文', rawDefault.length > 0);

  // `fail()` 是全部 26 个消息类型的失败收口 —— 它必须记日志
  const failBody = /function fail\(error: unknown\)[\s\S]*?\n\}/.exec(swCode);
  check('判据前提：取到了 `fail` 的函数体', failBody !== null);
  check('`fail()` 记了日志（26 个 handler 的失败收口）',
    !!failBody && /log\.error\(/.test(failBody[0]));

  // `dispatch` 入口有 trace（"消息到底有没有到 SW"）
  check('`dispatch` 入口有 `log.debug` trace', /log\.debug\(/.test(d));

  // ---------- 契约与实现同步（用**原始**源码：kind 名是字符串字面量） ----------
  const msgsRaw = readFileSync(join(SRC, 'shared', 'messages.ts'), 'utf8');
  const reqUnion = /export type RuntimeRequest =([\s\S]*?);\n/.exec(msgsRaw);
  check('判据前提：取到了 `RuntimeRequest` 联合', reqUnion !== null);
  const reqKinds = new Set(
    (reqUnion ? reqUnion[1] : '').match(/kind:\s*'[^']+'/g)?.map((s) => /'([^']+)'/.exec(s)[1]) ?? [],
  );
  const caseKinds = new Set(
    (swSrc.match(/case\s*'[^']+':/g) ?? []).map((s) => /'([^']+)'/.exec(s)[1]),
  );
  // 在 `onMessage` 里**前置分流**（不进 dispatch 的 switch）的 kind
  const preKinds = new Set(
    (swSrc.match(/\.kind === '[^']+'/g) ?? []).map((s) => /'([^']+)'/.exec(s)[1]),
  );

  // ★★ 空集自证：集合为空时下面两条 `every` 会**恒真**（假绿）。
  //   实测踩过：剥离把 kind 名弄成空串，于是 `reqKinds` 为空，
  //   两条断言"都通过"而其实什么都没验。
  check('判据前提：契约 kind 集合非空', reqKinds.size > 0, `${reqKinds.size} 个`);
  check('判据前提：dispatch case 集合非空', caseKinds.size > 0, `${caseKinds.size} 个`);

  check('契约里的每个 kind 都有处理分支（dispatch 或前置分流）',
    [...reqKinds].every((k) => caseKinds.has(k) || preKinds.has(k)),
    [...reqKinds].filter((k) => !caseKinds.has(k) && !preKinds.has(k)).join(', '));
  check('`dispatch` 没有契约之外的孤例 case',
    [...caseKinds].every((k) => reqKinds.has(k)),
    [...caseKinds].filter((k) => !reqKinds.has(k)).join(', '));
  console.log(`      （契约 ${reqKinds.size} 个 kind；dispatch 侧 ${caseKinds.size} 个 case；`
    + `前置分流 ${preKinds.size} 个）`);
}

// ---------------------------------------------------------------- ⑩ 网络平面失败可见
console.log('\n=== 10. 网络平面：规则装不上/摘不掉必须可见 ===');
{
  // ## 这一节防的是什么
  //
  // `tab-rules.ts` 是**七个隔离平面里的网络平面**（AUTH + COOKIE 两条 DNR 规则）。
  // 历史教训（`PITFALLS #1`、`#8`）：`updateSessionRules` 的失败会让
  // **整个网络平面一起死**，而当时唯一的信号只有一行 `diag()`（环形 60，会被挤掉）。
  //
  // ★★ 更危险的是**两条规则都装失败**那种形态：
  //   页签**完全没有网络平面保护**（既不回放 Cookie，也不改 AUTH 头），
  //   而它与"装好了"在界面上**长得一样** —— 平台照样能打开，
  //   只是**以错误的身份在跑**（串号）。
  //
  // ⇒ 钉住三件事：① `addOne` 失败必须 `log.error`；② `applyBinding` 必须对
  //   "该装却装不上"报 `log.error`（而不是只写 `debug` 轨迹）；
  //   ③ 移除失败也必须 `log.error`（它的方向与安装失败**相反**：
  //   装了没生效 vs 该失效的还生效）。
  //
  // ★ 读取方式遵循规则 24：这些断言找的都是**代码标识符**（`log.error(` / `getLogger(`），
  //   不是字符串字面量的内容 ⇒ 用剥过的源码（避免被自己的注释弄红）。
  //   而"哪个函数体"用与第 7 节相同的 `bodyOf`（跳过参数表再配平）。
  // ★★ 这一节**又踩了规则 24 那个坑的变体**，两次都值得记：
  //
  //   ① `getLogger('tab-rules')` 里的 `'tab-rules'` 是**字符串字面量** ⇒
  //      剥过之后变成 `getLogger('')` ⇒ 断言查不到。
  //   ② 更隐蔽：我要断言的 AUTH / COOKIE / "移除" 这些关键字
  //      **也都在 `log.error('...')` 的字符串里** ⇒ 同样被剥掉。
  //
  //   ⇒ 规则（与 #24 一致，但这次要**在同一节里混用两种源码**）：
  //     · 找**标识符**（`log.error(` / `diag(` / `log.debug(` / `getLogger`）→ 用**剥过的**
  //     · 找**字面量的内容**（`'tab-rules'` / `AUTH` / `COOKIE` / `移除`）→ 用**原文**
  //     ★ 而"哪个函数体"必须从**同一份**源码里切出来 —— 不能拿剥过的边界去原文里查
  //       （行号虽然一致，但混用容易出错）。所以下面切两遍，各查各的。
  const trSrc = readFileSync(join(SRC, 'background', 'core', 'tab-rules.ts'), 'utf8');
  const trCode = stripLiterals(trSrc);

  const bodyOfFn = (src, name) => {
    const head = new RegExp(
      `(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`,
    ).exec(src);
    if (!head) return null;
    let depth = 0;
    let bodyStart = -1;
    for (let j = src.indexOf('(', head.index); j < src.length; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') {
        depth--;
        if (depth === 0) {
          const brace = src.indexOf('{', j);
          if (brace < 0) return null;
          bodyStart = brace;
          break;
        }
      }
    }
    if (bodyStart < 0) return null;
    let d = 0;
    for (let j = bodyStart; j < src.length; j++) {
      if (src[j] === '{') d++;
      else if (src[j] === '}') { d--; if (d === 0) return src.slice(bodyStart, j + 1); }
    }
    return null;
  };
  /** `applyBinding` 是对象方法而非 function 声明，单独取（剥过/原文各切一次） */
  const applyOf = (src) => {
    const m = /async applyBinding\([\s\S]*?\n  \},/.exec(src);
    return m ? m[0] : null;
  };

  // ① 找标识符 ⇒ 用剥过的
  check('`tab-rules` 取 logger 走 `getLogger`', /getLogger\(/.test(trCode));
  // ② 找字面量内容 ⇒ 用原文
  check('`tab-rules` 的 logger 命名空间是 `tab-rules`', /getLogger\('tab-rules'\)/.test(trSrc));

  const addOne = bodyOfFn(trCode, 'addOne');
  check('判据前提：取到了 `addOne` 的函数体', addOne !== null);
  check('`addOne` 失败时 `log.error`（装不上必须显眼）',
    !!addOne && /log\.error\(/.test(addOne));
  check('`addOne` 仍然写 `diag()`（人读文本，进诊断包）',
    !!addOne && /diag\(/.test(addOne));

  const abCode = applyOf(trCode);
  const abRaw = applyOf(trSrc);
  check('判据前提：取到了 `applyBinding` 的实现（剥过）', abCode !== null);
  check('判据前提：取到了 `applyBinding` 的实现（原文）', abRaw !== null);
  check('`applyBinding` 有 `log.debug` 轨迹', !!abCode && /log\.debug\(/.test(abCode));
  // ★ 关键：对"该装却装不上"必须 `log.error` —— 那才是"静默以错误身份运行"的探针
  check('`applyBinding` 对"有 token 却装不上 AUTH"报 `log.error`',
    !!abRaw && /AUTH/.test(abRaw) && /log\.error\(/.test(abRaw));
  check('`applyBinding` 对"COOKIE 规则未装上"报 `log.error`',
    !!abRaw && /COOKIE/.test(abRaw) && /log\.error\(/.test(abRaw));
  check('移除规则失败报 `log.error`（方向与安装失败相反）',
    !!abRaw && /移除/.test(abRaw) && /log\.error\(/.test(abRaw));
}

// ---------------------------------------------------------------- ⑪ 凭据不进日志调用
console.log('\n=== 11. 凭据**不进日志调用**（纵深防御）===');
{
  // ## 这一节防的是什么
  //
  // 前面十节验的都是"`log()` **运行时**会打码"。那是**一道**防线。
  // 这一节验的是**第二道**：**根本没有把凭据值交给 `log()`**。
  //
  // ## 为什么需要第二道
  //
  // 打码靠的是 `redact()` 里的 6 条正则。正则**会被绕过**：
  // 一个没见过的键名、一个被 Base64 过、一个被拼进 URL 的凭据 ——
  // 都可能漏过。而"从不把明文交出去"**不依赖任何正则**。
  //
  // ⇒ 两种形态必须分开：
  //   · 安全：`log.info('token=%s', token ? '有' : '无')`  ← 交出去的是**判断结果**
  //   · 危险：``log.info(`token=${token}`)``               ← 交出去的是**明文**
  //
  // ★ 判据（两条，都要）：
  //   ① 模板串**插值**里不得出现凭据标识符；
  //   ② 模板串**之外**的参数里出现凭据标识符时，必须同时出现"存在性判断"的痕迹
  //      （`有` / `无` / `缺` / `Boolean(` / `.length`）—— 否则视为把值传了出去。
  //
  // ★ 实现要点：参数区必须**配平括号**取出（不能用 `[\s\S]*?\)` ——
  //   那样会在第一个 `)` 就截断，而括号在日志里很常见）。
  const CRED = [
    'deviceCode', 'userCode', 'token', 'fernetKey', 'password', 'passwd', 'pwd',
    'secret', 'credential', 'credentials', 'authorization', 'cookieValue', 'cookie',
  ];
  const credRe = (s) => CRED.filter((c) => new RegExp(`(?<![\\w.])${c}(?![\\w])`).test(s));

  const walkAll = [];
  const walkDir2 = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walkDir2(full); continue; }
      if (name.endsWith('.ts')) walkAll.push(full);
    }
  };
  walkDir2(SRC);

  const interpolationLeaks = [];
  const argLeaks = [];
  let callCount = 0;

  for (const f of walkAll) {
    const rel = f.replace(ROOT + '\\', '').replace(ROOT + '/', '');
    const src = readFileSync(f, 'utf8');
    const code = stripLiterals(src); // 剥掉注释：别被"解释为什么不用 X"的说明弄红（规则 23）
    for (const m of code.matchAll(/\blog\.(?:debug|info|warn|error)\(/g)) {
      callCount += 1;
      // 配平括号取参数区
      let d = 1;
      let j = m.index + m[0].length;
      const start = j;
      while (j < code.length && d > 0) {
        if (code[j] === '(') d += 1;
        else if (code[j] === ')') d -= 1;
        j += 1;
      }
      const args = code.slice(start, j - 1);
      const ln = code.slice(0, m.index).split('\n').length;
      // ① 模板串插值（剥过之后模板串内容为空，所以这里其实查不到 —— 见下面的说明）
      for (const tm of args.matchAll(/\$\{([^}]*)\}/g)) {
        const hit = credRe(tm[1]);
        if (hit.length) interpolationLeaks.push(`${rel}:${ln} \${…${hit[0]}…}`);
      }
      // ② 参数区（模板串之外）——有凭据标识符就必须有"存在性判断"痕迹
      //    ★ 剥过之后字符串内容变空，所以"有/无/缺"这些**痕迹也在字符串里**，
      //      会被剥掉 ⇒ 判据会**假红**。
      //      ⇒ 这里必须用**原文**的参数区（与规则 24 一致：读字面量内容用原文）。
    }
  }

  // ★★ 上面 ② 的说明暴露了一个实现选择：`stripLiterals` 会把 `'有'` 也剥掉，
  //   导致"有存在性判断"这个**证据**消失 ⇒ 那条断言会假红。
  //   ⇒ ② 改用**原文**重跑一遍（① 也一并重跑，因为模板串内容同样被剥掉了）。
  for (const f of walkAll) {
    const rel = f.replace(ROOT + '\\', '').replace(ROOT + '/', '');
    const raw = readFileSync(f, 'utf8');
    // 注释剥掉（但保留字符串）——手工做：只去块注释与行注释，**保留字符串**
    const noComment = raw
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    for (const m of noComment.matchAll(/\blog\.(?:debug|info|warn|error)\(/g)) {
      let d = 1;
      let j = m.index + m[0].length;
      const start = j;
      while (j < noComment.length && d > 0) {
        if (noComment[j] === '(') d += 1;
        else if (noComment[j] === ')') d -= 1;
        j += 1;
      }
      const args = noComment.slice(start, j - 1);
      const ln = noComment.slice(0, m.index).split('\n').length;
      // ① 模板串插值
      for (const tm of args.matchAll(/\$\{([^}]*)\}/g)) {
        const hit = credRe(tm[1]);
        if (hit.length) interpolationLeaks.push(`${rel}:${ln} 插值含 ${hit[0]}`);
      }
      // ② 参数区（去掉第一个格式串之后的部分）
      const afterFmt = args.replace(/^\s*(`(?:\\[\s\S]|[^`\\])*`|'(?:\\[\s\S]|[^'\\\n])*')/, '');
      // ★★ 判定必须**逐个凭据标识符**看它**自己**处于什么形态，
      //   不能看"整段里有没有痕迹"。
      //
      //   实测（反证 ⑩）：我第一版写的是"整段含 `有|无|缺|Boolean(|.length` 就算 benign"，
      //   于是缺陷版
      //       log.info('...', token, fernetKey ? '有' : '无', ...)
      //   里那个**裸 `token`** 因为**旁边 `fernetKey` 的 `'有'`** 而被判为 benign
      //   ⇒ 反证报"缺陷版下仍然绿"⇒ **判据有洞**。
      //
      //   ⇒ 安全形态只有三种，且必须**紧贴该标识符**：
      //     · `cred ? … : …`（三元判断）        · `cred.length` / `cred?.length`
      //     · `Boolean(cred)`                    · `cred != null` / `cred !== null`
      //   其余一律视为"把值传了出去"。
      for (const c of credRe(afterFmt)) {
        const benign = new RegExp(
          `(?<![\\w.])${c}(?![\\w])\\s*(\\?|\\.length|\\?\\.length|\\.slice\\(|!==?\\s*null|===?\\s*null)`
          + `|Boolean\\(\\s*${c}\\s*\\)`
          + `|(?<![\\w.])${c}(?![\\w])[^,)]*\\?[^,)]*:`,
        ).test(afterFmt);
        if (!benign) argLeaks.push(`${rel}:${ln} 裸传 ${c}`);
      }
    }
  }

  // ★ 空集自证（规则 24）：callCount 为 0 时上面两条断言恒真
  check('判据前提：确实扫到了 `log.*` 调用', callCount > 0, `${callCount} 处`);
  check('没有任何 `log.*` 的模板串插值里出现凭据标识符',
    interpolationLeaks.length === 0, interpolationLeaks.join(' | '));
  check('凭据标识符只以"存在性判断/长度"形式出现在日志参数里',
    argLeaks.length === 0, argLeaks.join(' | '));
  console.log(`      （扫过 ${callCount} 处 \`log.*\` 调用；凭据清单 ${CRED.length} 个）`);
}

// ---------------------------------------------------------------- ⑫ DOM 一致性（双向）
console.log('\n=== 12. DOM 一致性：HTML ↔ TS 双向 ===');
{
  // ## 这一节补的是规则 20 的**另一半**
  //
  // 规则 20 现在只查一个方向：`getElementById('x')` 的 x 必须在 HTML 里有 `id="x"`
  // （缺了 ⇒ `null` 被 `as HTMLElement` 骗过 ⇒ 运行时崩）。
  //
  // ★ 而本轮发现的缺陷是**反方向**：**HTML 有 id、TS 零引用**。
  //   它不一定崩，但用户会看到：
  //     · 一个**不工作的控件**（`#source-switch` 是个空容器），或
  //     · 一段**讲废弃功能、与当前行为相反**的说明文字
  //       （`#source-help-pop` 在讲"本地 → 云端合并上传、本地数据不会被删除"，
  //        而本地数据源**已整体废除**）。
  //   —— 后者不是崩溃，是**对用户说谎**，而没有门禁会抓到它。
  //
  // ⇒ 白名单：**确实只作静态内容、不需要 TS 触碰**的 id 才允许"零引用"。
  //   加进这个列表时必须写清**为什么它可以不被引用** ——
  //   否则它就退化成"新增孤儿 id 的合法通道"。
  const STATIC_ONLY_IDS = {
    // 盒子弹窗的标题，当前只有"移入盒子"一种用法 ⇒ 静态写死即可。
    // 保留 id 是为了将来出现第二种用法时能改（渐进增强），而不是因为它现在被用着。
    'box-modal-title': '静态标题（当前只有一种用法）',
  };

  // ★ 剥 HTML 注释再找 id —— 这一条**本轮又踩了同一个坑**：
  //   我在清理时写了注释"原先有个 `<span id="auth-bar-text">`"，
  //   而裸正则 `\bid="([^"]+)"` **命中了注释里的那个字面量** ⇒ 探针误报"还有 2 个孤儿"。
  //   这是 PITFALLS #14 / #18 那条教训的**第三次**（规则 23 / 26）。
  const stripHtmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, ' ');

  const htmlFiles = [];
  const walkHtml = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walkHtml(full); continue; }
      if (name.endsWith('.html')) htmlFiles.push(full);
    }
  };
  walkHtml(SRC);

  // TS 的全部文本（id 的引用面）。用它当"被引用"的判据足够：
  // 少引用的代价是"多报一个孤儿"（人工看一眼即可），而漏报的代价是缺陷溜过。
  const tsAll = [];
  const walkTs = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walkTs(full); continue; }
      if (name.endsWith('.ts')) tsAll.push(readFileSync(full, 'utf8'));
    }
  };
  walkTs(SRC);
  const tsText = tsAll.join('\n');

  const orphans = [];
  let idTotal = 0;
  for (const f of htmlFiles) {
    const rel = f.replace(ROOT + '\\', '').replace(ROOT + '/', '');
    const ids = [...stripHtmlComments(readFileSync(f, 'utf8')).matchAll(/\bid="([^"]+)"/g)]
      .map((m) => m[1]);
    idTotal += ids.length;
    for (const id of ids) {
      if (!tsText.includes(id) && !(id in STATIC_ONLY_IDS)) {
        orphans.push(`${rel}: ${id}`);
      }
    }
  }

  // ★ 空集自证（规则 24）：一个 id 都没扫到时上面恒真
  check('判据前提：确实扫到了 HTML 里的 id', idTotal > 0, `${idTotal} 个`);
  check('没有"HTML 有 id、TS 零引用"的孤儿标记（白名单除外）',
    orphans.length === 0, orphans.join(' | '));
  console.log(`      （${htmlFiles.length} 个页面 / ${idTotal} 个 id；`
    + `白名单 ${Object.keys(STATIC_ONLY_IDS).length} 个）`);
}

// ---------------------------------------------------------------- 汇总
const passed = results.filter(Boolean).length;
console.log(`\n=== 汇总：${passed}/${results.length} 通过 ===`);
if (passed !== results.length) {
  results.forEach((ok, i) => { if (!ok) console.log(`  第 ${i + 1} 项失败`); });
  process.exit(1);
}
console.log('RESULT: OK');
