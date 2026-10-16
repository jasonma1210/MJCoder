// T3-6 fixture：永不 ready 的子进程——验证宿主 ready 超时保护（子进程卡死在初始化时的兜底路径）。
setInterval(() => { /* 保持 IPC 通道存活但不发送任何消息 */ }, 1000);
