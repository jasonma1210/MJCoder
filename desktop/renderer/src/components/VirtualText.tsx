// T3-1：大文本虚拟滚动——10MB 构建日志这类输出不再整段塞进 <pre>。
// 背景：OutputBlock「展开完整输出」把全文渲染成单个文本节点，几十万行 DOM 直接冻结渲染进程。
// 策略：固定行高窗口化渲染——只渲染视口 ±overscan 行，行内容单行截断（日志查看
// 走横向滚动，不做自动换行；换行会让固定行高假设失效）。零依赖自研（渲染层纪律）。
// 小文本（<500 行）走普通渲染，避免虚拟化的额外复杂度无收益。
import { useMemo, useRef, useState } from 'react';

const LINE_H = 18; // 与 text-code（12px/18px）行高严格一致，虚拟滚动按此计算
const OVERSCAN = 20; // 视口上下各多渲染的缓冲行数
const VIRTUAL_MIN_LINES = 500; // 低于此行数不值得虚拟化

export default function VirtualText({
  text,
  className = '',
  height = 320,
}: {
  text: string;
  className?: string;
  height?: number;
}) {
  const lines = useMemo(() => text.split('\n'), [text]);
  const [scrollTop, setScrollTop] = useState(0);
  const rafRef = useRef(0);

  if (lines.length < VIRTUAL_MIN_LINES) {
    // 小内容：原样渲染（保留调用方的换行样式类）
    return <pre className={className}>{text}</pre>;
  }

  const start = Math.max(0, Math.floor(scrollTop / LINE_H) - OVERSCAN);
  const visibleCount = Math.ceil(height / LINE_H) + OVERSCAN * 2;
  const end = Math.min(lines.length, start + visibleCount);
  const totalH = lines.length * LINE_H;

  return (
    <div
      className={`overflow-y-auto overflow-x-auto ${className}`}
      style={{ height }}
      onScroll={(e) => {
        const el = e.currentTarget;
        // rAF 节流：滚动事件高频，窗口重算每帧至多一次
        if (rafRef.current) return;
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = 0;
          setScrollTop(el.scrollTop);
        });
      }}
    >
      <div style={{ height: totalH, position: 'relative' }}>
        <div style={{ position: 'absolute', top: start * LINE_H, left: 0, right: 0 }}>
          {lines.slice(start, end).map((l, i) => (
            <div
              key={start + i}
              className="whitespace-pre font-mono text-code"
              style={{ height: LINE_H, lineHeight: `${LINE_H}px` }}
            >
              {l || ' '}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
