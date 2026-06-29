# coding-x

Ralph 自动化 Coding 工作流：一个把 Developer→Validator 循环固化成确定性程序的 harness。
既是 Claude Code 插件（skills/commands），又是 TypeScript 引擎（`npx coding-x`）。

## 用法

1. 安装插件后，用 `/prime` `/plan-feature`，配合 `prd` / `ralph` skill 生成 `.workspace/prd.json`。
2. 终端运行引擎：

   ```bash
   npx coding-x            # 使用 claude
   npx coding-x codex      # 使用 codex
   npx coding-x --max-iter 20 --dev-timeout 20 --no-open
   npx coding-x repair     # 仅修复 .workspace/prd.json
   ```

3. 打开 http://localhost:7331 （像素视图 http://localhost:7331/p ）查看实时进度。

## 开发

- `npm run dev` — 直接用 tsx 运行 CLI
- `npm test` — Vitest
- `npm run sync` — 从 `assets/` 重新生成 `skills/ commands/ .cursor/ .agents/`
- `npm run build` — tsup 打包到 `dist/`

技法来源：Ralph 自主循环 + Anthropic harness 设计。详见 `docs/superpowers/specs/`。
