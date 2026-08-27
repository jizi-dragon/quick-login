import type { EngineCommand, EngineEvent } from '../../../shared/nm-protocol';
import { NM_HOST_NAME } from '../../../shared/nm-protocol';

/**
 * NM port 管理器：懒连接 + 指数退避重连。
 * 引擎（com.quicklogin.engine）由 Chrome 按需拉起；断连时上报事件以标记状态 unknown。
 */
let port: chrome.runtime.Port | null = null;
let connected = false;
let reconnectAttempts = 0;
let reconnectTimer: number | undefined;

type Listener = (event: EngineEvent) => void;
const listeners = new Set<Listener>();

export function onEngineEvent(listener: Listener): void {
  listeners.add(listener);
}

export function isEngineConnected(): boolean {
  return connected;
}

function emit(event: EngineEvent): void {
  for (const l of listeners) {
    l(event);
  }
}

export function connect(): chrome.runtime.Port | null {
  if (port) {
    return port;
  }
  try {
    port = chrome.runtime.connectNative(NM_HOST_NAME);
  } catch {
    port = null;
    scheduleReconnect();
    return null;
  }
  connected = true;
  reconnectAttempts = 0;
  port.onMessage.addListener((msg: EngineEvent) => {
    emit(msg);
  });
  port.onDisconnect.addListener(() => {
    port = null;
    connected = false;
    emit({ event: 'error', message: 'engine_disconnected' });
    scheduleReconnect();
  });
  return port;
}

function scheduleReconnect(): void {
  if (reconnectTimer !== undefined) {
    return;
  }
  const delay = Math.min(1000 * 2 ** reconnectAttempts, 30_000);
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, delay) as unknown as number;
}

/** 发送指令到引擎（必要时建立连接）；引擎不可用返回 false */
export function sendCommand(cmd: EngineCommand): boolean {
  const p = connect();
  if (!p) {
    return false;
  }
  p.postMessage(cmd);
  return true;
}
