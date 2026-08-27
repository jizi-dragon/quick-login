import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { encrypt, decrypt } from './crypto';

export interface AccountRow {
  id: string;
  site_host: string;
  username: string;
  alias: string;
  password_enc: string;
  created_at: number;
  updated_at: number;
}

/**
 * 账号库：SQLite 单文件。密码列仅存密文（AES-GCM + DPAPI 种子）。
 */
export class AccountStore {
  private db: Database.Database;

  constructor(dbPath: string, private readonly dataDir: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id          TEXT PRIMARY KEY,
        site_host   TEXT NOT NULL,
        username    TEXT NOT NULL,
        alias       TEXT NOT NULL,
        password_enc TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
    `);
  }

  list(): AccountRow[] {
    return this.db.prepare('SELECT * FROM accounts ORDER BY created_at').all() as AccountRow[];
  }

  get(id: string): AccountRow | undefined {
    return this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined;
  }

  create(input: { siteHost: string; username: string; alias: string; password: string }): AccountRow {
    const now = Date.now();
    const row: AccountRow = {
      id: randomUUID(),
      site_host: input.siteHost,
      username: input.username,
      alias: input.alias,
      password_enc: encrypt(this.dataDir, input.password),
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        'INSERT INTO accounts (id, site_host, username, alias, password_enc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(row.id, row.site_host, row.username, row.alias, row.password_enc, row.created_at, row.updated_at);
    return row;
  }

  password(row: AccountRow): string {
    return decrypt(this.dataDir, row.password_enc);
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id).changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
