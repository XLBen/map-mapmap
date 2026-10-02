import type { Region, TileCoord, WorldPos } from './coords';
import { tileKey } from './coords';

export type FieldKind = 'scalar' | 'vector' | 'categorical';

/** 场的几何与声明。tileSize / lodLevels 是接口（Q4/ADR-0007）：day-1 进核心，Phase-1 只实例化单 tile。 */
export interface FieldDef {
  semantic: string;
  kind: FieldKind;
  /** 采样数（lod 0 基准层）。 */
  width: number;
  height: number;
  origin: WorldPos;
  /** 世界单位 / 采样。 */
  resolution: number;
  tileSize: number;
  lodLevels: number;
  unit?: string;
  nodata: number;
}

/** 查询统计，按 kind 区分。 */
export type FieldStats =
  | { kind: 'scalar'; count: number; nodataCount: number; min: number; max: number; mean: number }
  | {
      kind: 'vector';
      count: number;
      nodataCount: number;
      minLength: number;
      maxLength: number;
      meanLength: number;
    }
  | { kind: 'categorical'; count: number; counts: Record<string, number> };

export type FieldValue = number | [number, number];

const strideOf = (lod: number): number => 1 << lod;

/**
 * 空间上处处有值的数据（Field）。统一访问只有 sample(worldPos)/query(region)；
 * 数组坐标只出现在构建路径（fill/setTile），不进入消费接口。
 */
export class Field {
  readonly def: FieldDef;
  private readonly legend?: Record<string, number>;
  private readonly legendInverse: Record<number, string>;
  // ponytail: 单一 Float32 存储（categorical 码是 ≤255 的小整数，精确可存）；图例超 256 或需数值稳定时再换 Uint8/分表
  private readonly tiles = new Map<string, Float32Array>();

  constructor(def: FieldDef, legend?: Record<string, number>) {
    if (def.width <= 0 || def.height <= 0) throw new Error('Field 尺寸必须为正');
    if (def.resolution <= 0) throw new Error('resolution 必须为正');
    if (def.tileSize <= 0 || def.lodLevels <= 0) throw new Error('tileSize/lodLevels 必须为正');
    this.def = def;
    this.legend = legend;
    this.legendInverse = Object.fromEntries(
      Object.entries(legend ?? {}).map(([name, code]) => [code, name]),
    );
  }

  get bounds(): Region {
    const d = this.def;
    return {
      minX: d.origin.x,
      minY: d.origin.y,
      maxX: d.origin.x + d.width * d.resolution,
      maxY: d.origin.y + d.height * d.resolution,
    };
  }

  /** 类别名列表（categorical）。 */
  get categories(): readonly string[] {
    return Object.keys(this.legend ?? {});
  }

  lodWidth(lod = 0): number {
    return Math.ceil(this.def.width / strideOf(lod));
  }

  lodHeight(lod = 0): number {
    return Math.ceil(this.def.height / strideOf(lod));
  }

  /** 类别名称（categorical 用）；非 categorical 或未知码返回 undefined。 */
  categoryName(p: WorldPos, lod = 0): string | undefined {
    const v = this.sample(p, lod);
    if (typeof v !== 'number') return undefined;
    return this.legendInverse[v] ?? `code:${v}`;
  }

  /** 最近邻采样；越界返回 nodata。lod 经 stride 寻址取基准层样本，不维护金字塔存储（ADR-0007）。 */
  sample(p: WorldPos, lod = 0): FieldValue {
    const d = this.def;
    const s = strideOf(lod);
    const lx = Math.floor((p.x - d.origin.x) / (d.resolution * s));
    const ly = Math.floor((p.y - d.origin.y) / (d.resolution * s));
    if (lx < 0 || ly < 0 || lx >= this.lodWidth(lod) || ly >= this.lodHeight(lod)) return d.nodata;
    return this.sampleBase(lx * s, ly * s);
  }

