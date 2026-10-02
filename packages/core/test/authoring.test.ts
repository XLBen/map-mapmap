import { describe, expect, test } from 'vitest';
import { FeatureSet } from '../src/feature';
import { SemanticRegistry } from '../src/registry';
import { World } from '../src/authoring';
import { dataFromJSON, dataToJSON } from '../src/serialize';
import type { LineFeature } from '../src/feature';

const registry = new SemanticRegistry();
registry.register({ semantic: 'elevation', dataType: { family: 'field', field: 'scalar' } });
registry.register({ semantic: 'route', dataType: { family: 'feature', feature: 'line' } });

function makeField() {
  return registry.createField('elevation', {
    width: 8,
    height: 8,
    origin: { x: 0, y: 0 },
    resolution: 10,
    tileSize: 4,
    fill: () => 0,
  });
}

const R = (a: number) => ({ minX: a, minY: a, maxX: a + 10, maxY: a + 10 });

describe('World：作者数据操作 + Undo/Redo（Q11）', () => {
  test('create → paint → undo 恢复 → redo 重放，标脏不倒推（charter 42）', () => {
    const w = new World(registry);
    w.createData('elev', makeField());
    w.paint('elev', R(10), 7);
    expect((w.data('elev') as never as { sample(p: unknown): number }).sample({ x: 15, y: 15 })).toBe(7);
    expect(w.dirty).toEqual(['elev']);
    expect(w.drainDirty()).toEqual(['elev']);
    expect(w.drainDirty()).toEqual([]);

    expect(w.undo()).toBeDefined();
    expect(w.dirty).toEqual(['elev']); // 撤销再次标脏
    const f = w.data('elev') as never as { sample(p: unknown): number };
    expect(f.sample({ x: 15, y: 15 })).toBe(0);

    expect(w.redo()).toBeDefined();
    expect((w.data('elev') as never as { sample(p: unknown): number }).sample({ x: 15, y: 15 })).toBe(7);
  });

  test('undo create 移除数据，redo 恢复；撤销到空栈返回 undefined', () => {
    const w = new World(registry);
    expect(w.undo()).toBeUndefined();
    const fs = registry.createFeatureSet('route');
    fs.add({ kind: 'line', id: 'r1', semantic: 'route', points: [{ x: 0, y: 0 }, { x: 30, y: 0 }], attributes: {} });
    w.createData('route.main', fs);
    expect(w.dataIds()).toEqual(['route.main']);
    w.undo();
    expect(w.data('route.main')).toBeUndefined();
    w.redo();
    expect((w.data('route.main') as FeatureSet).size).toBe(1);
  });

  test('modify 要素几何 → undo 恢复', () => {
    const w = new World(registry);
    const fs = registry.createFeatureSet('route');
    fs.add({ kind: 'line', id: 'r1', semantic: 'route', points: [{ x: 0, y: 0 }, { x: 30, y: 0 }], attributes: {} });
    w.createData('route.main', fs);
    w.modifyFeature('route.main', 'r1', { geometry: [{ x: 0, y: 0 }, { x: 50, y: 0 }], attributes: { level: 2 } });
    const line = (w.data('route.main') as FeatureSet).all()[0] as LineFeature;
    expect(line.points[1]).toEqual({ x: 50, y: 0 });
    expect(line.attributes).toEqual({ level: 2 });
    w.undo();
    const restored = (w.data('route.main') as FeatureSet).all()[0] as LineFeature;
    expect(restored.points[1]).toEqual({ x: 30, y: 0 });
    expect(restored.attributes).toEqual({});
  });
});

describe('World：意图操作（非破坏）+ removeIntent + latest-wins 顺序', () => {
  test('intents 有效集：removeIntent 语义删除；undo/redo 作用意图', () => {
    const w = new World(registry);
    w.createData('elev', makeField());
    const o1 = w.override({ dataId: 'elev', attribute: 'elevation', value: 42 });
    w.pin({ region: R(0) });
    w.suppress('gen-1', 'elevation');
    expect(w.intents().map((o) => o.kind)).toEqual(['override', 'pin', 'suppress']);

    w.removeIntent(o1);
    expect(w.intents().map((o) => o.kind)).toEqual(['pin', 'suppress']);
    expect(w.canUndo).toBe(true); // removeIntent 不进 undo 栈

    w.undo(); // 撤销的是 suppress
    expect(w.intents().map((o) => o.kind)).toEqual(['pin']);
    w.redo();
    expect(w.intents().map((o) => o.kind)).toEqual(['pin', 'suppress']);
  });

  test('同属性多次 override 保留完整历史与顺序（charter 52）', () => {
    const w = new World(registry);
    w.createData('elev', makeField());
    w.override({ dataId: 'elev', attribute: 'elevation', value: 1 });
    w.override({ dataId: 'elev', attribute: 'elevation', value: 2 });
    const ovs = w.intents().filter((o) => o.kind === 'override');
    expect(ovs).toHaveLength(2);
    expect((ovs[1] as { value: unknown }).value).toBe(2); // Resolver 取末项
  });
});

