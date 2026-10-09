// check_deps.mjs —— 防"幽灵依赖"门禁
//
// ## 它防的是什么（2026-10 实测事故）
//
// quick-login 的验证脚本 `import ... from 'playwright-core'`，而 package.json 的
// devDependencies 里**没有**它。它们能跑，只因为本机 node_modules/ 里有一次
// `npm install --no-save` 的残留（package-lock.json 里也查不到）。
// ⇒ 换机器 / 新 clone / CI：脚本全部 ERR_MODULE_NOT_FOUND，而且不报"缺依赖"。
//
// 实测当时共 **3 个**幽灵依赖：playwright-core、@peculiar/x509、reflect-metadata。
// 同类损失此前已发生过一次（tools/e2e/ 整套在"收束清理"中被删除）。
//
// ## 它怎么做的（以及两次踩坑的教训）
//
// 只剥**注释**，不剥字符串，然后用**行首锚定**的正则找 import/export/require。
//
// 为什么不能剥字符串：一旦把 `from 'playwright-core'` 的说明符清空成 `from ''`，
//   正则里的 `[^'"]+`（至少一字符）就匹配不到，**整个文件命中数变成 0**，
//   门禁退化成"永远绿"——而它打印的 `检查 0 处` 看起来完全正常。
//   这个假阴性被反证脚本当场抓住（见 docs 里"门禁必须先反证"的纪律）。
//
// 为什么必须行首锚定：不锚定就会把**注释里**出现的 import 示例当成真导入，
//   实测报出一个不存在的包 `x`（来自本文件自己的注释）。
//   一个会误报的门禁会把真缺陷埋在噪音里（同 akso-mogul PITFALLS #108）。
//
// 用法：node tools/check_deps.mjs      → 0 = 全部已声明；1 = 有未声明

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const declared = new Set([
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.devDependencies || {}),
  ...Object.keys(pkg.optionalDependencies || {}),
  ...Object.keys(pkg.peerDependencies || {}),
]);

const SCAN_DIRS = ['tools', 'scripts'];
const EXTS = new Set(['.mjs', '.js', '.cjs', '.ts']);

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'baseline') continue;
      out.push(...walk(full));
    } else if (EXTS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

// 行首锚定：只认语句位置开始的 import / export / require
const SPEC_RE = new RegExp(
  [
    String.raw`^[ \t]*(?:import|export)\b[^;\n]*?\bfrom\s*['"]([^'"]+)['"]`,
    String.raw`^[ \t]*import\s*\(\s*['"]([^'"]+)['"]\s*\)`,
    String.raw`^[ \t]*const\s+\w+\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)`,
  ].join('|'),
  'gm',
);

const isBare = (spec) =>
  Boolean(spec) && !spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('node:');

const pkgNameOf = (spec) => {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
};

const files = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
const undeclared = new Map();
let checked = 0;
let bareCount = 0;

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(SPEC_RE)) {
    const spec = m[1] || m[2] || m[3];
    if (!spec) continue;
    checked++;
    if (!isBare(spec)) continue;
    bareCount++;
    const name = pkgNameOf(spec);
    if (!declared.has(name)) {
      if (!undeclared.has(name)) undeclared.set(name, new Set());
      undeclared.get(name).add(path.relative(ROOT, file).replace(/\\/g, '/'));
    }
  }
}

console.log(`扫描 ${files.length} 个脚本文件：${checked} 处模块说明符，其中三方裸模块 ${bareCount} 处`);
console.log(`已声明依赖 ${declared.size} 个: ${[...declared].sort().join(', ')}`);

// 自检：一个"检查了 0 处三方导入"的门禁等于没在工作（实测退化过一次）
if (bareCount === 0) {
  console.error('\nDEP_SUSPECT —— 一处三方裸模块都没扫到，门禁很可能已退化（正则/范围失效）。');
  console.error('若确实已无三方依赖，请删除本门禁而不是让它静默空转。');
  process.exit(1);
}

if (undeclared.size === 0) {
  console.log('\nDEP_OK —— 所有三方裸模块导入都已在 package.json 中声明');
  process.exit(0);
}

console.error('\nDEP_FAIL —— 发现未声明的依赖（这些脚本换机器就会跑不起来）：');
for (const [name, where] of undeclared) {
  console.error(`  ✗ ${name}`);
  for (const f of where) console.error(`      ${f}`);
}
console.error('\n处置：加进 package.json 的 devDependencies，或改用 node: 前缀的内置模块。');
process.exit(1);
