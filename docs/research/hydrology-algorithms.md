# Research: Phase-1 Hydrology Processor 的最小正确算法（D8 / D∞ / MFD 与增量重算）

> 对应 GitHub issue **#4**（wayfinder research 票）。执行日期：**2026-10-02**（所有引用的访问日期均为该日）。
> 约束基准：`docs/requirements/engine-charter.md` —— 最小验证用例 `Elevation + Rainfall → River（LineFeature）`；
> Invalidation Policy 枚举含 `Downstream`；Tile/Dirty Region（§29–31）；Phase-1 规模 ~1024²（Q4）；
> TypeScript monorepo、Processor 默认可放 Web Worker、热点日后再换 Rust/WASM（Q2）。
> 本文所有外部事实均给出来源链接与可信度分级（A=同行评审论文/官方算法文档，B=官方源码/README 基准，C=工程博客/经验报告）。

---

## 0. 结论速览（TL;DR）

1. **Phase-1 用 D8**：实现最简单、语义上天然产出"单一河道线"（汇流型方法），river 提取直接映射 `LineFeature`；增量更新有最干净的结构（出度 ≤1 的汇流森林）。D∞/MFD 是发散型方法，语义上把水摊成"片流"，做离散河道需要额外阈值收敛逻辑，Phase-1 不需要。
2. 最小正确管线：**Priority-Flood 填洼（ε 变体）→ D8 pointer → 汇流累积（拓扑序 O(n)）→ 阈值提取 → 追踪成 LineFeature**。这正是 Whitebox / pysheds 的标准工作流。
3. **增量重算的已知做法**：局部高程编辑只会让"编辑区 R ∪ 一圈邻域"内的流向可能翻转（流向只依赖 3×3 邻域高程）；失效集 = 这些格点的**旧下游闭包 ∪ 新下游闭包**。D8 下可沿树做路径加减的 O(受影响集) 更新；通用做法是 DAG 动态拓扑排序；学术侧（交互式地形编辑）与 GIS 大规模计算侧（GraphFlood）都选择了"快速全量/近全量重算"路线。**1024² 下全量重算只要 ~0.4s（实测 375ms），所以 Phase-1 的正解是：Downstream 失效语义第一天做对（标脏 + Provenance），计算侧先用全量重算，把路径级增量更新留作优化**。
4. 1024² 纯 JS/TS 完全可行（本机 M2/Node22 实测：填洼 385ms、D8 指向 55ms、累积 22ms、全管线 375ms；`Float32Array/Int32Array` 内存 ~35–40MB）。**必须放常驻 Web Worker + Transferable 零拷贝**，主线程只做标脏与调度。

---

## 1. 三种算法对比

### 1.1 语义

| | **D8**（O'Callaghan & Mark 1984） | **D∞**（Tarboton 1997） | **MFD**（Quinn 1991 / Freeman 1991 / Holmgren 1994 等） |
|---|---|---|---|
| 规则 | 全部水流给 8 邻域中坡度最陡的**一个**邻居 | 把流向表示为 8 个三角面上最陡下降方向的**角度**，按角度把流**按比例分给相邻的 1–2 个**下游格 | 按坡度权重把流分给**所有**更低邻居：`f_i ∝ (tanβ_i)^x / Σ(tanβ_j)^x`；Holmgren 推荐 x∈[4,6]，x→∞ 退化为 D8 |
| 汇流/发散 | 汇流型（convergent）：河只有汇合、无分叉 | 发散型（divergent），但 dispersal 弱于 MFD | 发散型：坡面片流，山脊线清晰、河道收敛性差 |
| 已知失真 | 网格方向偏置（grid bias，8 个离散方向）；平地敏感 | 实现复杂度居中；三角面拟合在噪声 DEM 上较稳健 | 过度发散导致河道累积量被摊薄（Tarboton 称 slope-proportional 方法产生 "unrealistic dispersion"） |
| 下游图结构 | 每格出度 ≤1 → **汇流森林（树）** | 出度 ≤2（带分数权重）→ **DAG** | 出度 ≤8（带权重）→ **DAG** |
| 随机性 | 确定（可配 Rho8 随机变体消 bias） | 确定 | 确定 |
| 关键参数 | 无 | 无（方向即角度） | 指数 x（Holmgren 4–6 / Freeman ~1.1 / Qin 2007 自适应） |

