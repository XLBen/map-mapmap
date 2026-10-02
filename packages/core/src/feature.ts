import type { Region, WorldPos } from './coords';

export type FeatureKind = 'point' | 'line' | 'polygon';

export interface FeatureBase {
  id: string;
  semantic: string;
  attributes: Record<string, unknown>;
}

export interface PointFeature extends FeatureBase {
  kind: 'point';
  pos: WorldPos;
}

export interface LineFeature extends FeatureBase {
  kind: 'line';
  points: WorldPos[];
}

export interface PolygonFeature extends FeatureBase {
  kind: 'polygon';
  ring: WorldPos[];
}

export type Feature = PointFeature | LineFeature | PolygonFeature;

function bboxOf(f: Feature): Region {
  const pts =
    f.kind === 'point' ? [f.pos] : f.kind === 'line' ? f.points : f.ring;
  if (pts.length === 0) throw new Error(`空几何: ${f.id}`);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** 离散对象集合（Feature）。世界语义只有 query(region)；几何按世界坐标存取。 */
export class FeatureSet {
  readonly semantic: string;
  readonly kind: FeatureKind;
  #features: Feature[] = [];

  constructor(args: { semantic: string; kind: FeatureKind }) {
    this.semantic = args.semantic;
    this.kind = args.kind;
  }

  get size(): number {
    return this.#features.length;
  }

  all(): readonly Feature[] {
    return this.#features;
  }

  /** 信任边界：kind 不匹配直接拒绝。 */
  add(f: Feature): void {
    this.#validate(f);
    this.#features.push(f);
  }

  /** 原位替换（modify 的底座），校验同 add。 */
  replaceAt(index: number, f: Feature): void {
    if (index < 0 || index >= this.#features.length) throw new Error('replaceAt 越界');
    this.#validate(f);
    this.#features[index] = f;
  }

  #validate(f: Feature): void {
    if (f.kind !== this.kind || f.semantic !== this.semantic) {
      throw new Error(`要素与集合不匹配: 期望 ${this.kind}/${this.semantic}，收到 ${f.kind}/${f.semantic}`);
    }
    bboxOf(f); // 空几何在这里拒绝
  }

  // ponytail: O(n) 线性扫描 + bbox 相交；要素过万再考虑网格/R-tree 索引
  query(r: Region): Feature[] {
    return this.#features.filter((f) => {
      const b = bboxOf(f);
      return b.minX < r.maxX && r.minX < b.maxX && b.minY < r.maxY && r.minY < b.maxY;
    });
  }
}
