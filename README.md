# pi-web-search

Web search and page fetch tools for pi, with LLM summarization.

## 工作流程

**Chrome 扩展桥接（唯一链路）**：pi 侧在 127.0.0.1 起 WebSocket server（17890–17899 区间绑定第一个空闲端口），`extension/` 下的 Chrome 扩展主动拨入（MV3 扩展没有 listen 能力，连接方向固定为扩展 → pi）。`web_search` 交给扩展在真实标签页里跑 Google 搜索，`web_fetch` 在扩展标签页里加载页面并提取正文。两个工具都只走桥接，扩展未连接时直接报错，不回落。

`web_fetch` 抓取页面内容：

1. 接受 1-10 个 URL，扩展侧并行抓取（最多 3 个并发标签页），每页 20s 加载超时，单页失败不影响整体
2. 不传 `question` 时返回正文（每页截断 30KB，整体上限 50KB / 2000 行）；传 `question` 则把所有页面正文拼进一次无状态 `complete()` 调用（独立 system prompt，无会话上下文），由模型围绕问题总结，返回总结 + 来源列表

## Chrome 扩展

`extension/` 是一个 MV3 扩展，把搜索和抓取放进用户的真实浏览器标签页，绕过 Google 对裸 fetch / headless 的反爬拦截。

**仅支持 Chrome / Edge**：依赖 `chrome.tabGroups` API，Firefox 不支持。

### 安装（开发者模式 load unpacked）

1. 打开 `chrome://extensions`，右上角开启「开发者模式」
2. 点「加载已解压的扩展程序」，选择本仓库的 `extension/` 目录
3. pi 启动后扩展会自动扫描 17890–17899 端口并连上所有活跃的 pi 进程

多个 pi 实例并存时每个实例占用区间内一个端口，扩展对每个 server 各维持一条连接，按 conversationId 隔离标签组。

### 行为

- 每个 pi 会话对应一个标签组（组名 `pi:<会话id前8位>·<首个query>`，颜色轮换），会话间互不干扰
- 搜索复用组内一个 scratch 标签页；fetch 每个 URL 开一个标签页并保留供查看，组内超过 20 个回收最旧
- Google 搜索全局节流 ≥2.5 秒，多 pi 实例共用同一出口 IP 时不会高频触发异常流量标记
- pi 会话结束（`/new`、退出）时收到 closeSession 通知，默认保留标签组；超过 24 小时无活动的标签组由清扫器自动回收（pi 崩溃收不到通知时靠这个兜底）
- options 页可配 OpenAI 兼容端点（baseUrl + apiKey + model）：启用后带 `question` 的 `web_fetch` 在扩展侧对每页先做一次摘要，只回传摘要，减少主 agent 上下文压力；也可勾选会话结束自动关组

### 协议

WS 文本帧，JSON。扩展连接后 5 秒内发握手，之后 pi 侧按 `id` 发请求、扩展回响应：

```text
ext → pi  {"type":"hello","protocol":1}
pi  → ext {"type":"helloAck","ok":true,"protocol":1}
pi  → ext {"type":"request","id":7,"kind":"search","conversationId":"<uuid>","params":{"query":"...","maxResults":5}}
pi  → ext {"type":"request","id":8,"kind":"fetch","conversationId":"<uuid>","params":{"urls":["..."],"question":"..."?}}
ext → pi  {"type":"response","id":7,"ok":true,"result":{"results":[{"title","url","snippet"}]}}
ext → pi  {"type":"response","id":7,"ok":false,"error":"..."}
pi  → ext {"type":"notify","kind":"closeSession","conversationId":"<uuid>"}
pi  → ext {"type":"ping"}   // 每 20s，保住 MV3 service worker 不被 Chrome 杀掉
```

桥接状态全在 pi 进程内存里：握手通过才接受连接，断线即作废未完成请求。pi 侧 search 超时 30s、fetch 超时 60s，超时/断线直接报错。

### 打包与分发