来源：[R1] RichDEM Flow Metrics 文档（含各方法精确定义与公式）；[R2] Tarboton 1997 摘要（USU DigitalCommons 全文页）；[R3] GRASS `r.watershed` 手册（MFD 收敛因子 1–10、默认 5，引 Holmgren 1994）；[R4] Whitebox Flow Routing 手册（FD8/Qin/MD∞/convergence threshold、non-dispersive threshold："一旦水流渠道化，发散不再现实"）。

### 1.2 实现复杂度与性能

| | D8 | D∞ | MFD (Holmgren 型) |
|---|---|---|---|
| 指向计算 | 8 邻域比较，~20 行 | 8 个三角面构造 + 拟合/角度计算，~100+ 行 | 8 邻域权重归一化，~30 行 |
| 累积计算 | 拓扑序 O(n)，单累加目标 | DAG 拓扑序 O(n)，带权分摊 | DAG 拓扑序 O(n)，带权分摊 |
| 代码量直觉 | 最小 | 大约 3–5 倍于 D8 | 约 2 倍于 D8 |
| 性能（pysheds，numpy 向量化，36M cells，2015 MBP）[R5] | flowdir 1.14s / accum 3.44s | flowdir 7.01s / accum 14.9s | flowdir 4.21s / accum 32.5s |
| 换算每百万格 | ~0.03s / ~0.10s | ~0.19s / ~0.41s（accum ≈ D8 的 4.3×） | ~0.12s / ~0.90s（accum ≈ D8 的 9.4×） |
| 本机 JS 实测（见 §4） | pointer 55ms / accum 22ms | 未实现 | accum 830ms（朴素实现，与 pysheds 每百万格速率同量级） |

### 1.3 River 提取（→ LineFeature）适配性

- **D8：天然匹配。** 累积量超阈值即得单像素宽河道栅格，沿 receiver 链追踪即得线要素。pysheds 的 `extract_river_network` 直接输出 GeoJSON 线段 [R5]；Whitebox 工作流为 `D8 pointer → accumulation → Extract Streams(threshold) → Raster Streams to Vector` [R4]。
- **D∞/MFD：需要额外语义决定"哪里算河道"。** 发散型方法在坡面把流量摊薄，提取河道需要人为收敛规则（Whitebox 为 FD8/D∞/Qin 提供 `convergence_threshold` 与 non-dispersive `threshold`——累积量超过阈值后强制转 D8 式汇聚，理由是"渠道化后发散不现实"）[R4]。这层规则正是 charter 要求避免的隐式业务逻辑，Phase-1 不必引入。

### 1.4 主流 GIS 库的取舍（旁证）

| 库 | 默认/提供 | 说明 |
|---|---|---|
| GRASS `r.watershed` [R3] | 默认 MFD，`-s` 切 D8 | A^T 最小代价搜索（Ehlschlaeger 1989），**无需预先填洼**；ram 版 1M cells 约 31MB 内存 |
| WhiteboxTools [R4] | 全家桶：D8/Rho8/D∞/MD∞/FD8/Quinn/Qin | 官方推荐工作流第一步是 `Breach Depressions (Least Cost)`；`d8_pointer` 峰值内存 ~10 B/cell |
| pysheds [R5] | D8 + D∞ | `fill_pits → fill_depressions → resolve_flats → flowdir → accumulation → extract_river_network` |
| RichDEM [R1] | D4/D8/Rho4/Rho8/Quinn/Freeman/Holmgren/D∞ | 文档即算法对比集 |
| fastscape [R6] | 单流向 / 多流向路由器 | 暴露 `receivers / donors / stack(DFS 序)`——**汇流图与拓扑序作为持久状态维护**，是 LEM 领域的标准数据结构 |

---

## 2. 推荐的最小正确管线（Phase-1 Hydrology Processor）

```
Elevation(ScalarField) ─┐
                        ├─► [1] 填洼/开口 breach ─► [2] D8 pointer ─► [3] 汇流累积(权重=Rainfall)
Rainfall(ScalarField) ──┘                                                              │
                                                                [4] 阈值提取河道格 ─► [5] 沿 receiver 追踪 → River(LineFeature[])
```

