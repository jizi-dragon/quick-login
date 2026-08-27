import { LOCAL_KEYS } from '../../shared/constants';
import type { SiteGrant } from '../../shared/types';

const MENU_ID = 'sessionbox-add-site';

function hostPattern(host: string): string {
  return `*://${host}/*`;
}

function siteKey(host: string): string {
  return host.toLowerCase();
}

async function readGrants(): Promise<SiteGrant[]> {
  const stored = await chrome.storage.local.get(LOCAL_KEYS.siteGrants);
  return (stored[LOCAL_KEYS.siteGrants] as SiteGrant[] | undefined) ?? [];
}

async function writeGrants(grants: SiteGrant[]): Promise<void> {
  await chrome.storage.local.set({ [LOCAL_KEYS.siteGrants]: grants });
}

export const siteAuth = {
  async list(): Promise<SiteGrant[]> {
    return readGrants();
  },

  async grant(host: string): Promise<SiteGrant> {
    const normalized = host.toLocaleLowerCase();
    const key = siteKey(normalized);
    const ok = await chrome.permissions.request({ origins: [hostPattern(normalized)] });
    if (!ok) {
      throw new Error(`拒绝授权站点: ${normalized}`);
    }
    const grants = await readGrants();
    if (!grants.some((g) => siteKey(g.host) === key)) {
      grants.push({ host: normalized, grantedAt: Date.now() });
      await writeGrants(grants);
    }
    return { host: normalized, grantedAt: Date.now() };
  },

  async grantCurrentTab(): Promise<string> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const host = extractHost(tab?.url);
    if (!host) {
      throw new Error('当前标签页不是 http/https 站点');
    }
    await this.grant(host);
    return host;
  },
};

function extractHost(url: string | undefined): string | null {
  if (!url) {
    return null;
  }
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.host : null;
  } catch {
    return null;
  }
}

export function registerAuthHandlers(): void {
  chrome.contextMenus.create(
    {
      id: MENU_ID,
      title: '将当前站点添加为会话站点',
      contexts: ['page', 'link'],
    },
    () => void chrome.runtime.lastError,
  );

  chrome.contextMenus.onClicked.addListener((info) => {
    if (info.menuItemId === MENU_ID) {
      void siteAuth.grantCurrentTab().catch(() => undefined);
    }
  });

  chrome.commands.onCommand.addListener((command) => {
    if (command === 'add_current_site') {
      void siteAuth.grantCurrentTab().catch(() => undefined);
    }
  });
}