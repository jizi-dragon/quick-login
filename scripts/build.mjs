import { build, context as createContext } from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const extDir = path.join(root, 'packages', 'extension');
const watch = process.argv.includes('--watch');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

/** 仅复制 UI 静态文件（html/css），不含源码 */
function copyUiStatics(from, to) {
  for (const entry of readdirSync(from)) {
    const src = path.join(from, entry);
    const out = path.join(to, entry);
    if (statSync(src).isDirectory()) {
      mkdirSync(out, { recursive: true });
      copyUiStatics(src, out);
    } else if (entry.endsWith('.html') || entry.endsWith('.css')) {
      copyFileSync(src, out);
    }
  }
}

function copyExtensionStatics() {
  // ★★ **不是** `cpSync(assets → dist/assets, recursive)`。
  //
  // 那条 recursive 拷贝会把 `assets/` 下的**一切**带进包里 ——
  // 包括 `logo-master-422.png`（**11.1 KB 的源文件**，图标派生链的起点）。
  // 实测（2026-10-09）：`dist` 共 24 个文件 / 392.8 KB，而它是**唯一一个
  // manifest 没引用的**。⇒ **源文件不该发给用户。**
  //
  // ★ 与 `copyUiStatics` 同一条原则：**只拷运行期真正要用的**。
  //   `assets/` 是"源 + 产物"混放（`logo-master-422.png` 是源、`Icon*.png` 是产物），
  //   所以这里**按文件名白名单**挑，而不是整目录递归。
  mkdirSync(path.join(dist, 'assets'), { recursive: true });
  for (const n of [16, 32, 48, 128]) {
    copyFileSync(path.join(root, 'assets', `Icon${n}.png`),
                 path.join(dist, 'assets', `Icon${n}.png`));
  }
  copyFileSync(path.join(extDir, 'manifest.json'), path.join(dist, 'manifest.json'));
  copyUiStatics(path.join(extDir, 'src', 'ui'), path.join(dist, 'ui'));
}

const extensionOptions = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome110'],
  outbase: path.join(extDir, 'src'),
  outdir: dist,
  logLevel: 'info',
  entryPoints: {
    'background': path.join(extDir, 'src', 'background', 'service-worker.ts'),
    'content/shield-bridge': path.join(extDir, 'src', 'content', 'shield-bridge.ts'),
    'content/shield-main': path.join(extDir, 'src', 'content', 'shield-main.ts'),
    'content/title-hook': path.join(extDir, 'src', 'content', 'title-hook.ts'),
    'content/auto-login': path.join(extDir, 'src', 'content', 'auto-login.ts'),
    'content/wheel-overlay': path.join(extDir, 'src', 'content', 'wheel-overlay.ts'),
    'content/status-overlay': path.join(extDir, 'src', 'content', 'status-overlay.ts'),
    'content/favorites-overlay': path.join(extDir, 'src', 'content', 'favorites-overlay.ts'),
    'ui/popup/popup': path.join(extDir, 'src', 'ui', 'popup', 'popup.ts'),
    'ui/parallel/parallel': path.join(extDir, 'src', 'ui', 'parallel', 'parallel.ts'),
    'ui/wheel/wheel': path.join(extDir, 'src', 'ui', 'wheel', 'wheel.ts'),
  },
};

copyExtensionStatics();
if (watch) {
  const ctx = await createContext(extensionOptions);
  ctx.watch();
}
await build(extensionOptions);
console.log('BUILD_OK → dist/');