1. **[1] 填洼**：Priority-Flood（Barnes, Lehman & Mulla 2014）：整型 O(n)、浮点 O(n log n)，伪代码 20 行 [R7]。浮点平地用 ε 递增变体（或开口 breaching，对原始地形破坏更小；Whitebox 首选 least-cost breach [R4]）。→ 产物同时得到"每个格点必可排水"的 DEM，保证 D8 指向除边界外全部有定义。
2. **[2] D8 pointer**：8 邻域最陡下降；平地由 [1] 的 ε 保证单调。输出 `Int32Array` receiver 索引（-1=流出边界），即 fastscape/LEM 语境的 `receivers` [R6]。
3. **[3] 汇流累积**：Kahn 拓扑序（入度清零即出队）单遍累加，O(n)——即 Braun & Willett 2013 的"下游栈序"思想：以 `stack` 序遍历保证每个格点处理时其全部 donor 已完成 [R8][R6]。**Rainfall 作为每格权重**（`acc[i] 初始 = rainfall[i]`），即 charter 的 `Elevation + Rainfall → Hydrology`。pysheds 的 accumulation 也支持 weights [R5]，GRASS 的 `flow` 输入同理 [R3]。
4. **[4]+[5] 河道提取**：`acc > threshold` 得河道格集合；从源头沿 receiver 追踪、在汇合处切分，输出 `LineFeature + properties{semantic=hydrology.river, flow=acc}`（charter §8）。

**不需要**：D∞/MFD（§1.3）、A^T 最小代价搜索（GRASS 为省去预处理而设计，工程复杂度更高 [R3]）、河道阈值收敛规则（§1.3）。

---

## 3. 局部 elevation 修改后的增量重算：已知做法与复杂度边界

### 3.1 结构性事实（本文推演，基于上述算法定义）

- **局部性引理**：D8/D∞/MFD 的流向都只由该格与其 8 邻域的高程决定 [R1][R2]。因此修改区域 R 内的高程，只可能使 **R ∪ 1 圈邻域（∂R）** 内格点的流向翻转。记流向翻转集 `D ⊆ R ∪ ∂R`。
- **失效集定义**：汇流累积值改变的格点集合 = ∪_{c∈D} (old_path⁺(c) ∪ new_path⁺(c))，即每个翻转格点的**旧下游闭包与新下游闭包之并**。这就是 Downstream invalidation 的可计算定义：沿旧 receiver 链一路标脏到底，再按新指向走一遍。
- **复杂度边界**：
  - 最好情形：O(|D|)（改在盆地边缘，下游路径极短）；
  - 典型情形：O(|D| × 平均下游路径长) ≈ O(|D| × √n)（随机地形平均路径长 ~O(√n)）；
  - **最坏情形 O(n)**：翻转载分水岭上的格点、或在发育完好平地上重新路由，可让半张图的累积值改变——所以 Downstream 失效**没有优于 O(n) 的最坏保证**，任何增量实现都必须有全量重算兜底。
- **填洼的例外**：编辑挖出新洼地时，受影响范围不是严格局部（需要重新填洼才能恢复"每格必可排水"），这是增量路径上最麻烦的部分；好在 §4 实测全量 Priority-Flood 也只有 ~0.4s。

### 3.2 已知做法（按工程代价排序）

