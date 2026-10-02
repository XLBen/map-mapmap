# World Authoring Engine 需求书（Charter）

> 来源：需求方于 2026-10-02 提交的完整设计要求。
> 本文件是仓库内所有规划（wayfinder map / tickets）与实现工作的约束基准。
> 文末附 2026-10-02 grilling 已锁定的五项决策（Q1–Q5）。

## 零、定位一句话

本项目不是「地图绘画软件」或「地形渲染器」，而是一个强解耦、非破坏式、可扩展的
**Spatial Data Authoring Engine / World Authoring Engine**：

- 空间数据创作系统
- 空间数据推导系统（Processor / Derivation）
- 地图可视化系统（Renderer）

表面体验可类似 Photoshop / 地图编辑器 / 大战略游戏地图编辑器，但底层不能是普通位图绘画架构。

最终目标：**未来增加一种当前完全不存在的新空间数据或世界概念时，不需要修改核心世界模型。** 达不到即视为架构设计失败。

## 一、可表达的数据范围（非穷尽）

海拔、DEM、等高线、山峰、山脊、山谷、坡度、坡向、悬崖、洼地、盆地、山口、地形起伏度、河流、溪流、湖泊、水库、海洋、海岸线、湿地、流域、分水岭、水流方向、温度、降水、湿度、风向、风速、气压、气候区、雪线、干旱指数、植被密度、土壤类型、地表湿度、Biome……以及未来任何创建时未预料到的数据，例如 Radiation、Pollution、Population、PoliticalInfluence、Corruption、MagicDensity、DragonActivity、HolyEnergy、自定义幻想属性、自定义 GIS/科学数据。**新概念不得要求修改核心引擎源码。**

## 二、最核心原则：解耦的是实现，不是概念之间的关系

核心引擎不得写死认识 River / Desert / Forest / Biome / Magic / Radiation / Dragon。
具体数据通过 **schema / metadata / semantic / capability / plugin / processor declaration** 向系统声明：

> 我是什么类型的数据、我有什么语义、我可以怎样被编辑和渲染。

例：DragonActivity 可声明为 `type = ScalarField<float>, range = 0..1, semantic = dragon.activity, unit = none`，核心不懂「龙」，但自动知道它可以 sample / query / 画 / 擦 / 平滑 / 渐变 / heatmap / isoline / 统计 / 参与 Processor。
`DragonActivity + Dryness -> DragonFireRisk` 是数据之间通过 Processor 发生关系，不是核心增加 dragon-specific 逻辑。

## 三、World 的正确抽象

禁止 `World = Layer[]`。

```
World =
    Spatial Data + User Intent + Authored Data + Generated Data
  + Processor Graph + Dependency Graph + Overrides + Suppressions
  + Locks + Metadata + History + Plugin Lock + Generated Cache
```

即 `World = Facts + Intent + Rules`，通过 Resolver 得到 Resolved World：

```
Facts + Intent + Rules + Resolution = Resolved World
```

**Renderer 最终主要读取 Resolved World，而不是原始 Generated Data。**

## 四、Layer 不是世界数据模型

Layer 主要用于 UI / 编辑管理（显示隐藏、排序、分组、透明度、编辑选择、View 管理）。
世界数据可能是：连续数值场、离散分类场、向量场、点、线、多边形、图结构、未来新表示。
`Layer = UI / presentation / editing organization`，不是 World Data Core Type。

## 五、核心空间数据类型

核心只提供少量通用类型：

- `ScalarField<T>`
- `VectorField<T>`
- `CategoricalField<T>`
- `PointFeature` / `LineFeature` / `PolygonFeature`

禁止为具体概念增加 RiverLayer / BiomeLayer / MagicLayer / ForestLayer 等专有核心类型。
Elevation/Temperature/Humidity/Rainfall/Radiation/MagicDensity/DragonActivity 都可以是 ScalarField<float>；
Wind/OceanCurrent 可以是 VectorField<Vec2>；
Biome/PoliticalRegion/GeologyType/LandOwnership 都可以是 CategoricalField<ID>。

## 六、语义和数据类型分离

