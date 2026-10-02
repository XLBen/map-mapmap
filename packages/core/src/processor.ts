import type { Region } from './coords';
import type { Field, FieldValue } from './field';
import type { Feature, FeatureSet } from './feature';

/** 数据状态（Q6 五态；charter 32）。 */
export type DataStatus = 'current' | 'partially-outdated' | 'outdated' | 'blocked' | 'error';

export type InvalidationPolicy =
  | { propagation: 'local' }
  | { propagation: 'neighborhood'; radius: number }
  | { propagation: 'downstream' }
  | { propagation: 'connectedRegion' }
  | { propagation: 'global' };

/** Q4 / ADR-0004：重算达到与全图一致所需的确定性上下文；不可逐值一致者必须显式声明降级。 */
export interface PolicyContext {
  /** 外扩采样数。 */
  padding: number;
  /** 越出输入范围时的处理。 */
  seam: 'extend' | 'nodata';
}

export type DataKind = 'field' | 'feature';
export type DataShape = 'scalar' | 'vector' | 'categorical' | 'point' | 'line' | 'polygon';

export interface PortSpec {
  name: string;
  kind: DataKind;
  dataType?: DataShape;
  /** 二选一：semantic 精确匹配（技术默认值）或 capability 匹配（charter §57–60）。都不填 = 任意同名类型。 */
  semantic?: string;
  capability?: string;
}

export interface OutputSpec {
  kind: DataKind;
  dataType?: DataShape;
  semantic: string;
  /** categorical 输出的图例（名称→码）。 */
  legend?: Record<string, number>;
}

export interface RunContext {
  /** 处理器实例 id（谱系 id 组成部分）。 */
  instanceId: string;
  /** 本次要产出的输出区域（世界坐标；tile 粒度由引擎切分）。 */
  region: Region;
  /** field 输出的写入通道（只写本次区域，坐标为世界坐标）。 */
  write(p: { x: number; y: number }, v: FieldValue): void;
}

export interface ProcessorDef<P = Record<string, unknown>> {
  id: string;
  /** 插件版本（provenance 用，charter 19）。 */
  version?: string;
  inputs: PortSpec[];
  output: OutputSpec;
  invalidation: { policy: InvalidationPolicy; context: PolicyContext };
  /**
   * 纯函数（charter 21）：只经 inputs 的公开视图（sample/query）读，禁止原地修改输入；
   * 产出经 ctx.write 写出（field）或返回 { features: Feature[] }（feature 输出）。
   */
  run(inputs: Record<string, Field | FeatureSet>, params: P, ctx: RunContext): { features: Feature[] } | void;
}

/** 影响半径（采样数）；非 neighborhood 传播为 0。 */
export function radiusOf(def: ProcessorDef): number {
  return def.invalidation.policy.propagation === 'neighborhood' ? def.invalidation.policy.radius : 0;
}
