# 统一 Lock 与 Freeze 为单一 Pin 意图

**Status**: accepted (2026-10-02, Spec Lock #6)

charter §39 的 Freeze（区域 / 语义级「自动结果不得覆盖」）与 §15 的 `lock=true`（属性级锁定）语义高度重叠，因此合并为单一 `Pin` 意图：`scope` 为 `attribute`（锁住某属性的值，等价属性级锁定）或 `region`（锁住某区域，可带语义过滤，等价 Freeze）。解析器因此只需处理 Override / Suppression / Pin 三个原语加一条优先级链；UI 仍可保留「锁定属性」「冻结区域」「冻结语义」等手势，映射到同一模型。

## Considered Options

- **保留四个独立原语**：概念更齐全，但解析器要维护 Override × Freeze × Suppression × Lock 的交互矩阵（6+ 条规则），且用户难以区分 Lock 与 Freeze 的差别。

## Consequences

术语以 `Pin` 为准，Lock / Freeze 作为别名列入 `CONTEXT.md` 的 `_Avoid_`；若日后确实需要区分两者语义，应新开 ADR，而不是让模型悄悄分叉。
