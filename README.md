# dsh-html-host-panel

DeepSeek Harness 插件：在**左侧面板列表**里浏览托管在 [pages.vmao.top](https://pages.vmao.top) 上的 HTML 页面；会话里预览 `.html` 文件时，预览头部多一个上传图标，点一下就把当前文件发布出去。

```
左侧「HTML 托管」图标
   └─ 中央区域：页面列表（标题 / 短链 / 大小 / 浏览量 / 有效期 / 是否加密）
        ├─ 点标题或短链 → 新标签页打开
        ├─ 复制 → 短链进剪贴板
        └─ 搜索、刷新、加载更多（每页 30 条）

会话右侧预览 .html / .htm
   └─ 预览头部：☁︎↑ 上传图标
        ├─ 点击 → Host 读取该文件并发布
        └─ 完成后右侧显示短链（点一下复制）
```

## 功能

- **列表**：标题、短链、大小、浏览量、创建时间、有效期，以及是否设了访问密码。
- **搜索**：按标题或页面 ID 过滤，回车即搜。
- **刷新 / 加载更多**：`total` 显示总数，按需翻页。
- **打开 / 复制**：一键拿短链。
- **上传当前预览的 HTML**：会话里预览 `.html` / `.htm` 时，预览头部的图标把该文件发布出去（≤ 5 MB，标题取文件名）。按钮只有图标，保留 `aria-label` 供读屏使用。
- **AI 发布**：会话里说「把这份报告发到 pages.vmao.top」，Agent 调 `html_host_publish` 直接发布并返回短链。

## 安装

需要 DSH `0.2.2-rc.5` 或更高版本（使用 `sidebar.panellist`、`main` 与 `sidebar.right.tab.document.actions` 三个 Slot；后两个在更早的 rc 上也能解析，但只在有 Web GUI 的 profile 里出现）。

```bash
dsh plugin add github:vmaoserver/dsh-html-host-panel
```

或在 GUI 里 **Plugins** → **Add plugin** 填 GitHub 地址。

安装后在**左侧面板列表区**会多出一枚「方框 + 外链箭头」图标，标签「HTML 托管」。

> 面板和插件的 Slot 依赖 Web GUI。在没有 Web 界面的 profile（CLI / headless）里，只有 `html_host_publish` 工具可用。

## 配置

默认连接 `https://pages.vmao.top`。如果你部署了自己的 html-host（同款零依赖 HTML 托管服务，API v1），改插件行的配置即可：

```yaml
- id: html-host-panel
  name: 'dsh-html-host-panel'
  config:
    serviceOrigin: https://your-host.example.com
```

## 凭证

只有一种凭证：**API Key**（`hh_live_` 开头），请求时走 `X-API-Key` 头。

| 操作 | 需要的权限 |
| --- | --- |
| 列出页面 | `read` |
| 发布页面 | `write` |

在面板顶部「凭证」里填一次即可。Key 存在 DSH 的 credentials 服务里（一条 `grant` 记录），**不写插件配置、不回显明文、不进日志**——面板只显示前 4 位与后 4 位。

图标右上角的黄点表示还没配置 Key。

## Agent 工具

```ts
html_host_publish({
  html: string,        // 完整 HTML，单页上限 5 MB
  title?: string,      // 最长 200 字，缺省「未命名页面」
  ttlSeconds?: number  // 有效期秒数，0 或省略 = 永久
})
```

返回 `{ ok, id, title, url, rawUrl, size, expiresAt, hasPassword }`，失败时带 `code` 与可操作的中文 `error`。

## 为什么不直接在浏览器里请求

`pages.vmao.top` 的 `cors` 是 `null`，浏览器跨源写请求会在预检阶段被拒。所以 Host 半注册了一条同源前缀路由 `/__html-host/*` 做代理，面板只与本机 DSH 通信，真正的出网请求由 Host 发出。

该路由用 `WebRoute`（原始 Node 请求处理）而不是资源式路由——资源式路由在 HTTP 层只承认 `GET` / `HEAD`，写操作会一律 405。写接口另外校验 `sec-fetch-site` 与 `Origin`，拒绝跨站调用。

## 限制

- **只读浏览**：不删除、不改标题、不设访问密码——这些请用 html-host 自带的管理台或 API。
- 与 `html-host` **v2.1.0 的 API v1** 对齐；服务端改契约需同步调整。
- 服务端默认给托管页加 CSP `sandbox`（无 `allow-same-origin`），页面内访问 `localStorage` / `document.cookie` 会抛 `SecurityError`；纯展示型页面不受影响。

更多细节（错误码表、实现说明）见 [docs/DETAIL.md](docs/DETAIL.md)。

## 开发

仓库本身就是可安装的 bundle，没有构建步骤：

```
index.js          Host 半：发布/列表实现、发布本地文件、同源路由、Agent 工具
client.js         Client 半：左侧图标 + 中央列表页 + 预览头部上传图标
cordis.patch.yml  装配（插入一行插件，带默认 serviceOrigin）
locale/           中英文显示名
docs/DETAIL.md    详细说明
icon.svg          插件图标
```

本地安装：`dsh plugin add <本目录绝对路径>`。

## License

[MIT](LICENSE)