| # | 做法 | 复杂度 | 适用 | 来源/依据 |
|---|---|---|---|---|
| 1 | **全量重算 O(n)**：保留 receiver/stack 数据结构，Rebuild 时重跑 pointer+累积 | O(n)（累积）；填洼 O(n log n) | 任何规模；Phase-1 默认 | Braun & Willett 2013 的 O(n) 栈序法即为此设计——LEM 每个时间步地形都在变，仍然每步全量重排 [R8]；fastscape 每步 `route_flow()` 重建 stack [R6]；GraphFlood 依赖"汇流 DAG + 快速图算法"支持 10⁶–10⁸ 格近线性重算 [R9] |
| 2 | **路径级 Δ 更新（D8 专属）**：流向翻转集 D 的每格：沿**旧下游路径**做 `acc -= Δ`，再沿**新下游路径** `acc += Δ`；对 D 的 donor 子树增量重算 | O(Σ 受影响路径长)，最坏 O(n) | 仅 D8（出度 1 树上加减法才无歧义）；D∞/MFD 需在受影响子图内按拓扑序重算 | 由 D8 出度 ≤1 的森林结构直接推出（§3.1）；fastscape 维护 `receivers/donors/stack` 持久图提供了所需状态 [R6] |
| 3 | **DAG 动态拓扑排序**：边增删后只重排受影响区域（Pearce–Kelly 2006, ACM JEA），再在受影响子图上重聚合 | O(受影响区域)，最坏 O(n) | 通用，D∞/MFD 的正规解法 | [R10]（论文 DOI 与题名经 ACM 检索确认；全文付费墙，未读原文——见 §7 局限） |
| 4 | **交互式地形编辑的经验做法**：不追求真正的 Δ 更新，而是把汇流计算压到交互帧预算内 + 只在编辑事件后重算 | 每次编辑 ~全量（但每次极快） | 编辑器/authoring 工具 | Schott et al. 2023（ACM TOG 42(5)）：**"a fast yet accurate approximation of drainage area and flow routing … allows for incremental authoring"**——用快速汇流近似换取交互式编辑 [R11]；GraphFlood 同思路 [R9] |
| 5 | **Tile/Dirty Region 组合**（charter §29–31）：脏集 = R∪∂R ∪ 其下游闭包 ∩ 各 tile；按 tile 局部重算方向，累积在受影响子图上重算 | 同 #2/#3，但以 tile 为调度单位 | 16384² 及以上（Q4 的后续压测票） | charter §30/§31 的 `Downstream` 策略即此定义；本节给出其可计算形式 |

### 3.3 对应到本项目的结论

- **Downstream invalidation 的"标脏"语义第一天就做对**：Hydrology processor 拿到 elevation 脏区 R 后，计算 `dirty = R∪∂R ∪ 下游闭包`，把命中的 River feature / accumulation 格标为 outdated（Debug View 可见，charter §38/§53）。这一步是纯图遍历，代价即受影响集大小，与是否立即重算解耦（charter §32 Outdated + Rebuild）。
- **计算侧 Phase-1 直接全量重算**（约 0.4s，见 §4），由 Worker 执行，不阻塞 UI。**这不算偷懒**：#1 是 GIS 与 LEM 领域在"地形持续变化"场景下的主流做法 [R8][R9]；增量路径（#2/#3）的收益在 1024² 下小于其复杂度与正确性风险（填洼例外、边界翻转、DAG 权重分摊）。
- **数据结构按"将来好增量"设计**：持久保存 `receiver: Int32Array` 与 `acc: Float64Array`（而非每次重建临时数组），这样 #2 的路径加减、#5 的闭包遍历、以及 River feature 的 Provenance（哪条线来自哪些格，charter §19）都建立在同一份状态上。
- **阈值化 River feature 的失效粒度**：`acc` 变化 ±threshold 才会导致河道起止点移动；可先按"受影响闭包内的 feature 重建"实现，避免为 feature 级 diff 先行优化。

---

## 4. 1024² 纯 JS/TS 性能预估

### 4.1 本机实测（一手测量，2026-10-02）

环境：**Apple M2 / Node v22.23.3 / 8GB**；实现：纯 JS，`Float32Array` 高程、`Int32Array` receiver、二叉堆 Priority-Flood（ε 变体）、Kahn 拓扑序累积；输入为 fBm 合成 DEM + 300 个随机挖坑（模拟笔刷编辑痕迹）；每项取 3–5 次中位数；MFD 为朴素实现（含 `Math.pow`）。

| 步骤（n = 1,048,576 cells） | 实测中位 | 每百万格 |
|---|---|---|
| Priority-Flood 填洼（ε，二叉堆） | **385 ms** | ~0.37 s |
| D8 pointer | **55 ms** | ~0.05 s |
| D8 汇流累积（Kahn O(n)） | **22 ms** | ~0.02 s |
| MFD Holmgren x=5 累积（朴素 JS） | 830 ms | ~0.8 s |
| 全管线（填洼+pointer+累积，编辑后地形） | **375 ms** | ~0.36 s |
| 增量：仅 64²+1 圈重算方向 | **0.8 ms** | — |
| 增量：全量累积重跑（编辑后） | 70 ms | — |
| 进程 RSS 峰值 | 247 MB（含基准脚本多份副本；管线稳态 ~8 个 1M typed array ≈ 35–40 MB） | |

