/**
 * dsh-html-host-panel —— Host 半
 *
 * 职责：
 *  1. 唯一一份「发布」实现（publishPage）：供 Agent 工具 html_host_publish 与两条面板路由使用。
 *  2. 唯一一份「列出托管页面」实现（listPages）：供面板的浏览视图使用。
 *  3. 注册同源前缀路由 /__html-host/*，让浏览器面板绕开 pages.vmao.top 的
 *     跨源限制（该服务 cors 为 null，浏览器直连会被 CORS 拦下）。
 *  4. 「发布本地文件」（publishFile）：会话侧边栏预览 HTML 时，预览头部把
 *     被预览文件的绝对路径交给本进程读取并发布；文件内容不回传浏览器。
 *  5. 凭证只支持 API Key，存进 credentials 服务的 GrantRecord，
 *     不写配置、不进日志、不回显明文。
 *
 * 依赖取舍：webServer 只在「有 Web 宿主」时存在，做成可选注册；
 * 否则在 CLI/TUI profile 里连发布工具都会一起消失。
 */

import { readFile, stat } from 'node:fs/promises'

const DEFAULT_ORIGIN = 'https://pages.vmao.top'
const ROUTE_PREFIX = '/__html-host'
// 本地修补：credentials 服务要求 `<scope>/<id>`（KEY_SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/），
// 原值 'html-host-panel:credential' 用冒号分隔，会让 dsh-credentials-local 解析整份文档时抛错，
// 连带 credentials 插件激活失败、connection 等 14 个插件连锁 pending、整个 Host 启动中止。
const CREDENTIAL_KEY = 'html-host-panel/credential'
const MAX_HTML_BYTES = 5 * 1024 * 1024
const MAX_BODY_BYTES = 12 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 30_000

export const inject = ['tools']

const encoder = new TextEncoder()

/** 服务端错误码 → 可操作的中文提示。查不到的错误码退回服务端原文。 */
const ERROR_HINTS = {
  RATE_LIMITED: (retry) => `请求太频繁，服务端按 IP 限流，${retry ? `${retry} 秒后` : '稍等一会'}再试`,
  INSUFFICIENT_SCOPE: () => '这把 API Key 没有该操作权限（列表需要 read、发布需要 write），请换一把权限够的 Key',
  INVALID_API_KEY: () => '这把 API Key 无效或已撤销，请换一把',
  INVALID_CREDENTIAL: () => '这把 API Key 无效或已撤销，请换一把',
  MISSING_CREDENTIAL: () => '这把 API Key 已失效，请重新设置',
  CSRF_BLOCKED: () => '服务端把这次请求判为跨站写入，请重试；持续出现需检查反向代理是否改写了 Origin',
  PAYLOAD_TOO_LARGE: () => '页面超过服务端 5 MB 上限，请精简后再发',
  UNSUPPORTED_MEDIA_TYPE: () => '服务端拒绝了请求格式，请重试',
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function sendJson(res, body, status = 200, extraHeaders) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders,
  })
  res.end(payload)
}

/**
 * 读请求体。超限时排空上传但**不销毁 socket**——否则响应写不回去，
 * 浏览器只会看到 "Failed to fetch" 而不是可读的 413。
 */
function readRequestBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const tooLarge = (size) => {
      const error = new Error(`请求体 ${size} 字节，超过 ${limit} 字节上限`)
      error.status = 413
      error.code = 'BODY_TOO_LARGE'
      return error
    }

    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) {
      req.resume()
      reject(tooLarge(declared))
      return
    }

    const chunks = []
    let size = 0
    let settled = false

    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        settled = true
        req.resume()
        reject(tooLarge(size))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}

