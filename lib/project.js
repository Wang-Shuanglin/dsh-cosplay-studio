// Projects + the generation queue.
//
// One project = one character. The queue is strictly sequential because a single
// 8 GB GPU cannot run two ComfyUI jobs at once; the browser polls /state for
// progress instead of holding an HTTP request open.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECTS_DIR, logLine, slugify } from './paths.js'
import { downloadImage, imageToImageGraph, resolveSize, runGraph, textToImageGraph, uploadImage } from './comfy.js'
import { DEFAULT_POSE, buildCard, referenceBasePrompt, referenceShotPrompt, shotPrompt } from './card.js'

/** Character palette for the backdrop (top / bottom colours of the gradient). */
export function projectPalette(project) {
  return {
    top: String(project?.details?.paletteTop ?? ''),
    bottom: String(project?.details?.paletteBottom ?? ''),
  }
}

export function projectDirs(id) {
  const root = join(PROJECTS_DIR, id)
  const dirs = {
    root,
    refs: join(root, 'refs'),
    base: join(root, 'base'),
    raw: join(root, 'raw'),
    final: join(root, 'final'),
    deliver: join(root, 'deliver'),
    research: join(root, 'research'),
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
  // Intra-item sampler progress (0..1) reported by the ComfyUI websocket.
  stepFraction: 0,
  label: '',
}

function queueState() {
  const total = queue.total > 0 ? queue.total : 0
  const done = total > 0 ? Math.min(queue.done, total) : 0
  // done counts finished images; stepFraction fills the image in flight, so
  // the bar moves during sampling instead of jumping 0 → 100 at the end.
  const fraction = total > 0 ? Math.min(1, (done + (Number(queue.stepFraction) || 0)) / total) : 0
  return {
    running: queue.running,
    current: queue.current,
    pending: queue.pending,
    total: queue.total,
    done: queue.done,
    fraction,
    label: queue.label,
    lastError: queue.lastError,
    lastResult: queue.lastResult,
  }
}

/** Per-image progress sink: reset at the start of every image. */
function itemProgress() {
  queue.stepFraction = 0
  return (event) => {
    const fraction = Number(event?.fraction)
    if (Number.isFinite(fraction) && fraction > queue.stepFraction) {
      queue.stepFraction = Math.min(0.98, fraction)
    }
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
  queue.stepFraction = 0
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
    queue.stepFraction = 0
    if (jobs.length > 0) void pump()
  }
}

/* --------------------------------------------------------- job builders */

function pngPath(dir, name) {
  return join(dir, name)
}

/** Generate 1–2 base images from the card, or from the uploaded reference picture. */
export function enqueueBase(config, layout, projectId, count = 1, options = {}) {
  const project0 = readProject(projectId)
  const reference = options.useReference === true && String(project0?.referenceFile ?? '') !== ''
  return enqueue({
    id: `${reference ? 'refbase' : 'base'}-${projectId}`,
    label: reference ? '按参考图生成基准图' : `生成基准图（${config.baseSize}）`,
    total: count,
    async run() {
      const project = readProject(projectId)
      if (project === null) throw new Error('项目不存在')
      const dirs = projectDirs(projectId)
      const size = resolveSize(config.baseSize, config.baseSize)
      let uploaded = ''
      if (reference) {
        const referencePath = join(dirs.refs, project.referenceFile)
        if (!existsSync(referencePath)) throw new Error('参考图文件不存在，请重新上传')
        uploaded = await uploadImage(config.comfyPort, readFileSync(referencePath), project.referenceFile)
      }
      const prompt = reference
        ? referenceBasePrompt(project.research?.detailLine ?? '', projectPalette(project))
        : shotPrompt(project.card, { pose: DEFAULT_POSE })
      const denoise = Number(config.referenceDenoise) > 0 ? Number(config.referenceDenoise) : 0.75
      const saved = []
      for (let index = 0; index < count; index += 1) {
        if (queue.cancelRequested) throw new Error('任务已取消')
        const seed = Math.floor(Math.random() * 2_147_483_000)
        queue.label = count > 1 ? `生成基准图 ${index + 1}/${count}` : (reference ? '按参考图生成基准图' : '生成基准图')
        const graph = reference
          ? imageToImageGraph(prompt, uploaded, size, config, seed, denoise, `cosplay_${projectId}_refbase`)
          : textToImageGraph(prompt, size, config, seed, `cosplay_${projectId}_base`)
        const images = await runGraph(config.comfyPort, graph, { onProgress: itemProgress() })
        const bytes = await downloadImage(config.comfyPort, images[0])
        const file = reference
          ? `base_ref_${Date.now()}_${index + 1}.png`
          : `base_${Date.now()}_${index + 1}.png`
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
      // Shots render straight at the delivery size: sampling at the base size
      // and then upscaling with a 0.25-denoise refine pass softened faces and
      // fabric (the "oil painting" look). One img2img pass at 1440x2560 keeps
      // the detail; with base === target the graph skips the refine tail.
      const shotSize = { ...size, baseWidth: size.width, baseHeight: size.height }
      // Reference projects keep the character via img2img from the approved
      // base (or the original reference when no base was approved). Text-only
      // projects keep the card-driven text-to-image path.
      const baseName = String(project.approvedBase ?? '').trim()
      const anchor =
        baseName !== '' && existsSync(join(dirs.base, baseName))
          ? { dir: dirs.base, name: baseName }
          : String(project.referenceFile ?? '') !== '' && existsSync(join(dirs.refs, project.referenceFile))
            ? { dir: dirs.refs, name: project.referenceFile }
            : null
      const uploaded = anchor === null ? '' : await uploadImage(config.comfyPort, readFileSync(join(anchor.dir, anchor.name)), anchor.name)
      const denoise = Number(config.shotDenoise) > 0 ? Number(config.shotDenoise) : 0.72
      const raws = []
      for (let index = 0; index < project.shots.length; index += 1) {
        if (queue.cancelRequested) throw new Error('任务已取消')
        const shot = project.shots[index]
        queue.label = `生成成片 ${index + 1}/${project.shots.length}｜${shot.title ?? ''}`
        const seed = Math.floor(Math.random() * 2_147_483_000)
        const graph = anchor === null
          ? textToImageGraph(shotPrompt(project.card, shot), shotSize, config, seed, `cosplay_${projectId}_shot${index + 1}`)
          : imageToImageGraph(referenceShotPrompt(shot, project.research?.detailLine ?? '', projectPalette(project)), uploaded, shotSize, config, seed, denoise, `cosplay_${projectId}_shot${index + 1}`)
        const images = await runGraph(config.comfyPort, graph, { onProgress: itemProgress() })
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

/** Reference-photo guided base image (img2img, denoise 0.75: the picture carries the design). */
export function enqueueReferenceBase(config, layout, projectId) {
  return enqueueBase(config, layout, projectId, 1, { useReference: true })
}

/**
 * Instruction-driven retouch of one existing picture.
 *  - target 'base': a new base_edit_* version is appended (the old ones stay).
 *  - target 'shot': the raw PNG is replaced in place (original moved to raw/.history).
 * `options.instruction` is the English edit line: either typed by the user or
 * produced by the smart-analysis pass in the index route.
 */
export function enqueueEdit(config, layout, projectId, options = {}) {
  const target = options.target === 'shot' ? 'shot' : 'base'
  return enqueue({
    id: `edit-${projectId}`,
    label: target === 'base' ? '微调基准图' : '微调成片',
    async run() {
      const project = readProject(projectId)
      if (project === null) throw new Error('项目不存在')
      const dirs = projectDirs(projectId)
      const fromBase = target === 'base'
      const file = String(options.file ?? '').trim()
        || (fromBase ? ([...(project.baseImages ?? [])].reverse()[0] ?? '') : '')
      if (file === '') throw new Error(fromBase ? '还没有基准图' : '没有指定要修改的成片')
      if (file.includes('/') || file.includes('\\') || file.includes('..')) throw new Error('文件名不合法')
      const sourcePath = join(fromBase ? dirs.base : dirs.raw, file)
      if (!existsSync(sourcePath)) throw new Error('要修改的图片不存在')

      const size = resolveSize(config.baseSize, fromBase ? config.baseSize : config.finalSize)
      // Editing a shot renders at the delivery size, so the edit itself is the
      // only sampling pass (no refine tail that softens the result).
      const graphSize = fromBase ? size : { ...size, baseWidth: size.width, baseHeight: size.height }
      const uploaded = await uploadImage(config.comfyPort, readFileSync(sourcePath), file)
      let prompt = ''
      if (fromBase) {
        prompt = String(project.referenceFile ?? '') === ''
          ? shotPrompt(project.card, { pose: DEFAULT_POSE })
          : referenceBasePrompt(project.research?.detailLine ?? '', projectPalette(project))
      } else {
        const index = Number.parseInt(file.replace(/\D+/g, ''), 10)
        const shot = Array.isArray(project.shots) ? project.shots[Math.max(0, index - 1)] : null
        const anchored = String(project.approvedBase ?? '') !== '' || String(project.referenceFile ?? '') !== ''
        prompt = shot
          ? (anchored
              ? referenceShotPrompt(shot, project.research?.detailLine ?? '', projectPalette(project))
              : shotPrompt(project.card, shot))
          : referenceBasePrompt(project.research?.detailLine ?? '', projectPalette(project))
      }
      const instruction = String(options.instruction ?? '').trim()
      if (instruction !== '') {
        prompt += `\n\nEDIT INSTRUCTION (apply exactly this change and keep the same person, face, pose, camera, costume and background otherwise): ${instruction}`
      }
      const seed = Math.floor(Math.random() * 2_147_483_000)
      const denoise = Number(options.denoise) > 0 ? Number(options.denoise) : 0.42
      const graph = imageToImageGraph(prompt, uploaded, graphSize, config, seed, denoise, `cosplay_${projectId}_edit`)
      const images = await runGraph(config.comfyPort, graph, { onProgress: itemProgress() })
      const bytes = await downloadImage(config.comfyPort, images[0])
      const extraNotes = Array.isArray(options.notes) ? options.notes : []
      if (fromBase) {
        const out = `base_edit_${Date.now()}_1.png`
        writeFileSync(join(dirs.base, out), bytes)
        const next = updateProject(projectId, {
          baseImages: [...(project.baseImages ?? []), out],
          status: 'awaiting-base-approval',
          notes: [...(project.notes ?? []), ...extraNotes, `微调基准图：${out}`],
        })
        return { projectId, target, file: out, baseImages: next?.baseImages ?? [] }
      }
      const history = join(dirs.raw, '.history')
      if (!existsSync(history)) mkdirSync(history, { recursive: true })
      renameSync(sourcePath, join(history, `${file}.${Date.now()}.png`))
      writeFileSync(sourcePath, bytes)
      const pending = [...new Set([...(project.pendingFinals ?? []), file])]
      updateProject(projectId, {
        status: 'generated',
        pendingFinals: pending,
        notes: [...(project.notes ?? []), ...extraNotes, `微调成片：${file}`],
      })
      return { projectId, target, file, pendingFinals: pending }
    },
    onError(message) {
      logLine(`微调失败（${projectId}）：${message}`, 'error')
    },
  })
}

/* ------------------------------------------------------------- finalize */

/**
 * Optional post-processing for the finished shots: JPEG export (near-original
 * quality), optional de-oil / body makeup, optional 2×2 preview + 文案 copy.
 * The raw PNGs in raw/ stay untouched, so this step can be re-run with
 * different options without regenerating anything.
 */
export function enqueueFinalize(config, layout, projectId, options = {}) {
  const deoil = options.deoil === true
  const makeup = options.makeup === true
  const flatten = options.flatten !== false
  const preview = options.preview !== false
  const copy = options.copy !== false
  return enqueue({
    id: `final-${projectId}`,
    label: deoil || makeup ? '去油光 / 导出成片' : '导出成片（JPEG + 预览 + 文案）',
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
          '--makeup', makeup ? '1' : '0',
          '--deoil', deoil ? '1' : '0',
          '--flatten', flatten ? '1' : '0',
          '--preview', preview ? '1' : '0',
          '--copy', copy ? '1' : '0',
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
        finalizeOptions: { deoil, makeup, flatten, preview, copy },
        completedAt: new Date().toISOString(),
        notes: report?.notes ?? [],
      })
      return { projectId, report }
    },
  })
}
