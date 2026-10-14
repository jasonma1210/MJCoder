// 组件 props 契约一致性门禁：父组件传入的 prop 名 vs 子组件解构的参数名
//
// 背景（同一处连续三次白屏，均在 ChatArea 的内部组件 Composer）：
//   ① onModeChange / worktreeInfo —— 变量重命名后 props 仍写旧名
//   ② planMode / onPlanMode      —— 父组件传了，Composer 解构列表漏了
//   ③ modeMsg                     —— 同样传了却没解构，直接在 JSX 里用
//
// 为什么 undef-ident 门禁抓不到：
//   它做的是「单文件扁平绑定集」—— 只要名字在整个文件里出现过就算已声明。
//   ChatArea 的组件顶层有 `const [modeMsg, setModeMsg] = useState('')`，
//   于是 Composer 里引用未解构的 modeMsg 也被认为合法。
//   这类错误必须按「组件边界」判定，而非文件边界。
//
// 做法：
//   1. 用 TS AST 找出文件内所有「函数组件」与其形参解构出的 prop 名
//   2. 找出所有 JSX 元素调用点，收集其传入的属性名（kebab/camel 统一转 camel）
//   3. 父传入的属性名若不在子组件的形参里 → 报「疑似漏解构」
//
// 边界（诚实标注）：
//   - 只覆盖同文件内的组件（跨文件 props 契约需要类型系统，见遗留项）
//   - 不区分「组件」与「普通函数」：普通函数被当组件用时会漏判（保守，不误报）
//   - 不校验属性值的正确性，只校验名字是否存在
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DESKTOP = path.join(__dirname, '..');
const SRC = path.join(DESKTOP, 'renderer/src');
const ts = require(path.join(DESKTOP, 'renderer/node_modules/typescript'));

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

/** 把 JSX 属性名归一：foo-bar → fooBar */
function toCamel(name) {
  return name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/**
 * 收集文件内每个「函数式组件」的形参 prop 名
 * 返回 Map<组件名, Set<propName>>
 * 组件识别：function Foo(...) / const Foo = (...) => ... / function Foo({a, b}) {...}
 */
function collectComponents(sf) {
  const components = new Map();
  const localNames = new Set();

  // 顶层名字先扫一遍，便于识别 const Foo = () => {}
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) localNames.add(st.name.text);
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) localNames.add(d.name.text);
      }
    }
    if (ts.isClassDeclaration(st) && st.name) localNames.add(st.name.text);
  }

  function propsOfParams(params) {
    const props = new Set();
    for (const p of params) {
      const n = p.name;
      if (ts.isObjectBindingPattern(n)) {
        for (const el of n.elements) {
          if (ts.isOmittedExpression(el)) continue;
          if (ts.isBindingElement(el)) {
            // 重命名解构 { path: dir } —— 对外的 prop 名是 path（键），不是 dir（本地名）
            props.add(el.propertyName ? el.propertyName.getText(sf) : el.name.getText(sf));
          } else {
            props.add(el.name.getText(sf));
          }
        }
      }
    }
    return props;
  }

  function visit(node) {
    // function Foo(props) { ... }
    if (ts.isFunctionDeclaration(node) && node.name) {
      const props = propsOfParams(node.parameters);
      // 只有解构了对象形参，或零参数，才视为「可接收 props 的组件」
      const isComponentLike = props.size > 0 || node.parameters.length === 0;
      if (isComponentLike) {
        // 精确匹配组件名，不可前缀匹配（Composer 与 ComposerControls 是两个组件）
        components.set(node.name.text, props);
      }
    }
    // const Foo = ({ a }) => ...  /  const Foo = (props) => ...
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
        node.initializer && ts.isArrowFunction(node.initializer)) {
      const props = propsOfParams(node.initializer.parameters);
      if (!components.has(node.name.text)) components.set(node.name.text, props);
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(sf, visit);
  return components;
}

// React 保留属性：不是组件自己声明的 props，由 React 运行时消费
const REACT_RESERVED = new Set([
  'key', 'ref', 'children', 'dangerouslySetInnerHTML', 'suppressContentEditableWarning',
  'suppressHydrationWarning', 'defaultValue', 'defaultChecked',
]);