describe('World：History = op log + snapshot（charter 43）', () => {
  test('快照边界上的 undo/redo（手动快照 + 自动快照均覆盖）', () => {
    const w = new World(registry, { snapshotInterval: 3 }); // seq=3 时自动快照（含 A、B）
    w.createData('elev', makeField());
    w.paint('elev', R(0), 1); // A → cell(0,0)
    w.paint('elev', R(10), 2); // B → cell(1,1)；此处触发自动快照
    w.paint('elev', R(20), 3); // C → cell(2,2)
    const s = (id: number) => (w.data('elev') as never as { sample(p: unknown): number }).sample({ x: id * 10 + 5, y: id * 10 + 5 });
    expect([s(0), s(1), s(2)]).toEqual([1, 2, 3]);

    w.undo(); // 撤销 C：快照仍有效，重放跳过 C
    expect([s(0), s(1), s(2)]).toEqual([1, 2, 0]);
    w.undo(); // 撤销 B：含 B 的自动快照失效 → 从零重建
    expect([s(0), s(1), s(2)]).toEqual([1, 0, 0]);
    w.undo(); // 撤销 A
    expect([s(0), s(1), s(2)]).toEqual([0, 0, 0]);
    expect(w.data('elev')).toBeDefined(); // create 未被撤销

    w.redo();
    w.redo();
    w.redo();
    expect([s(0), s(1), s(2)]).toEqual([1, 2, 3]);
  });

  test('手动快照后新 apply 使 redo 失效（标准编辑器语义）', () => {
    const w = new World(registry);
    w.createData('elev', makeField());
    w.paint('elev', R(0), 1);
    w.undo();
    expect(w.canRedo).toBe(true);
    w.paint('elev', R(10), 2); // 新操作清空 redo 栈
    expect(w.canRedo).toBe(false);
  });

  test('log 完整可审计：标记也留痕（append-only，Q11）', () => {
    const w = new World(registry);
    w.createData('elev', makeField());
    w.paint('elev', R(0), 1);
    w.undo();
    const kinds = w.log.map((e) => e.op.kind);
    expect(kinds).toEqual(['create', 'paint', 'disable']);
  });
});

describe('World：守卫', () => {
  test('重复创建 / 目标类型不符 / 未知要素 / 非意图 removeIntent', () => {
    const w = new World(registry);
    const fs = registry.createFeatureSet('route');
    w.createData('elev', makeField());
    expect(() => w.createData('elev', makeField())).toThrow();
    expect(() => w.paint('route.x', R(0), 1)).toThrow();
    w.createData('route.x', fs);
    expect(() => w.paint('route.x', R(0), 1)).toThrow();
    expect(() => w.modifyFeature('route.x', 'nope', {})).toThrow();
    expect(() => w.removeIntent('op-999')).toThrow();
    const paintOp = w.log.find((e) => e.op.kind === 'create')!.opId;
    expect(() => w.removeIntent(paintOp)).toThrow();
  });
});

describe('序列化（Q13：JSON 逻辑契约 + base64 存储编码）', () => {
  test('Field 往返：值、统计、图例一致', () => {
    const f = registry.createField('elevation', {
      width: 8,
      height: 8,
      origin: { x: 0, y: 0 },
      resolution: 10,
      tileSize: 4,
      fill: (p) => p.x + p.y,
    });
    const restored = dataFromJSON(JSON.parse(JSON.stringify(dataToJSON(f)))) as typeof f;
    expect(restored.sample({ x: 25, y: 5 })).toBe(f.sample({ x: 25, y: 5 }));
    expect(restored.query(restored.bounds)).toEqual(f.query(f.bounds));
    expect(restored.tileList).toEqual(f.tileList);
  });

  test('FeatureSet 往返', () => {
    const fs = registry.createFeatureSet('route');
    fs.add({ kind: 'line', id: 'r1', semantic: 'route', points: [{ x: 1, y: 2 }], attributes: { label: 'x' } });
    const restored = dataFromJSON(JSON.parse(JSON.stringify(dataToJSON(fs)))) as FeatureSet;
    expect(restored.all()).toEqual(fs.all());
    expect(restored.query({ minX: 0, minY: 0, maxX: 5, maxY: 5 }).map((f) => f.id)).toEqual(['r1']);
  });
});
