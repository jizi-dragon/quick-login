import { build, context as createContext } from 'esbuild';
import { copyFileSync, cpSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const extDir = path.join(root, 'packages', 'extension');
const engineDir = path.join(root, 'packages', 'engine');
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
  cpSync(path.join(root, 'assets'), path.join(dist, 'assets'), { recursive: true });
  copyFileSync(path.join(extDir, 'manifest.json'), path.join(dist, 'manifest.json'));
  copyUiStatics(path.join(extDir, 'src', 'ui'), path.join(dist, 'ui'));
}

/** 引擎：bundle 为单 js（原生依赖 better-sqlite3/@primno/dpapi 不打包，运行时从 node_modules 解析）。
 * 输出 .cjs：CJS 格式与 packages/engine 的 "type":"module" 声明隔离，避免 Node 误判 */
const engineOptions = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: ['node20'],
  outdir: path.join(engineDir, 'dist'),
  outExtension: { '.js': '.cjs' },
  logLevel: 'info',
  entryPoints: { engine: path.join(engineDir, 'src', 'main.ts') },
  external: ['better-sqlite3', '@primno/dpapi', 'chrome-remote-interface'],
};

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
    'content/title-hook': path.join(extDir, 'src', 'content', 'title-hook.ts'),
    'content/auto-login': path.join(extDir, 'src', 'content', 'auto-login.ts'),
    'ui/popup/popup': path.join(extDir, 'src', 'ui', 'popup', 'popup.ts'),
    'ui/options/options': path.join(extDir, 'src', 'ui', 'options', 'options.ts'),
  },
};

copyExtensionStatics();
if (watch) {
  const ctx = await createContext(extensionOptions);
  ctx.watch();
}
await build(extensionOptions);
await build(engineOptions);
console.log('BUILD_OK → dist/ + packages/engine/dist/');
