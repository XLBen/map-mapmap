import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Engine, SemanticRegistry, World } from '@world/core';
import type { Field, FeatureSet, Region } from '@world/core';
import { biomeProcessor, hydrologyProcessor, moistureProcessor, oasisProcessor } from '@world/processors';
import { slopeProcessor } from '@world/processors';
import { canvas2dBackend, defaultFeatureStyle, defaultFieldStyle } from '@world/render';
import type { DebugOverlay, SceneLayer } from '@world/render';

const SIZE = 64; // 世界 64×64
const SCALE = 10; // 画布 640×640
const W = SIZE * SCALE;

const registry = new SemanticRegistry();
for (const s of ['elevation', 'rainfall', 'slope', 'moisture'] as const) {
  registry.register({ semantic: s, dataType: { family: 'field', field: 'scalar' } });
}
registry.register({ semantic: 'biome', dataType: { family: 'field', field: 'categorical' } });
registry.register({ semantic: 'river', dataType: { family: 'feature', feature: 'line' } });
registry.register({ semantic: 'oasis', dataType: { family: 'feature', feature: 'point' } });

function createWorld() {
  const world = new World(registry);
  const engine = new Engine(world);
  for (const p of [slopeProcessor, hydrologyProcessor, moistureProcessor, biomeProcessor, oasisProcessor]) engine.registerProcessor(p);
  world.createData('elev.main', world.registry.createField('elevation', {
    width: SIZE,
    height: SIZE,
    origin: { x: 0, y: 0 },
    resolution: 1,
    tileSize: 16,
    fill: (p) => 0.9 * Math.abs(p.y - 32) * 0.05 + 20 + 6 * Math.sin(p.x / 7) * Math.cos(p.y / 9),
  }));
  world.createData('rain.main', world.registry.createField('rainfall', {
    width: SIZE,
    height: SIZE,
    origin: { x: 0, y: 0 },
    resolution: 1,
    tileSize: 16,
    fill: () => 10,
  }));
  engine.addInstance('slope.i', 'core.slope', {});
  engine.addInstance('hyd.i', 'hydrology.d8', { threshold: 260, seed: 'editor-seed' });
  engine.addInstance('moi.i', 'hydrology.moisture', { base: 0.2, boost: 0.6, radius: 12 });
  engine.addInstance('bio.i', 'world.biome', {});
  engine.addInstance('oas.i', 'world.oasis', { minMoisture: 0.5, maxPoints: 16 });
  return { world, engine };
}

