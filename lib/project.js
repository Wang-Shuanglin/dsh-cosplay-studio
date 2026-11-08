// Projects + the generation queue.
//
// One project = one character. The queue is strictly sequential because a single
// 8 GB GPU cannot run two ComfyUI jobs at once; the browser polls /state for
// progress instead of holding an HTTP request open.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECTS_DIR, logLine, slugify } from './paths.js'
import { downloadImage, imageToImageGraph, resolveSize, runGraph, textToImageGraph } from './comfy.js'
import { DEFAULT_POSE, buildCard, shotPrompt } from './card.js'

export function projectDirs(id) {
  const root = join(PROJECTS_DIR, id)
  const dirs = {
    root,
    refs: join(root, 'refs'),
    base: join(root, 'base'),
    raw: join(root, 'raw'),
    final: join(root, 'final'),
    deliver: join(root, 'deliver'),
  }
  for (const dir of Object.values(dirs)) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
  return dirs
}

export function readProject(id) {
  try {
    return JSON.parse(readFileSync(join(PROJECTS_DIR, id, 'project.json'), 'utf8'))
  } catch {
    return null
  }
}

export function saveProject(project) {
  const dirs = projectDirs(project.id)
  writeFileSync(join(dirs.root, 'project.json'), JSON.stringify(project, null, 2), 'utf8')
  return project
}

export function listProjects() {
  if (!existsSync(PROJECTS_DIR)) return []
  return readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readProject(entry.name))
    .filter((project) => project !== null)
    .sort((a, b) => String(b.updatedAt ?? b.createdAt ?? '').localeCompare(String(a.updatedAt ?? a.createdAt ?? '')))
}

export function uniqueProjectId(character) {
  const base = slugify(character)
  let id = base
  let index = 2
  while (existsSync(join(PROJECTS_DIR, id))) {
    id = `${base}_${index}`
    index += 1
  }
  return id
}

export function createProject({ character, series = '', details, source = 'name', referenceFile = '' }) {
  const id = uniqueProjectId(character)
  const dirs = projectDirs(id)
  const merged = { ...(details ?? {}) }
  const card = buildCard(merged)
  const project = {
    id,
    character: merged.character ?? character,
    series: merged.series ?? series,
    source,
    details: merged,
    card,
    referenceFile,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'card',
    baseImages: [],
    shots: [],
    finals: [],
    preview: '',
    notes: [],
  }
  writeFileSync(join(dirs.root, 'character_card.txt'), card, 'utf8')
  return saveProject(project)
}

export function updateProject(id, patch) {
  const project = readProject(id)
  if (project === null) return null
  const next = { ...project, ...patch, updatedAt: new Date().toISOString() }
  return saveProject(next)
}

/* ------------------------------------------------------------- the queue */

export const queue = {
  running: false,
  current: null,
  pending: 0,
  lastError: '',
  lastResult: null,
  cancelRequested: false,
  total: 0,
  done: 0,
  label: '',
}

function queueState() {
  return {
    running: queue.running,
    current: queue.current,
    pending: queue.pending,
    total: queue.total,
    done: queue.done,
    label: queue.label,
    lastError: queue.lastError,
    lastResult: queue.lastResult,
  }
}

export function queueSnapshot() {
  return queueState()
}

const jobs = []

export function enqueue(job) {
  jobs.push(job)
  queue.pending = jobs.length
  void pump()
  return queueState()
}

export function cancelQueue() {
  queue.cancelRequested = true
  queue.lastError = '任务已取消'
}

async function pump() {
  if (queue.running) return
  const job = jobs.shift()
  if (job === undefined) {
    queue.pending = 0
    return
  }
  queue.pending = jobs.length
  queue.running = true
  queue.cancelRequested = false
  queue.current = job.id
  queue.label = job.label
  queue.total = job.total ?? 1
  queue.done = 0
  queue.lastError = ''
  try {
    const result = await job.run()
    queue.label = job.doneLabel ?? job.label
    queue.lastResult = result ?? null
    job.onSuccess?.(result)
  } catch (error) {
    queue.lastError = error?.message ?? String(error)
    logLine(`任务失败（${job.id}）：${queue.lastError}`, 'error')
    job.onError?.(queue.lastError)
  } finally {
    queue.running = false
    queue.current = null
    if (jobs.length > 0) void pump()
  }
}

/* --------------------------------------------------------- job builders */

function pngPath(dir, name) {
  return join(dir, name)
}

/** Generate 1–2 base images (1152×2048) from the card. */
export function enqueueBase(config, layout, projectId, count = 1) {
  return enqueue({
    id: `base-${projectId}`,
    label: `生成基准图（${config.baseSize}）`,
    total: count,
    async run() {
      const project = readProject(projectId)
      if (project === null) throw new Error('项目不存在')
      const dirs = projectDirs(projectId)
      const size = resolveSize(config.baseSize, config.baseSize)
      const saved = []
      for (let index = 0; index < count; index += 1) {
        if (queue.cancelRequested) throw new Error('任务已取消')
        const seed = Math.floor(Math.random() * 2_147_483_000)
        queue.label = count > 1 ? `生成基准图 ${index + 1}/${count}` : '生成基准图'
        const prompt = shotPrompt(project.card, { pose: DEFAULT_POSE })
        const graph = textToImageGraph(prompt, size, config, seed, `cosplay_${projectId}_base`)
        const images = await runGraph(config.comfyPort, graph)
        const bytes = await downloadImage(config.comfyPort, images[0])
        const file = `base_${Date.now()}_${index + 1}.png`
        writeFileSync(pngPath(dirs.base, file), bytes)
        saved.push(file)
        queue.done = index + 1
      }
      const next = updateProject(projectId, {
        baseImages: [...(project.baseImages ?? []), ...saved],
        status: 'awaiting-base-approval',
        seedless: true,
      })
      return { projectId, baseImages: next?.baseImages ?? saved }
    },
  })
}

