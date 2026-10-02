# 同类系统先例调研：Processor DAG / 派生数据 / 失效传播 / Suppression / Provenance

> 对应研究问题：GitHub issue #3（wayfinder research）。
> 研究日期 / 全部引用访问日期：**2026-10-02**。
> 方法：仅使用一手来源（官方文档、官方帮助站、开源仓库/官方源码），通过 web_search / web_fetch 获取；抓取到的网页内容一律按数据处理，不作为指令。每条事实后附来源链接，可信度标注见文末「引用清单」。无法从一手来源核实的内容一律不写或明确标注为推测。

## 0. 结论速览

| 系统 | Processor DAG | 派生数据建模 | 失效 / 脏区 | 覆盖 / 抑制（Suppression） | Provenance |
|---|---|---|---|---|---|
| World Machine | 设备网络（显式连线） | 构建产物 + 渐进分辨率构建 | 设备级重建；tile 级局部导出；无空间脏区 | Bypass（临时）/ Disable（持久）设备 | 网络本身即谱系；无对象级溯源 |
| Gaea | 节点图 | 节点烘焙缓存（显式） | 修改节点后默认失效，烘焙可阻断重算 | 无（Unbake 恢复可编辑） | 图结构即谱系 |
| Houdini | SOP 网络 | cook 产物（按需求值） | pull 式 dirty 标记，节点粒度 | 节点级 bypass/display 标志 | 节点图即谱系 |
| GDAL | 无图（用户用脚本串联） | VRT/GDALG：声明式派生描述 | 无失效概念：按读重算 + block cache | 无 | VRT XML 内嵌来源与操作（结构化谱系） |
| GRASS GIS | 无图（模块串联） | 每个输出是新 raster map | 无自动失效（显式覆盖需 `--overwrite`） | r.mask：空间级"禁改/禁生成"区域 | **每张地图内建历史**（创建者/源/命令行） |
| QGIS | 模型设计器（显式 DAG） | 模型输出（每次运行生成） | 无自动失效（手动重跑） | Deactivate 算法 + 连带下游 | 模型文件记录算法+参数+输入 |
| Unreal Landscape | 无（层栈顺序即"图"） | 编辑层 / 权重层 | 修改即时生效于所在层 | 层 Lock / Hide；层顺序与 Alpha | 无对象级溯源 |
| Cities: Skylines II | 无 | 无（就地编辑） | 就地修改，无失效概念 | 无（材质覆盖是视觉层） | 无 |
| Blender Geometry Nodes | 节点树 + 修改器栈 | 节点求值结果；显式 Bake 节点 | 依赖图标记更新（整体节点粒度） | 修改器显示/渲染开关；模拟区 Skip | 节点树即谱系；Bake 数据带版本风险 |
| Substance Designer | 节点图 | 图输出；实例节点（参数化复用） | 参数变更沿继承链传播重算 | 参数继承 Absolute = 实例级覆盖锁定 | 图 + 实例关系即谱系 |

核心判断：**五个维度中，前两个（DAG、派生数据）与后两个的一半（UI 级开关、结构化谱系）在业界都有成熟先例；而「删除生成结果 ≠ 删除生成器，以 Suppression 持久化用户意图」与「空间级 Dirty Region 传播」在所调研的所有系统中都没有完整先例**——前者最接近的是 UE 的层 Hide/Lock 与 QGIS 的 Deactivate，后者最接近的是 World Machine 的 tile 边界处理。这两点是本项目真正的差异化设计，也是最容易踩坑的地方（见 §3）。

---

## 1. 逐系统模式概述

### 1.1 World Machine（程序化地形）

来源：官方帮助站 World Machine Help（User's Guide 章节，访问日期 2026-10-02）。

