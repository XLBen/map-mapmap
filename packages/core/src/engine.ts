import { Field } from './field';
import type { FeatureSet } from './feature';
import type { Region } from './coords';
import type { World } from './authoring';
import type { DataId } from './spatial';
import type { DataStatus, PortSpec, ProcessorDef } from './processor';
import { radiusOf } from './processor';
import type { SpatialData } from './spatial';

export interface GeneratedEntry {
  dataId: DataId;
  instanceId: string;
  processorId: string;
  params: Record<string, unknown>;
  status: DataStatus;
  /** 待重算区域（世界坐标，输出网格空间）。 */
  pending: Region[];
  error?: string;
  /** 上游 error 导致的 blocked（Q6）。 */
  blockedByUpstream?: string;
}

interface Instance {
  instanceId: string;
  processorId: string;
  params: Record<string, unknown>;
}

const intersect = (a: Region, b: Region): Region | undefined => {
  const r = { minX: Math.max(a.minX, b.minX), minY: Math.max(a.minY, b.minY), maxX: Math.min(a.maxX, b.maxX), maxY: Math.min(a.maxY, b.maxY) };
  return r.maxX > r.minX && r.maxY > r.minY ? r : undefined;
};

/** 矩形减法：a \ b（最多 4 块）。 */
function subtractRect(a: Region, b: Region): Region[] {
  const i = intersect(a, b);
  if (!i) return [a];
  const out: Region[] = [];
  if (i.minY > a.minY) out.push({ ...a, maxY: i.minY });
  if (i.maxY < a.maxY) out.push({ ...a, minY: i.maxY });
  if (i.minX > a.minX) out.push({ ...a, maxY: i.maxY, minY: i.minY, maxX: i.minX });
  if (i.maxX < a.maxX) out.push({ ...a, maxY: i.maxY, minY: i.minY, minX: i.maxX });
  return out;
}

/**
 * 处理引擎：Processor DAG（semantic 依赖边 + 无环校验，charter 25）+ Generated 存储 +
 * Dirty Region 真实传播与 tile 粒度局部重算（Q4：禁止退化成全图重算）。
 * 所有重算都由显式 Rebuild 触发（charter 31/32，ADR-0001 pull 模型）。
 */
export class Engine {
  readonly world: World;
  #processors = new Map<string, ProcessorDef>();
  #instances = new Map<string, Instance>();
  #generated = new Map<string, GeneratedEntry>();
  #outputs = new Map<string, Field | FeatureSet>();

  constructor(world: World) {
    this.world = world;
  }

