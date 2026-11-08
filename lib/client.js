// Cosplay Studio 2.0 — browser half.
//
// Renders one workbench panel inside the DSH main area plus its sidebar icon:
//   • tutorial + consent, ComfyUI deployment progress and the setup log;
//   • project list, character card editing, base-image approval gate;
//   • shot script editor and approval gate; final gallery + delivery copy.
//
// The bundle is a CommonJS factory registered with the DSH module loader; React
// is required from the host, everything else is plain fetch against the JSON API
// the host half registers under /api/cosplay-studio.

window.__ModuleLoader__.load({
  id: 'dsh-cosplay-studio',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const react = require('react')
    const h = react.createElement
    const { useState, useEffect, useRef, useMemo, useCallback } = react

    const API = '/api/cosplay-studio'
    const PANEL_ID = 'cosplay-studio'
    const ACCENT = '#7c5cff'

    const STATUS_LABEL = {
      card: '角色卡',
      'awaiting-base-approval': '待确认基准图',
      'base-approved': '基准图已确认',
      'awaiting-script-approval': '待确认脚本',
      generating: '生成中',
      generated: '待导出',
      done: '已完成',
      failed: '失败',
    }

    const CHIP = {
      card: '#8e8e93',
      'awaiting-base-approval': '#ff9f0a',
      'base-approved': '#34c759',
      'awaiting-script-approval': '#ff9f0a',
      generating: '#0a84ff',
      generated: '#0a84ff',
      done: '#34c759',
      failed: '#ff453a',
    }

    function api(path, body, method) {
      const init = { method: method ?? (body === undefined ? 'GET' : 'POST') }
      if (body !== undefined) {
        init.headers = { 'content-type': 'application/json' }
        init.body = JSON.stringify(body)
      }
      return fetch(API + path, init).then(async (res) => {
        let data = null
        try {
          data = await res.json()
        } catch {
          data = null
        }
        if (!res.ok || (data !== null && data.ok === false)) {
          throw new Error(data?.error ?? `请求失败（HTTP ${res.status}）`)
        }
        return data
      })
    }

    function mediaUrl(id, subpath) {
      const encoded = String(subpath)
        .split('/')
        .map((part) => encodeURIComponent(part))
        .join('/')
      return `${API}/media/${encodeURIComponent(id)}/${encoded}`
    }

    function errText(error) {
      return error?.message ?? String(error)
    }

    /* ------------------------------------------------------------- atoms */

    const ui = {
      root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, color: 'inherit', fontSize: 13 },
      header: {
        display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px',
        borderBottom: '1px solid rgba(128,128,128,0.22)', flex: 'none',
      },
      title: { fontSize: 15, fontWeight: 600, letterSpacing: 0.2 },
      sub: { fontSize: 11.5, opacity: 0.6, marginTop: 2 },
      body: { flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' },
      scroll: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 18px 24px' },
      card: {
        border: '1px solid rgba(128,128,128,0.24)', borderRadius: 10,
        padding: '12px 14px', marginBottom: 12, background: 'rgba(128,128,128,0.045)',
      },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      col: { display: 'flex', flexDirection: 'column', gap: 6 },
      label: { fontSize: 11.5, opacity: 0.66, letterSpacing: 0.2 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 11.5, lineHeight: 1.55 },
      input: {
        width: '100%', boxSizing: 'border-box', padding: '6px 8px', fontSize: 12.5, borderRadius: 7,
        border: '1px solid rgba(128,128,128,0.32)', background: 'rgba(128,128,128,0.06)', color: 'inherit',
        outline: 'none', fontFamily: 'inherit',
      },
      textarea: {
        width: '100%', boxSizing: 'border-box', padding: '7px 9px', fontSize: 12, lineHeight: 1.5,
        borderRadius: 7, border: '1px solid rgba(128,128,128,0.32)', background: 'rgba(128,128,128,0.06)',
        color: 'inherit', outline: 'none', resize: 'vertical', fontFamily: 'inherit',
      },
      hint: { fontSize: 11.5, opacity: 0.62, lineHeight: 1.6 },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))', gap: 12 },
      thumb: { width: '100%', aspectRatio: '9 / 16', objectFit: 'cover', borderRadius: 8, display: 'block', background: 'rgba(128,128,128,0.12)' },
      tab: (active) => ({
        padding: '5px 11px', borderRadius: 999, fontSize: 12, cursor: 'pointer', userSelect: 'none',
        border: '1px solid ' + (active ? ACCENT : 'rgba(128,128,128,0.3)'),
        background: active ? ACCENT : 'transparent',
        color: active ? '#fff' : 'inherit', fontWeight: active ? 600 : 400,
      }),
      chip: (color) => ({
        display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, padding: '1px 7px',
        borderRadius: 999, border: `1px solid ${color}55`, color, background: `${color}18`, whiteSpace: 'nowrap',
      }),
      bar: { height: 6, borderRadius: 999, background: 'rgba(128,128,128,0.2)', overflow: 'hidden', marginTop: 8 },
    }

    function Btn({ children, onClick, kind = 'ghost', disabled, title, style }) {
      const base = {
        padding: '6px 12px', borderRadius: 8, fontSize: 12.5, cursor: disabled ? 'not-allowed' : 'pointer',
        border: '1px solid rgba(128,128,128,0.3)', background: 'rgba(128,128,128,0.08)', color: 'inherit',
        opacity: disabled ? 0.45 : 1, whiteSpace: 'nowrap', fontFamily: 'inherit',
      }
      const primary = { ...base, background: ACCENT, borderColor: ACCENT, color: '#fff', fontWeight: 600 }
      return h('button', {
        type: 'button', title, disabled, onClick: disabled ? undefined : onClick,
        style: { ...(kind === 'primary' ? primary : base), ...style },
      }, children)
    }

    function Field({ label, value, onChange, placeholder, type = 'text', textarea, rows = 2, disabled }) {
      return h('label', { style: ui.col },
        h('span', { style: ui.label }, label),
        textarea
          ? h('textarea', {
              value: value ?? '', rows, placeholder, disabled,
              onChange: (event) => onChange(event.target.value),
              style: ui.textarea,
            })
          : h('input', {
              type, value: value ?? '', placeholder, disabled,
              onChange: (event) => onChange(event.target.value),
              style: ui.input,
            }))
    }

    function Progress({ value, label }) {
      const pct = Math.max(0, Math.min(1, Number(value) || 0)) * 100
      return h('div', null,
        h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 11.5, opacity: 0.7 } },
          h('span', null, label ?? ''),
          h('span', null, `${pct.toFixed(0)}%`)),
        h('div', { style: ui.bar }, h('div', { style: { height: '100%', width: `${pct}%`, background: ACCENT, transition: 'width .4s ease' } })))
    }

    function StatusChip({ status }) {
      const color = CHIP[status] ?? '#8e8e93'
      return h('span', { style: ui.chip(color) }, STATUS_LABEL[status] ?? status)
    }

    /* ------------------------------------------------------------ icon */

    function SidebarIcon(props) {
      const size = props?.size ?? 20
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
      },
        h('path', { d: 'M12 3.2l2.1 5.1 5.1 2.1-5.1 2.1L12 17.6l-2.1-5.1L4.8 10.4l5.1-2.1z' }),
        h('circle', { cx: 18.6, cy: 5.4, r: 1.5 }),
        h('path', { d: 'M5.2 18.4l1 2.4 2.4 1-2.4 1-1 2.4' }))
    }

    /* ------------------------------------------------------- consent view */

    function ConsentView({ state, onConsent, onConsentDeploy, busy }) {
      const [agree, setAgree] = useState(false)
      const [warn, setWarn] = useState(false)
      const guard = (fn) => {
        if (!agree) {
          setWarn(true)
          return
        }
        setWarn(false)
        fn()
      }
      return h('div', { style: { ...ui.scroll, maxWidth: 760 } },
        h('div', { style: { fontSize: 18, fontWeight: 650, marginBottom: 6 } }, '开始之前，请先读一遍'),
        h('div', { style: { ...ui.hint, marginBottom: 16 } },
          '第一次使用需要在本机部署 ComfyUI 和模型，下载量较大。读完后勾选同意，插件才会开始下载与安装。'),
        ...(state?.tutorial ?? []).map((section) => h('div', { key: section.title, style: ui.card },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, section.title),
          h('div', { style: { ...ui.hint, opacity: 0.78 } }, section.body))),
        h('label', {
          style: {
            display: 'flex', gap: 8, alignItems: 'flex-start', margin: '18px 0 8px', cursor: 'pointer',
            padding: '8px 10px', borderRadius: 8,
            border: '1px solid ' + (warn && !agree ? '#ff4538' : 'transparent'),
            background: warn && !agree ? 'rgba(255,69,58,0.08)' : 'transparent',
            transition: 'background .2s ease, border-color .2s ease',
          },
        },
          h('input', {
            type: 'checkbox', checked: agree,
            onChange: (event) => {
              setAgree(event.target.checked)
              if (event.target.checked) setWarn(false)
            },
            style: { marginTop: 2 },
          }),
          h('span', { style: { fontSize: 12.5, lineHeight: 1.6 } },
            '我已阅读并同意：插件将在本机下载并安装 ComfyUI 与模型（约 8–10 GB），占用磁盘与网络；出图全部在本机完成，图片不上传云端；角色为 18 岁以上成人设定。')),
        warn && !agree
          ? h('div', { style: { fontSize: 12, color: '#ff6b6b', marginBottom: 8 } }, '请先勾选上面的同意项，再点下面的按钮。')
          : null,
        h('div', { style: ui.row },
          h(Btn, { kind: 'primary', disabled: busy, onClick: () => guard(onConsentDeploy) },
            busy ? '处理中…' : '同意并开始部署'),
          h(Btn, { disabled: busy, onClick: () => guard(onConsent) }, '仅同意，稍后手动部署')))
    }

    /* -------------------------------------------------------- deploy view */

    function DeployView({ state, actions, busy }) {
      const deployment = state?.deployment ?? {}
      const env = state?.env ?? {}
      const config = state?.config ?? {}
      const [showSettings, setShowSettings] = useState(false)
      const [settings, setSettings] = useState(null)
      const logRef = useRef(null)

      useEffect(() => {
        if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
      }, [deployment.log?.length])

      useEffect(() => {
        if (settings === null && config.comfyDir !== undefined) {
          setSettings({
            comfyDir: config.comfyDir ?? '',
            comfyPort: String(config.comfyPort ?? 8188),
            autoDownloadModels: config.autoDownloadModels !== false,
            llmBaseUrl: config.llm?.baseUrl ?? '',
            llmModel: config.llm?.model ?? '',
            llmApiKey: '',
          })
        }
      }, [config.comfyDir, config.comfyPort, settings])

      const s = settings ?? {}
      const patch = (key) => (value) => setSettings({ ...(settings ?? {}), [key]: value })

      const saveSettings = async () => {
        const body = {
          comfyDir: s.comfyDir ?? '',
          comfyPort: Number(s.comfyPort) || 8188,
          autoDownloadModels: s.autoDownloadModels !== false,
          llm: { baseUrl: s.llmBaseUrl ?? '', model: s.llmModel ?? '', ...(String(s.llmApiKey ?? '').trim() !== '' ? { apiKey: String(s.llmApiKey).trim() } : {}) },
        }
        await actions.saveConfig(body)
        setSettings({ ...s, llmApiKey: '' })
      }

      const statusColor = deployment.status === 'ready' ? '#34c759' : deployment.status === 'failed' ? '#ff453a' : deployment.status === 'running' ? '#0a84ff' : '#8e8e93'
      const vramGb = env.vram > 0 ? (env.vram / 1073741824).toFixed(1) : ''

      return h('div', { style: { ...ui.scroll, maxWidth: 860 } },
        h('div', { style: { ...ui.card } },
          h('div', { style: ui.row },
            h(StatusChip, { status: deployment.status === 'ready' ? 'done' : (deployment.status === 'failed' ? 'failed' : 'generating') }),
            h('span', { style: { fontWeight: 600, fontSize: 13.5 } },
              deployment.status === 'ready' ? '部署完成，可以出图了' : deployment.status === 'running' ? `正在部署：${deployment.step || ''}` : deployment.status === 'failed' ? '部署中断' : '尚未部署'),
            h('span', { style: { flex: 1 } }),
            h(Btn, { kind: 'primary', disabled: busy || deployment.busy, onClick: () => actions.deploy() },
              deployment.status === 'ready' ? '重新检测并自检' : '开始部署')),
          deployment.status === 'running' || deployment.message
            ? h('div', null,
                h('div', { style: { ...ui.hint, marginTop: 8, color: deployment.status === 'failed' ? '#ff453a' : 'inherit' } }, deployment.message),
                h(Progress, { value: deployment.progress ?? 0, label: deployment.step ?? '' }))
            : null,
          deployment.selfTest
            ? h('div', { style: { ...ui.hint, marginTop: 8 } },
                `自检：${deployment.selfTest.elapsedSeconds}s 出图 · ${Math.round((deployment.selfTest.bytes ?? 0) / 1024)} KB · 分辨率 ${deployment.selfTest.width}×${deployment.selfTest.height}`)
            : null),

        h('div', { style: ui.card },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '运行环境'),
          h('div', { style: { display: 'grid', gridTemplateColumns: '110px 1fr', rowGap: 6, fontSize: 12 } },
            h('span', { style: ui.label }, 'ComfyUI'),
            h('span', null, env.comfyFound ? env.comfyDir : '未找到（部署时会自动安装）'),
            h('span', { style: ui.label }, 'Python'),
            h('span', { style: { ...ui.mono, opacity: 0.8 } }, env.python || '—'),
            h('span', { style: ui.label }, '服务状态'),
            h('span', null, env.running
              ? `运行中 · 端口 ${config.comfyPort}${env.pid ? ` · PID ${env.pid}` : ''}`
              : '未运行'),
            h('span', { style: ui.label }, '显卡'),
            h('span', null, env.gpu ? `${env.gpu}${vramGb ? ` · ${vramGb} GB 显存` : ''}` : '未检测到（服务未启动）'),
            h('span', { style: ui.label }, '模型'),
            h('span', null, (env.missingModels ?? []).length === 0
              ? 'UNET / 文本编码器 / VAE 齐全'
              : `缺少：${(env.missingModels ?? []).join('、')}`)),
          h('div', { style: { ...ui.row, marginTop: 10 } },
            h(Btn, { disabled: busy || env.running, onClick: () => actions.startComfy() }, '启动 ComfyUI'),
            h(Btn, { disabled: busy || !env.running, onClick: () => actions.stopComfy() }, '停止'),
            h(Btn, { disabled: busy, onClick: () => actions.detect() }, '重新检测'))),

        h('div', { style: ui.card },
          h('div', { style: { ...ui.row, marginBottom: 8 } },
            h('span', { style: { fontWeight: 600 } }, '部署日志'),
            h('span', { style: { flex: 1 } }),
            h(Btn, { disabled: busy, onClick: () => actions.clearAndReload() }, '刷新')),
          h('div', {
            ref: logRef,
            style: {
              ...ui.mono, maxHeight: 220, overflowY: 'auto', background: 'rgba(0,0,0,0.18)',
              borderRadius: 8, padding: '8px 10px', border: '1px solid rgba(128,128,128,0.18)',
            },
          },
            (deployment.log ?? []).length === 0
              ? h('div', { style: { opacity: 0.5 } }, '（还没有日志）')
              : (deployment.log ?? []).map((line, index) => h('div', {
                  key: index,
                  style: { color: line.level === 'error' ? '#ff6b6b' : 'inherit', opacity: line.level === 'error' ? 1 : 0.82, whiteSpace: 'pre-wrap' },
                }, `${line.t} ${line.text}`)))),

        h('div', { style: ui.card },
          h('div', { style: { ...ui.row, cursor: 'pointer' } },
            h(Btn, { onClick: () => setShowSettings(!showSettings) }, showSettings ? '收起设置' : '高级设置'),
            h('span', { style: ui.hint }, '已有 ComfyUI、换了模型、或想接自己的对话模型时在这里改')),
          showSettings
            ? h('div', { style: { display: 'grid', gap: 10, marginTop: 12 } },
                h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 120px', gap: 10 } },
                  h(Field, { label: 'ComfyUI 目录（含 main.py）', value: s.comfyDir, onChange: patch('comfyDir'), placeholder: 'D:\\Softwares\\ComfyUI\\ComfyUI' }),
                  h(Field, { label: '端口', value: s.comfyPort, onChange: patch('comfyPort'), placeholder: '8188' })),
                h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, cursor: 'pointer' } },
                  h('input', { type: 'checkbox', checked: s.autoDownloadModels !== false, onChange: (event) => patch('autoDownloadModels')(event.target.checked) }),
                  '部署时自动下载缺失的模型（关闭后需手动放置）'),
                h('div', { style: { fontSize: 12, fontWeight: 600, marginTop: 4 } }, '角色/脚本模型（OpenAI 兼容接口，可选）'),
                h('div', { style: { ...ui.hint } }, '填了之后会用对话模型检索角色设定、生成角色卡与镜头脚本；不填则用内置模板。密钥只保存在本机配置里。'),
                h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 } },
                  h(Field, { label: '接口地址', value: s.llmBaseUrl, onChange: patch('llmBaseUrl'), placeholder: 'https://api.openai.com/v1' }),
                  h(Field, { label: '模型名', value: s.llmModel, onChange: patch('llmModel'), placeholder: 'gpt-4o-mini' })),
                h(Field, { label: 'API Key（留空表示不修改）', value: s.llmApiKey, onChange: patch('llmApiKey'), type: 'password', placeholder: config.llm?.hasKey ? '已保存' : '' }),
                h('div', { style: ui.row }, h(Btn, { kind: 'primary', disabled: busy, onClick: () => { void saveSettings().catch((error) => actions.reportError(errText(error))) } }, '保存设置')))
            : null))
    }

    /* -------------------------------------------------------- shot editor */

    function ShotCard({ shot, index, onChange, onRemove }) {
      const set = (key) => (value) => onChange({ ...shot, [key]: value })
      return h('div', { style: { ...ui.card, marginBottom: 10 } },
        h('div', { style: ui.row },
          h('span', { style: { fontWeight: 650, minWidth: 54 } }, `镜头 ${index + 1}`),
          h('select', {
            value: shot.type ?? 'A 情绪特写',
            onChange: (event) => set('type')(event.target.value),
            style: { ...ui.input, width: 140 },
          }, ['A 情绪特写', 'B 不看她', 'C 动态抓拍', 'D 标志动作 + 道具', 'E 极端机位', 'F 坐蹲卧'].map((type) =>
              h('option', { key: type, value: type }, type))),
          h('input', {
            value: shot.title ?? '', placeholder: '动作名（会用作文件名）',
            onChange: (event) => set('title')(event.target.value),
            style: { ...ui.input, flex: 1, minWidth: 160 },
          }),
          h(Btn, { onClick: onRemove, title: '删除这一镜' }, '删除')),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 } },
          h(Field, { label: '情境（她在做什么）', value: shot.situation, onChange: set('situation'), textarea: true, rows: 2 }),
          h(Field, { label: '表情', value: shot.expression, onChange: set('expression'), textarea: true, rows: 2 }),
          h(Field, { label: '动作', value: shot.pose, onChange: set('pose'), textarea: true, rows: 2 }),
          h(Field, { label: '手在哪里', value: shot.hands, onChange: set('hands'), textarea: true, rows: 2 }),
          h(Field, { label: '机位', value: shot.camera, onChange: set('camera'), textarea: true, rows: 2 }),
          h(Field, { label: '道具', value: shot.props, onChange: set('props'), textarea: true, rows: 2 })))
    }

    /* ------------------------------------------------------- project view */

    function ProjectView({ state, project, actions, busy, tab, setTab }) {
      const [details, setDetails] = useState(null)
      const [shots, setShots] = useState(null)
      const queue = state?.queue ?? {}
      const deployment = state?.deployment ?? {}
      const env = state?.env ?? {}

      useEffect(() => {
        setDetails(project?.details ? { ...project.details } : null)
        setShots(project?.shots ? project.shots.map((shot) => ({ ...shot })) : null)
      }, [project?.id, project?.updatedAt])

      if (!project) {
        return h('div', { style: { ...ui.scroll, display: 'flex', alignItems: 'center', justifyContent: 'center' } },
          h('div', { style: { textAlign: 'center', opacity: 0.55, maxWidth: 380, lineHeight: 1.8 } },
            h('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 8 } }, '还没有打开项目'),
            h('div', { style: { fontSize: 12.5 } }, '在左边输入角色名新建一个，或者点开已有项目。'),
            h('div', { style: { fontSize: 12.5, marginTop: 8 } }, '流程：角色卡 → 基准图确认 → 镜头脚本确认 → 成片 → 导出。')))
      }

      const baseApproved = ['base-approved', 'awaiting-script-approval', 'generating', 'generated', 'done'].includes(project.status)
      const scriptApproved = ['generating', 'generated', 'done'].includes(project.status)
      const d = details ?? project.details ?? {}
      const patchDetail = (key) => (value) => setDetails({ ...(details ?? {}), [key]: value })

      const saveDetails = () => {
        void actions.updateProject(project.id, { details }).catch((error) => actions.reportError(errText(error)))
      }

      const confirmBase = () => {
        void actions.updateProject(project.id, { status: 'base-approved' }).then(() => setTab('script'))
      }

      const saveShots = () => {
        void actions.updateProject(project.id, { shots }).catch((error) => actions.reportError(errText(error)))
      }

      const confirmShots = () => {
        void actions.updateProject(project.id, { shots })
          .then(() => actions.generate(project.id))
          .then(() => setTab('final'))
          .catch((error) => actions.reportError(errText(error)))
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 } },
        h('div', { style: { padding: '12px 18px 0', flex: 'none' } },
          h('div', { style: ui.row },
            h('div', { style: { fontSize: 15.5, fontWeight: 650 } }, project.character),
            project.series ? h('div', { style: { fontSize: 12, opacity: 0.6 } }, `《${project.series}》`) : null,
            h(StatusChip, { status: project.status }),
            h('span', { style: { flex: 1 } }),
            ...['base', 'script', 'final'].map((key) => h('div', {
              key,
              style: ui.tab(tab === key),
              onClick: () => {
                if (key === 'script' && !baseApproved) {
                  actions.reportError('先确认基准图，再进入镜头脚本')
                  return
                }
                if (key === 'final' && !scriptApproved) {
                  actions.reportError('先确认镜头脚本，再生成成片')
                  return
                }
                setTab(key)
              },
            }, key === 'base' ? '① 基准图' : key === 'script' ? '② 镜头脚本' : '③ 成片导出'))),
          h('div', { style: { ...ui.hint, marginTop: 6 } },
            baseApproved ? '基准图已确认，后续成片会逐字复用这张角色卡，只替换姿态与手部描述。' : '基准图是整套图的地基：人物、服装、背景、灯光都由它定下来，确认后才继续。'),
          !env.running ? h('div', { style: { ...ui.hint, color: '#ff9f0a', marginTop: 4 } }, 'ComfyUI 当前没有运行，生成前请到「安装」页启动。') : null),

        h('div', { style: { ...ui.scroll, paddingTop: 12 } },
          tab === 'base' ? h('div', null,
            h('div', { style: ui.card },
              h('div', { style: ui.row, marginBottom: 8 },
                h('span', { style: { fontWeight: 600 } }, '角色特征'),
                h('span', { style: ui.hint }, '改完记得保存，角色卡会重新生成')),
              h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } },
                h(Field, { label: '人物设定（gender word）', value: d.genderWord, onChange: patchDetail('genderWord') }),
                h(Field, { label: '道具', value: d.props, onChange: patchDetail('props') }),
                h(Field, { label: '发型', value: d.hair, onChange: patchDetail('hair'), textarea: true, rows: 2 }),
                h(Field, { label: '脸部', value: d.face, onChange: patchDetail('face'), textarea: true, rows: 2 }),
                h(Field, { label: '服装', value: d.costume, onChange: patchDetail('costume'), textarea: true, rows: 3 }),
                h('div', { style: { display: 'grid', gap: 8 } },
                  h(Field, { label: '背景上色', value: d.paletteTop, onChange: patchDetail('paletteTop') }),
                  h(Field, { label: '背景下色', value: d.paletteBottom, onChange: patchDetail('paletteBottom') }),
                  h(Field, { label: '性格（脚本用）', value: d.personality, onChange: patchDetail('personality') }))),
              h('div', { style: { ...ui.row, marginTop: 10 } },
                h(Btn, { kind: 'primary', disabled: busy, onClick: saveDetails }, '保存角色卡'),
                h(Btn, { disabled: busy, onClick: () => { void actions.copyCard(project.card) } }, '复制完整提示词'))),

            h('div', { style: ui.card },
              h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '基准图 1152×2048'),
              h('div', { style: ui.row },
                h(Btn, { kind: 'primary', disabled: busy || queue.running || !env.running, onClick: () => actions.base(project.id, 1, false) }, '生成 1 张基准图'),
                h(Btn, { disabled: busy || queue.running || !env.running, onClick: () => actions.base(project.id, 2, false) }, '生成 2 张（对比）'),
                project.referenceFile
                  ? h(Btn, { disabled: busy || queue.running || !env.running, onClick: () => actions.base(project.id, 1, true) }, '按参考图生成')
                  : null),
              h('div', { style: { ...ui.hint, marginTop: 8 } },
                '生成一张约 75 秒。同一张角色卡换随机种子，多张可选最像的一张。' + (project.referenceFile ? '参考图模式用 img2img（denoise 0.6），会保留参考图的构图与配色倾向。' : '')),
              (project.baseImages ?? []).length > 0
                ? h('div', { style: { ...ui.grid, marginTop: 12 } },
                    (project.baseImages ?? []).map((file) => h('div', { key: file, style: ui.col },
                      h('img', { src: mediaUrl(project.id, `base/${file}`), style: ui.thumb }),
                      h('span', { style: { ...ui.mono, opacity: 0.6, fontSize: 10.5, wordBreak: 'break-all' } }, file))))
                : h('div', { style: { ...ui.hint, marginTop: 10, opacity: 0.5 } }, '还没有基准图。'),
              (project.baseImages ?? []).length > 0 && !baseApproved
                ? h('div', { style: { ...ui.row, marginTop: 12 } },
                    h(Btn, { kind: 'primary', disabled: busy, onClick: confirmBase }, '确认基准图，进入镜头脚本'))
                : null)) : null,

          tab === 'script' ? h('div', null,
            h('div', { style: ui.card },
              h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '镜头脚本（4–6 镜）'),
              h('div', { style: ui.row },
                h(Btn, { kind: 'primary', disabled: busy, onClick: () => actions.script(project.id, 6) }, '生成 6 镜脚本'),
                h(Btn, { disabled: busy, onClick: () => actions.script(project.id, 4) }, '生成 4 镜脚本'),
                h(Btn, { disabled: busy, onClick: () => { setShots([...(shots ?? []), { type: 'A 情绪特写', title: `镜头 ${(shots ?? []).length + 1}`, situation: '', expression: '', pose: '', hands: '', camera: '', props: 'no props' }]) } }, '手动加一镜')),
              h('div', { style: { ...ui.hint, marginTop: 8 } },
                '脚本规矩：表情不重样、至少一张不看镜头、机位至少两种、手的位置各不相同。一行一镜，确认后才开始出成片（每张约 230 秒）。')),
            (shots ?? []).length === 0
              ? h('div', { style: { ...ui.card, opacity: 0.6 } }, '还没有脚本。先生成或手动添加。')
              : (shots ?? []).map((shot, index) => h(ShotCard, {
                  key: `${index}-${shot.title ?? ''}`,
                  shot, index,
                  onChange: (next) => setShots((current) => (current ?? []).map((item, i) => (i === index ? next : item))),
                  onRemove: () => setShots((current) => (current ?? []).filter((item, i) => i !== index)),
                })),
            (shots ?? []).length > 0
              ? h('div', { style: { ...ui.row, marginTop: 4, marginBottom: 12 } },
                  h(Btn, { disabled: busy, onClick: saveShots }, '保存脚本'),
                  h(Btn, { kind: 'primary', disabled: busy || queue.running || !env.running, onClick: confirmShots }, `确认脚本，开始出 ${(shots ?? []).length} 张成片`),
                  h('span', { style: ui.hint }, `预计 ${Math.round((shots ?? []).length * 3.9)} 分钟`))
              : null) : null,

          tab === 'final' ? h('div', null,
            h('div', { style: ui.card },
              h('div', { style: { ...ui.row, marginBottom: 8 } },
                h('span', { style: { fontWeight: 600 } }, '成片与导出'),
                h('span', { style: { flex: 1 } }),
                h(Btn, { kind: 'primary', disabled: busy || queue.running || !env.running, onClick: () => actions.generate(project.id) }, '重新生成未完成的镜头')),
              h('div', { style: ui.row },
                h(Btn, { disabled: busy || queue.running || (project.pendingFinals ?? []).length === 0, onClick: () => actions.finalize(project.id) }, '去油光 / 压 JPEG / 生成预览与文案')),
              h('div', { style: { ...ui.hint, marginTop: 8 } },
                '导出会按 skill 规矩输出：00_基准角色_角色.jpg、01_动作名.jpg……、00_全套预览.jpg（2×2，单格 720×1280）、文案.txt，并复制到 deliver/。'),
              queue.running && queue.current === `shots-${project.id}`
                ? h('div', { style: { marginTop: 10 } },
                    h(Progress, { value: queue.total > 0 ? queue.done / queue.total : 0, label: queue.label }),
                    h('div', { style: { ...ui.row, marginTop: 8 } }, h(Btn, { onClick: () => actions.cancelQueue() }, '取消剩余镜头')))
                : null),

            (project.finals ?? []).length > 0 || project.preview
              ? h('div', null,
                  project.preview
                    ? h('div', { style: { ...ui.card } },
                        h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '全套预览'),
                        h('img', { src: mediaUrl(project.id, `final/${project.preview}`), style: { width: '100%', maxWidth: 520, borderRadius: 8, display: 'block' } }),
                        h('div', { style: { ...ui.row, marginTop: 8 } },
                          h('a', { href: mediaUrl(project.id, `deliver/文案.txt`), target: '_blank', rel: 'noreferrer', style: { color: ACCENT, fontSize: 12 } }, '打开文案.txt'),
                          h('a', { href: mediaUrl(project.id, `deliver/${project.preview}`), target: '_blank', rel: 'noreferrer', style: { color: ACCENT, fontSize: 12 } }, '下载预览图')))
                    : null,
                  h('div', { style: { ...ui.grid } },
                    (project.finals ?? []).map((file) => h('div', { key: file, style: ui.col },
                      h('a', { href: mediaUrl(project.id, `final/${file}`), target: '_blank', rel: 'noreferrer' },
                        h('img', { src: mediaUrl(project.id, `final/${file}`), style: ui.thumb })),
                      h('span', { style: { ...ui.mono, fontSize: 10.5, opacity: 0.7, wordBreak: 'break-all' } }, file)))))
              : h('div', { style: { ...ui.card, opacity: 0.6 } }, '成片还没导出。生成完成后点上面的导出按钮。'),

            (project.notes ?? []).length > 0
              ? h('div', { style: { ...ui.card } },
                  h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '交付说明'),
                  (project.notes ?? []).map((note, index) => h('div', { key: index, style: { ...ui.hint, opacity: 0.8 } }, `· ${note}`)))
              : null) : null))
    }

    /* ------------------------------------------------------------- panel */

    function Panel() {
      const [state, setState] = useState(null)
      const [project, setProject] = useState(null)
      const [selectedId, setSelectedId] = useState('')
      const [tab, setTab] = useState('base')
      const [view, setView] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [form, setForm] = useState({ character: '', series: '', useModel: true, file: null, details: null })
      const [picks, setPicks] = useState([])
      const fileRef = useRef(null)

      // null = follow the environment: a ready install opens on the workbench,
      // anything else opens on the install page. Picking a tab pins the view.
      const applyState = useCallback((next) => {
        setState(next)
      }, [])

      const load = useCallback(async () => {
        try {
          const next = await api('/state')
          applyState(next)
        } catch (error_) {
          setError(errText(error_))
        }
      }, [applyState])

      useEffect(() => {
        void load()
        const interval = setInterval(() => {
          void load()
        }, (state?.queue?.running || state?.deployment?.busy) ? 1800 : 6000)
        return () => clearInterval(interval)
      }, [load, state?.queue?.running, state?.deployment?.busy])

      useEffect(() => {
        if (selectedId === '') {
          setProject(null)
          return
        }
        let alive = true
        api(`/project?id=${encodeURIComponent(selectedId)}`)
          .then((data) => {
            if (alive) setProject(data.project)
          })
          .catch((error_) => setError(errText(error_)))
        return () => {
          alive = false
        }
      }, [selectedId, state?.queue?.done, state?.queue?.running, state?.queue?.lastResult])

      // Refresh the open project whenever the queue finishes something.
      useEffect(() => {
        if (selectedId !== '' && !state?.queue?.running) {
          api(`/project?id=${encodeURIComponent(selectedId)}`)
            .then((data) => setProject(data.project))
            .catch(() => {})
        }
      }, [state?.queue?.running, state?.queue?.done, state?.queue?.lastResult])

      // Pinning only happens for a known state: before the first /state reply the
      // view stays automatic, so a ready install opens on the workbench.
      useEffect(() => {
        if (state !== null && !state.config?.consented) setView('install')
      }, [state?.config?.consented])

      const run = useCallback(async (fn) => {
        setBusy(true)
        setError('')
        try {
          await fn()
        } catch (error_) {
          setError(errText(error_))
        } finally {
          setBusy(false)
        }
      }, [])

      const actions = useMemo(() => ({
        reportError: (message) => setError(String(message)),
        consent: () => run(async () => {
          await api('/consent', { accepted: true })
          await load()
        }),
        consentDeploy: () => run(async () => {
          await api('/consent', { accepted: true })
          await api('/deploy', {})
          await load()
          setView('install')
        }),
        deploy: () => run(async () => {
          await api('/deploy', {})
          await load()
        }),
        startComfy: () => run(async () => {
          await api('/comfy/start', {})
          await load()
        }),
        stopComfy: () => run(async () => {
          await api('/comfy/stop', {})
          await load()
        }),
        detect: () => run(async () => {
          await api('/detect', {})
          await load()
        }),
        clearAndReload: () => run(async () => {
          await api('/log')
          await load()
        }),
        saveConfig: async (body) => {
          await api('/config', body)
          await load()
        },
        createProject: async () => {
          const character = form.character.trim()
          if (character === '') throw new Error('请输入角色名')
          const data = await api('/project/create', {
            character,
            series: form.series.trim(),
            useModel: form.useModel,
            details: form.details ?? null,
            source: form.file ? 'image' : (form.details ? 'recommend' : 'name'),
          })
          let created = data.project
          if (form.file !== null) {
            const dataUrl = await new Promise((resolvePromise, rejectPromise) => {
              const reader = new FileReader()
              reader.onload = () => resolvePromise(String(reader.result))
              reader.onerror = () => rejectPromise(new Error('读取参考图失败'))
              reader.readAsDataURL(form.file)
            })
            await api('/project/reference', { id: created.id, dataUrl })
            created = (await api(`/project?id=${encodeURIComponent(created.id)}`)).project
          }
          setForm({ character: '', series: '', useModel: form.useModel, file: null, details: null })
          if (fileRef.current) fileRef.current.value = ''
          setSelectedId(created.id)
          setProject(created)
          setTab('base')
          setView('studio')
          await load()
        },
        openProject: (id) => {
          setSelectedId(id)
          setTab('base')
          setView('studio')
        },
        updateProject: async (id, patch) => {
          const data = await api('/project/update', { id, ...patch })
          setProject(data.project)
          await load()
        },
        copyCard: async (text) => {
          try {
            await navigator.clipboard.writeText(String(text ?? ''))
          } catch {
            setError('浏览器拒绝了剪贴板访问')
          }
        },
        base: (id, count, useReference) => run(async () => {
          await api('/project/base', { id, count, useReference })
          await load()
        }),
        script: (id, count) => run(async () => {
          const data = await api('/project/script', { id, count })
          setProject(data.project)
          await load()
        }),
        generate: (id) => run(async () => {
          await api('/project/generate', { id })
          await load()
        }),
        finalize: (id) => run(async () => {
          await api('/project/finalize', { id })
          await load()
        }),
        cancelQueue: () => run(async () => {
          await api('/queue', {})
          await load()
        }),
      }), [form, load, run])

      const consented = state?.config?.consented === true
      const deployment = state?.deployment ?? {}
      const ready = deployment.status === 'ready'
      const queue = state?.queue ?? {}
      const env = state?.env ?? {}
      const activeView = view ?? (ready ? 'studio' : 'install')

      const pickFile = () => fileRef.current?.click()

      return h('div', { style: ui.root },
        h('div', { style: ui.header },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            h('div', {
              style: {
                width: 26, height: 26, borderRadius: 8, background: ACCENT, color: '#fff',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none',
              },
            }, h(SidebarIcon, { size: 15 })),
            h('div', null,
              h('div', { style: ui.title }, 'Cosplay Studio'),
              h('div', { style: ui.sub }, `角色名 / 参考图 → 真人 cosplay 套图 · ${ready ? 'ComfyUI 就绪' : env.comfyFound ? 'ComfyUI 待启动' : '未部署'}`))),
          h('span', { style: { flex: 1 } }),
          consented
            ? ['studio', 'install'].map((key) => h('div', {
                key,
                style: ui.tab(activeView === key),
                onClick: () => setView(key),
              }, key === 'studio' ? '工作台' : '安装与设置'))
            : null,
          h(Btn, { onClick: () => { void load() }, disabled: busy, title: '刷新状态' }, '刷新')),

        error !== ''
          ? h('div', {
              style: {
                margin: '0 18px', marginTop: 10, padding: '7px 10px', borderRadius: 8, fontSize: 12,
                background: 'rgba(255,69,58,0.12)', border: '1px solid rgba(255,69,58,0.35)', color: '#ff6b6b',
                display: 'flex', gap: 8, alignItems: 'flex-start',
              },
            },
              h('span', { style: { flex: 1 } }, error),
              h(Btn, { onClick: () => setError(''), style: { padding: '1px 7px', fontSize: 11 } }, '关闭'))
          : null,

        state === null
          ? h('div', { style: { ...ui.scroll, opacity: 0.6 } }, '正在读取插件状态…')
          : !consented
            ? h(ConsentView, { state, onConsent: actions.consent, onConsentDeploy: actions.consentDeploy, busy })
            : activeView === 'install'
              ? h(DeployView, { state, actions, busy })
              : h('div', { style: ui.body },
                  h('div', {
                    style: {
                      width: 250, flex: 'none', borderRight: '1px solid rgba(128,128,128,0.2)',
                      display: 'flex', flexDirection: 'column', minHeight: 0,
                    },
                  },
                    h('div', { style: { padding: '12px 12px 8px', flex: 'none' } },
                      h('div', { style: { ...ui.label, marginBottom: 6 } }, '新建角色'),
                      h('input', {
                        value: form.character,
                        placeholder: '角色名，例如 2B / 雷电将军',
                        onChange: (event) => setForm({ ...form, character: event.target.value, details: null }),
                        style: { ...ui.input, marginBottom: 6 },
                      }),
                      h('input', {
                        value: form.series,
                        placeholder: '作品名（可选）',
                        onChange: (event) => setForm({ ...form, series: event.target.value }),
                        style: { ...ui.input, marginBottom: 6 },
                      }),
                      h('div', { style: ui.row },
                        h(Btn, { onClick: pickFile, style: { flex: 1 } }, form.file ? '换参考图' : '上传参考图'),
                        form.file ? h(Btn, { onClick: () => { setForm({ ...form, file: null }); if (fileRef.current) fileRef.current.value = '' } }, '×') : null),
                      h('input', {
                        ref: fileRef, type: 'file', accept: 'image/png,image/jpeg,image/webp',
                        style: { display: 'none' },
                        onChange: (event) => setForm({ ...form, file: event.target.files?.[0] ?? null }),
                      }),
                      form.file
                        ? h('div', { style: { ...ui.hint, marginTop: 4, wordBreak: 'break-all' } }, `已选：${form.file.name}`)
                        : null,
                      h('label', { style: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 8, fontSize: 11.5, cursor: 'pointer', opacity: state.config?.llm?.hasKey && state.config?.llm?.model ? 1 : 0.55 } },
                        h('input', {
                          type: 'checkbox', checked: form.useModel,
                          onChange: (event) => setForm({ ...form, useModel: event.target.checked }),
                        }),
                        '用对话模型补全角色特征'),
                      h(Btn, {
                        kind: 'primary', disabled: busy,
                        style: { width: '100%', marginTop: 8 },
                        onClick: () => run(async () => { await actions.createProject() }),
                      }, '创建项目'),
                      h('div', { style: { marginTop: 12, paddingTop: 10, borderTop: '1px dashed rgba(128,128,128,0.25)' } },
                        h('div', { style: { ...ui.hint, marginBottom: 6, lineHeight: 1.5 } },
                          '没有想好做谁？让插件从热门角色里随机挑几个。'),
                        h(Btn, {
                          disabled: busy,
                          style: { width: '100%' },
                          onClick: () => run(async () => {
                            const data = await api('/recommend', { count: 3 })
                            setPicks(data.picks ?? [])
                          }),
                        }, picks.length > 0 ? '换一批热门推荐' : '随机推荐 3 个热门角色'),
                        ...picks.map((pick) => h('div', {
                          key: pick.character,
                          style: {
                            marginTop: 8, padding: '8px 9px', borderRadius: 8,
                            background: 'rgba(124,92,255,0.10)', border: '1px solid rgba(124,92,255,0.25)',
                          },
                        },
                          h('div', { style: { fontSize: 12.5, fontWeight: 600, lineHeight: 1.4 } },
                            `${pick.character}${pick.series ? ` · ${pick.series}` : ''}`),
                          pick.hook
                            ? h('div', { style: { ...ui.hint, marginTop: 3, lineHeight: 1.5 } }, pick.hook)
                            : null,
                          h('div', { style: { ...ui.row, marginTop: 6 } },
                            h(Btn, {
                              kind: 'primary',
                              style: { flex: 1, padding: '4px 9px', fontSize: 11.5 },
                              onClick: () => setForm({
                                character: pick.character,
                                series: pick.series ?? '',
                                useModel: form.useModel,
                                file: null,
                                details: pick.details ?? null,
                              }),
                            }, '用这个角色')))))),
                    h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 12px 16px' } },
                      (state.projects ?? []).length === 0
                        ? h('div', { style: { ...ui.hint, opacity: 0.5, padding: '8px 2px' } }, '还没有项目。')
                        : (state.projects ?? []).map((item) => h('div', {
                            key: item.id,
                            onClick: () => actions.openProject(item.id),
                            style: {
                              padding: '8px 10px', borderRadius: 8, cursor: 'pointer', marginBottom: 6,
                              border: '1px solid ' + (selectedId === item.id ? ACCENT : 'transparent'),
                              background: selectedId === item.id ? 'rgba(124,92,255,0.12)' : 'rgba(128,128,128,0.06)',
                            },
                          },
                            h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                              h('span', { style: { fontSize: 12.5, fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.character),
                              h(StatusChip, { status: item.status })),
                            h('div', { style: { ...ui.hint, fontSize: 10.5, marginTop: 3 } },
                              `基准 ${item.baseCount} · 成片 ${item.finalCount}`))))),

                  h(ProjectView, { state, project, actions: { ...actions, reportError: (message) => setError(String(message)) }, busy, tab, setTab })),

        queue.running || queue.pending > 0
          ? h('div', {
              style: {
                flex: 'none', padding: '8px 18px 10px', borderTop: '1px solid rgba(128,128,128,0.22)',
                background: 'rgba(124,92,255,0.06)',
              },
            },
              h(Progress, { value: queue.total > 0 ? queue.done / queue.total : 0, label: queue.label || '生成中' }),
              queue.lastError ? h('div', { style: { ...ui.hint, color: '#ff6b6b', marginTop: 4 } }, queue.lastError) : null)
          : null)
    }

    /* ------------------------------------------------------ settings card */

    // Settings is the durable entry point: it always exists, even when the
    // sidebar icon is hidden, and it can open the main panel on demand.
    function SettingsCard({ ctx, onToggleSidebar }) {
      const [state, setState] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')

      const load = useCallback(async () => {
        try {
          setState(await api('/state'))
        } catch (error_) {
          setError(errText(error_))
        }
      }, [])

      useEffect(() => {
        void load()
        const interval = setInterval(() => { void load() }, 8000)
        return () => clearInterval(interval)
      }, [load])

      const run = useCallback(async (fn, ok) => {
        setBusy(true)
        setError('')
        setNotice('')
        try {
          await fn()
          if (ok) setNotice(ok)
          await load()
        } catch (error_) {
          setError(errText(error_))
        } finally {
          setBusy(false)
        }
      }, [load])

      const openStudio = () => {
        try {
          const layout = ctx?.layout
          if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(PANEL_ID)
          else setNotice('当前宿主不支持从设置跳转，请用侧边栏入口打开。')
        } catch (error_) {
          setError(`打开工作台失败：${errText(error_)}`)
        }
      }

      const config = state?.config ?? {}
      const deployment = state?.deployment ?? {}
      const env = state?.env ?? {}
      const showSidebar = config.showSidebar !== false
      const bodyMakeup = config.bodyMakeup !== false
      const ready = deployment.status === 'ready'

      return h('div', { style: { padding: '14px 16px', maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 12 } },
        h('div', { style: ui.row },
          h('div', { style: { flex: 1, minWidth: 200 } },
            h('div', { style: { fontSize: 14.5, fontWeight: 650 } }, 'Cosplay Studio'),
            h('div', { style: { ...ui.hint, marginTop: 3, lineHeight: 1.5 } },
              '输入角色名或上传参考图，在本机 ComfyUI 生成真人 cosplay 套图。')),
          h(StatusChip, { status: ready ? 'done' : (env.comfyFound ? 'awaiting-script-approval' : 'failed') })),

        h('div', { style: ui.row },
          h(Btn, { kind: 'primary', onClick: openStudio, disabled: busy }, '打开工作台'),
          h(Btn, {
            disabled: busy,
            onClick: () => run(async () => { await api('/detect', {}) }, '已重新检测运行环境'),
          }, '重新检测'),
          h(Btn, {
            disabled: busy || !env.comfyFound,
            onClick: () => run(async () => {
              await api(env.running ? '/comfy/stop' : '/comfy/start', {})
            }, env.running ? '已请求停止 ComfyUI' : '已请求启动 ComfyUI'),
          }, env.running ? '停止 ComfyUI' : '启动 ComfyUI')),

        h('div', { style: ui.card },
          h('label', { style: { display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' } },
            h('input', {
              type: 'checkbox', checked: showSidebar, disabled: busy,
              onChange: (event) => {
                const next = event.target.checked
                void run(async () => {
                  await api('/config', { showSidebar: next })
                  onToggleSidebar?.(next)
                }, next ? '侧边栏入口已显示' : '侧边栏入口已隐藏，仍可从设置这里打开')
              },
              style: { marginTop: 2 },
            }),
            h('span', { style: { fontSize: 12.5, lineHeight: 1.6 } },
              h('span', { style: { fontWeight: 600 } }, '在侧边栏显示「Cosplay 工作台」'),
              h('br'),
              h('span', { style: { ...ui.hint } },
                '取消勾选后侧边栏图标会消失，用上面「打开工作台」仍可进入。')))),

        h('div', { style: ui.card },
          h('label', { style: { display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' } },
            h('input', {
              type: 'checkbox', checked: bodyMakeup, disabled: busy,
              onChange: (event) => {
                const next = event.target.checked
                void run(async () => { await api('/config', { bodyMakeup: next }) },
                  next ? '已开启 P7b 身体化妆' : '已关闭 P7b 身体化妆')
              },
              style: { marginTop: 2 },
            }),
            h('span', { style: { fontSize: 12.5, lineHeight: 1.6 } },
              h('span', { style: { fontWeight: 600 } }, '成片自动做身体化妆（P7b）'),
              h('br'),
              h('span', { style: { ...ui.hint } },
                `导出时统一脸到脚的肤色，腿脚强度 ${config.legStrength ?? 0.85}。关掉后只做去油光。`)))),

        h('div', { style: ui.card },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '运行环境'),
          ...[
            ['ComfyUI', env.comfyFound ? (env.comfyDir ?? '已找到') : '未找到'],
            ['服务', env.running ? `运行中（:${env.port ?? 8188}）` : '未运行'],
            ['显卡', env.gpu ?? '未知'],
            ['模型', (env.missingModels ?? []).length === 0 ? '齐全' : `缺少 ${(env.missingModels ?? []).length} 个`],
            ['数据目录', state?.paths?.dataDir ?? ''],
          ].map(([key, value]) => h('div', { key, style: { display: 'flex', gap: 10, fontSize: 12, marginTop: 4 } },
            h('span', { style: { width: 76, opacity: 0.6, flex: 'none' } }, key),
            h('span', { style: { wordBreak: 'break-all', opacity: 0.85 } }, String(value))))),

        error !== '' ? h('div', { style: { fontSize: 12, color: '#ff6b6b' } }, error) : null,
        notice !== '' ? h('div', { style: { fontSize: 12, color: '#3ecf8e' } }, notice) : null)
    }

    /* ------------------------------------------------------------ export */

    function apply(ctx) {
      const disposers = []
      let sidebarDispose = null

      const mountSidebar = () => {
        if (sidebarDispose !== null) return
        sidebarDispose = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 6,
          label: () => 'Cosplay 工作台',
        }, (props) => h(SidebarIcon, props?.size ? props : undefined)))
        disposers.push(sidebarDispose)
      }

      const unmountSidebar = () => {
        if (sidebarDispose === null) return
        try {
          sidebarDispose()
        } catch {
          // ignore
        }
        const index = disposers.indexOf(sidebarDispose)
        if (index >= 0) disposers.splice(index, 1)
        sidebarDispose = null
      }

      let sidebarShown = null
      const setSidebar = (show) => {
        const next = show !== false
        if (next === sidebarShown) return
        sidebarShown = next
        if (next) mountSidebar()
        else unmountSidebar()
      }

      // The main panel stays registered whether or not the sidebar icon is
      // visible, so "打开工作台" in settings keeps working after hiding it.
      setSidebar(true)
      disposers.push(ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        inject: () => ({}),
      }, () => h(Panel, {}))))

      disposers.push(ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: PANEL_ID,
        order: 24,
        label: () => 'Cosplay Studio',
      }, () => h(SettingsCard, { ctx, onToggleSidebar: setSidebar }))))

      // Read the persisted preference once; failures (host not ready yet) keep
      // the default of a visible sidebar icon.
      api('/state')
        .then((snapshot) => setSidebar(snapshot?.config?.showSidebar !== false))
        .catch(() => {})

      return async () => {
        for (const dispose of disposers.reverse()) {
          try {
            dispose()
          } catch {
            // ignore
          }
        }
      }
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
