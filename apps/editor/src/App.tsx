import { useMemo } from 'react';
import { SemanticRegistry } from '@world/core';

/** Phase B 脚手架壳：证明三包链路可用；工作台 UI 由 #8–#12 逐票充实。 */
export default function App() {
  const registry = useMemo(() => {
    const r = new SemanticRegistry();
    r.register({ semantic: 'elevation', dataType: { family: 'field', field: 'scalar' } });
    return r;
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', margin: 16, display: 'grid', gap: 12 }}>
      <h1 style={{ fontSize: 18, margin: 0 }}>World Authoring Engine — Workbench</h1>
      <p style={{ margin: 0, color: '#555' }}>
        脚手架就绪（#7）。已注册 semantic：{registry.list().map((d) => d.semantic).join(', ') || '（无）'}
      </p>
      <canvas width={640} height={400} style={{ border: '1px solid #ccc', background: '#fafafa' }} />
    </main>
  );
}
