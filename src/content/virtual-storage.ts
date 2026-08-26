import { CONTENT_MESSAGE } from '../shared/constants';

const RUNTIME_URL = chrome.runtime.getURL('content/main/virtual-storage-runtime.js');

let injected = false;

/** 注入一次主世界运行时，负责按命名空间虚拟化 localStorage/sessionStorage */
function ensureRuntime(): void {
  if (injected) {
    return;
  }
  injected = true;
  const script = document.createElement('script');
  script.src = RUNTIME_URL;
  script.async = false;
  (document.head || document.documentElement).appendChild(script);
  script.remove();
}

function announce(sessionId: string): void {
  ensureRuntime();
  window.dispatchEvent(
    new CustomEvent('sb:storage-enable', { detail: { sessionId } }),
  );
}

chrome.runtime.onMessage.addListener((msg: unknown) => {
  if (
    msg &&
    typeof msg === 'object' &&
    (msg as { type?: string }).type === CONTENT_MESSAGE.announceSession
  ) {
    announce((msg as { sessionId?: string }).sessionId ?? '');
  }
});