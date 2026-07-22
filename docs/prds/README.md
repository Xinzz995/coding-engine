# PRD

`prd-generate` skill 的产出目录，文件名 `prd-[feature-name].md`。

status 约定：`active`（意图生效中/待实施）/ `done`（本轮意图已交付——story 全部通过且已合并；需求演进时翻回 active，修改后再派生）/ `superseded`（被后继 PRD 取代，注明替代者）。对齐稿（`align-*`/`tech-*`）被正式 PRD 吸收后置 `superseded`；done/superseded 文档可由 `/compound-docs` 在明确授权后迁入 `docs/archive/`。
