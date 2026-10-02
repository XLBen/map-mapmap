import { Field } from '@world/core';
import type { FeatureSet, ProcessorDef } from '@world/core';

/** 手工/生成河流通用的 moisture 基础参数（charter 12：手绘河同样滋养）。 */
export const moistureProcessor: ProcessorDef<{ base: number; boost: number; radius: number }> = {
  id: 'hydrology.moisture',
  version: '0.1.0',
  inputs: [
    { name: 'elevation', kind: 'field', dataType: 'scalar', semantic: 'elevation' },
    { name: 'river', kind: 'feature', dataType: 'line', semantic: 'river' },
  ],
  output: { kind: 'field', dataType: 'scalar', semantic: 'moisture' },
  invalidation: { policy: { propagation: 'neighborhood', radius: 16 }, context: { padding: 0, seam: 'extend' } },
  run(inputs, params, ctx) {
    const elev = inputs.elevation as Field;
    const river = inputs.river;
    const d = elev.def;
    const res = d.resolution;
    const R = params.radius; // 世界单位
    const segs = collectSegments(river);
    const nx = Math.round((ctx.region.maxX - ctx.region.minX) / res);
    const ny = Math.round((ctx.region.maxY - ctx.region.minY) / res);
    for (let iy = 0; iy < ny; iy++) {
      const y = ctx.region.minY + iy * res;
      for (let ix = 0; ix < nx; ix++) {
        const x = ctx.region.minX + ix * res;
        let m = params.base;
        if (segs.length) {
          let best = Infinity;
          for (const s of segs) best = Math.min(best, distToSegment(x, y, s));
          if (best < R) m = Math.min(1, params.base + params.boost * (1 - best / R));
        }
        ctx.write({ x, y }, m);
      }
    }
  },
};

type Seg = [WorldPosA, WorldPosA];
type WorldPosA = { x: number; y: number };

function collectSegments(river: Field | import('@world/core').FeatureSet | undefined): Seg[] {
  if (!river || river instanceof Field) return [];
  const segs: Seg[] = [];
  for (const f of river.all()) {
    if (f.kind !== 'line') continue;
    const pts = f.points;
    for (let i = 0; i + 1 < pts.length; i++) segs.push([pts[i], pts[i + 1]]);
  }
  return segs;
}

function distToSegment(x: number, y: number, [a, b]: Seg): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2));
  const px = a.x + t * dx;
  const py = a.y + t * dy;
  return Math.hypot(x - px, y - py);
}