- **自用 / 团队内部**：直接分发仓库，用户按上面 load unpacked。这是推荐方式，无签名问题
- **固定扩展 ID**：load unpacked 的 ID 由目录路径决定，换机器/换路径 ID 会变，options 里存的配置（在 storage.local，按 ID 隔离）就丢了。要固定 ID：在 `chrome://extensions` 点「打包扩展程序」生成 `.crx` + `.pem`，把 `.pem` 的公钥（base64）写进 manifest 的 `key` 字段，之后 load unpacked 也会得到稳定 ID。`.pem` 私钥妥善保存，打更新包必须用同一个
- **crx 直装已不可行**：Chrome 禁止安装 Web Store 以外的 crx（企业策略除外），生成的 `.crx` 只用于提取 ID，不能直接发给用户装
- **分发给非开发者**：只能上架 Chrome Web Store（可以选不公开列出 / unlisted），需要开发者账号和审核。本项目暂不提供

## 结构

| 文件 | 职责 |
| --- | --- |
| `src/bridge.ts` | WS server（127.0.0.1:17890–17899）、握手、请求/响应、心跳保活、会话生命周期 |
| `extension/` | Chrome MV3 扩展：连接扫描、标签组管理、Google 搜索 / 页面正文提取、扩展侧摘要、清扫器 |
| `scripts/smoke-bridge.mjs` | 桥接 smoke test：fake 扩展客户端验证握手、search/fetch、closeSession |
| `src/search.ts` | 搜索：只走 Chrome 扩展桥接，扩展未连接时报错 |
| `src/summarize.ts` | 配置加载、总结模型解析、无状态总结调用 |
| `src/text.ts` | 截断、URL 校验 |
| `index.ts` | 包入口，转发 `src/index.ts`（让 pi 启动列表显示包名而非 `src`） |
| `src/index.ts` | 工具与命令注册、session_start/session_shutdown 接线 |

## 配置

`~/.pi/agent/web-search.json`：

```json
{
  "summaryModel": "minimax-cn/MiniMax-M3",
  "summaryThinking": "high",
  "fetchCount": 5
}
```

- `summaryModel`：`provider/id`，缺省 `minimax-cn/MiniMax-M3`，不可用（未找到或未配置凭据）时回退当前会话模型并弹出通知。环境变量 `WEB_SUMMARY_MODEL` 优先
- `summaryThinking`：总结调用的 thinking level，缺省 `high`。环境变量 `WEB_SUMMARY_THINKING` 优先
- `fetchCount`：`web_search` 返回的结果条数，缺省 5，上限 10

`/web-search-model` 命令可在会话内交互切换总结模型。

## 依赖

- `ws`（npm）：pi 侧桥接的 WebSocket server。Node 内置的只有 WebSocket 客户端（undici），没有 server
- Chrome / Edge 浏览器 + `extension/` 扩展：`web_search` / `web_fetch` 的唯一抓取链路

## 安装

```bash
pi install git@github.com:DDtoma/pi-web-search.git
```

## 已知边界

- `web_search` / `web_fetch` 只走 Chrome 扩展：Google 对本机 IP 的纯 fetch 返回 JS 壳、对 headless Chrome 返回反爬拦截页，本地链路实际不可用，所以未连接时直接报错而不是静默降级
- 桥接 server 绑在 127.0.0.1 且无鉴权：本机任何进程都能连上并看到转发的搜索词。接受这个风险（本地工具场景），不要把端口映射到公网
- 桥接 server 生命周期绑在 pi 会话上（session_start 起、session_shutdown 关）：pi `/reload` 会重新 import 扩展模块，模块级单例 server 会泄漏占住端口，所以每次会话重建。端口区间内最多 10 个 pi 实例并存，超出后新实例桥接不可用，`web_search` / `web_fetch` 报错
- Google 账号首次使用或触发 consent 页时扩展提取不到结果，`web_search` 直接报错
- 开发时 `node_modules` 里的 `@earendil-works/*`、`typebox` 是指向本机 pi 全局安装的符号链接（供 tsc/单测解析），`npm install` 会清掉需要重建

## 内网防护

`web_fetch` 在把 URL 发给扩展前先过 `validateUrl`：拒绝非 http/https 协议和内网地址——loopback、RFC1918 私有网段（10/8、172.16/12、192.168/16）、链路本地（169.254/16、fe80::/10）、ULA（fc00::/7）、IPv4 映射 IPv6、`*.localhost` 及云 metadata 端点。域名解析到内网 IP（DNS rebinding）不在防护范围（页面在扩展标签页里加载，等同于用户自己访问）。