  registerProcessor(def: ProcessorDef): void {
    if (this.#processors.has(def.id)) throw new Error(`Processor 已注册: ${def.id}`);
    this.#processors.set(def.id, def);
  }

  // ---- DAG（charter 24/25）----
  addInstance(instanceId: string, processorId: string, params: Record<string, unknown> = {}): void {
    if (this.#instances.has(instanceId)) throw new Error(`实例已存在: ${instanceId}`);
    const def = this.#processors.get(processorId);
    if (!def) throw new Error(`Processor 未注册: ${processorId}`);
    this.#instances.set(instanceId, { instanceId, processorId, params });
    this.#checkAcyclic();
    const missing = def.inputs.some((p) => !this.#resolveInput(p));
    const entry: GeneratedEntry = {
      dataId: `gen:${instanceId}`,
      instanceId,
      processorId,
      params,
      status: missing ? 'blocked' : 'outdated',
      pending: [],
    };
    if (!missing) {
      const extent = this.#extentFor(instanceId);
      if (extent) entry.pending = [extent];
    }
    this.#generated.set(instanceId, entry);
  }

  instanceIds(): string[] {
    return [...this.#instances.keys()];
  }

  entryOf(instanceId: string): GeneratedEntry {
    const e = this.#generated.get(instanceId);
    if (!e) throw new Error(`实例不存在: ${instanceId}`);
    return e;
  }

  dataOf(instanceId: string): Field | FeatureSet | undefined {
    return this.#outputs.get(instanceId);
  }

  /** 世界作者数据变更 → 传播失效到所有下游（Dirty Region 真实传播，charter 31）。 */
  sync(): void {
    const dirt = this.world.drainDirtyEntries();    const frontier: Array<{ semantic: string; region?: Region }> = [];
    for (const d of dirt) {
      const s = this.#semanticOf(d.dataId);
      if (!s) continue;
      for (const r of d.regions) frontier.push({ semantic: s, region: r });
    }
    while (frontier.length) {
      const cur = frontier.shift()!;
      for (const inst of this.#instances.values()) {
        const def = this.#processors.get(inst.processorId)!;
        if (!def.inputs.some((p) => p.semantic === cur.semantic)) continue;
        const entry = this.entryOf(inst.instanceId);
        if (cur.region) entry.pending.push(this.#expandFor(def, inst.instanceId, cur.region));
        else {
          const extent = this.#extentFor(inst.instanceId);
          if (extent) entry.pending.push(extent);
        }
        const next = this.#statusWithPending(entry);
        entry.status = next;
        frontier.push({ semantic: def.output.semantic, region: cur.region });
      }
    }
    this.#propagateBlocking();
  }

  /**
   * 显式 Rebuild：按拓扑序重算 pending（可限定 instanceIds / region）。
   * 局部重算粒度 = tile：pending 外扩 (radius+padding) 后取相交 tile，只重算这些 tile。
   */
  rebuild(opts?: { region?: Region; instanceIds?: string[] }): void {
    const order = this.#topoOrder();
    for (const iid of order) {
      if (opts?.instanceIds && !opts.instanceIds.includes(iid)) continue;
      const entry = this.entryOf(iid);
      const inst = this.#instances.get(iid)!;
      const def = this.#processors.get(inst.processorId)!;
      if (!entry.pending.length && this.#outputs.has(iid)) continue;

      const inputs: Record<string, Field | FeatureSet> = {};
      let missing = false;
      for (const port of def.inputs) {
        const d = this.#resolveInput(port);
        if (!d) {
          missing = true;
          break;
        }
        inputs[port.name] = d;
      }
      if (missing) {
        entry.status = 'blocked';
        continue;
      }
      if (def.output.kind !== 'field') throw new Error('#9 仅支持 field 输出（feature 输出随 #11）');

      let out = this.#outputs.get(iid) as Field | undefined;
      if (!out) {
        out = this.#createOutputField(def, inputs);
        this.#outputs.set(iid, out);
      }

      let clip: Region | undefined;
      if (opts?.region) clip = opts.region;
      let targets = entry.pending.length ? entry.pending : [out.bounds];
      if (clip) {
        targets = targets
          .map((r) => intersect(r, clip))
          .filter((r): r is Region => r !== undefined);
      }
      if (!targets.length) continue;

      const pad = (radiusOf(def) + def.invalidation.context.padding) * out.def.resolution;
      const tiles = this.#tilesFor(out, targets, pad);
      try {
        for (const t of tiles) this.#runTile(def, inst.params, inputs, out, t.tx, t.ty, t.extent);
      } catch (e) {
        entry.status = 'error';
        entry.error = (e as Error).message;
        continue;
      }
      // 清掉已处理的 pending（含与 region 部分相交的裁剪）
      entry.pending = clip ? entry.pending.flatMap((r) => subtractRect(r, clip)) : [];
      entry.status = entry.pending.length ? 'partially-outdated' : 'current';
    }
    this.#propagateBlocking();
  }

  // ---- 内部 ----
  #semanticOf(dataId: DataId): string | undefined {
    const d = this.world.data(dataId);
    if (!d) return undefined;
    return d instanceof Field ? d.def.semantic : d.semantic;
  }

  #resolveInput(port: PortSpec): Field | FeatureSet | undefined {
    const candidates: Array<{ data: Field | FeatureSet; fromGenerated: boolean }> = [];
    for (const id of this.world.dataIds()) {
      const d = this.world.data(id);
      if (!d) continue;
      const s = d instanceof Field ? d.def.semantic : d.semantic;
      if (this.#portMatches(port, d, s)) candidates.push({ data: d, fromGenerated: false });
    }
    for (const def of this.#processors.values()) {
      if (def.output.semantic !== port.semantic) continue;
      for (const inst of this.#instances.values()) {
        if (this.#processors.get(inst.processorId) !== def) continue;
        const d = this.#outputs.get(inst.instanceId);
        if (d) candidates.push({ data: d, fromGenerated: true });
      }
    }
    if (candidates.length === 0) return undefined;
    if (candidates.length > 1) throw new Error(`输入歧义（semantic=${port.semantic ?? ''}，${candidates.length} 个候选）`);
    return candidates[0].data;
  }

  #portMatches(port: PortSpec, d: Field | FeatureSet, semantic: string): boolean {
    if (port.kind === 'field' && !(d instanceof Field)) return false;
    if (port.kind === 'feature' && d instanceof Field) return false;
    if (port.semantic !== undefined && semantic !== port.semantic) return false;
    if (port.capability !== undefined) {
      if (!this.world.registry.hasCapabilities(semantic, [port.capability])) return false;
    }
    if (port.dataType !== undefined) {
      const shape = d instanceof Field ? d.def.kind : d.kind;
      if (shape !== port.dataType) return false;
    }
    return true;
  }

  #extentFor(instanceId: string): Region | undefined {
    const inst = this.#instances.get(instanceId)!;
    const def = this.#processors.get(inst.processorId)!;
    const port = def.inputs.find((p) => p.kind === 'field') ?? def.inputs[0];
    const d = this.#resolveInput(port);
    if (!d) return undefined;
    return d.bounds;
  }

  #expandFor(def: ProcessorDef, instanceId: string, r: Region): Region {
    const out = this.#outputs.get(instanceId) as Field | undefined;
    const res = out?.def.resolution ?? 1;
    const pad = (radiusOf(def) + def.invalidation.context.padding) * res;
    return { minX: r.minX - pad, minY: r.minY - pad, maxX: r.maxX + pad, maxY: r.maxY + pad };
  }

  #statusWithPending(entry: GeneratedEntry): DataStatus {
    if (entry.status === 'error') return 'error';
    if (!entry.pending.length) {
      if (entry.status === 'blocked') return 'blocked';
      return this.#outputs.has(entry.instanceId) ? 'current' : 'outdated';
    }
    if (!this.#outputs.has(entry.instanceId)) return 'outdated';
    const out = this.#outputs.get(entry.instanceId) as Field;
    const coversAll = entry.pending.some((r) => r.minX <= out.bounds.minX && r.minY <= out.bounds.minY && r.maxX >= out.bounds.maxX && r.maxY >= out.bounds.maxY);
    return coversAll ? 'outdated' : 'partially-outdated';
  }

  /** 上游 error / 输入缺失 → 下游 blocked（Q6）。 */
  #propagateBlocking(): void {
    for (const iid of this.#topoOrder()) {
      const entry = this.entryOf(iid);
      if (entry.status === 'error') continue;
      const inst = this.#instances.get(iid)!;
      const def = this.#processors.get(inst.processorId)!;
      for (const port of def.inputs) {
        if (port.semantic === undefined) continue;
        const producerEntry = [...this.#generated.values()].find((e) => {
          const d = this.#processors.get(e.processorId)!;
          return d.output.semantic === port.semantic;
        });
        if (producerEntry && producerEntry.status === 'error') {
          entry.status = 'blocked';
          entry.blockedByUpstream = producerEntry.instanceId;
        } else if (producerEntry) {
          entry.blockedByUpstream = undefined;
        }
      }
    }
  }

  #createOutputField(def: ProcessorDef, inputs: Record<string, Field | FeatureSet>): Field {
    const primary = def.inputs.find((p) => p.kind === 'field') ?? def.inputs[0];
    const src = inputs[primary.name] as Field;
    // 输出继承主 field 输入的几何（Phase B 切片：同一网格）；创建走注册表唯一路径
    return this.world.registry.createField(def.output.semantic, {
      width: src.def.width,
      height: src.def.height,
      origin: src.def.origin,
      resolution: src.def.resolution,
      tileSize: src.def.tileSize,
      lodLevels: src.def.lodLevels,
      nodata: src.def.nodata,
      fill: () => src.def.nodata,
    });
  }

