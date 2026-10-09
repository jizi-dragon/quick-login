/**
 * `verify-icons.mjs` 的反证：把每条判据的**真实缺陷**注进去，看它红不红。
 *
 *     npm run build && node tools/verify/verify-falsify-icons.mjs
 *
 * ## 为什么要反证（规则 17）
 *
 * "写完判据先问：**拆掉什么它才会红**？"——答不上来说明它没在验任何东西。
 * 本仓已经**三次**退化成"永远绿"（幽灵依赖 / `[].every()` 空集 / `stripLiterals`
 * 把要读的东西也剥了），所以每条新判据都配一条反证。
 *
 * ## 每条反证都要"真的能红"
 *
 * 缺陷版必须让被断言的**那个东西真的消失**（规则 25 的教训：
 * 把 `log.error(` 拆成两半会让 marker 仍在源码里 ⇒ 判据不红 ⇒ 反证 SKIP）。
 *
 * ## 还原
 *
 * 每条之后立刻还原；末尾做**逐字节**核对 + 再跑一次判据确认恢复全绿。
 * ★ 图片类文件用 `Buffer` 读写（不能当 utf8 文本）。
 */
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..'); // tools/verify/ → 仓库根（两层）
const ASSETS = join(ROOT, 'assets');
const DIST = join(ROOT, 'dist');
const CHECK = join(HERE, 'verify-icons.mjs');

const MASTER = join(ASSETS, 'logo-master-422.png');
const ICON16 = join(ASSETS, 'Icon16.png');
const ICON32 = join(ASSETS, 'Icon32.png');

/** 造一张纯色 PNG（用 node:zlib 手写，避免引入依赖） */
function makePng(w, h, [r, g, b, a]) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    const off = y * (w * 4 + 1);
    raw[off] = 0; // filter none
    for (let x = 0; x < w; x++) {
      const p = off + 1 + x * 4;
      raw[p] = r; raw[p + 1] = g; raw[p + 2] = b; raw[p + 3] = a;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

/** 跑判据，返回是否通过 */
function checkPasses() {
  const r = spawnSync(process.execPath, [CHECK], { encoding: 'utf8', cwd: ROOT });
  return { pass: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
}

/** 备份（Buffer，因为要恢复二进制） */
const BACKUP = new Map();
for (const f of [MASTER, ICON16, ICON32]) BACKUP.set(f, readFileSync(f));

const CASES = [
  {
    name: '① 把 logo 源换成"占位图"（不含品牌色的纯色块）',
    file: MASTER,
    apply: () => makePng(422, 422, [0x2e, 0x7b, 0xff, 255]),
  },
  {
    name: '② 把 Icon16 换成非方形（16×9）',
    file: ICON16,
    apply: () => makePng(16, 9, [0x00, 0x5b, 0xac, 255]),
  },
  {
    name: '③ 把 Icon32 换成"和 128 覆盖率相同"的版本（抹掉小档手工调整）',
    file: ICON32,
    apply: () => readFileSync(join(ASSETS, 'Icon128.png')), // 尺寸不对 ⇒ 也会红
  },
  {
    name: '④ 重新放回一个骗人的假源 assets/src-icon.svg',
    file: join(ASSETS, 'src-icon.svg'),
    apply: () => Buffer.from('<svg/>', 'utf8'),
    remove: true,
  },
];

const results = [];
console.log('=== 基线（未改动）：判据必须通过 ===');
const base = checkPasses();
console.log(`  ${base.pass ? 'OK  ' : 'FAIL'} 基线${base.pass ? '通过' : '不通过 —— 先修判据本身'}`);
if (!base.pass) results.push(false);

try {
  for (const c of CASES) {
    const orig = BACKUP.has(c.file) ? BACKUP.get(c.file) : null;
    writeFileSync(c.file, c.apply(orig));
    const { pass, out } = checkPasses();
    const ok = !pass; // 必须变红
    results.push(ok);
    console.log(`\n=== ${c.name} ===`);
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${ok ? '如期变红 —— 反证有效' : '★ 缺陷版下仍然绿 ⇒ 这条验收是空断言！'}`);
    if (!ok) console.log(out.split('\n').slice(-6).map((l) => `      ${l}`).join('\n'));
    if (orig) writeFileSync(c.file, orig); // 立刻还原
    else if (c.remove) rmSync(c.file, { force: true });
  }
} finally {
  for (const [f, buf] of BACKUP) writeFileSync(f, buf);
  rmSync(join(ASSETS, 'src-icon.svg'), { force: true });
}

// ---------------------------------------------------------------- 还原核对
console.log('\n=== 还原核对 ===');
let restored = true;
for (const [f, buf] of BACKUP) {
  const same = readFileSync(f).equals(buf);
  restored &&= same;
  console.log(`  ${same ? 'OK  ' : 'FAIL'} ${f.slice(ROOT.length + 1)} 已还原（逐字节）`);
}
const gone = !existsSync(join(ASSETS, 'src-icon.svg'));
restored &&= gone;
console.log(`  ${gone ? 'OK  ' : 'FAIL'} assets/src-icon.svg 仍不存在`);

const after = checkPasses();
console.log(`  ${after.pass ? 'OK  ' : 'FAIL'} 判据恢复全绿`);
restored &&= after.pass;
// dist 里的图标是**拷贝**：源还原了，但 dist 里可能仍是被篡改的副本 ⇒ 也要还原
for (const n of [16, 32]) {
  try {
    writeFileSync(join(DIST, 'assets', `Icon${n}.png`), readFileSync(join(ASSETS, `Icon${n}.png`)));
  } catch { /* dist 可能不存在 */ }
}

const passed = results.filter(Boolean).length;
console.log(`\nRESULT: ${passed}/${results.length} 反证通过`
  + `${restored ? '（验收有效且已还原）' : '（★ 还原有问题）'}`);
