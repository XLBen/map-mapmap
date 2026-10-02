# World 文件 v1：JSON 逻辑契约 + base64 物理编码（非长期 ABI）

**Status**: accepted (2026-10-02, Spec Lock #6)

世界文件 v1 的**逻辑契约**是 JSON 信封：版本头、插件锁、处理器图、历史（快照 + 操作）、作者数据为必备分区；生成数据与其谱系属可弃缓存。typed array 在 Phase-1 以 base64 承载，但这只是**存储编码、不是长期稳定 ABI**——日后允许在不改变逻辑 schema / DataId / lineage / processorGraph / history 语义的前提下，把大型数组迁移为独立 binary blob 或其他物理编码。

## Considered Options

- **v1 直接用二进制容器（protobuf/flatbuffers）**：体积与性能更好，但格式与工具链第一天就定死，且审查者无法直接读懂世界文件。
- **把 Provenance 升级为必备分区**：删缓存后仍可直接查谱系，但文件更大，且与「生成数据可视为缓存」（charter §44）相抵触。

## Consequences

读取端不得依赖 base64 这一具体编码；插件锁与确定性 lineageId 保证删缓存后世界仍可完整重建。
