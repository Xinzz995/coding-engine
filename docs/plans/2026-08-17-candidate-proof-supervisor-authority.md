---
title: 补齐候选补签监督器命令权威
status: active
updated: 2026-08-17
scope: root
---

# 背景

0.37.0 候选运行 32003942139 在 PR #258 上完成 Story、机械门禁、审计版 Validator 和
`remote=pending` 的 Shadow Final Review 后，远端 ready 的唯一一次补签调用在 1.36 秒内失败且
零写入。TypeScript `OwnerCommand` 与 schema 已接受 `candidate-proof`，但固定 POSIX 监督器和
Windows `WindowsJobAuthority` 的命令白名单均漏掉该值。首个受管远端查询因此被判为
`workspace marker/protocol/owner binding mismatch`，workspace 正确进入隔离状态。

# 完成合同

| 验收标准 | 失败时可观察结果 | 验证方式 |
|---|---|---|
| POSIX 固定监督器接受合法 `candidate-proof` owner | macOS/Linux 候选补签在首个受管查询前隔离 | 在 `candidate-proof` 短租约中真实运行 `quality-check` 并安全结算 |
| Windows 固定监督器接受同一 owner command | Windows 候选补签仍被固定二进制拒绝 | 同一跨平台 coordinator 回归在 Windows native proof 中通过 |
| 未知命令与其他权威约束仍 fail-closed | 放宽为任意字符串或绕过 owner 绑定 | 既有非法 owner、篡改 marker/protocol/owner 和 helper 身份回归继续通过 |
| Windows 源与提交二进制完全一致 | 只改 C# 源但实际发布仍带旧二进制 | 固定 SDK 双槽可复现构建与 committed executable 字节核对 |
| 旧候选不得复用 | 用源码修复解释运行 32003942139 已恢复 | 关闭 PR #258；修复合并后从新 main 重建候选和全新 workspace |

# 黄金原则对照

1. **可证伪完成合同**：两平台真实 helper 必须在相同短租约场景完成，旧 helper 可稳定复现失败。
2. **独立证据**：通过结论由 helper、workspace 机械结算、Windows 可复现构建和远端矩阵给出，不采信
   候选命令自述。
3. **自治与可逆性**：不增加命令权限，只让已由 TypeScript schema 明确批准的命令穿过同一固定
   owner 校验；失败仍隔离，PR 与候选均可关闭作废。
4. **原生能力优先**：复用现有 POSIX/Windows 监督器和 `runManagedWorkspaceProcess`，不新增旁路。
5. **真实失败固化**：PR #258 的 owner 白名单漂移被转成跨平台真实短租约回归；修复后必须用新候选
   重做 #250，而不是把单测当成下游实证。

# 交付边界

- 限时政策例外 Issue #259 只授权监督器权威源、Windows 固定二进制、直接回归与本计划。
- 旧候选运行 32003942139、候选身份
  `sha256:7a1aef3f3b406ec6b2c38f45897aaade47af82ced6ae36edf686fff8edd5e979` 和 PR #258
  不得继续用于 staging 或发布。
- 本修复不运行 npm staging、发布、latest、标签或 GitHub Release。
