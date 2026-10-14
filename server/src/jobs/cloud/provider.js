// 云端执行 Provider 抽象与实现
// CloudProvider 接口：
//   provision(task) -> { sandboxId, workdir }   创建执行环境
//   run(sandbox, task) -> { ok, diff, report }  在环境中执行任务（report 含 finalText/usage/error 等）
//   destroy(sandbox)                            释放环境
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// 任务 JSON / 报告 JSON 与 agent-core cli.js 的约定契约：
// task.json   { objective, provider:{id, base_url, model_id, api_key}, cwd, maxRounds }
// report.json { ok, finalText, usage, diff, sessionPath, error }

class LocalWorkerProvider {
  /**
   * @param {object} opts
   * @param {string} [opts.cliPath]  agent-core cli.js 绝对路径，缺省指向 desktop/agent-core/cli.js
   * @param {string} [opts.nodeBin]  node 可执行文件
   */
  constructor(opts = {}) {
    this.name = 'local-worker';
    this.nodeBin = opts.nodeBin || process.execPath;
    this.cliPath = opts.cliPath
      || path.resolve(__dirname, '../../../..', 'desktop', 'agent-core', 'cli.js');
  }

  // 本地容器替身：mkdtemp 建独立工作目录充当沙箱
  async provision(task) {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-cloud-'));
    return { sandboxId: `local-${path.basename(workdir)}`, workdir };
  }

  // spawn node cli.js 真实执行；cli 缺失或进程失败时 report.ok=false 带错误
  async run(sandbox, task) {
    if (!fs.existsSync(this.cliPath)) {
      return {
        ok: false,
        diff: null,
        report: { ok: false, error: `agent-core cli 不存在: ${this.cliPath}` },
      };
    }
    const taskJson = path.join(sandbox.workdir, 'task.json');
    const reportJson = path.join(sandbox.workdir, 'report.json');
    fs.writeFileSync(taskJson, JSON.stringify({
      objective: task.objective,
      provider: task.provider,
      cwd: sandbox.workdir,
      maxRounds: task.maxRounds || 20,
    }));

    const result = await new Promise((resolve) => {
      const child = spawn(this.nodeBin, [this.cliPath, '--task', taskJson, '--out', reportJson], {
        cwd: sandbox.workdir,
        env: { ...process.env },
      });
      let stderr = '';
      const timeout = setTimeout(() => {
        stderr += '\n执行超时（10 分钟），进程已终止';
        child.kill('SIGKILL');
      }, 10 * 60 * 1000);
      child.on('error', (err) => {
        clearTimeout(timeout);
        resolve({ ok: false, stderr: `进程启动失败: ${err.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timeout);
        resolve({ ok: code === 0, stderr });
      });
    });

    if (!result.ok) {
      return {
        ok: false,
        diff: null,
        report: { ok: false, error: result.stderr || `agent-core 进程退出码异常` },
      };
    }
    // 读取 report；读不到或解析失败均按失败处理
    try {
      const report = JSON.parse(fs.readFileSync(reportJson, 'utf8'));
      return { ok: !!report.ok, diff: report.diff || null, report };
    } catch (err) {
      return {
        ok: false,
        diff: null,
        report: { ok: false, error: `report.json 读取失败: ${err.message}` },
      };
    }
  }

  async destroy(sandbox) {
    // 保留工作目录供排障，不做物理清理；容器化后此处对接 docker rm
  }
}

class E2BProvider {
  constructor(opts = {}) {
    this.name = 'e2b';
    // 结构完整的桩实现：缺 E2B_API_KEY 直接抛「未配置」
    if (!opts.apiKey && !process.env.E2B_API_KEY) {
      throw new Error('E2BProvider 未配置：缺少 E2B_API_KEY 环境变量');
    }
    this.apiKey = opts.apiKey || process.env.E2B_API_KEY;
  }

  async provision(task) {
    throw new Error('E2BProvider 尚未接入：等待 e2b SDK 集成');
  }

  async run(sandbox, task) {
    throw new Error('E2BProvider 尚未接入：等待 e2b SDK 集成');
  }

  async destroy(sandbox) {
    throw new Error('E2BProvider 尚未接入：等待 e2b SDK 集成');
  }
}

// 按名称取 provider 实例；opts 透传构造参数（测试可注入 cliPath 覆盖）
function createProvider(name, opts = {}) {
  if (name === 'e2b') return new E2BProvider(opts);
  return new LocalWorkerProvider(opts);
}

module.exports = { LocalWorkerProvider, E2BProvider, createProvider };
