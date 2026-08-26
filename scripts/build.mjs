import { build, context as createContext } from 'esbuild';
import { copyFileSync, cpSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const srcDir = path.join(root, 'src');
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

function copyStatics() {
  cpSync(path.join(root, 'assets'), path.join(dist, 'assets'), { recursive: true });
  copyFileSync(path.join(root, 'manifest.json'), path.join(dist, 'manifest.json'));
  copyUiStatics(path.join(srcDir, 'ui'), path.join(dist, 'ui'));
}

const options = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome110'],
  outbase: srcDir,
  outdir: dist,
  logLevel: 'info',
  entryPoints: {
    'background': path.join(srcDir, 'background', 'service-worker.ts'),
    'content/title-hook': path.join(srcDir, 'content', 'title-hook.ts'),
    'content/virtual-storage': path.join(srcDir, 'content', 'virtual-storage.ts'),
    'content/main/virtual-storage-runtime': path.join(srcDir, 'content', 'main', 'virtual-storage-runtime.ts'),
    'content/auto-login': path.join(srcDir, 'content', 'auto-login.ts'),
    'ui/popup/popup': path.join(srcDir, 'ui', 'popup', 'popup.ts'),
    'ui/options/options': path.join(srcDir, 'ui', 'options', 'options.ts'),
  },
};

copyStatics();
if (watch) {
  const ctx = await createContext(options);
  ctx.watch();
}
await build(options);
console.log('BUILD_OK → dist/');