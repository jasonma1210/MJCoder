// 渲染层未定义标识符门禁：静态拦住「引用了不存在的变量/组件」导致的白屏
//
// 背景（两次真实事故，均由用户在真机启动时发现）：
//   ① ChatArea 重命名 onModeChange→switchMode、worktreeInfo→worktree，
//      但两处 <Composer> 的 props 仍写旧名 → 运行时 "onModeChange is not defined" → 白屏
//   ② 内部组件 Composer 的解构参数漏了 planMode / onPlanMode，函数体却在用
//      → 运行时 "planMode is not defined" → 白屏
// 两次发生时 22 套件 / 606 断言全绿 —— 现有门禁只查「约定」（裸色/z-index/emoji），
// 完全没有查「名字是否存在」。这类错误必须静态拦，不能靠人眼或用户实测发现。
//
// 方法：用 TypeScript 编译器 API 做真正的作用域分析（不是正则，也不是手写词法器）。
//   1. ts.createSourceFile 解析 .jsx 为 AST（JSX 标签、属性、解构、默认值全是结构化节点）
//   2. 遍历收集「绑定」：import / var-let-const / function / class / 形参 / 箭头参数 /
//      解构 / for-in-of / catch / 类成员 —— 逐层递归进任意作用域
//   3. 遍历收集「引用」：只认裸标识符，排除属性访问右侧（a.b）、对象键、JSX 标签名、
//      JSX 属性名、标签字符串、以及 JS 全局/React 生态白名单
//   4. 差集 = 引用了但未绑定 → 即白屏风险
//
// 关键点：绑定集是「全文件扁平集合」，不做作用域隔离 ——
//   目的是只抓「这个名字在整个文件里从未出现过」这一类致命错误，
//   而不是做完整的 TDZ/作用域校验（那会误报跨作用域的合法引用）。
//   换来的是零误报 + 两次真实事故 100% 命中。
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

// JS 全局 + React 生态：不参与「漏声明」判定
const GLOBALS = new Set([
  'undefined', 'null', 'true', 'false', 'NaN', 'Infinity', 'globalThis', 'window',
  'document', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage',
  'console', 'JSON', 'Math', 'Date', 'Number', 'String', 'Boolean', 'Array', 'Object',
  'Promise', 'Symbol', 'Map', 'Set', 'WeakMap', 'WeakSet', 'RegExp', 'Error', 'TypeError',
  'RangeError', 'SyntaxError', 'Proxy', 'Reflect', 'BigInt', 'Intl', 'URL', 'URLSearchParams',
  'AbortController', 'AbortSignal', 'TextEncoder', 'TextDecoder', 'fetch', 'setTimeout',
  'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
  'cancelAnimationFrame', 'queueMicrotask', 'structuredClone', 'crypto', 'performance',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'encodeURI', 'decodeURI', 'Function', 'eval', 'arguments', 'require', 'process',
  'Buffer', '__dirname', '__filename', 'global', 'exports', 'module',
  // 浏览器全局（渲染层运行在浏览器环境）
  'CustomEvent', 'Event', 'EventTarget', 'Blob', 'File', 'FileReader', 'FormData',
  'Headers', 'Request', 'Response', 'URL', 'WebSocket', 'Worker', 'Notification',
  'alert', 'confirm', 'prompt', 'matchMedia', 'getComputedStyle', 'requestIdleCallback',
  'ResizeObserver', 'IntersectionObserver', 'MutationObserver', 'DOMParser',
  'XMLHttpRequest', 'Image', 'Audio', 'Node', 'Element', 'HTMLElement', 'navigator',
  'screen', 'frames', 'parent', 'top', 'self', 'name', 'origin', 'status',
  // 类型化数组 / 编码 / 音频（A5 录音与 A12 粘贴落盘使用）
  'Uint8Array', 'Uint16Array', 'Uint32Array', 'Int8Array', 'Int16Array', 'Int32Array',
  'Float32Array', 'Float64Array', 'ArrayBuffer', 'DataView', 'btoa', 'atob',
  'AudioContext', 'AudioWorklet', 'MediaRecorder', 'MediaStream', 'getUserMedia',
  // React 生态
  'React', 'Fragment', 'Suspense', 'StrictMode', 'memo', 'forwardRef', 'createElement',
  'Children', 'cloneElement', 'isValidElement', 'useState', 'useEffect', 'useLayoutEffect',
  'useMemo', 'useCallback', 'useRef', 'useContext', 'useReducer', 'useId',
  'useSyncExternalStore', 'useTransition', 'useDeferredValue', 'createContext', 'createPortal',
  'useImperativeHandle', 'useDebugValue',
]);

