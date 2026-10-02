/** 统一世界坐标。单位由 schema 记录，核心不做换算或校验（charter §27；技术默认值：只记录不校验）。 */
export interface WorldPos {
  x: number;
  y: number;
}

/** 轴对齐世界区域，半开区间 [min, max)。 */
export interface Region {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** tile 寻址（接口 day-1，ADR-0007：Phase-1 只实例化一个 tile）。 */
export interface TileCoord {
  lod: number;
  tx: number;
  ty: number;
}

export function regionSize(r: Region): { w: number; h: number } {
  return { w: r.maxX - r.minX, h: r.maxY - r.minY };
}

export function regionsIntersect(a: Region, b: Region): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}

export function regionContains(r: Region, p: WorldPos): boolean {
  return p.x >= r.minX && p.x < r.maxX && p.y >= r.minY && p.y < r.maxY;
}

export function tileKey(c: TileCoord): string {
  return `${c.lod}:${c.tx}:${c.ty}`;
}
