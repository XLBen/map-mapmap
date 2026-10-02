# 采用 pull 式求值 + Outdated/手动 Rebuild，第一版不引入后台调度器

**Status**: accepted (2026-10-02, Spec Lock #6)

世界的派生数据在被请求时才求值：编辑只标脏，用户显式触发 Rebuild，求值沿处理器图向上拉取、遇到已是最新的子图即停。理由是世界机器（World Machine）、QGIS、Houdini 三个不同领域一致选择「不自动全量重算」（见调研 `prior-art` §2.9–§2.10），而自动重算会把「谁在什么时候算了什么」变成隐式行为，破坏可预测性与可调试性。

## Considered Options

- **编辑即自动重算**：交互更顺，但昂贵处理器会阻塞编辑，且失败与过期状态对用户不可见。
- **后台调度器 + 渐进重算**：体验最好、成本最高；charter §32 主句本就是 Outdated + Rebuild，第一版无此必要。

## Consequences

处理器声明中的 `costHint` 字段保留但不驱动任何行为；将来若要启用自动重算，不需要改接口。
