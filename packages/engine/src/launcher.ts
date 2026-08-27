import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import type { AccountRow } from './store/db';
import { findBrowser } from './chrome-path';
import type { AccountState } from '../../shared/nm-protocol';

export interface LaunchResult {
  port: number;
  state: AccountState;
  message?: string;
}

export interface StartCredentials {
  username: string;
  password: string;
}

/**
 * 账号浏览器实例编排：每账号一个独立 user-data-dir 的 Chrome 实例。
 * spawn 出的进程独立于引擎生命周期（引擎退出不连坐）；实例状态经调试端口探测。
 */
const BASE_PORT = 9300;

export class Launcher {
  /** accountId → 运行信息（仅本引擎会话内的已知映射；引擎重启后靠端口探测恢复） */
  private running = new Map<string, { proc: ChildProcess; port: number }>();

  constructor(
    private readonly profilesDir: string,
    private readonly onState: (accountId: string, state: AccountState, message?: string) => void,
  ) {}

  isRunning(accountId: string): boolean {
    return this.running.has(accountId);
  }

  /** 引擎重启后的状态恢复：逐账号探测调试端口（约定 port = BASE_PORT + 序号） */
  static portFor(index: number): number {
    return BASE_PORT + index;
  }

  async start(account: AccountRow, index: number, credentials?: StartCredentials): Promise<LaunchResult> {
    const existing = this.running.get(account.id);
    if (existing && !existing.proc.killed) {
      return { port: existing.port, state: 'online' };
    }

    const browser = findBrowser();
    if (!browser) {
      this.onState(account.id, 'login_failed', '本机未找到 Chrome/Edge');
      return { port: 0, state: 'login_failed', message: 'browser not found' };
    }

    const port = Launcher.portFor(index);
    const profileDir = join(this.profilesDir, account.id);
    mkdirSync(profileDir, { recursive: true });

    this.onState(account.id, 'starting');
    const proc = spawn(
      browser,
      [
        `--user-data-dir=${profileDir}`,
        `--remote-debugging-port=${port}`,
        '--no-first-run',
        '--no-default-browser-check',
        `https://${account.site_host}/`,
      ],
      { detached: true, stdio: 'ignore', windowsHide: false },
    );
    proc.unref();
    proc.once('exit', () => {
      this.running.delete(account.id);
      this.onState(account.id, 'offline');
    });

    // 等待调试端口就绪（实例启动 + CDP endpoint 可用）
    const ready = await waitPortReady(port, 15_000);
    if (!ready) {
      this.onState(account.id, 'login_failed', '浏览器调试端口未就绪');
      return { port, state: 'login_failed', message: 'debug port not ready' };
    }

    this.running.set(account.id, { proc, port });
    this.onState(account.id, 'online');

    // 自动登录：实例已带持久 profile，若已登录则 autoLogin 会立即判定 already_authed；
    // 首次（无登录态）则 CDP 填表提交。失败不阻塞在线状态，仅回传 login_failed 提示。
    if (credentials) {
      void (async () => {
        try {
          const { autoLogin } = await import('./autologin');
          const result = await autoLogin(port, credentials);
          if (!result.success) {
            this.onState(account.id, 'login_failed', result.reason);
          }
        } catch (e) {
          this.onState(account.id, 'login_failed', e instanceof Error ? e.message : String(e));
        }
      })();
    }

    return { port, state: 'online' };
  }

  async stop(accountId: string): Promise<boolean> {
    const entry = this.running.get(accountId);
    if (!entry) {
      return false;
    }
    // Windows 下 Chrome 是多进程树，杀主进程即可带掉整个实例
    try {
      process.kill(entry.proc.pid!);
    } catch {
      // 已退出
    }
    this.running.delete(accountId);
    this.onState(accountId, 'offline');
    return true;
  }

  /** 清除登录态：删除该账号的 user-data-dir（实例须已停止） */
  clearProfile(accountId: string): boolean {
    const dir = join(this.profilesDir, accountId);
    if (this.running.has(accountId)) {
      return false;
    }
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
    return true;
  }
}

/** 轮询调试端口直至 HTTP 响应或超时 */
function waitPortReady(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => {
        if (Date.now() > deadline) {
          resolve(false);
        } else {
          setTimeout(attempt, 500);
        }
      });
    };
    attempt();
  });
}