数据结构只回答「这是什么形式的数据」；semantic 回答「这个数据在世界里代表什么」。
例：`ScalarField<float> + semantic=terrain.elevation + unit=meter`；
`ScalarField<float> + semantic=climate.temperature + unit=celsius`；
`CategoricalField<string> + semantic=environment.biome`。
核心只处理类型；插件 / Processor / Renderer 按 semantic 决定额外行为。

## 七、新增数据必须尽可能简单

声明 Name/Type/Range/Unit/Semantic 后，系统应自动提供：创建、保存、加载、sample、query、brush、erase、smooth、blur、gradient、heatmap、isoline、threshold、statistics、Processor input/output、Viewer support。不得要求专门写该概念的核心代码。

## 八、Feature 模型

地图对象不要全部成为专属 class。River 可以是 `LineFeature + properties {semantic=hydrology.river, flow, width, depth, seasonal}`。NormalRiver/LavaRiver/UndergroundRiver/MagicRiver 都建立在通用 LineFeature 上。MountainPeak→PointFeature、Lake→PolygonFeature、Road→LineFeature、Country→PolygonFeature、City→PointFeature 或 PolygonFeature。Feature 支持 schema-defined extensible properties。

## 九、Biome 与局部 Feature 分离

不要把所有现象塞进互斥 enum。Desert 与 Oasis：`Biome = Desert` 同时存在 `LocalFeature {oasis=true, water=present, vegetation_density=high}`。大尺度环境与局部 Feature 分开表达，推广到其他系统。世界 = Base Environment + Local Feature + Modifier + Other Spatial Properties。

## 十、Authored Data 与 Generated Data 必须分离

Authored Data = 用户明确输入/绘制；Generated Data = Processor 自动计算。
禁止混进无法区分来源的最终数组。

```
Spatial Data
  +-- Authored Data
  +-- Generated Data
         |
       Resolver
         |
   Resolved World
```

## 十一、用户明确意图优先

优先级：`Explicit User Override > User-authored data > Generated/simulated > Default/fallback`。
用户手画的河必须存在；规则最多标记 Conflict/Warning/建议，不能偷偷删除用户结果。
同级用户指令冲突：`Latest explicit user action wins`（如 10:00 画 Forest、10:05 改 Desert → 当前意图 Desert）。
但不得简单 last-writer-wins——插件最后运行不等于插件可以覆盖用户。

## 十二、用户创建的数据必须进入后续世界逻辑

手画的 River 不能只是视觉覆盖，应进入 ResolvedRiver，供下游 Processor 消费：
`ResolvedRiver -> Moisture -> Vegetation -> Oasis`。否则用户画的对象只是视觉假象。

## 十三、用户默认应能编辑「原因」，但允许高层 Brush Recipe

高级模式直接编辑 Elevation/Moisture/Temperature/VegetationDensity/Soil…，由 Processor 推导 Biome/Features。
普通用户可用 Forest Brush / Desert Brush / Mountain Brush，但它们应实现为 **Brush Recipe**（对若干底层属性产生一组 Authoring Operation），不是核心特殊对象。UI 支持 Simple Mode（Forest/Desert/Mountain/River）与 Advanced Mode（底层属性）。

## 十四、允许直接 Override 最终结果

`BiomeOverride = Forest` 即使 `Temperature=60°C, Humidity=0` 也允许 `ResolvedBiome = Forest`，可显示 Conflict/Warning。
**系统是创作工具，规则帮助用户，不替用户做最终决定。**

## 十五、Override 应尽量属性级、细粒度

避免「把整个区域强行变成 Forest 对象」（隐含修改 Temperature/Moisture/Soil/Vegetation/Biome…）。
推荐 `UserOverride {biome=Forest}`、`UserConstraint {tree_density>=0.8}`、`biome.category=Forest, lock=true`。
用户明确修改什么就只修改什么；其他变化必须由显式 Processor 产生。

## 十六、Generated Data 不允许被直接破坏

`Elevation -> Slope -> River`，删除 River 不应进入 GeneratedRiver 内部直接删（否则重算自动恢复）。
正确模型：`Generated Data + Override/Suppression/User Intent = Resolved Data`。Generated Data 保持可重新生成。

