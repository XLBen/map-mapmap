# 失效策略携带确定性上下文；「局部重算 == 全图重算」是可测试性质

**Status**: accepted (2026-10-02, Spec Lock #6)

失效策略 = 传播类（local / neighborhood(r) / downstream / connectedRegion / global）+ `context{padding, seam}`。原因是 World Machine 官方承认上下文敏感的处理器（Erosion / Snow）在 tile 模式与整图模式下结果不同，只能靠外扩周边数据再混合来缓解（见调研 `prior-art` §1.1、§3.1）。因此「重算需要多大上下文才能与全图一致」必须成为声明的一部分，且「局部 == 全图」要写成可执行的性质测试（同 seed / 输入下逐值相等），而不是假设。

## Considered Options

- **只用 charter §31 的五种枚举**：接口更薄，但局部重算的正确性既无法声明也无法测试，可能产出「从未存在过的世界」。
- **要求所有处理器满足逐值一致**：对全局汇聚类（Hydrology）不成立，只能改用「标脏集 == 全量重算差异集」。

## Consequences

无法满足逐值一致的处理器必须显式声明降级路径（更大范围重算或标注近似），这一点进入验收标准。