/** 收集绑定名：递归处理解构与默认值 */
function addBindingName(bound, node) {
  if (!node) return;
  if (ts.isIdentifier(node)) { bound.add(node.text); return; }
  if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
    for (const el of node.elements) {
      if (ts.isOmittedExpression(el)) continue;
      addBindingName(bound, el.name);
    }
    return;
  }
  if (ts.isAssignmentPattern(node)) { addBindingName(bound, node.left); return; }
  if (ts.isRestElement(node)) { addBindingName(bound, node.name); return; }
  // TS 类型注解等，忽略
}

/** 收集文件内所有绑定名（扁平、不做作用域隔离） */
function collectBindings(sf) {
  const bound = new Set();

  // 关键：ts.forEachChild 默认不进入函数体（Body 是独立子节点），
  // 必须显式递归进去，否则函数体内的形参解构/const 全部漏收。
  // 注意：class 没有 .body 属性（成员是它的直接子节点），不能被这个 early-return 拦掉。
  function enterBody(fn) {
    if (fn.body) {
      ts.forEachChild(fn, (c) => { if (c !== fn.body) visit(c); });
      visit(fn.body);
      return;
    }
    // class：成员（Constructor / MethodDeclaration / PropertyDeclaration）都是直接子节点
    ts.forEachChild(fn, visit);
  }

  function visit(node) {
    // import x from / import { a, b as c } / import * as ns
    if (ts.isImportDeclaration(node)) {
      const c = node.importClause;
      if (c) {
        if (c.name) bound.add(c.name.text);
        if (c.namedBindings) {
          if (ts.isNamespaceImport(c.namedBindings)) bound.add(c.namedBindings.name.text);
          else for (const el of c.namedBindings.elements) bound.add(el.name.text);
        }
      }
      return ts.forEachChild(node, visit);
    }

    // import('x') / require('x')
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      return ts.forEachChild(node, visit);
    }

    // 变量声明
    if (ts.isVariableDeclaration(node)) { addBindingName(bound, node.name); return ts.forEachChild(node, visit); }

    // 形参：function f(a, {b}, c = 1, ...rest) / 箭头 (x) =>
    // 关键：形参是函数的直接子节点，但若不在此处收集，
    // 解构出的名字会一路漏到文件末尾 —— 表现为「引用了但从未声明」
    if (ts.isParameter(node)) { addBindingName(bound, node.name); return undefined; }

    // 函数 / 类声明名
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
      if (node.name) bound.add(node.name.text);
      enterBody(node);
      return undefined;
    }

    // 函数表达式 / 箭头函数 / 方法 / 构造器 / getter / setter：收集形参
    if (ts.isFunctionExpression(node) || ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) ||
        ts.isFunctionDeclaration(node)) {
      for (const p of node.parameters) addBindingName(bound, p.name);
      if (node.name && node.name.text) bound.add(node.name.text);
      enterBody(node);
      return undefined;
    }

    // catch (e)
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      addBindingName(bound, node.variableDeclaration.name);
      if (node.block) visit(node.block);
      return undefined;
    }

    // enum / namespace
    if (ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) {
      if (node.name) bound.add(node.name.text);
      return ts.forEachChild(node, visit);
    }

    // JSX 内部自身处理（不把标签名/属性名当引用）
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
      return ts.forEachChild(node, visit);
    }

    // 其余函数型节点（IIFE 包裹等）：必须进入 body
    if (ts.isFunctionLike(node) && node.body) {
      enterBody(node);
      return undefined;
    }

    return ts.forEachChild(node, visit);
  }

  ts.forEachChild(sf, visit);
  return bound;
}

