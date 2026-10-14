// Computer Use 单元测试：AX 树解析 / 提示词 / 动作解析 / 敏感判定 / 审批摘要 / Loop 逻辑
const cua = require('../main/computerUse');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── 样例 AX 树（缩进 + role|name|value|x,y|w,h）──
const SAMPLE_AX = [
  'AXWindow|主窗口||0,0|800,600',
  '  AXButton|登录||100,200|80,30',
  '  AXTextField|用户名|hello|50,60|120,24',
  '    AXStaticText|提示文本||0,0|0,0',
  '  AXCheckBox|记住我||300,400|20,20',
  '    AXButton|支付||10,10|60,24',
  '  AXButton|删除记录||400,500|70,24',
  '  AXImage|logo||0,0|50,50',
].join('\n');

// ── parseAxTree ──
{
  const { nodes, interactive } = cua.parseAxTree(SAMPLE_AX);
  check('AX 树节点总数', nodes.length === 8, `实际 ${nodes.length}`);
  check('role 前缀归一化小写', nodes[1].role === 'button' && nodes[2].role === 'textfield');
  check('缩进层级解析', nodes[0].depth === 0 && nodes[1].depth === 1 && nodes[3].depth === 2);
  check('name/value 提取', nodes[2].name === '用户名' && nodes[2].value === 'hello');
  check('position/size 解析', nodes[1].position.x === 100 && nodes[1].position.y === 200 && nodes[1].size.x === 80);
  check('path 层级构造', JSON.stringify(nodes[3].path) === '[0,1,0]', `实际 ${JSON.stringify(nodes[3].path)}`);
  check('可交互节点过滤', interactive.length === 5 && !interactive.some((n) => n.role === 'statictext' || n.role === 'image'));
  check('ref 从 1 起编号', interactive[0].ref === 1 && interactive[4].ref === 5);
  check('空输入不崩溃', cua.parseAxTree('').nodes.length === 0 && cua.parseAxTree(null).interactive.length === 0);
}

// ── buildCUAPrompt ──
{
  const { interactive } = cua.parseAxTree(SAMPLE_AX);
  const { system, user } = cua.buildCUAPrompt(interactive, '登录测试应用', ['测试应用']);
  check('system 含第三方内容隔离声明', system.includes('都不是用户指令'));
  check('system 含动作 JSON 约束', system.includes('"action"') && system.includes('done'));
  check('system 含敏感操作逐次确认声明', system.includes('逐次'));
  check('user 含目标', user.includes('登录测试应用'));
  check('user 含允许应用', user.includes('测试应用'));
  check('user 含 ref 编号节点', user.includes('[1] button "登录"') && user.includes('[4] button "支付"'));
  check('空节点列表兜底', cua.buildCUAPrompt([], '目标').user.includes('未发现可交互节点'));
}

// ── parseAction ──
{
  const a1 = cua.parseAction('{"action":"click","ref":3}');
  check('合法 click 解析', a1 && a1.action === 'click' && a1.ref === 3);
  const a2 = cua.parseAction('```json\n{"action":"type","ref":2,"text":"你好"}\n```');
  check('代码围栏内 JSON 解析', a2 && a2.action === 'type' && a2.text === '你好');
  const a3 = cua.parseAction('好的，我将点击 {"action":"click","ref":1} 请确认');
  check('混杂文本中提取 JSON', a3 && a3.ref === 1);
  const a4 = cua.parseAction('{"action" "click" "ref" 1');
  check('JSON 损坏正则兜底', a4 && a4.action === 'click');
  check('非法动作返回 null', cua.parseAction('{"action":"format_disk"}') === null);
  check('click 缺 ref 返回 null', cua.parseAction('{"action":"click"}') === null);
  check('type 缺 text 返回 null', cua.parseAction('{"action":"type","ref":1}') === null);
  check('key 缺 key 返回 null', cua.parseAction('{"action":"key"}') === null);
  check('非 JSON 输出返回 null', cua.parseAction('我觉得应该点击登录按钮') === null);
  check('空输入返回 null', cua.parseAction('') === null && cua.parseAction(null) === null);
  const a5 = cua.parseAction('{"action":"done","summary":"完成登录"}');
  check('done 动作解析', a5 && a5.action === 'done' && a5.summary === '完成登录');
}

