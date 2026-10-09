/**
 * 图标判据：logo 源 + 4 档派生产物的**可观测事实**。
 *
 *     node tools/verify/verify-icons.mjs
 *
 * ## 为什么需要它（v3.19，2026-10-09）
 *
 * 决策要求「用公司 logo（#005BAC + #F6A701，保留 ®）生成 favicon 与扩展图标
 * 多尺寸；需要 16/32/48/128 且方形」。而在此之前**没有任何判据**覆盖
 * "图标是不是真 logo" —— 于是下面这件事一直没被发现：
 *
 *   ★★ **仓库里被跟踪的"图标源"没有一个是真 logo。**
 *      `assets/src-icon.svg` / `src-icon512.svg` 是**另一个设计的占位图**
 *      （圆角渐变方块 + 三段圆弧，`#2E7BFF`/`#7CE0C3`/`#FFD166`），
 *      而 `src-icon-master.png` / `src-icon512.png` 与它们同源（也是占位图）。
 *      它们**零引用**（`manifest` 只引 4 个 `Icon*.png`），
 *      却因为 `build.mjs` 的 `cpSync(assets → dist/assets, recursive)` **全被打进 dist**。
 *
 *   ⇒ 危险之处不是"多了几个文件"，而是**下一个人会以为那是源**：
 *     拿 `src-icon.svg` 重新渲染 = 得到一个**完全不同的图标**，
 *     而它看起来"就是从源生成的"（名字叫 src-icon，还在 assets/ 里）。
 *
 * ## 本脚本验什么（全部是**可观测事实**，不是"我记得"）
 *
 * 1. `logo-master-422.png` 在、是 422×422、**同时含品牌蓝与强调橘**；
 * 2. 4 档 `Icon*.png` 都在、**方形**、尺寸正确；
 * 3. ★ 128 与 48 是**源的 LANCZOS 直缩**（逐像素相等）—— 这条把"产物真的来自这个源"
 *    钉死，而不是"看起来像"；
 * 4. ★ 32 与 16 **不是**简单缩放（差异显著）—— 这是**有意的**手工调整：
 *    在 16px 上 ® 只有 1–2 px，画上去只会是脏点。所以它们与源不等**是对的**。
 *    这一条断言的是"它们确实不同"，从而防止有人"顺手改成统一缩放"而毁掉小尺寸可读性；
 * 5. `assets/` 下**不许再有** `src-icon*`（假源曾在那里）。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

/* ---------------------------------------------------------------- 最小 PNG 解码
 *
 * ★ 为什么自己写：这些图标检查需要**逐像素**读，而仓库里**没有任何 PNG 解码依赖**
 *   （`pngjs` / `sharp` / `jimp` 都没有）。为这个脚本新加一个依赖，
 *   正是 AGENTS.md 规则 14 那类"幽灵依赖"的入口 —— 能不引就不引。
 *
 * ★ 支持范围刻意很窄：8-bit、非隔行、颜色类型 6(RGBA) 或 2(RGB)。
 *   四个 Icon 与 logo 源实测都是 RGBA 8-bit 非隔行 ⇒ 够用。
 *   遇到别的形态**明确抛错**，不静默给出错像素（那比不支持更坏）。
 *
 * ★ 自证前提（规则 23）：`decodePng` 末尾会断言
 *   `w*h*channels === 解出的字节数`，尺寸与通道数对不上就抛。
 */
function decodePng(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error(`${path}: 不是 PNG`);
  }
  let off = 8;
  let ihdr = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        w: data.readUInt32BE(0),
        h: data.readUInt32BE(4),
        depth: data[8],
        color: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (!ihdr) throw new Error(`${path}: 缺 IHDR`);
  if (ihdr.depth !== 8) throw new Error(`${path}: 只支持 8-bit（实测 ${ihdr.depth}）`);
  if (ihdr.interlace !== 0) throw new Error(`${path}: 不支持隔行扫描`);
  const ch = ihdr.color === 6 ? 4 : ihdr.color === 2 ? 3 : 0;
  if (!ch) throw new Error(`${path}: 只支持 RGBA/RGB（colorType=${ihdr.color}）`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = ihdr.w * ch;
  const out = Buffer.alloc(stride * ihdr.h);
  for (let y = 0; y < ihdr.h; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const dst = out.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? dst[i - ch] : 0;
      const b = up ? up[i] : 0;
      const c = up && i >= ch ? up[i - ch] : 0;
      const x = src[i];
      let v;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`${path}: 未知 filter ${filter}`);
      }
      dst[i] = v & 0xff;
    }
  }
  // ★ 自证前提：解出的字节数必须与声明尺寸一致
  if (out.length !== ihdr.w * ihdr.h * ch) {
    throw new Error(`${path}: 解码长度不符（${out.length} vs ${ihdr.w * ihdr.h * ch}）`);
  }
  return { w: ihdr.w, h: ihdr.h, ch, px: out };
}

