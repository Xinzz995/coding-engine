---
title: coding-x 0.38.1 coding-engine 候选证明种子 R2
status: seed-only
updated: 2026-08-23
scope: root
---

# coding-x 0.38.1 coding-engine 候选证明种子 R2

本文件只用于在第二次候选尝试前建立新的开放 PR。它不是候选证明，也不得供 npm staging 使用。

- 候选来源：`6e7cde0aceef7918c75c3d0c99f20246bfb6c587`
- 候选运行：`32631400657`
- 候选身份：`sha256:7d1df0f7d17c9c07cbff1ea9dbfafe5d9052f3c65ca52aef90f56dd80ccbbd5d`
- tarball SHA-256：`2224cfefd10c3505829b6d1c00bc107e5cac4333097a7eba97e9de96e5d330c2`

第一次尝试 PR #332 因候选说明遗漏 `workspace init`，且没有强制在本次新建、未复用的 workspace 中原子应用已确认 PRD，被 Final Review 以两个 P1 阻断。本次必须修正这些边界，并在 Builder 提交出现后由外层流程及时原样推送，再由同一候选调用继续完成检查、独立 Validator 与 Shadow Final Review。