function parseJsonObject(text) {
  if (!text) return null
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

/** 写接口的来源校验：挡住别的网页用简单请求借已存凭证发布页面。 */
function sameOrigin(req) {
  const site = req.headers['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') return false
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

function maskSecret(value) {
  if (typeof value !== 'string' || !value) return ''
  if (value.length <= 8) return `${value.slice(0, 2)}****`
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}

function joinOriginUrl(origin, value) {
  if (typeof value !== 'string' || !value) return ''
  if (/^https?:\/\//i.test(value)) return value
  return `${origin}${value.startsWith('/') ? '' : '/'}${value}`
}

/** 时间戳单位归一：秒级与毫秒级都映射成毫秒，字符串走 Date.parse。 */
function toMillis(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 && value < 1e12 ? Math.round(value * 1000) : value
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function apply(ctx, config) {
  const configured = config && typeof config.serviceOrigin === 'string' ? config.serviceOrigin.trim() : ''
  const origin = (configured || DEFAULT_ORIGIN).replace(/\/+$/, '')

  const credentialStore = () => ctx.get('credentials')

  /** 读取 API Key；不存在时返回 undefined。旧的账号会话记录一律视为未配置。 */
  async function loadCredential() {
    const store = credentialStore()
    if (!store) return undefined
    const record = await store.readRecord(CREDENTIAL_KEY)
    if (!record || record.kind !== 'grant') return undefined
    const payload = record.payload
    if (!payload || typeof payload !== 'object') return undefined
    if (payload.mode === 'key' && typeof payload.apiKey === 'string' && payload.apiKey.trim()) {
      return { apiKey: payload.apiKey.trim() }
    }
    return undefined
  }

  async function saveCredential(apiKey) {
    const store = credentialStore()
    if (!store) throw new Error('当前 profile 没有 credentials 服务，凭证无法保存')
    await store.modifyRecord(CREDENTIAL_KEY, async () => ({ kind: 'grant', payload: { mode: 'key', apiKey } }))
  }

  async function clearCredential() {
    const store = credentialStore()
    if (!store) return
    await store.deleteRecord(CREDENTIAL_KEY)
  }

  /** 对外（面板）只暴露脱敏后的身份描述。 */
  function describeCredential(credential) {
    if (!credential) return { configured: false, label: '', masked: '' }
    return { configured: true, label: 'API Key', masked: maskSecret(credential.apiKey) }
  }

  /** 把服务端错误体翻成「原因 + 该怎么办」。 */
  function describeFailure(response, payload) {
    const code = (payload && payload.code) || `HTTP_${response.status}`
    const retryAfter = Number(response.headers.get('retry-after')) || 0
    const detail = (payload && payload.error) || `请求失败（HTTP ${response.status}）`
    const hint = ERROR_HINTS[code]
    return {
      ok: false,
      code,
      error: hint ? `${hint(retryAfter)}${payload && payload.error ? `（${payload.error}）` : ''}` : detail,
      status: response.status,
      retryAfterSeconds: retryAfter || undefined,
    }
  }

  /**
   * 列出已托管页面：面板的浏览视图用。
   */
  async function listPages(query) {
    const credential = await loadCredential()
    if (!credential) {
      return {
        ok: false,
        code: 'NO_CREDENTIAL',
        error: '还没有配置 API Key：在面板「凭证」里填一把 hh_live_ 开头的 Key',
      }
    }

    const params = new URLSearchParams()
    const limit = Number(query && query.limit)
    const offset = Number(query && query.offset)
    if (Number.isFinite(limit) && limit > 0) params.set('limit', String(Math.min(200, Math.floor(limit))))
    if (Number.isFinite(offset) && offset > 0) params.set('offset', String(Math.floor(offset)))
    const q = query && typeof query.q === 'string' ? query.q.trim() : ''
    if (q) params.set('q', q.slice(0, 100))
    if (query && typeof query.sort === 'string' && query.sort) params.set('sort', query.sort)
    if (query && typeof query.order === 'string' && query.order) params.set('order', query.order)

    const search = params.toString()
    let response
    try {
      response = await fetch(`${origin}/api/v1/pages${search ? `?${search}` : ''}`, {
        headers: { 'x-api-key': credential.apiKey },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      return { ok: false, code: 'NETWORK', error: `连接 ${origin} 失败：${errorMessage(error)}` }
    }

    let payload = null
    try {
      payload = await response.json()
    } catch {
      payload = null
    }

    if (!response.ok || !payload || payload.ok !== true) {
      return describeFailure(response, payload)
    }

    const pages = Array.isArray(payload.pages) ? payload.pages : []
    return {
      ok: true,
      total: Number(payload.total) || pages.length,
      limit: Number(payload.limit) || pages.length,
      offset: Number(payload.offset) || 0,
      count: Number(payload.count) || pages.length,
      pages: pages.map((page) => ({
        id: page.id,
        title: typeof page.title === 'string' ? page.title : '',
        url: joinOriginUrl(origin, page.url),
        rawUrl: joinOriginUrl(origin, page.rawUrl),
        size: Number(page.size) || 0,
        views: Number(page.views) || 0,
        createdAt: toMillis(page.createdAt),
        updatedAt: toMillis(page.updatedAt),
        expiresAt: toMillis(page.expiresAt),
        hasPassword: Boolean(page.hasPassword),
      })),
    }
  }

  /**
   * 发布实现：只供 Agent 工具使用。失败一律带 code、原因与可选的等待秒数。
   */
  async function publishPage(input) {
    const source = input && typeof input === 'object' ? input : {}
    const html = typeof source.html === 'string' ? source.html : ''
    if (!html.trim()) {
      return { ok: false, code: 'EMPTY_HTML', error: 'HTML 内容为空，先贴一段页面再发布' }
    }

    const bytes = encoder.encode(html).length
    if (bytes > MAX_HTML_BYTES) {
      return {
        ok: false,
        code: 'PAYLOAD_TOO_LARGE',
        error: `页面 ${(bytes / 1048576).toFixed(2)} MB，超过服务端 5 MB 上限`,
      }
    }

    const credential = await loadCredential()
    if (!credential) {
      return {
        ok: false,
        code: 'NO_CREDENTIAL',
        error: '还没有配置 API Key：在「HTML 托管」面板的凭证区填一把 hh_live_ 开头的 Key',
      }
    }

    const body = { html }
    const title = typeof source.title === 'string' ? source.title.trim() : ''
    if (title) body.title = title.slice(0, 200)
    const ttl = Number(source.ttlSeconds)
    if (Number.isFinite(ttl) && ttl > 0) body.ttlSeconds = Math.floor(ttl)

    let response
    try {
      response = await fetch(`${origin}/api/v1/pages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': credential.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      return { ok: false, code: 'NETWORK', error: `连接 ${origin} 失败：${errorMessage(error)}` }
    }

    let payload = null
    try {
      payload = await response.json()
    } catch {
      payload = null
    }

    if (!response.ok || !payload || payload.ok !== true || !payload.page) {
      return describeFailure(response, payload)
    }

    const page = payload.page
    return {
      ok: true,
      id: page.id,
      title: page.title,
      url: joinOriginUrl(origin, page.url),
      rawUrl: joinOriginUrl(origin, page.rawUrl),
      path: page.url,
      size: page.size,
      expiresAt: toMillis(page.expiresAt),
      hasPassword: Boolean(page.hasPassword),
    }
  }

  /* ------------------------------------------------------------------ *
   * 发布本地文件：会话侧边栏预览 HTML 时，预览头部把文件的绝对路径交过来。
   *
   * 只接受 .html / .htm，且必须落在本机绝对路径上；内容只在 Host 进程内读，
   * 不回传浏览器，返回的只有短链。路径不合法时一律拒绝，不做猜测。
   * ------------------------------------------------------------------ */

  const HTML_SUFFIX = /\.html?$/i

  function isAbsolutePath(value) {
    if (typeof value !== 'string' || !value) return false
    if (/^[A-Za-z]:[\\/]/.test(value)) return true
    return value.startsWith('/') || value.startsWith('\\\\')
  }

  async function publishFile(input) {
    const source = input && typeof input === 'object' ? input : {}
    const target = typeof source.path === 'string' ? source.path.trim() : ''

    if (!isAbsolutePath(target)) {
      return { ok: false, code: 'BAD_PATH', error: '需要一个本机绝对路径（预览头部传下来的路径）' }
    }
    if (!HTML_SUFFIX.test(target)) {
      return { ok: false, code: 'NOT_HTML', error: '只支持上传 .html / .htm 文件' }
    }

    let info
    try {
      info = await stat(target)
    } catch (error) {
      return { ok: false, code: 'FILE_UNREADABLE', error: `读不到这个文件：${errorMessage(error)}` }
    }
    if (!info.isFile()) {
      return { ok: false, code: 'NOT_A_FILE', error: '这个路径不是普通文件' }
    }
    if (info.size > MAX_HTML_BYTES) {
      return {
        ok: false,
        code: 'PAYLOAD_TOO_LARGE',
        error: `文件 ${(info.size / 1048576).toFixed(2)} MB，超过服务端 5 MB 上限`,
      }
    }

    let html
    try {
      html = await readFile(target, 'utf8')
    } catch (error) {
      return { ok: false, code: 'FILE_UNREADABLE', error: `读文件失败：${errorMessage(error)}` }
    }
    // 去掉 BOM，否则发布出去的页面首行会多一个不可见字符。
    if (html.charCodeAt(0) === 0xfeff) html = html.slice(1)
    if (!html.trim()) {
      return { ok: false, code: 'EMPTY_HTML', error: '文件是空的，没有可发布的内容' }
    }

    const explicitTitle = typeof source.title === 'string' ? source.title.trim() : ''
    const fallbackTitle = (target.split(/[\\/]/).pop() || '').replace(HTML_SUFFIX, '')
    return publishPage({ html, title: explicitTitle || fallbackTitle })
  }

  /* ------------------------------------------------------------------ *
   * 同源路由：浏览器面板的入口（Host 侧代理，绕开跨源限制）
   *
   * 用 WebRoute（原始 Node 请求处理）：资源式 WebResourceRoute 在 HTTP 层
   * 只承认 GET / HEAD，写操作会一律 405。webServer 只在 Web 宿主存在，
   * 因此走 ctx.inject 的可选注册，不影响 Agent 工具。
   * ------------------------------------------------------------------ */

  ctx.inject(['webServer'], (web) => {
    web.effect(() =>
      web.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          const rawUrl = req.url || '/'
          const queryIndex = rawUrl.indexOf('?')
          const pathname = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex)
          const search = queryIndex === -1 ? '' : rawUrl.slice(queryIndex + 1)
          const route = pathname.slice(ROUTE_PREFIX.length) || '/'
          const method = (req.method || 'GET').toUpperCase()

          try {
            if (method !== 'GET' && method !== 'HEAD' && !sameOrigin(req)) {
              return sendJson(res, { ok: false, code: 'CROSS_ORIGIN_BLOCKED', error: '跨站请求被拒绝' }, 403)
            }

            if (route === '/status' && method === 'GET') {
              const credential = await loadCredential()
              return sendJson(res, { ok: true, origin, ...describeCredential(credential) })
            }

            if (route === '/credential' && method === 'POST') {
              const body = parseJsonObject(await readRequestBody(req))
              if (!body || typeof body.apiKey !== 'string') {
                return sendJson(res, { ok: false, code: 'BAD_REQUEST', error: '缺少 apiKey 字段' }, 400)
              }
              const apiKey = body.apiKey.trim()
              if (!apiKey) {
                await clearCredential()
                return sendJson(res, { ok: true, configured: false, label: '', masked: '' })
              }
              await saveCredential(apiKey)
              return sendJson(res, { ok: true, ...describeCredential({ apiKey }) })
            }

            if (route === '/credential' && method === 'DELETE') {
              await clearCredential()
              return sendJson(res, { ok: true, configured: false, label: '', masked: '' })
            }

            if (route === '/pages' && method === 'GET') {
              const params = new URLSearchParams(search)
              const result = await listPages({
                limit: params.get('limit'),
                offset: params.get('offset'),
                q: params.get('q'),
                sort: params.get('sort'),
                order: params.get('order'),
              })
              const extra = result.retryAfterSeconds ? { 'retry-after': String(result.retryAfterSeconds) } : undefined
              return sendJson(res, result, result.ok ? 200 : result.status || 400, extra)
            }

            if (route === '/publish' && method === 'POST') {
              const body = parseJsonObject(await readRequestBody(req))
              if (!body) return sendJson(res, { ok: false, code: 'BAD_REQUEST', error: '请求体不是合法 JSON' }, 400)
              const result = await publishPage(body)
              const extra = result.retryAfterSeconds ? { 'retry-after': String(result.retryAfterSeconds) } : undefined
              return sendJson(res, result, result.ok ? 200 : result.status || 400, extra)
            }

            if (route === '/publish-file' && method === 'POST') {
              const body = parseJsonObject(await readRequestBody(req))
              if (!body) return sendJson(res, { ok: false, code: 'BAD_REQUEST', error: '请求体不是合法 JSON' }, 400)
              const result = await publishFile(body)
              const extra = result.retryAfterSeconds ? { 'retry-after': String(result.retryAfterSeconds) } : undefined
              return sendJson(res, result, result.ok ? 200 : result.status || 400, extra)
            }

            return sendJson(res, { ok: false, code: 'NOT_FOUND', error: '接口不存在' }, 404)
          } catch (error) {
            const status = Number.isInteger(error && error.status) ? error.status : 500
            return sendJson(
              res,
              { ok: false, code: (error && error.code) || 'INTERNAL_ERROR', error: errorMessage(error) },
              status,
            )
          }
        },
      }),
    )
  })

  /* ------------------------------------------------------------------ *
   * Agent 工具：发布仍由 AI 调用
   * ------------------------------------------------------------------ */

  ctx.effect(() =>
    ctx.tools.register({
      name: 'html_host_publish',
      description:
        '把一段完整 HTML 发布到 pages.vmao.top，返回可直接分享的短链。用于把报告、图表、演示页交付给用户，或生成一个可以发出去的网页。' +
        '凭证必须先在「HTML 托管」面板配置 API Key，否则会返回 NO_CREDENTIAL。',
      parameters: {
        type: 'object',
        properties: {
          html: { type: 'string', description: '完整 HTML 文本（单页上限 5 MB）' },
          title: { type: 'string', description: '页面标题，最长 200 字，缺省为「未命名页面」' },
          ttlSeconds: { type: 'integer', description: '有效期秒数，0 或省略表示永久' },
        },
        required: ['html'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            id: { type: 'string' },
            title: { type: 'string' },
            url: { type: 'string', description: '可分享的完整短链' },
            rawUrl: { type: 'string' },
            size: { type: 'integer' },
            expiresAt: { type: 'integer', description: '过期时间戳（毫秒）；永久页面为 null' },
            hasPassword: { type: 'boolean' },
            code: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => {
          const result = value && typeof value === 'object' ? value : {}
          if (result.ok === true) {
            const lines = [`已发布：${result.title || '未命名页面'}`, `短链 ${result.url}`]
            if (result.expiresAt) {
              lines.push(`有效期至 ${new Date(result.expiresAt).toLocaleString('zh-CN')}`)
            } else {
              lines.push('有效期：永久')
            }
            return [{ type: 'text', text: lines.join('\n') }]
          }
          return [
            {
              type: 'text',
              text: `发布失败：${result.error || '未知错误'}（${result.code || 'UNKNOWN'}）`,
            },
          ]
        },
      },
      execute: async (args) => publishPage(args),
    }),
  )
}
