import { join } from 'node:path';
import { NmChannel } from './nm-host';
import { AccountStore, type AccountRow } from './store/db';
import { Launcher } from './launcher';
import type { EngineCommand, EngineAccount, AccountState } from '../../shared/nm-protocol';

/**
 * 引擎入口：NM host 主循环。
 * 数据目录约定（P1）：引擎仓 packages/engine 下 quicklogin.db + profiles/，便于开发调试。
 */
const ENGINE_DIR = join(__dirname, '..');
const DATA_DIR = join(ENGINE_DIR, 'data');
const DB_PATH = join(DATA_DIR, 'quicklogin.db');
const PROFILES_DIR = join(ENGINE_DIR, 'profiles');

const store = new AccountStore(DB_PATH, DATA_DIR);

/** 账号在线状态（内存态；引擎重启后由端口探测恢复，P4 完善） */
const states = new Map<string, AccountState>();

function toEngineAccount(row: AccountRow): EngineAccount {
  return {
    id: row.id,
    siteHost: row.site_host,
    username: row.username,
    alias: row.alias,
    state: states.get(row.id) ?? 'offline',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const channel = new NmChannel(
  process.stdin,
  process.stdout,
  (msg) => void handle(msg as EngineCommand),
  () => {
    // Chrome 关闭 NM 端口：引擎退出（账号实例独立进程，不受影响）
    store.close();
    process.exit(0);
  },
);

function emitAccounts(): void {
  channel.send({ event: 'accounts', accounts: store.list().map(toEngineAccount) });
}

const launcher = new Launcher(PROFILES_DIR, (accountId, state) => {
  states.set(accountId, state);
  channel.send({ event: 'state', accountId, state });
});

async function handle(cmd: EngineCommand): Promise<void> {
  try {
    switch (cmd.cmd) {
      case 'list':
        emitAccounts();
        return;
      case 'create': {
        const row = store.create({
          siteHost: cmd.siteHost,
          username: cmd.username,
          alias: cmd.alias,
          password: cmd.password,
        });
        emitAccounts();
        if (cmd.start !== false) {
          await launcher.start(row, store.list().indexOf(row));
        }
        return;
      }
      case 'start': {
        const row = store.get(cmd.accountId);
        if (!row) {
          channel.send({ event: 'error', message: `账号不存在: ${cmd.accountId}` });
          return;
        }
        await launcher.start(row, store.list().indexOf(row));
        return;
      }
      case 'stop':
        await launcher.stop(cmd.accountId);
        emitAccounts();
        return;
      case 'delete': {
        if (launcher.isRunning(cmd.accountId)) {
          await launcher.stop(cmd.accountId);
        }
        launcher.clearProfile(cmd.accountId);
        store.delete(cmd.accountId);
        emitAccounts();
        return;
      }
    }
  } catch (e) {
    channel.send({ event: 'error', message: e instanceof Error ? e.message : String(e) });
  }
}

channel.start();
// 启动即上报账号现状
emitAccounts();
