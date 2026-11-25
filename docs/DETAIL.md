# HTML 托管

浏览 `https://pages.vmao.top` 上已托管的页面。**面板只做浏览，不提供上传界面**——新页面由 AI 通过 `html_host_publish` 工具发布。

## 入口在哪

**左侧面板列表区**（和「插件」「定时任务」那排图标并列）有一枚「方框 + 外链箭头」图标，标签 **HTML 托管**。点它，中央主区域就是已托管页面列表。图标上有个黄点，表示还没配置 API Key。

> 注意：宿主自己的面板列表里另有一条 `html-host`（不是本插件）。本插件的图标认「方框 + 外链箭头」这个。

## 面板里能做什么

- **列表**：标题、短链、大小、浏览量、创建时间、有效期，以及是否设了访问密码。
- **搜索**：按标题或页面 ID 过滤，回车即搜。
- **刷新** / **加载更多**：每页 30 条，`total` 显示总数。
- **打开**：点标题或短链在新标签页打开托管页。
- **复制**：把短链复制到剪贴板。

**不做的事**：不删除、不改标题、不设访问密码——这些请用服务自带管理台或 API。

## 想发布新页面？

在会话里让我发一句话就行，例如「把这份报告发到 pages.vmao.top」。我会调用 `html_host_publish`（接受 `html` / `title` / `ttlSeconds`）并把短链回给你。界面里没有粘贴框，发布不走 UI。

## 凭证

只有一种：**API Key**（`hh_live_` 开头），请求时走 `X-API-Key` 头。

| 操作 | 需要 Key 的权限 |
| --- | --- |
| 列出页面 | `read` |
| 发布页面 | `write` |

Key 存在 DSH 的 credentials 服务里（一条 `grant` 记录），不写插件配置、不回显明文、不进日志；面板只显示前 4 位与后 4 位。点「清除」可随时删除。

账号密码登录通道已移除——服务端是 `account` 模式也不影响，API Key 通道与账号体系并存，Key 只用于本插件的读写。

## 出错时看这里

错误信息由「该怎么办」+ 服务端原文组成，括号里是原文。常见 `code`：

| `code` | 含义与处理 |
| --- | --- |
| `NO_CREDENTIAL` | 还没配置 API Key。在面板「凭证」里填一把。 |
| `INVALID_API_KEY` / `INVALID_CREDENTIAL` | Key 无效、已撤销或已过期。换一把。 |
| `MISSING_CREDENTIAL` | 服务端不认这个 Key（可能被删了）。重新设置。 |
| `INSUFFICIENT_SCOPE` | Key 缺权限：列表要 `read`，发布要 `write`。换一把权限够的。 |
| `RATE_LIMITED` | 服务端按 IP 限流。响应里的 `Retry-After` 会翻成「N 秒后再试」。 |
| `NETWORK` | 连不上 `pages.vmao.top`。检查网络或服务是否在线（`GET /healthz`）。 |
| `CSRF_BLOCKED` | 服务端把请求判为跨站写入（仅发布路径会遇到）。检查反向代理是否改写了 `Origin`。 |
| `CROSS_ORIGIN_BLOCKED` | 别的网页试图借已存凭证调用本面板的写接口，已被插件拒绝。 |

时间戳一律按**毫秒**返回；服务端若给秒级，插件会自动换算。永久页面显示「永久」。

## 实现要点

浏览器不能直连 `pages.vmao.top`——该服务 `cors` 为 `null`，跨源预检会被拒。因此 Host 半注册了一条同源前缀路由 `/__html-host/*` 做代理（`GET /status`、`POST|DELETE /credential`、`GET /pages`、`POST /publish`），面板只与本机 DSH 通信，真正的出网请求由 Host 发出。

该路由用 `WebRoute`（原始 Node 请求处理）而不是资源式路由：资源式路由在 HTTP 层只承认 `GET` / `HEAD`，写操作会一律 405。写接口同时校验 `sec-fetch-site` 与 `Origin`，拒绝跨站调用。
