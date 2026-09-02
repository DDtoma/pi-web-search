# Findings: src/search.ts

- status: open
  severity: informational
  role: subsystem reference（注释）
  issue: L97 注释 "Google now serves a JS-only shell..." 用了时间相对措辞 "now"。
  standard: 文档记录当前状态而非变更历史；时间相对措辞按 informational 处理（project-doc-audit Phase 3, currently/时间词规则）。
  action: none
  detail: 该注释解释的是 Google 当前的外部行为（为什么需要进程内失败记忆与 DuckDuckGo 降级），属于合法的非显而易见背景，不是变更叙述。可选顺手改：删 "now" 不影响语义。
  evidence: src/search.ts:97-100 注释块。