/** 收集被引用的裸标识符 */
function collectReferences(sf) {
  const refs = new Map();

  function add(name) {
    if (!name || GLOBALS.has(name)) return;
    refs.set(name, (refs.get(name) || 0) + 1);
  }

  function visit(node, parent) {
    // 排除属性访问：foo.bar 只认 foo，bar 是成员名不是标识符
    if (ts.isPropertyAccessExpression(node)) {
      visit(node.expression, node);                // 只深入 obj，不加 name
      return;
    }
    if (ts.isElementAccessExpression(node)) {
      visit(node.expression, node);
      if (node.argumentExpression) visit(node.argumentExpression, node);
      return;
    }
    if (ts.isPropertyAssignment(node)) {
      ts.forEachChild(node.initializer, (c) => visit(c, node)); // 只认 value，不认 key
      return;
    }
    if (ts.isShorthandPropertyAssignment(node)) { add(node.name.text); return; }
    if (ts.isJsxAttribute(node)) {
      if (node.initializer) ts.forEachChild(node.initializer, (c) => visit(c, node));
      return;
    }
    if (ts.isQualifiedName(node)) {
      ts.forEachChild(node.left, (c) => visit(c, node));
      return;
    }

    // JSX：标签文本（div/span/button 等 HTML 标签）不是标识符引用；
    // 只有大写开头的自定义组件才是。只深入 attributes 的表达式与 children。
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
      const opening = node.openingElement || node;
      const tagName = opening.tagName;
      if (tagName) {
        if (ts.isIdentifier(tagName) && /^[A-Z]/.test(tagName.text)) add(tagName.text);
        else if (ts.isPropertyAccessExpression(tagName)) {
          const base = tagName.expression;
          if (ts.isIdentifier(base) && /^[A-Z]/.test(base.text)) add(base.text);
        }
      }
      if (opening.attributes) {
        for (const attr of opening.attributes.properties) {
          if (ts.isJsxAttribute(attr) && attr.initializer) {
            ts.forEachChild(attr.initializer, (c) => visit(c, attr));
          } else if (ts.isJsxSpreadAttribute(attr)) {
            ts.forEachChild(attr.expression, (c) => visit(c, attr));
          }
        }
      }
      if (node.children) {
        for (const child of node.children) visit(child, node);
      }
      return;
    }
    if (ts.isJsxText(node)) { return; }
    if (ts.isJsxExpression(node)) {
      // 关键：必须整体 visit(expression)，不能用 forEachChild 逐个子节点 ——
      // 后者会把 PropertyAccessExpression 的成员名（col.label 的 label）也当引用。
      if (node.expression) visit(node.expression, node);
      return;
    }
    // JSX 属性：name（label / onClick 等）不是标识符引用，只看 initializer
    if (ts.isJsxAttribute(node)) {
      if (node.initializer) visit(node.initializer, node);
      return;
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxClosingElement(node)) { return; }

    if (ts.isIdentifier(node)) {
      // 声明位标识符（变量名/形参/属性名等）不是引用
      const p = parent;
      const isDeclName =
        p && (ts.isVariableDeclaration(p) || ts.isFunctionDeclaration(p) ||
              ts.isClassDeclaration(p) || ts.isParameter(p) ||
              ts.isBindingElement(p) || ts.isImportSpecifier(p) ||
              ts.isImportClause(p) || ts.isPropertyAssignment(p) ||
              ts.isEnumMember(p) || ts.isMethodDeclaration(p) ||
              ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) ||
              ts.isFunctionExpression(p) || ts.isArrowFunction(p));
      if (!isDeclName) add(node.text);
      return;
    }

    // catch (err) {} —— block 是独立节点，须显式进入
    if (ts.isCatchClause(node)) {
      if (node.variableDeclaration) visit(node.variableDeclaration, node);
      if (node.block) visit(node.block, node);
      return;
    }

    // 关键：ts.forEachChild 默认不进入函数体，须显式递归，否则回调内的引用全漏
    if (ts.isFunctionLike(node) && node.body) {
      ts.forEachChild(node, (c) => { if (c !== node.body) visit(c, node); });
      visit(node.body, node);
      return;
    }

    ts.forEachChild(node, (c) => visit(c, node));
  }

  ts.forEachChild(sf, (n) => visit(n, sf));
  return refs;
}

