# Doc audit — pi-web-search — 2026-09-02

Scanner: doc_landscape.py (bundled with project-doc-landscape)
Scope: 1 markdown file, 6 code files (5 TS + 1 Python, 全量阅读，非抽样）

## Summary

| Severity | Count |
| --- | --- |
| high | 0 |
| medium | 0 |
| low | 0（1 已修复） |
| informational | 3 |

## 机械扫描结果（Phase 1）

- `links`: 1 个文件，相对链接与 fragment 全部可解析。
- `wrap`: 无跨行硬换行段落。
- `inventory`: 1 个文档（README.md, 856 词 / 71 行）, 无孤儿候选，无生成器配置，无 standing-order 文件。
- 注释卫生 grep（used to / no longer / previously / 以前 / 不再 / decision 引用 / PR 视角 / TODO|FIXME|XXX|HACK): 全部零命中。

## Findings index

| File | Findings | Highest severity |
| --- | --- | --- |
| [README.md](findings/README.md) | 依赖一节 Chrome 路径候选不完整；单文档多角色（可接受） | low |
| [src/index.ts.md](findings/src/index.ts.md) | 系统性：TS 模块缺模块级注释（1 条覆盖全部 5 个 TS 文件） | informational |
| [src/search.ts.md](findings/src/search.ts.md) | 注释中时间相对措辞 "now" | informational |

注：代码文件的 findings 以 `<源文件名>.md` 命名（如 `findings/src/index.ts.md`），避免诊断工具把 Markdown 内容当源码解析。

## 缺失角色（informational，启发式，不单独建 findings 文件）

- 无 AGENTS.md / standing-orders 文件。项目规模（1 文档、~1200 行代码）低于需要它的阈值；若后续引入 agent 协作约定再补。
- 无独立 contributor workflow 文档。README 的「依赖 / 安装 / 已知边界」已覆盖 setup；`node_modules` 符号链接这条开发者须知目前放在「已知边界」里，项目此规模下可接受。

## Remediation log

- 2026-09-02: README.md 依赖一节已补 Chrome 候选路径（findings/README.md 的 low 项 → fixed）。其余 3 条 informational 均为 `action: none`，无需处理。
