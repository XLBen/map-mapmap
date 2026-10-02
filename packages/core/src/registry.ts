import type { FieldKind, FieldValue } from './field';
import { Field } from './field';
import type { FeatureKind } from './feature';
import { FeatureSet } from './feature';
import type { WorldPos } from './coords';

/** 属性模式：只记录名称/类型/单位/描述，核心不校验取值（charter §27）。 */
export interface AttributeSchema {
  type: 'number' | 'string' | 'boolean';
  unit?: string;
  description?: string;
}

export interface SchemaDeclaration {
  description?: string;
  attributes?: Record<string, AttributeSchema>;
}

export type DataTypeDecl =
  | { family: 'field'; field: FieldKind }
  | { family: 'feature'; feature: FeatureKind };

/** semantic 是命名空间式精确字符串（技术默认值：exact match）。capability 声明供后续处理器输入匹配（charter §57–60）。 */
export interface SemanticDeclaration {
  semantic: string;
  dataType: DataTypeDecl;
  schema?: SchemaDeclaration;
  capabilities?: string[];
}

export type FieldFill = (p: WorldPos) => FieldValue;

export interface FieldCreateArgs {
  width: number;
  height: number;
  origin: WorldPos;
  resolution: number;
  tileSize?: number;
  lodLevels?: number;
  unit?: string;
  nodata?: number;
  legend?: Record<string, number>;
  fill: FieldFill;
}

/**
 * semantic 注册表：任何空间数据的唯一创建路径。
 * 通用性门槛（charter「工作方式」9、#7 验收）：新语义只走 register + create*，核心零改动。
 */
export class SemanticRegistry {
  #decls = new Map<string, SemanticDeclaration>();

  register(d: SemanticDeclaration): void {
    if (this.#decls.has(d.semantic)) throw new Error(`semantic 已注册: ${d.semantic}`);
    if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/.test(d.semantic)) {
      throw new Error(`semantic 命名需为小写点分标识: ${d.semantic}`);
    }
    this.#decls.set(d.semantic, d);
  }

  get(semantic: string): SemanticDeclaration {
    const d = this.#decls.get(semantic);
    if (!d) throw new Error(`未注册的 semantic: ${semantic}`);
    return d;
  }

  has(semantic: string): boolean {
    return this.#decls.has(semantic);
  }

  list(): readonly SemanticDeclaration[] {
    return [...this.#decls.values()];
  }

  /** 声明的 capabilities 是否覆盖要求（后续处理器输入匹配用）。 */
  hasCapabilities(semantic: string, required: string[]): boolean {
    const have = new Set(this.get(semantic).capabilities ?? []);
    return required.every((r) => have.has(r));
  }

  createField(semantic: string, args: FieldCreateArgs): Field {
    const d = this.get(semantic);
    if (d.dataType.family !== 'field') {
      throw new Error(`${semantic} 不是 field 族语义`);
    }
    const field = new Field(
      {
        semantic,
        kind: d.dataType.field,
        width: args.width,
        height: args.height,
        origin: args.origin,
        resolution: args.resolution,
        tileSize: args.tileSize ?? 256,
        lodLevels: args.lodLevels ?? 1,
        unit: args.unit,
        nodata: args.nodata ?? (d.dataType.field === 'categorical' ? 255 : -9999),
      },
      args.legend,
    );
    field.fill(args.fill);
    return field;
  }

  createFeatureSet(semantic: string): FeatureSet {
    const d = this.get(semantic);
    if (d.dataType.family !== 'feature') {
      throw new Error(`${semantic} 不是 feature 族语义`);
    }
    return new FeatureSet({ semantic, kind: d.dataType.feature });
  }
}
