---
title: 约定与陷阱
status: active
updated: {YYYY-MM-DD}
scope: {root 或子项目名}
---

# 约定与陷阱

<!-- /compound-docs 收口沉淀与熵 GC 的落点：稳定开发约定 + 高频陷阱。条目短、可验证、带日期；
     结构性知识不放这里（去 architecture.md）；失效、重复或只记录一次事故的条目在 GC 时删除/合并/迁位。 -->

## 约定

<!-- 多个 story 反复出现、未来会复用的稳定开发写法 -->

- {YYYY-MM-DD} {如：共享逻辑统一放 `src/utils/`，feature 目录内禁止复制辅助函数}

## 陷阱

<!-- 容易再次踩、与本项目框架/数据边界/路由方式强相关的坑 -->

- {YYYY-MM-DD} {如：更改 X 时必须同步更新 Y，否则 Z 失效}
