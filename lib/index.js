// Cosplay Studio 2.0 — host half.
//
// Responsibilities:
//   1. the first-run tutorial + consent gate and the ComfyUI deployment
//      (detect → install portable build → fetch models → start → self-test);
//   2. character card + shot script generation (LLM when configured);
//   3. a sequential generation queue over the local ComfyUI HTTP API;
//   4. post-processing (de-oil / JPEG cap / 2×2 preview / delivery copy);
//   5. the JSON API the browser half talks to, plus project media serving.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import {
  API_PREFIX, MEDIA_PREFIX, PROJECTS_DIR, dshHome, logLine, patchConfig, readConfig, setupLog, clearLog,
} from './paths.js'
import {
  comfyPid, comfyStats, detectComfyDir, downloadModel, findComfyPortableAsset, installComfyPortable,
  modelStatus, resolveComfyLayout, selfTest, startComfy, stopComfy, waitForComfy,
} from './comfy.js'
import {
  SCRIPT_SYSTEM, buildCard, chatComplete, defaultDetails, llmConfigured, normalizeShotItems, researchCharacter,
  ruleScript, scriptUserText, shotPrompt, writeScript,
} from './card.js'
import {
  cancelQueue, createProject, enqueueBase, enqueueEdit, enqueueFinalize, enqueueShots,
  listProjects, projectDirs, queueSnapshot, readProject, saveProject, updateProject,
} from './project.js'
import { recommend } from './hot.js'
import { createRandomProject, llmText, parseJson, researchState, startResearch } from './research.js'

const inject = ['webServer']

const API = {
  state: `${API_PREFIX}/state`,
  consent: `${API_PREFIX}/consent`,
  config: `${API_PREFIX}/config`,
  detect: `${API_PREFIX}/detect`,
  deploy: `${API_PREFIX}/deploy`,
  log: `${API_PREFIX}/log`,
  start: `${API_PREFIX}/comfy/start`,
  stop: `${API_PREFIX}/comfy/stop`,
  projects: `${API_PREFIX}/projects`,
  project: `${API_PREFIX}/project`,
  recommend: `${API_PREFIX}/recommend`,
  create: `${API_PREFIX}/project/create`,
  update: `${API_PREFIX}/project/update`,
  reference: `${API_PREFIX}/project/reference`,
  base: `${API_PREFIX}/project/base`,
  baseEdit: `${API_PREFIX}/project/base/edit`,
  shotEdit: `${API_PREFIX}/project/shot/edit`,
  restoreShot: `${API_PREFIX}/project/shot/restore`,
  script: `${API_PREFIX}/project/script`,
  scriptAdd: `${API_PREFIX}/project/script/add`,
  generate: `${API_PREFIX}/project/generate`,
  finalize: `${API_PREFIX}/project/finalize`,
  queue: `${API_PREFIX}/queue`,
  openFolder: `${API_PREFIX}/project/open-folder`,
  research: `${API_PREFIX}/project/research`,
  random: `${API_PREFIX}/project/random`,
}

const TUTORIAL = [
  {
    title: '① 这个插件做什么',
    body: 'Cosplay Studio 把「角色名 / 参考图 → 真人 cosplay 套图」整条流程装进一个面板：角色卡 → 基准图确认 → 镜头脚本确认 → 1440×2560 成片 → 质检与导出。所有出图都在你本机的 ComfyUI 上跑，不上传任何图片到云端。',
  },
  {
    title: '② 部署会装什么',
    body: '如果没有找到已安装的 ComfyUI，插件会下载 ComfyUI Windows 便携版（约 1.4–1.8 GB）并解压；然后补齐三个模型文件：UNET（z_image_turbo_int8_convrot）、文本编码器（qwen_3_4b_fp8_mixed，lumina2 类型）、VAE（ae）。模型来自公开镜像，合计约 8–10 GB，请预留 15 GB 以上磁盘。',
  },
  {
    title: '③ 部署后会自动调试什么',
    body: '启动服务 → 检查 /system_stats → 用真实工作流跑一张 640×1152 的测试图（约 15–30 秒），确认模型能加载、采样器能出图、图片能取回。三项全部通过才会标记为「就绪」。',
  },
  {
    title: '④ 硬件与时间',
    body: 'NVIDIA 显卡显存 ≥ 8 GB（6 GB 也可以跑 1152 宽，但 1440×2560 可能 OOM）。本机实测：1152×2048 约 75 秒/张，1440×2560 约 230 秒/张，一套 6 镜大约 20–30 分钟。',
  },
  {
    title: '⑤ 出图流程与两道闸门',
    body: '先用角色卡出一张基准图，你确认人物/服装/背景之后才会继续；接着生成 4–6 镜脚本给你确认；确认后才批量出成片。两道闸门都在面板里，不会偷偷跑完。',
  },
  {
    title: '⑥ 内容边界',
    body: '角色一律 18 岁成人设定，画面是穿着完整 cosplay 服装的肖像照，不含露骨或成人内容。若你上传的参考图涉及版权角色，请自行确认使用范围。',
  },
]