## 十七、删除 Generated Feature = Suppression

`Generated Oasis #27 + Suppress Oasis #27 = Resolved: absent`。以后 Processor 再生成 Oasis，Suppression 继续生效。Delete Generated Result 在数据语义上是 Create Suppression Intent。

## 十八、Suppression 至少支持对象级和空间级

对象级：「不要这条河」（Suppress River #A；未来逻辑上不同的 River #B 可出现）。
空间级：「这片区域不允许生成河流」（`Suppress {semantic=hydrology.river, region=polygon(...)}`）。
UI 分别提供：删除这个对象 / 禁止该区域生成这种对象。

## 十九、Generated Object 必须支持 Provenance / Lineage

自动数据记录来源：derived_from（输入数据与区域）、processor、plugin_version、seed、input hashes、region、generation lineage、stable logical identity。用于 Suppression / Cache / Debug / Incremental Rebuild / Reproducibility / Object identity。

## 二十、用户删除派生结果后不应自动重新出现

River->Oasis，删 Oasis → 创建 Oasis Suppression；River 仍在、Processor 仍生成，Resolver 继续隐藏，除非用户撤销 Suppression。这是统一世界编辑机制，不是 River/Oasis 特例。

## 二十一、Processor 不允许原地修改输入

`Input Data -> Processor -> New Output Data`，如 `OriginalElevation -> ErosionProcessor -> ErodedElevation`。禁止直接修改 OriginalElevation。支撑 Undo/Redo、Disable plugin、Switch algorithm、Compare、Cache、Rebuild、Versioning、Deterministic replay。

## 二十二、Processor 的定义

Processor 是 `Data -> Data`：`Elevation -> Slope`；`Elevation + Rainfall -> Hydrology`；`River -> Moisture`；`Temperature + Moisture + Vegetation -> Biome`；`DragonActivity + Dryness -> DragonFireRisk`。核心不需要理解这些关系的现实意义。

## 二十三、元素定义与元素关系分离

「River cannot exist in desert」不写进 River schema。River schema 只描述 River 自己；另一个 Rule/Processor 决定 Aridity 如何影响 RiverGeneration。换规则不需要重定义 River / 修改核心 / 破坏数据模型。

## 二十四、依赖存在，但通过数据能力连接

`Elevation -> Slope -> Hydrology -> Moisture -> Biome` 依赖真实存在，但 Processor 不写死依赖具体 ElevationLayer class，而是声明 `input {type=ScalarField, semantic/capability=terrain.elevation}`，由系统解析哪个具体数据满足输入。未来可支持 Capability Resolution（如 elevation-like scalar field）。

## 二十五、第一版 Processor Graph 必须是 DAG

普通 Processor 不允许隐式循环（`Vegetation -> Humidity -> Vegetation`）。循环需要 iteration/convergence/tolerance/max-iterations/oscillation-detection/initial-state，第一版不引入。未来如需，增加显式 SimulationLoop 节点专门管理。

## 二十六、统一 World Coordinate Space，不强制统一数据分辨率

统一世界坐标（如 X=0..10000km, Y=0..8000km）。不同数据可有不同内部表示（Elevation 4096²、Temperature 1024²、Rainfall 512²、River Vector、Country Polygon）。外部代码不得假设 `data[x][y]` 是世界访问方式，统一用 `sample(worldPosition)` / `query(region)`。

## 二十七、SpatialField 隐藏采样、插值和重采样

SpatialField 概念上暴露 bounds/resolution/coordinate_space + `sample(position)` / `query(region)`；具体实现决定 nearest/bilinear/bicubic/categorical-nearest/vector-interpolation。接口不得把底层数组坐标泄露为世界语义。

## 二十八、当前以二维地图为主，但避免永久写死二维数组思维

第一版无需完整 x,y,z,time 高维体系，但架构应避免业务直接依赖 `array[y][x]`，为 depth/altitude/time/underground/atmosphere/multi-level 留扩展机会。

## 二十九、大地图采用 Tile

