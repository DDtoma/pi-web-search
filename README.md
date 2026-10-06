# pi-web-search

Web search and page fetch tools for pi, with LLM summarization.

## 工作流程

**Chrome 扩展桥接（唯一链路）**：所有 pi 进程共享 127.0.0.1:17890 上一个 bridge hub（先绑定该端口的 pi 进程成为 hub，其余作为 client 接入；hub 退出后有 client 重绑接管）。`extension/` 下的 Chrome 扩展只拨入这一个端口（MV3 扩展没有 listen 能力，连接方向固定为扩展 → hub），hub 按 conversationId 把各 pi 的请求路由给扩展。client 连接不占端口，任意数量的 pi 会话（含 subagent）可以并存。`web_search` 交给扩展在真实标签页里跑 Google 搜索，`web_fetch` 在扩展标签页里加载页面并提取正文或结构骨架，`web_eval` 在已开页面里执行 JS。三个工具都只走桥接，扩展未连接时直接报错，不回落。

`web_fetch` 抓取页面内容：

1. 接受 1-10 个 URL，扩展侧并行抓取（最多 3 个并发标签页），每页 20s 加载超时，单页失败不影响整体
2. 每页文本写入本地缓存 `~/.pi/agent/sessions/<工作区>/web-search-cache/<会话id>/`（与 pi 会话历史同目录，方便对照查看），文件名由 URL 确定性生成（`<slug>-<sha1前8位>.txt`，同 URL 重抓覆盖）；工具结果附带每个页面的缓存路径，后续可用 read 工具读取完整原文。扩展侧摘要生效时缓存的是摘要，文件头会标注
3. 不传 `question` 时返回正文（每页截断 30KB，整体上限 50KB / 2000 行）；传 `question` 则把所有页面正文拼进一次无状态 `complete()` 调用（独立 system prompt，无会话上下文），由模型围绕问题总结，返回总结 + 来源列表

`web_fetch` 还有 `mode:"outline"`：返回页面结构骨架（YAML 树：嵌套容器、文本片段、编号的可交互元素 `tag[N]: "label" -> href`），比正文小得多，用于了解页面结构和定位元素；复用同 URL 已开的标签页，不重载。`web_eval` 配合它驱动页面：在已打开的页面里通过 debugger 协议执行任意 JS（不受页面 CSP 限制），用 outline 输出的 `[data-pi-ref="N"]` 选择器定位元素。eval 从不导航，页面必须由同会话先前的 search/fetch 打开。

## Chrome 扩展

`extension/` 是一个 MV3 扩展，把搜索和抓取放进用户的真实浏览器标签页，绕过 Google 对裸 fetch / headless 的反爬拦截。

**仅支持 Chrome / Edge**：依赖 `chrome.tabGroups` API，Firefox 不支持。

### 安装（开发者模式 load unpacked）

1. 打开 `chrome://extensions`，右上角开启「开发者模式」
2. 点「加载已解压的扩展程序」，选择本仓库的 `extension/` 目录
3. pi 启动后扩展会自动连上 hub，popup（点工具栏图标）显示 hub 上注册的所有会话（项目名 + 会话 id）和本浏览器的标签组

多个 pi 实例并存时共享同一 hub 连接，按 conversationId 隔离标签组。popup 里可以对某个会话点 release：hub 断开该 client（pi 会话不受影响，下次搜索时自动重新注册）。工具栏图标在 hub 连通时显示蓝点，断开时灰点。

### 行为

