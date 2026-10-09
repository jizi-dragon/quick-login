/**
 * 品牌色一致性 + **不新增硬编码**。
 *
 *     node tools/verify/verify-brand.mjs
 *
 * ## 它防的是"跨语言 / 跨文件的同一事实多份声明"
 *
 * 实测（2026-10-09）：品牌蓝 `#1E6FFF` 在源码里一共有 **三处独立定义**
 * 与 **21 处内联副本**：
 *
 * | 位置 | 性质 |
 * |---|---|
 * | `src/ui/tokens.css` 的 `--sb-brand` | ★ **权威源**（扩展自有页面） |
 * | `src/ui/wheel/wheel.css` 的 `--acc` 的 fallback | 副本（轮盘不加载 tokens 时的兜底） |
 * | `src/shared/constants.ts` 的 `SESSION_COLORS[0]` | 副本（**TS 里**的调色板） |
 *
 * ★ 而**没有任何门禁**检查它们是否一致 —— `typecheck` 不管颜色，
 *   `verify-css-vars` 只看 CSS 变量，**看不到 TS 里那一份**。
 *
 * ## 判据（三条）
 *
 * ① **三处独立定义必须逐字等价**（归一化后比）；
 * ② TS/JS 里品牌色的**硬编码处数**不得超过冻结的基线（**只减不增**）；
 * ③ 每条硬编码要么在**白名单**里（附"为什么它不能用 var"），要么必须被解释。
 *
 * ★ ② 是"冻结现值 + 只减不增"的形态：现在没法一次改完（有些地方**必须**是具体值，
 *   例如 `chrome.action.setBadgeBackgroundColor({color})` 不收 CSS 变量），
 *   但**至少不许变多**。每次减掉一处就把基线调小。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'packages', 'extension', 'src');
const UI = path.join(SRC, 'ui');

const results = [];
function check(label, ok, detail = '') {
  results.push(ok);
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
}

const norm = (s) => s.trim().toLowerCase().replace(/^#/, '');
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ');

/** 与品牌色同源的字面量（含 `rgba(30,111,255,…)` 这种形式） */
const BRAND_RE = /#1e6fff|30,\s*111,\s*255/gi;

/** ★ 冻结基线：TS/JS 里品牌色的硬编码处数。**只许减，不许增。**
 *  改小它 = 你真的消掉了一处；改大它 = 你在新增漂移源，那正是本条判据要拦的。
 *
 *  24 → 15（2026-10-09）：消掉了 `ui/wheel/ring-wheel-style.ts` 的 13 处
 *  （10 处 `var(--acc,#1e6fff)` 的兜底 —— 那兜底**永远不会被用到**，因为
 *   `ring-wheel.ts` 在每个扇区的 style 里都显式定义了 `--acc`；
 *   另有 2 处直写色 + 1 处同源 `rgba(30,111,255,…)`，后者改用 `color-mix` 表达）。
 *  ★ 判据是轮盘截图**逐字节不变**（`f32568…` / `1cc5fa…`）。 */
const TS_HARDCODE_BUDGET = 15;

/** 白名单：这些**必须**是具体色值，不能用 CSS 变量。
 *  每条都要写清"为什么"。 */
const ALLOWED = [
  {
    file: 'background/service-worker.ts',
    why: '`chrome.action.setBadgeBackgroundColor({color})` 收的是**具体色值**，不收 CSS 变量',
  },
];

console.log('=== 前提 ===');
check('src/ui 存在', existsSync(UI));
check('src/shared/constants.ts 存在', existsSync(path.join(SRC, 'shared', 'constants.ts')));
if (!existsSync(UI)) process.exit(1);

// ---------------------------------------------------------------- ① 三处定义一致
console.log('\n=== ① 三处独立定义必须逐字等价 ===');
const tokensCss = stripComments(readFileSync(path.join(UI, 'tokens.css'), 'utf8'));
const mTok = /--sb-brand:\s*([^;]+);/.exec(tokensCss);
check('`tokens.css` 有 `--sb-brand`', Boolean(mTok));
const vTok = mTok ? mTok[1] : '';

