import { randomBytes, createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Dpapi } from '@primno/dpapi';

/**
 * 账号密码加密：AES-256-GCM，密钥经 HKDF 从种子派生。
 * 种子本体用 Windows DPAPI 加密落盘（CurrentUser 范围，设备绑定，换机失效）。
 */
const SEED_FILE = 'seed.bin';
const SALT = 'quicklogin-v1';

let cachedKey: Buffer | null = null;

/** 取或生成 DPAPI 保护的密钥种子（种子明文只在内存瞬时存在） */
function loadSeed(dir: string): Buffer {
  const seedPath = join(dir, SEED_FILE);
  if (existsSync(seedPath)) {
    return Buffer.from(Dpapi.unprotectData(readFileSync(seedPath), null, 'CurrentUser'));
  }
  const seed = randomBytes(32);
  mkdirSync(dir, { recursive: true });
  writeFileSync(seedPath, Buffer.from(Dpapi.protectData(seed, null, 'CurrentUser')));
  return seed;
}

function deriveKey(dir: string): Buffer {
  if (cachedKey) {
    return cachedKey;
  }
  const seed = loadSeed(dir);
  cachedKey = Buffer.from(
    hkdfSync('sha256', seed, Buffer.from(SALT), Buffer.from('quicklogin-credentials'), 32),
  );
  return cachedKey;
}

/** 返回 "iv:tag:ciphertext"（均 base64） */
export function encrypt(dataDir: string, plaintext: string): string {
  const key = deriveKey(dataDir);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

export function decrypt(dataDir: string, payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(':');
  const key = deriveKey(dataDir);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
