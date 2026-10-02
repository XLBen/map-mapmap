import type { Feature, FeatureSet, Field, Region } from '@world/core';

/**
 * 标准化渲染输入（Q3/charter 34）：核心只传纯数据层 + 视口 + 样式，
 * 本包公开接口不出现任何 Canvas/DOM 类型；Canvas2D 只是 adapter（canvas2d.ts）。
 */

export interface Viewport {
  /** 世界坐标可视区。 */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FieldLayerStyle {
  kind: 'heatmap' | 'isoline' | 'categorical';
  /** 值 → 颜色（heatmap/isoline 用）。 */
  colormap?: (value: number) => [number, number, number];
  /** categorical：码 → [r,g,b]。 */
  palette?: Record<number, [number, number, number]>;
  /** isoline 等值级数（默认 8）。 */
  levels?: number;
  opacity?: number;
}

export interface FeatureLayerStyle {
  stroke?: string;
  fill?: string;
  width?: number;
  /** 点半径（world 单位）。 */
  pointRadius?: number;
}

export type SceneLayer =
  | { semantic: string; kind: 'field'; data: Field; style: FieldLayerStyle }
  | { semantic: string; kind: 'feature'; data: FeatureSet; style: FeatureLayerStyle };

/** 调试覆盖层（charter 38/Q5）：矩形组（dirty/suppressed 区域等）。 */
export interface DebugOverlay {
  label: string;
  color: string;
  rects: Region[];
}

export interface RenderInput {
  layers: SceneLayer[];
  overlays: DebugOverlay[];
  viewport: Viewport;
  background?: string;
}

/**
 * 渲染后端抽象：只消费 RenderInput，surface 由后端自行解释
 * （Canvas2D 后端收 CanvasRenderingContext2D，但那是 adapter 的私有约定）。
 */
export interface RenderBackend {
  render(input: RenderInput, surface: unknown): void;
}

/** 语义 → 图层的组织者：Renderer 默认读 Resolved World（charter 54），由调用方组装 SceneLayer。 */
export type LayerPicker = (semantic: string) => SceneLayer | undefined;
