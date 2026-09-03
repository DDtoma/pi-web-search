# pi-web-search

Web search and page fetch tools for pi, with LLM summarization.

## 工作流程

`web_search` 一次工具调用完成整条链路：

1. Google 搜索（不可用时自动降级 DuckDuckGo）
2. 取前 N 条结果（默认 5，上限 10），并行抓取网页正文
3. 渲染通道默认走 CDP 驱动的系统 Chrome（headless），CSR 页面也能拿到完整内容；渲染失败自动降级裸 fetch；每页独立 15s 超时，单页失败不影响整体
4. 抓到的正文拼进一次无状态 `complete()` 调用（独立 system prompt，无会话上下文），由模型围绕 query 总结
5. 返回总结 + 来源列表（标注每条来源用的渲染器）

`web_fetch` 抓取单个 URL，同样走渲染降级链；传 `question` 则围绕问题总结，不传返回正文（截断 50KB）。

## 结构

| 文件 | 职责 |
| --- | --- |
| `src/search.ts` | 搜索引擎：Google → DuckDuckGo 降级 |
| `src/render.ts` | `Renderer` 接口 + 渲染降级链（`WebViewRenderer` / `CdpRenderer` / `FetchRenderer`），按配置选链 |
| `src/webkit-render.py` | WebKit2GTK 渲染辅助进程：加载页面 → 等 settle → 输出 `body.innerText` JSON |
| `src/summarize.ts` | 配置加载、总结模型解析、无状态总结调用 |
| `src/text.ts` | HTML 剥标签、截断、URL 校验 |
| `index.ts` | 包入口，转发 `src/index.ts`（让 pi 启动列表显示包名而非 `src`） |
| `src/index.ts` | 工具与命令注册 |

## 配置

`~/.pi/agent/web-search.json`：

```json
{
  "summaryModel": "minimax-cn/MiniMax-M3",
  "summaryThinking": "high",
  "fetchCount": 5,
  "renderer": "auto"
}
```

- `summaryModel`：`provider/id`，缺省 `minimax-cn/MiniMax-M3`，不可用（未找到或未配置凭据）时回退当前会话模型。环境变量 `WEB_SUMMARY_MODEL` 优先
- `summaryThinking`：总结调用的 thinking level，缺省 `high`。环境变量 `WEB_SUMMARY_THINKING` 优先
- `fetchCount`：每次搜索抓取的页数，缺省 5，上限 10
- `renderer`：渲染后端。`auto`（缺省，CDP → fetch 降级）、`cdp`（CDP → fetch）、`webview`（WebKit2GTK → CDP → fetch，仅 Linux）、`fetch`（只裸请求）。环境变量 `WEB_RENDERER` 优先

`/web-search-model` 命令可在会话内交互切换总结模型。

## 依赖

- 系统 Chrome/Chromium，通过裸 CDP 驱动（`--remote-debugging-port=0` + 内置 WebSocket），无 npm 浏览器依赖；缺失时渲染自动降级裸 fetch。依次探测 `CHROME_PATH`、平台安装路径、PATH（`where.exe`/`which`）。平台安装路径：Linux 为 `/usr/bin/google-chrome-stable`、`/usr/bin/google-chrome`、`/usr/bin/chromium`、`/usr/bin/chromium-browser`；macOS 为 `/Applications` 下的 Chrome/Chromium/Edge；Windows 为 `%PROGRAMFILES%` / `%PROGRAMFILES(X86)%` / `%LOCALAPPDATA%` 下的 Chrome，并回退到预装的 Edge（同样支持 CDP）。PATH 探测可以覆盖 scoop/chocolatey 等包管理器安装
- WebView 后端仅支持 Linux，要求：`python3` + PyGObject + WebKit2GTK 4.1（`libwebkit2gtk-4.1`）；其他平台直接跳过该后端，缺依赖时自动降级 CDP/fetch

## 安装

```bash
pi install git@github.com:DDtoma/pi-web-search.git
```

## 资源回收

- CDP Chrome 空闲 5 分钟自动关闭（SIGTERM 整树退出；Windows 下用 `taskkill /pid /t /f` 杀整棵树），临时 profile 目录随关闭删除；`WEB_CDP_IDLE_MS` 可调
- 每次渲染开独立 target，结束（含超时/中断）即关闭
- 宿主进程退出时杀 Chrome 并删 profile；Windows 上 Chrome 的 SQLite/LevelDB 文件锁在进程死后短暂残留，删除目录带重试，仍失败则留给启动清扫；宿主被 SIGKILL 残留的 profile 目录在下次启动时清扫（>1h）
- WebView 后端（Linux）按进程组杀死，超时下 python 的 WebKit 子进程不会残留

## 已知边界

- Google 对本机 IP 的纯 fetch 返回 JS 壳、对 headless Chrome 返回反爬拦截页，因此实际搜索基本都落到 DuckDuckGo；Google 不可用在进程内记忆一次失败，之后直达 DuckDuckGo
- 渲染不解决风控：知乎这类强制登录墙页面渲染后仍只有壳内容，会作为失败/短内容降级处理
- 开发时 `node_modules` 里的 `@earendil-works/*`、`typebox` 是指向本机 pi 全局安装的符号链接（供 tsc/单测解析），`npm install` 会清掉需要重建
