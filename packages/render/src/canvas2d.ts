import type { Field } from '@world/core';
import type { FieldLayerStyle, FeatureLayerStyle, RenderBackend, RenderInput, SceneLayer } from './scene';

/**
 * Canvas2D 适配器（charter 34/35）：唯一的 DOM 感知文件。
 * 同一 Field 可经 heatmap 或 isoline 渲染（charter 35）；样式缺失时按数据形态给默认渲染（charter 36）。
 */

type RGB = [number, number, number];

/** 默认 colormap：灰度（未知 semantic 的中性回退，charter 36）。 */
const gray = (v: number): RGB => {
  const c = Math.max(0, Math.min(255, Math.round(v * 255)));
  return [c, c, c];
};

const CATEGORICAL_FALLBACK: RGB[] = [
  [219, 202, 141], // 0 沙黄
  [124, 175, 108], // 1 草绿
  [58, 112, 70], // 2 深绿
  [96, 125, 158], // 3
  [158, 96, 96], // 4
];

function normalize(field: Field, vs: { x: number; y: number; width: number; height: number }): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  const nodata = field.def.nodata;
  const res = field.def.resolution;
  const nx = Math.round(vs.width / res);
  const ny = Math.round(vs.height / res);
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const v = field.sample({ x: vs.x + ix * res, y: vs.y + iy * res }) as number;
      if (v === nodata) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return { min: Number.isFinite(min) ? min : 0, max: Number.isFinite(max) ? max : 1 };
}

function drawFieldLayer(
  ctx: CanvasRenderingContext2D,
  layer: Extract<SceneLayer, { kind: 'field' }>,
  vs: RenderInput['viewport'],
): void {
  const field = layer.data;
  const d = field.def;
  const res = d.resolution;
  const nx = Math.round(vs.width / res);
  const ny = Math.round(vs.height / res);
  const style = layer.style;
  const img = ctx.createImageData(nx, ny);
  const px = img.data;
  const put = (i: number, c: RGB) => {
    px[i * 4] = c[0];
    px[i * 4 + 1] = c[1];
    px[i * 4 + 2] = c[2];
    px[i * 4 + 3] = Math.round((style.opacity ?? 1) * 255);
  };

  if (style.kind === 'categorical') {
    const palette = (x: number): RGB => style.palette?.[x] ?? CATEGORICAL_FALLBACK[x % CATEGORICAL_FALLBACK.length];
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const v = field.sample({ x: vs.x + ix * res, y: vs.y + iy * res }) as number;
        const i = iy * nx + ix;
        if (v === d.nodata) continue;
        put(i, palette(v));
      }
    }
  } else if (style.kind === 'heatmap') {
    const { min, max } = normalize(field, vs);
    const span = max - min || 1;
    const cmap = style.colormap ?? gray;
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const v = field.sample({ x: vs.x + ix * res, y: vs.y + iy * res }) as number;
        const i = iy * nx + ix;
        if (v === d.nodata) continue;
        put(i, cmap((v - min) / span));
      }
    }
  } else {
    // isoline：像素级等值线——与右/下邻居跨越等值级时描暗点（同一数据、另一渲染器，charter 35）
    const { min, max } = normalize(field, vs);
    const span = max - min || 1;
    const levels = style.levels ?? 8;
    const step = span / levels;
    const val = (ix: number, iy: number): number | undefined => {
      if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) return undefined;
      const v = field.sample({ x: vs.x + ix * res, y: vs.y + iy * res }) as number;
      return v === d.nodata ? undefined : v;
    };
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const v = val(ix, iy);
        const i = iy * nx + ix;
        if (v === undefined) continue;
        const r = val(ix + 1, iy);
        const b = val(ix, iy + 1);
        const cross = (a?: number, bb?: number) =>
          a !== undefined && bb !== undefined && Math.floor((a - min) / step) !== Math.floor((bb - min) / step);
        put(i, cross(v, r) || cross(v, b) ? [30, 30, 30] : [236, 236, 226]);
      }
    }
  }

  // 写入画布：世界 res → 画布像素缩放（一次性 putImageData + drawImage）
  const tmp = document.createElement('canvas');
  tmp.width = nx;
  tmp.height = ny;
  tmp.getContext('2d')!.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, nx, ny, 0, 0, nx * res, ny * res);
}