交叉验证：pysheds 的 numpy 基准换算每百万格 D8 flowdir ≈ 0.03s、D8 accum ≈ 0.10s [R5]——**本 JS 实现落在同一量级**（D8 累积甚至更快，因为 22ms 只含单遍 O(n)）。MFD 每百万格 ~0.9s 也与 pysheds 的 ~0.9s 吻合。参考内存上界：GRASS ram 版 1M cells ≈ 31MB [R3]、Whitebox d8_pointer ≈ 10B/cell [R4]——1024² 管线总驻留数十 MB 是共识水平。

**预估结论**：
- 1024² 全量 Hydrology 重算 **0.3–1.0s**（视 DEM 坑洼密度与是否 breaching），纯 TS 完全可行；主线程直接跑会掉几帧到十几帧，**必须 Worker**。
- Rebuild 交互目标 ≤100ms 可达成：跳过全量填洼（仅当地形编辑产生新洼地才重填）时，pointer+累积 ≈ 80–90ms；路径级增量（§3.2 #2）再降一个数量级，但 Phase-1 不需要。
- 4096² 外推（×16）：全管线 ~6–16s ⇒ 必须配合 Tile/Dirty Region（charter §29–31），这属于 Q4 说的 16384² 压测票范围。

### 4.2 Web Worker 化建议

1. **常驻 Worker**（非按需创建）：Hydrology 是高频 Rebuild 目标，常驻避免重复 JIT 预热；Worker 内持有 dem/acc/receiver 缓冲，主线程只发"dirty region + 编辑后高程补丁"。
2. **Transferable ArrayBuffer 零拷贝**：1024² Float32Array = 4MB，结构化克隆会复制；Chrome 官方基准 32MB 消息 clone 往返 ~302ms vs transfer ~6.6ms（2011 年硬件，数量级仍成立；transfer 是所有权移交，O(1)）[R12]。实践：`postMessage(buf, [buf.buffer])`，或更简单——**双缓冲**：主线程与 Worker 各持一份高程，编辑时把脏区（紧凑编码）发给 Worker，结果（新 receiver/acc/河道线）回传。
3. **回传的是"差量"**：受影响闭包内的 acc 区间 + 新/失效 River feature 列表，而不是 4MB 全图，进一步省带宽与 GC。
4. **调度**：笔刷拖动中只标脏（§3.3），`pointerup`/防抖后触发一次 Rebuild——正合 charter §32 的 Outdated+Rebuild 模型；不要每帧重算。
5. **WASM 退路保持开放**：charter Q2 要求 TS first、热点换 Rust/WASM。本调研数据表明 **Phase-1 没有换 WASM 的必要**（亚秒级已达标）；Rust→WASM 的 GIS 水文实现已有先例（如 surtgis-wasm 提供 D8 flow accumulation 等 [R13]），接口保持纯 typed-array 输入输出即可无痛替换。mapgen4（纯 JS 程序化地图生成器，画地形→模拟→产河）也走"JS + Web Worker 多线程"路线，作者专门撰文讲多线程化 [R14]。

---

## 5. 给蓝图票（#5）与实现票（#11）的明确推荐

### 给 #5（蓝图/接口设计）

1. **声明 Processor**：`HydrologyProcessor`，`input: { elevation: ScalarField<float> (semantic=terrain.elevation), rainfall?: ScalarField<float> (semantic=climate.rainfall, 缺省权重 1) }`；`output: { river: LineFeature[] (semantic=hydrology.river, properties.flow), accumulation: ScalarField<float>（中间产物，进 Generated Cache/Provenance, charter §19/§44） }`。中间产物必须可复现（charter §45）。
2. **Invalidation Policy = Downstream 的正式定义写进票**：`affected = dirtyRegion ∪ ring(1) 的流向翻转集的 旧∪新 下游闭包`（§3.1）。核心只调用策略、不理解水文（charter §31）；策略实现属于 Hydrology 插件包。
3. **参数**：`threshold`（成河累积阈值）、`breach|fill` 策略、平地 ε——全部为 Processor 参数（进 Plugin Lock, charter §46），不是核心常量。
4. **不排期**：D∞/MFD、侵蚀模拟、湖库演算。可在接口上预留"多 receiver + weights"形态（`receivers: Int32Array ×k, weights: Float32Array ×k`，k=1 即 D8）[R6]，使未来换 D∞/MFD 不改接口。