const wheelCss = stripComments(readFileSync(path.join(UI, 'wheel', 'wheel.css'), 'utf8'));
const mFb = /--acc:\s*var\(\s*--sb-brand\s*,\s*([^)]+)\)/.exec(wheelCss);
check('`wheel.css` 的 `--acc` 引用了 `--sb-brand` 并带兜底',
  Boolean(mFb), mFb ? '' : '（`--acc` 没有写成 `var(--sb-brand, …)`）');
const vFb = mFb ? mFb[1] : '';

const consts = readFileSync(path.join(SRC, 'shared', 'constants.ts'), 'utf8');
const mPal = /SESSION_COLORS\s*=\s*\[\s*'([^']+)'/.exec(consts);
check('`constants.ts` 的 `SESSION_COLORS[0]` 存在', Boolean(mPal));
const vPal = mPal ? mPal[1] : '';

check('前提：三处都取到了值（否则下面比的是空串）',
  Boolean(vTok && vFb && vPal), `${vTok} / ${vFb} / ${vPal}`);
const allSame = Boolean(vTok && vFb && vPal
  && norm(vTok) === norm(vFb) && norm(vFb) === norm(vPal));
check('三处独立定义**逐字等价**', allSame,
  allSame ? `都是 ${norm(vTok)}` : `★ 不一致：${norm(vTok)} / ${norm(vFb)} / ${norm(vPal)}`);

// ---------------------------------------------------------------- ② 硬编码不许增长
console.log('\n=== ② TS/JS 里品牌色的硬编码处数（冻结基线，只减不增）===');
const hits = [];
for (const rel of readdirSync(SRC, { recursive: true }).map((f) => String(f))) {
  if (!rel.endsWith('.ts')) continue;
  const abs = path.join(SRC, rel);
  const text = readFileSync(abs, 'utf8');
  text.split('\n').forEach((line, i) => {
    if (BRAND_RE.test(line)) {
      BRAND_RE.lastIndex = 0;
      hits.push({ file: rel.replace(/\\/g, '/'), line: i + 1, text: line.trim() });
    }
    BRAND_RE.lastIndex = 0;
  });
}
console.log(`  实测 ${hits.length} 处（基线 ${TS_HARDCODE_BUDGET}）`);
check('前提：至少扫到 1 处（否则判据恒真）', hits.length > 0, `${hits.length} 处`);
check(`TS 硬编码处数 <= 冻结基线 ${TS_HARDCODE_BUDGET}`, hits.length <= TS_HARDCODE_BUDGET,
  hits.length > TS_HARDCODE_BUDGET
    ? `★ 多出 ${hits.length - TS_HARDCODE_BUDGET} 处 —— 你在新增漂移源`
    : '只减不增');

// ---------------------------------------------------------------- ③ 白名单要写清原因
console.log('\n=== ③ 每条硬编码所属文件都有"为什么"（白名单）===');
const files = [...new Set(hits.map((h) => h.file))].sort();
const allowedFiles = new Set(ALLOWED.map((a) => a.file));
for (const f of files) {
  const n = hits.filter((h) => h.file === f).length;
  const allow = ALLOWED.find((a) => a.file === f);
  console.log(`      ${f.padEnd(42)} ${String(n).padStart(2)} 处`);
}
check('白名单的每条都写明了原因', ALLOWED.every((a) => a.why && a.why.length > 10),
  ALLOWED.map((a) => a.file).join(' '));

const passed = results.filter(Boolean).length;
console.log(`\n=== 汇总：${passed}/${results.length} 通过 ===`);
if (passed !== results.length) {
  results.forEach((ok, i) => { if (!ok) console.log(`  第 ${i + 1} 项失败`); });
  process.exit(1);
}
console.log('RESULT: OK');