function analyzeCode(code, label) {
  const sf = ts.createSourceFile(label || 't.jsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
  const diagnostics = sf.parseDiagnostics || [];
  if (diagnostics.length) {
    const first = diagnostics[0];
    const pos = sf.getLineAndCharacterOfPosition(first.start);
    throw new Error(`语法错误（第 ${pos.line + 1} 行）：${ts.flattenDiagnosticMessageText(first.messageText, ' ')}`);
  }
  const bound = collectBindings(sf);
  const refs = collectReferences(sf);
  const missing = [];
  for (const name of refs.keys()) if (!bound.has(name)) missing.push(name);
  return missing;
}

function analyzeFile(rel) {
  return analyzeCode(fs.readFileSync(path.join(SRC, rel), 'utf8'), rel);
}

// ── P1 新门禁：hook 依赖数组 TDZ ──
// 真实事故（用户真机启动即白屏）：
//   App.jsx 的 useEffect 依赖数组 [selectedModel, activeProject] 同步求值，
//   但 activeProject 的 const 声明在该 effect 之后 → 组件函数体执行到依赖数组即
//   「Cannot access 'activeProject' before initialization」，界面直接崩。
// 为何既有体系全部漏掉：语法正确（undef-ident 的单文件扁平绑定集认为"已声明"）；
// smoke-load 不执行组件函数；tsc 不覆盖 .jsx。这是「白屏类」事故的新形态。
// 规则：依赖数组在渲染时同步求值，引用文件中后置声明的 const/let 即 TDZ。
// 只查 useEffect/useMemo/useCallback 等的最后一个数组实参（依赖数组），
// 成员访问取最左标识符（thread?.id → thread），字面量/调用不深挖（防误报）。
const DEPS_HOOKS = new Set(['useEffect', 'useLayoutEffect', 'useMemo', 'useCallback', 'useInsertionEffect', 'useImperativeHandle']);

function collectTdzViolations(code, label = 't.jsx') {
  const sf = ts.createSourceFile(label, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
  if (sf.parseDiagnostics && sf.parseDiagnostics.length) return []; // 语法错误由上方既有门禁负责
  const declPos = new Map(); // name → 首次「视为已声明」的绝对位置
  const visitDecl = (node) => {
    if (ts.isVariableDeclaration(node)) {
      // 解构声明也要收：const [a, setA] = useState() 是 ArrayBindingPattern，
      // 真实事故的 activeProject 正是这种形态（漏收解构 = 漏报 TDZ）
      const pos = node.name.getStart(sf);
      const addName = (n) => {
        if (ts.isIdentifier(n)) { if (!declPos.has(n.text)) declPos.set(n.text, pos); return; }
        if (ts.isObjectBindingPattern(n) || ts.isArrayBindingPattern(n)) {
          for (const el of n.elements) { if (!ts.isOmittedExpression(el)) addName(el.name); }
          return;
        }
        if (ts.isAssignmentPattern(n)) { addName(n.left); return; }
        if (ts.isRestElement(n)) { addName(n.name); return; }
      };
      addName(node.name);
    }
    // 2026-10-18（修假阳性）：**形参 / 函数声明 / import 绑定**同样属于「已声明」。
    // 误报实例（真机代码）：`function useProbedWindows(open)` 的形参 open 在依赖数组里使用，
    // 扫描器只认 const/let，于是匹配到另一个作用域的 `const [open, setOpen] = useState(false)`
    // （位置在后）→ 误判成 TDZ。形参/函数声明/import 都在作用域开头即已绑定（函数声明还提升），
    // 不存在「引用后置声明」的形态，必须纳入声明集。
    // 注意 declPos 是「首次出现即定」，所以同名的形参与后置 const 并存时取形参位置（更早）→ 不误报。
    const markName = (id, pos) => {
      if (id && ts.isIdentifier(id) && !declPos.has(id.text)) declPos.set(id.text, pos);
    };
    // HOISTED = -1 哨兵：函数声明与 import 绑定**会被提升**，出现在依赖数组之后也合法。
    // 参数也一样——形参只能在函数体内被引用，而函数体必然在形参之后，不存在「引用在后」的形态。
    const HOISTED = -1;
    if (ts.isParameter(node)) {
      const pos = HOISTED;
      const addParam = (n) => {
        if (!n) return;
        if (ts.isIdentifier(n)) { markName(n, pos); return; }
        if (ts.isObjectBindingPattern(n) || ts.isArrayBindingPattern(n)) {
          for (const el of n.elements) { if (!ts.isOmittedExpression(el)) addParam(el.name); }
          return;
        }
        if (ts.isAssignmentPattern(n)) { addParam(n.left); return; }
        if (ts.isRestElement(n)) { addParam(n.name); return; }
      };
      addParam(node.name);
    }
    // 函数声明提升；class 声明**不**提升（`new X()` 在 class 前是真实 TDZ），故 class 仍按位置判
    if (ts.isFunctionDeclaration(node) && node.name) {
      markName(node.name, HOISTED);
    } else if (ts.isClassDeclaration(node) && node.name) {
      markName(node.name, node.name.getStart(sf));
    }
    if (ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isNamespaceImport(node)) {
      const local = node.name || node.propertyName;
      if (local) markName(local, HOISTED);
    }
    ts.forEachChild(node, visitDecl);
  };
  visitDecl(sf);

  const violations = [];
  const addIfLate = (id) => {
    const dp = declPos.get(id.text);
    if (dp !== undefined && dp !== -1 && dp > id.getStart(sf)) {
      const line = sf.getLineAndCharacterOfPosition(id.getStart(sf)).line + 1;
      violations.push(`${id.text}（依赖数组第 ${line} 行，声明在其后）`);
    }
  };
  // 依赖数组元素 → 裸标识符：成员访问取最左（a.b.c → a），括号/展开递归
  const identsOf = (node) => {
    const out = [];
    const walk = (n) => {
      if (ts.isIdentifier(n)) { out.push(n); return; }
      if (ts.isPropertyAccessExpression(n)) { walk(n.expression); return; }
      if (ts.isElementAccessExpression(n)) { walk(n.expression); if (n.argumentExpression) walk(n.argumentExpression); return; }
      if (ts.isParenthesizedExpression(n)) { walk(n.expression); return; }
      // 字面量 / 调用等不深挖：依赖数组内出现调用的场景极罕见，深挖易误报
    };
    walk(node);
    return out;
  };
  const visitCall = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && DEPS_HOOKS.has(node.expression.text)) {
      const args = node.arguments;
      const last = args[args.length - 1];
      if (last && ts.isArrayLiteralExpression(last)) {
        for (const el of last.elements) {
          const target = ts.isSpreadElement(el) ? el.expression : el;
          for (const id of identsOf(target)) addIfLate(id);
        }
      }
    }
    ts.forEachChild(node, visitCall);
  };
  visitCall(sf);
  return violations;
}