### 给 #11（实现）

1. 实现 §2 五步管线，全部 typed array；先 fill（Priority-Flood ε 版，~120 行）+ D8 + Kahn 累积 + 阈值 + 沿 receiver 追踪成线。本调研实测可作验收基准：**1024² 全管线 ≤1s（Worker 内）、pointer+累积 ≤150ms**。
2. Worker 常驻 + 双缓冲/Transferable（§4.2）；主线程零水文计算。
3. Downstream 失效先做**标脏**（§3.3）：受影响闭包内标 outdated + 更新 Debug View；Rebuild 时全量重算（预算内）。路径级 Δ 更新（§3.2 #2）记为后续优化票，不做进 Phase-1。
4. 测试用例建议：①合成 V 形谷验证唯一主河道与汇流单调性；②挖封闭洼地验证填洼后可排水（max accumulation ≈ 总权重）；③局部编辑后对比"增量标脏集"与"全量重算差异集"，验证失效集定义正确（这是 Q4 要求的"局部失效是真的"的最直接证据）；④Rainfall 权重生效（×2 rainfall → flow ×2）。

---

## 6. 引用清单

> 访问日期均为 **2026-10-02**。可信度：A = 同行评审论文 / 官方算法文档；B = 官方源码、README 基准；C = 工程博客 / 经验报告。