const deployment = {
  status: 'idle', // idle | running | ready | failed
  step: '',
  progress: 0,
  message: '',
  startedAt: '',
  finishedAt: '',
  selfTest: null,
}

let deploying = false
let serverStarted = ''

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

function readBody(request, limit = 16 * 1024 * 1024) {
  return new Promise((resolvePromise) => {
    const chunks = []
    let bytes = 0
    let aborted = false
    request.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > limit) {
        aborted = true
        chunks.length = 0
        return
      }
      if (!aborted) chunks.push(buffer)
    })
    request.on('end', () => {
      if (aborted) return resolvePromise(null)
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        const parsed = JSON.parse(raw)
        resolvePromise(parsed !== null && typeof parsed === 'object' ? parsed : null)
      } catch {
        resolvePromise(null)
      }
    })
    request.on('error', () => resolvePromise(null))
  })
}

function publicConfig(config) {
  return {
    consented: config.consented,
    comfyDir: config.comfyDir,
    comfyPort: config.comfyPort,
    autoStart: config.autoStart,
    autoDownloadModels: config.autoDownloadModels !== false,
    models: { ...config.models, clipType: config.models.clipType },
    llm: { baseUrl: config.llm.baseUrl, model: config.llm.model, hasKey: String(config.llm.apiKey ?? '') !== '' },
    outputRoot: config.outputRoot,
    shotCount: config.shotCount,
    bodyMakeup: config.bodyMakeup !== false,
    deoil: config.deoil !== false,
    makeupStrength: config.makeupStrength ?? 0.35,
    legStrength: config.legStrength ?? 0.85,
    showSidebar: config.showSidebar !== false,
  }
}

/* --------------------------------------------------------------- deploy */

function setStep(step, progress, message = '') {
  deployment.step = step
  deployment.progress = progress
  if (message !== '') deployment.message = message
  logLine(`【${step}】${message}`)
}

const MODEL_SLOTS = [
  { key: 'unet', dir: 'diffusion_models', file: 'unetFile', url: 'unetUrl' },
  { key: 'clip', dir: 'text_encoders', file: 'clipFile', url: 'clipUrl' },
  { key: 'vae', dir: 'vae', file: 'vaeFile', url: 'vaeUrl' },
]

async function ensureModels(config, layout) {
  const modelsDir = layout.models
  if (!existsSync(modelsDir)) throw new Error(`ComfyUI 的 models 目录不存在：${modelsDir}`)
  const status = modelStatus(config, layout)
  const missing = MODEL_SLOTS.filter((slot) => status[slot.key] === '')
  if (missing.length === 0) return status
  const names = missing.map((slot) => config.models[slot.file]).join('、')
  if (config.autoDownloadModels === false) {
    throw new Error(`缺少模型：${names}。关闭了自动下载，请手动放进 ${modelsDir} 后重试。`)
  }
  for (const slot of missing) {
    const targetDir = join(modelsDir, slot.dir)
    mkdirSync(targetDir, { recursive: true })
    const dest = join(targetDir, config.models[slot.file])
    const url = String(config.models[slot.url] ?? '')
    if (url === '') throw new Error(`模型 ${config.models[slot.file]} 缺少下载地址，请手动放置。`)
    setStep('下载模型', deployment.progress, `下载 ${config.models[slot.file]}`)
    logLine(`下载源：${url}`)
    await downloadModel(url, dest, (received, total) => {
      if (total > 0) {
        const pct = Math.round((received / total) * 100)
        deployment.message = `下载 ${config.models[slot.file]} ${pct}%（${Math.round(received / 1048576)} / ${Math.round(total / 1048576)} MB）`
      }
    })
    logLine(`完成：${dest}`)
  }
  return modelStatus(config, layout)
}

async function runDeploy() {
  deploying = true
  deployment.status = 'running'
  deployment.startedAt = new Date().toISOString()
  deployment.finishedAt = ''
  deployment.progress = 0.02
  clearLog()
  logLine('Cosplay Studio 部署开始')
  try {
    let config = readConfig()
    setStep('定位 ComfyUI', 0.05, '查找已安装的 ComfyUI')
    let { layout, tried } = detectComfyDir(config)
    if (layout !== null) {
      logLine(`复用已安装的 ComfyUI：${layout.cwd}`)
    } else {
      logLine(`没有找到已安装的 ComfyUI（尝试过：${tried.slice(0, 4).join('；')}）`)
      setStep('安装 ComfyUI', 0.12, '下载并解压 ComfyUI 便携版（约 1.5 GB）')
      layout = await installComfyPortable(logLine)
      config = patchConfig({ comfyDir: layout.cwd })
    }
    config = patchConfig({ comfyDir: layout.cwd, pythonExe: layout.python })

    setStep('检查模型', 0.5, '核对 UNET / 文本编码器 / VAE')
    await ensureModels(config, layout)
    setStep('启动 ComfyUI', 0.62, '等待 /system_stats 就绪')
    const running = await comfyStats(config.comfyPort)
    if (running === null) {
      const started = await startComfy(layout, config.comfyPort, config.pythonExe, logLine)
      serverStarted = String(started.pid ?? '')
    } else {
      logLine('ComfyUI 已经在运行，直接复用')
    }
    setStep('自检', 0.78, '跑一张测试图验证整条链路')
    const result = await selfTest(config, layout, logLine)
    deployment.selfTest = result
    deployment.status = 'ready'
    deployment.progress = 1
    deployment.message = '部署完成，自检通过'
    deployment.finishedAt = new Date().toISOString()
    logLine(`部署完成：自检 ${result.elapsedSeconds} 秒出图`)
    return { ok: true, selfTest: result, comfyDir: layout.cwd, python: layout.python }
  } catch (error) {
    deployment.status = 'failed'
    deployment.message = error?.message ?? String(error)
    deployment.finishedAt = new Date().toISOString()
    logLine(`部署失败：${deployment.message}`, 'error')
    return { ok: false, error: deployment.message }
  } finally {
    deploying = false
  }
}

