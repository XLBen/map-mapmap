import type { Feature, FeatureSet, Field } from '@world/core';

/** 样式是数据→视觉的映射约定，由具体后端解释（charter §20：Renderer 后端无关）。 */
export interface FieldStyle {
  /** 值 → 颜色。nodata 处后端应跳过或用背景色。 */
  colormap: (value: number) => string;
  opacity?: number;
}

export interface FeatureStyle {
  stroke?: string;
  fill?: string;
  width?: number;
}

/**
 * 渲染后端抽象：只消费空间数据与样式，不反查世界模型（charter §20/§21）。
 * Canvas2D 适配器在 #12 落地；本包 Phase-1 只固化接口。
 */
export interface RenderBackend {
  clear(color?: string): void;
  drawField(field: Field, lod: number, style: FieldStyle): void;
  drawFeatures(features: FeatureSet, style: FeatureStyle, visible?: (f: Feature) => boolean): void;
}
