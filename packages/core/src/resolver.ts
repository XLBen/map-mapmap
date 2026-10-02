import { Field } from './field';
import { FeatureSet } from './feature';
import type { Region } from './coords';
import type { World } from './authoring';
import type { DataId, SpatialData } from './spatial';
import type { Engine } from './engine';
import type { PinOp } from './authoring';

export type ConflictKind = 'override-vs-pin' | 'constraint-violated' | 'suppressed-target-missing';

/** Conflict 只标记/警告/建议，不自动纠正（charter 14/50）；数据可查（charter 53）。 */
export interface Conflict {
  kind: ConflictKind;
  message: string;
  target?: string;
  region?: Region;
}

export interface ResolvedItem {
  semantic: string;
  source: 'authored' | 'generated' | 'fallback';
  data?: Field | FeatureSet;
  lineage: Array<{ dataId: DataId; source: string; processorId?: string }>;
  conflicts: Conflict[];
}

const overlaps = (a: Region, b: Region): boolean =>
  a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;

const contains = (r: Region, x: number, y: number): boolean =>
  x >= r.minX && x < r.maxX && y >= r.minY && y < r.maxY;

/**
 * Resolver（charter 55，核心一等组件）：
 * 槽位优先级 Explicit Override > Authored > Generated > Fallback（charter 51，禁 last-run-wins）。
 * 对象级抑制在此过滤生成的 FeatureSet（数据本体不破坏）；空间级抑制在引擎输入侧作 mask（Q8）。
 */
export class Resolver {
  readonly world: World;
  readonly engine: Engine;
  #last = new Map<string, Conflict[]>();

  constructor(world: World, engine: Engine) {
    this.world = world;
    this.engine = engine;
  }

  /** 槽位基座选择：authored > generated；同侧多候选报歧义。 */
  pickBase(semantic: string): {
    dataId: DataId;
    data: Field | FeatureSet;
    source: 'authored' | 'generated';
    processorId?: string;
  } | undefined {
    const authored: Array<{ dataId: DataId; data: Field | FeatureSet }> = [];
    for (const id of this.world.dataIds()) {
      const d = this.world.data(id);
      if (!d) continue;
      if (this.#semanticOf(d) === semantic) authored.push({ dataId: id, data: d });
    }
    if (authored.length > 1) throw new Error(`semantic ${semantic} 有 ${authored.length} 份作者数据，槽位歧义`);
    if (authored.length === 1) return { ...authored[0], source: 'authored' };

    const gen: Array<{ dataId: DataId; data: Field | FeatureSet; processorId: string }> = [];
    for (const iid of this.engine.instanceIds()) {
      const def = this.engine.processorOf(iid);
      if (def.output.semantic !== semantic) continue;
      const d = this.engine.dataOf(iid);
      if (d) gen.push({ dataId: `gen:${iid}`, data: d, processorId: def.id });
    }
    if (gen.length > 1) throw new Error(`semantic ${semantic} 有 ${gen.length} 个生成候选，槽位歧义`);
    if (gen.length === 1) {
      return { dataId: gen[0].dataId, data: gen[0].data, source: 'generated', processorId: gen[0].processorId };
    }
    return undefined;
  }

  /** 解析一个 semantic 的最终数据（含 Override / 对象抑制 / Constraint 检查）。 */
  resolve(semantic: string): ResolvedItem {
    const intents = this.world.intents();
    const conflicts: Conflict[] = [];
    const lineage: ResolvedItem['lineage'] = [];
    const base = this.pickBase(semantic);
    if (!base) {
      const item: ResolvedItem = { semantic, source: 'fallback', lineage, conflicts };
      this.#last.set(semantic, conflicts);
      return item;
    }
    lineage.push({ dataId: base.dataId, source: base.source, processorId: base.processorId });
    let data: Field | FeatureSet = base.data;

    // 1) Override（charter 15）：按 seq 序应用于副本，原数据零改动（charter 21）
    const pins = intents.filter((o): o is PinOp => o.kind === 'pin');
    const overrides = intents.filter((o) => o.kind === 'override' && o.dataId === base.dataId);
    if (data instanceof Field && overrides.length) {
      const copy = this.#cloneField(data);
      for (const op of overrides) {
        if (op.kind !== 'override') continue;
        const region = op.region ?? copy.bounds;
        const pinned = pins.find((p) => this.#pinBlocks(p, base.dataId, region, op.attribute));
        if (pinned) {
          conflicts.push({ kind: 'override-vs-pin', message: 'Override 与 Pin 冲突，未应用（只标记不纠正，charter 50）', target: base.dataId, region });
          continue;
        }
        this.#patchField(copy, region, op.value);
      }
      data = copy;
    }

    // 2) 对象级抑制（charter 16/17，Q2）：生成的 FeatureSet 按 lineageId 过滤
    if (data instanceof FeatureSet && base.source === 'generated') {
      const sup = intents.filter((o) => o.kind === 'suppress' && o.semantic === semantic);
      if (sup.length) {
        const ids = new Set(sup.map((o) => (o.kind === 'suppress' ? o.targetFeatureId : '')));
        const fs = this.world.registry.createFeatureSet(semantic);
        const found = new Set<string>();
        for (const f of data.all()) {
          if (ids.has(f.id)) {
            found.add(f.id);
            continue; // 排除但生成数据本体不动
          }
          fs.add(f);
        }
        for (const o of sup) {
          if (o.kind === 'suppress' && !found.has(o.targetFeatureId)) {
            conflicts.push({ kind: 'suppressed-target-missing', message: `抑制目标不存在: ${o.targetFeatureId}`, target: o.targetFeatureId });
          }
        }
        data = fs;
      }
    }

    // 3) Constraint（Q9：只存储 + Conflict 显示，不求解；v0 检查口径 = 字段均值）
    for (const op of intents) {
      if (op.kind !== 'constraint' || op.dataId !== base.dataId) continue;
      if (!(data instanceof Field)) continue;
      const stats = data.query(data.bounds);
      if (!('mean' in stats)) continue;
      const mean = stats.mean;
      const ok =
        op.op === '>=' ? mean >= (op.value as number)
        : op.op === '<=' ? mean <= (op.value as number)
        : op.op === '==' ? mean === op.value
        : Array.isArray(op.value) && (op.value as number[]).includes(mean);
      if (!ok) {
        conflicts.push({
          kind: 'constraint-violated',
          message: `约束未满足: ${op.attribute} ${op.op} ${JSON.stringify(op.value)}（当前均值 ${mean.toFixed(4)}）`,
          target: base.dataId,
        });
      }
    }

    this.#last.set(semantic, conflicts);
    return { semantic, source: base.source, data, lineage, conflicts };
  }

  /** Conflict Map（charter 53）。 */
  conflicts(semantic?: string): Conflict[] {
    if (semantic) return this.#last.get(semantic) ?? [];
    return [...this.#last.values()].flat();
  }

  #semanticOf(d: Field | FeatureSet): string {
    return d instanceof Field ? d.def.semantic : d.semantic;
  }

  #pinBlocks(pin: PinOp, dataId: DataId, region: Region, attribute?: string): boolean {
    if (pin.kind !== 'pin') return false;
    if ('target' in pin.scope) {
      return pin.scope.target === dataId && (attribute === undefined || pin.scope.attribute === attribute);
    }
    return overlaps(pin.scope.region, region); // region pin：与改动区域相交即挡下（v0 语义）
  }

  /** 解析副本：tile 引用共享（只读契约），命中改动的 tile 才复制。 */
  #cloneField(src: Field): Field {
    const d = src.def;
    const out = this.world.registry.createField(d.semantic, {
      width: d.width,
      height: d.height,
      origin: d.origin,
      resolution: d.resolution,
      tileSize: d.tileSize,
      lodLevels: d.lodLevels,
      nodata: d.nodata,
      fill: () => d.nodata,
    });
    for (const { tx, ty } of src.tileList) {
      const t = src.getTile(tx, ty);
      if (t) out.setTile(tx, ty, t);
    }
    return out;
  }