/* ------------------------------------------------------------ env state */

async function envSnapshot(config) {
  const { layout } = detectComfyDir(config)
  const stats = await comfyStats(config.comfyPort, 1200)
  const models = layout === null
    ? { modelsDir: '', unet: '', clip: '', vae: '', scanned: 0 }
    : modelStatus(config, layout)
  return {
    comfyFound: layout !== null,
    comfyDir: layout?.cwd ?? '',
    python: layout?.python ?? '',
    portable: layout?.portable ?? false,
    running: stats !== null,
    gpu: stats?.devices?.[0]?.name ?? '',
    vram: stats?.devices?.[0]?.vram_total ?? 0,
    models,
    missingModels: MODEL_SLOTS.filter((slot) => models[slot.key] === '').map((slot) => config.models[slot.file]),
    pid: comfyPid(config.comfyPort) || Number(serverStarted || 0),
  }
}

/* ------------------------------------------------------------- projects */

function referenceSave(id, body) {
  const dataUrl = String(body.dataUrl ?? '')
  const match = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i.exec(dataUrl)
  if (match === null) throw new Error('参考图格式不支持，请上传 PNG / JPEG / WebP')
  const buffer = Buffer.from(match[2], 'base64')
  if (buffer.length > 12 * 1024 * 1024) throw new Error('参考图不能超过 12 MB')
  const ext = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase()
  const dirs = projectDirs(id)
  const name = `ref_${Date.now()}.${ext}`
  writeFileSync(join(dirs.refs, name), buffer)
  return name
}

function applyShots(id, shots) {
  const project = readProject(id)
  if (project === null) throw new Error('项目不存在')
  const normalized = (Array.isArray(shots) ? shots : []).slice(0, 10).map((shot, index) => ({
    id: index + 1,
    type: String(shot.type ?? 'A'),
    title: String(shot.title ?? `镜头 ${index + 1}`),
    situation: String(shot.situation ?? ''),
    expression: String(shot.expression ?? ''),
    pose: String(shot.pose ?? ''),
    hands: String(shot.hands ?? ''),
    camera: String(shot.camera ?? ''),
    props: String(shot.props ?? 'no props'),
    prompt: `${shot.type ?? 'A'}｜${shot.title ?? `镜头 ${index + 1}`}`,
  }))
  return updateProject(id, { shots: normalized })
}

function mediaTypeOfName(name) {
  const lower = String(name).toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.webp')) return 'image/webp'
  return 'image/jpeg'
}

/** Script model path: configured chat endpoint first, then the DSH host model,
 *  then the built-in templates. Keeps existing shots for smart additions. */
async function generateShotList(ctx, project, count, existing = []) {
  const config = readConfig()
  const user = scriptUserText(project.details, count, existing)
  const startIndex = existing.length + 1
  if (llmConfigured(config)) {
    try {
      const text = await chatComplete(config, SCRIPT_SYSTEM, user)
      const parsed = parseJson(text)
      const list = Array.isArray(parsed) ? parsed : parsed?.shots
      return { shots: normalizeShotItems(list, startIndex), note: '镜头脚本由脚本模型生成' }
    } catch {
      // fall through to the host model
    }
  }
  try {
    let lastError = null
    for (const maxTokens of [9000, 12000]) {
      try {
        const text = await llmText(ctx, `${SCRIPT_SYSTEM}\n\n${user}\n\n只输出 JSON 数组，不要输出任何思考过程或解释。`, { maxTokens })
        const parsed = parseJson(text)
        const list = Array.isArray(parsed) ? parsed : parsed?.shots
        return { shots: normalizeShotItems(list, startIndex), note: '镜头脚本由 DSH 模型生成' }
      } catch (error) {
        lastError = error
      }
    }
    throw lastError ?? new Error('脚本模型没有返回内容')
  } catch (error) {
    return { shots: ruleScript(project.details, Math.max(1, Math.min(6, count))), note: `内置脚本模板（${error?.message ?? error}）` }
  }
}

/** Smart edit: compare the picture with the reference / approved base, let the
 *  vision model name the flaws and produce one English img2img instruction. */
