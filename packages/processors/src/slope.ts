import type { Field, ProcessorDef } from '@world/core';

/**
 * 首条 Processor：Elevation → Slope（坡度 = 梯度模长，单位 = 高程单位 / 世界单位）。
 * 中心差分；seam: extend（越界钳制到边缘采样）；邻域半径 1 + padding 1。
 */
export const slopeProcessor: ProcessorDef = {
  id: 'core.slope',
  inputs: [{ name: 'elevation', kind: 'field', dataType: 'scalar', semantic: 'elevation' }],
  output: { kind: 'field', dataType: 'scalar', semantic: 'slope' },
  invalidation: { policy: { propagation: 'neighborhood', radius: 1 }, context: { padding: 1, seam: 'extend' } },
  run(inputs, _params, ctx) {
    const elev = inputs.elevation as Field;
    const seam = slopeProcessor.invalidation.context.seam;
    const res = elev.def.resolution;
    const nodata = elev.def.nodata;
    const nx = Math.round((ctx.region.maxX - ctx.region.minX) / res);
    const ny = Math.round((ctx.region.maxY - ctx.region.minY) / res);
    for (let iy = 0; iy < ny; iy++) {
      const y = ctx.region.minY + iy * res;
      for (let ix = 0; ix < nx; ix++) {
        const x = ctx.region.minX + ix * res;
        const zL = clampSample(elev, x - res, y, seam);
        const zR = clampSample(elev, x + res, y, seam);
        const zT = clampSample(elev, x, y - res, seam);
        const zB = clampSample(elev, x, y + res, seam);
        if (zL === nodata || zR === nodata || zT === nodata || zB === nodata) {
          ctx.write({ x, y }, nodata);
          continue;
        }
        const gx = (zR - zL) / (2 * res);
        const gy = (zB - zT) / (2 * res);
        ctx.write({ x, y }, Math.hypot(gx, gy));
      }
    }
  },
};

function clampSample(f: Field, x: number, y: number, seam: 'extend' | 'nodata'): number {
  const b = f.bounds;
  const res = f.def.resolution;
  const maxX = b.minX + (f.def.width - 1) * res;
  const maxY = b.minY + (f.def.height - 1) * res;
  if (x < b.minX || y < b.minY || x > maxX || y > maxY) {
    if (seam === 'nodata') return f.def.nodata;
    x = Math.min(Math.max(x, b.minX), maxX);
    y = Math.min(Math.max(y, b.minY), maxY);
  }
  return f.sample({ x, y }) as number;
}
