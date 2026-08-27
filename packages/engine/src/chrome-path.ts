import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * 探测本机 Chrome/Edge 可执行文件路径（注册表优先，常见安装位置兜底）。
 * 返回 null 表示本机无可用的 Chromium 系浏览器。
 */
const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  `${process.env.LOCALAPPDATA ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

function fromRegistry(): string | null {
  for (const name of ['chrome.exe', 'msedge.exe']) {
    try {
      const out = execSync(
        `reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${name}" /ve`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] },
      );
      const m = out.match(/REG_SZ\s+(.+)/);
      if (m && existsSync(m[1].trim())) {
        return m[1].trim();
      }
    } catch {
      // 该键不存在，尝试下一个
    }
  }
  return null;
}

export function findBrowser(): string | null {
  return fromRegistry() ?? CANDIDATES.find((p) => p && existsSync(p)) ?? null;
}