/** Run every shot of the confirmed script at the final size. */
export function enqueueShots(config, layout, projectId) {
  const project0 = readProject(projectId)
  const shots = project0?.shots ?? []
  return enqueue({
    id: `shots-${projectId}`,
    label: `生成成片 0/${shots.length}`,
    total: shots.length,
    doneLabel: '成片生成完成',
    async run() {
      const project = readProject(projectId)
      if (project === null) throw new Error('项目不存在')
      if (!Array.isArray(project.shots) || project.shots.length === 0) throw new Error('脚本还没有确认')
      const dirs = projectDirs(projectId)
      const size = resolveSize(config.baseSize, config.finalSize)
      const raws = []
      for (let index = 0; index < project.shots.length; index += 1) {
        if (queue.cancelRequested) throw new Error('任务已取消')
        const shot = project.shots[index]
        queue.label = `生成成片 ${index + 1}/${project.shots.length}｜${shot.title ?? ''}`
        const seed = Math.floor(Math.random() * 2_147_483_000)
        const prompt = shotPrompt(project.card, shot)
        const graph = textToImageGraph(prompt, size, config, seed, `cosplay_${projectId}_shot${index + 1}`)
        const images = await runGraph(config.comfyPort, graph)
        const bytes = await downloadImage(config.comfyPort, images[0])
        const file = `shot_${String(index + 1).padStart(2, '0')}.png`
        writeFileSync(pngPath(dirs.raw, file), bytes)
        raws.push(file)
        queue.done = index + 1
      }
      updateProject(projectId, { status: 'generated', pendingFinals: raws })
      return { projectId, raws }
    },
    onError(message) {
      updateProject(projectId, { status: 'failed', error: message })
    },
  })
}

/** Reference-photo guided base image (denoise 0.55: design survives, photo guides). */
export function enqueueReferenceBase(config, layout, projectId) {
  return enqueue({
    id: `refbase-${projectId}`,
    label: '按参考图生成基准图',
    async run() {
      const project = readProject(projectId)
      if (project === null) throw new Error('项目不存在')
      if (!project.referenceFile) throw new Error('项目没有参考图')
      const dirs = projectDirs(projectId)
      const size = resolveSize(config.baseSize, config.baseSize)
      const seed = Math.floor(Math.random() * 2_147_483_000)
      const { uploadImage } = await import('./comfy.js')
      const { readFileSync: read } = await import('node:fs')
      const bytesIn = read(join(dirs.refs, project.referenceFile))
      const uploaded = await uploadImage(config.comfyPort, bytesIn, project.referenceFile)
      const prompt = shotPrompt(project.card, { pose: DEFAULT_POSE })
      const graph = imageToImageGraph(prompt, uploaded, size, config, seed, 0.6, `cosplay_${projectId}_refbase`)
      const images = await runGraph(config.comfyPort, graph)
      const bytes = await downloadImage(config.comfyPort, images[0])
      const file = `base_ref_${Date.now()}.png`
      writeFileSync(pngPath(dirs.base, file), bytes)
      updateProject(projectId, { baseImages: [...(project.baseImages ?? []), file], status: 'awaiting-base-approval' })
      return { projectId, baseImages: [file] }
    },
  })
}

/* ------------------------------------------------------------- finalize */

/** Run the Pillow/numpy post-processing: de-oil, JPEG cap, 2×2 preview. */
export function enqueueFinalize(config, layout, projectId) {
  return enqueue({
    id: `final-${projectId}`,
    label: '去油光 / 导出 JPEG / 生成预览',
    async run() {
      const { spawn } = await import('node:child_process')
      const dirs = projectDirs(projectId)
      if (layout === null || layout.python === '') {
        updateProject(projectId, { status: 'generated', notes: ['没有可用的 Python，跳过 JPEG 后处理（原始 PNG 保留在 raw/）'] })
        return { projectId, skipped: true }
      }
      const script = join(import.meta.dirname, 'tools', 'finalize.py')
      const reportPath = join(dirs.root, 'finalize-report.json')
      const result = await new Promise((resolvePromise, rejectPromise) => {
        // stdio is ignored on purpose: piped stdio for a spawned interpreter is
        // unreliable on Windows, so the script writes its JSON report to a file.
        const child = spawn(layout.python, [
          script,
          dirs.root,
          '--report', reportPath,
          '--makeup', config.bodyMakeup === false ? '0' : '1',
          '--deoil', config.deoil === false ? '0' : '1',
          '--strength', String(config.makeupStrength ?? 0.35),
          '--leg-strength', String(config.legStrength ?? 0.85),
        ], {
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'ignore'],
        })
        child.on('error', rejectPromise)
        child.on('exit', (code) => {
          if (code === 0) resolvePromise('')
          else rejectPromise(new Error(`后处理失败（退出码 ${code}），详见 ${dirs.root}`))
        })
      })
      void result
      let report = null
      try {
        report = JSON.parse(readFileSync(reportPath, 'utf8'))
      } catch {
        report = null
      }
      updateProject(projectId, {
        status: 'done',
        finals: report?.finals ?? [],
        preview: report?.preview ?? '',
        completedAt: new Date().toISOString(),
        notes: report?.notes ?? [],
      })
      return { projectId, report }
    },
  })
}