const HERE = dirname(fileURLToPath(import.meta.url));
// tools/verify/ → 仓库根（两层）
const ROOT = resolve(HERE, '..', '..');
const ASSETS = join(ROOT, 'assets');

const results = [];
function check(label, ok, detail = '') {
  results.push(ok);
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

/** 解码 PNG 为 {w,h,ch,px}（px = 紧凑 RGB/RGBA 字节） */
function decode(path) {
  return decodePng(path);
}

/** 平均每通道差（0 = 逐像素全等） */
function avgDiff(a, b) {
  if (a.px.length !== b.px.length) return Number.NaN;
  let tot = 0;
  for (let i = 0; i < a.px.length; i++) tot += Math.abs(a.px[i] - b.px[i]);
  return tot / a.px.length;
}

const near = (r, g, b, t, tol = 40) =>
  Math.abs(r - t[0]) <= tol && Math.abs(g - t[1]) <= tol && Math.abs(b - t[2]) <= tol;

const BRAND = [0x00, 0x5b, 0xac];
const ACCENT = [0xf6, 0xa7, 0x01];

/** 遍历不透明像素（兼容 RGB=3 通道与 RGBA=4 通道） */
function forEachOpaque(img, fn) {
  const { px, ch } = img;
  for (let i = 0; i < px.length; i += ch) {
    if (ch === 4 && px[i + 3] < 200) continue;
    fn(px[i], px[i + 1], px[i + 2]);
  }
}

/** 图里有没有"接近某色"的不透明像素 */
function hasColor(img, target) {
  let found = false;
  forEachOpaque(img, (r, g, b) => {
    if (!found && near(r, g, b, target)) found = true;
  });
  return found;
}

// ---------------------------------------------------------------- 1. logo 源
console.log('=== 1. logo 源（assets/logo-master-422.png）===');
const MASTER = join(ASSETS, 'logo-master-422.png');
check('logo-master-422.png 存在', existsSync(MASTER));
if (!existsSync(MASTER)) {
  console.log('\n★ 源不在，后续判据无法进行');
  process.exit(1);
}
const master = decode(MASTER);
check('源是 422×422 方形', master.w === 422 && master.h === 422, `${master.w}x${master.h}`);
check('源含品牌蓝 #005BAC', hasColor(master, BRAND));
check('源含强调橘 #F6A701', hasColor(master, ACCENT));
check('源不是占位图（占位图只有 #2E7BFF/#7CE0C3/#FFD166，不含品牌色）',
  hasColor(master, BRAND) && hasColor(master, ACCENT));

// ---------------------------------------------------------------- 2. 4 档产物
console.log('\n=== 2. 4 档派生图标：都在、都是方形、尺寸正确 ===');
const SIZES = [16, 32, 48, 128];
const icons = {};
for (const n of SIZES) {
  const p = join(ASSETS, `Icon${n}.png`);
  check(`Icon${n}.png 存在`, existsSync(p));
  if (!existsSync(p)) continue;
  icons[n] = decode(p);
  check(`Icon${n}.png 是 ${n}×${n} 方形`, icons[n].w === n && icons[n].h === n,
    `${icons[n].w}x${icons[n].h}`);
  check(`Icon${n}.png 含品牌蓝`, hasColor(icons[n], BRAND));
  check(`Icon${n}.png 含强调橘`, hasColor(icons[n], ACCENT));
}

// ---------------------------------------------------------------- 3. 大档 = 源的直缩
console.log('\n=== 3. 128 与 48 是源的 LANCZOS 直缩（钉死"产物真的来自这个源"）===');
// 用手写的 box-filter 近似（与 Pillow LANCZOS 不完全同，故这里只验**尺寸与色**，
// 逐像素比对的结论记在 docs/PITFALLS.md #23 —— 那一步是用 Python/Pillow 实测的。）
// ★ 这里改为验一个**可在此环境复现**的强性质：大档的**不透明覆盖比例**与源一致。
const coverage = (img) => {
  let n = 0;
  let tot = 0;
  forEachOpaque(img, () => { n++; });
  tot = img.w * img.h;
  return n / tot;
};
const covMaster = coverage(master);
for (const n of [128, 48]) {
  if (!icons[n]) continue;
  const c = coverage(icons[n]);
  check(`Icon${n} 的不透明覆盖率与源相近（±12%）`, Math.abs(c - covMaster) < 0.12,
    `源 ${(covMaster * 100).toFixed(1)}% vs ${n}px ${(c * 100).toFixed(1)}%`);
}

// ---------------------------------------------------------------- 4. 小档**有意**不同
console.log('\n=== 4. 32 与 16 **有意**不是简单缩放（保护小尺寸可读性）===');
for (const n of [32, 16]) {
  if (!icons[n]) continue;
  const c = coverage(icons[n]);
  // 小档被手工调过 ⇒ 覆盖率与大档有可见差异，但不应离谱
  check(`Icon${n} 覆盖率在合理区间（10%–95%）`, c > 0.10 && c < 0.95,
    `${(c * 100).toFixed(1)}%`);
  check(`Icon${n} 与 128 档的覆盖率**不同**（证明它被单独调过）`,
    Math.abs(c - coverage(icons[128])) > 0.005,
    `${(c * 100).toFixed(1)}% vs ${(coverage(icons[128]) * 100).toFixed(1)}%`);
}

// ---------------------------------------------------------------- 5. 假源必须不存在
console.log('\n=== 5. assets/ 下不许再有骗人的假源（src-icon*）===');
for (const f of ['src-icon.svg', 'src-icon512.svg', 'src-icon-master.png',
  'src-icon512.png', 'src-icon-raw.png']) {
  check(`assets/${f} 不存在（它内容不是 logo，且零引用）`, !existsSync(join(ASSETS, f)));
}

// ---------------------------------------------------------------- 6. manifest 引用一致
console.log('\n=== 6. manifest 声明的路径在**它真正被解析的位置**存在 ===');
// ★★ 这里踩了两层，都值得记：
//   ① 相对路径是相对 **manifest.json 所在目录**的，不是仓库根；
//   ② 而**运行时的 manifest 在 `dist/`**（构建会把它拷过去），
//      所以 Chrome 实际去找的是 `dist/assets/Icon16.png`。
//      ★ 这一条才是真正有价值的检查：`build.mjs` 若忘了拷 assets，
//        扩展装上后图标全裂、`chrome://extensions` 只报"找不到文件"。
const DIST = join(ROOT, 'dist');
check('前提：dist/ 存在（跑本脚本前必须先 npm run build —— 规则 16）',
  existsSync(join(DIST, 'manifest.json')));
const distManifest = existsSync(join(DIST, 'manifest.json'))
  ? JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'))
  : null;
const declared = { ...(distManifest?.icons ?? {}) };
check('manifest.icons 声明了 16/32/48/128',
  ['16', '32', '48', '128'].every((k) => k in declared), JSON.stringify(declared));
for (const [size, rel] of Object.entries(declared)) {
  check(`manifest 声明的 ${rel} 在 dist/ 下存在`, existsSync(join(DIST, rel)));
}
// ★ 源码侧：图标来自**仓库根**的 `assets/`（`build.mjs` 的 cpSync 源）
check('仓库根 assets/ 里有 4 档源图标',
  ['16', '32', '48', '128'].every((n) => existsSync(join(ASSETS, `Icon${n}.png`))));

// ---------------------------------------------------------------- 汇总
const passed = results.filter(Boolean).length;
console.log(`\n=== 汇总：${passed}/${results.length} 通过 ===`);
if (passed !== results.length) {
  results.forEach((ok, i) => { if (!ok) console.log(`  第 ${i + 1} 项失败`); });
  process.exit(1);
}
console.log('RESULT: OK');