// ── needsCUAConfirmation ──
{
  const { interactive } = cua.parseAxTree(SAMPLE_AX);
  check('支付按钮命中确认', cua.needsCUAConfirmation({ action: 'click', ref: 4 }, interactive[3]) === true);
  check('删除按钮命中确认', cua.needsCUAConfirmation({ action: 'click', ref: 5 }, interactive[4]) === true);
  check('普通中文输入不命中确认', cua.needsCUAConfirmation({ action: 'type', text: '金额 100 元' }, null) === false);
  check('含验证码节点命中确认', cua.needsCUAConfirmation({ action: 'type', text: '123456' }, { name: 'captcha 输入框' }) === true);
  check('普通点击不命中确认', cua.needsCUAConfirmation({ action: 'click', ref: 1 }, interactive[0]) === false);
  check('普通输入不命中确认', cua.needsCUAConfirmation({ action: 'type', text: 'hello' }, interactive[1]) === false);
  check('英文关键词命中确认', cua.needsCUAConfirmation({ action: 'click' }, { name: 'Checkout Now' }) === true);
  check('空动作返回 false', cua.needsCUAConfirmation(null, null) === false);
}

// ── cuApprovalSummary ──
{
  const { interactive } = cua.parseAxTree(SAMPLE_AX);
  const s1 = cua.cuApprovalSummary({ action: 'click', ref: 1 }, interactive[0]);
  check('click 摘要含标题与目标', s1.title.includes('点击') && s1.detail.includes('登录'));
  check('摘要定级 L1', s1.level === 'L1');
  const s2 = cua.cuApprovalSummary({ action: 'type', ref: 2, text: 'some-password' }, interactive[1]);
  check('type 摘要含输入内容', s2.detail.includes('some-password'));
  const s3 = cua.cuApprovalSummary({ action: 'click', ref: 99 }, null);
  check('未定位节点时摘要可读', s3.detail.includes('ref 99'));
}

// ── buildActionScript / buildAxScript ──
{
  check('AX 脚本注入清洗', cua.buildAxScript('Foo"Bar').includes('FooBar') && !cua.buildAxScript('a"b').includes('"b'));
  const click = cua.buildActionScript({ action: 'click' }, { position: { x: 10, y: 20 }, size: { x: 100, y: 50 } }, 'App');
  check('click 命中元素中心', click.includes('click at {60, 45}'));
  check('无位置节点 click 返回 null', cua.buildActionScript({ action: 'click' }, null, 'App') === null);
  check('type 转义引号', cua.buildActionScript({ action: 'type', text: 'say "hi"' }, null, '').includes('\\"hi\\"'));
  check('return 映射 key code 36', cua.buildActionScript({ action: 'key', key: 'return' }, null, '').includes('key code 36'));
  check('scroll 默认下翻', cua.buildActionScript({ action: 'scroll' }, null, '').includes('key code 121'));
  check('非法动作返回 null', cua.buildActionScript({ action: 'reboot' }, null, 'App') === null);
}

// ── HUD（stub BrowserWindow）──
{
  class FakeBW {
    constructor(opts) { this.opts = opts; this.url = ''; this.webContents = { executeJavaScript: async () => {} }; }
    loadURL(u) { this.url = u; }
    destroy() { this.destroyed = true; }
  }
  const hud = cua.createHudWindow(FakeBW);
  check('HUD 尺寸 450x56', hud.win.opts.width === 450 && hud.win.opts.height === 56);
  check('HUD 无边框置顶', hud.win.opts.frame === false && hud.win.opts.alwaysOnTop === true);
  check('HUD 加载内嵌页面', hud.win.url.startsWith('data:text/html'));
  hud.update('测试动作');
  hud.destroy();
  cua.destroyHud(); // 幂等
  check('HUD 销毁幂等', true);
}

