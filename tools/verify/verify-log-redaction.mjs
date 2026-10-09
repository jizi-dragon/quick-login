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

  /**
   * 剥掉**注释**与**字符串字面量**后的代码。
   *
   * ## ★ 为什么必须剥（本仓第四次踩同一个坑）
   *
   * 我在这段代码旁边写了"这里原先写的是 `diag(...)`"来解释降级原因 ——
   * 而裸的 `/\bdiag\s*\(/` **命中了那句注释**。
   * 同一个坑的历史：`urlTransform`（PITFALLS #1）、`RETURNING`（#14）、
   * `is_admin`（akso-vault #19）。规律：**"解释为什么不用 X"的文本必然包含 X。**
   *
   * ⇒ 判据只看**运行时会执行的东西**。这里没有 AST 可用（是 TS 源码正则检查），
   *   所以退一步剥注释 + 清空字符串内容。
   *   ★ 顺序要紧：**先剥字符串再剥行注释**，否则 `'//'` 这种字面量会把后面的
   *     真代码当注释吃掉（反向失效，那是更坏的一类）。
   */
  const stripLiterals = (code) => code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')                       // ① 块注释
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')                // ② 模板串
    .replace(/'(?:\\[\s\S]|[^'\\\n])*'/g, "''")              // ③ 单引号串
    .replace(/"(?:\\[\s\S]|[^"\\\n])*"/g, '""')              // ④ 双引号串
    .replace(/\/\/[^\n]*/g, ' ');                            // ⑤ 行注释（必须在字符串之后）

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

// ---------------------------------------------------------------- 汇总
const passed = results.filter(Boolean).length;
console.log(`\n=== 汇总：${passed}/${results.length} 通过 ===`);
if (passed !== results.length) {
  results.forEach((ok, i) => { if (!ok) console.log(`  第 ${i + 1} 项失败`); });
  process.exit(1);
}
console.log('RESULT: OK');
