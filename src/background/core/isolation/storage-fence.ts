/**
 * Storage-Fence：把「会话标识 + 账号别名」下发到标签页内容脚本，
 * 由内容脚本在该会话的 JS 态层做独立的 DOM 存储虚拟化与标题改写。
 */
export async function notifyTabState(tabId: number, sessionId: string, alias: string): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'sb:activate',
      sessionId,
      alias,
    });
  } catch {
    // 内容脚本尚未就绪（如加载中），由 navigation 在下一次 committed 时再次下发
  }
}