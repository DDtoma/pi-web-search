# Findings: README.md

- status: fixed
  severity: low
  role: per-component contract（产品入口）
  issue: 「依赖」一节只写了 `/usr/bin/google-chrome-stable`，代码实际探测 4 个候选路径。
  standard: per-component contracts 应如实描述配置与环境假设，不欠不漏（project-doc-landscape 角色表）。
  action: edit
  detail: 在「依赖」一节的 Chrome 条目补一句：代码依次探测 `CHROME_PATH`、`/usr/bin/google-chrome-stable`、`/usr/bin/google-chrome`、`/usr/bin/chromium`、`/usr/bin/chromium-browser`（src/render.ts `findChrome()`）。
  evidence: src/render.ts findChrome() candidates 数组；README.md 「依赖」一节仅列第一个路径。

- status: open
  severity: informational
  role: 多角色混合（产品入口 + contributor setup + 已知边界/事件记录）
  issue: 单文档承担多个角色。
  standard: 每个文档一个角色；但「角色混在一个文件里」只在规模或读者冲突造成实际成本时才拆分（project-doc-landscape：a doc can hold both when one form is small and clearly labeled）。
  action: none
  detail: 856 词、分节清晰，各节边界明确；拆成多文件反而增加维护面。项目规模增长（多包、多贡献者）时再重估。
  evidence: doc_landscape.py inventory — 1 docs, 856 words。