- 每个 pi 会话对应一个标签组（组名 `pi:<会话id前8位>·<首个query>`，颜色轮换），会话间互不干扰
- 搜索复用组内一个 scratch 标签页；fetch 每个 URL 开一个标签页并保留供查看，组内超过 20 个回收最旧
- Google 搜索全局节流 ≥2.5 秒，多 pi 实例共用同一出口 IP 时不会高频触发异常流量标记
- pi 会话结束（`/new`、退出）时收到 closeSession 通知，默认保留标签组；超过 24 小时无活动的标签组由清扫器自动回收（pi 崩溃收不到通知时靠这个兜底）
- options 页可配 OpenAI 兼容端点（baseUrl + apiKey + model）：启用后带 `question` 的 `web_fetch` 在扩展侧对每页先做一次摘要，只回传摘要，减少主 agent 上下文压力；也可勾选会话结束自动关组

### 协议

WS 文本帧，JSON，协议版本 2。hub 监听 127.0.0.1:17890，接受两类连接：扩展（必须带 `chrome-extension://` Origin，只有一个槽位）和 pi client（必须无 Origin，即非浏览器客户端）。hub 启动时生成随机 token 写入 `~/.pi/agent/web-search-hub-token`（0600），client 的 `register` 必须带上；扩展走 Origin 校验不需要 token（socket 没有文件访问能力）。hub 把 client 的请求换上自己的 `rid` 转发给扩展，按 `rid` 把响应路由回对应 client；转发时 `conversationId` 以注册值为准，忽略 client 自称的值：

```text
ext    → hub  {"type":"extHello","protocol":2}
hub    → ext  {"type":"extHelloAck","ok":true,"protocol":2,"sessions":[{"clientId":0,"conversationId":"<uuid>","project":"<cwd basename>","self":true}]}
client → hub  {"type":"register","protocol":2,"conversationId":"<uuid>","project":"<cwd basename>","token":"<hub token>"}
hub    → client {"type":"registerAck","ok":true,"clientId":3}
hub    → ext  {"type":"sessions","sessions":[...]}        // client 注册/断开/release 时推送
client → hub  {"type":"request","rid":7,"kind":"search","conversationId":"<uuid>","params":{"query":"...","maxResults":5}}
hub    → ext  {"type":"request","rid":41,"kind":"search","conversationId":"<uuid>","params":{...}}
ext    → hub  {"type":"response","rid":41,"ok":true,"result":{"results":[...]}}
hub    → client {"type":"response","rid":7,"ok":true,"result":{...}}
client → hub  {"type":"notify","kind":"closeSession","conversationId":"<uuid>"}   // 原样转发给 ext
hub    → ext  {"type":"ping"}                              // 每 20s，保住 MV3 service worker
ext    → hub  {"type":"release","clientId":3}              // popup 手动回收
hub    → client {"type":"released"}                        // 随后断开；client 不再自动重连，下次请求时懒重连
```

`kind` 有 `search` / `fetch` / `snapshot` / `eval` / `closeGroup`，参数同工具参数。扩展未接入时 hub 直接给 client 回错误响应，不排队。hub 的自身会话以 `clientId:0, self:true` 出现在 sessions 里，popup 不提供对它的 release（释放它没有意义）。hub 进程退出后，断开的 client 重绑端口接管成为新 hub，扩展自动重拨。pi 侧 search 超时 30s、fetch 超时 60s，超时/断线直接报错。

### 打包与分发

- **自用 / 团队内部**：直接分发仓库，用户按上面 load unpacked。这是推荐方式，无签名问题
- **固定扩展 ID**：load unpacked 的 ID 由目录路径决定，换机器/换路径 ID 会变，options 里存的配置（在 storage.local，按 ID 隔离）就丢了。要固定 ID：在 `chrome://extensions` 点「打包扩展程序」生成 `.crx` + `.pem`，把 `.pem` 的公钥（base64）写进 manifest 的 `key` 字段，之后 load unpacked 也会得到稳定 ID。`.pem` 私钥妥善保存，打更新包必须用同一个
- **crx 直装已不可行**：Chrome 禁止安装 Web Store 以外的 crx（企业策略除外），生成的 `.crx` 只用于提取 ID，不能直接发给用户装
- **分发给非开发者**：只能上架 Chrome Web Store（可以选不公开列出 / unlisted），需要开发者账号和审核。本项目暂不提供