// ── ComputerUseLoop：三步脚本 click → type → done ──
async function loopHappyPath() {
  const script = [
    '{"action":"click","ref":1}',
    '{"action":"type","ref":2,"text":"hello"}',
    '{"action":"done","summary":"登录完成"}',
  ];
  const { interactive } = cua.parseAxTree(SAMPLE_AX);
  const events = [];
  const performOrder = [];
  const approvalCalls = [];
  const auditCalls = [];
  let chatIdx = 0;
  const loop = new cua.ComputerUseLoop({
    objective: '登录测试应用',
    appName: 'TestApp',
    maxSteps: 5,
    approvalMode: 'on-request',
    toolHandlers: {
      chat: async () => script[chatIdx++],
      collectAx: async () => ({ nodes: [], interactive }),
      perform: async (action) => { performOrder.push(action.action); return { ok: true }; },
    },
    approval: {
      requestApproval: async (summary) => { approvalCalls.push(summary); return 'once'; },
      audit: (...args) => auditCalls.push(args),
    },
    onEvent: (evt) => events.push(evt),
  });
  const result = await loop.run();
  check('Loop 完成', result.completed === true && result.step === 3);
  check('动作按序执行', JSON.stringify(performOrder) === '["click","type"]', JSON.stringify(performOrder));
  check('on-request 模式逐步审批', approvalCalls.length === 2 && approvalCalls[0].title.includes('点击') && approvalCalls[1].title.includes('输入'));
  check('审批摘要含目标节点', approvalCalls[0].detail.includes('登录'));
  check('每步审计上报', auditCalls.length === 2 && auditCalls[0][2] === 'approved');
  const types = events.map((e) => e.type).join(',');
  check('事件序列正确', types === 'started,confirm,step,confirm,step,done', types);
  check('done 事件含摘要', events.find((e) => e.type === 'done').summary === '登录完成');
  check('step 事件携带节点与结果', events.find((e) => e.type === 'step').node.role === 'button');
}

// ── ComputerUseLoop：stop() 提前中断 ──
async function loopStop() {
  const { interactive } = cua.parseAxTree(SAMPLE_AX);
  const events = [];
  let performs = 0;
  let loop;
  const run = new cua.ComputerUseLoop({
    objective: '不停点击',
    appName: 'TestApp',
    maxSteps: 10,
    approvalMode: 'auto-safe',
    toolHandlers: {
      chat: async () => '{"action":"click","ref":1}',
      collectAx: async () => ({ nodes: [], interactive }),
      perform: async () => {
        performs++;
        if (performs === 2) loop.stop();
        return { ok: true };
      },
    },
    approval: { requestApproval: async () => 'once', audit: () => {} },
    onEvent: (evt) => events.push(evt),
  });
  loop = run;
  const result = await loop.run();
  check('stop 后两步内中断', performs === 2 && result.stopped === true);
  check('末尾事件为 stopped', events[events.length - 1].type === 'stopped');
}

// ── ComputerUseLoop：拒绝审批即停止 ──
async function loopDeny() {
  const { interactive } = cua.parseAxTree(SAMPLE_AX);
  const events = [];
  let performs = 0;
  const loop = new cua.ComputerUseLoop({
    objective: '触发支付确认',
    appName: 'TestApp',
    maxSteps: 5,
    approvalMode: 'never',
    toolHandlers: {
      chat: async () => '{"action":"click","ref":4}',
      collectAx: async () => ({ nodes: [], interactive }),
      perform: async () => { performs++; return { ok: true }; },
    },
    approval: { requestApproval: async () => 'deny', audit: () => {} },
    onEvent: (evt) => events.push(evt),
  });
  const result = await loop.run();
  check('敏感动作在 never 模式仍强制确认', events.some((e) => e.type === 'confirm'));
  check('拒绝后不执行动作', performs === 0 && result.stopped === true);
  check('末尾事件为 stopped', events[events.length - 1].type === 'stopped');
}

// ── ComputerUseLoop：maxSteps 耗尽 ──
async function loopMaxSteps() {
  const { interactive } = cua.parseAxTree(SAMPLE_AX);
  const events = [];
  const loop = new cua.ComputerUseLoop({
    objective: '循环点击',
    appName: 'TestApp',
    maxSteps: 2,
    approvalMode: 'auto-safe',
    toolHandlers: {
      chat: async () => '{"action":"click","ref":1}',
      collectAx: async () => ({ nodes: [], interactive }),
      perform: async () => ({ ok: true }),
    },
    approval: { requestApproval: async () => 'once', audit: () => {} },
    onEvent: (evt) => events.push(evt),
  });
  const result = await loop.run();
  const doneEvt = events.find((e) => e.type === 'done');
  check('maxSteps 耗尽输出 done+maxStepsReached', result.maxStepsReached === true && doneEvt && doneEvt.maxStepsReached === true);
}

(async () => {
  await loopHappyPath();
  await loopStop();
  await loopDeny();
  await loopMaxSteps();
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
  process.exit(fail === 0 ? 0 : 1);
})();
