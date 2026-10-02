import { Field } from './field';
import { FeatureSet } from './feature';
import type { Region, WorldPos } from './coords';
import type { SemanticRegistry } from './registry';
import type { DataId, SpatialData } from './spatial';
import { dataFromJSON, dataToJSON } from './serialize';
import type { SerializedData } from './serialize';

export type OpId = string;

// ---------- 意图操作（非破坏，charter 41；Resolver 在 #10 消费） ----------
// Lock/Freeze 已按 Q1（ADR-0008）合并为 pin。
export interface OverrideOp {
  kind: 'override';
  dataId: DataId;
  attribute?: string;
  value: unknown;
  region?: Region;
}

/** 对象级抑制：targetFeatureId 即生成对象的 lineageId（Q2，#11 落地确定性 id）。 */
export interface SuppressObjectOp {
  kind: 'suppress';
  targetFeatureId: string;
  semantic: string;
}

/** 空间级抑制（Q8）：该区域不允许生成该类对象；只作用于生成数据，不影响作者数据。 */
export interface SuppressSpatialOp {
  kind: 'suppressSpatial';
  semantic?: string;
  spatialType: 'field' | 'point' | 'line' | 'polygon';
  region: Region;
}

export interface PinOp {
  kind: 'pin';
  scope: { target: DataId; attribute: string } | { region: Region; semantic?: string };
}

/** 约束（Q9）：只存储 + Conflict 显示，不求解。 */
export interface ConstraintOp {
  kind: 'constraint';
  dataId: DataId;
  attribute: string;
  op: '>=' | '<=' | '==' | 'in';
  value: number | number[];
}

export type IntentOp = OverrideOp | SuppressObjectOp | SuppressSpatialOp | PinOp | ConstraintOp;

// ---------- 作者数据操作（直接改动 authored 存储） ----------
export interface CreateOp {
  kind: 'create';
  dataId: DataId;
  data: SerializedData;
}

export interface PaintOp {
  kind: 'paint';
  dataId: DataId;
  region: Region;
  value: number;
}

export interface ModifyFeatureOp {
  kind: 'modify';
  dataId: DataId;
  featureId: string;
  geometry?: WorldPos | WorldPos[];
  attributes?: Record<string, unknown>;
}

export type AuthoredOp = CreateOp | PaintOp | ModifyFeatureOp;

export type AuthoringOp = IntentOp | AuthoredOp;

// ---------- 标记（Q11：append-only；物理不删除） ----------
export interface DisableOp {
  kind: 'disable';
  targetOpId: OpId;
}

export interface EnableOp {
  kind: 'enable';
  targetOpId: OpId;
}

/** 语义删除意图（charter 41 的 Remove Intent）；不入 undo 栈——恢复 = 重新添加。 */
export interface RemoveIntentOp {
  kind: 'removeIntent';
  targetOpId: OpId;
}

export type MarkerOp = DisableOp | EnableOp | RemoveIntentOp;
export type LogOp = AuthoringOp | MarkerOp;

export interface HistoryEntry {
  opId: OpId;
  seq: number;
  op: LogOp;
}

export interface Snapshot {
  afterSeq: number;
  authored: Record<DataId, SerializedData>;
}

const isMarker = (op: LogOp): op is MarkerOp =>
  op.kind === 'disable' || op.kind === 'enable' || op.kind === 'removeIntent';

const INTENT_KINDS = new Set(['override', 'suppress', 'suppressSpatial', 'pin', 'constraint']);
const isIntent = (op: LogOp): op is IntentOp => !isMarker(op) && INTENT_KINDS.has(op.kind);
const isAuthored = (op: LogOp): op is AuthoredOp => !isMarker(op) && !INTENT_KINDS.has(op.kind);

/**
 * 世界状态（Phase B 骨架）：authored 单源（硬原则 7；generated 侧由 #9 挂载）+ append-only 历史。
 * 数据引用一律经 data(id) 获取——undo/redo 会整体重建实例，旧引用不保证继续有效。
 */
export class World {
  readonly registry: SemanticRegistry;
  readonly snapshotInterval: number;
  #authored = new Map<DataId, SpatialData>();
  #log: HistoryEntry[] = [];
  #snapshots: Snapshot[] = [];
  #seq = 0;
  #undoStack: OpId[] = [];
  #redoStack: OpId[] = [];
  #dirty = new Set<DataId>();

