/**
 * dsh-html-host-panel —— Client 半（Web 页面）
 *
 * 入口是左侧面板列表里的一枚图标（sidebar.panellist），点开在中央主区域
 * 显示「已托管页面」列表（main 里同名 key）。
 *
 * 本面板做浏览：列出 pages.vmao.top 上已有的页面，可打开、可复制短链。
 * 另有一处出口：会话侧边栏预览 HTML 文件时，预览头部出现「上传到 HTML 托管」，
 * 把当前文件直接发布出去。面板本身不放上传框。
 * AI 也仍可通过 html_host_publish 工具发布页面。
 * 凭证只有一种：API Key。
 *
 * 所有跨源请求都走 Host 注册的同源前缀路由 /__html-host/*，浏览器侧不直连 pages.vmao.top。
 *
 * 配色只用宿主主题 token。注意 brand-primary 在明暗两套主题里是反转的
 * （浅色近黑、暗色近白），主按钮的文字必须用 bg-base 跟着反转。
 */

window.__ModuleLoader__.load({
  id: 'dsh-html-host-panel',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const API = '/__html-host'
    const PANEL_ID = 'html-host-publish'
    const PAGE_SIZE = 30

    /* ---------------------------------------------------------------- *
     * 页面内样式：内联样式写不了 :hover / :focus-visible，
     * 而键盘焦点可见是可达性底线。作为 React 元素渲染，卸载即移除。
     * ---------------------------------------------------------------- */
    const LOCAL_CSS = `
.hhp-primary { transition: filter .12s ease, opacity .12s ease; }
.hhp-primary:hover:not(:disabled) { filter: brightness(0.94); }
.hhp-ghost { transition: background-color .12s ease, color .12s ease; }
.hhp-ghost:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.hhp-row:hover { background: var(--dsw-alias-bg-layer-2); }
.hhp-page :is(input, textarea, select, button):focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.hhp-page a.hhp-link { text-decoration: none; }
.hhp-page a.hhp-link:hover { text-decoration: underline; }
.hhp-page a.hhp-title:hover { text-decoration: underline; }
.hhp-icon:disabled { opacity: .5; cursor: default; }
.hhp-icon:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.hhp-icon svg { pointer-events: none; }
`

    function LocalStyles() {
      return h('style', null, LOCAL_CSS)
    }

    function errorText(error) {
      if (error instanceof Error) return error.message
      return String(error)
    }

    async function requestJson(path, options) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 35_000)
      try {
        const response = await fetch(API + path, { ...options, signal: controller.signal })
        let data = null
        try {
          data = await response.json()
        } catch {
          data = null
        }
        if (!data || typeof data !== 'object') {
          throw new Error(`服务端返回了非 JSON 响应（HTTP ${response.status}）`)
        }
        return data
      } catch (error) {
        if (error && error.name === 'AbortError') throw new Error('请求超时（35 秒）')
        throw error
      } finally {
        clearTimeout(timer)
      }
    }

    function formatSize(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / 1048576).toFixed(2)} MB`
    }

    function formatTime(ms) {
      if (!ms) return ''
      try {
        return new Date(ms).toLocaleString('zh-CN', {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
      } catch {
        return ''
      }
    }

    function formatExpiry(ms) {
      if (!ms) return '永久'
      try {
        return `至 ${new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`
      } catch {
        return ''
      }
    }

    /* ---------------------------------------------------------------- *
     * 样式：只用宿主主题 token
     * ---------------------------------------------------------------- */

    const styles = {
      page: {
        height: '100%',
        boxSizing: 'border-box',
        overflowY: 'auto',
        padding: '30px 36px 64px',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        lineHeight: 1.55,
      },
      inner: { maxWidth: 860, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 },
      heading: { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 },
      headingText: { display: 'flex', flexDirection: 'column', gap: 4 },
      title: { margin: 0, fontSize: 18, fontWeight: 600 },
      subtitle: { margin: 0, fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)' },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: 14,
        borderRadius: 12,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      cardHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
      cardTitle: { fontSize: 12.5, fontWeight: 600 },
      label: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        height: 32,
        padding: '0 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 12.5,
        fontFamily: 'inherit',
      },
      row: { display: 'flex', gap: 8, alignItems: 'center' },
      rowEnd: { display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end' },
      primary: {
        height: 32,
        padding: '0 16px',
        borderRadius: 8,
        border: '1px solid transparent',
        background: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-bg-base)',
        fontSize: 13,
        fontWeight: 600,
        fontFamily: 'inherit',
        cursor: 'pointer',
      },
      ghost: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 28,
        padding: '0 10px',
        borderRadius: 7,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 12,
        fontFamily: 'inherit',
        cursor: 'pointer',
      },
      listCard: {
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 12,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        overflow: 'hidden',
      },
      listHead: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        padding: '10px 14px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
      },
      item: {
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '11px 14px',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
      },
      itemMain: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 },
      itemTitle: {
        display: 'block',
        fontSize: 13,
        fontWeight: 500,
        color: 'var(--dsw-alias-label-primary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      itemUrl: {
        display: 'block',
        fontSize: 11.5,
        color: 'var(--dsw-alias-brand-primary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      itemMeta: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' },
      notice: {
        padding: '8px 11px',
        borderRadius: 8,
        fontSize: 12,
        border: '1px solid var(--dsw-alias-state-success-primary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        wordBreak: 'break-all',
      },
      errorBox: {
        padding: '8px 11px',
        borderRadius: 8,
        fontSize: 12,
        border: '1px solid var(--dsw-alias-state-error-primary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-state-error-primary)',
        wordBreak: 'break-word',
      },
      empty: {
        padding: '28px 14px',
        textAlign: 'center',
        fontSize: 12.5,
        color: 'var(--dsw-alias-label-secondary)',
      },
      dot: {
        position: 'absolute',
        top: 0,
        right: 0,
        width: 6,
        height: 6,
        borderRadius: 3,
        background: 'var(--dsw-alias-state-warn-primary)',
      },
      lock: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
      previewAction: { display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 },
      iconButton: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 26,
        height: 26,
        padding: 0,
        borderRadius: 7,
        border: '1px solid transparent',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
      },
    }

    /** 「页面 + 外链箭头」：读作「托管页面」。 */
    function IconPublish({ size = 18 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('rect', {
          x: 2.3,
          y: 3.3,
          width: 10.4,
          height: 10.4,
          rx: 2.2,
          stroke: 'currentColor',
          strokeWidth: 1.3,
        }),
        h('path', { d: 'M6.2 9.8 9.8 6.2', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        h('path', {
          d: 'M7.1 6.2h2.7v2.7',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /* ---------------------------------------------------------------- *
     * 左侧面板列表里的图标
     * 宿主传入 { size, active }，并自己包一层按钮；这里只画图标。
     * ---------------------------------------------------------------- */

    function PanelIcon(props) {
      const size = typeof props.size === 'number' && props.size > 0 ? props.size : 18
      const [configured, setConfigured] = useState(null)

      useEffect(() => {
        let alive = true
        requestJson('/status')
          .then((data) => {
            if (alive) setConfigured(Boolean(data.configured))
          })
          .catch(() => {
            /* 状态读不到就不加提示点，不影响图标本身 */
          })
        return () => {
          alive = false
        }
      }, [])

      return h(
        'span',
        {
          style: { position: 'relative', display: 'inline-flex' },
          title: configured === false ? 'HTML 托管（还没配置 API Key）' : 'HTML 托管',
        },
        h(IconPublish, { size }),
        configured === false ? h('span', { style: styles.dot, 'aria-hidden': true }) : null,
      )
    }

    /* ---------------------------------------------------------------- *
     * 中央主区域：已托管页面列表
     * ---------------------------------------------------------------- */

    function PanelPage() {
      const [status, setStatus] = useState({ loading: true, configured: false, label: '', masked: '', origin: '' })
      const [pages, setPages] = useState([])
      const [total, setTotal] = useState(0)
      const [query, setQuery] = useState('')
      const [appliedQuery, setAppliedQuery] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [credOpen, setCredOpen] = useState(false)
      const [keyDraft, setKeyDraft] = useState('')

      const loadPages = useCallback(async ({ offset = 0, q = '', append = false } = {}) => {
        setBusy(true)
        setError('')
        try {
          const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) })
          if (q) params.set('q', q)
          const data = await requestJson(`/pages?${params.toString()}`)
          if (data.ok) {
            setPages((prev) => (append ? [...prev, ...data.pages] : data.pages))
            setTotal(data.total)
            setAppliedQuery(q)
          } else {
            setError(`${data.error || '读取失败'}${data.code ? `（${data.code}）` : ''}`)
            if (data.code === 'NO_CREDENTIAL' || data.code === 'MISSING_CREDENTIAL' || data.code === 'INVALID_API_KEY') {
              setCredOpen(true)
              setStatus((prev) => ({ ...prev, configured: false }))
            }
            if (!append) setPages([])
          }
        } catch (err) {
          setError(`读取失败：${errorText(err)}`)
          if (!append) setPages([])
        } finally {
          setBusy(false)
        }
      }, [])

      const refreshStatus = useCallback(async () => {
        try {
          const data = await requestJson('/status')
          const next = {
            loading: false,
            configured: Boolean(data.configured),
            label: data.label || '',
            masked: data.masked || '',
            origin: data.origin || '',
          }
          setStatus(next)
          if (!next.configured) setCredOpen(true)
          return next
        } catch (err) {
          setStatus((prev) => ({ ...prev, loading: false }))
          setError(`读取凭证状态失败：${errorText(err)}`)
          return null
        }
      }, [])

      useEffect(() => {
        let alive = true
        ;(async () => {
          const next = await refreshStatus()
          if (!alive || !next) return
          if (next.configured) await loadPages({ offset: 0, q: '' })
        })()
        return () => {
          alive = false
        }
      }, [refreshStatus, loadPages])

      const handleSearch = () => {
        loadPages({ offset: 0, q: query.trim() })
      }

      const handleRefresh = () => {
        setNotice('')
        loadPages({ offset: 0, q: appliedQuery })
      }

      const handleLoadMore = () => {
        loadPages({ offset: pages.length, q: appliedQuery, append: true })
      }

      const handleSaveKey = async () => {
        const value = keyDraft.trim()
        if (!value) {
          setError('先填 API Key')
          return
        }
        setBusy(true)
        setError('')
        setNotice('')
        try {
          const data = await requestJson('/credential', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ apiKey: value }),
          })
          if (data.ok) {
            setKeyDraft('')
            setCredOpen(false)
            setNotice('API Key 已保存')
            const next = await refreshStatus()
            if (next && next.configured) await loadPages({ offset: 0, q: appliedQuery })
          } else {
            setError(data.error || '保存失败')
          }
        } catch (err) {
          setError(`保存失败：${errorText(err)}`)
        } finally {
          setBusy(false)
        }
      }

      const handleClearKey = async () => {
        setBusy(true)
        setError('')
        setNotice('')
        try {
          await requestJson('/credential', { method: 'DELETE' })
          setPages([])
          setTotal(0)
          setCredOpen(true)
          setNotice('API Key 已清除')
          await refreshStatus()
        } catch (err) {
          setError(`清除失败：${errorText(err)}`)
        } finally {
          setBusy(false)
        }
      }

      const handleCopy = async (text) => {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text)
            setNotice('短链已复制到剪贴板')
            return
          }
        } catch {
          /* 浏览器拒绝时退回手动复制 */
        }
        setNotice('浏览器不允许自动复制，请手动选中短链复制')
      }

      const credentialSummary = status.loading
        ? '读取中…'
        : status.configured
          ? `${status.label}${status.masked ? ` · ${status.masked}` : ''}`
          : '未配置 API Key'

      return h(
        'div',
        { className: 'hhp-page', style: styles.page },
        h(LocalStyles, null),
        h(
          'div',
          { style: styles.inner },

          h(
            'div',
            { style: styles.heading },
            h(
              'div',
              { style: styles.headingText },
              h('h1', { style: styles.title }, 'HTML 托管'),
              h(
                'p',
                { style: styles.subtitle },
                `${status.origin || 'pages.vmao.top'} 上已托管的页面。新页面由 AI 通过 html_host_publish 工具发布，或在会话里预览 HTML 文件时点「上传到 HTML 托管」。`,
              ),
            ),
            h(
              'div',
              { style: styles.row },
              h('button', { type: 'button', className: 'hhp-ghost', style: styles.ghost, disabled: busy, onClick: handleRefresh }, busy ? '刷新中…' : '刷新'),
            ),
          ),

          // 凭证
          h(
            'div',
            { style: styles.card },
            h(
              'div',
              { style: styles.cardHead },
              h('span', { style: styles.cardTitle }, '凭证'),
              h(
                'div',
                { style: styles.row },
                h('span', { style: styles.label }, credentialSummary),
                status.configured
                  ? h('button', { type: 'button', className: 'hhp-ghost', style: styles.ghost, disabled: busy, onClick: handleClearKey }, '清除')
                  : null,
                h(
                  'button',
                  { type: 'button', className: 'hhp-ghost', style: styles.ghost, onClick: () => setCredOpen(!credOpen) },
                  credOpen ? '收起' : '设置',
                ),
              ),
            ),
            credOpen
              ? h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                  h('span', { style: styles.label }, 'API Key（hh_live_ 开头，只在 Host 侧保存，不回显明文）'),
                  h(
                    'div',
                    { style: styles.row },
                    h('input', {
                      style: styles.input,
                      type: 'password',
                      value: keyDraft,
                      placeholder: 'hh_live_…',
                      autoComplete: 'off',
                      onChange: (event) => setKeyDraft(event.target.value),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter') handleSaveKey()
                      },
                    }),
                    h(
                      'button',
                      { type: 'button', className: 'hhp-primary', style: styles.primary, disabled: busy, onClick: handleSaveKey },
                      '保存',
                    ),
                  ),
                )
              : null,
          ),

          // 搜索
          h(
            'div',
            { style: styles.row },
            h('input', {
              style: styles.input,
              type: 'search',
              value: query,
              placeholder: '按标题或页面 ID 搜索',
              onChange: (event) => setQuery(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') handleSearch()
              },
            }),
            h('button', { type: 'button', className: 'hhp-ghost', style: styles.ghost, disabled: busy, onClick: handleSearch }, '搜索'),
          ),

          notice ? h('div', { style: styles.notice }, notice) : null,
          error ? h('div', { style: styles.errorBox }, error) : null,

          // 列表
          h(
            'div',
            { style: styles.listCard },
            h(
              'div',
              { style: styles.listHead },
              h('span', { style: styles.cardTitle }, appliedQuery ? `搜索结果` : '全部页面'),
              h(
                'span',
                { style: styles.label },
                `${pages.length} / ${total} 个${appliedQuery ? ` · 关键词「${appliedQuery}」` : ''}`,
              ),
            ),

            pages.length === 0
              ? h(
                  'div',
                  { style: styles.empty },
                  status.loading
                    ? '读取中…'
                    : !status.configured
                      ? '先在上面配置 API Key，再回来就能看到已托管的页面。'
                      : appliedQuery
                        ? `没有匹配「${appliedQuery}」的页面。`
                        : '还没有托管过页面。让 AI 用 html_host_publish 发布一个吧。',
                )
              : pages.map((page) =>
                  h(
                    'div',
                    { key: page.id, className: 'hhp-row', style: styles.item },
                    h(
                      'div',
                      { style: styles.itemMain },
                      h(
                        'a',
                        {
                          className: 'hhp-link hhp-title',
                          style: styles.itemTitle,
                          href: page.url,
                          target: '_blank',
                          rel: 'noreferrer',
                          title: page.title || '未命名页面',
                        },
                        page.title || '未命名页面',
                        page.hasPassword ? h('span', { style: styles.lock }, ' · 有访问密码') : null,
                      ),
                      h(
                        'a',
                        { className: 'hhp-link', style: styles.itemUrl, href: page.url, target: '_blank', rel: 'noreferrer' },
                        page.url,
                      ),
                      h(
                        'span',
                        { style: styles.itemMeta },
                        `${formatSize(page.size)} · ${page.views} 次浏览 · ${formatTime(page.createdAt)} · ${formatExpiry(page.expiresAt)}`,
                      ),
                    ),
                    h(
                      'div',
                      { style: styles.row },
                      h('button', { type: 'button', className: 'hhp-ghost', style: styles.ghost, onClick: () => handleCopy(page.url) }, '复制'),
                      h(
                        'a',
                        { className: 'hhp-link hhp-ghost', style: styles.ghost, href: page.url, target: '_blank', rel: 'noreferrer' },
                        '打开',
                      ),
                    ),
                  ),
                ),

            pages.length > 0 && pages.length < total
              ? h(
                  'div',
                  { style: { ...styles.rowEnd, padding: '10px 14px', borderTop: '1px solid var(--dsw-alias-border-l1)' } },
                  h(
                    'button',
                    { type: 'button', className: 'hhp-ghost', style: styles.ghost, disabled: busy, onClick: handleLoadMore },
                    busy ? '加载中…' : `加载更多（还有 ${total - pages.length} 个）`,
                  ),
                )
              : null,
          ),
        ),
      )
    }

    /* ---------------------------------------------------------------- *
     * 会话里打开 HTML 文件预览时，文档预览头部多一个上传图标
     *
     * 宿主把被预览文件的绝对路径作为 owner prop（absolutePath）交给
     * `sidebar.right.tab.document.actions` 的占用者。只在 .html/.htm 上出现，
     * 其它文件返回 null，不占位置。
     *
     * 按钮只有图标（云 + 上传箭头），所以必须自带 aria-label 与 title：
     * 没有可见文字时，可访问名称不能也一起消失。
     * ---------------------------------------------------------------- */

    /** 「云 + 上传箭头」：读作「上传到托管」。原图 viewBox 1024，按需缩放。 */
    function IconUploadCloud({ size = 16 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 1024 1024',
          fill: 'currentColor',
          'aria-hidden': true,
          focusable: 'false',
          style: { display: 'block' },
        },
        h('path', {
          d:
            'M808.192 262.592a320.16 320.16 0 0 0-592.352 0A238.592 238.592 0 0 0 32 496C32 628.352 139.648 736 272 736h91.488a32 32 0 1 0 0-64H272A176.192 176.192 0 0 1 96 496a175.04 175.04 0 0 1 148.48-173.888l19.04-2.976 6.24-18.24C305.248 197.472 402.592 128 512 128a256 256 0 0 1 242.208 172.896l6.272 18.24 19.04 2.976A175.04 175.04 0 0 1 928 496c0 97.024-78.976 176-176 176h-97.28a32 32 0 1 0 0 64h97.28c132.352 0 240-107.648 240-240a238.592 238.592 0 0 0-183.808-233.408z',
        }),
        h('path', {
          d:
            'M649.792 570.048a32 32 0 1 0 40.544-49.536l-158.048-129.408a32 32 0 0 0-40.576 0l-159.04 130.24a32.032 32.032 0 0 0 20.256 56.768 31.744 31.744 0 0 0 20.256-7.264L480 483.456V912a32 32 0 0 0 64 0V483.456l105.792 86.592z',
        }),
      )
    }

    function fileNameOf(path) {
      const cut = path.split(/[\\/]/).pop() || ''
      return cut || '未命名页面'
    }

    function PreviewUploadAction(props) {
      // hooks 必须无条件调用：先声明状态，再决定是否渲染。
      const [busy, setBusy] = useState(false)
      const [outcome, setOutcome] = useState(null)

      const absolutePath = props && typeof props.absolutePath === 'string' ? props.absolutePath : ''
      if (!/\.html?$/i.test(absolutePath)) return null

      const baseName = fileNameOf(absolutePath)
      const title = baseName.replace(/\.(html?|htm)$/i, '') || '未命名页面'

      const handleUpload = async () => {
        if (busy) return
        setBusy(true)
        setOutcome(null)
        try {
          const data = await requestJson('/publish-file', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: absolutePath, title }),
          })
          if (data.ok) {
            setOutcome({ ok: true, text: `已上传：${data.url || ''}` })
          } else {
            setOutcome({ ok: false, text: `${data.error || '上传失败'}${data.code ? `（${data.code}）` : ''}` })
          }
        } catch (err) {
          setOutcome({ ok: false, text: `上传失败：${errorText(err)}` })
        } finally {
          setBusy(false)
        }
      }

      const handleCopy = async () => {
        if (!outcome || !outcome.ok) return
        const url = String(outcome.text).replace(/^已上传：/, '')
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(url)
            setOutcome({ ok: true, text: `已复制：${url}` })
          }
        } catch {
          /* 浏览器拒绝就保持原文案，用户仍可手动选中 */
        }
      }

      return h(
        'div',
        { style: styles.previewAction },
        h(LocalStyles, null),
        h(
          'button',
          {
            type: 'button',
            className: 'hhp-ghost hhp-icon',
            style: styles.iconButton,
            disabled: busy,
            title: busy ? `正在上传 ${baseName}…` : `上传到 HTML 托管（${baseName}）`,
            'aria-label': '上传到 HTML 托管',
            'aria-busy': busy ? 'true' : undefined,
            onClick: handleUpload,
          },
          h(IconUploadCloud, { size: 16 }),
        ),
        outcome
          ? h(
              'button',
              {
                type: 'button',
                className: outcome.ok ? 'hhp-ghost hhp-link' : 'hhp-ghost',
                style: {
                  ...styles.ghost,
                  height: 26,
                  maxWidth: 320,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: outcome.ok ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-state-error-primary)',
                },
                title: outcome.text,
                onClick: outcome.ok ? handleCopy : undefined,
              },
              outcome.text,
            )
          : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 左侧面板列表的图标；id 与下面 main 的 key 必须一致。
        // 标签用「HTML 托管」以外的区分：宿主的 panellist 里已有一条自带的
        // `html-host`，两条同 id 会互相顶掉，所以这里用独立 id。
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 21, label: 'HTML 托管' },
            PanelIcon,
          ),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, PanelPage),
        )
        // 会话侧边栏的文档预览头部：只在预览 .html/.htm 时出现上传按钮。
        ctx.slots.inject('sidebar.right.tab.document.actions', () =>
          ctx.slots.register(
            {
              name: 'sidebar.right.tab.document.actions',
              id: 'html-host-upload',
              order: 30,
              label: '上传到 HTML 托管',
            },
            PreviewUploadAction,
          ),
        )
      },
    }
  },
})
