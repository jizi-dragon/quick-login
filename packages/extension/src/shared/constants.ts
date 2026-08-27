export const IDB_NAME = 'sessionbox-reborn';
export const IDB_VERSION = 1;
export const IDB_STORE_SESSIONS = 'sessions';

/** 存在 session 级 chrome.storage.session 中的键 */
export const SESSION_KEYS = {
  sessionTabBindings: 'sb:tabBindings',
  pendingAutoLogins: 'sb:pendingAutoLogins',
} as const;

/** 存在 chrome.storage.local 中的站点清单键 */
export const LOCAL_KEYS = {
  siteGrants: 'sb:siteGrants',
} as const;

/** background 向内容脚本下发的消息 type */
export const CONTENT_MESSAGE = {
  setTitle: 'sb:setTitle',
  autoLogin: 'sb:autoLogin',
  autoLoginRequest: 'sb:autoLoginRequest',
} as const;

/** 新会话默认配色（蓝白主题内的强调色轮换） */
export const SESSION_COLORS = [
  '#1E6FFF',
  '#0FA3B1',
  '#7C5CFF',
  '#FF7A1A',
  '#22C55E',
] as const;
