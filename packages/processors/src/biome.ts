import type { Field, ProcessorDef } from '@world/core';

/**
 * Biome Processor：Moisture → 类别场（charter 12）。
 * 阈值刻意保守：只有强水分才改写 biome；沿河轻度水分以 Oasis 表达（charter 58：不自动改写 Desert）。
 */
export const biomeProcessor: ProcessorDef = {
  id: 'world.biome',
  version: '0.1.0',
  inputs: [{ name: 'moisture', kind: 'field', dataType: 'scalar', semantic: 'moisture' }],
  output: {
    kind: 'field',
    dataType: 'categorical',
    semantic: 'biome',
    legend: { desert: 0, grass: 1, forest: 2 },
  },
  invalidation: { policy: { propagation: 'local' }, context: { padding: 0, seam: 'extend' } },
  run(inputs, _params, ctx) {
    const moisture = inputs.moisture as Field;
    const d = moisture.def;
    const res = d.resolution;
    const nodata = d.nodata;
    const nx = Math.round((ctx.region.maxX - ctx.region.minX) / res);
    const ny = Math.round((ctx.region.maxY - ctx.region.minY) / res);
    for (let iy = 0; iy < ny; iy++) {
      const y = ctx.region.minY + iy * res;
      for (let ix = 0; ix < nx; ix++) {
        const x = ctx.region.minX + ix * res;
        const m = moisture.sample({ x, y }) as number;
        if (m === nodata) {
          ctx.write({ x, y }, nodata);
          continue;
        }
        ctx.write({ x, y }, m >= 0.92 ? 2 : m >= 0.8 ? 1 : 0);
      }
    }
  },
};

/** Oasis：Desert 中水分显著的局部点（charter 12 局部 feature；与 Desert 共存，charter 58）。 */
export const oasisProcessor: ProcessorDef<{ minMoisture: number; maxPoints: number }> = {
  id: 'world.oasis',
  version: '0.1.0',
  inputs: [
    { name: 'moisture', kind: 'field', dataType: 'scalar', semantic: 'moisture' },
    { name: 'biome', kind: 'field', dataType: 'categorical', semantic: 'biome' },
  ],
  output: { kind: 'feature', dataType: 'point', semantic: 'oasis' },
  invalidation: { policy: { propagation: 'neighborhood', radius: 16 }, context: { padding: 0, seam: 'extend' } },
  run(inputs, params, ctx) {
    const moisture = inputs.moisture as Field;
    const biome = inputs.biome as Field;
    const d = moisture.def;
    const res = d.resolution;
    const candidates: Array<{ x: number; y: number; m: number }> = [];
    const nx = Math.round((ctx.region.maxX - ctx.region.minX) / res);
    const ny = Math.round((ctx.region.maxY - ctx.region.minY) / res);
    for (let iy = 0; iy < ny; iy++) {
      const y = ctx.region.minY + iy * res;
      for (let ix = 0; ix < nx; ix++) {
        const x = ctx.region.minX + ix * res;
        const b = biome.sample({ x, y });
        if (b !== 0) continue; // 只在 Desert
        const m = moisture.sample({ x, y }) as number;
        if (m >= params.minMoisture) candidates.push({ x, y, m });
      }
    }
    candidates.sort((a, b) => b.m - a.m); // 确定性：按水分降序
    const features = candidates.slice(0, params.maxPoints).map((c) => ({
      kind: 'point' as const,
      id: `oasis:${ctx.instanceId}:${c.x}_${c.y}`,
      semantic: 'oasis',
      pos: { x: c.x, y: c.y },
      attributes: { moisture: c.m, provenance: { processorId: oasisProcessor.id, version: oasisProcessor.version, instanceId: ctx.instanceId } },
    }));
    return { features };
  },
};
