# Findings: src/index.ts（系统性发现，覆盖全部 TS 模块）

- status: open
  severity: informational
  role: subsystem reference（模块契约）
  issue: 5 个 TS 文件（index.ts / render.ts / search.ts / summarize.ts / text.ts）均无模块级 doc 注释；仅 webkit-render.py 有模块 docstring。
  standard: 模块级注释应存在并陈述契约（行为、所有权、失败模式），而非叙述控制流（project-doc-audit Phase 3）。
  action: none
  detail: README.md「结构」表已承担模块地图职责，逐文件复述会违反 one-home-per-fact。render.ts 的 `Renderer` 接口、search.ts 的 Google 降级、summarize.ts 的 `summarize()` 均已有 declaration 级契约注释，质量达标。若未来某模块行为超出 README 表格一行能概括的范围，在该文件顶部补模块注释即可。
  evidence: 全量阅读 5 个 TS 文件；README.md 结构表 6 行对应 6 个源文件。
