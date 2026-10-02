# Phase-1 Hydrology：D8 + Priority-Flood 全量重算，Downstream 只做标脏

**Status**: accepted (2026-10-02, Spec Lock #6)

第一版水文处理器采用 D8（汇流型、出度 ≤1，天然产出单像素河道并直接映射为线要素），管线为 Priority-Flood 填洼 → D8 指向 → 拓扑序累积（Rainfall 作权重）→ 阈值 → 沿 receiver 追踪成线。局部编辑后的「下游失效集」按「翻转格的旧 ∪ 新下游闭包」标脏并展示，但**计算侧直接全量重算**：1024² 纯 JS 实测全管线约 375ms，而增量更新的最坏复杂度仍是 O(n)（翻分水岭）还要处理填洼例外，Phase-1 的收益不抵复杂度与正确性风险。

## Considered Options

- **路径级 Δ 增量更新**：沿旧/新下游路径对累积量做加减，最快，但只在 D8 下无歧义且边界情况多，留作后续优化票。
- **D∞ / MFD**：发散型方法需要额外的河道收敛规则，正是 charter 要避免的隐式业务逻辑。

## Consequences

处理器接口按「多 receiver + weights」形态预留（k=1 即 D8），将来换算法不改接口；增量 Δ 优化单独立票。
