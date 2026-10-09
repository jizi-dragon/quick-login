/**
 * 反证：证明 `verify-log-redaction.mjs` 真的会红。
 *
 * 依据 quick-login AGENTS.md 规则 17：**写完判据先问"拆掉什么它才会红？"**
 * 答不上来说明它没在验任何东西。
 *
 * 做法：临时制造缺陷版，跑验收并断言**必须失败**，
 *       最后无论成败都把文件逐字节还原（放 `finally`）。
 *
 * ★ 2026-10-09 泛化：原先只支持改 `log.ts` 一个文件，而验收脚本后来长出了
 *   **闭环**那一节（第 6 节：日志必须有消费者）—— 那节改的是
 *   `service-worker.ts` 与 `parallel.ts`。单文件版**没法反证它**
 *   ⇒ 一条没人反证过的判据，正是"永远绿"的候选。
 *   现在每个用例自带 `file` 字段。
 *
 * 跑法：node tools/verify/verify-falsify-logredaction.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..'); // tools/verify/ → 仓库根（两层）
const CHECK = join(HERE, 'verify-log-redaction.mjs');

const SRC = join(ROOT, 'packages', 'extension', 'src');
const LOG_TS = join(SRC, 'shared', 'log.ts');
const SW_TS = join(SRC, 'background', 'service-worker.ts');
const PANEL_TS = join(SRC, 'ui', 'parallel', 'parallel.ts');
const PS_TS = join(SRC, 'background', 'core', 'parallel-session.ts');
// ★ 名字相近、容易拿错的两个文件：`parallel-session`（运行时编排）
//   与 `parallel-store`（数据层门面）。第 ⑥ 条要改的是**后者**。
const PSTORE_TS = join(SRC, 'background', 'core', 'parallel-store.ts');

const CASES = [
  {
    label: '① 打码被绕过（formatArgs 直接返回原文）⇒ 凭据原样输出',
    file: LOG_TS,
    anchor: '  return redact(text);',
    broken: '  return text;  // 缺陷版：不调用 redact',
  },
  {
    label: '② 只打码第一个参数（漏掉分隔参数）⇒ password=%s 形态失效',
    file: LOG_TS,
    anchor: "  const text = typeof first === 'string' ? interpolate(first, rest) : args.map(stringify).join(' ');",
    broken: "  const text = typeof first === 'string' ? first : args.map(stringify).join(' ');",
  },
  {
    // ★ 本节判据（闭环）的反证 —— 原先没有
    label: '③ 拆掉 `ql.diag` 里的 drain() ⇒ 日志又没人读了',
    file: SW_TS,
    anchor: '        out.logs = drain();\n',
    broken: '',
  },
  {
    label: '④ 拆掉诊断包的 `appLogs` ⇒ handler 带了前端也不收',
    file: PANEL_TS,
    anchor: '      appLogs: (diagRes as { result?: { data?: { logs?: unknown[]; logLevel?: string } } } | null)\n'
          + '        ?.result?.data?.logs ?? [],\n',
    broken: '',
  },
  {
    // ★ 第 7 节（三通道分工）的反证 —— 把**热路径**改回写 storage 缓冲
    label: '⑤ 热路径改回 `diag()` ⇒ 环形 60 又被刷满、真实失败被挤掉',
    file: PS_TS,
    anchor: "    log.debug('isEnforceable(%s) → 缓存 %s', host, cached);\n",
    broken: '    void diag(`isEnforceable(${host}) → 缓存 ${cached}`);\n',
  },
  {
    // ★ 第 8 节（离线判定只有一处）的反证 —— 重新引入重复的类定义。
    //   这一条尤其值得反证：重复定义**当时不会出问题**（判定用标记字段），
    //   所以"没有报错"完全不能说明判据在验东西。
    label: '⑥ `parallel-store` 又自定义一份 `OfflineError` ⇒ 判定改 `instanceof` 就会静默失效',
    file: PSTORE_TS,
    anchor: "export { OfflineError, isOfflineError } from './offline';\n",
    broken: "export { OfflineError, isOfflineError } from './offline';\n"
          + 'export class OfflineError extends Error { readonly isOfflineError = true; }\n',
  },
];

function runCheck() {
  try {
    execFileSync(process.execPath, [CHECK], { stdio: 'pipe', encoding: 'utf8' });
    return false; // 退出码 0 = 没红
  } catch {
    return true; // 非 0 = 红了
  }
}

const failures = [];

// 基线：未改动时必须通过
console.log('=== 基线（未改动）：验收必须通过 ===');
const baselineGreen = !runCheck();
console.log(`  ${baselineGreen ? 'OK  ' : 'FAIL'} 基线${baselineGreen ? '通过' : '不通过 —— 先修验收本身'}`);
if (!baselineGreen) failures.push('基线就不通过');

for (const c of CASES) {
  const original = readFileSync(c.file, 'utf8');
  const short = c.file.slice(ROOT.length + 1);
  if (!original.includes(c.anchor)) {
    console.log(`\n=== ${c.label} ===\n  SKIP 锚点没找到（源码变了？）${short}`);
    failures.push(`${c.label}：锚点没找到`);
    continue;
  }
  try {
    writeFileSync(c.file, original.replace(c.anchor, c.broken), 'utf8');
    console.log(`\n=== ${c.label} ===`);
    const red = runCheck();
    if (red) {
      console.log('  OK   如期变红 —— 反证有效');
    } else {
      console.log('  FAIL 缺陷版下仍然绿 ⇒ 这条验收是空断言！');
      failures.push(`${c.label}：缺陷版下仍绿`);
    }
  } finally {
    // ★ 写回时用 utf8 且内容与原文完全一致 —— 逐字节还原
    writeFileSync(c.file, original, 'utf8');
    if (readFileSync(c.file, 'utf8') !== original) failures.push(`${c.label}：还原失败`);
  }
}

console.log('\n=== 还原核对 ===');
// ★ 每个"被用例改过的文件"都必须出现在这里。
//   漏一个的后果：那个文件的还原失败不会被发现，而工作区会留下一个**缺陷版**
//   —— 下一轮的全量验收会红，但原因指向别处。
//   判据（自证）：本列表与 CASES 里出现的 `file` **集合相等**。
const touched = [...new Set(CASES.map((c) => c.file))];
const COVERED = [LOG_TS, SW_TS, PANEL_TS, PS_TS, PSTORE_TS];
const uncovered = touched.filter((f) => !COVERED.includes(f));
if (uncovered.length) failures.push(`还原核对漏了：${uncovered.join(', ')}`);

for (const f of COVERED) {
  const short = f.slice(ROOT.length + 1);
  // 每个文件里那个"本轮修好的东西"必须仍在
  const marker = f === LOG_TS ? 'return redact(text);'
    : f === SW_TS ? 'out.logs = drain();'
    : f === PANEL_TS ? 'appLogs:'
    : f === PS_TS ? "log.debug('isEnforceable(%s) → 缓存 %s', host, cached);"
    : "export { OfflineError, isOfflineError } from './offline';";
  const ok = readFileSync(f, 'utf8').includes(marker);
  if (!ok) failures.push(`${short} 还原后缺少 ${marker}`);
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${short} 已还原（含 ${marker.slice(0, 40)}）`);
}

const total = CASES.length + 1;
const passed = total - failures.length;
console.log(`\nRESULT: ${passed}/${total} ${failures.length ? '—— 失败：' + failures.join('; ') : '反证通过（验收有效且已还原）'}`);
process.exit(failures.length ? 1 : 0);