  #tilesFor(out: Field, regions: Region[], pad: number): Array<{ tx: number; ty: number; extent: Region }> {
    const d = out.def;
    const ts = d.tileSize;
    const span = ts * d.resolution;
    const nx = Math.ceil(d.width / ts);
    const ny = Math.ceil(d.height / ts);
    const set = new Map<string, { tx: number; ty: number }>();
    for (const r of regions) {
      const ex = { minX: r.minX - pad, minY: r.minY - pad, maxX: r.maxX + pad, maxY: r.maxY + pad };
      const tx0 = Math.max(0, Math.floor((ex.minX - d.origin.x) / span));
      const ty0 = Math.max(0, Math.floor((ex.minY - d.origin.y) / span));
      const tx1 = Math.min(nx - 1, Math.floor((ex.maxX - d.origin.x - 1e-9) / span));
      const ty1 = Math.min(ny - 1, Math.floor((ex.maxY - d.origin.y - 1e-9) / span));
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) set.set(`${tx}:${ty}`, { tx, ty });
      }
    }
    return [...set.values()].map(({ tx, ty }) => ({
      tx,
      ty,
      extent: {
        minX: d.origin.x + tx * span,
        minY: d.origin.y + ty * span,
        maxX: d.origin.x + (tx + 1) * span,
        maxY: d.origin.y + (ty + 1) * span,
      },
    }));
  }

  #runTile(
    def: ProcessorDef,
    params: Record<string, unknown>,
    inputs: Record<string, Field | FeatureSet>,
    out: Field,
    tx: number,
    ty: number,
    extent: Region,
  ): void {
    const d = out.def;
    const ts = d.tileSize;
    const res = d.resolution;
    const comps = d.kind === 'vector' ? 2 : 1;
    const arr = new Float32Array(ts * ts * comps).fill(d.nodata);
    def.run(inputs, params, {
      region: extent,
      write: (p, v) => {
        const lx = Math.round((p.x - extent.minX) / res);
        const ly = Math.round((p.y - extent.minY) / res);
        if (lx < 0 || ly < 0 || lx >= ts || ly >= ts) return;
        const i = ly * ts + lx;
        if (Array.isArray(v)) {
          arr[i * 2] = v[0];
          arr[i * 2 + 1] = v[1];
        } else {
          arr[i] = v;
        }
      },
    });
    out.setTile(tx, ty, arr);
  }

  /** semantic 依赖边 + 拓扑序（Kahn）；环在 addInstance 即拒绝（charter 25）。 */
  #edges(): Map<string, Set<string>> {
    const edges = new Map<string, Set<string>>();
    for (const iid of this.#instances.keys()) edges.set(iid, new Set());
    for (const inst of this.#instances.values()) {
      const def = this.#processors.get(inst.processorId)!;
      for (const port of def.inputs) {
        if (port.semantic === undefined) continue;
        for (const other of this.#instances.values()) {
          if (other.instanceId === inst.instanceId) continue;
          const od = this.#processors.get(other.processorId)!;
          if (od.output.semantic === port.semantic) edges.get(other.instanceId)!.add(inst.instanceId);
        }
      }
    }
    return edges;
  }

  #checkAcyclic(): void {
    const edges = this.#edges();
    const indeg = new Map<string, number>();
    for (const [from, tos] of edges) {
      indeg.set(from, indeg.get(from) ?? 0);
      for (const to of tos) indeg.set(to, (indeg.get(to) ?? 0) + 1);
    }
    const queue = [...edges.keys()].filter((k) => (indeg.get(k) ?? 0) === 0);
    let seen = 0;
    while (queue.length) {
      const n = queue.shift()!;
      seen += 1;
      for (const to of edges.get(n) ?? []) {
        const d = (indeg.get(to) ?? 0) - 1;
        indeg.set(to, d);
        if (d === 0) queue.push(to);
      }
    }
    if (seen !== edges.size) throw new Error('Processor Graph 存在环（charter 25 要求 DAG）');
  }

  #topoOrder(): string[] {
    this.#checkAcyclic();
    const edges = this.#edges();
    const indeg = new Map<string, number>();
    for (const [from, tos] of edges) {
      indeg.set(from, indeg.get(from) ?? 0);
      for (const to of tos) indeg.set(to, (indeg.get(to) ?? 0) + 1);
    }
    const queue = [...edges.keys()].filter((k) => (indeg.get(k) ?? 0) === 0);
    const order: string[] = [];
    while (queue.length) {
      const n = queue.shift()!;
      order.push(n);
      for (const to of edges.get(n) ?? []) {
        const d = (indeg.get(to) ?? 0) - 1;
        indeg.set(to, d);
        if (d === 0) queue.push(to);
      }
    }
    return order;
  }
}