/** 收集 JSX 调用点：返回 [{ name, props:Set }]，name 为大写开头的组件 */
function collectJsxUsages(sf) {
  const usages = [];

  function propsOf(attrs) {
    const props = new Set();
    if (!attrs) return props;
    for (const a of attrs.properties) {
      if (ts.isJsxAttribute(a) && a.name) {
        props.add(ts.isIdentifier(a.name) ? a.name.text : a.name.getText(sf));
      }
      // JsxSpreadAttribute 视为 {...any}，无法判定，忽略
    }
    return props;
  }

  function visit(node) {
    if (ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName;
      if (ts.isIdentifier(tag) && /^[A-Z]/.test(tag.text)) {
        usages.push({ name: tag.text, props: propsOf(node.attributes) });
      } else if (ts.isPropertyAccessExpression(tag) && ts.isIdentifier(tag.expression) && /^[A-Z]/.test(tag.expression.text)) {
        usages.push({ name: tag.expression.text, props: propsOf(node.attributes) });
      }
    }
    if (ts.isJsxElement(node)) {
      const opening = node.openingElement;
      const tag = opening.tagName;
      if (ts.isIdentifier(tag) && /^[A-Z]/.test(tag.text)) {
        usages.push({ name: tag.text, props: propsOf(opening.attributes) });
      }
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(sf, visit);
  return usages;
}

function analyzeFile(rel) {
  const sf = ts.createSourceFile(rel, fs.readFileSync(path.join(SRC, rel), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
  return { components: collectComponents(sf), usages: collectJsxUsages(sf) };
}

function listJsxFiles() {
  const out = [];
  const walk = (dir, prefix) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else if (e.name.endsWith('.jsx') && !e.name.includes('deprecated')) out.push(rel);
    }
  };
  walk(SRC, '');
  return out.sort();
}

const files = listJsxFiles();

check('扫描到渲染层文件', () => {
  assert.ok(files.length > 10, `只扫到 ${files.length} 个文件`);
  console.log(`       扫描 ${files.length} 个 JSX 文件`);
});

check('门禁自检：能抓出漏解构的 prop（真实事故形态）', () => {
  const fake = `
    import React from 'react';
    function Parent() {
      const [modeMsg, setModeMsg] = useState('');
      return <Composer modeMsg={modeMsg} onPlanMode={f} planMode={p} />;
    }
    function Composer({ input, onPlanMode }) {
      return <div>{modeMsg}</div>;
    }
    export default Parent;
  `;
  const sf = ts.createSourceFile('t.jsx', fake, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
  const components = collectComponents(sf);
  const usages = collectJsxUsages(sf);
  const u = usages.find((x) => x.name === 'Composer');
  assert.ok(u, '未识别出 Composer 调用点');
  assert.ok(u.props.has('modeMsg'), '未收集到传入的 modeMsg 属性');
  const missing = [...u.props].filter((p) => !REACT_RESERVED.has(p) && !components.get('Composer').has(p));
  assert.ok(missing.includes('modeMsg'), `门禁未能抓出漏解构：${missing}`);
  assert.ok(missing.includes('planMode'), `门禁未能抓出漏解构：${missing}`);
  assert.ok(!missing.includes('onPlanMode'), `已解构的属性被误报：${missing}`);
  assert.ok(!missing.includes('input'), `未传入的属性被误报：${missing}`);
});

check('门禁自检：kebab-case 属性归一为 camelCase', () => {
  const fake = `
    import React from 'react';
    function Child({ onSteer }) { return null; }
    function Parent() { return <Child on-steer={f} onQueue={g} />; }
    export default Parent;
  `;
  const sf = ts.createSourceFile('t.jsx', fake, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
  const u = collectJsxUsages(sf).find((x) => x.name === 'Child');
  assert.ok(u.props.has('on-steer'), 'kebab 属性未被收集');
  assert.equal(toCamel('on-steer'), 'onSteer');
});

check('门禁自检：HTML 标签与 spread 属性不误报', () => {
  const fake = `
    import React from 'react';
    function Parent() { return <div className="x"><Child {...rest} title="t" /></div>; }
    function Child({ title }) { return null; }
    export default Parent;
  `;
  const sf = ts.createSourceFile('t.jsx', fake, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
  const usages = collectJsxUsages(sf);
  assert.ok(!usages.some((u) => u.name === 'div'), 'HTML 标签被误认为组件');
  const u = usages.find((x) => x.name === 'Child');
  const missing = [...u.props].filter((p) => !REACT_RESERVED.has(p) && !collectComponents(sf).get('Child').has(p));
  assert.deepEqual(missing, [], `spread/保留属性被误报：${missing}`);
});

check('全部渲染层 JSX：组件 props 契约一致', () => {
  const problems = [];
  for (const f of files) {
    const { components, usages } = analyzeFile(f);
    for (const u of usages) {
      const known = components.get(u.name);
      if (!known) continue;               // 组件不在本文件定义（跨文件），不在本门禁范围
      const missing = [...u.props]
        .map(toCamel)
        .filter((p) => !REACT_RESERVED.has(p) && !known.has(p));
      if (missing.length) {
        problems.push(`${f}：<${u.name}> 传入未解构的属性 → ${missing.join(', ')}`);
      }
    }
  }
  assert.equal(problems.length, 0, `\n       ${problems.join('\n       ')}`);
});

console.log(`\nPASS：${pass}/${total} 项通过`);