假设世界很大（如 16384²）。Field/Raster 支持 Tile 化（如 256² tile），用户编辑只标脏受影响 tile：`dirty_tiles = affected tiles`，增量计算围绕受影响区域。

## 三十、使用 Dirty Region 而不是整个数据失效

修改小区域 Elevation：不是 `Slope invalid, River invalid, Biome invalid` 全失效，而是 Elevation region X changed → Slope X+neighborhood dirty → Hydrology 相关 drainage area dirty → Biome affected region dirty。Dirty Region Propagation 是核心性能机制。

## 三十一、Processor 声明 Invalidation Policy

如 Blur：Local/Neighborhood(radius)；Hydrology：Downstream。策略枚举至少 Local / Neighborhood(radius) / Downstream / ConnectedRegion / Global。核心负责调用策略，不需要理解算法为何影响下游。

## 三十二、默认使用 Outdated + Rebuild，而不是所有东西实时自动重算

编辑后依赖数据标记 current / partially outdated / outdated，用户点击 Rebuild（尤其大世界/昂贵 Processor）。未来可 Cheap→auto、Expensive→manual，Processor 声明 cost hint。

## 三十三、支持 LOD / Mipmap

Raster/Field 提供不同 LOD（8192/4096/2048/1024…）用于 zoom/preview/overview/performance。LOD 是表现/性能机制，不改变 World Data 语义。

## 三十四、Processor 和 Renderer 必须严格分离

Processor = Data→Data；Renderer = Data→Visual。`Elevation + Latitude -> Temperature` 是 Processor；`Temperature -> 红蓝 Heatmap` 是 Renderer。严禁把世界逻辑藏进 Renderer。

## 三十五、同一数据允许多个 Renderer

Elevation：Heightmap/Contour/Hillshade/Hypsometric/3D。ScalarField 通用可用 Heatmap/Isoline/Gradient/Threshold。数据不绑定唯一表现方式。

## 三十六、Renderer 通过类型和声明认识未知数据

新增 Radiation：声明 `type=ScalarField, range=0..100, default renderer=heatmap`，系统自动提供通用 Renderer；插件可额外注册 RadiationFancyRenderer。通用数据→默认渲染；特殊插件→可选特殊渲染。

## 三十七、大战略游戏式地图模式 = ViewPreset

Terrain View / Climate View / Rainfall View / Ocean Current View / Political View / Resource View——不复制数据，只是 ViewPreset（如 `ClimateView {background=biome, overlay=temperature, overlay2=rainfall, labels=climate_zone, roads=hidden}`）。一份 World Data 对应无限多 ViewPreset。

## 三十八、支持高级调试视图

除 Resolved World 外支持：User Intent / Authored Data / Generated Data / Raw Data / Suppressed Data / Conflict Map / Dirty Regions / Dependency Graph / Provenance View。普通用户默认只看 Resolved World。

## 三十九、Freeze / Lock 是正式 User Intent

支持 Freeze all / Freeze elevation / Freeze biome / Freeze river / Freeze generated type X / Freeze semantic Y。Freeze 表示指定范围内相关自动结果不能覆盖最终 Resolved State。

## 四十、用户操作历史与 Renderer 历史分离

Undo/Redo 记录 Authoring Operations（PaintElevation / PaintDesertIntent / AddManualRiver / SuppressOasis / FreezeRegion / OverrideBiome…），不记录渲染 frame / preview / viewport redraw。

## 四十一、Authoring Operation 应尽量非破坏式

操作建模为 Paint / Create / Modify / Override / Suppress / Lock / Freeze / Remove Intent，而非永久修改最终数组。支撑 Undo/Redo、Disable operation、Compare、Debug、History inspect、Replay。

## 四十二、Undo 不逐级倒推所有派生结果

Undo River 不需要删 Oasis→还原 Vegetation→还原 Humidity→删 River；只需撤销对应 Authoring Operation，然后标记相关 Derived Data Dirty → 重算。

## 四十三、历史采用 Operation Log + Snapshot

不要求加载世界时从第一个 brush stroke replay。推荐 Snapshot + 之后的 Operations（Snapshot #10000 + #10001/#10002/#10003）。兼顾快速加载、Undo、历史、可重放、文件大小。

