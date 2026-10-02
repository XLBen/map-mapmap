import { Field } from './field';
import type { FieldDef } from './field';
import { FeatureSet } from './feature';
import type { Feature } from './feature';

/**
 * 空间数据 ↔ JSON（Q13：JSON 信封是 v1 逻辑契约；base64 只是 Phase-1 存储编码，非长期 ABI）。
 * 快照（#8）与世界文件（后续票）共用这一层。
 */

function toBase64(arr: Float32Array): string {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function float32FromBase64(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

export interface SerializedField {
  __type: 'field';
  def: FieldDef;
  legend?: Record<string, number>;
  tiles: Array<{ tx: number; ty: number; data: string }>;
}

export interface SerializedFeatureSet {
  __type: 'features';
  semantic: string;
  kind: Feature['kind'];
  features: Feature[];
}

export type SerializedData = SerializedField | SerializedFeatureSet;

export function fieldToJSON(f: Field): SerializedField {
  return {
    __type: 'field',
    def: { ...f.def },
    legend: f.legendTable,
    tiles: f.tileList.map(({ tx, ty }) => ({
      tx,
      ty,
      data: toBase64(f.getTile(tx, ty)!),
    })),
  };
}

export function fieldFromJSON(j: SerializedField): Field {
  const f = new Field(j.def, j.legend);
  for (const t of j.tiles) {
    f.setTile(t.tx, t.ty, float32FromBase64(t.data));
  }
  return f;
}

export function featureSetToJSON(fs: FeatureSet): SerializedFeatureSet {
  return {
    __type: 'features',
    semantic: fs.semantic,
    kind: fs.kind,
    features: fs.all().map((f) => structuredClone(f)),
  };
}

export function featureSetFromJSON(j: SerializedFeatureSet): FeatureSet {
  const fs = new FeatureSet({ semantic: j.semantic, kind: j.kind });
  for (const f of j.features) fs.add(structuredClone(f));
  return fs;
}

export function dataToJSON(d: Field | FeatureSet): SerializedData {
  return d instanceof FeatureSet ? featureSetToJSON(d) : fieldToJSON(d);
}

export function dataFromJSON(j: SerializedData): Field | FeatureSet {
  return j.__type === 'field' ? fieldFromJSON(j) : featureSetFromJSON(j);
}
