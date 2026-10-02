# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Lifecycle convention（关闭时的标签处理）

`ready-for-agent` / `ready-for-human` / `needs-info` / `needs-triage` 是**状态**标签：票完成（closed）即摘除。类别标签（wayfinder 组的 `task` / `research` / `grilling` / `prototype`）**保留**——它们描述票的性质，不随状态变化。

理由：状态标签在已关闭票上语义为假（不存在「等待 AFK agent」的已完成票），且会污染按标签筛选 ready 队列的结果。实践依据：#1/#3/#4 关闭时均无状态标签；#5 于 2026-10-02 关闭时按此约定摘除了 `ready-for-agent`、保留 `task`。