## 四十四、Generated Data 可视为 Cache

`Authored State + Operations + Processors + Parameters + Seed + Plugin Versions` 足以重建派生数据。Generated Data 可作为 Cache 提速加载；删除 cache 后世界仍可恢复。

## 四十五、世界必须尽可能可复现

世界文件保存：Processor Graph、Processor ID、参数、Seed、Plugin ID/version/content hash、World format version、Engine version、Input lineage。Deterministic Processor：同样 input+plugin+parameters+seed → 相同 output。

## 四十六、必须保存 Plugin Lock

世界记录 plugin_id/version/content_hash、processor_id/parameters/seed（类似 lockfile），避免半年后插件升级导致旧世界重开结果全变。

## 四十七、World Format Version 与 Engine Version 分离

`world_format_version=1` 与 `engine_version=0.4.0` 分离。新程序尽量始终能读旧世界；format 变化走 v1→migration→v2；不要求旧程序读未来格式。

## 四十八、插件更新不能无提示改变已有世界

旧世界默认继续用锁定版本或兼容实现；用户主动升级才执行 Upgrade/Migration/Rebuild。不因应用更新偷偷重新生成整个世界。

## 四十九、单位系统 optional but supported

Elevation→meter、Temperature→celsius、Rainfall→mm/year；MagicDensity/Risk/Influence→null。unit 存在时做基本输入检查（如防止 Elevation+Temperature 直接相加）。不强制所有值必须有现实物理单位。

## 五十、允许世界内部存在规则冲突

`Temperature=60°C, Moisture=0, BiomeOverride=Forest` 允许；Resolver 仍输出 `ResolvedBiome=Forest`，同时 Conflict System 报 conflict。不因系统认为不合理就自动纠正用户。

## 五十一、禁止「插件最后运行就赢」

冲突解析不是 execution order。优先级：Explicit User Override > User Authored Data > Generated Data > Fallback，同级再决定冲突。

## 五十二、同一属性上的用户明确新指令可以覆盖旧指令

Paint Forest 后 Paint Desert：同一位置同一目标属性 latest explicit user intent wins，保留 Undo/history。

## 五十三、Conflict Map 应是一等调试能力

可视化：normal / user overridden / rule conflict / suppressed / locked / dirty / outdated。让用户理解「为什么这里是这样」，而不是系统暗中自动修正。

## 五十四、Renderer 默认读取 Resolved World

正常视图：Resolved World→Renderer。高级 Debug View 才可选 Generated/Raw/Intent/Conflict/Suppression/Dirty Region。

## 五十五、Resolver 是核心一等组件

Resolver 负责 Authored Data / Generated Data / Override / Suppression / Lock / Freeze / Priority / Conflicts / Source precedence / Resolved state。它不是 Renderer 也不是 Processor。职责：回答「根据当前事实、自动结果和用户意图，这个世界现在最终是什么？」

## 五十六、核心整体数据流

```
WORLD
+-- Spatial Data
|     +-- Authored Data
|     +-- Generated Data
+-- User Intent
|     +-- Override / Suppression / Lock / Freeze / Constraint
+-- Resolver
|     +-- Resolved World
+-- Processor Graph
|     +-- New Generated Data
+-- Dependency / Dirty Graph
+-- Renderer
+-- ViewPreset
+-- Debug / Inspection
+-- History
+-- Snapshot
+-- Plugin Lock
```

注意：Resolved World 既给 Renderer 使用，也可作为其他 Processor 的输入。

## 五十七–六十、典型场景

- **修改山脉**：改 Elevation region X → Elevation current，Slope/Hydrology/Moisture/Biome partially outdated → 用户点 Rebuild → 只重算实际受影响区域。
- **沙漠强行画河**：`AddManualRiver` → `ResolvedRiver = exists` → 下游 Moisture→Vegetation→Oasis。最终 Biome=Desert 同时 River/Oasis/局部 Vegetation high 存在；不自动把 Desert 改成 Oasis。
- **删除自动 Oasis**：`Generated Oasis + User Delete` → 记录 Suppress Oasis → `Resolved Oasis = absent`；River 仍在、Processor 仍生成，继续隐藏。
- **后悔删除**：Remove Suppression → 生成结果重新进入 Resolved World，无需重新生成世界。

