# AGENTS.md

map-mapmap 工作区（本地 `~/Documents/map`）。工程技能的 per-repo 配置记录如下；细节文档在 `docs/agents/`，可直接编辑，重跑 setup 仅在需要换 issue tracker 或推倒重来时才必要。

## Agent skills

### Issue tracker

本仓库的 issue 记录在 GitHub Issues（XLBen/map-mapmap），读写一律走 deck_ 系列工具。See `docs/agents/issue-tracker.md`.

### Triage labels

沿用默认五角色：needs-triage / needs-info / ready-for-agent / ready-for-human / wontfix（另含 wayfinder 标签组 wayfinder:map / research / prototype / grilling / task）。See `docs/agents/triage-labels.md`.

### Domain docs

single-context——仓库根目录一份 `CONTEXT.md` ＋ `docs/adr/`，架构决定放 docs/adr/，懒创建（首个词条落地才建文件）。See `docs/agents/domain.md`.