  /** 区域统计（含边界裁剪到场的范围）。 */
  query(r: Region, lod = 0): FieldStats {
    const d = this.def;
    const s = strideOf(lod);
    const x0 = Math.max(0, Math.floor((r.minX - d.origin.x) / (d.resolution * s)));
    const y0 = Math.max(0, Math.floor((r.minY - d.origin.y) / (d.resolution * s)));
    const x1 = Math.min(this.lodWidth(lod), Math.ceil((r.maxX - d.origin.x) / (d.resolution * s)));
    const y1 = Math.min(this.lodHeight(lod), Math.ceil((r.maxY - d.origin.y) / (d.resolution * s)));

    let count = 0;
    let nodataCount = 0;
    if (d.kind === 'categorical') {
      const counts: Record<string, number> = {};
      for (let ly = y0; ly < y1; ly++) {
        for (let lx = x0; lx < x1; lx++) {
          count++;
          const v = this.sampleBase(lx * s, ly * s) as number;
          if (v === d.nodata) nodataCount++;
          const name = this.legendInverse[v] ?? `code:${v}`;
          counts[name] = (counts[name] ?? 0) + 1;
        }
      }
      return { kind: 'categorical', count, counts };
    }

    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (let ly = y0; ly < y1; ly++) {
      for (let lx = x0; lx < x1; lx++) {
        count++;
        const v = this.sampleBase(lx * s, ly * s);
        if (d.kind === 'vector') {
          const [vx, vy] = v as [number, number];
          if (vx === d.nodata && vy === d.nodata) {
            nodataCount++;
            continue;
          }
          const len = Math.hypot(vx, vy);
          if (len < min) min = len;
          if (len > max) max = len;
          sum += len;
        } else {
          const value = v as number;
          if (value === d.nodata) {
            nodataCount++;
            continue;
          }
          if (value < min) min = value;
          if (value > max) max = value;
          sum += value;
        }
      }
    }
    const valid = count - nodataCount;
    const mean = valid > 0 ? sum / valid : NaN;
    return d.kind === 'vector'
      ? {
          kind: 'vector',
          count,
          nodataCount,
          minLength: valid ? min : NaN,
          maxLength: valid ? max : NaN,
          meanLength: mean,
        }
      : { kind: 'scalar', count, nodataCount, min: valid ? min : NaN, max: valid ? max : NaN, mean };
  }

  /** 构建路径：按世界坐标逐采样填充（数组坐标不外泄给消费方）。 */
  fill(f: (p: WorldPos) => FieldValue): void {
    const d = this.def;
    for (let sy = 0; sy < d.height; sy++) {
      for (let sx = 0; sx < d.width; sx++) {
        const p = { x: d.origin.x + sx * d.resolution, y: d.origin.y + sy * d.resolution };
        this.setBase(sx, sy, f(p));
      }
    }
  }

  /** 构建/批量通道（供内部与后续处理器视图用）。 */
  getTile(tx: number, ty: number): Float32Array | undefined {
    return this.tiles.get(tileKey({ lod: 0, tx, ty }));
  }

  setTile(tx: number, ty: number, data: Float32Array): void {
    const d = this.def;
    const comps = d.kind === 'vector' ? 2 : 1;
    const expected = d.tileSize * d.tileSize * comps;
    if (data.length !== expected) throw new Error(`tile 数据长度应为 ${expected}`);
    this.tiles.set(tileKey({ lod: 0, tx, ty }), data);
  }

  tileCoordOf(p: WorldPos): TileCoord {
    const d = this.def;
    const s = strideOf(0);
    return {
      lod: 0,
      tx: Math.floor((p.x - d.origin.x) / (d.resolution * d.tileSize * s)),
      ty: Math.floor((p.y - d.origin.y) / (d.resolution * d.tileSize * s)),
    };
  }

  private sampleBase(sx: number, sy: number): FieldValue {
    const d = this.def;
    const comps = d.kind === 'vector' ? 2 : 1;
    const tileSx = Math.floor(sx / d.tileSize);
    const tileSy = Math.floor(sy / d.tileSize);
    const tile = this.tiles.get(tileKey({ lod: 0, tx: tileSx, ty: tileSy }));
    if (!tile) return d.nodata;
    const localX = sx - tileSx * d.tileSize;
    const localY = sy - tileSy * d.tileSize;
    const idx = (localY * d.tileSize + localX) * comps;
    return d.kind === 'vector' ? [tile[idx], tile[idx + 1]] : tile[idx];
  }

  private setBase(sx: number, sy: number, v: FieldValue): void {
    const d = this.def;
    const tileSx = Math.floor(sx / d.tileSize);
    const tileSy = Math.floor(sy / d.tileSize);
    const key = tileKey({ lod: 0, tx: tileSx, ty: tileSy });
    let tile = this.tiles.get(key);
    if (!tile) {
      const comps = d.kind === 'vector' ? 2 : 1;
      tile = new Float32Array(d.tileSize * d.tileSize * comps);
      tile.fill(d.nodata);
      this.tiles.set(key, tile);
    }
    const localX = sx - tileSx * d.tileSize;
    const localY = sy - tileSy * d.tileSize;
    const comps = d.kind === 'vector' ? 2 : 1;
    const idx = (localY * d.tileSize + localX) * comps;
    if (d.kind === 'vector' && Array.isArray(v)) {
      tile[idx] = v[0];
      tile[idx + 1] = v[1];
    } else if (typeof v === 'number') {
      tile[idx] = v;
    }
  }
}
