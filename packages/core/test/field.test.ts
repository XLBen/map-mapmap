import { describe, expect, test } from 'vitest';
import { SemanticRegistry } from '../src/registry';

const registry = new SemanticRegistry();
registry.register({
  semantic: 'elevation',
  dataType: { family: 'field', field: 'scalar' },
  capabilities: ['sample', 'query'],
});
registry.register({
  semantic: 'flow',
  dataType: { family: 'field', field: 'vector' },
});
registry.register({
  semantic: 'landcover',
  dataType: { family: 'field', field: 'categorical' },
});

const NODATA = -9999;
const elevation = registry.createField('elevation', {
  width: 8,
  height: 6,
  origin: { x: 0, y: 0 },
  resolution: 10,
  tileSize: 4,
  lodLevels: 3,
  unit: 'm',
  nodata: NODATA,
  fill: (p) => (p.x >= 40 && p.y < 20 ? NODATA : p.x + p.y),
});

describe('Field：scalar（经注册路径创建的 elevation）', () => {
  test('sample：最近邻 + 越界 nodata', () => {
    expect(elevation.sample({ x: 25, y: 5 })).toBe(20);
    expect(elevation.sample({ x: 45, y: 5 })).toBe(NODATA); // p.x>=40 且 p.y<20 → 构建时置 nodata
    expect(elevation.sample({ x: 85, y: 5 })).toBe(NODATA); // 越界
    expect(elevation.sample({ x: -1, y: 5 })).toBe(NODATA);
  });

  test('query：min/max/mean 排除 nodata', () => {
    const s = elevation.query({ minX: 0, minY: 0, maxX: 80, maxY: 60 });
    expect(s.kind).toBe('scalar');
    if (s.kind !== 'scalar') return;
    expect(s.count).toBe(48);
    expect(s.nodataCount).toBe(8);
    expect(s.min).toBe(0);
    expect(s.max).toBe(120);
    expect(s.mean).toBeCloseTo(2400 / 40, 6);
  });

  test('tile：按 tileSize 分块，setTile/getTile 往返', () => {
    expect(elevation.getTile(0, 0)?.length).toBe(16);
    expect(elevation.getTile(1, 1)?.length).toBe(16);
    expect(elevation.getTile(5, 5)).toBeUndefined();
    expect(elevation.tileCoordOf({ x: 45, y: 5 })).toEqual({ lod: 0, tx: 1, ty: 0 });

    const empty = registry.createField('elevation', {
      width: 8,
      height: 4,
      origin: { x: 0, y: 0 },
      resolution: 10,
      tileSize: 4,
      nodata: NODATA,
      fill: () => NODATA,
    });
    const data = new Float32Array(16);
    data[0] = 42;
    empty.setTile(0, 0, data);
    expect(empty.sample({ x: 0, y: 0 })).toBe(42);
    expect(empty.sample({ x: 50, y: 0 })).toBe(NODATA); // tile (1,0) 未填充
    expect(() => empty.setTile(0, 0, new Float32Array(3))).toThrow();
  });

  test('LOD：stride 寻址（接口先行，无金字塔存储）', () => {
    expect(elevation.lodWidth(1)).toBe(4);
    expect(elevation.lodHeight(1)).toBe(3);
    expect(elevation.sample({ x: 25, y: 5 }, 1)).toBe(20);
    const s = elevation.query({ minX: 0, minY: 0, maxX: 80, maxY: 60 }, 1);
    if (s.kind !== 'scalar') return;
    expect(s.count).toBe(12);
    expect(s.nodataCount).toBe(2);
    expect(s.min).toBe(0);
    expect(s.max).toBe(100);
  });
});

describe('Field：vector', () => {
  const flow = registry.createField('flow', {
    width: 4,
    height: 4,
    origin: { x: 0, y: 0 },
    resolution: 1,
    fill: (p) => [1, p.y],
  });

  test('sample 返回分量', () => {
    expect(flow.sample({ x: 1.5, y: 2.5 })).toEqual([1, 2]);
  });

  test('query 统计矢量长度', () => {
    const s = flow.query(flow.bounds);
    if (s.kind !== 'vector') return expect.fail('应为 vector 统计');
    expect(s.count).toBe(16);
    expect(s.nodataCount).toBe(0);
    expect(s.minLength).toBeCloseTo(1, 6);
    expect(s.maxLength).toBeCloseTo(Math.sqrt(10), 6);
    expect(s.meanLength).toBeCloseTo((1 + Math.SQRT2 + Math.sqrt(5) + Math.sqrt(10)) / 4, 6);
  });
});

describe('Field：categorical', () => {
  const landcover = registry.createField('landcover', {
    width: 4,
    height: 4,
    origin: { x: 0, y: 0 },
    resolution: 1,
    legend: { water: 0, grass: 1, rock: 2 },
    fill: (p) => (p.x < 2 ? 0 : 1),
  });

  test('sample + categoryName', () => {
    expect(landcover.sample({ x: 0, y: 0 })).toBe(0);
    expect(landcover.categoryName({ x: 0, y: 0 })).toBe('water');
    expect(landcover.categoryName({ x: 3, y: 0 })).toBe('grass');
  });

  test('query 类别直方图', () => {
    const s = landcover.query(landcover.bounds);
    expect(s).toEqual({ kind: 'categorical', count: 16, counts: { water: 8, grass: 8 } });
    expect(landcover.categories).toEqual(['water', 'grass', 'rock']);
  });
});