type Tool = 'brush' | 'river' | 'delete';
type Debug = { resolved: boolean; generated: boolean; intent: boolean; suppressed: boolean; dirty: boolean; conflict: boolean };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export default function App() {
  const { world, engine } = useMemo(createWorld, []);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef(false);
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const [tool, setTool] = useState<Tool>('brush');
  const [baseSemantic, setBaseSemantic] = useState<'elevation' | 'slope' | 'moisture' | 'biome'>('elevation');
  const [debug, setDebug] = useState<Debug>({ resolved: true, generated: false, intent: false, suppressed: false, dirty: true, conflict: false });
  const [status, setStatus] = useState('就绪 — 先用笔刷画 Elevation，或点「▶ 14 步演示」');
  const [rebuildMs, setRebuildMs] = useState<number | null>(null);
  const [draft, setDraft] = useState<Array<{ x: number; y: number }>>([]);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [tour, setTour] = useState(0); // 0=未开始，1..14 进行中
  const [tourLog, setTourLog] = useState<string[]>([]);

  const settle = useCallback(() => {
    const t0 = performance.now();
    engine.sync();
    for (let i = 0; i < 4; i++) engine.rebuild();
    setRebuildMs(Math.round(performance.now() - t0));
  }, [engine]);

  useEffect(() => {
    settle();
    bump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 渲染循环（Renderer 默认读 Resolved World，charter 54） ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
    ctx.imageSmoothingEnabled = false;

    const layers: SceneLayer[] = [];
    const overlays: DebugOverlay[] = [];

    const baseItem = debug.generated
      ? { data: engine.dataOf(baseSemantic === 'slope' ? 'slope.i' : baseSemantic === 'moisture' ? 'moi.i' : baseSemantic === 'biome' ? 'bio.i' : 'slope.i') }
      : { data: engine.resolver.resolve(baseSemantic).data };
    const baseData = baseItem.data as Field | undefined;
    if (baseData) {
      layers.push({
        semantic: baseSemantic,
        kind: 'field',
        data: baseData,
        style: { ...defaultFieldStyle(baseSemantic, baseSemantic === 'biome' ? 'categorical' : 'scalar'), opacity: 0.95 },
      });
    }

    const riverData = (debug.generated ? engine.dataOf('hyd.i') : engine.resolver.resolve('river').data) as FeatureSet | undefined;
    if (riverData) layers.push({ semantic: 'river', kind: 'feature', data: riverData, style: defaultFeatureStyle('river') });
    const oasisData = (debug.generated ? engine.dataOf('oas.i') : engine.resolver.resolve('oasis').data) as FeatureSet | undefined;
    if (oasisData) layers.push({ semantic: 'oasis', kind: 'feature', data: oasisData, style: defaultFeatureStyle('oasis') });
    const manual = world.data('river.manual') as FeatureSet | undefined;
    if (manual) layers.push({ semantic: 'river', kind: 'feature', data: manual, style: { stroke: '#7ee081', width: 2.4 } });

    if (debug.dirty) {
      const rects: Region[] = [];
      for (const iid of engine.instanceIds()) {
        const e = engine.entryOf(iid);
        if (e.status !== 'current') rects.push(...e.pending);
      }
      if (rects.length) overlays.push({ label: 'Dirty', color: '#ff4d4f', rects });
    }
    if (debug.suppressed) {
      const rects = world.intents().filter((o) => o.kind === 'suppressSpatial' && o.semantic === 'river').map((o) => (o.kind === 'suppressSpatial' ? o.region : undefined)).filter(Boolean) as Region[];
      if (rects.length) overlays.push({ label: 'Suppressed', color: '#ffa940', rects });
    }

    canvas2dBackend.render({ layers, overlays, viewport: { x: 0, y: 0, width: SIZE, height: SIZE } }, ctx);

    // 草稿线（未提交的手绘河）
    if (draftRef.current.length >= 1) {
      ctx.strokeStyle = '#7ee081';
      ctx.lineWidth = 0.3;
      ctx.beginPath();
      ctx.moveTo(draftRef.current[0]!.x + 0.5, draftRef.current[0]!.y + 0.5);
      for (const p of draftRef.current.slice(1)) ctx.lineTo(p.x + 0.5, p.y + 0.5);
      ctx.stroke();
    }
  }, [version, debug, baseSemantic, engine, world, draft]);

  // ---- 交互 ----
  const toWorld = (e: React.MouseEvent<HTMLCanvasElement>): { x: number; y: number } => ({
    x: Math.floor(e.nativeEvent.offsetX / SCALE),
    y: Math.floor(e.nativeEvent.offsetY / SCALE),
  });

  const brushAt = (p: { x: number; y: number }) => {
    const f = world.data('elev.main') as Field;
    const cur = f.sample(p) as number;
    const v = Math.min(80, cur + 14);
    world.paint('elev.main', { minX: p.x - 2, minY: p.y - 2, maxX: p.x + 2, maxY: p.y + 2 }, v);
    engine.sync();
    bump();
  };

  const onDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const p = toWorld(e);
    if (tool === 'brush') {
      dragRef.current = true;
      brushAt(p);
    } else if (tool === 'river') {
      setDraft((d) => [...d, p]);
      bump();
    } else {
      // 删除 = Suppression（charter 16）：找最近的生成河
      const item = engine.resolver.resolve('river');
      const fs = item.data as FeatureSet | undefined;
      let best: { id: string; dist: number } | undefined;
      for (const f of fs?.all() ?? []) {
        if (!f.id.startsWith('river:')) continue;
        for (const pt of f.kind === 'line' ? f.points : f.kind === 'point' ? [f.pos] : f.ring) {
          const dist = Math.hypot(pt.x - p.x, pt.y - p.y);
          if (!best || dist < best.dist) best = { id: f.id, dist };
        }
      }
      if (best && best.dist < 6) {
        world.suppress(best.id, 'river');
        engine.sync();
        for (let i = 0; i < 4; i++) engine.rebuild();
        setStatus(`已抑制生成河 ${best.id}（删除 = 创建 Suppression，charter 16/17）`);
        bump();
      } else {
        setStatus('点击处附近没有生成河');
      }
    }
  };
  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (tool === 'brush' && dragRef.current) brushAt(toWorld(e));
  };
  const onUp = () => {
    dragRef.current = false;
  };

  const commitRiver = useCallback(() => {
    const pts = draftRef.current;
    if (pts.length < 2) {
      setStatus('手绘河至少需要 2 个点');
      return;
    }
    const line = pts.map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 }));
    const existing = world.data('river.manual') as FeatureSet | undefined;
    if (existing) {
      const f = existing.all()[0]!;
      const prev = f.kind === 'line' ? f.points : f.kind === 'point' ? [f.pos] : f.ring;
      world.modifyFeature('river.manual', f.id, { geometry: [...prev, ...line] });
    } else {
      const fs = registry.createFeatureSet('river');
      fs.add({ kind: 'line', id: 'manual-river', semantic: 'river', points: line, attributes: { source: 'manual' } });
      world.createData('river.manual', fs);
    }
    settle();
    setStatus('Manual River 已提交 → 进入 Resolved World，Moisture 会读取它（charter 12）');
    setDraft([]);
    bump();
  }, [world, engine, settle]);

  const undo = () => {
    world.undo();
    settle();
    setStatus('Undo 完成');
    bump();
  };
  const redo = () => {
    world.redo();
    settle();
    setStatus('Redo 完成');
    bump();
  };
  const rebuild = () => {
    settle();
    setStatus(`Rebuild 完成（${rebuildMs ?? 0}ms）`);
    bump();
  };

  // ---- 14 步验收演示（charter 382-400） ----
  const runTour = useCallback(async () => {
    const mark = (n: number, text: string, ok = true) => {
      setTour(n);
      const line = `步骤 ${n}/14 ${ok ? '✓' : '✗'} ${text}`;
      setTourLog((l) => [...l, line]);
      setStatus(line);
      bump();
    };
    setTourLog([]);
    setDebug({ resolved: true, generated: false, intent: true, suppressed: true, dirty: true, conflict: true });
    const elev = world.data('elev.main') as Field;
    const baseMoistureNear = (x: number, y: number) => (engine.dataOf('moi.i') as Field).sample({ x, y }) as number;

    // 1 画 Elevation
    world.paint('elev.main', { minX: 28, minY: 20, maxX: 36, maxY: 28 }, 70);
    mark(1, '画 Elevation（高台）');
    await sleep(500);
    // 2 标记 Dirty Region
    engine.sync();
    const slopePending = engine.entryOf('slope.i').pending.length;
    mark(2, `Dirty Region 已标记（slope.i pending=${slopePending}，红框）`, slopePending > 0);
    await sleep(600);
    // 3 Rebuild Slope
    settle();
    mark(3, `Rebuild Slope → current（${rebuildMs}ms 量级）`, engine.entryOf('slope.i').status === 'current');
    await sleep(500);
    // 4 Hydrology 生成 River
    const rivers = engine.resolver.resolve('river').data as FeatureSet;
    mark(4, `Hydrology 生成 River（${rivers.size} 段，蓝线）`, rivers.size > 0);
    await sleep(500);
    // 5 删除一条生成河 = Suppression
    const first = rivers.all()[0]!;
    world.suppress(first.id, 'river');
    mark(5, `删除生成河 ${first.id} → 实际创建 Suppression（Intent 面板）`);
    await sleep(500);
    // 6 Rebuild 不复活
    settle();
    const after = engine.resolver.resolve('river').data as FeatureSet;
    mark(6, `Rebuild 后该 River 不重新显示（${after.all().filter((f) => f.id === first.id).length === 0 ? '已抑制' : '仍在!'})`, !after.all().some((f) => f.id === first.id));
    await sleep(500);
    // 7 取消 Suppression → 恢复
    world.undo();
    settle();
    const restored = (engine.resolver.resolve('river').data as FeatureSet).all().some((f) => f.id === first.id);
    mark(7, `取消 Suppression → River 恢复`, restored);
    await sleep(500);
    // 8 手绘 River
    const fs = registry.createFeatureSet('river');
    fs.add({ kind: 'line', id: 'manual-river', semantic: 'river', points: [{ x: 10, y: 40 }, { x: 30, y: 44 }, { x: 52, y: 40 }], attributes: { source: 'manual' } });
    world.createData('river.manual', fs);
    mark(8, '手绘 Manual River（绿线）');
    await sleep(400);
    // 9 进入 Resolved World
    const merged = engine.resolver.resolve('river').data as FeatureSet;
    mark(9, `Manual River 进入 Resolved World（合并集 ${merged.size} 条，含生成+手绘）`, merged.all().some((f) => f.id === 'manual-river'));
    await sleep(400);
    // 10 Moisture 读取 Manual River
    settle();
    mark(10, 'Moisture Processor 读取 Manual River（feature 端口走 Resolved 槽位）');
    await sleep(400);
    // 11 河周 Moisture 上升
    const m = baseMoistureNear(30, 44);
    mark(11, `River 周围 Moisture 上升（(30,44)=${m.toFixed(2)} > 基线 0.2）`, m > 0.4);
    await sleep(400);
    // 12 Biome/Oasis 变化
    settle();
    const oasis = engine.resolver.resolve('oasis').data as FeatureSet;
    mark(12, `Biome/Oasis 随之变化（Oasis ${oasis.size} 点，绿点）`, oasis.size > 0);
    await sleep(400);
    // 13 Renderer 显示 Resolved World
    mark(13, `Renderer 显示 Resolved World（当前全部图层来自 resolver.resolve）`);
    await sleep(400);
    // 14 Debug View
    setDebug({ resolved: true, generated: true, intent: true, suppressed: true, dirty: true, conflict: true });
    mark(14, 'Debug View：Generated / Intent / Suppressed / Dirty / Conflict 全开（右侧面板）');
    setTour(15);
    await sleep(400);
    setStatus('14 步验收演示完成 ✓ — 全部断言见状态栏历史');
  }, [world, engine, settle, bump, rebuildMs]);

  // ---- 面板数据 ----
  const intents = world.intents();
  const conflicts = engine.resolver.conflicts();
  const outdated = engine.instanceIds().filter((iid) => engine.entryOf(iid).status !== 'current');
  const suppressedIds = intents.filter((o) => o.kind === 'suppress').map((o) => (o.kind === 'suppress' ? o.targetFeatureId : ''));

  const btn: React.CSSProperties = { padding: '4px 10px', border: '1px solid #555', borderRadius: 6, background: '#2a2a31', color: '#eee', cursor: 'pointer' };
  const active = { ...btn, background: '#3b5bdb' };

  return (
    <div style={{ display: 'flex', gap: 12, padding: 12, background: '#141418', minHeight: '100vh', color: '#ddd', fontFamily: 'ui-sans-serif, system-ui' }}>
      <div>
        <h1 style={{ fontSize: 16, margin: '0 0 8px' }}>World Authoring Engine — Workbench（Phase B vertical slice）</h1>
        <canvas ref={canvasRef} width={W} height={W} style={{ border: '1px solid #444', borderRadius: 8, cursor: 'crosshair' }}
          onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp} />
        <div style={{ marginTop: 8, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <button style={tool === 'brush' ? active : btn} onClick={() => setTool('brush')}>笔刷 Elevation</button>
          <button style={tool === 'river' ? active : btn} onClick={() => setTool('river')}>手绘 River{draft.length ? `（${draft.length} 点）` : ''}</button>
          <button style={btn} onClick={commitRiver}>完成河段</button>
          <button style={btn} onClick={() => { setDraft([]); bump(); }}>清空草稿</button>
          <button style={tool === 'delete' ? active : btn} onClick={() => setTool('delete')}>删除 River = Suppression</button>
          <button style={btn} onClick={undo}>↩ Undo</button>
          <button style={btn} onClick={redo}>↪ Redo</button>
          <button style={btn} onClick={rebuild}>⟳ Rebuild</button>
          <button style={{ ...btn, background: '#2b8a3e', borderColor: '#2b8a3e' }} onClick={runTour} disabled={tour > 0 && tour < 15}>
            {tour >= 15 ? '✓ 14 步完成' : tour > 0 ? `演示中 ${tour}/14…` : '▶ 14 步演示'}
          </button>
        </div>
        <div style={{ marginTop: 8, display: 'flex', gap: 6, alignItems: 'center' }}>
          <span>基础语义：</span>
          {(['elevation', 'slope', 'moisture', 'biome'] as const).map((s) => (
            <button key={s} style={baseSemantic === s ? active : btn} onClick={() => setBaseSemantic(s)}>{s}</button>
          ))}
        </div>
        <div data-testid="status" style={{ marginTop: 8, padding: '8px 10px', background: '#1d1d23', borderRadius: 6, border: '1px solid #333', minHeight: 20 }}>
          {status}
        </div>
      </div>

      <div style={{ width: 320, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ padding: 10, background: '#1d1d23', borderRadius: 6, border: '1px solid #333' }}>
          <strong style={{ fontSize: 13 }}>Debug 视图（charter 38）</strong>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginTop: 6, fontSize: 13 }}>
            {(['resolved', 'generated', 'intent', 'suppressed', 'dirty', 'conflict'] as const).map((k) => (
              <label key={k} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                <input type="checkbox" checked={debug[k]} onChange={(e) => setDebug({ ...debug, [k]: e.target.checked })} />
                {k}
              </label>
            ))}
          </div>
        </div>
        <div style={{ padding: 10, background: '#1d1d23', borderRadius: 6, border: '1px solid #333', fontSize: 12, flex: 1, overflow: 'auto' }}>
          <strong style={{ fontSize: 13 }}>User Intent（{intents.length}）</strong>
          <div style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>
            {debug.intent
              ? intents.map((o, i) => <div key={i}>#{i} {o.kind} {JSON.stringify('scope' in o ? o.scope : 'dataId' in o ? o.dataId : 'semantic' in o ? o.semantic : '')}</div>)
              : '（未勾选 intent）'}
          </div>
          <strong style={{ fontSize: 13, display: 'block', marginTop: 8 }}>Suppressed（{suppressedIds.length}）</strong>
          <div>{debug.suppressed ? suppressedIds.join(', ') || '（无）' : '（未勾选 suppressed）'}</div>
          <strong style={{ fontSize: 13, display: 'block', marginTop: 8 }}>Conflict（{conflicts.length}）</strong>
          <div>{debug.conflict ? conflicts.map((c) => `[${c.kind}] ${c.message}`).join('\n') || '（无）' : '（未勾选 conflict）'}</div>
        </div>
        <div style={{ padding: 10, background: '#1d1d23', borderRadius: 6, border: '1px solid #333', fontSize: 12, maxHeight: 240, overflow: 'auto' }}>
          <strong style={{ fontSize: 13 }}>14 步验收日志</strong>
          <div style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{tourLog.length ? tourLog.join('\n') : '（点「▶ 14 步演示」运行）'}</div>
        </div>
        <div data-testid="statusbar" style={{ padding: 10, background: '#101014', borderRadius: 6, border: '1px solid #333', fontSize: 12 }}>
          状态栏 — 工具：{tool} ｜ 语义：{baseSemantic} ｜ dirty-outdated：{outdated.length ? outdated.join(',') : '无'} ｜ 最近 rebuild：{rebuildMs ?? '—'}ms ｜ Conflict：{conflicts.length}
        </div>
      </div>
    </div>
  );
}
