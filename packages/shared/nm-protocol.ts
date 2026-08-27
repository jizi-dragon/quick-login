/** 引擎宿主名（Native Messaging 注册名） */
export const NM_HOST_NAME = 'com.quicklogin.engine';

export type AccountState = 'starting' | 'online' | 'login_failed' | 'offline';

export interface EngineAccount {
  id: string;
  siteHost: string;
  username: string;
  alias: string;
  state: AccountState;
  createdAt: number;
  updatedAt: number;
}

/** 扩展 → 引擎 */
export type EngineCommand =
  | { cmd: 'list' }
  | {
      cmd: 'create';
      siteHost: string;
      username: string;
      alias: string;
      password: string;
      start?: boolean;
    }
  | { cmd: 'start'; accountId: string }
  | { cmd: 'stop'; accountId: string }
  | { cmd: 'delete'; accountId: string };

/** 引擎 → 扩展 */
export type EngineEvent =
  | { event: 'accounts'; accounts: EngineAccount[] }
  | { event: 'state'; accountId: string; state: AccountState; message?: string }
  | { event: 'error'; message: string };