  constructor(registry: SemanticRegistry, opts?: { snapshotInterval?: number }) {
    this.registry = registry;
    this.snapshotInterval = opts?.snapshotInterval ?? 50;
  }

  // ---- 读取 ----
  get log(): readonly HistoryEntry[] {
    return this.#log;
  }

  get canUndo(): boolean {
    return this.#undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.#redoStack.length > 0;
  }

  dataIds(): DataId[] {
    return [...this.#authored.keys()];
  }

  data(id: DataId): SpatialData | undefined {
    return this.#authored.get(id);
  }

  /** charter 42：撤销/重做只把受影响数据标脏，派生结果不倒推。 */
  get dirty(): readonly DataId[] {
    return [...this.#dirty];
  }

  drainDirty(): DataId[] {
    const out = [...this.#dirty];
    this.#dirty.clear();
    return out;
  }

  /** 有效意图（seq 序）。同属性 latest-explicit-wins 由 Resolver 取末项（charter 52）。 */
  intents(): IntentOp[] {
    const disabled = this.#disabledSet();
    return this.#log
      .filter((e): e is HistoryEntry & { op: IntentOp } => isIntent(e.op) && !disabled.has(e.opId))
      .map((e) => e.op);
  }

  // ---- 作者数据操作 ----
  createData(id: DataId, data: SpatialData): OpId {
    if (this.#authored.has(id)) throw new Error(`数据已存在: ${id}`);
    const semantic = data instanceof Field ? data.def.semantic : data.semantic;
    if (!this.registry.has(semantic)) throw new Error(`semantic 未注册: ${semantic}`);
    return this.#append({ kind: 'create', dataId: id, data: dataToJSON(data) });
  }

  paint(id: DataId, region: Region, value: number): OpId {
    this.#requireField(id);
    return this.#append({ kind: 'paint', dataId: id, region, value });
  }

  modifyFeature(
    id: DataId,
    featureId: string,
    patch: { geometry?: WorldPos | WorldPos[]; attributes?: Record<string, unknown> },
  ): OpId {
    const fs = this.#requireFeatures(id);
    if (!fs.all().some((f) => f.id === featureId)) throw new Error(`要素不存在: ${featureId}`);
    return this.#append({ kind: 'modify', dataId: id, featureId, ...patch });
  }

  // ---- 意图操作 ----
  override(op: Omit<OverrideOp, 'kind'>): OpId {
    return this.#append({ kind: 'override', ...op });
  }

  suppress(targetFeatureId: string, semantic: string): OpId {
    return this.#append({ kind: 'suppress', targetFeatureId, semantic });
  }

  suppressSpatial(op: Omit<SuppressSpatialOp, 'kind'>): OpId {
    return this.#append({ kind: 'suppressSpatial', ...op });
  }

  pin(scope: PinOp['scope']): OpId {
    return this.#append({ kind: 'pin', scope });
  }

  constraint(op: Omit<ConstraintOp, 'kind'>): OpId {
    return this.#append({ kind: 'constraint', ...op });
  }

  removeIntent(targetOpId: OpId): OpId {
    const entry = this.#log.find((e) => e.opId === targetOpId);
    if (!entry || !isIntent(entry.op)) throw new Error(`removeIntent 目标必须是意图操作: ${targetOpId}`);
    return this.#append({ kind: 'removeIntent', targetOpId }, { recordUndo: false });
  }

  // ---- Undo / Redo（Q11：disable/enable 标记 + 快照重放） ----
  undo(): OpId | undefined {
    const opId = this.#undoStack.pop();
    if (!opId) return undefined;
    this.#redoStack.push(opId);
    this.#append({ kind: 'disable', targetOpId: opId }, { recordUndo: false });
    this.#markDirtyIfAuthored(opId);
    return opId;
  }

  redo(): OpId | undefined {
    const opId = this.#redoStack.pop();
    if (!opId) return undefined;
    this.#undoStack.push(opId);
    this.#append({ kind: 'enable', targetOpId: opId }, { recordUndo: false });
    this.#markDirtyIfAuthored(opId);
    return opId;
  }

  snapshot(): void {
    this.#snapshotNow();
  }

  // ---- 内部 ----
  #markDirtyIfAuthored(opId: OpId): void {
    const entry = this.#log.find((e) => e.opId === opId);
    if (entry && isAuthored(entry.op)) this.#dirty.add(entry.op.dataId);
  }

  #append(op: LogOp, opts?: { recordUndo?: boolean }): OpId {
    this.#seq += 1;
    const opId = `op-${this.#seq}`;
    this.#log.push({ opId, seq: this.#seq, op });

    if (isMarker(op)) {
      // 只有作用于作者数据的标记需要重建状态；意图标记只影响 intents() 的过滤
      const target = this.#log.find((e) => e.opId === op.targetOpId);
      if (target && isAuthored(target.op)) {
        // 含被禁操作效果的快照全部失效
        this.#snapshots = this.#snapshots.filter((s) => s.afterSeq < target.seq);
        this.#rebuild();
      }
    } else {
      if (isAuthored(op)) {
        this.#applyAuthored(op, this.#authored);
        if (op.kind !== 'create') this.#dirty.add(op.dataId); // 编辑既有数据 → 下游待重算（charter 42 的正向面）
      }
      if (opts?.recordUndo !== false) {
        this.#undoStack.push(opId);
        this.#redoStack.length = 0;
      }
    }
    if (this.#seq % this.snapshotInterval === 0) this.#snapshotNow();
    return opId;
  }

  #applyAuthored(op: AuthoredOp, store: Map<DataId, SpatialData>): void {
    if (op.kind === 'create') {
      store.set(op.dataId, dataFromJSON(op.data));
      return;
    }
    if (op.kind === 'paint') {
      const f = store.get(op.dataId);
      if (!(f instanceof Field)) throw new Error(`paint 目标不是 Field: ${op.dataId}`);
      f.fillRegion(op.region, op.value);
      return;
    }
    const fs = store.get(op.dataId);
    if (!(fs instanceof FeatureSet)) throw new Error(`modify 目标不是 FeatureSet: ${op.dataId}`);
    const idx = fs.all().findIndex((f) => f.id === op.featureId);
    if (idx < 0) throw new Error(`要素不存在: ${op.featureId}`);
    const next = structuredClone(fs.all()[idx]);
    if (op.geometry !== undefined) {
      if (next.kind === 'point') next.pos = op.geometry as WorldPos;
      else if (next.kind === 'line') next.points = op.geometry as WorldPos[];
      else next.ring = op.geometry as WorldPos[];
    }
    if (op.attributes) next.attributes = { ...next.attributes, ...op.attributes };
    fs.replaceAt(idx, next);
  }

  #disabledSet(): Set<OpId> {
    const disabled = new Set<OpId>();
    for (const e of this.#log) {
      if (e.op.kind === 'disable' || e.op.kind === 'removeIntent') disabled.add(e.op.targetOpId);
      else if (e.op.kind === 'enable') disabled.delete(e.op.targetOpId);
    }
    return disabled;
  }

  #rebuild(): void {
    const disabled = this.#disabledSet();
    const snap = this.#snapshots[this.#snapshots.length - 1];
    const authored = new Map<DataId, SpatialData>();
    if (snap) {
      for (const [id, j] of Object.entries(snap.authored)) authored.set(id, dataFromJSON(j));
    }
    for (const e of this.#log) {
      if (e.seq <= (snap?.afterSeq ?? 0)) continue;
      if (isMarker(e.op) || disabled.has(e.opId)) continue;
      if (isAuthored(e.op)) this.#applyAuthored(e.op, authored);
    }
    this.#authored = authored;
  }

  #snapshotNow(): void {
    const authored: Record<DataId, SerializedData> = {};
    for (const [id, d] of this.#authored) authored[id] = dataToJSON(d);
    this.#snapshots.push({ afterSeq: this.#seq, authored });
  }

  #requireField(id: DataId): Field {
    const d = this.#authored.get(id);
    if (!(d instanceof Field)) throw new Error(`数据不存在或不是 Field: ${id}`);
    return d;
  }

  #requireFeatures(id: DataId): FeatureSet {
    const d = this.#authored.get(id);
    if (!(d instanceof FeatureSet)) throw new Error(`数据不存在或不是 FeatureSet: ${id}`);
    return d;
  }
}
