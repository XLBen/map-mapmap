import { Field } from './field';
import { FeatureSet, bboxOf } from './feature';
import type { Region } from './coords';
import type { World } from './authoring';
import type { DataId } from './spatial';
import type { DataStatus, PortSpec, ProcessorDef } from './processor';
import { radiusOf } from './processor';
import type { SpatialData } from './spatial';
import type { IntentOp, LogOp } from './authoring';
import { Resolver } from './resolver';

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
  /** Resolver 与引擎共享同一套槽位语义（charter 55/56）。 */
  readonly resolver: Resolver;
  #processors = new Map<string, ProcessorDef>();
  #instances = new Map<string, Instance>();
  #generated = new Map<string, GeneratedEntry>();
  #outputs = new Map<string, Field | FeatureSet>();

  constructor(world: World) {
    this.world = world;
    this.resolver = new Resolver(world, this);
  }

  registerProcessor(def: ProcessorDef): void {
    if (this.#processors.has(def.id)) throw new Error(`Processor 已注册: ${def.id}`);
    this.#processors.set(def.id, def);
  }

  processorOf(instanceId: string): ProcessorDef {
    const inst = this.#instances.get(instanceId);
    if (!inst) throw new Error(`实例不存在: ${instanceId}`);
    return this.#processors.get(inst.processorId)!;
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

  /** 世界作者数据变更或新增意图 → 传播失效到所有下游（Dirty Region 真实传播，charter 31）。 */
  sync(): void {
    const frontier: Array<{ semantic: string; region?: Region }> = [];
    for (const d of this.world.drainDirtyEntries()) {
      const s = this.#semanticOf(d.dataId);
      if (!s) continue;
      for (const r of d.regions) frontier.push({ semantic: s, region: r });
    }
    // 意图与意图标记（override/pin/suppress/removeIntent/undo）= 用户可见变化 → 相应 semantic 整域待重算
    for (const e of this.world.log) {
      if (e.seq <= this.#lastSeenSeq) continue;
      this.#lastSeenSeq = e.seq;
      const s = this.#intentSemantic(e.op);
      if (s) frontier.push({ semantic: s, region: undefined });
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

      const clip = opts?.region;
      if (def.output.kind === 'feature') {
        // Phase B v0：feature 输出全量重建（区域级增量随 #11 水文链落地）
        const extent = this.#extentFor(iid);
        if (!extent) continue;
        const region = clip ? (intersect(extent, clip) ?? extent) : extent;
        const fs = this.world.registry.createFeatureSet(def.output.semantic);
        const produced = def.run(inputs, inst.params, { region, write: () => {} });
        if (produced) {
          for (const f of produced.features.all()) fs.add(f);
        }
        this.#outputs.set(iid, fs);
        entry.pending = clip ? entry.pending.flatMap((r) => subtractRect(r, clip)) : [];
        entry.status = entry.pending.length ? 'partially-outdated' : 'current';
        continue;
      }
      if (def.output.kind !== 'field') throw new Error(`未知输出类型: ${(def.output as { kind: string }).kind}`);

      let out = this.#outputs.get(iid) as Field | undefined;
      if (!out) {
        out = this.#createOutputField(def, inputs);
        this.#outputs.set(iid, out);
      }

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
  #lastSeenSeq = 0;

  #intentSemantic(op: LogOp): string | undefined {
    switch (op.kind) {
      case 'override':
        return this.#semanticOfDataId(op.dataId);
      case 'pin':
        return 'target' in op.scope ? this.#semanticOfDataId(op.scope.target) : op.scope.semantic;
      case 'suppress':
      case 'suppressSpatial':
        return op.semantic ?? undefined;
      case 'removeIntent':
      case 'disable':
      case 'enable': {
        const t = this.world.log.find((e) => e.opId === op.targetOpId);
        return t ? this.#intentSemantic(t.op) : undefined;
      }
      default:
        return undefined; // 作者数据操作由标脏通道负责，避免双重失效
    }
  }

  #semanticOfDataId(id: DataId): string | undefined {
    if (id.startsWith('gen:')) {
      try {
        return this.processorOf(id.slice(4)).output.semantic;
      } catch {
        return undefined;
      }
    }
    const d = this.world.data(id);
    return d ? (d instanceof Field ? d.def.semantic : d.semantic) : undefined;
  }

  #semanticOf(dataId: DataId): string | undefined {
    const d = this.world.data(dataId);
    if (!d) return undefined;
    return d instanceof Field ? d.def.semantic : d.semantic;
  }

  #resolveInput(port: PortSpec): Field | FeatureSet | undefined {
    if (port.semantic !== undefined) {
      // 槽位解析走 Resolver：authored > generated（charter 51，禁 last-run-wins）+ 空间抑制 mask（Q8）
      const picked = this.resolver.pickBase(port.semantic);
      if (!picked) return undefined;
      return this.#maskSpatial(port.semantic, picked.data);
    }
    const candidates: Array<{ data: Field | FeatureSet }> = [];
    for (const id of this.world.dataIds()) {
      const d = this.world.data(id);
      if (!d) continue;
      const s = d instanceof Field ? d.def.semantic : d.semantic;
      const kindOk = port.kind === 'field' ? d instanceof Field : d instanceof FeatureSet;
      if (!kindOk) continue;
      if (port.capability !== undefined && !this.world.registry.hasCapabilities(s, [port.capability])) continue;
      if (port.dataType !== undefined) {
        const shape = d instanceof Field ? d.def.kind : d.kind;
        if (shape !== port.dataType) continue;
      }
      candidates.push({ data: d });
    }
    for (const inst of this.#instances.values()) {
      const def = this.#processors.get(inst.processorId)!;
      if (!this.#portMatchesOutput(def, port)) continue;
      const d = this.#outputs.get(inst.instanceId);
      if (d) candidates.push({ data: d });
    }
    if (candidates.length === 0) return undefined;
    if (candidates.length > 1) throw new Error(`输入歧义（capability=${port.capability ?? ''}，${candidates.length} 个候选）`);
    return candidates[0].data;
  }

  #portMatchesOutput(def: ProcessorDef, port: PortSpec): boolean {
    if (def.output.semantic !== port.semantic && port.capability === undefined) return false;
    if (port.capability !== undefined) {
      if (!this.world.registry.hasCapabilities(def.output.semantic, [port.capability])) return false;
    }
    if (port.kind !== def.output.kind) return false;
    return true;
  }

  /** 空间级抑制（Q8）：Processor 输入 mask——只掩蔽数据副本，输入本体不动（charter 21）。 */
  #maskSpatial(semantic: string, data: Field | FeatureSet): Field | FeatureSet {
    const masks = this.world.intents().filter(
      (o): o is IntentOp & { kind: 'suppressSpatial' } =>
        o.kind === 'suppressSpatial' && (o.semantic === undefined || o.semantic === semantic),
    );
    if (!masks.length) return data;
    const kind = data instanceof Field ? 'field' : data.kind;
    const regions = masks.filter((o) => o.spatialType === kind).map((o) => o.region);
    if (!regions.length) return data;

    if (data instanceof Field) {
      const copy = this.#cloneFieldForMask(data);
      const d = data.def;
      const span = d.tileSize * d.resolution;
      const res = d.resolution;
      for (const { tx, ty } of data.tileList) {
        const extent = {
          minX: d.origin.x + tx * span,
          minY: d.origin.y + ty * span,
          maxX: d.origin.x + (tx + 1) * span,
          maxY: d.origin.y + (ty + 1) * span,
        };
        const hit = regions.some((r) => r.minX < extent.maxX && extent.minX < r.maxX && r.minY < extent.maxY && extent.minY < r.maxY);
        if (!hit) continue;
        const cur = data.getTile(tx, ty);
        if (!cur) continue;
        const arr = cur.slice();
        const nx = Math.round((extent.maxX - extent.minX) / res);
        const ny = Math.round((extent.maxY - extent.minY) / res);
        for (let iy = 0; iy < ny; iy++) {
          for (let ix = 0; ix < nx; ix++) {
            const x = extent.minX + ix * res;
            const y = extent.minY + iy * res;
            if (regions.some((r) => x >= r.minX && x < r.maxX && y >= r.minY && y < r.maxY)) {
              arr[iy * d.tileSize + ix] = d.nodata;
            }
          }
        }
        copy.setTile(tx, ty, arr);
      }
      return copy;
    }
    const fs = this.world.registry.createFeatureSet(semantic);
    for (const f of data.all()) {
      const b = bboxOf(f);
      if (!regions.some((r) => r.minX < b.maxX && b.minX < r.maxX && r.minY < b.maxY && b.minY < r.maxY)) fs.add(f);
    }
    return fs;
  }

  #cloneFieldForMask(src: Field): Field {
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
