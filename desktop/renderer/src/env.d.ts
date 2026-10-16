/// <reference types="vite/client" />
// 运行环境类型声明：window.mjcode 由 preload contextBridge 注入
declare global {
  interface Window {
    mjcode: Record<string, (...args: unknown[]) => unknown> | undefined;
  }
}

export {};
