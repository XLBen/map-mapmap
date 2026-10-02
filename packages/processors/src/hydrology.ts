import type { Field, Feature, ProcessorDef, WorldPos } from '@world/core';

/**
 * Hydrology Processor：D8 + Priority-Flood（#4 调研结论）全量重算 v0。
 * Elevation + Rainfall → River LineFeature；对象 id 由汇流源头网格坐标决定（重建稳定，Q2 lineageId）。
 * 区域增量（Downstream 标脏）随 16384² 压测票落地；本版全量但纯函数、确定性。
 */
export const hydrologyProcessor: ProcessorDef<{ threshold: number; seed: string }> = {
  id: 'hydrology.d8',
  version: '0.1.0',
  inputs: [
    { name: 'elevation', kind: 'field', dataType: 'scalar', semantic: 'elevation' },
    { name: 'rainfall', kind: 'field', dataType: 'scalar', semantic: 'rainfall' },
  ],
  output: { kind: 'feature', dataType: 'line', semantic: 'river' },
  invalidation: { policy: { propagation: 'downstream' }, context: { padding: 0, seam: 'nodata' } },
  run(inputs, params, ctx) {
    const elev = inputs.elevation as Field;
    const rain = inputs.rainfall as Field;
    const d = elev.def;
    const res = d.resolution;
    const w = d.width;
    const h = d.height;
    const N = w * h;
    const zAt = (sx: number, sy: number): number => elev.sample({ x: d.origin.x + sx * res, y: d.origin.y + sy * res }) as number;
    const rAt = (sx: number, sy: number): number => {
      const v = rain.sample({ x: rain.def.origin.x + sx * res, y: rain.def.origin.y + sy * res });
      return v === rain.def.nodata ? 0 : (v as number);
    };

    // 1) Priority-Flood 填洼（最小堆；边界种子）
    const filled = new Float32Array(N);
    const seen = new Uint8Array(N);
    const heap: number[] = []; // 存 idx，按 filled 最小堆
    const push = (idx: number, z: number) => {
      filled[idx] = z;
      heap.push(idx);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (filled[heap[p]] <= filled[heap[i]]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]];
        i = p;
      }
    };
    const pop = (): number => {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1;
          const r = l + 1;
          let m = i;
          if (l < heap.length && filled[heap[l]] < filled[heap[m]]) m = l;
          if (r < heap.length && filled[heap[r]] < filled[heap[m]]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) push(y * w + x, zAt(x, y));
      }
    }
    const DX = [1, 1, 0, -1, -1, -1, 0, 1];
    const DY = [0, 1, 1, 1, 0, -1, -1, -1];
    while (heap.length) {
      const cur = pop();
      const cx = cur % w;
      const cy = (cur / w) | 0;
      for (let k = 0; k < 8; k++) {
        const nx = cx + DX[k];
        const ny = cy + DY[k];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (seen[ni]) continue;
        seen[ni] = 1;
        push(ni, Math.max(filled[cur], zAt(nx, ny)));
      }
    }
    const z = (sx: number, sy: number): number => filled[sy * w + sx];

    // 2) D8：最陡下降（平地按扫描序取首个不升高邻居）
    const down = new Int32Array(N).fill(-1);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let best = -1;
        let bestSlope = 0;
        for (let k = 0; k < 8; k++) {
          const nx = x + DX[k];
          const ny = y + DY[k];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const slope = (z(x, y) - z(nx, ny)) / (k % 2 === 0 ? 1 : Math.SQRT2);
          if (slope > bestSlope) {
            bestSlope = slope;
            best = ny * w + nx;
          }
        }
        down[i] = best;
      }
    }

    // 3) 汇流累积（按填洼高程降序处理；权重 = rainfall）
    const order = Array.from({ length: N }, (_, i) => i).sort((a, b) => filled[b] - filled[a]);
    const acc = new Float32Array(N);
    for (let i = 0; i < N; i++) acc[i] = rAt(i % w, (i / w) | 0);
    for (const i of order) {
      if (down[i] >= 0) acc[down[i]] += acc[i];
    }

    // 4) 河道栅格 + 河段折线（源头=无上游河网的河道格；汇流处断段）
    const isRiver = new Uint8Array(N);
    for (let i = 0; i < N; i++) isRiver[i] = acc[i] >= params.threshold ? 1 : 0;
    const inflow = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (isRiver[i] && down[i] >= 0) inflow[down[i]] += 1;
    }
    const pt = (i: number): WorldPos => ({ x: d.origin.x + (i % w) * res, y: d.origin.y + ((i / w) | 0) * res });
    const features: Feature[] = [];
    const consumed = new Uint8Array(N);
    let seg = 0;
    for (let i = 0; i < N; i++) {
      if (!isRiver[i] || consumed[i] || inflow[i] > 0) continue;
      const points: WorldPos[] = [pt(i)];
      let cur = i;
      for (;;) {
        consumed[cur] = 1;
        const nxt = down[cur];
        if (nxt < 0 || !isRiver[nxt]) break;
        points.push(pt(nxt));
        if (inflow[nxt] >= 2) break; // 汇流点收束本段，下段从汇流点起
        cur = nxt;
      }
      if (points.length < 2) continue;
      const headX = i % w;
      const headY = (i / w) | 0;
      features.push({
        kind: 'line',
        id: `river:${ctx.instanceId}:${headX}_${headY}`, // 源头网格坐标 → 重建稳定 lineageId（Q2）
        semantic: 'river',
        points,
        attributes: {
          provenance: {
            processorId: hydrologyProcessor.id,
            version: hydrologyProcessor.version,
            seed: params.seed,
            instanceId: ctx.instanceId,
            inputs: ['elevation', 'rainfall'],
          },
        },
      });
    }
    return { features };
  },
};
