// 功能开关中心（M6）
// 云端委派与微信小程序控制面默认停用，需显式开启，避免无谓的队列 worker 占用与安全面暴露。
// 读取环境变量（运行时求值，便于测试按需开启）：
//   MJ_CLOUD_ENABLED=1        开启云端委派（cloud 路由 + 队列 worker + 调度分发）
//   MJ_MINIPROGRAM_ENABLED=1  开启微信小程序控制面（mp-bind / mp-confirm / mp-session）
function boolEnv(name, def = false) {
  const v = process.env[name];
  if (v === undefined || v === null || v === '') return def;
  return v === '1' || String(v).toLowerCase() === 'true' || String(v).toLowerCase() === 'yes';
}

const features = {
  get cloud() {
    return boolEnv('MJ_CLOUD_ENABLED', false);
  },
  get miniprogram() {
    return boolEnv('MJ_MINIPROGRAM_ENABLED', false);
  },
};

// 对外快照：/api/health 与桌面端据此隐藏/显示相关功能
function snapshot() {
  return {
    cloud: features.cloud,
    miniprogram: features.miniprogram,
  };
}

module.exports = { features, snapshot, boolEnv };