## 结构

| 文件 | 职责 |
| --- | --- |
| `src/hub.ts` | 共享 hub：单端口 server、ext/client 接入、请求路由、sessions 推送、release |
| `src/bridge.ts` | 桥接 facade：hub/client 角色管理与故障接管、请求 API、会话生命周期 |
| `extension/` | Chrome MV3 扩展：hub 连接、popup 会话管理、标签组管理、Google 搜索 / 页面正文提取、扩展侧摘要、清扫器 |
| `scripts/smoke-bridge.mjs` | 桥接 smoke test：fake 扩展验证握手、search/fetch/snapshot/eval/closeGroup、closeSession、client 路由与 release（需在无活跃 hub 的环境跑，如 `unshare -Urn`） |
| `scripts/smoke-client.mjs` | smoke 的子进程：以 client 模式注册并验证路由与 release |
| `scripts/test-extension.py` | 扩展回归：fake hub + Playwright 驱动真实 Chromium 验证图标/popup/标签组（netns 里跑） |
| `src/search.ts` | 搜索：只走 Chrome 扩展桥接，扩展未连接时报错 |
| `src/cache.ts` | 页面缓存：按会话写入 `<sessionDir>/web-search-cache/`，URL 确定性文件名，失败静默跳过 |
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
- Chrome / Edge 浏览器 + `extension/` 扩展：`web_search` / `web_fetch` / `web_eval` 的唯一抓取链路

## 安装

```bash
pi install git@github.com:DDtoma/pi-web-search.git
```

## 已知边界

- `web_search` / `web_fetch` 只走 Chrome 扩展：Google 对本机 IP 的纯 fetch 返回 JS 壳、对 headless Chrome 返回反爬拦截页，本地链路实际不可用，所以未连接时直接报错而不是静默降级
- 桥接 server 绑在 127.0.0.1：client 注册需持 hub token（0600 文件，其他本地用户读不到），驱动浏览器搜索/抓取/eval 的能力不裸奔。残余风险：同用户的恶意进程能读 token 文件，也能伪造 `chrome-extension://` Origin 抢占扩展槽——抢到槽位后可以按 rid 回假响应，往所有 pi 会话注入伪造的搜索/抓取/eval 结果，还能发 release 踢掉 client（结果伪造 + 槽位 DoS）；接受这个风险（本地工具场景），不要把端口映射到公网
- 桥接生命周期绑在 pi 会话上（session_start 接入、session_shutdown 断开）：pi `/reload` 会重新 import 扩展模块，模块级单例会泄漏，所以每次会话重建。hub 由某个 pi 进程充当，该进程退出或 `/reload` 时其他 client 自动接管，接管窗口内（秒级）进行中的请求会失败
- 协议 v2 与 v1（每进程一个端口、17890–17899）不兼容：升级后所有 pi 会话需要 `/reload`，旧进程占着的 17891–17899 会随会话结束释放。v1 的扩展连不上 v2 的 hub（握手类型不同），反之亦然，扩展和 pi 侧要一起升级
- Google 账号首次使用或触发 consent 页时扩展提取不到结果，`web_search` 直接报错
- 开发时 `node_modules` 里的 `@earendil-works/*`、`typebox` 是指向本机 pi 全局安装的符号链接（供 tsc/单测解析），`npm install` 会清掉需要重建

## 内网防护

`web_fetch` 在把 URL 发给扩展前先过 `validateUrl`：拒绝非 http/https 协议和内网地址——loopback、RFC1918 私有网段（10/8、172.16/12、192.168/16）、链路本地（169.254/16、fe80::/10）、ULA（fc00::/7）、IPv4 映射 IPv6、`*.localhost` 及云 metadata 端点。域名解析到内网 IP（DNS rebinding）不在防护范围（页面在扩展标签页里加载，等同于用户自己访问）。
