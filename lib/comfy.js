// ComfyUI integration: locate / install / start the server, verify the model
// files, talk to the HTTP API, and build the Z-Image-Turbo workflow graphs.
//
// The graph layout is a faithful JavaScript port of the proven
// comfy-shim workflow: 6 steps, cfg 2, ModelSamplingAuraFlow shift 3,
// res_multistep + simple, real negative conditioning (cfg > 1), and a tiled
// low-denoise refine pass only when the final size is much larger than the
// single-pass size.

import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { homedir } from 'node:os'
import { DOWNLOADS_DIR, dshHome, logLine } from './paths.js'

const REQUEST_TIMEOUT_MS = 60_000
const JOB_TIMEOUT_MS = 900_000

/* ------------------------------------------------------------------ files */

function walkFiles(dir, depth = 0, out = []) {
  if (depth > 4) return out
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, depth + 1, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

/** Resolve the layout of a ComfyUI installation. */
export function resolveComfyLayout(input) {
  const dir = resolve(String(input ?? '').trim())
  if (dir === '' || !existsSync(dir)) return null
  const candidates = []
  if (existsSync(join(dir, 'main.py'))) candidates.push({ cwd: dir, root: dir })
  if (existsSync(join(dir, 'ComfyUI', 'main.py'))) candidates.push({ cwd: join(dir, 'ComfyUI'), root: dir })
  if (existsSync(join(dir, '..', 'main.py'))) candidates.push({ cwd: dir, root: dir })

  for (const candidate of candidates) {
    const portablePython = join(candidate.root, 'python_embeded', 'python.exe')
    const venvPython = join(candidate.cwd, 'venv', 'Scripts', 'python.exe')
    const venvPython2 = join(candidate.root, 'venv', 'Scripts', 'python.exe')
    // A venv is often one level above the ComfyUI folder (…/ComfyUI + …/venv).
    const venvPython3 = join(dirname(candidate.cwd), 'venv', 'Scripts', 'python.exe')
    let python = ''
    if (existsSync(portablePython)) python = portablePython
    else if (existsSync(venvPython)) python = venvPython
    else if (existsSync(venvPython2)) python = venvPython2
    else if (existsSync(venvPython3)) python = venvPython3
    const comfyRoot = resolve(candidate.cwd, '..')
    return {
      root: candidate.root,
      main: candidate.cwd,
      cwd: candidate.cwd,
      python,
      models: join(candidate.cwd, 'models'),
      portable: python === portablePython,
      // ComfyUI portable nests python_embeded next to the ComfyUI folder
      portableRoot: candidate.root !== candidate.cwd ? candidate.root : dirname(candidate.cwd),
      comfyRoot,
    }
  }
  return null
}

const COMMON_COMFY_DIRS = () => [
  'D:\\Softwares\\ComfyUI',
  'D:\\Softwares\\ComfyUI\\ComfyUI',
  'D:\\ComfyUI',
  'D:\\ComfyUI\\ComfyUI',
  'D:\\AI\\ComfyUI\\ComfyUI',
  'C:\\ComfyUI',
  'C:\\ComfyUI\\ComfyUI',
  join(homedir(), 'ComfyUI'),
  join(homedir(), 'ComfyUI_windows_portable'),
  join(homedir(), 'ComfyUI_windows_portable', 'ComfyUI'),
  join(homedir(), 'Documents', 'ComfyUI', 'ComfyUI'),
  join(dshHome(), 'ComfyUI'),
]

/** Find an existing installation without asking the user. */
export function detectComfyDir(config) {
  const tried = []
  const candidates = [
    config?.comfyDir,
    process.env.COMFYUI_PATH,
    ...COMMON_COMFY_DIRS(),
  ].filter((value) => typeof value === 'string' && value.trim() !== '')
  for (const candidate of candidates) {
    const layout = resolveComfyLayout(candidate)
    tried.push(candidate)
    if (layout !== null) return { layout, tried }
  }
  return { layout: null, tried }
}

/** Which required model files are present under models/ (searched recursively). */
export function modelStatus(config, layout) {
  const modelsDir = layout?.models ?? ''
  const files = modelsDir !== '' && existsSync(modelsDir) ? walkFiles(modelsDir) : []
  const find = (name) => files.find((file) => file.toLowerCase().endsWith(String(name).toLowerCase())) ?? ''
  return {
    modelsDir,
    unet: find(config.models.unetFile),
    clip: find(config.models.clipFile),
    vae: find(config.models.vaeFile),
    scanned: files.length,
  }
}

/* --------------------------------------------------------------- transport */

async function httpJson(port, path, options = {}) {
  const url = `http://127.0.0.1:${port}${path}`
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    headers: { accept: 'application/json', ...(options.headers ?? {}) },
  })
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 600)
    throw new Error(`ComfyUI ${path} → HTTP ${response.status} ${detail}`)
  }
  return response
}