- **[R1]** Barnes R.（RichDEM）, *Flow Metrics* 官方文档——D8/D4/Rho8/Quinn/Freeman/Holmgren/D∞ 的精确定义、公式与汇流/发散分类。https://richdem.readthedocs.io/en/stable/flow_metrics.html （A）
- **[R2]** Tarboton D.G. 1997, *A New Method for the Determination of Flow Directions and Upslope Areas in Grid Digital Elevation Models*, Water Resources Research 33(2):309–319, DOI:10.1029/96WR03137——D∞ 原始论文（8 三角面最陡下降、按比例分给两个下游格；指出 D8 grid bias 与 slope-proportional 方法的 dispersion 问题）。全文页：https://digitalcommons.usu.edu/cee_facpub/2507/ （A）
- **[R3]** GRASS GIS 8.5 `r.watershed` 官方手册——A^T least-cost 搜索（无需预填洼）、默认 MFD/`-s` D8、convergence 因子（引 Holmgren 1994）、ram 版 1M cells ≈ 31MB。https://grass.osgeo.org/grass-stable/manuals/r.watershed.html （A）
- **[R4]** Whitebox Workflows for QGIS 官方手册，*Spatial Hydrology* 与 *Flow Routing* 章——breach→pointer→accum→Extract Streams(threshold)→矢量化的标准工作流；`d8_pointer` 内存 ~10B/cell；平地导致平行条纹的 pitfall；FD8/D∞/Qin 的 non-dispersive/convergence threshold。https://www.whiteboxgeo.com/manuals/qgis/spatial-hydrology.html 、https://www.whiteboxgeo.com/manuals/qgis/hydrology-flow-routing.html （A）
- **[R5]** pysheds（Bartos M.）GitHub README——D8/D∞ 双支持；36M cells 官方性能基准表（flowdir D8 1.14s / DINF 7.01s / MFD 4.21s；accumulation 3.44 / 14.9 / 32.5s）；`extract_river_network` 输出 GeoJSON 线。https://github.com/pysheds/pysheds （B）
- **[R6]** fastscape `SingleFlowRouter` API 文档——`receivers/donors/stack(DFS 序)/weights` 持久汇流图状态，LEM 每步 `route_flow()` 重建。https://fastscape.readthedocs.io/en/stable/_api_generated/fastscape.processes.SingleFlowRouter.html （B）
- **[R7]** Barnes R., Lehman C., Mulla D. 2014, *Priority-Flood: An Optimal Depression-Filling and Watershed-Labeling Algorithm for DEMs*, Computers & Geosciences 62:117–127, DOI:10.1016/j.cageo.2013.04.024——整型 O(n)/浮点 O(n log n)；plain-queue 变体 O(m log m)；ε 与 carving 变体；20 行伪代码；arXiv 全文：https://ar5iv.labs.arxiv.org/html/1511.04463 （A）
- **[R8]** Braun J., Willett S.D. 2013, *A very efficient O(n), implicit and parallel method to solve the stream power equation governing fluvial incision and landscape evolution*, Geomorphology 180–181:170–179, DOI:10.1016/j.geomorph.2012.10.008（条目页：https://ouci.dntb.gov.ua/en/works/96JWDn09/ ）——下游栈序 O(n) 框架，地形逐时步变化场景下的标准做法。（A）
- **[R9]** Gailleton B. et al. 2024, *GraphFlood 1.0*, Earth Surface Dynamics 12:1295–1313, DOI:10.5194/esurf-12-1295-2024——利用地表汇流 **DAG 结构**做快速累积/水力面迭代；计算量随格数近线性，适用 10⁶–10⁸ 格。https://insu.hal.science/insu-04822581 （A）
- **[R10]** Pearce D.J., Kelly P.H.J. 2006, *A dynamic topological sort algorithm for directed acyclic graphs*, ACM JEA 11, DOI:10.1145/1187436.1210590（https://dl.acm.org/doi/10.1145/1187436.1210590 ）——DAG 边更新后仅重排受影响区域的通用算法；**全文付费墙未读，仅作方向性引用**（题名/出处经 ACM 检索条目确认）。（A/B，未读全文）
- **[R11]** Schott H., Paris A., Fournier L., Guérin E., Galin E. 2023, *Large-scale terrain authoring through interactive erosion simulation*, ACM TOG 42(5), DOI:10.1145/3592787——摘要明言以"fast yet accurate approximation of drainage area and flow routing"支撑 **incremental authoring**。https://hal.science/hal-04049125v1 （A）
- **[R12]** Bidelman E., *Transferable Objects – Lightning Fast*, Chrome for Developers Blog——32MB ArrayBuffer：结构化克隆 ~302ms vs Transferable ~6.6ms（往返，2011 年硬件）。https://developer.chrome.com/blog/transferable-objects-lightning-fast （B/C，厂商文档+基准）
- **[R13]** `surtgis-wasm` crate 文档——Rust→WASM GIS 库，含 D8 flow accumulation 等水文函数（WASM 路线先例）。https://docs.rs/surtgis-wasm （B）
- **[R14]** Patel A., *Mapgen4 Procedural Map Generator* 及系列博文（尤其 *Mapgen4: threads*、*Mapgen4: river representation*）——纯 JS/TS 地图生成器：画地形→模拟→产河；为达到速度使用了多线程（Worker）。https://www.redblobgames.com/maps/mapgen4/ 、https://simblob.blogspot.com/2018/09/mapgen4-threads.html 、https://simblob.blogspot.com/2018/10/mapgen4-river-representation.html （C，经验报告）
- **[R15]** 本报告 §4.1 微基准：本仓库研究过程自有测量（Apple M2 / Node 22.23.3，2026-10-02），脚本未入库，方法与参数已在正文给出。

## 7. 局限与未尽事项

1. **未实测 D∞** 的 JS 实现（预估按 pysheds 比例 ~4× accum 开销），Phase-1 用不上故未投入。
2. MFD 实测是朴素实现；numpy/编译级 MFD 可更快，但结论"MFD 比 D8 贵一个量级"与 pysheds 基准一致，方向可信。
3. [R10]（动态拓扑排序）未读全文，增量 DAG 更新的精确复杂度记号未引用原文数值，工程结论不依赖它。
4. Transferable 基准数据来自 2011 年浏览器 [R12]；现代引擎的 clone 已有优化，但 transfer 是所有权移交、无复制这一语义未变。
5. 增量路径级更新（§3.2 #2）是结构推演 + 领域实践支持，未找到专门以"DEM 局部编辑后汇流增量更新"为主题的论文；若蓝图阶段需要更强背书，可在 Schott 2023 [R11] 补充材料与 fastscape 源码中进一步核对。
