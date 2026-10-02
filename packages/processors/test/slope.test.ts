import { describe, expect, test } from 'vitest';
import { Engine, Field, SemanticRegistry, World } from '@world/core';
import type { ProcessorDef } from '@world/core';
import { slopeProcessor } from '../src';

const registry = new SemanticRegistry();
registry.register({ semantic: 'elevation', dataType: { family: 'field', field: 'scalar' } });
registry.register({ semantic: 'slope', dataType: { family: 'field', field: 'scalar' } });

/** 带面积计数的 slope 包装（验证「只重算受影响 tile」，Q4 反全图退化）。 */
function makeCountingSlope() {
  const counter = { area: 0 };
  const def: ProcessorDef = {
    ...slopeProcessor,
    run(inputs, params, ctx) {
      counter.area += Math.round((ctx.region.maxX - ctx.region.minX) * (ctx.region.maxY - ctx.region.minY));
      return slopeProcessor.run(inputs, params, ctx);
    },
  };
  return { def, counter };
}

function setup(withCounting: boolean) {
  const world = new World(registry);
  const engine = new Engine(world);
  let counter = { area: 0 };
  if (withCounting) {
    const c = makeCountingSlope();
    counter = c.counter;
    engine.registerProcessor(c.def);
  } else {
    engine.registerProcessor(slopeProcessor);
  }
  engine.addInstance('slope.main', withCounting ? 'core.slope' : 'core.slope');
  const fill = (x: number, y: number) => x * 0.01 + Math.sin(y / 32) * 5;
  const elev = world.registry.createField('elevation', {
    width: 1024,
    height: 1024,
    origin: { x: 0, y: 0 },
    resolution: 1,
    tileSize: 128,
    fill: (p) => fill(p.x, p.y),
  });
  world.createData('elev.main', elev);
  engine.sync();
  return { world, engine, counter };
}

describe('Elevation → Slope：1024² 上的脏区传播与局部重算（Q4）', () => {
  test('修改 32×32 局部区域只重算受影响 tile，结果与全图重算一致', () => {
    const { world, engine, counter } = setup(true);

    const t0 = performance.now();
    engine.rebuild();
    const fullMs = performance.now() - t0;
    expect(engine.entryOf('slope.main').status).toBe('current');
    const fullArea = counter.area;
    expect(fullArea).toBe(1024 * 1024); // 初始 = 全图一次

    counter.area = 0;
    world.paint('elev.main', { minX: 500, minY: 500, maxX: 532, maxY: 532 }, 100);
    engine.sync();
    expect(engine.entryOf('slope.main').status).toBe('partially-outdated');

    const t1 = performance.now();
    engine.rebuild();
    const incMs = performance.now() - t1;
    expect(engine.entryOf('slope.main').status).toBe('current');

    // (498..534)² 外扩后只命中 2×2 个 128² tile = 65536 采样（6.25%）
    expect(counter.area).toBe(4 * 128 * 128);
    expect(counter.area).toBeLessThan(fullArea * 0.1);
    // eslint-disable-next-line no-console
    console.log(`[perf] 1024² full=${fullMs.toFixed(0)}ms incremental=${incMs.toFixed(0)}ms (${((counter.area / fullArea) * 100).toFixed(1)}% samples)`);

    // 正确性：与「先改后算」的全图基准逐点一致（P1，全分辨率抽查边界带 + 步进 8 全图）
    const base = setup(false);
    base.engine.rebuild(); // 基准先全图建好
    base.world.paint('elev.main', { minX: 500, minY: 500, maxX: 532, maxY: 532 }, 100);
    base.engine.sync();
    base.engine.rebuild();
    const out = engine.dataOf('slope.main') as Field;
    const ref = base.engine.dataOf('slope.main') as Field;
    for (let y = 0; y < 1024; y += 8) {
      for (let x = 0; x < 1024; x += 8) {
        expect(out.sample({ x, y })).toBe(ref.sample({ x, y }));
      }
    }
    for (let y = 490; y < 545; y += 1) {
      for (let x = 490; x < 545; x += 1) {
        expect(out.sample({ x, y })).toBe(ref.sample({ x, y }));
      }
    }
  });
});