- **设备网络**：世界由 device 及其连线定义，device 分为 Generator（创建数据）/ Filter & Combiner（修改数据）/ Output（导出数据），端口类型化（输入/输出/底部 mask 输入/顶部 parameter port）。来源：[Device Workspace](https://help.world-machine.com/topic/devices-and-the-device-workspace/)（访问 2026-10-02）。
- **构建状态可见**：每个设备有状态灯——深绿（已完整构建）、浅绿（已连接但只有渐进预览，"devices are built in the background up to certain resolution"，分辨率逐步升高）、红（未连接/错误）。这是一个「current / partially built」的现成 UI 先例，对应 charter §32 的 Outdated 状态。来源同上。
- **Bypass vs Disable 两级抑制**：Bypass Device =「暂时让设备不做事，用于对比开关效果」；Disable Device =「设备灰掉，构建时不激活，**任何依赖其输出的设备也将构建失败**」，可再启用。来源同上。
- **Mask 输入端口**：部分设备有 mask 输入端口"controls the area of effect of that device"——空间上限定 Processor 作用域的直接先例（对应 charter §18 空间级抑制的"Processor 侧"对偶物）。来源同上。
- **调试 Overlay**：可按构建耗时 / 内存 / **tile blending 兼容性** 给设备与连线着色——「按资源消耗与 tile 兼容性可视化」的调试视图先例。来源同上。
- **Tiled Build 与上下文丢失陷阱**（对本项目最重要的警示）：Pro 版支持把输出切成 tile 导出，且支持「Tile Output Subset」——只重导出**被修改区域涉及的 tile**（官方原文："useful if you have made modifications to only certain regions of your world and want to overwrite only those specific tiles"）。但官方同时明确警告：Erosion、Snow 等**上下文敏感设备在 tile 模式与整图模式下结果不同**，因为 tiling 后设备拿不到 tile 外的信息；WM 的补偿办法是**每个 tile 多构建一圈周边数据，再在 Merging 阶段按 Blending Percentage 混合**。来源：[Professional Edition Addendum](https://help.world-machine.com/topic/world-machine-professional-edition-addendum/)（访问 2026-10-02）。
- **多分辨率缓存**：Tiled File Input 设备内部用"multi-resolution cache"加速大 tileset 操作。来源同上。
- **分辨率与范围是项目级参数**：Render Extents / 分辨率可整体调整，XML 自动化脚本可在不同分辨率/范围下重复构建同一世界（`<world res="512">` + `<build mode="normal"/>`），并可按组 enable/disable 设备。来源同上。
- **复用单元**：Groups（组织）、Macro（设备组合成带宏端口的单元）、Blueprint（保存到库的可复用设备组）。来源：Device Workspace 页及 [User's Guide 目录](https://help.world-machine.com/topics/manual/)（访问 2026-10-02）。

**没有的**：空间脏区传播（修改一块高度后是设备级重建）、对象级 Suppression、生成对象的稳定身份与溯源（无"第 27 个绿洲"的概念，eroded heightfield 没有"哪些要素来自哪个设备"的记录）。

### 1.2 Gaea（程序化地形）

来源：QuadSpinner 官方文档 docs.gaea.app（访问 2026-10-02）。

- **节点烘焙（Baking）**：把节点在选定分辨率下"锁定"——"Baking a node saves its current state at a chosen resolution, which allows for faster loading and **prevents the node from being recalculated unless explicitly unbaked or modified**"。配套操作：Bake Selected / Bake Required Nodes（用于 tiling 操作，保证跨 segment 无缝）/ Unbake Selected / Unbake All / Force Load Baked Cache；烘焙分辨率可选 1024²–8192²。来源：[Baking Nodes](https://docs.gaea.app/using/using-gaea/baking-nodes/index.html)（访问 2026-10-02）。
- **磁盘缓存与会话缓存**："Cache Previews to Disk"（前身 Session Cache）在关闭文件或空闲时把预览与构建结果写盘，重开文件时直接载入；可 Delete Cache。另有 **Linchpin Nodes** 机制降低单次会话需载入内存的数据量。来源同上。
- 解读：Gaea 把「Generated Data 可视为 Cache、可整体删除重建」落到实处——烘焙缓存是显式的、可清理的、可强制重载的，与 charter §44（Generated Data 可视为 Cache）同构；但它没有把「用户意图」从缓存中分离出来（unbake 后修改即全量重算）。

### 1.3 Houdini（节点式 DCC / 程序化管线的事实标准）

来源：SideFX 官方 HDK 文档（访问 2026-10-02）。

- **Cook 引擎 = 函数式 + 拉取式 + dirty 标记**（HDK 官方原文要点）："the cooking architecture is one of the *functional* programming paradigm"——同一输入求值结果相同、无副作用；"Nodes are never cooked unless they are asked for their data"；UI 观察 display 打开的节点，"When it is informed that such a node is out of date (aka 'dirty'), then the UI element asks the node for its data"；recook 时向上游拉取输入，"If Houdini at any point encounters a node that is up to date, then no further cooking will be done"。来源：[HDK: Cooking](https://www.sidefx.com/docs/hdk/_h_d_k__op_basics__overview__cooking.html)（访问 2026-10-02）。
- **失效粒度是节点级**：recook 单位是整个节点的输出（`cookMySop()`），没有"只重算节点输出的一部分空间区域"的概念。对本项目：charter §30 的 Dirty Region 是超越 Houdini 的增量，正因为业界标准是节点粒度，做区域级时要自己补齐 Houdini 不需要面对的问题（见 §3.1）。
- **节点标志**：节点带运行时标志系统（display / bypass 等），由 `OP_NodeFlags` 管理。来源：[OP_NodeFlags Class Reference](https://www.sidefx.com/docs/hdk/class_o_p___node_flags.html)（API 参考，访问 2026-10-02；具体标志语义为文档结构推断，中等可信）。
- **操作纪律**：官方警告 cook 期间不得修改参数或节点外数据——"the *functional* paradigm of cooking implies that it is invalid to set parameters or otherwise modify data outside your node while cooking"。即 Processor 求值必须是纯函数，这是 charter §21（不原地修改输入）的工业级表述。来源：HDK: Cooking。

### 1.4 GDAL（GIS 处理链的基础库）

来源：GDAL 官方文档 gdal.org（访问 2026-10-02）。

- **VRT（Virtual Format）= 声明式派生数据描述**：VRT 允许"virtual GDAL dataset ... composed from other GDAL datasets with repositioning, and algorithms potentially applied"；描述存在 XML（`.vrt`）里：每个 VRTRasterBand 声明自己的 source（SimpleSource / ComplexSource（含缩放、LUT、NODATA 掩膜）/ AveragedSource / KernelFilteredSource（卷积核）/ NoDataFromMaskSource 等），并注明源文件、源波段、SrcRect/DstRect；其上还有 Warped VRT（重投影）、Pansharpened VRT、Derived Bands（像素函数）、Multidimensional VRT。来源：[VRT — GDAL Virtual Format](https://gdal.org/en/stable/drivers/raster/vrt.html)（访问 2026-10-02）。
  - **谱系即格式**：VRT XML 本身就是 machine-readable 的 lineage——每个派生波段记录了"从哪个文件的哪个波段、经过什么映射/变换而来"。这是 charter §19（Provenance 记录 derived_from、processor、参数）的极简实现范本。
  - **无失效机制**：VRT 不缓存派生结果，读取时按需重算（配合 GDAL 的 block cache，默认块大小 128×128）；上游文件改变时 VRT 的结果"自动"跟着变——因为它每次都重读。换来的代价是昂贵操作反复重算。来源同上。
- **GDALG（GDAL 3.11+，流式算法）**：新驱动读取一个 JSON（`{"type":"gdal_streamed_alg","command_line":"gdal raster pipeline ! read in.tif ! reproject ..."}`），把 **gdal CLI 命令行本身**当作可打开的数据集，"on-the-fly / streamed raster dataset"，官方定位"conceptually close to VRT, although the implementation is substantially different"。来源：[GDALG: GDAL Streamed Algorithm](https://gdal.org/en/stable/drivers/raster/gdalg.html)（访问 2026-10-02）。
  - 意义：GIS 世界正在从「跑脚本生成新文件」走向「把处理链本身序列化为数据集描述」——与本项目把 Processor Graph 序列化进世界文件是同一方向。

### 1.5 GRASS GIS（GIS 处理链）

来源：GRASS 官方手册 grass.osgeo.org（访问 2026-10-02）。

- **模块即 Processor**：`r.*` 模块都是"输入 raster → 输出新 raster"，默认不原地修改（覆盖需显式 `--overwrite`）。
- **每张地图自带 Provenance（最强先例）**：`r.info` 输出内建历史字段：`creator`（创建者登录名）、`date`、`source1`（数据源，如 "raster elevation file elev_ned10m"）、`description`（"generated by r.slope.aspect"）、`comments`（**完整命令行与参数**，如 "slope map elev = elev_ned10m\nzfactor = 1.00 format = degrees\nmin_slp_allowed = ..."）。`r.info -h` 专门打印历史，`-e` 打印扩展元数据（还有 `semantic_label` 字段）。来源：[r.info](https://grass.osgeo.org/grass-stable/manuals/r.info.html)（访问 2026-10-02）。
  - 关键启示：GRASS 的溯源成本极低——模块在写结果时顺手把「模块名 + 完整参数 + 输入地图名」写进结果的历史文件（GIS 层面的 plugin lock：半年后用 `comments` 里的命令行可以复现这张图）。本项目给每个 Generated 对象写 provenance 应当达到同样的"顺手、无感"程度。
- **r.mask = 空间级抑制的区域对偶**：mask 是一张名为 `MASK` 的 reclass 栅格，"data falling outside the mask is treated as if it were NULL"——即**限定所有后续模块的作用区域**；`r.mask -r` 移除后一切恢复正常。官方手册明确 mask 的语义是"the mask specifies the area that should be considered for the operations and area which should be ignored"。来源：[r.mask](https://grass.osgeo.org/grass-stable/manuals/r.mask.html)（访问 2026-10-02）。
  - 它是「区域上禁止生成/修改某类对象」的手工先例：mask 不是删除数据，而是一个可随时撤销的持久意图，改变了后续所有 Processor 的有效作用域——与 charter §18 空间级 Suppression 高度同构，但 GRASS 的 mask 是全局单例，本项目需要的是可命名、可叠加、按 semantic 过滤的多重 mask。
- **没有的**：无处理图、无自动失效、无对象级身份（raster 是场不是对象集合）。

### 1.6 QGIS（GIS 处理链 / 桌面 GIS）

来源：QGIS 官方文档 docs.qgis.org（访问 2026-10-02）。

- **模型设计器（Model Designer）**：把算法链包成可反复执行的模型——"a model is executed as a single algorithm"；模型输入（Model Input）与算法输出（Algorithm Output）显式连接，"When you use the output of a previous algorithm as the input of your algorithm, that implicitly sets the previous algorithm as parent"；还有显式 **Dependencies** 参数处理"不传数据但有顺序依赖"的边。模型存为 `.model3` 文件（或嵌入工程文件），可导出为 Python 脚本。来源：[The model designer](https://docs.qgis.org/3.34/en/docs/user_manual/processing/modeler.html)（访问 2026-10-02）。
- **类型化接口是入图门槛**："To be included in a model, an algorithm must have the correct semantic. If an algorithm does not have such a well-defined semantic (**for instance, if the number of output layers cannot be known in advance**), then it is not possible to use it within a model"。来源同上。——输出可预知才能进 DAG，这对 charter §24（按类型/semantic 声明输入输出）是直接佐证。
- **DAG 完整性保护**：删除算法时，"An algorithm can be removed only if there are no other algorithms depending on it"，否则弹警告。来源同上。
- **Deactivate = 子图级抑制**："A model can be run partially by deactivating some of its algorithms"——被禁用算法**连同所有依赖它的算法**一起变灰、不执行，可随时 Activate 恢复。来源同上。——这是所调研系统中语义上最接近「Suppression 传播」的机制：抑制一个节点会沿依赖方向传播，且完全可逆。
- **没有的**：无自动失效/重算（输入数据变了模型不会自己重跑）、无对象级溯源（模型本身有谱系，产物文件没有）。

### 1.7 Unreal Engine：Landscape Edit Layers + Blueprint Brushes（游戏引擎地形）

来源：Epic 官方文档 dev.epicgames.com（访问 2026-10-02）。

- **编辑层（Edit Layers）**：UE5 用非破坏层编辑 Heightmap/Weightmap——"Edit layers exist in a stack-based workflow and act as independent, non-destructive containers"；每层可独立编辑、重排序（"you can drag and drop layers in any order"）、隐藏（Hide = 从混合中排除）、**锁定**（"Locked edit layers cannot be modified in any way. This includes actions like sculpting, painting, collapsing, and managing Blueprint brushes"）；每层有 Heightmap Alpha 与 Weightmap Alpha（负 alpha = 减法混合）。来源：[Landscape Edit Layers in Unreal Engine](https://dev.epicgames.com/documentation/unreal-engine/landscape-edit-layers-in-unreal-engine?application_version=5.5)（访问 2026-10-02）。
  - **Layer Contribution 可视化**：可高亮"你的层对最终高度图的贡献"——调试单一来源影响的现成 UI 先例（对应 charter §38 的 Generated/Intent 调试视图）。来源同上。
  - **Collapse（压平）是显式破坏性操作**："Collapse: Merge the edit layer into the layer below"；"Collapse All Layers: Destructive collapse, removing all Blueprint Brushes"。非破坏是常态，破坏性合并必须显式点名。来源同上。
  - **专属程序化层**：Splines Edit Layer / Patches Edit Layer "only supports procedural data. It cannot be sculpted or painted by hand"——层可以声明「只接受程序化数据」或反过来（基础层接受手绘），即层与数据来源存在类型约束。来源同上。
- **Blueprint Brushes（程序化笔刷）**："a stack of user-defined sculpting brushes that can be manipulated non-destructively, so that **any changes to a brush lower in the stack automatically flow through to the brushes above it**"；笔刷有混合模式（Alpha Blend / Min / Max / Additive），LandmassRiver 笔刷沿样条挤出并让地形自动贴合（河/路的先例）。来源：[Landscape Blueprint Brushes in Unreal Engine](https://dev.epicgames.com/documentation/en-us/unreal-engine/landscape-blueprint-brushes-in-unreal-engine?application_version=5.5)（访问 2026-10-02）。
  - 解读：UE 的层栈 = 一个「顺序即语义」的隐式 DAG：手绘层（Authored）与程序化笔刷（Generated 参数化操作）在同一个栈里按顺序解析，Hide/Lock/Alpha 就是持久用户意图（对应 charter §39 Freeze/Lock 与 §11 优先级）。它没有显式图、没有自动失效，但**它把「用户意图作为一等数据（层的可见性/锁定/透明度）持久化在世界里」**这一点做对了。
- **UE PCG 框架（简）**：PCG 子系统以图调度刷新——`UPCGSubsystem::ScheduleRefresh` "Schedule refresh on the current or next frame"（编辑器中输入变化 → 调度重评估）。来源：[UPCGSubsystem::ScheduleRefresh](https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/PCG/UPCGSubsystem/ScheduleRefresh?application_version=5.0)（API 文档，访问 2026-10-02）。图执行器源码中存在"把无输入/已满足的任务推入就绪队列"的调度逻辑（见引用清单，源码级佐证，中等可信）。PCG 结果默认是再生成的派生数据，编辑器刷新触发重算——是「Processor 图 + 按需重评估」在游戏引擎内的对应物，但无空间脏区。

### 1.8 Cities: Skylines II 地图编辑器（游戏引擎地图编辑）

来源：Paradox 官方验证 wiki（cs2.paradoxwikis.com，页面标注 "Verified by Paradox Interactive for version 1.6.0 f1"，访问 2026-10-02）。

- **工作流是「外部生成 + 导入 + 就地雕刻」**：高度图为 4096² 16-bit PNG/TIFF，可导入/导出，"Exported heightmaps ... can be edited in external applications before being re-imported"；地形工具（抬升/压平/坡度/平滑）与材质笔刷都是**就地修改**，无层、无图、无失效概念。来源：[Map Creation: Terrain](https://cs2.paradoxwikis.com/Map_Creation:_Terrain)（访问 2026-10-02）。
- **「生成底 + 手绘面」混合的一个样本**：地表材质分两部分——基础纹理**由地形属性（海拔、坡度、水覆盖、地形变化）程序化生成**，用户绘制材质作为额外层叠加；渲染时按固定优先级解析（Rock/Cliff > 手绘层 01–04 > Dirt > Grass），"Erasing removes the painted material and returns the terrain to its **automatically generated appearance**"。来源同上。
- **警示价值**：
  - 手绘材质**只是视觉覆盖**，不进入任何游戏逻辑（对应 charter §12 要避免的"视觉假象"）。
  - 生成底与手绘层的解析顺序是**渲染器里写死的优先级**，不是 Resolver 的显式规则（对应 charter §34「严禁把世界逻辑藏进 Renderer」的反面教材）。
  - 无撤销粒度/无谱系：改坏了只能重导入高度图。作为「不做 Processor/Resolver 分层」的自然终态样本非常有说服力。
  - 正面样本价值：Base Generated + Authored overlay + "erase 恢复自动外观" 的用户体验直觉是对的，本项目 Eraser 语义（charter §62）可以借鉴这种「擦掉手绘 = 回到生成结果」的心智模型。

### 1.9 Blender Geometry Nodes（节点式 DCC）

来源：Blender 官方手册 docs.blender.org 及官方手册仓库 blender-manual 源文件（访问 2026-10-02）。

- **Bake 节点 = 显式中间缓存**："The Bake node allows saving and loading intermediate geometries. This node bakes parts of the node tree for better performance"；烘焙目标可选 Packed（打进 .blend）或 Disk；数据格式"not considered to be an import/export format"；**官方明示版本风险**："It's not guaranteed that data written with one Blender version can be read by another Blender version"。来源：[Baking（手册）](https://docs.blender.org/manual/en/4.4/modeling/geometry_nodes/baking.html)、[Bake 节点（手册仓库源文件）](https://projects.blender.org/blender/blender-manual/raw/branch/main/manual/modeling/geometry_nodes/geometry/operations/bake.rst)（访问 2026-10-02）。
  - 解读：缓存可删、可重算（bake 是显式动作，删 bake 数据世界无损），符合 charter §44；但"跨版本缓存不可读"正是 charter §46–48（Plugin Lock / 版本分离）要系统性解决的问题——Blender 选择容忍，本项目应选择版本化。
- **Simulation Zone = 显式循环容器**（对 charter §25 的直接印证）："Simulation zones allow the result of one frame to influence the next one"；区域封闭——"It is not possible to have any link going towards outside. The result of the simulation can only be accessed via the Simulation Output node"；输入只在起点求值一次；还有两条极有用的设计笔记：
  - "Anonymous attributes are not propagated by the simulation nodes unless they are explicitly stored in the simulation state. This is because detecting which anonymous attributes will be required ... would require **looking into the future**"（跨迭代状态必须显式声明）。
  - 模拟在播放时**自动缓存**（timeline 上显示有效缓存区间），可 opt-out，渲染农场场景可 bake 到磁盘支持非顺序渲染。
  - 来源：[Simulation Zone（手册仓库源文件）](https://projects.blender.org/blender/blender-manual/raw/branch/main/manual/modeling/geometry_nodes/simulation/simulation_zone.rst)（访问 2026-10-02）。
  - 即 Blender 的做法与 charter §25 一致：普通图禁止隐式循环，循环必须装进显式管理迭代/缓存的专用容器（SimulationLoop ↔ Simulation Zone），并要求显式声明跨迭代状态。
- **修改器栈 = 非破坏 User Intent 栈**：几何节点以修改器形式挂在对象上，修改器可整体开关——尽管本次未逐字引用手册条目，这是 Blender 的基础行为（修改器栈定义求值管线，派生几何永不写回基网格）。可信度：高（Blender 长期文档化行为），如需逐字引用可在 blueprint 阶段补充。

### 1.10 Substance 3D Designer（节点式 DCC / 材质）

来源：Adobe 官方文档 experienceleague.adobe.com（访问 2026-10-02）。

- **实例节点（instance）**："an *instance node* is a node representing a graph in another graph, with its **own discrete parameter values**"——同一源图（如 perlin_noise）可有多个实例，各自持有参数。来源：[Inheritance in Substance graphs](https://experienceleague.adobe.com/en/docs/substance-3d-designer/using/substance-graphs/inheritance-in-substance-compositing-graphs)（访问 2026-10-02）。
- **参数继承三级 + 属性级覆盖**：每个节点的 Base 参数（Output Size / Output Format / Pixel Size / Pixel Ratio / Tiling Mode / **Random Seed**）都有继承方法——**Absolute**（本地任意取值，不继承）、**Relative to input**（从主输入继承）、**Relative to parent**（从父图/宿主继承）；改一处源值会"carry out that change across all nodes which inherit from it"；相对值可做 `(1,-1)` 这类"高一级/低一级分辨率"的相对修改。来源同上。
  - 解读：这就是**属性级细粒度 Override 的成熟范本**（charter §15）：默认继承（生成值），用户显式改哪一项就只覆盖哪一项（Absolute），其余照常随上游流动。且注意 Random Seed 是普通参数——种子属于可继承/可覆盖的属性，而非全局黑盒，与 charter §45 的 seed 记录相容。
- **发布即锁（SBSAR = Plugin Lock 先例）**："Parenthood is applied as-is when publishing a package to ... (SBSAR). This means setting any parameter to the *Absolute* inheritance method will **lock** that parameter to its current value in the published asset"；官方"strongly recommend using Relative to… inheritance unless there is a clear, deliberate purpose"。来源同上。
  - 发布的 .sbsar 把解析结果固化，消费端拿到的是锁定值——与 charter §46「世界保存 plugin/version/hash，旧世界不被升级偷改」动机一致（Substance 用"锁定发布"，本项目用"世界内 lockfile"，本项目方案对长生命周期世界更稳）。
- **In-context editing**：可进入实例节点内部编辑子图，此时"the parent of the graph is the instance node"——实例与源图可分离演进。来源同上。

---

## 2. 可借鉴模式清单（按 charter 概念分组）

### Processor DAG 与接口

1. **类型化端口是入图门槛**（Houdini 端口、QGIS"输出不可预知的算法不得入模"）：Processor 的输入输出必须可静态枚举类型与语义，否则拒绝进图。→ 直接支持 charter §24。
2. **显式依赖边补数据流边**（QGIS Dependencies 参数）：存在"无数据传递但必须先后执行"的顺序依赖，图模型要允许显式顺序边。→ 蓝图中 Dependency Graph ≠ 数据连线。
3. **DAG 完整性保护**（QGIS：有依赖者的节点禁删；WM：禁用设备会让依赖者构建失败并如实显示红/失败状态）：删除/禁用节点时对下游的影响必须显式建模并向用户呈现，而不是静默。
4. **复用三级**（WM Group / Macro / Blueprint；Substance instance；Blender node group）：组（纯组织）→ 宏/子图（带端口封装）→ 库组件（跨世界复用）。第一版只需要 Group 级别。

### 派生数据与缓存

5. **渐进分辨率构建 + 状态灯**（WM 浅绿→深绿）：昂贵 Processor 先出低分辨率结果再后台精化，状态灯区分 built / partial / error。→ charter §32/§38 的状态可视化的现成 UX。
6. **显式 Bake 与缓存生命周期**（Gaea bake/unbake/delete cache；Blender Bake 节点 packed/disk）：缓存必须是显式、可清理、可强制重载的；缓存丢失永远无损（world 可重建）。
7. **声明式派生描述作为交换格式**（GDAL VRT/GDALG；QGIS .model3）：把「怎么算的」序列化为独立于结果的文件，读取方可选择现算或用缓存。→ 世界文件中 Processor Graph 与 Generated Cache 的双轨结构（charter §44）。
8. **多分辨率缓存**（WM tiled input 的 multi-resolution cache；charter §33 LOD）：缓存按 LOD 分层，读取端按视口需求取用。

### 失效与脏区

9. **Pull 式求值**（Houdini HDK 官方定义）：只在被请求且 dirty 时重算，向上游拉取，遇最新节点即停。→ charter §32 的引擎级实现方式；比"编辑事件主动推送失效"更稳。
10. **Outdated 状态 + 手动 Rebuild**（Houdini UI 观察者驱动 cook；WM 需手动触发 Build；QGIS 模型需手动重跑）：三个不同领域一致选择「不自动全量重算」。
11. **tile 级局部导出**（WM Tile Output Subset）：只重建/重导出受影响 tile 是可行的，且被商业工具验证。
12. **上下文敏感设备的邻域补偿**（WM：erosion/snow tile 边界外扩 + blending）：charter §31 的 Invalidation Policy 除了 Neighborhood(radius) 还需要**上下文半径/填充**概念——重算时给 tile 外扩 padding，再在 tile 接缝混合，否则局部重算结果与全图重算不一致（WM 官方承认两者结果不同，只能混合缓解）。

### Override / Suppression / Lock / Freeze

13. **层栈 + Lock/Hide/Alpha 作为持久意图**（UE Landscape Edit Layers）：用户意图（锁定、隐藏、透明度、顺序）作为数据持久化，非破坏是默认，破坏性 Collapse 必须显式。→ charter §39（Lock/Freeze 是正式 Intent）的引擎级先例。
14. **两级抑制**（WM：Bypass=临时对比，Disable=持久关闭且下游如实失败；QGIS：Deactivate 连同下游一起失效、可恢复）：Suppression 应区分「临时试一下」和「持久意图」，且抑制有传播语义。
15. **属性级继承 + Absolute 覆盖**（Substance）：默认继承生成值，用户只覆盖显式改动的属性；覆盖即"锁定为绝对值"，其余属性继续跟随上游。→ charter §15 的直接范本。
16. **空间作用域控制**（WM 设备 mask 输入端口；GRASS r.mask）：Processor 接受可选的 mask 输入（作用域限制），mask 本身是可撤销的持久意图；GRASS 证明"mask 之外当 NULL"的语义简单可用。
17. **擦除回到生成结果**（CS2 材质擦除恢复自动外观）：Eraser 抹掉 Authored 覆盖后显示 Generated 底层的直觉，用户已经从其他软件学过。→ charter §62 的 UX 参考。

### Provenance 与可复现

18. **生成时顺手写谱系**（GRASS：creator/date/source/模块名/完整命令行进地图历史；GDAL VRT：XML 即谱系）：溯源信息在**写入时**生成，格式机器可读，成本≈0。→ charter §19 的最低实现标准：每个 Generated 对象至少记录 processor id、输入引用、完整参数、时间与作者/插件版本。
19. **发布即锁定**（Substance SBSAR Absolute 锁定；charter §46 Plugin Lock）：对外分发/长期保存时把参数与实现锁定，升级需显式迁移。
20. **种子是普通参数**（Substance Random Seed 继承链）：seed 应像其他参数一样走继承/覆盖/记录，而非游离在图外的全局状态。

---

## 3. 要避的坑（全部有官方来源背书）

1. **局部重算结果 ≠ 全图重算结果**（World Machine 官方承认 tiled 与 normal 构建下 Erosion/Snow 结果不同，只能靠外扩+混合近似）。教训：Dirty Region 重算必须要求 Processor 声明**确定性上下文**（需要多大邻域才能与全图一致），否则"局部重算"会产出"从未存在过的世界"。对 Hydrology 这类全局汇聚型 Processor，这基本不可能完全成立——需接受近似或降级为更大范围重算（charter §31 的 Downstream 策略必须回答"汇水区边界怎么算"）。
2. **缓存跨版本不可读**（Blender 官方明示 bake 数据跨版本不保证可读）。教训：缓存要么带版本与内容 hash、不匹配即弃（重算），要么根本不长期保存；绝不能让缓存成为事实上的数据源（charter §44 的"Cache 可删除"必须是硬保证）。
3. **参数继承链失控**（Substance 官方把"沿继承链排查意外分辨率/精度"写成 troubleshooting 专节，并点名 Blend 节点主输入易弄错）。教训：Override/继承让"这个值从哪来"变成调试难题，Resolver 必须能回答"最终值由谁决定"——charter §38 的 Conflict/Provenance 调试视图不是可选装饰，是继承机制的自带成本。
4. **抑制的静默传播**（WM Disable 会让依赖设备"fail to build"而不是空结果；QGIS Deactivate 连带下游全部变灰）。教训：抑制/禁用一个上游节点时，下游是「失败」「跳过」还是「回退默认」，必须显式选择并显示；静默空白最伤信任。
5. **把世界逻辑写进渲染/混合层**（CS2 的材质优先级表是渲染器行为，用户无法让手绘沙子参与逻辑）。教训：Resolved World 必须由 Resolver 产出，Renderer 只读（charter §34/§54）——CS2 证明跳过 Resolver 的系统最终会把优先级硬编码进 shader。
6. **就地编辑 + 外部往返**（CS2 高度图导出→外部改→重导入；改坏无粒度化撤销）。教训：唯一写入路径应是 Authoring Operation + Processor，任何"导出再导入"的修补流程都意味着模型缺了非破坏编辑能力。
7. **自动重算的失控成本**（对照面：Houdini/WM/QGIS 全部选择按需或手动触发；Gaea 用空闲时缓存来追平体验）。教训：默认 Outdated+Rebuild（charter §32），自动重算只留给声明了低 cost hint 的 Processor。
8. **跨迭代状态靠猜**（Blender 官方注释：匿名属性不自动进模拟状态，否则"需要预见未来"）。教训：未来 SimulationLoop 的迭代间状态必须显式声明字段，不做隐式全量携带。

---

## 4. 对本项目蓝图（票 #5）的直接建议

按对第一版 vertical slice（charter「最小验证用例」14 步）的影响排序：

1. **Resolver 一次做对三件事**：优先级解析（Explicit Override > Authored > Generated，charter §51）、Suppression 过滤（Resolved = Generated + Intent − Suppressed）、**决策溯源查询**（"这个像素/对象为什么是这个值"）。第 3 件是 Substance 继承链调试痛点的解药，也是 charter §38/§53 的落点；建议 Resolver 每次合并时顺手产出 decision 记录（谁、依据什么意图、覆盖了谁），Debug 视图只是它的渲染。
2. **Invalidation Policy 增加 `context`（上下文填充）字段**：在 charter §31 的 Local/Neighborhood/Downstream/ConnectedRegion/Global 之外，每个策略需声明"tile 外扩多少、接缝如何处理"。Neighborhood(radius) 的 radius 就是 padding；Downstream 需要说明汇水区是否跨 tile（第一版可以限定 Hydrology 触发更大重算范围，但要写进 policy 而不是特例代码）。World Machine 用外扩+混合逼近全图结果，我们应当让「局部重算 == 全图重算」成为可测试的性质（同 seed 同输入下逐字节比较）。
3. **Provenance 采用 GRASS 式"写入时顺手记录"**：Generated 数据落盘即携带 `{processor_id, plugin_version+hash, inputs(数据 id+hash), params, seed, region, timestamp}`（charter §19/§45/§46 的并集）。第一版甚至可以就是 JSON sidecar；不要做"事后从日志重建谱系"的复杂方案。
4. **Suppression 分两级 + 传播语义显式化**：`temporary（试对比，对应 Bypass）`与`persistent intent（持久，入 Undo/History，charter §41）`；空间级 Suppression 实现为「作用在 Processor 上的持久 mask 意图」（参考 WM mask 端口与 r.mask 语义），而不是在生成结果上打洞。禁用/抑制上游时，下游明确选「跳过」或「回退默认」并显示，不静默。
5. **Dirty Region 用 pull 模型实现**：编辑只把受影响 tile 标 dirty（charter §29/§30），重算由请求（渲染/查询/用户 Rebuild）触发，沿 DAG 向上拉取，遇到 clean 子图即停（Houdini 模型）。这比推送式失效简单且天然支持 Outdated 状态——第一版不用做后台调度器。
6. **缓存三原则**（对照 Gaea/Blender 的教训）：显式 bake/删除；带 format/plugin 版本与 hash，不匹配即重算；缓存可整体丢弃且永远可由 `Authored + Operations + Processors + Params + Seed` 重建（charter §44）。LOD 缓存按级存储（charter §33）。
7. **Processor 接口以"可预测输出"为入图条件**（QGIS 规则）：input/output 必须声明 type + semantic/capability（charter §24），输出数量/类型在声明期可枚举；不能枚举的算法只能作为"终端工具"存在，不得进图。
8. **显式 Collapse（压平）作为后期功能占位**：UE 的经验是非破坏栈会膨胀，最终需要"把 N 层合并为一层"的显式破坏性操作。第一版不实现，但 Authoring Operation 的设计（charter §41）要保证 Collapse = 「删除若干 Op + 落一个 Snapshot」可表达，不需要新机制。
9. **避免照抄的**：Layer 不进核心数据模型（charter §4 已定，UE/CS2 恰好是反面参照——层是 UI 概念，UE 自己也要靠 Splines/Patches 专属层来补救"层里混程序化数据"的混乱）；不做自动全量重算；不做 SBSAR 式"发布即锁死"（我们用世界内 lockfile，保留迁移路径，charter §47/§48）。
10. **最小验证用例的映射提示**：14 步验收中「删 Generated River → Suppression → 不复现 → 恢复」这条链没有任何被调研系统完整做过，是本项目必须自证的核心创新；实现顺序建议 Resolver 的 Suppression 过滤最先写测试（纯函数、无 IO），Dirty Region 第二（需要 tile 化 Field），Provenance 随 Hydrology Processor 一起落（写入时顺手记）。

---

## 5. 引用清单

访问日期均为 **2026-10-02**。类型：官方文档（一手）为主。

| # | 来源 | 类型 | 用于 |
|---|---|---|---|
| 1 | [World Machine Help — 2. Device Workspace](https://help.world-machine.com/topic/devices-and-the-device-workspace/) | 官方文档 | 设备网络/状态灯/Bypass/Disable/mask 端口/Overlay |
| 2 | [World Machine Help — Professional Edition Addendum](https://help.world-machine.com/topic/world-machine-professional-edition-addendum/) | 官方文档 | Tiled Build、Tile Output Subset、tile 上下文丢失与外扩混合、多分辨率缓存、XML 自动化 |
| 3 | [Gaea Docs — Baking Nodes](https://docs.gaea.app/using/using-gaea/baking-nodes/index.html) | 官方文档 | 烘焙/Unbake/磁盘缓存/Linchpin |
| 4 | [SideFX HDK — Cooking](https://www.sidefx.com/docs/hdk/_h_d_k__op_basics__overview__cooking.html) | 官方开发文档 | 函数式/拉取式 cook、dirty 语义、cook 期间禁改外部数据 |
| 5 | [SideFX HDK — OP_NodeFlags Class Reference](https://www.sidefx.com/docs/hdk/class_o_p___node_flags.html) | 官方 API 参考 | 节点标志存在性（语义细节为推断，中等可信） |
| 6 | [GDAL Docs — VRT: GDAL Virtual Format](https://gdal.org/en/stable/drivers/raster/vrt.html) | 官方文档 | VRT 声明式派生/源类型/谱系即 XML/block cache |
| 7 | [GDAL Docs — GDALG: GDAL Streamed Algorithm](https://gdal.org/en/stable/drivers/raster/gdalg.html) | 官方文档 | 处理链序列化为可打开数据集（3.11+） |
| 8 | [GRASS GIS Manual — r.info](https://grass.osgeo.org/grass-stable/manuals/r.info.html) | 官方文档 | 地图内建历史（creator/source/生成模块/完整命令行） |
| 9 | [GRASS GIS Manual — r.mask](https://grass.osgeo.org/grass-stable/manuals/r.mask.html) | 官方文档 | 空间 mask 语义（mask 外视为 NULL、可移除） |
| 10 | [QGIS Docs — The model designer](https://docs.qgis.org/3.34/en/docs/user_manual/processing/modeler.html) | 官方文档 | 模型 DAG、显式 Dependencies、类型化入图门槛、禁删有依赖节点、Deactivate 连带下游 |
| 11 | [Epic Docs — Landscape Edit Layers in Unreal Engine (5.5)](https://dev.epicgames.com/documentation/unreal-engine/landscape-edit-layers-in-unreal-engine?application_version=5.5) | 官方文档 | 层栈/Lock/Hide/Alpha/Layer Contribution/Collapse/程序化专属层 |
| 12 | [Epic Docs — Landscape Blueprint Brushes in Unreal Engine (5.5)](https://dev.epicgames.com/documentation/en-us/unreal-engine/landscape-blueprint-brushes-in-unreal-engine?application_version=5.5) | 官方文档 | 非破坏程序化笔刷栈、混合模式、样条河笔刷 |
| 13 | [Epic Docs — UPCGSubsystem::ScheduleRefresh (API)](https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/PCG/UPCGSubsystem/ScheduleRefresh?application_version=5.0) | 官方 API 文档 | PCG 图按帧调度刷新 |
| 14 | [UE PCG 图执行器源码（镜像仓库 PCGGraphExecutor.cpp）](https://raw.githubusercontent.com/chenyong2github/UnrealEngine/c865e168d0935b8e5f4bd865ddcc1c733c8ce7cf/Engine/Plugins/Experimental/PCG/Source/PCG/Private/Graph/PCGGraphExecutor.cpp) | 源码（非官方镜像，中等可信） | 就绪队列调度注释（佐证任务图调度） |
| 15 | [Cities: Skylines 2 Wiki — Map Creation: Terrain（rev 6786，Paradox 验证）](https://cs2.paradoxwikis.com/Map_Creation:_Terrain) | 官方验证 wiki | 高度图导入导出、就地雕刻、生成底+手绘层与固定优先级 |
| 16 | [Blender Manual — Geometry Nodes: Baking (4.4)](https://docs.blender.org/manual/en/4.4/modeling/geometry_nodes/baking.html) | 官方文档 | 烘焙概览与版本风险声明 |
| 17 | [Blender Manual 仓库源文件 — Bake 节点](https://projects.blender.org/blender/blender-manual/raw/branch/main/manual/modeling/geometry_nodes/geometry/operations/bake.rst) | 官方文档源 | Bake 节点输入项/Packed/Disk/版本声明 |
| 18 | [Blender Manual 仓库源文件 — Simulation Zone](https://projects.blender.org/blender/blender-manual/raw/branch/main/manual/modeling/geometry_nodes/simulation/simulation_zone.rst) | 官方文档源 | 封闭模拟区、跨迭代显式状态、播放缓存与磁盘 bake |
| 19 | [Adobe Docs — Inheritance in Substance graphs](https://experienceleague.adobe.com/en/docs/substance-3d-designer/using/substance-graphs/inheritance-in-substance-compositing-graphs) | 官方文档 | 实例节点、参数继承三级、Absolute=锁定、SBSAR 发布锁定、继承链 troubleshooting |

可信度说明：#1–13、15–19 为厂商/项目官方一手来源（#15 为厂商验证 wiki）；#14 为非官方镜像的源码快照，仅用于佐证调度注释，中等可信。所有对"某系统没有 X"的否定性论断，基于以上官方文档对相应功能的记载缺失与对现有功能的完整覆盖，属"文档证据下的强推断"，如需在架构评审中引用，可再针对具体否定项做二次核查。
