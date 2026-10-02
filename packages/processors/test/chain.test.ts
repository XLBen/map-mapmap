import { describe, expect, test } from 'vitest';
import { Engine, FeatureSet, Field, SemanticRegistry, World } from '@world/core';
import type { Field as FieldT, LineFeature } from '@world/core';
import { hydrologyProcessor, moistureProcessor, biomeProcessor, oasisProcessor } from '../src';

const registry = new SemanticRegistry();
for (const s of ['elevation', 'rainfall', 'moisture'] as const) {
  registry.register({ semantic: s, dataType: { family: 'field', field: 'scalar' } });
}
registry.register({ semantic: 'biome', dataType: { family: 'field', field: 'categorical' } });
registry.register({ semantic: 'river', dataType: { family: 'feature', feature: 'line' } });
registry.register({ semantic: 'oasis', dataType: { family: 'feature', feature: 'point' } });

const W = 64;

function makeWorld(opts: { threshold: number }) {
  const world = new World(registry);
  const engine = new Engine(world);
  for (const p of [hydrologyProcessor, moistureProcessor, biomeProcessor, oasisProcessor]) engine.registerProcessor(p);
  world.createData('elev.main', world.registry.createField('elevation', {
    width: W,
    height: W,
    origin: { x: 0, y: 0 },
    resolution: 1,
    tileSize: 16,
    // V 型沟谷 + 缓 -x 坡 → 两侧汇入 y=32 沟道后向东流（确定性河道）
    fill: (p) => 0.9 * Math.abs(p.y - 32) + 0.15 * p.x,
  }));
  world.createData('rain.main', world.registry.createField('rainfall', {
    width: W,
    height: W,
    origin: { x: 0, y: 0 },
    resolution: 1,
    tileSize: 16,
    fill: () => 10,
  }));
  engine.addInstance('hyd.i', 'hydrology.d8', { threshold: opts.threshold, seed: 'test-seed' });
  engine.addInstance('moi.i', 'hydrology.moisture', { base: 0.2, boost: 0.6, radius: 12 });
  engine.addInstance('bio.i', 'world.biome', {});
  engine.addInstance('oas.i', 'world.oasis', { minMoisture: 0.5, maxPoints: 16 });
  engine.sync();
  return { world, engine, settle };
}

/** 反复 rebuild 直到链路收敛（首次构建时下游可能 blocked，输入就绪后再补算）。 */
function settle(engine: Engine): void {
  for (let i = 0; i < 4; i++) engine.rebuild();
}