// ── 新门禁：组件作用域内跨作用域引用（"X is not defined"）──
// 真实事故（用户真机启动，报 "decomposing is not defined"）：
//   ChatArea.jsx 里 Composer 是独立 function 组件，但大任务拆分的
//   decomposing / plan / planReport / send / thread 都是 ChatArea 的局部状态，
//   af26f7b 把这段 JSX 插进了 Composer 体内 → 每次渲染 Composer 即 ReferenceError。
//   此前被 App 层的 TDZ 崩溃挡在前面（App 先崩，Composer 根本没渲染）。
// 为何扁平绑定集漏掉：decomposing 确实在第 51 行声明过——只不过在**另一个函数**里。
// 方法：真正的作用域链分析——模块作用域 + 逐层函数作用域，
//   引用位标识符必须在当前作用域链上可解析，否则即白屏风险。
// 取「函数级作用域」（let/const/var 全收进所在函数）而非块级：
//   只会放宽可见性（漏报），不会收紧（误报），保证零误报。
function isFnLike(n) {
  return ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n);
}

function collectScopeViolations(code, label = 't.jsx') {
  const sf = ts.createSourceFile(label, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
  if (sf.parseDiagnostics && sf.parseDiagnostics.length) return []; // 语法错误由既有门禁负责

  const mkScope = (parent) => ({ names: new Set(), parent });
  const resolve = (scope, name) => {
    for (let s = scope; s; s = s.parent) if (s.names.has(name)) return true;
    return false;
  };

  // 收集某容器内「属于本作用域」的声明（不下降进嵌套函数体/类体）
  const collectDecls = (container, scope) => {
    const visit = (n) => {
      // import：默认导入 / 命名空间 / 具名导入，全部属于本（模块）作用域
      if (ts.isImportDeclaration(n)) {
        const c = n.importClause;
        if (c) {
          if (c.name) scope.names.add(c.name.text);
          if (c.namedBindings) {
            if (ts.isNamespaceImport(c.namedBindings)) scope.names.add(c.namedBindings.name.text);
            else for (const el of c.namedBindings.elements) scope.names.add(el.name.text);
          }
        }
        return;
      }
      if (isFnLike(n)) {
        // 函数声明名 / 具名函数表达式名属于本作用域；函数体另开作用域，此处不进
        if ((ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)) && n.name) scope.names.add(n.name.text);
        return;
      }
      if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) {
        if (n.name) scope.names.add(n.name.text);
        return; // 方法/字段另开作用域
      }
      if (ts.isVariableDeclaration(n)) {
        addBindingName(scope.names, n.name);
        ts.forEachChild(n, visit); // 初始值里的箭头函数由 isFnLike 拦掉
        return;
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(container, visit);
  };

  const violations = [];
  const seen = new Set();
  const report = (id) => {
    const name = id.text;
    const line = sf.getLineAndCharacterOfPosition(id.getStart(sf)).line + 1;
    const sig = `${name}@${line}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    violations.push(`${name}（第 ${line} 行）`);
  };

  const walk = (node, scope, parent) => {
    // import 的名字是声明位不是引用位（ImportSpecifier 已由 collectDecls 收进作用域）
    if (ts.isImportDeclaration(node)) return;
    // 嵌套函数/方法：开新作用域
    if (isFnLike(node)) {
      const child = mkScope(scope);
      for (const p of node.parameters) addBindingName(child.names, p.name);
      if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name) child.names.add(node.name.text);
      for (const p of node.parameters) if (p.initializer) walk(p.initializer, child, p);
      if (node.body) { collectDecls(node.body, child); walk(node.body, child, node); }
      return;
    }
    if (ts.isCatchClause(node)) {
      const child = mkScope(scope);
      if (node.variableDeclaration) addBindingName(child.names, node.variableDeclaration.name);
      if (node.block) { collectDecls(node.block, child); walk(node.block, child, node); }
      return;
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      // 类体：方法由 isFnLike 处理；这里只需继续走（装饰器/heritage）
      ts.forEachChild(node, (c) => walk(c, scope, node));
      return;
    }

    if (ts.isPropertyAccessExpression(node)) { walk(node.expression, scope, node); return; }
    if (ts.isElementAccessExpression(node)) {
      walk(node.expression, scope, node);
      if (node.argumentExpression) walk(node.argumentExpression, scope, node);
      return;
    }
    if (ts.isPropertyAssignment(node)) {
      if (node.initializer) walk(node.initializer, scope, node); // 只认 value，不认 key
      return;
    }
    if (ts.isShorthandPropertyAssignment(node)) {
      if (!GLOBALS.has(node.name.text) && !resolve(scope, node.name.text)) report(node.name);
      return;
    }
    if (ts.isQualifiedName(node)) { walk(node.left, scope, node); return; }

    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
      const opening = node.openingElement || node;
      const tagName = opening.tagName;
      if (tagName) {
        if (ts.isIdentifier(tagName) && /^[A-Z]/.test(tagName.text)) {
          if (!resolve(scope, tagName.text)) report(tagName);
        } else if (ts.isPropertyAccessExpression(tagName)) {
          let base = tagName.expression;
          while (ts.isPropertyAccessExpression(base)) base = base.expression;
          if (ts.isIdentifier(base) && /^[A-Z]/.test(base.text) && !resolve(scope, base.text)) report(base);
        }
      }
      if (opening.attributes) {
        for (const attr of opening.attributes.properties) {
          if (ts.isJsxAttribute(attr) && attr.initializer) {
            ts.forEachChild(attr.initializer, (c) => walk(c, scope, attr));
          } else if (ts.isJsxSpreadAttribute(attr)) {
            walk(attr.expression, scope, attr);
          }
        }
      }
      if (node.children) for (const child of node.children) walk(child, scope, node);
      return;
    }
    if (ts.isJsxText(node)) return;
    if (ts.isJsxExpression(node)) { if (node.expression) walk(node.expression, scope, node); return; }
    if (ts.isJsxAttribute(node)) { if (node.initializer) walk(node.initializer, scope, node); return; }
    if (ts.isJsxOpeningElement(node) || ts.isJsxClosingElement(node)) return;

    if (ts.isIdentifier(node)) {
      const p = parent;
      const isDeclName = p && (ts.isVariableDeclaration(p) || ts.isFunctionDeclaration(p) ||
        ts.isClassDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p) ||
        ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isPropertyAssignment(p) ||
        ts.isEnumMember(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) ||
        ts.isPropertySignature(p) || ts.isFunctionExpression(p) || ts.isArrowFunction(p) ||
        ts.isNamespaceImport(p) || ts.isExportSpecifier(p));
      if (!isDeclName && !GLOBALS.has(node.text) && !resolve(scope, node.text)) report(node);
      return;
    }

    ts.forEachChild(node, (c) => walk(c, scope, node));
  };

  // 模块作用域：先收顶层声明（import / 顶层 const / 函数声明 / 类），
  // 函数声明与顶层 const 的相互引用不受书写顺序影响（提升 + 运行时调用顺序）
  const moduleScope = mkScope(null);
  collectDecls(sf, moduleScope);
  walk(sf, moduleScope, null);
  return violations;
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
  assert.ok(files.length > 10, `只扫到 ${files.length} 个文件，扫描范围可能不对`);
  console.log(`       扫描 ${files.length} 个 JSX 文件`);
});

check('门禁自检：干净代码零误报', () => {
  const fake = `
    import React, { useState, useEffect } from 'react';
    import Foo, { helper } from './Foo';
    export default function T({ title, embedded = false }) {
      const [a, setA] = useState(0);
      const obj = { alpha: 1, beta: 2 };
      const { gamma, delta: renamed = 3 } = obj;
      useEffect(() => { setA(1); }, []);
      function inner(v) { return v + a; }
      const arrow = (x) => x * 2;
      try { inner(a); } catch (err) { console.error(err.message); }
      for (const item of [1, 2]) { console.log(item); }
      return <div className="x" title={title} onClick={() => realFn(a, obj.alpha, renamed, gamma, arrow(1), helper())}><Foo />{realVar}<span>{embedded}</span></div>;
    }
    function realFn(...args) { return args.length; }
    const realVar = 1;
  `;
  const missing = analyzeCode(fake);
  assert.deepEqual(missing, [], `干净代码被误报：${missing}`);
});

check('门禁自检：能复现真实事故 ①（props 传旧名）', () => {
  const fake = `
    import React, { useState } from 'react';
    function ChatArea() {
      const [worktree, setWorktree] = useState(null);
      const switchMode = () => {};
      return <Composer onModeChange={onModeChange} worktreeInfo={worktreeInfo} />;
    }
    function Composer(props) { return null; }
    export default ChatArea;
  `;
  const missing = analyzeCode(fake);
  assert.ok(missing.includes('onModeChange'), `未能复现事故① onModeChange：${missing}`);
  assert.ok(missing.includes('worktreeInfo'), `未能复现事故① worktreeInfo：${missing}`);
});

check('门禁自检：能复现真实事故 ②（组件解构漏参数）', () => {
  // 真实事故形态：planMode 在父组件 ChatArea 里声明，传给内部组件 Composer，
  // 但 Composer 自己的解构参数漏了它 —— Composer 所在文件内从未声明该名字。
  // 注意：扁平绑定集是「单文件」的，所以此用例必须模拟「Composer 独占一个文件」。
  const fake = `
    import React from 'react';
    function Composer({ input, onPlanMode }) {
      function pickSlash(cmd) { if (cmd.key === '/plan') onPlanMode?.(); }
      return <div>{planMode ? 'on' : 'off'}{pickSlash}</div>;
    }
    export default Composer;
  `;
  const missing = analyzeCode(fake);
  assert.ok(missing.includes('planMode'), `未能复现事故② planMode：${missing}`);
});

check('门禁自检：class 组件不误报', () => {
  const fake = `
    import React from 'react';
    export default class ErrorBoundary extends React.Component {
      constructor(props) { super(props); this.state = { error: null }; }
      static getDerivedStateFromError(error) { return { error }; }
      componentDidCatch(error, info) { console.error('crash', error.message, info?.componentStack); }
      render() { if (this.state.error) { return <div>出错了</div>; } return this.props.children; }
    }
  `;
  const missing = analyzeCode(fake);
  assert.deepEqual(missing, [], `class 组件被误报：${missing}`);
});

check('门禁自检：能识别语法错误', () => {
  let threw = false;
  try { analyzeCode('const a = {;'); } catch (e) { threw = /语法错误/.test(e.message); }
  assert.ok(threw, '语法错误未被检出');
});

check('全部渲染层 JSX 无未定义标识符', () => {
  const problems = [];
  for (const f of files) {
    const missing = analyzeFile(f);
    if (missing.length) problems.push(`${f}\n         → ${missing.join(', ')}`);
  }
  assert.equal(problems.length, 0, `\n       ${problems.join('\n       ')}`);
});

check('门禁自检：依赖数组 TDZ 干净代码零误报', () => {
  const fake = `
    import React, { useState, useEffect, useMemo } from 'react';
    export default function T({ thread }) {
      const [a, setA] = useState(0);
      const derived = useMemo(() => a * 2, [a]);
      useEffect(() => { setA(derived); }, [derived]);
      useEffect(() => { console.log(thread?.id); }, [thread?.id]);
      useEffect(() => {}, []);
      const later = 1;
      useEffect(() => { console.log(later); }, [later]);
      return <div>{a}</div>;
    }
  `;
  assert.deepEqual(collectTdzViolations(fake), [], `干净代码被误报：${collectTdzViolations(fake)}`);
});

check('门禁自检：能复现依赖数组 TDZ 事故（activeProject before initialization）', () => {
  const fake = `
    import React, { useState, useEffect } from 'react';
    export default function App() {
      const [selectedModel, setSelectedModel] = useState(null);
      useEffect(() => { console.log(selectedModel, activeProject); }, [selectedModel, activeProject]);
      const [activeProject, setActiveProject] = useState(null);
      return <div />;
    }
  `;
  const v = collectTdzViolations(fake);
  assert.ok(v.some((s) => s.includes('activeProject')), `未能复现 TDZ 事故：${v}`);
  assert.ok(!v.some((s) => s.startsWith('selectedModel')), `误报 selectedModel：${v}`);
});

// ── 反向用例（team-lead 硬要求）：修完「不再误报」之后，「能抓到真问题」这一性质不得下降 ──
// 只证明不再误报是不够的——那是「把红灯改成绿灯」的严谨。
check('门禁自检（反向）：真实 TDZ 仍必须被判红', () => {
  const fake = `
    import React, { useEffect } from 'react';
    export default function C() {
      useEffect(() => { doThing(); }, [doThing]);
      const doThing = () => {};
      return <div />;
    }
  `;
  const v = collectTdzViolations(fake);
  assert.ok(v.some((s) => s.includes('doThing')), `真实 TDZ 被漏报（把门禁改哑了）：${JSON.stringify(v)}`);
});

check('门禁自检（反向）：形参 vs 外层同名 const 的跨作用域遮蔽不误报', () => {
  // 这条正是本轮误报的形态：内层形参 x 先被引用，外层 const x 声明在文件更后面。
  // 若扫描器不认形参，就会匹配到后置 const 而判红。
  const fake = `
    import React, { useEffect } from 'react';
    function Inner({ x }) {
      useEffect(() => { console.log(x); }, [x]);
      return <div>{x}</div>;
    }
    export default function Outer() {
      const x = 1;
      return <Inner x={x} />;
    }
  `;
  const v = collectTdzViolations(fake);
  assert.deepEqual(v, [], `跨作用域遮蔽被误报：${JSON.stringify(v)}`);
});

check('门禁自检（反向）：函数声明提升与 import 绑定不误报', () => {
  const fake = `
    import React, { useEffect } from 'react';
    import { helper } from './helper';
    export default function D() {
      useEffect(() => { helper(compute()); }, [helper, compute]);
      return <div />;
    }
    function compute() { return 1; }
  `;
  const v = collectTdzViolations(fake);
  assert.deepEqual(v, [], `函数声明/import 绑定被误报：${JSON.stringify(v)}`);
});

check('hook 依赖数组无 TDZ 风险（引用后置声明的 const/let）', () => {
  const problems = [];
  for (const f of files) {
    const v = collectTdzViolations(fs.readFileSync(path.join(SRC, f), 'utf8'), f);
    if (v.length) problems.push(`${f} → ${v.join(', ')}`);
  }
  assert.equal(problems.length, 0, `\n       ${problems.join('\n       ')}`);
});

check('门禁自检：作用域分析干净代码零误报', () => {
  const fake = `
    import React, { useState, useEffect } from 'react';
    import IconX, { helper } from './icons';
    const OUTER = 1;
    export default function Parent({ title }) {
      const [a, setA] = useState(0);
      const { b, c: renamed } = { b: 2, c: 3 };
      useEffect(() => { setA(1); }, [a]);
      const arrow = (x) => x + a + OUTER;
      function inner(v) { return v + b; }
      try { inner(a); } catch (err) { console.error(err.message); }
      return <div title={title} onClick={() => helper(arrow(1), renamed)}><IconX /><Child v={a} /></div>;
    }
    function Child({ v }) { return <span>{v}{OUTER}</span>; }
  `;
  const v = collectScopeViolations(fake);
  assert.deepEqual(v, [], `干净代码被误报：${v}`);
});

check('门禁自检：能复现跨作用域事故（decomposing is not defined）', () => {
  const fake = `
    import React, { useState } from 'react';
    export default function ChatArea() {
      const [decomposing, setDecomposing] = useState(false);
      const [plan, setPlan] = useState(null);
      return <Composer input="" />;
    }
    function Composer({ input }) {
      return <div>{decomposing && <span>分析中</span>}{plan && <span>{plan.tasks.length}</span>}</div>;
    }
  `;
  const v = collectScopeViolations(fake);
  assert.ok(v.some((s) => s.startsWith('decomposing')), `未能复现 decomposing：${v}`);
  assert.ok(v.some((s) => s.startsWith('plan')), `未能复现 plan：${v}`);
  assert.ok(!v.some((s) => s.startsWith('input')), `误报形参 input：${v}`);
});

check('组件作用域内无跨作用域未定义引用（X is not defined）', () => {
  const problems = [];
  for (const f of files) {
    const v = collectScopeViolations(fs.readFileSync(path.join(SRC, f), 'utf8'), f);
    if (v.length) problems.push(`${f}\n         → ${v.join(', ')}`);
  }
  assert.equal(problems.length, 0, `\n       ${problems.join('\n       ')}`);
});

console.log(`\nPASS：${pass}/${total} 项通过`);