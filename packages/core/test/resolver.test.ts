import { describe, expect, test } from 'vitest';
import { Engine } from '../src/engine';
import { SemanticRegistry } from '../src/registry';
import { World } from '../src/authoring';
import type { Field as FieldT } from '../src/field';
import type { FeatureSet } from '../src/feature';
import type { ProcessorDef } from '../src';

const registry = new SemanticRegistry();
registry.register({ semantic: 'elevation', dataType: { family: 'field', field: 'scalar' } });
registry.register({ semantic: 'route', dataType: { family: 'feature', feature: 'line' }, capabilities: ['routable'] });
registry.register({ semantic: 'routes.gen', dataType: { family: 'feature', feature: 'line' } });
registry.register({ semantic: 'elev.copy', dataType: { family: 'field', field: 'scalar' } });

function makeElev(world: World, fill: (x: number, y: number) => number): FieldT {
  return world.registry.createField('elevation', {
    width: 32,
    height: 32,
    origin: { x: 0, y: 0 },
    resolution: 1,
    tileSize: 8,
    fill: (p) => fill(p.x, p.y),
  });
}

/** 生成 'elev.copy'（field）与 'routes.gen'（line 要素）的测试处理器。 */
function setup() {
  const world = new World(registry);
  const engine = new Engine(world);
  const copyDef: ProcessorDef = {
    id: 'test.copy',
    inputs: [{ name: 'elevation', kind: 'field', dataType: 'scalar', semantic: 'elevation' }],
    output: { kind: 'field', dataType: 'scalar', semantic: 'elev.copy' },
    invalidation: { policy: { propagation: 'local' }, context: { padding: 0, seam: 'extend' } },
    run: (inputs, _p, ctx) => {
      const src = inputs.elevation as FieldT;
      const nx = Math.round(ctx.region.maxX - ctx.region.minX);
      const ny = Math.round(ctx.region.maxY - ctx.region.minY);
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          ctx.write({ x: ctx.region.minX + ix, y: ctx.region.minY + iy }, src.sample({ x: ctx.region.minX + ix, y: ctx.region.minY + iy }) as number);
        }
      }
    },
  };
  const routesDef: ProcessorDef = {
    id: 'test.routes',
    inputs: [{ name: 'elevation', kind: 'field', dataType: 'scalar', semantic: 'elevation' }],
    output: { kind: 'feature', dataType: 'line', semantic: 'routes.gen' },
    invalidation: { policy: { propagation: 'global' }, context: { padding: 0, seam: 'extend' } },
    run: (_inputs, _p, _ctx) => ({
      features: [
        { kind: 'line' as const, id: 'gen-r1', semantic: 'routes.gen', points: [{ x: 1, y: 1 }, { x: 5, y: 5 }], attributes: {} },
        { kind: 'line' as const, id: 'gen-r2', semantic: 'routes.gen', points: [{ x: 20, y: 20 }, { x: 25, y: 25 }], attributes: {} },
      ],
    }),
  };
  engine.registerProcessor(copyDef);
  engine.registerProcessor(routesDef);
  world.createData('elev.main', makeElev(world, () => 5));
  engine.addInstance('copy.i', 'test.copy');
  engine.addInstance('routes.i', 'test.routes');
  engine.sync();
  engine.rebuild();
  return { world, engine };
}

describe('Resolver：槽位优先级（charter 51）', () => {
  test('Authored > Generated，即使生成数据更新（禁 last-run-wins）；无数据 → fallback', () => {
    const { world, engine } = setup();
    // elev.copy 是后生成的；elevation 的槽位只有 authored
    const r = engine.resolver.resolve('elevation');
    expect(r.source).toBe('authored');
    expect(r.lineage[0].dataId).toBe('elev.main');

    // 同 semantic 一 authored 一 generated：authored 赢
    world.override({ dataId: 'gen:copy.i', value: 999 }); // 对生成数据的 override 不影响槽位
    const copy = engine.resolver.resolve('elev.copy');
    expect(copy.source).toBe('generated');

    const missing = engine.resolver.resolve('nope.semantic');
    expect(missing.source).toBe('fallback');
    expect(missing.data).toBeUndefined();
  });
});

