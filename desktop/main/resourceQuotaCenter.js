// P3-1/P3-2/P3-3：ResourceQuotaCenter——唯一可信资源快照 + 槽位预占 + 预算隔离 + 节流状态机
// 指标按 Backend 类型多态（计划 1.4-#3 裁定）：
//   Cloud（现状主力）：并发请求数 / provider + 前台预占槽位 + 错误连击熔断
//   Local（P3-4）：预留探测位（detectOllama），槽位语义=推理并发
// 前台/后台隔离（P3-2）：
//   fg = 用户会话 / Worker 子任务 / 定时任务（用户可感知的一切）
//   bg = 记忆压缩等后台作业；bg 可用槽位 = limit - fgReserve（前台永远保留 fgReserve 个槽位）
// 节流状态机（P3-3）：
//   idle     fg 在飞 0 个               → bg 正常
//   busy     fg 在飞 > 0                → bg 最多同时 1 个（让路）
//   overload 连续错误 ≥ 阈值 → 熔断 5 分钟 → bg 全停，fg 照常（用户自己会看到错误）
// 可观测（P3-5）：snapshot() 供渲染层轮询；'change' 事件供后续事件驱动升级。
const { EventEmitter } = require('events');

const OVERLOAD_THRESHOLD = 5;      // 连续错误次数 → 熔断
const OVERLOAD_COOLDOWN_MS = 5 * 60 * 1000;

class ResourceQuotaCenter extends EventEmitter {
  constructor({ providerLimit = 8, fgReserve = 2 } = {}) {
    super();
    this.providerLimit = Math.max(1, Number(providerLimit) || 8);
    this.fgReserve = Math.max(0, Number(fgReserve) || 2);
    this.providers = new Map(); // providerId → { inFlightFg, inFlightBg, errStreak, openUntil }
    this.localBackend = null;   // P3-4：{ ollama: bool, models: n, checkedAt }
  }

  _provider(id) {
    const key = String(id || 'default');
    if (!this.providers.has(key)) {
      this.providers.set(key, { inFlightFg: 0, inFlightBg: 0, errStreak: 0, openUntil: 0 });
    }
    return this.providers.get(key);
  }

  // ── 槽位获取（P3-2 槽位预占）──
  // 返回 { release() }；等待超时仍拿不到 → 抛错（调用方决定降级；fg 超时罕见=真过载）
  async acquire(kind, providerId, { timeoutMs = 30000 } = {}) {
    const p = this._provider(providerId);
    const isFg = kind !== 'bg';
    const start = Date.now();
    // 等待循环：前台优先——bg 不仅要看总量，还要给 fg 留 fgReserve 个空位
    for (;;) {
      const total = p.inFlightFg + p.inFlightBg;
      const breakerOpen = p.openUntil > Date.now();
      if (!breakerOpen) {
        if (isFg) {
          if (total < this.providerLimit) { p.inFlightFg += 1; break; }
        } else {
          const bgCeiling = this.providerLimit - this.fgReserve; // 预算隔离：bg 不吃预留槽
          const bgRunning = p.inFlightBg;
          const busy = p.inFlightFg > 0;
          const bgCap = busy ? Math.min(1, bgCeiling) : bgCeiling; // busy 态 bg 让路（P3-3）
          if (bgRunning < bgCap) { p.inFlightBg += 1; break; }
        }
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`资源槽位等待超时（${kind}/${providerId}，limit=${this.providerLimit}${breakerOpen ? '，熔断中' : ''}）`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    this.emit('change', this.snapshot());
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        if (isFg) p.inFlightFg = Math.max(0, p.inFlightFg - 1);
        else p.inFlightBg = Math.max(0, p.inFlightBg - 1);
        this.emit('change', this.snapshot());
      },
    };
  }

  // ── 错误连击熔断（P3-3 overload）──
  reportError(providerId) {
    const p = this._provider(providerId);
    p.errStreak += 1;
    if (p.errStreak >= OVERLOAD_THRESHOLD && p.openUntil <= Date.now()) {
      p.openUntil = Date.now() + OVERLOAD_COOLDOWN_MS;
      this.emit('overload', { providerId, cooldownMs: OVERLOAD_COOLDOWN_MS });
    }
    this.emit('change', this.snapshot());
  }

  reportSuccess(providerId) {
    const p = this._provider(providerId);
    p.errStreak = 0;
    p.openUntil = 0;
  }

  // bg 任务是否放行（MemoryBgScheduler 每次领取前询问）
  bgAllowed() {
    for (const p of this.providers.values()) {
      if (p.openUntil > Date.now()) return false; // 任一 provider 熔断中 → bg 全停
    }
    return true;
  }

  throttleState() {
    let busy = false;
    let overloaded = false;
    for (const p of this.providers.values()) {
      if (p.inFlightFg > 0) busy = true;
      if (p.openUntil > Date.now()) overloaded = true;
    }
    return overloaded ? 'overloaded' : busy ? 'busy' : 'idle';
  }

  // ── 统一快照（P3-1/P3-5：渲染层唯一可信资源视图）──
  snapshot() {
    const providers = {};
    for (const [id, p] of this.providers) {
      providers[id] = {
        fg: p.inFlightFg, bg: p.inFlightBg, limit: this.providerLimit,
        errStreak: p.errStreak, breakerOpen: p.openUntil > Date.now(),
      };
    }
    return {
      providers,
      throttle: this.throttleState(),
      localBackend: this.localBackend,
      ts: Date.now(),
    };
  }

  // ── P3-4：本地后端探测（Ollama）——探测结果进快照；接入方式=自定义 provider（baseUrl http://localhost:11434/v1）──
  async detectLocalBackend() {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 800);
      const res = await fetch('http://localhost:11434/api/tags', { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) {
        const j = await res.json().catch(() => ({}));
        this.localBackend = { ollama: true, models: (j.models || []).length, checkedAt: Date.now() };
      } else { this.localBackend = { ollama: false, models: 0, checkedAt: Date.now() }; }
    } catch {
      this.localBackend = { ollama: false, models: 0, checkedAt: Date.now() };
    }
    this.emit('change', this.snapshot());
    return this.localBackend;
  }
}

module.exports = { ResourceQuotaCenter, OVERLOAD_THRESHOLD, OVERLOAD_COOLDOWN_MS };