function drawFeatureLayer(ctx: CanvasRenderingContext2D, layer: Extract<SceneLayer, { kind: 'feature' }>): void {
  const style = layer.style;
  ctx.strokeStyle = style.stroke ?? '#1f4e79';
  ctx.fillStyle = style.fill ?? style.stroke ?? '#1f4e79';
  ctx.lineWidth = style.width ?? 2;
  for (const f of layer.data.all()) {
    if (f.kind === 'line') {
      ctx.beginPath();
      ctx.moveTo(f.points[0].x, f.points[0].y);
      for (let i = 1; i < f.points.length; i++) ctx.lineTo(f.points[i].x, f.points[i].y);
      ctx.stroke();
    } else if (f.kind === 'point') {
      ctx.beginPath();
      ctx.arc(f.pos.x, f.pos.y, style.pointRadius ?? 3, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // polygon：外环
      ctx.beginPath();
      ctx.moveTo(f.ring[0]!.x, f.ring[0]!.y);
      for (let i = 1; i < f.ring.length; i++) ctx.lineTo(f.ring[i]!.x, f.ring[i]!.y);
      ctx.closePath();
      if (style.fill) ctx.fill();
      ctx.stroke();
    }
  }
}

function drawOverlays(ctx: CanvasRenderingContext2D, input: RenderInput): void {
  for (const ov of input.overlays) {
    ctx.strokeStyle = ov.color;
    ctx.lineWidth = 1;
    for (const r of ov.rects) {
      ctx.strokeRect(r.minX, r.minY, r.maxX - r.minX, r.maxY - r.minY);
    }
  }
}

/** Canvas2D 后端。surface 必须是 CanvasRenderingContext2D（adapter 私有约定）。 */
export const canvas2dBackend: RenderBackend = {
  render(input: RenderInput, surface: unknown): void {
    const ctx = surface as CanvasRenderingContext2D;
    ctx.save();
    ctx.fillStyle = input.background ?? '#0d0d10';
    ctx.fillRect(input.viewport.x, input.viewport.y, input.viewport.width, input.viewport.height);
    for (const layer of input.layers) {
      if (layer.kind === 'field') drawFieldLayer(ctx, layer, input.viewport);
      else drawFeatureLayer(ctx, layer);
    }
    drawOverlays(ctx, input);
    ctx.restore();
  },
};

/** 样式表：semantic → field 样式（editor 组装 SceneLayer 用；未知 semantic 落到默认，charter 36）。 */
export const defaultFieldStyle = (semantic: string, kind: 'scalar' | 'categorical'): FieldLayerStyle => {
  if (kind === 'categorical') return { kind: 'categorical' };
  switch (semantic) {
    case 'elevation':
      return { kind: 'heatmap', colormap: (v) => [40 + v * 90, 90 + v * 110, 60 + v * 100] };
    case 'moisture':
      return { kind: 'heatmap', colormap: (v) => [200 - v * 160, 220 - v * 60, 255] };
    case 'slope':
      return { kind: 'isoline' };
    default:
      return { kind: 'heatmap' }; // 未知 semantic：灰度默认渲染（charter 36）
  }
};

export const defaultFeatureStyle = (semantic: string): FeatureLayerStyle => {
  switch (semantic) {
    case 'river':
      return { stroke: '#2f7fd1', width: 2 };
    case 'oasis':
      return { fill: '#37b24d', pointRadius: 3 };
    default:
      return { stroke: '#999' }; // 未知 semantic：灰线默认（charter 36）
  }
};