## 六十一、用户体验可以像 Photoshop

用户不需要理解 DAG/Resolver/Provenance/Dirty Region/SpatialField/Invalidation Policy。UI 提供 Brush/Eraser/Layers/Show-Hide/Lock/Freeze/Undo/Redo/History/View Mode/Rebuild。底层像空间数据引擎，表面像专业创作工具。

## 六十二、同一个 UI「橡皮」底层语义可能不同

Erase 用户画的数据 = 删除 Authored Operation；Erase Generated Feature = 建立 Suppression；Erase Area from Generation = Spatial Suppression。UI 可统一，底层语义必须明确。

## 六十三、自然世界规则只是默认规则

「沙漠通常很少生成河流」属于 Hydrology Processor/Rule，不是核心硬编码定律。用户可手动画河、换 Processor、装插件、自定义规则。核心必须允许完全不同的世界规律。

## 六十四、Fantasy 示例仅用于测试扩展性

MagicDensity/HolyDesert/DragonActivity 不是项目核心目标，只用于验证「系统能否处理设计时完全没预料到的概念」。同样架构应适用于现实世界数据。

## 六十五、第一版不需要解决全部模拟问题

允许暂缓：复杂循环反馈、完整物理模拟、4D 时空、高精度流体、全面侵蚀、高级 GIS、任意 Simulation Loop。但底层抽象不能阻止未来扩展。

## 六十六、16 条硬原则

1. World 不是 Layer 集合。
2. Layer 主要是 UI 管理概念。
3. 核心认识通用空间数据类型，不认识固定世界概念。
4. 具体概念通过 schema / semantic / metadata / plugin 声明。
5. Processor = Data -> Data；Renderer = Data -> Visual。
6. Processor 不原地修改输入。
7. Authored Data 与 Generated Data 分源保存。
8. 用户明确意图优先于自动规则。
9. 用户创建的数据必须进入后续 Processor。
10. 删除自动结果使用 Suppression，不破坏 Generated Data。
11. Override / Suppress / Lock / Freeze 都属于持久 User Intent。
12. Resolver 输出 Resolved World。
13. 世界通过统一空间坐标访问，不强制所有数据相同 resolution。
14. 大世界采用 Tile / Dirty Region / local invalidation / LOD。
15. 用户操作采用非破坏式 History + Snapshot。
16. 世界保存插件、算法、参数、seed、version、hash，保证兼容性与可复现性。

## 你的工作方式

1. 先阅读并理解现有代码。
2. 找出现有架构与理论模型的冲突。
3. 不机械照搬术语；判断哪些概念当前阶段真的需要实现。
4. 避免过度设计。
5. 优先构建一条最小但完整的 vertical slice。
6. slice 至少证明：通用 Spatial Data 定义、用户绘制、Processor 产生 Derived Data、Dirty Region、Resolver 合并用户与生成结果、Renderer 查看 Resolved Result、Undo、Suppress 自动结果。
7. 第一版不同时实现所有地图要素。
8. 用最少的具体示例验证最大程度的通用性。
9. 若实现某功能必须让核心认识 River/Desert/Magic 等具体概念，先停下来重新设计。
10. 每次增加新抽象时，解释它解决的是当前真实问题还是未来假设问题。

## 推荐最小验证用例（第一条 vertical slice）

只用：Elevation(ScalarField)、Slope(Derived ScalarField)、River(LineFeature)、Moisture(ScalarField)、Biome(CategoricalField)。

用户可以：
1. 画 Elevation。
2. 标记 Dirty Region。
3. Rebuild Slope。
4. Hydrology Processor 生成 River。
5. 删除一条 Generated River → 实际创建 Suppression。
6. Rebuild 后该 River 不重新显示。
7. 取消 Suppression → River 恢复。
8. 手动画 River。
9. Manual River 进入 Resolved World。
10. Moisture Processor 可以读取 Manual River。
11. River 周围 Moisture 上升。
12. Biome / Oasis Feature 随之变化。
13. Renderer 显示 Resolved World。
14. Debug View 显示 Generated / Intent / Suppressed / Dirty。