async function smartEditInstruction(ctx, project, target, file, note = '') {
  const dirs = projectDirs(project.id)
  const images = []
  const add = (folder, name) => {
    if (name === '') return
    const path = join(folder, name)
    if (!existsSync(path) || images.some((image) => image.name === name)) return
    images.push({ data: readFileSync(path), mediaType: mediaTypeOfName(name), name })
  }
  add(target === 'base' ? dirs.base : dirs.raw, file)
  add(dirs.refs, String(project.referenceFile ?? ''))
  add(dirs.base, String(project.approvedBase ?? ''))
  const ask = note === ''
    ? '没有额外要求，请自行找出最需要修的瑕疵（手、脚、五官、服装边缘、穿模）'
    : `用户的修改要求：${note}`
  const prompt = `你在为一套真人 cosplay 照片做精修指导，只输出 JSON。\n\n角色设定（英文）：\n${String(project.card ?? '').slice(0, 1800)}\n\n${ask}\n\n请比对图片：第一张是待修改的图片${images.length > 1 ? '，后面的图片是该角色的参考图 / 已确认基准图' : ''}。找出需要修的 1-4 处具体问题，并给出一句可直接用于 img2img 重绘的英文编辑指令：只描述要改的局部，明确保持同一人物、同一姿势、同一机位、同一服装与背景不变；优先修手、脚、五官和衣物边缘这类细节。\n\n只输出：{"issues":["中文问题1","中文问题2"],"fix":"one English editing instruction"}`
  let lastError = null
  for (const maxTokens of [4000, 6000]) {
    try {
      const text = await llmText(ctx, `${prompt}\n\n不要输出任何思考过程。`, { images, maxTokens })
      const parsed = parseJson(text)
      const issues = Array.isArray(parsed?.issues) ? parsed.issues.map((value) => String(value)).filter(Boolean).slice(0, 4) : []
      const fix = String(parsed?.fix ?? '').trim()
      if (fix === '') throw new Error('智能分析没有给出修改指令')
      return { issues, fix }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error('智能分析失败')
}

/* ----------------------------------------------------------------- apply */

export function apply(ctx) {
  const disposers = []
  const disposeAll = () => {
    while (disposers.length > 0) {
      const dispose = disposers.pop()
      try {
        dispose()
      } catch {
        // ignore
      }
    }
  }
  // The plugin loader ignores a plugin's return value, so binding cleanup to
  // the returned function alone leaks routes: a hot reload then fails with
  // "webserver: duplicate exact route ...". Bind it to the fiber instead.
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => disposeAll)
  } else if (typeof ctx.on === 'function') {
    ctx.on('dispose', disposeAll)
  }
  ctx.logger?.info?.('[cosplay-studio] host half loaded')

  const route = (path, handler) => {
    const dispose = ctx.webServer.register({ kind: 'exact', path, handler })
    disposers.push(dispose)
  }

  route(API.state, async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' })
      response.end()
      return
    }
    const config = readConfig()
    const env = await envSnapshot(config)
    const projects = listProjects().map((project) => ({
      id: project.id,
      character: project.character,
      series: project.series,
      status: project.status,
      source: project.source,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      finalCount: (project.finals ?? []).length,
      baseCount: (project.baseImages ?? []).length,
      research: project.research
        ? { status: project.research.status, stage: project.research.stage, stageLabel: project.research.stageLabel }
        : null,
    }))
    sendJson(response, 200, {
      ok: true,
      tutorial: TUTORIAL,
      consented: config.consented,
      config: publicConfig(config),
      deployment: {
        ...deployment,
        busy: deploying,
        log: setupLog().slice(-120),
      },
      env,
      queue: queueSnapshot(),
      projects,
      paths: { dataDir: join(dshHome(), 'data', 'dsh-cosplay-studio'), projectsDir: PROJECTS_DIR },
    })
  })

  route(API.consent, async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    const body = await readBody(request, 64 * 1024)
    if (body?.accepted !== true) {
      sendJson(response, 400, { ok: false, error: '需要勾选同意才能继续' })
      return
    }
    patchConfig({ consented: true, consentAt: new Date().toISOString() })
    sendJson(response, 200, { ok: true })
  })

  route(API.config, async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    const body = await readBody(request, 256 * 1024)
    if (body === null) {
      sendJson(response, 400, { ok: false, error: '请求体不是合法 JSON' })
      return
    }
    const patch = {}
    if (typeof body.comfyDir === 'string') patch.comfyDir = body.comfyDir.trim()
    if (Number.isInteger(body.comfyPort) && body.comfyPort > 1024 && body.comfyPort < 65536) patch.comfyPort = body.comfyPort
    if (typeof body.autoStart === 'boolean') patch.autoStart = body.autoStart
    if (typeof body.autoDownloadModels === 'boolean') patch.autoDownloadModels = body.autoDownloadModels
    if (typeof body.showSidebar === 'boolean') patch.showSidebar = body.showSidebar
    if (typeof body.deoil === 'boolean') patch.deoil = body.deoil
    if (typeof body.bodyMakeup === 'boolean') patch.bodyMakeup = body.bodyMakeup
    if (Number.isFinite(body.legStrength) && body.legStrength >= 0 && body.legStrength <= 1.2) patch.legStrength = body.legStrength
    if (Number.isFinite(body.makeupStrength) && body.makeupStrength >= 0 && body.makeupStrength <= 1) patch.makeupStrength = body.makeupStrength
    if (body.llm !== null && typeof body.llm === 'object') {
      patch.llm = {
        baseUrl: String(body.llm.baseUrl ?? '').trim(),
        model: String(body.llm.model ?? '').trim(),
        ...(typeof body.llm.apiKey === 'string' && body.llm.apiKey.trim() !== '' ? { apiKey: body.llm.apiKey.trim() } : {}),
      }
    }
    if (body.models !== null && typeof body.models === 'object') {
      patch.models = {
        unetFile: String(body.models.unetFile ?? '').trim(),
        clipFile: String(body.models.clipFile ?? '').trim(),
        clipType: String(body.models.clipType ?? 'lumina2').trim(),
        vaeFile: String(body.models.vaeFile ?? '').trim(),
      }
    }
    const config = patchConfig(patch)
    sendJson(response, 200, { ok: true, config: publicConfig(config) })
  })

  route(API.detect, async (request, response) => {
    const config = readConfig()
    const { layout, tried } = detectComfyDir(config)
    const models = layout === null ? null : modelStatus(config, layout)
    sendJson(response, 200, {
      ok: true,
      found: layout !== null,
      layout: layout === null ? null : { cwd: layout.cwd, python: layout.python, portable: layout.portable },
      models,
      tried,
    })
  })

  route(API.deploy, async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    const config = readConfig()
    if (!config.consented) {
      sendJson(response, 403, { ok: false, error: '请先阅读教程并勾选同意' })
      return
    }
    if (deploying) {
      sendJson(response, 409, { ok: false, error: '部署正在进行中' })
      return
    }
    void runDeploy()
    sendJson(response, 200, { ok: true, started: true })
  })

  route(API.log, async (request, response) => {
    sendJson(response, 200, { ok: true, log: setupLog().slice(-200), deployment })
  })

  route(API.start, async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    const config = readConfig()
    const { layout } = detectComfyDir(config)
    if (layout === null) {
      sendJson(response, 400, { ok: false, error: '没有找到 ComfyUI，请先部署' })
      return
    }
    try {
      if ((await comfyStats(config.comfyPort)) !== null) {
        sendJson(response, 200, { ok: true, already: true })
        return
      }
      const started = await startComfy(layout, config.comfyPort, config.pythonExe, logLine)
      serverStarted = String(started.pid ?? '')
      sendJson(response, 200, { ok: true, pid: started.pid })
    } catch (error) {
      sendJson(response, 500, { ok: false, error: error?.message ?? String(error) })
    }
  })

  route(API.stop, async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    const config = readConfig()
    const stopped = stopComfy(config.comfyPort)
    sendJson(response, 200, { ok: true, stopped })
  })

  route(API.projects, async (request, response) => {
    sendJson(response, 200, { ok: true, projects: listProjects() })
  })

  route(API.project, async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const id = url.searchParams.get('id') ?? ''
    const project = id === '' ? null : readProject(id)
    if (project === null) {
      sendJson(response, 404, { ok: false, error: '项目不存在' })
      return
    }
    // A host restart leaves research jobs marked running forever; normalise so
    // the panel shows "重新研究" instead of a spinner that never ends.
    const research = researchState(project)
    sendJson(response, 200, { ok: true, project: research === null ? project : { ...project, research } })
  })

  route(API.recommend, async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'POST') {
      response.writeHead(405, { allow: 'GET, HEAD, POST' })
      response.end()
      return
    }
    let count = 3
    if (request.method === 'POST') {
      const body = await readBody(request, 8 * 1024)
      if (Number.isInteger(body?.count)) count = body.count
    } else {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const raw = Number(url.searchParams.get('count'))
      if (Number.isInteger(raw) && raw > 0) count = raw
    }
    const config = readConfig()
    const picks = await recommend(config, Math.max(1, Math.min(6, count)))
    sendJson(response, 200, { ok: true, picks, model: llmConfigured(config) })
  })

  route(API.create, async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    const body = await readBody(request, 1024 * 1024)
    const character = String(body?.character ?? '').trim()
    if (character === '') {
      sendJson(response, 400, { ok: false, error: '请输入角色名' })
      return
    }
    const series = String(body?.series ?? '').trim()
    const source = String(body?.source ?? 'name')
    const config = readConfig()
    let details = body?.details !== null && typeof body?.details === 'object' ? { ...body.details } : null
    let note = ''
    if (details === null) {
      if (body?.useModel !== false && llmConfigured(config)) {
        try {
          details = await researchCharacter(config, { character, series, referencePath: body?.referenceFile ?? '' })
          note = '角色卡由脚本模型生成'
        } catch (error) {
          details = defaultDetails(character, series, { reference: source === 'image' })
          note = `脚本模型不可用（${error?.message ?? error}），已用内置模板`
        }
      } else {
        details = defaultDetails(character, series, { reference: source === 'image' })
        note = source === 'image'
          ? '参考图项目：人物外观以参考图为准，角色卡里的发型/服装/道具只是占位描述，可留空'
          : llmConfigured(config) ? '按内置模板生成角色卡' : '未配置脚本模型，角色卡用通用模板；想做得像请上传参考图'
      }
    }
    const project = createProject({ character, series, details, source: body?.source ?? 'name' })
    updateProject(project.id, { notes: [note] })
    // Name projects start the slow research right away (web search → pictures →
    // vision analysis → draft). Image projects start after the upload arrives.
    let researching = false
    if (body?.research !== false && source !== 'image') {
      try {
        startResearch(ctx, config, project.id)
        researching = true
      } catch (error) {
        updateProject(project.id, { notes: [note, `角色研究未能启动：${error?.message ?? error}`] })
      }
    }
    sendJson(response, 200, { ok: true, project: readProject(project.id), note, researching })
  })

  route(API.update, async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    const body = await readBody(request, 1024 * 1024)
    const id = String(body?.id ?? '')
    const project = readProject(id)
    if (project === null) {
      sendJson(response, 404, { ok: false, error: '项目不存在' })
      return
    }
    const patch = {}
    if (body?.details !== null && typeof body?.details === 'object') {
      patch.details = { ...project.details, ...body.details }
      patch.card = buildCard(patch.details)
      writeFileSync(join(PROJECTS_DIR, id, 'character_card.txt'), patch.card, 'utf8')
    }
    if (Array.isArray(body?.shots)) {
      applyShots(id, body.shots)
    }
    if (typeof body?.status === 'string') {
      patch.status = body.status
      // Remember which base the user approved: later shots are img2img from it.
      if (body.status === 'base-approved') {
        const bases = Array.isArray(project.baseImages) ? project.baseImages : []
        if (bases.length > 0) patch.approvedBase = bases[bases.length - 1]
      }
    }
    if (Object.keys(patch).length > 0) updateProject(id, patch)
    sendJson(response, 200, { ok: true, project: readProject(id) })
  })

  route(API.reference, async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    const body = await readBody(request, 20 * 1024 * 1024)
    const id = String(body?.id ?? '')
    if (readProject(id) === null) {
      sendJson(response, 404, { ok: false, error: '项目不存在' })
      return
    }
    try {
      const file = referenceSave(id, body)
      updateProject(id, { referenceFile: file })
      sendJson(response, 200, { ok: true, referenceFile: file })
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error?.message ?? String(error) })
    }
  })

  route(API.base, async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    const body = await readBody(request, 64 * 1024)
    const id = String(body?.id ?? '')
    const project = readProject(id)
    if (project === null) {
      sendJson(response, 404, { ok: false, error: '项目不存在' })
      return
    }
    const config = readConfig()
    const { layout } = detectComfyDir(config)
    if (layout === null || (await comfyStats(config.comfyPort)) === null) {
      sendJson(response, 409, { ok: false, error: 'ComfyUI 没有运行，请先在「安装」页启动或部署' })
      return
    }
    if (queueSnapshot().running) {
      sendJson(response, 409, { ok: false, error: '正在生成其它任务，请稍候' })
      return
    }
    // Reference projects default to img2img from the uploaded picture; the
    // text-to-image path stays available with an explicit useReference:false.
    const useReference = String(project.referenceFile ?? '') !== '' && body?.useReference !== false
    enqueueBase(config, layout, id, body?.count === 2 ? 2 : 1, { useReference })
    sendJson(response, 200, { ok: true, queue: queueSnapshot() })
  })

  // Manual / smart retouch: 'base' appends a new base version, 'shot' replaces
  // one raw final. Smart mode asks the vision model what to fix first.
  const editRoute = (target) => async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    const body = await readBody(request, 64 * 1024)
    const id = String(body?.id ?? '')
    const project = readProject(id)
    if (project === null) {
      sendJson(response, 404, { ok: false, error: '项目不存在' })
      return
    }
    const config = readConfig()
    const { layout } = detectComfyDir(config)
    if (layout === null || (await comfyStats(config.comfyPort)) === null) {
      sendJson(response, 409, { ok: false, error: 'ComfyUI 没有运行，请先在「安装」页启动' })
      return
    }
    if (queueSnapshot().running) {
      sendJson(response, 409, { ok: false, error: '正在生成其它任务，请稍候' })
      return
    }
    const file = String(body?.file ?? '').trim()
    if (target === 'shot' && file === '') {
      sendJson(response, 400, { ok: false, error: '请选择要修改的成片' })
      return
    }
    let instruction = String(body?.instruction ?? '').trim()
    const notes = []
    if (body?.smart === true) {
      try {
        const analysis = await smartEditInstruction(ctx, project, target, file, instruction)
        instruction = analysis.fix
        if (analysis.issues.length > 0) notes.push(`智能微调分析：${analysis.issues.join('；')}`)
      } catch (error) {
        sendJson(response, 500, { ok: false, error: `智能分析失败：${error?.message ?? error}` })
        return
      }
    }
    if (instruction === '') {
      sendJson(response, 400, { ok: false, error: '请输入修改要求，或改用智能修改' })
      return
    }
    try {
      enqueueEdit(config, layout, id, { target, file, instruction, denoise: Number(body?.denoise), notes })
      sendJson(response, 200, { ok: true, project: readProject(id), issues: notes })
    } catch (error) {
      sendJson(response, 500, { ok: false, error: error?.message ?? String(error) })
    }
  }
  route(API.baseEdit, editRoute('base'))
  route(API.shotEdit, editRoute('shot'))

  // Undo the most recent retouch of one raw final (backups live in raw/.history).
  route(API.restoreShot, async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    const body = await readBody(request, 16 * 1024)
    const id = String(body?.id ?? '')
    const project = readProject(id)
    if (project === null) {
      sendJson(response, 404, { ok: false, error: '项目不存在' })
      return
    }
    const file = String(body?.file ?? '').trim()
    if (file === '' || file.includes('/') || file.includes('\\') || file.includes('..')) {
      sendJson(response, 400, { ok: false, error: '文件名不合法' })
      return
    }
    const dirs = projectDirs(id)
    const history = join(dirs.raw, '.history')
    const current = join(dirs.raw, file)
    if (!existsSync(history) || !existsSync(current)) {
      sendJson(response, 404, { ok: false, error: '没有可恢复的历史版本' })
      return
    }
    const versions = readdirSync(history)
      .filter((name) => name.startsWith(`${file}.`) && name.endsWith('.png'))
      .sort()
    if (versions.length === 0) {
      sendJson(response, 404, { ok: false, error: '没有可恢复的历史版本' })
      return
    }
    const latest = versions[versions.length - 1]
    writeFileSync(join(history, `${file}.${Date.now()}.png`), readFileSync(current))
    writeFileSync(current, readFileSync(join(history, latest)))
    const updated = updateProject(id, {
      pendingFinals: [...new Set([...(project.pendingFinals ?? []), file])],
      notes: [...(project.notes ?? []), `已恢复上一版成片：${file}`],
    })
    sendJson(response, 200, { ok: true, project: updated })
  })

  route(API.research, async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    const body = await readBody(request, 64 * 1024)
    const id = String(body?.id ?? '')
    if (readProject(id) === null) {
      sendJson(response, 404, { ok: false, error: '项目不存在' })
      return
    }
    const config = readConfig()
    try {
      const project = startResearch(ctx, config, id, { supplement: body?.supplement === true })
      sendJson(response, 200, { ok: true, project })
    } catch (error) {
      sendJson(response, 500, { ok: false, error: error?.message ?? String(error) })
    }
  })

  route(API.random, async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    const config = readConfig()
    try {
      const pick = await createRandomProject(ctx, config)
      const project = createProject({
        character: pick.character,
        series: pick.series,
        details: defaultDetails(pick.character, pick.series),
        source: 'random',
      })
      updateProject(project.id, { notes: [pick.reason === '' ? '随机推荐角色' : `随机推荐：${pick.reason}`] })
      startResearch(ctx, config, project.id)
      sendJson(response, 200, { ok: true, project: readProject(project.id), pick })
    } catch (error) {
      sendJson(response, 500, { ok: false, error: error?.message ?? String(error) })
    }
  })

  route(API.script, async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    const body = await readBody(request, 1024 * 1024)
    const id = String(body?.id ?? '')
    const project = readProject(id)
    if (project === null) {
      sendJson(response, 404, { ok: false, error: '项目不存在' })
      return
    }
    const config = readConfig()
    const count = Math.max(4, Math.min(6, Number(body?.count ?? config.shotCount ?? 6)))
    const { shots, note } = await generateShotList(ctx, project, count)
    const updated = applyShots(id, shots)
    updateProject(id, { status: 'awaiting-script-approval', notes: [...(updated.notes ?? []), note] })
    sendJson(response, 200, { ok: true, project: readProject(id), note })
  })

  // Smart add: the script model designs extra shots that must not repeat the
  // ones already in the list.
  route(API.scriptAdd, async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    const body = await readBody(request, 64 * 1024)
    const id = String(body?.id ?? '')
    const project = readProject(id)
    if (project === null) {
      sendJson(response, 404, { ok: false, error: '项目不存在' })
      return
    }
    const existing = Array.isArray(project.shots) ? project.shots : []
    if (existing.length === 0) {
      sendJson(response, 409, { ok: false, error: '还没有镜头脚本，请先生成' })
      return
    }
    const add = Math.max(1, Math.min(3, Number(body?.count ?? 2)))
    const limit = Math.max(0, 10 - existing.length)
    if (limit === 0) {
      sendJson(response, 409, { ok: false, error: '已经有 10 个分镜，先删除一些再补' })
      return
    }
    const { shots: fresh, note } = await generateShotList(ctx, project, Math.min(add, limit), existing)
    const merged = [...existing, ...fresh].slice(0, 10).map((shot, index) => ({
      ...shot,
      id: index + 1,
      prompt: `${shot.type ?? 'A'}｜${shot.title ?? `镜头 ${index + 1}`}`,
    }))
    const updated = updateProject(id, {
      shots: merged,
      status: 'awaiting-script-approval',
      notes: [...(project.notes ?? []), note, `智能补充分镜 ${fresh.length} 个`],
    })
    sendJson(response, 200, { ok: true, project: updated, note })
  })

  route(API.generate, async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    const body = await readBody(request, 64 * 1024)
    const id = String(body?.id ?? '')
    const project = readProject(id)
    if (project === null) {
      sendJson(response, 404, { ok: false, error: '项目不存在' })
      return
    }
    if (!Array.isArray(project.shots) || project.shots.length === 0) {
      sendJson(response, 409, { ok: false, error: '还没有镜头脚本' })
      return
    }
    const config = readConfig()
    const { layout } = detectComfyDir(config)
    if (layout === null || (await comfyStats(config.comfyPort)) === null) {
      sendJson(response, 409, { ok: false, error: 'ComfyUI 没有运行' })
      return
    }
    if (queueSnapshot().running) {
      sendJson(response, 409, { ok: false, error: '已有生成任务在运行' })
      return
    }
    updateProject(id, { status: 'generating' })
    enqueueShots(config, layout, id)
    sendJson(response, 200, { ok: true, queue: queueSnapshot() })
  })

  route(API.finalize, async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    const body = await readBody(request, 64 * 1024)
    const id = String(body?.id ?? '')
    if (readProject(id) === null) {
      sendJson(response, 404, { ok: false, error: '项目不存在' })
      return
    }
    const config = readConfig()
    const { layout } = detectComfyDir(config)
    if (queueSnapshot().running) {
      sendJson(response, 409, { ok: false, error: '已有任务在运行' })
      return
    }
    enqueueFinalize(config, layout, id, {
      deoil: body?.deoil === true,
      makeup: body?.makeup === true,
      flatten: body?.flatten !== false,
      preview: body?.preview !== false,
      copy: body?.copy !== false,
    })
    sendJson(response, 200, { ok: true })
  })

  // Open one of a project's image folders in the desktop file manager. The
  // browser cannot reveal local files, so this is the escape hatch when an
  // <img> preview still fails.
  route(API.openFolder, async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    const body = await readBody(request, 16 * 1024)
    const id = String(body?.id ?? '')
    if (id === '' || id.includes('..') || /[\\/]/.test(id)) {
      sendJson(response, 400, { ok: false, error: '项目 id 不合法' })
      return
    }
    if (readProject(id) === null) {
      sendJson(response, 404, { ok: false, error: '项目不存在' })
      return
    }
    const dirs = projectDirs(id)
    const key = String(body?.sub ?? 'base')
    if (!Object.hasOwn(dirs, key)) {
      sendJson(response, 400, { ok: false, error: '未知的文件夹' })
      return
    }
    const dir = dirs[key]
    if (!existsSync(dir)) {
      sendJson(response, 404, { ok: false, error: '文件夹不存在' })
      return
    }
    const { spawn } = await import('node:child_process')
    const opener = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    try {
      const child = spawn(opener, [dir], { detached: true, stdio: 'ignore' })
      child.on('error', () => {})
      child.unref()
    } catch (error) {
      sendJson(response, 500, { ok: false, error: `打开文件夹失败：${error?.message ?? error}` })
      return
    }
    sendJson(response, 200, { ok: true, path: dir })
  })

  route(API.queue, async (request, response) => {
    if (request.method === 'POST') {
      cancelQueue()
      sendJson(response, 200, { ok: true, queue: queueSnapshot() })
      return
    }
    sendJson(response, 200, { ok: true, queue: queueSnapshot(), deployment })
  })

  // Media: /api/cosplay-studio/media/<projectId>/<subpath>
  const disposeMedia = ctx.webServer.register({
    kind: 'prefix',
    path: MEDIA_PREFIX,
    handler: async (request, response) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { allow: 'GET, HEAD' })
        response.end()
        return
      }
      const pathname = (request.url ?? '').split('?')[0]
      let raw = ''
      try {
        raw = decodeURIComponent(pathname.slice(MEDIA_PREFIX.length).replace(/^\/+/, ''))
      } catch {
        sendJson(response, 400, { error: 'bad path' })
        return
      }
      const target = resolve(join(PROJECTS_DIR, raw))
      const rootWithSep = PROJECTS_DIR.endsWith(sep) ? PROJECTS_DIR : PROJECTS_DIR + sep
      if (!target.startsWith(rootWithSep)) {
        sendJson(response, 403, { error: 'forbidden' })
        return
      }
      if (!existsSync(target)) {
        sendJson(response, 404, { error: 'not found' })
        return
      }
      const ext = target.slice(target.lastIndexOf('.') + 1).toLowerCase()
      const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', txt: 'text/plain; charset=utf-8' }
      const buffer = readFileSync(target)
      response.writeHead(200, {
        'content-type': types[ext] ?? 'application/octet-stream',
        'content-length': buffer.length,
        'cache-control': 'private, max-age=60',
      })
      response.end(buffer)
    },
  })
  disposers.push(disposeMedia)

  return async () => {
    disposeAll()
  }
}

export { inject }