export async function comfyStats(port, timeoutMs = 2500) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/system_stats`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return null
    const stats = await response.json()
    return stats
  } catch {
    return null
  }
}

export async function waitForComfy(port, timeoutMs = 180_000, onTick = () => {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const stats = await comfyStats(port)
    if (stats !== null) return stats
    onTick()
    await new Promise((r) => setTimeout(r, 1500))
  }
  return null
}

/* ---------------------------------------------------------------- process */

const children = new Map()

export function comfyPid(port) {
  return children.get(port)?.pid ?? 0
}

/** Start ComfyUI in the background and wait until /system_stats answers. */
export async function startComfy(layout, port, pythonOverride, log) {
  if (pythonOverride !== '' && existsSync(pythonOverride)) {
    layout = { ...layout, python: pythonOverride }
  }
  if (layout.python === '') {
    throw new Error('找不到 ComfyUI 的 Python 解释器（缺 python_embeded 或 venv）。请在设置里手动指定 python.exe 路径。')
  }
  const args = [
    '-s', 'main.py',
    '--port', String(port),
    '--listen', '127.0.0.1',
    '--preview-method', 'none',
    // Proven on 8 GB cards: split attention keeps the peak allocation low and
    // reserving 1 GB leaves room for the desktop compositor.
    '--use-split-cross-attention',
    '--reserve-vram', '1',
  ]
  log(`启动 ComfyUI：${layout.python} ${args.join(' ')}`)
  const child = spawn(layout.python, args, {
    cwd: layout.cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTORCH_ENABLE_MPS_FALLBACK: '1' },
  })
  children.set(port, child)
  const tail = []
  const capture = (chunk) => {
    const text = chunk.toString('utf8')
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === '') continue
      tail.push(line)
      if (tail.length > 40) tail.shift()
    }
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  child.on('exit', (code) => {
    children.delete(port)
    log(`ComfyUI 进程退出（code=${code ?? '?'}）`, code === 0 ? 'info' : 'warn')
  })

  const stats = await waitForComfy(port, 240_000)
  if (stats === null) {
    throw new Error(`ComfyUI 启动超时。最近日志：\n${tail.slice(-12).join('\n') || '（无输出）'}`)
  }
  log('ComfyUI 已就绪')
  return { pid: child.pid, stats }
}

export function stopComfy(port) {
  const child = children.get(port)
  if (child === undefined) return false
  try {
    child.kill()
  } catch {
    // ignore
  }
  children.delete(port)
  return true
}

/* ------------------------------------------------------------------ graphs */

const snap = (value) => Math.max(16, Math.round(value / 16) * 16)

export function resolveSize(baseSize, finalSize) {
  const parse = (value) => {
    const match = /^\s*(\d+)\s*[xX*]\s*(\d+)\s*$/.exec(String(value ?? ''))
    return match === null ? null : [Number(match[1]), Number(match[2])]
  }
  const fin = parse(finalSize)
  const base = parse(baseSize)
  const target = fin ?? [1152, 2048]
  const longest = Math.max(target[0], target[1])
  const first = base ?? (longest <= 2048 ? target : [Math.round(target[0] * 1152 / longest), Math.round(target[1] * 1152 / longest)])
  return {
    width: snap(target[0]),
    height: snap(target[1]),
    baseWidth: snap(first[0]),
    baseHeight: snap(first[1]),
  }
}

function loaders(config) {
  return {
    28: { class_type: 'UNETLoader', inputs: { unet_name: config.models.unetFile, weight_dtype: 'default' } },
    30: { class_type: 'CLIPLoader', inputs: { clip_name: config.models.clipFile, type: config.models.clipType || 'lumina2', device: 'default' } },
    29: { class_type: 'VAELoader', inputs: { vae_name: config.models.vaeFile } },
    11: { class_type: 'ModelSamplingAuraFlow', inputs: { shift: config.shift, model: ['28', 0] } },
  }
}

function conditioning(prompt, negative, cfg) {
  const nodes = { 27: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['30', 0] } } }
  if (Number(cfg) > 1.01 && String(negative ?? '').trim() !== '') {
    nodes[33] = { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['30', 0] } }
  } else {
    nodes[33] = { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['27', 0] } }
  }
  return nodes
}

function hiresTail(lastImage, size, config) {
  const nodes = {}
  let pixels = lastImage
  const targetLong = Math.max(size.width, size.height)
  const baseLong = Math.max(size.baseWidth, size.baseHeight)
  const needRefine = targetLong >= baseLong * 1.15
  // 8 GB cards cannot sample much more than ~4.6 MP in one refine pass.
  const limit = Math.sqrt(4_600_000)
  let refineWidth = size.width
  let refineHeight = size.height
  if (Math.sqrt(size.width * size.height) > limit) {
    const k = limit / Math.sqrt(size.width * size.height)
    refineWidth = snap(size.width * k)
    refineHeight = snap(size.height * k)
  }
  if (needRefine) {
    // Large tiles with a generous overlap keep the tiled VAE round-trip from
    // leaving a visible seam in a flat backdrop.
    const tile = config.vaeTileSize ?? 1024
    const overlap = config.vaeOverlap ?? 128
    nodes[52] = { class_type: 'ImageScale', inputs: { image: pixels, upscale_method: 'lanczos', width: refineWidth, height: refineHeight, crop: 'disabled' } }
    nodes[53] = {
      class_type: 'VAEEncodeTiled',
      inputs: { pixels: ['52', 0], vae: ['29', 0], tile_size: tile, overlap, temporal_size: 64, temporal_overlap: 8 },
    }
    nodes[54] = {
      class_type: 'KSampler',
      inputs: {
        seed: config._seed, steps: 8, cfg: config.cfg, sampler_name: config.sampler, scheduler: config.scheduler,
        denoise: 0.25, model: ['11', 0], positive: ['27', 0], negative: ['33', 0], latent_image: ['53', 0],
      },
    }
    nodes[55] = {
      class_type: 'VAEDecodeTiled',
      inputs: { samples: ['54', 0], vae: ['29', 0], tile_size: tile, overlap, temporal_size: 64, temporal_overlap: 8 },
    }
    pixels = ['55', 0]
    if ((refineWidth !== size.width || refineHeight !== size.height)) {
      nodes[58] = { class_type: 'ImageScale', inputs: { image: pixels, upscale_method: 'lanczos', width: size.width, height: size.height, crop: 'disabled' } }
      pixels = ['58', 0]
    }
  }
  nodes[9] = { class_type: 'SaveImage', inputs: { images: pixels, filename_prefix: config._prefix ?? 'cosplay' } }
  return nodes
}

export function textToImageGraph(prompt, size, config, seed, prefix) {
  const local = { ...config, _seed: seed, _prefix: prefix }
  const graph = loaders(config)
  Object.assign(graph, conditioning(prompt, config.negative, config.cfg))
  graph[13] = { class_type: 'EmptySD3LatentImage', inputs: { width: size.baseWidth, height: size.baseHeight, batch_size: 1 } }
  graph[3] = {
    class_type: 'KSampler',
    inputs: {
      seed, steps: config.steps, cfg: config.cfg, sampler_name: config.sampler, scheduler: config.scheduler, denoise: 1,
      model: ['11', 0], positive: ['27', 0], negative: ['33', 0], latent_image: ['13', 0],
    },
  }
  graph[8] = { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['29', 0] } }
  // First pass image is [8,0]; the tail either just saves it or refines it first.
  const tail = hiresTail(['8', 0], size, local)
  Object.assign(graph, tail)
  return graph
}

/**
 * Reference-photo guided image: the photo is re-composed at the base size and
 * sampled with a moderately low denoise so the cosplay design survives.
 */
export function imageToImageGraph(prompt, uploadedName, size, config, seed, denoise, prefix) {
  const graph = loaders(config)
  Object.assign(graph, conditioning(prompt, config.negative, config.cfg))
  graph[40] = { class_type: 'LoadImage', inputs: { image: uploadedName } }
  graph[41] = {
    class_type: 'ImageScale',
    inputs: { image: ['40', 0], upscale_method: 'lanczos', width: size.baseWidth, height: size.baseHeight, crop: 'center' },
  }
  graph[42] = { class_type: 'VAEEncode', inputs: { pixels: ['41', 0], vae: ['29', 0] } }
  graph[3] = {
    class_type: 'KSampler',
    inputs: {
      seed, steps: config.steps, cfg: config.cfg, sampler_name: config.sampler, scheduler: config.scheduler,
      denoise, model: ['11', 0], positive: ['27', 0], negative: ['33', 0], latent_image: ['42', 0],
    },
  }
  graph[8] = { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['29', 0] } }
  Object.assign(graph, hiresTail(['8', 0], size, { ...config, _seed: seed, _prefix: prefix }))
  return graph
}

/* -------------------------------------------------------------- execution */

export async function uploadImage(port, data, filename) {
  const boundary = `----cosplay${Math.random().toString(16).slice(2)}`
  const safe = String(filename ?? 'reference.png').replace(/[^A-Za-z0-9._-]/g, '_')
  const stored = `cosplay-${Date.now().toString(36)}-${safe}`
  const parts = []
  for (const [name, value] of [['type', 'input'], ['subfolder', 'cosplay'], ['overwrite', 'true']]) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${stored}"\r\nContent-Type: image/png\r\n\r\n`))
  parts.push(data)
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))
  const body = Buffer.concat(parts)
  const response = await fetch(`http://127.0.0.1:${port}/upload/image`, {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body,
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) throw new Error(`上传参考图失败：HTTP ${response.status}`)
  const parsed = await response.json()
  const name = parsed?.name ?? stored
  const subfolder = parsed?.subfolder ?? ''
  return subfolder ? `${subfolder}/${name}` : name
}

