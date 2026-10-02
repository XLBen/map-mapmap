import { describe, expect, test, vi } from 'vitest';
import { FeatureSet, Field, SemanticRegistry } from '@world/core';
import type { RenderInput, SceneLayer } from '../src/scene';
import { canvas2dBackend, defaultFeatureStyle, defaultFieldStyle } from '../src';

const registry = new SemanticRegistry();
registry.register({ semantic: 'elevation', dataType: { family: 'field', field: 'scalar' } });
registry.register({ semantic: 'river', dataType: { family: 'feature', feature: 'line' } });

function makeField(): Field {
  const f = new Field({ semantic: 'elevation', kind: 'scalar', width: 4, height: 4, origin: { x: 0, y: 0 }, resolution: 1, tileSize: 4, lodLevels: 1, nodata: -9999 });
  f.fill((p) => p.x + p.y * 2);
  return f;
}

/** 最小 DOM 桩：createImageData + tmp canvas（backend 私有缩放路径用）。 */
function stubDom(ctx: MockCtx): void {
  const fakeCtx = { putImageData: (img: unknown) => ctx.calls.push(['tmp.putImageData', img]), fillRect: () => {} };
  (globalThis as Record<string, unknown>).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => fakeCtx }),
  };
}

type Call = [string, ...unknown[]];
type MockCtx = {
  calls: Call[];
  images: Array<{ data: Uint8ClampedArray; width: number; height: number }>;
};

function makeCtx(): { ctx: CanvasRenderingContext2D; mock: MockCtx } {
  const mock: MockCtx = { calls: [], images: [] };
  const ctx = {
    save: vi.fn(() => mock.calls.push(['save'])),
    restore: vi.fn(() => mock.calls.push(['restore'])),
    fillRect: vi.fn((x: number, y: number, w: number, h: number) => mock.calls.push(['fillRect', x, y, w, h])),
    strokeRect: vi.fn((...a: unknown[]) => mock.calls.push(['strokeRect', ...a])),
    drawImage: vi.fn((img: { width: number; height: number }, ...rest: unknown[]) => {
      mock.calls.push(['drawImage', img.width, img.height, ...rest]);
    }),
    createImageData: vi.fn((w: number, h: number) => {
      const img = { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
      mock.images.push(img);
      return img;
    }),
    beginPath: vi.fn(() => mock.calls.push(['beginPath'])),
    moveTo: vi.fn((...a: unknown[]) => mock.calls.push(['moveTo', ...a])),
    lineTo: vi.fn((...a: unknown[]) => mock.calls.push(['lineTo', ...a])),
    closePath: vi.fn(() => mock.calls.push(['closePath'])),
    arc: vi.fn((...a: unknown[]) => mock.calls.push(['arc', ...a])),
    stroke: vi.fn(() => mock.calls.push(['stroke'])),
    fill: vi.fn(() => mock.calls.push(['fill'])),
    imageSmoothingEnabled: true,
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
  } as unknown as CanvasRenderingContext2D;
  return { ctx, mock };
}

const viewport = { x: 0, y: 0, width: 4, height: 4 };

describe('Canvas2D 后端（charter 34/35/36）', () => {
  test('heatmap 与 isoline 渲染同一 Field，产出不同像素（charter 35）', () => {
    const field = makeField();
    const a = makeCtx();
    stubDom(a.mock);
    canvas2dBackend.render({ layers: [{ semantic: 'elevation', kind: 'field', data: field, style: { kind: 'heatmap' } }], overlays: [], viewport }, a.ctx);
    const heat = a.mock.images[0]!.data.slice();

    const b = makeCtx();
    stubDom(b.mock);
    canvas2dBackend.render({ layers: [{ semantic: 'elevation', kind: 'field', data: field, style: { kind: 'isoline' } }], overlays: [], viewport }, b.ctx);
    const iso = b.mock.images[0]!.data;

    let diff = 0;
    for (let i = 0; i < heat.length; i++) if (heat[i] !== iso[i]) diff++;
    expect(diff).toBeGreaterThan(0); // 同一数据、两种渲染器、视觉不同
  });

  test('feature 层触发路径绘制；overlays 画矩形（charter 38 Debug 用）', () => {
    const fs = new FeatureSet({ semantic: 'river', kind: 'line' });
    fs.add({ kind: 'line', id: 'r1', semantic: 'river', points: [{ x: 1, y: 1 }, { x: 3, y: 2 }], attributes: {} });
    const c = makeCtx();
    canvas2dBackend.render(
      {
        layers: [{ semantic: 'river', kind: 'feature', data: fs, style: { stroke: '#2f7fd1' } }],
        overlays: [{ label: 'dirty', color: '#e33', rects: [{ minX: 0, minY: 0, maxX: 2, maxY: 2 }] }],
        viewport,
      },
      c.ctx,
    );
    const names = c.mock.calls.map((x) => x[0]);
    expect(names).toContain('moveTo');
    expect(names).toContain('lineTo');
    expect(names).toContain('stroke');
    expect(names).toContain('strokeRect');
  });

  test('未知 semantic 按声明获得默认渲染（charter 36）：标量→灰度 heatmap，要素→灰线', () => {
    const fs = defaultFieldStyle('totally.unknown', 'scalar');
    expect(fs.kind).toBe('heatmap');
    expect(fs.colormap).toBeUndefined(); // 缺省 → 后端灰度回退
    const fl = defaultFeatureStyle('mystery.layer');
    expect(fl.stroke).toBe('#999');
  });

  test('RenderInput 组装自纯数据 + resolved data（charter 54 由调用方保证）', () => {
    const fs = new FeatureSet({ semantic: 'river', kind: 'line' });
    const input: RenderInput = {
      layers: [{ semantic: 'river', kind: 'feature', data: fs, style: defaultFeatureStyle('river') }],
      overlays: [],
      viewport,
    };
    const layers: SceneLayer[] = input.layers;
    expect(layers[0]!.semantic).toBe('river');
  });
});
