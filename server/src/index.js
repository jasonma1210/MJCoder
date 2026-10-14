require('dotenv').config();
const express = require('express');
const cors = require('cors');
const authRoutes = require('./routes/auth');
const threadRoutes = require('./routes/threads');
const modelRoutes = require('./routes/models');
const dashboardRoutes = require('./routes/dashboard');
const globalModelsRoutes = require('./routes/global-models');
const scheduledTasksRoutes = require('./routes/scheduled-tasks');
const cloudRoutes = require('./routes/cloud');
const chatRoutes = require('./routes/chat');
const auditRoutes = require('./routes/audit');
const collabRoutes = require('./routes/collab');
const { features, snapshot } = require('./config/features');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// health 必须置于各 router 之前：router.use(authMiddleware) 会吞掉未匹配路径
// features 下发给桌面端，用于按开关隐藏/显示功能入口
app.get('/api/health', (req, res) => res.json({ status: 'ok', ts: Date.now(), features: snapshot() }));

app.use('/api/auth', authRoutes);
app.use('/api', globalModelsRoutes);
app.use('/api', threadRoutes);
app.use('/api', modelRoutes);
app.use('/api', dashboardRoutes);
app.use('/api', scheduledTasksRoutes);
// 云端委派默认停用（M6）：不挂载 cloud 路由、不启动队列 worker
if (features.cloud) {
  app.use('/api', cloudRoutes);
  console.log('[features] 云端委派已开启（MJ_CLOUD_ENABLED）');
} else {
  console.log('[features] 云端委派已停用（M6 暂停），如需恢复设置 MJ_CLOUD_ENABLED=1');
}
app.use('/api', chatRoutes);
app.use('/api', auditRoutes);
// 协同（P4/P5，默认开启）：会话/看板/审批 CRDT；路由自带鉴权中间件
app.use('/api', collabRoutes);
console.log('[features] 协同（Yjs CRDT）已开启');

// 404
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// 统一错误中间件（asyncHandler 捕获的异常在此收敛）
app.use((err, req, res, next) => {
  console.error(`[api] ${req.method} ${req.path}`, err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || '服务端异常' });
});

const PORT = process.env.PORT || 3001;

// 进程级兜底：单个 async 路由异常不得拖垮服务端（M1 将上线统一 asyncHandler）
process.on('unhandledRejection', (err) => {
  console.error('[server] 未处理的 Promise 拒绝:', err);
});

app.listen(PORT, () => {
  console.log(`MJ Code server running on http://localhost:${PORT}`);
  // 定时任务调度引擎随服务端启动
  require('./jobs/scheduler').startScheduler();
  // 云端任务队列 worker 随服务端启动（单并发消费 queued 运行）；云端委派停用时不启动
  if (features.cloud) {
    require('./jobs/cloud/queue').startWorker();
  }
});
