# Phase-1 世界单 tile 实例化，tile/LOD 接口从第一天进核心

**Status**: accepted (2026-10-02, Spec Lock #6)

`Field` 自带 `tileSize` 与 tile 寻址接口，但 Phase-1 整个世界只实例化一个 tile（约 1024²）；多 tile 调度、多分辨率金字塔与缓存淘汰延期到 16384² 压测票。理由是 Q4 要求「Tile / DirtyRegion / InvalidationPolicy / LOD 接口第一天进核心」，但按 charter §29 字面在第一版就建多 tile 存储属于为未来假设问题付费，而这些机制并不改变任何架构结论。

## Considered Options

- **第一版直接多 tile + LOD 最小实装**：更接近最终形态，但显著抬高脚手架成本与内存 / 缓存复杂度。

## Consequences

局部失效的真实性由 P1/P2 性质与「编辑期只标脏」验证，不依赖 tile 数量；大世界性能问题留给独立压测票。
