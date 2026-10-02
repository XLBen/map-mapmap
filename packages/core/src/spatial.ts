import type { Field } from './field';
import type { FeatureSet } from './feature';

/** 数据项身份（§5）。Phase-1 由上层按约定组装；#9 落地 lineageId 时固化规则。 */
export type DataId = string;

export type SpatialData = Field | FeatureSet;