describe('Resolver：Override / Pin / Conflict（charter 15/50，Q1）', () => {
  test('Override 区域生效于解析副本，原数据不动；Pin 冲突 → 不应用 + Conflict', () => {
    const { world, engine } = setup();
    const elev = world.data('elev.main') as FieldT;
    world.override({ dataId: 'elev.main', region: { minX: 10, minY: 10, maxX: 14, maxY: 14 }, value: 42 });

    const r = engine.resolver.resolve('elevation');
    expect(r.conflicts).toEqual([]);
    const resolved = r.data as FieldT;
    expect(resolved.sample({ x: 12, y: 12 })).toBe(42);
    expect(resolved.sample({ x: 20, y: 20 })).toBe(5);
    expect(elev.sample({ x: 12, y: 12 })).toBe(5); // 作者数据零改动（charter 21）

    // Pin 区域后：所有与 Pin 相交的 override（含先前添加的）都被挡下（冻结语义）
    world.pin({ region: { minX: 0, minY: 0, maxX: 32, maxY: 32 } });
    world.override({ dataId: 'elev.main', region: { minX: 20, minY: 20, maxX: 24, maxY: 24 }, value: 7 });
    const r2 = engine.resolver.resolve('elevation');
    expect(r2.conflicts.map((c) => c.kind)).toEqual(['override-vs-pin', 'override-vs-pin']);
    expect((r2.data as FieldT).sample({ x: 22, y: 22 })).toBe(5); // 新 override 未应用
    expect((r2.data as FieldT).sample({ x: 12, y: 12 })).toBe(5); // 冻结后旧 override 也不再应用
  });
});

describe('Resolver：对象级抑制（charter 16/17，Q2）+ Conflict Map（charter 53）', () => {
  test('lineageId 精确过滤生成的要素；目标缺失 → Conflict；生成数据本体不破坏', () => {
    const { world, engine } = setup();
    const gen = engine.dataOf('routes.i') as FeatureSet;
    expect(gen.size).toBe(2);

    world.suppress('gen-r1', 'routes.gen');
    world.suppress('gen-ghost', 'routes.gen'); // 不存在的目标

    const r = engine.resolver.resolve('routes.gen');
    const fs = r.data as FeatureSet;
    expect(fs.size).toBe(1); // gen-r1 被抑制排除
    expect(fs.all()[0].id).toBe('gen-r2');
    expect(gen.size).toBe(2); // 生成数据本体不破坏（charter 17）
    expect(r.conflicts.map((c) => c.kind)).toEqual(['suppressed-target-missing']);
    expect(engine.resolver.conflicts()).toHaveLength(1); // Conflict Map 可查
  });
});

describe('Resolver：Constraint 只报告不求解（Q9）+ 空间抑制 mask（Q8）', () => {
  test('违反约束 → Conflict 记录，数据不被纠正', () => {
    const { world, engine } = setup();
    world.constraint({ dataId: 'elev.main', attribute: 'elevation', op: '>=', value: 100 });
    const r = engine.resolver.resolve('elevation');
    expect(r.conflicts.map((c) => c.kind)).toEqual(['constraint-violated']);
    expect((r.data as FieldT).sample({ x: 5, y: 5 })).toBe(5); // 未被自动纠正
  });

  test('空间级抑制 = Processor 输入 mask：下游输入在掩蔽区变 nodata，输入本体不动', () => {
    const { world, engine } = setup();
    const before = (engine.dataOf('copy.i') as FieldT).sample({ x: 12, y: 12 }) as number;
    expect(before).toBe(5);

    world.suppressSpatial({ semantic: 'elevation', spatialType: 'field', region: { minX: 10, minY: 10, maxX: 16, maxY: 16 } });
    engine.sync();
    engine.rebuild();

    const after = engine.dataOf('copy.i') as FieldT;
    expect(after.sample({ x: 12, y: 12 })).toBe(-9999); // mask 区 → nodata 下传
    expect(after.sample({ x: 20, y: 20 })).toBe(5); // 掩蔽区外正常
    expect((world.data('elev.main') as FieldT).sample({ x: 12, y: 12 })).toBe(5); // 输入本体不动
  });

  test('空间级抑制过滤生成的要素输入（下游看到的集合变小）', () => {
    const { world, engine } = setup();
    world.suppressSpatial({ semantic: 'routes.gen', spatialType: 'line', region: { minX: 18, minY: 18, maxX: 28, maxY: 28 } });
    const fs = engine.resolver.resolve('routes.gen').data as FeatureSet;
    // resolver 出口不过滤空间抑制（Q8：mask 在处理器输入侧）；验证引擎输入侧过滤
    expect(fs.size).toBe(2);
    const consumer: ProcessorDef = {
      id: 'test.count',
      inputs: [
        { name: 'elevation', kind: 'field', dataType: 'scalar', semantic: 'elevation' },
        { name: 'routes', kind: 'feature', dataType: 'line', semantic: 'routes.gen' },
      ],
      output: { kind: 'field', dataType: 'scalar', semantic: 'route.count' },
      invalidation: { policy: { propagation: 'local' }, context: { padding: 0, seam: 'extend' } },
      run: (inputs, _p, ctx) => {
        ctx.write({ x: 1, y: 1 }, (inputs.routes as FeatureSet).size);
      },
    };
    registry.register({ semantic: 'route.count', dataType: { family: 'field', field: 'scalar' } });
    engine.registerProcessor(consumer);
    engine.addInstance('count.i', 'test.count');
    engine.sync();
    engine.rebuild();
    expect((engine.dataOf('count.i') as FieldT).sample({ x: 1, y: 1 })).toBe(1); // gen-r2 被输入 mask 滤掉
  });
});
