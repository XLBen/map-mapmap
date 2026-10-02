import { describe, expect, test } from 'vitest';
import { Engine } from '../src/engine';
import { SemanticRegistry } from '../src/registry';
import { World } from '../src/authoring';
import type { Field, ProcessorDef } from '../src';

const registry = new SemanticRegistry();
registry.register({ semantic: 'elevation', dataType: { family: 'field', field: 'scalar' } });
registry.register({ semantic: 'slope', dataType: { family: 'field', field: 'scalar' } });

/** 测试用 slope：与 core.slope 相同的邻域语义，避免跨包依赖。 */
const slopeDef: ProcessorDef = {
  id: 'test.slope',
  inputs: [{ name: 'elevation', kind: 'field', dataType: 'scalar', semantic: 'elevation' }],
  output: { kind: 'field', dataType: 'scalar', semantic: 'slope' },
  invalidation: { policy: { propagation: 'neighborhood', radius: 1 }, context: { padding: 1, seam: 'extend' } },
  run(inputs, _params, ctx) {
    const elev = inputs.elevation as Field;
    const res = elev.def.resolution;
    const nodata = elev.def.nodata;
    const nx = Math.round((ctx.region.maxX - ctx.region.minX) / res);
    const ny = Math.round((ctx.region.maxY - ctx.region.minY) / res);
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const x = ctx.region.minX + ix * res;
        const y = ctx.region.minY + iy * res;
        const s = (px: number, py: number) => {
          const px2 = Math.min(Math.max(px, 0), (elev.def.width - 1) * res);
          const py2 = Math.min(Math.max(py, 0), (elev.def.height - 1) * res);
          return elev.sample({ x: px2, y: py2 });
        };
        const zL = s(x - res, y) as number;
        const zR = s(x + res, y) as number;
        const zT = s(x, y - res) as number;
        const zB = s(x, y + res) as number;
        if (zL === nodata || zR === nodata || zT === nodata || zB === nodata) {
          ctx.write({ x, y }, nodata);
          continue;
        }
        ctx.write({ x, y }, Math.hypot((zR - zL) / (2 * res), (zB - zT) / (2 * res)));
      }
    }
  },
};

function makeElev(world: World, fill: (x: number, y: number) => number): Field {
  return world.registry.createField('elevation', {
    width: 64,
    height: 64,
    origin: { x: 0, y: 0 },
    resolution: 1,
    tileSize: 16,
    fill: (p) => fill(p.x, p.y),
  });
}

const R = (x0: number, y0: number, x1: number, y1: number) => ({ minX: x0, minY: y0, maxX: x1, maxY: y1 });

describe('Engine：状态机 + Rebuild（charter 31/32，Q6）', () => {
  test('blocked（输入缺失）→ outdated → rebuild → current；slope 数值正确', () => {
    const world = new World(registry);
    const engine = new Engine(world);
    engine.registerProcessor(slopeDef);
    engine.addInstance('slope.main', 'test.slope');
    expect(engine.entryOf('slope.main').status).toBe('blocked');

    world.createData('elev.main', makeElev(world, (x) => x * 0.01));
    engine.sync();
    expect(engine.entryOf('slope.main').status).toBe('outdated');
    expect(world.drainDirty()).toEqual([]); // sync 已消费标脏

    engine.rebuild();
    const entry = engine.entryOf('slope.main');
    expect(entry.status).toBe('current');
    const out = engine.dataOf('slope.main') as Field;
    expect(out.def.semantic).toBe('slope');
    expect(out.sample({ x: 20, y: 20 })).toBeCloseTo(0.01, 6); // fill = x*0.01 → dz/dx = 0.01
  });

  test('局部 paint → partially-outdated → rebuild 后 current；pending 按 radius+padding 外扩', () => {
    const world = new World(registry);
    const engine = new Engine(world);
    engine.registerProcessor(slopeDef);
    world.createData('elev.main', makeElev(world, () => 5));
    engine.addInstance('slope.main', 'test.slope');
    engine.sync();
    engine.rebuild();
    expect(engine.entryOf('slope.main').status).toBe('current');

    world.paint('elev.main', R(10, 10, 20, 20), 100);
    engine.sync();
    const entry = engine.entryOf('slope.main');
    expect(entry.status).toBe('partially-outdated');
    expect(entry.pending).toEqual([R(8, 8, 22, 22)]); // radius 1 + padding 1 → 外扩 2

    engine.rebuild();
    expect(entry.status).toBe('current');
    const out = engine.dataOf('slope.main') as Field;
    expect(out.sample({ x: 10, y: 15 })).toBeGreaterThan(1); // 高台边缘梯度大
    expect(out.sample({ x: 15, y: 15 })).toBe(0); // 平台中心无梯度
    expect(out.sample({ x: 40, y: 40 })).toBe(0); // 未受影响区仍是平面
  });

  test('P1 可测试性质：局部重算结果 == 全图重算（Q4）', () => {
    const paint = R(10, 10, 20, 20);
    const base = (x: number, y: number) => x * 0.01 + Math.sin(y / 8) * 3;

    const w1 = new World(registry);
    const e1 = new Engine(w1);
    e1.registerProcessor(slopeDef);
    const f1 = makeElev(w1, base);
    w1.createData('elev.main', f1);
    w1.paint('elev.main', paint, 100); // 先建实例后改 → 走局部重算路径
    e1.addInstance('slope.main', 'test.slope');
    e1.sync();
    e1.rebuild();

    const w2 = new World(registry);
    const e2 = new Engine(w2);
    e2.registerProcessor(slopeDef);
    const f2 = makeElev(w2, base);
    w2.createData('elev.main', f2);
    w2.paint('elev.main', paint, 100); // 先改后建实例 → 全图重算路径
    e2.addInstance('slope.main', 'test.slope');
    e2.sync();
    e2.rebuild();

    const o1 = e1.dataOf('slope.main') as Field;
    const o2 = e2.dataOf('slope.main') as Field;
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        expect(o1.sample({ x, y })).toBe(o2.sample({ x, y }));
      }
    }
  });

  test('region 限定 rebuild → 剩余 pending 保持 partially-outdated', () => {
    const world = new World(registry);
    const engine = new Engine(world);
    engine.registerProcessor(slopeDef);
    world.createData('elev.main', makeElev(world, () => 5));
    engine.addInstance('slope.main', 'test.slope');
    engine.sync();
    engine.rebuild();
    world.paint('elev.main', R(10, 10, 30, 30), 50);
    engine.sync();
    engine.rebuild({ region: R(0, 0, 16, 16) });
    const entry = engine.entryOf('slope.main');
    expect(entry.status).toBe('partially-outdated');
    engine.rebuild();
    expect(entry.status).toBe('current');
  });
});