describe('#11 下游链：Elevation+Rainfall → River → Moisture → Biome/Oasis', () => {
  test('天然河道生成，id 重建稳定，对象带 Provenance（charter 19）', () => {
    const { engine } = makeWorld({ threshold: 400 });
    settle(engine);
    expect(engine.entryOf('hyd.i').status).toBe('current');
    const rivers = engine.resolver.resolve('river').data as FeatureSet;
    expect(rivers.size).toBeGreaterThanOrEqual(1);
    const ids1 = rivers.all().map((f) => f.id).sort();
    const attrs = rivers.all()[0].attributes as { provenance: Record<string, unknown> };
    expect(attrs.provenance.processorId).toBe('hydrology.d8');
    expect(attrs.provenance.version).toBe('0.1.0');
    expect(attrs.provenance.seed).toBe('test-seed');

    // 重建后 id 不变（lineageId 稳定，Q2）
    engine.sync();
    settle(engine);
    const rivers2 = engine.resolver.resolve('river').data as FeatureSet;
    expect(rivers2.all().map((f) => f.id).sort()).toEqual(ids1);
  });

  test('手工河进入 Resolved World 与生成河共存；重叠 → Conflict 不去重（charter 12，Q12）', () => {
    const { world, engine } = makeWorld({ threshold: 400 });
    const fs = registry.createFeatureSet('river');
    fs.add({ kind: 'line', id: 'manual-1', semantic: 'river', points: [{ x: 5, y: 32 }, { x: 60, y: 32 }], attributes: {} });
    world.createData('river.manual', fs);
    engine.sync();
    settle(engine);

    const resolved = engine.resolver.resolve('river');
    const ids = (resolved.data as FeatureSet).all().map((f) => f.id);
    expect(ids).toContain('manual-1'); // 手绘河进入 Resolved World（charter 12）
    expect(ids.some((id) => id.startsWith('river:'))).toBe(true); // 生成河共存
    expect(resolved.conflicts.map((c) => c.kind)).toContain('manual-generated-overlap'); // 不去重，报 Conflict
  });

  test('删除生成河 = 创建抑制：Rebuild 不复活；撤销恢复（charter 16/17/20）', () => {
    const { world, engine } = makeWorld({ threshold: 400 });
    settle(engine);
    const riverId = (engine.resolver.resolve('river').data as FeatureSet).all()[0].id;

    world.suppress(riverId, 'river');
    engine.sync();
    settle(engine);
    let ids = (engine.resolver.resolve('river').data as FeatureSet).all().map((f) => f.id);
    expect(ids).not.toContain(riverId); // 抑制后排除

    engine.rebuild(); // 再 rebuild 也不复活（charter 20）
    ids = (engine.resolver.resolve('river').data as FeatureSet).all().map((f) => f.id);
    expect(ids).not.toContain(riverId);

    world.undo(); // 撤销抑制 → 恢复
    engine.sync();
    settle(engine);
    ids = (engine.resolver.resolve('river').data as FeatureSet).all().map((f) => f.id);
    expect(ids).toContain(riverId);
  });

  test('空间抑制河道区域：生成段消失且下游不再受滋养（charter 18，Q8）', () => {
    const { world, engine } = makeWorld({ threshold: 400 });
    settle(engine);
    const gen = (engine.resolver.resolve('river').data as FeatureSet).all().filter((f) => f.id.startsWith('river:')) as LineFeature[];
    expect(gen.length).toBeGreaterThanOrEqual(1);
    const target = gen[0];
    const before = (engine.dataOf('moi.i') as FieldT).sample({ x: target.points[0].x, y: target.points[0].y + 3 }) as number;
    expect(before).toBeGreaterThan(0.3); // 河边滋养

    const xs = target.points.map((p) => p.x);
    const ys = target.points.map((p) => p.y);
    world.suppressSpatial({
      semantic: 'river',
      spatialType: 'line',
      region: { minX: Math.min(...xs) - 1, minY: Math.min(...ys) - 1, maxX: Math.max(...xs) + 1, maxY: Math.max(...ys) + 1 },
    });
    engine.sync();
    settle(engine);

    const ids = (engine.resolver.resolve('river').data as FeatureSet).all().map((f) => f.id);
    expect(ids).not.toContain(target.id); // 该区域的生成河被压制
    const after = (engine.dataOf('moi.i') as FieldT).sample({ x: target.points[0].x, y: target.points[0].y + 3 }) as number;
    expect(after).toBeCloseTo(0.2, 6); // 下游不再受滋养（Q8 mask 影响下游）
  });

  test('沙漠强行画河（charter 58）：Biome 保持 Desert，River/Oasis/局部水分共存', () => {
    const { world, engine } = makeWorld({ threshold: 1e9 }); // 不可能成河 → 无天然河
    settle(engine);
    expect((engine.resolver.resolve('river').data as FeatureSet).size).toBe(0);
    const biome0 = engine.dataOf('bio.i') as FieldT;
    expect(biome0.categories).toEqual(['desert', 'grass', 'forest']);
    expect(biome0.sample({ x: 32, y: 32 })).toBe(0); // 全 Desert

    // 手绘一条穿沙漠的河
    const fs = registry.createFeatureSet('river');
    fs.add({ kind: 'line', id: 'manual-desert', semantic: 'river', points: [{ x: 8, y: 30 }, { x: 56, y: 34 }], attributes: { label: 'manual' } });
    world.createData('river.manual', fs);
    engine.sync();
    settle(engine);

    const moisture = engine.dataOf('moi.i') as FieldT;
    expect(moisture.sample({ x: 30, y: 32 })).toBeGreaterThan(0.45); // 沿河水分升高（局部植被潜力）
    const biome = engine.dataOf('bio.i') as FieldT;
    expect(biome.sample({ x: 30, y: 32 })).toBe(0); // Biome 不被自动改写，保持 Desert
    expect(biome.sample({ x: 5, y: 5 })).toBe(0);
    const oasis = engine.resolver.resolve('oasis').data as FeatureSet;
    expect(oasis.size).toBeGreaterThanOrEqual(1); // Oasis 局部 feature 与 Desert 共存
    const resolvedRivers = engine.resolver.resolve('river').data as FeatureSet;
    expect(resolvedRivers.all().map((f) => f.id)).toContain('manual-desert');
  });

  test('Moisture 只消费抑制后/合并后的 river 槽位（ResolvedWorld 可作 Processor 输入，charter 56）', () => {
    const { world, engine } = makeWorld({ threshold: 400 });
    settle(engine);
    const first = (engine.resolver.resolve('river').data as FeatureSet).all()[0] as LineFeature;
    world.suppress(first.id, 'river');
    engine.sync();
    settle(engine);
    // 被抑制河道边上的 moisture 回落到基线（moisture 的 river 输入 = Resolved 合并结果）
    const px = first.points[0].x;
    const py = first.points[0].y + 2;
    const m = (engine.dataOf('moi.i') as FieldT).sample({ x: px, y: py }) as number;
    const other = (engine.resolver.resolve('river').data as FeatureSet).all() as LineFeature[];
    if (!other.some((f) => f.points.some((p) => Math.hypot(p.x - px, p.y - py) < 12))) {
      expect(m).toBeCloseTo(0.2, 6);
    } else {
      expect(m).toBeGreaterThan(0.3);
    }
  });
});

// 防止未使用导入告警（Field/FeatureSet 在类型断言中使用）
void Field;