/** Submit a graph, wait for history, and return the produced images. */
export async function runGraph(port, graph, options = {}) {
  const clientId = `cosplay-studio-${Math.random().toString(36).slice(2)}`
  const response = await httpJson(port, '/prompt', {
    method: 'POST',
    body: JSON.stringify({ prompt: graph, client_id: clientId }),
    headers: { 'content-type': 'application/json' },
  })
  const queued = await response.json()
  if (queued?.node_errors && Object.keys(queued.node_errors).length > 0) {
    throw new Error(`ComfyUI 拒绝了工作流：${JSON.stringify(queued.node_errors).slice(0, 800)}`)
  }
  const promptId = queued?.prompt_id
  if (!promptId) throw new Error('ComfyUI 没有返回 prompt_id')
  if (typeof options.onQueued === 'function') options.onQueued(promptId)

  const deadline = Date.now() + (options.timeoutMs ?? JOB_TIMEOUT_MS)
  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw new Error('任务已取消')
    const historyResponse = await httpJson(port, `/history/${promptId}`)
    const history = await historyResponse.json()
    const entry = history?.[promptId]
    if (entry !== undefined && entry !== null) {
      const status = entry.status ?? {}
      if (status.status_str === 'error') {
        throw new Error(`ComfyUI 执行失败：${JSON.stringify(status.messages ?? []).slice(0, 800)}`)
      }
      const images = []
      for (const output of Object.values(entry.outputs ?? {})) {
        for (const image of output?.images ?? []) images.push(image)
      }
      if (images.length === 0) throw new Error('ComfyUI 执行完成但没有产出图片')
      return images
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error(`等待 ComfyUI 出图超时（${Math.round((options.timeoutMs ?? JOB_TIMEOUT_MS) / 1000)} 秒）`)
}

export async function downloadImage(port, image) {
  const query = new URLSearchParams({
    filename: image.filename ?? '',
    subfolder: image.subfolder ?? '',
    type: image.type ?? 'output',
  })
  const response = await fetch(`http://127.0.0.1:${port}/view?${query.toString()}`, {
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) throw new Error(`下载图片失败：HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

/* ------------------------------------------------------------ self test */

export async function selfTest(config, layout, log) {
  const port = config.comfyPort
  log('自检 1/3：检查模型文件…')
  const models = modelStatus(config, layout)
  if (models.unet === '' || models.clip === '' || models.vae === '') {
    const missing = [
      models.unet === '' ? config.models.unetFile : '',
      models.clip === '' ? config.models.clipFile : '',
      models.vae === '' ? config.models.vaeFile : '',
    ].filter(Boolean)
    throw new Error(`缺少模型文件：${missing.join('、')}。把它们放进 ${models.modelsDir || 'models'} 下的对应目录后重试。`)
  }
  log(`模型就绪：UNET ${models.unet}`)

  log('自检 2/3：跑一张 640×1152 的测试图（约 15–30 秒）…')
  const size = { width: 640, height: 1152, baseWidth: 640, baseHeight: 1152 }
  const started = Date.now()
  const graph = textToImageGraph(
    'Photorealistic photograph of a young woman standing in a plain sunlit room, natural skin texture, sharp focus',
    size,
    { ...config, steps: 4 },
    Math.floor(Math.random() * 1_000_000),
    'cosplay-selftest',
  )
  const images = await runGraph(port, graph, { timeoutMs: 300_000 })
  const elapsed = Math.round((Date.now() - started) / 1000)
  const bytes = await downloadImage(port, images[0])
  if (bytes.length < 4096) throw new Error('测试图内容异常（文件过小）')
  log(`自检 3/3：通过，${elapsed} 秒出图（${Math.round(bytes.length / 1024)} KB）`)
  return { ok: true, elapsedSeconds: elapsed, bytes: bytes.length, at: new Date().toISOString() }
}

/* ------------------------------------------------------------- downloads */

async function downloadToFile(url, dest, onProgress) {
  mkdirSync(dirname(dest), { recursive: true })
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}：${url}`)
  const total = Number(response.headers.get('content-length') ?? 0)
  let received = 0
  const source = Readable.fromWeb(response.body)
  source.on('data', (chunk) => {
    received += chunk.length
    if (typeof onProgress === 'function') onProgress(received, total)
  })
  await pipeline(source, createWriteStream(dest))
  return dest
}

export async function downloadModel(url, destFile, onProgress) {
  if (existsSync(destFile) && statSync(destFile).size > 1024 * 1024) {
    return { skipped: true, path: destFile }
  }
  const partial = `${destFile}.part`
  await downloadToFile(url, partial, onProgress)
  const { renameSync } = await import('node:fs')
  renameSync(partial, destFile)
  return { skipped: false, path: destFile }
}

/** Find the Windows portable archive of the latest ComfyUI release. */
export async function findComfyPortableAsset(log) {
  const fallback = 'https://github.com/comfyanonymous/ComfyUI/releases/latest/download/ComfyUI_windows_portable_nvidia.7z'
  try {
    const response = await fetch('https://api.github.com/repos/comfyanonymous/ComfyUI/releases/latest', {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-cosplay-studio' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) throw new Error(String(response.status))
    const release = await response.json()
    const asset = (release.assets ?? []).find((item) => /windows_portable/i.test(item.name) && /\.7z$/i.test(item.name))
    if (asset === undefined) throw new Error('release 里没有 windows_portable 资产')
    log(`找到 ComfyUI 便携版：${asset.name}（${Math.round(asset.size / 1048576)} MB）`)
    return { url: asset.browser_download_url, name: asset.name, size: asset.size }
  } catch (error) {
    log(`GitHub API 不可用（${error.message}），改用固定下载地址`, 'warn')
    return { url: fallback, name: 'ComfyUI_windows_portable_nvidia.7z', size: 0 }
  }
}

/** Download + extract the ComfyUI portable build into downloads/comfyui. */
export async function installComfyPortable(log, onProgress) {
  const asset = await findComfyPortableAsset(log)
  const archive = join(DOWNLOADS_DIR, asset.name)
  if (!existsSync(archive) || statSync(archive).size < 100 * 1024 * 1024) {
    log(`开始下载 ${asset.name}（约 1.4–1.8 GB，网络慢时请耐心等待）…`)
    await downloadToFile(asset.url, archive, (received, total) => {
      if (typeof onProgress === 'function') onProgress(received, total)
      if (total > 0 && received % (256 * 1024 * 1024) < 1024 * 512) {
        log(`已下载 ${Math.round(received / 1048576)} / ${Math.round(total / 1048576)} MB`)
      }
    })
  }
  const target = join(DOWNLOADS_DIR, 'comfyui')
  mkdirSync(target, { recursive: true })
  log('解压 ComfyUI 便携版（可能需要几分钟）…')
  await extractArchive(archive, target, log)
  const entries = readdirSync(target, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  for (const entry of entries) {
    const layout = resolveComfyLayout(join(target, entry.name))
    if (layout !== null) {
      log(`ComfyUI 解压完成：${layout.cwd}`)
      return layout
    }
  }
  const direct = resolveComfyLayout(target)
  if (direct !== null) return direct
  throw new Error('解压后没有找到 main.py，请手动指定 ComfyUI 目录')
}

function runProcess(command, args, onLine) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const feed = (chunk) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.trim() !== '' && typeof onLine === 'function') onLine(line.trim())
      }
    }
    child.stdout.on('data', feed)
    child.stderr.on('data', feed)
    child.on('error', rejectPromise)
    child.on('exit', (code) => (code === 0 ? resolvePromise() : rejectPromise(new Error(`${command} 退出码 ${code}`))))
  })
}

export async function extractArchive(archive, target, log) {
  const tarExe = 'C:\\Windows\\System32\\tar.exe'
  if (existsSync(tarExe)) {
    try {
      await runProcess(tarExe, ['-xf', archive, '-C', target], (line) => {
        if (line.length < 120 && !line.includes('%')) log(`解压：${line}`)
      })
      return
    } catch (error) {
      log(`tar 解压失败（${error.message}），尝试 7z…`, 'warn')
    }
  }
  const sevenZip = [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
  ].find((candidate) => existsSync(candidate))
  if (sevenZip !== undefined) {
    await runProcess(sevenZip, ['x', archive, `-o${target}`, '-y'], (line) => {
      if (line.length < 120) log(`解压：${line}`)
    })
    return
  }
  throw new Error('没有可用的解压工具。请安装 7-Zip，或手动解压 ComfyUI 便携版后在设置里指定目录。')
}