describe('Engine：DAG 校验 + 歧义 + 错误传播（charter 25，Q6）', () => {
  test('环在 addInstance 即拒绝', () => {
    const world = new World(registry);
    const engine = new Engine(world);
    const mk = (id: string, input: string, output: string): ProcessorDef => ({
      id,
      inputs: [{ name: 'in', kind: 'field', dataType: 'scalar', semantic: input }],
      output: { kind: 'field', dataType: 'scalar', semantic: output },
      invalidation: { policy: { propagation: 'local' }, context: { padding: 0, seam: 'extend' } },
      run: () => {},
    });
    engine.registerProcessor(mk('p1', 'slope', 'elevation2'));
    engine.registerProcessor(mk('p2', 'elevation2', 'slope2'));
    engine.addInstance('a', 'p1');
    engine.addInstance('b', 'p2');
    engine.registerProcessor(mk('p3', 'slope2', 'slope')); // b→c→a 成环
    expect(() => engine.addInstance('c', 'p3')).toThrow(/环/);
  });

  test('同名 semantic 多候选 → 槽位解析报歧义', () => {
    const world = new World(registry);
    const engine = new Engine(world);
    registry.register({ semantic: 'merged', dataType: { family: 'field', field: 'scalar' } });
    engine.registerProcessor(slopeDef);
    const mergeDef: ProcessorDef = {
      id: 'test.merge',
      inputs: [{ name: 'in', kind: 'field', dataType: 'scalar', semantic: 'slope' }],
      output: { kind: 'field', dataType: 'scalar', semantic: 'merged' },
      invalidation: { policy: { propagation: 'local' }, context: { padding: 0, seam: 'extend' } },
      run: () => {},
    };
    engine.registerProcessor(mergeDef);
    world.createData('elev.main', makeElev(world, () => 5));
    engine.addInstance('slope.a', 'test.slope');
    engine.addInstance('slope.b', 'test.slope'); // 两个实例都产出 slope
    engine.addInstance('merge.i', 'test.merge');
    engine.sync();
    expect(() => engine.rebuild()).toThrow(/歧义/);
  });

  test('processor 抛错 → error；下游 → blocked（Q6）', () => {
    const world = new World(registry);
    const engine = new Engine(world);
    registry.register({ semantic: 'boomout', dataType: { family: 'field', field: 'scalar' } });
    registry.register({ semantic: 'final', dataType: { family: 'field', field: 'scalar' } });
    const boom: ProcessorDef = {
      id: 'test.boom',
      inputs: [{ name: 'elevation', kind: 'field', dataType: 'scalar', semantic: 'elevation' }],
      output: { kind: 'field', dataType: 'scalar', semantic: 'boomout' },
      invalidation: { policy: { propagation: 'local' }, context: { padding: 0, seam: 'extend' } },
      run: () => {
        throw new Error('boom');
      },
    };
    const down: ProcessorDef = {
      id: 'test.down',
      inputs: [{ name: 'in', kind: 'field', dataType: 'scalar', semantic: 'boomout' }],
      output: { kind: 'field', dataType: 'scalar', semantic: 'final' },
      invalidation: { policy: { propagation: 'local' }, context: { padding: 0, seam: 'extend' } },
      run: () => {},
    };
    engine.registerProcessor(boom);
    engine.registerProcessor(down);
    world.createData('elev.main', makeElev(world, () => 5));
    engine.addInstance('boom.i', 'test.boom');
    engine.addInstance('down.i', 'test.down');
    engine.sync();
    engine.rebuild();
    expect(engine.entryOf('boom.i').status).toBe('error');
    expect(engine.entryOf('boom.i').error).toBe('boom');
    expect(engine.entryOf('down.i').status).toBe('blocked');
    expect(engine.entryOf('down.i').blockedByUpstream).toBe('boom.i');
    // 修复（换实现）后重建恢复
    boom.run = (_inputs, _p, ctx) => {
      ctx.write({ x: 0, y: 0 }, 0);
    };
    engine.rebuild();
    expect(engine.entryOf('boom.i').status).toBe('current');
  });
});