  #patchField(f: Field, region: Region, value: unknown): void {
    const d = f.def;
    const res = d.resolution;
    const comps = d.kind === 'vector' ? 2 : 1;
    const ts = d.tileSize;
    const span = ts * res;
    const tx0 = Math.max(0, Math.floor((region.minX - d.origin.x) / span));
    const ty0 = Math.max(0, Math.floor((region.minY - d.origin.y) / span));
    const tx1 = Math.min(Math.ceil(d.width / ts) - 1, Math.floor((region.maxX - d.origin.x - 1e-9) / span));
    const ty1 = Math.min(Math.ceil(d.height / ts) - 1, Math.floor((region.maxY - d.origin.y - 1e-9) / span));
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const cur = f.getTile(tx, ty);
        if (!cur) continue;
        const arr = cur.slice();
        const ex = { minX: d.origin.x + tx * span, minY: d.origin.y + ty * span, maxX: d.origin.x + (tx + 1) * span, maxY: d.origin.y + (ty + 1) * span };
        const ix0 = Math.max(0, Math.ceil((Math.max(region.minX, ex.minX) - ex.minX) / res));
        const iy0 = Math.max(0, Math.ceil((Math.max(region.minY, ex.minY) - ex.minY) / res));
        const ix1 = Math.min(ts, Math.ceil((Math.min(region.maxX, ex.maxX) - ex.minX) / res));
        const iy1 = Math.min(ts, Math.ceil((Math.min(region.maxY, ex.maxY) - ex.minY) / res));
        for (let ly = iy0; ly < iy1; ly++) {
          for (let lx = ix0; lx < ix1; lx++) {
            const i = ly * ts + lx;
            const v = value as number | [number, number];
            if (Array.isArray(v)) {
              arr[i * 2] = v[0];
              arr[i * 2 + 1] = v[1];
            } else {
              arr[i] = v;
            }
          }
        }
        void comps;
        f.setTile(tx, ty, arr);
      }
    }
  }
}