## 输出要求（实施前）

先输出 17 项：①当前代码库架构总结 ②与理论模型的主要差距 ③第一阶段必须实现的原则 ④可延期项 ⑤建议的核心 domain model ⑥建议的模块边界 ⑦数据流 ⑧Processor/Resolver/Renderer 边界 ⑨World 文件模型 ⑩History/Snapshot 模型 ⑪Dirty Region/invalidation 模型 ⑫Plugin/semantic/schema 模型 ⑬最小 vertical slice ⑭分阶段迁移计划 ⑮风险和可能的过度设计点 ⑯测试策略 ⑰完成第一阶段后的验收标准。然后再开始修改代码。

不要仅仅复述本需求书。需要主动指出其中可能存在的架构问题、逻辑冲突和不必要复杂度，并在不破坏核心目标的前提下提出更简单、更可靠的实现。

---

## 附：2026-10-02 grilling 已锁定的五项决策（Q1–Q5）

**Q1 map 终点形态**：同一 effort 双阶段终点。阶段 A = Spec Lock：完成并评审锁定 17 项架构输出，作为实施基线（强制 checkpoint，不是终点，通过后才允许进入实现）；阶段 B = Vertical Slice：按该 spec 实现最小纵切，完成 14 步验收并通过测试。map 最终终点 = 架构已锁定 + vertical slice 已落地并验收通过。后续完整功能扩展另开 effort，不在这张 map 内。

**Q2 技术栈**：TypeScript monorepo + 明确 WASM 扩展边界。`packages/core` 纯 TS、零 DOM/React 依赖（Spatial Data、Processor DAG、Resolver、History、Dirty Region、schema/semantic）；`packages/render` 独立渲染抽象；`apps/editor` Vite + React + TS（只负责 UI、工具、图层面板、ViewPreset、调试视图）。Processor 默认可放 Web Worker。核心接口不依赖 TS 特有对象布局，热点（Hydrology/DEM/侵蚀）日后可单独换 Rust/WASM。路线：TS first → interfaces stable → profile → 仅热点 Processor → Rust/WASM。Phase 1 不上 Rust/Python 核心；Python/GDAL 日后更适合作为数据导入/离线处理插件。

**Q3 渲染后端**：Canvas 2D 先行，Renderer 接口后端无关。接口禁止暴露 Canvas API：核心只传标准化 render input / viewport / style / resolved data；Canvas2D 只是 backend adapter；未来可加 WebGL/WebGPU backend 而不改 Processor/Resolver/World Model。viewport clipping、tile/LOD、dirty redraw、worker/offscreen canvas 后续渐进加入。先证明渲染架构正确，再优化渲染后端。

**Q4 第一版世界规模**：抽象先行，但 Phase 1 必须真实验证「局部失效」，不能只留接口空壳。~1024² 或少量真实 Tile；Tile/DirtyRegion/Invalidation Policy/LOD 接口第一天进核心模型；至少验证修改局部区域后只标记并重算受影响 Tile/Region，不退化成全图重算；LOD 先有数据结构/最小实现。16384² 压测单独立票（内存/缓存/worker/调度/渲染性能），不阻塞架构纵切。先证明增量模型是真的，再证明它能扩到 16384²。

**Q5 第一版 UI**：极简工作台，但 UI 必须能暴露核心架构状态。必做：Canvas、Elevation 笔刷、Manual River 线工具、Generated Feature 删除→Suppression、Undo/Redo、Rebuild；必做调试面板：Resolved/Generated/User Intent/Suppressed/Dirty/Conflict 切换；最小状态栏：当前工具、当前数据语义、dirty/outdated 状态、最近一次 rebuild 结果。暂缓：完整图层面板、复杂 ViewPreset 管理、Simple/Advanced 双模式、属性检查器、Photoshop 式布局；UI 组件边界预留扩展。Phase 1 UI = 能创作 + 能观察内部状态 + 能完成 14 步验收，把 UI 当架构验证仪器。
