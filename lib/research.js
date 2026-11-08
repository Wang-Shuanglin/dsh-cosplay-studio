// Character research: the slow, staged "who is this character" step before the base image.
//
// Two entry modes share one pipeline:
//   name   → web search → download character / cosplay photos → vision analysis → rough draft
//   image  → vision analysis of the upload (+ optional cosplay photos) → rough draft
//
// The heavy lifting comes from the DSH host itself: ctx.web searches and fetches
// pages, ctx.llm (deepseek-account, image capable) reads pictures, the local
// ComfyUI renders a cheap 640×1024 draft. Every stage is written back to
// project.research so the panel can show 正在检索信息 / 正在分析特征 … while it runs.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_POSE, buildCard, defaultDetails, referenceBasePrompt, shotPrompt,
} from './card.js'
import {
  downloadImage, imageToImageGraph, resolveSize, runGraph, textToImageGraph, uploadImage,
} from './comfy.js'
import { logLine } from './paths.js'
import { projectDirs, readProject, updateProject } from './project.js'

const RESEARCH_IDLE = 15 * 60 * 1000
const MAX_DOWNLOADS = 4

/* --------------------------------------------------------------- the job */

/** Read a project's research block, marking a job stuck by a host restart as failed. */
export function researchState(project) {
  const research = project?.research
  if (!research) return null
  const started = Date.parse(research.startedAt ?? '')
  if (research.status === 'running' && Number.isFinite(started) && Date.now() - started > RESEARCH_IDLE) {
    return { ...research, status: 'failed', stageLabel: '研究被中断（宿主可能重启过），请重新研究' }
  }
  return research
}

const running = new Map()

/** Kick off research for one project. Returns the updated project immediately. */
export function startResearch(ctx, config, projectId, options = {}) {
  const project = readProject(projectId)
  if (project === null) throw new Error('项目不存在')
  if (running.has(projectId)) return project
  const job = runResearch(ctx, config, projectId, options)
    .catch((error) => {
      const message = error?.message ?? String(error)
      logLine(`角色研究失败（${projectId}）：${message}`, 'error')
      return updateProject(projectId, {
        research: {
          ...(readProject(projectId)?.research ?? {}),
          status: 'failed',
          stage: 'failed',
          stageLabel: '研究失败',
          error: message,
          finishedAt: new Date().toISOString(),
        },
        notes: [...(readProject(projectId)?.notes ?? []), `角色研究失败：${message}`],
      })
    })
    .finally(() => { running.delete(projectId) })
  running.set(projectId, job)
  return readProject(projectId)
}

function researchOf(projectId) {
  return readProject(projectId)?.research ?? { steps: [] }
}

/** Merge a research patch and a step log line into the project. */
function patchResearch(projectId, patch, step = null) {
  const project = readProject(projectId)
  if (project === null) return null
  const previous = project.research ?? { steps: [] }
  const steps = Array.isArray(previous.steps) ? [...previous.steps] : []
  if (step !== null) steps.push({ at: new Date().toISOString(), ...step })
  return updateProject(projectId, { research: { ...previous, ...patch, steps: steps.slice(-24) } })
}

/* ------------------------------------------------------------- pipeline */

async function runResearch(ctx, config, projectId, options = {}) {
  const project = readProject(projectId)
  if (project === null) throw new Error('项目不存在')
  const mode = project.source === 'image' && String(project.referenceFile ?? '') !== '' ? 'image' : 'name'
  const character = String(project.character ?? '')
  const series = String(project.series ?? '')

  patchResearch(projectId, {
    status: 'running',
    mode,
    stage: 'prepare',
    stageLabel: '准备研究角色…',
    startedAt: new Date().toISOString(),
    finishedAt: '',
    error: '',
    sources: [],
    images: [],
    features: null,
    summary: '',
    draft: '',
    detailLine: '',
  }, { label: '开始研究角色形象', status: 'done' })

  const sources = []
  const images = []

  /* 1. web search */
  try {
    patchResearch(projectId, { stage: 'search', stageLabel: '正在联网检索角色资料…' })
    const queries = mode === 'image'
      ? [character ? `${character} ${series}` : '']
      : [`${character} ${series}`, `${character} ${series} cosplay`]
    const results = []
    for (const query of queries.filter(Boolean)) {
      const found = await searchWeb(ctx, query)
      if (found === null) continue
      results.push({ query, found })
      for (const source of found.sources ?? []) {
        if (sources.length >= 12) break
        if (source?.url && !sources.some((item) => item.url === source.url)) {
          sources.push({ url: source.url, title: source.title ?? '', snippet: source.snippet ?? '' })
        }
      }
    }
    patchResearch(projectId, {
      sources,
      stageLabel: `检索完成，找到 ${sources.length} 条资料`,
    }, { label: `联网检索：${sources.length} 条资料`, status: 'done' })
    var searchResults = results
  } catch (error) {
    patchResearch(projectId, {}, { label: `联网检索失败：${error?.message ?? error}`, status: 'error' })
    var searchResults = []
  }

  /* 2. collect + download reference photos (each candidate is checked by the vision model) */
  try {
    if (mode === 'image' && options.supplement !== true) {
      patchResearch(projectId, { images: [], stageLabel: '参考图项目：外观以上传的参考图为准' }, { label: '参考图片：使用上传的参考图', status: 'done' })
    } else {
    const urls = []
    const push = (list) => {
      for (const url of list) if (!urls.includes(url)) urls.push(url)
    }
    // Image search first: quoted exact name avoids Bing fuzzy-matching a single
    // character of the name (薇斯纳 → 薇 → dictionary glyph pages).
    const imageQueries = imageSearchQueries(character, series)
    for (const query of imageQueries) {
      try {
        const page = await fetchPage(ctx, `https://www.bing.com/images/search?q=${encodeURIComponent(query)}`)
        if (page !== null) push(imagesFromHtml(page.html, page.url))
      } catch {
        // image search is best-effort
      }
    }
    // Article pages still help for cosplay write-ups with real photos, but they
    // are noisy, so the vision check below decides what is kept.
    const pages = new Set()
    const cosplay = character !== '' ? await searchWeb(ctx, `"${character}" ${series} cosplay`) : null
    const candidatePages = [
      ...(cosplay?.sources ?? []),
      ...searchResults.flatMap((item) => item.found?.sources ?? []),
    ]
    for (const source of candidatePages.slice(0, 4)) {
      if (pages.size >= 3) break
      if (!source?.url || pages.has(source.url) || !/^https?:/i.test(source.url)) continue
      pages.add(source.url)
      const page = await fetchPage(ctx, source.url)
      if (page === null) continue
      push(imagesFromHtml(page.html, source.url))
    }
    const unique = urls.slice(0, 24)
    patchResearch(projectId, { stage: 'images', stageLabel: `正在挑选角色参考图（0 张可用 / 已看 ${Math.min(unique.length, 20)} 张）…` })
    let attempts = 0
    for (const url of unique) {
      if (images.length >= MAX_DOWNLOADS || attempts >= 20) break
      attempts += 1
      const image = await downloadPicture(url)
      if (image === null) continue
      const verdict = await classifyReferenceImage(ctx, image, { character, series, mode })
      if (!verdict.usable) {
        patchResearch(projectId, {}, { label: `跳过：${verdict.kind}${verdict.reason ? `（${verdict.reason}）` : ''}`, status: 'done' })
        continue
      }
      const dir = projectDirs(projectId)
      const ext = image.mediaType === 'image/png' ? 'png' : image.mediaType === 'image/webp' ? 'webp' : 'jpg'
      const file = `research_${Date.now()}_${images.length + 1}.${ext}`
      writeFileSync(join(dir.refs, file), image.data)
      images.push({ file, url, width: image.width, height: image.height, kind: verdict.kind })
      patchResearch(projectId, {
        images: [...images],
        stageLabel: `正在挑选角色参考图（${images.length} 张可用 / 已看 ${attempts} 张）…`,
      }, { label: `采用参考图：${verdict.kind}（${image.width}×${image.height}）`, status: 'done' })
    }
    patchResearch(projectId, {}, { label: `参考图片：${images.length} 张可用`, status: images.length > 0 ? 'done' : 'error' })
    }
  } catch (error) {
    patchResearch(projectId, {}, { label: `下载参考图失败：${error?.message ?? error}`, status: 'error' })
  }

  /* 3. vision analysis */
  let features = null
  try {
    patchResearch(projectId, { stage: 'analyze', stageLabel: '正在分析外观特征…' })
    const inputs = []
    if (mode === 'image') {
      const projectNow = readProject(projectId)
      const reference = String(projectNow?.referenceFile ?? '')
      if (reference !== '') {
        const path = join(projectDirs(projectId).refs, reference)
        if (existsSync(path)) inputs.push({ data: readFileSync(path), mediaType: mediaTypeOf(reference), name: reference })
      }
    }
    for (const image of images.slice(0, 3)) {
      const path = join(projectDirs(projectId).refs, image.file)
      if (existsSync(path)) inputs.push({ data: readFileSync(path), mediaType: mediaTypeOf(image.file), name: image.file })
    }
    const snippets = searchResults
      .flatMap((item) => (item.found?.sources ?? []).map((source) => `${source.title ?? ''}：${source.snippet ?? ''}`))
      .filter((line) => line.trim() !== '')
      .slice(0, 12)
      .join('\n')
    const prompt = analysisPrompt({ character, series, mode, snippets })
    const text = await llmText(ctx, prompt, { images: inputs, maxTokens: 5000 })
    features = normalizeFeatures(parseJson(text))
    patchResearch(projectId, {
      features,
      summary: features.summary,
    }, { label: `外观分析完成：置信度 ${(features.confidence * 100).toFixed(0)}%`, status: 'done' })
  } catch (error) {
    patchResearch(projectId, {}, { label: `外观分析失败：${error?.message ?? error}`, status: 'error' })
  }

  /* 4. write the card + detail line */
  let details = null
  if (features !== null) {
    details = detailsFromFeatures(features, { character, series, mode })
    const card = buildCard(details)
    const dir = projectDirs(projectId)
    writeFileSync(join(dir.root, 'character_card.txt'), card, 'utf8')
    updateProject(projectId, {
      details,
      card,
      character: details.character || character,
      series: details.series || series,
      notes: [...(readProject(projectId)?.notes ?? []), `角色研究：${features.summary}`],
    })
  }
  const detailLine = features === null ? '' : compactDetails(features)
  patchResearch(projectId, { detailLine })

  /* 5. rough draft */
  try {
    patchResearch(projectId, { stage: 'draft', stageLabel: '正在生成粗略草图…' })
    const draft = await renderDraft(ctx, config, projectId, mode, details, detailLine)
    if (draft !== '') {
      patchResearch(projectId, { draft }, { label: `粗略草图已生成（${Math.round(draft.width / 10) * 10}×${draft.height}）`, status: 'done' })
    }
  } catch (error) {
    patchResearch(projectId, {}, { label: `草图失败（不影响继续）：${error?.message ?? error}`, status: 'error' })
  }

  const final = updateProject(projectId, {
    research: {
      ...(researchOf(projectId)),
      status: 'done',
      stage: 'done',
      stageLabel: '研究完成，可以确认特征并生成基准图',
      finishedAt: new Date().toISOString(),
    },
  })
  logLine(`角色研究完成（${projectId}）：${final?.research?.stageLabel ?? ''}`)
  return final
}

/* ----------------------------------------------------------- draft render */

async function renderDraft(ctx, config, projectId, mode, details, detailLine) {
  const port = Number(config.comfyPort)
  const reachable = await fetch(`http://127.0.0.1:${port}/system_stats`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok).catch(() => false)
  if (!reachable) return ''
  const project = readProject(projectId)
  if (project === null) return ''
  const dirs = projectDirs(projectId)
  const size = resolveSize('640x1024', '640x1024')
  const draftConfig = { ...config, steps: Math.max(3, Math.min(4, Number(config.steps) || 6)) }
  const seed = Math.floor(Math.random() * 2_147_483_000)
  let graph
  if (mode === 'image' && String(project.referenceFile ?? '') !== '') {
    const path = join(dirs.refs, project.referenceFile)
    if (!existsSync(path)) return ''
    const uploaded = await uploadImage(port, readFileSync(path), project.referenceFile)
    graph = imageToImageGraph(referenceBasePrompt(project.research?.detailLine ?? detailLine), uploaded, size, draftConfig, seed, 0.75, `cosplay_${projectId}_draft`)
  } else {
    const card = details === null ? (project.card ?? '') : buildCard(details)
    graph = textToImageGraph(card, size, draftConfig, seed, `cosplay_${projectId}_draft`)
  }
  const images = await runGraph(port, graph, {})
  const bytes = await downloadImage(port, images[0])
  const file = `draft_${Date.now()}.png`
  writeFileSync(join(dirs.research, file), bytes)
  return { file, width: 640, height: 1024 }
}

/* --------------------------------------------------------------- details */

function detailsFromFeatures(features, { character, series, mode }) {
  const base = defaultDetails(character, series, { reference: mode === 'image' })
  const palette = Array.isArray(features.palette) ? features.palette.filter((item) => String(item ?? '').trim() !== '') : []
  return {
    ...base,
    character: features.character || character,
    series: features.series || series,
    hair: features.hair || base.hair,
    face: features.face || base.face,
    eyeColor: features.eyes || base.eyeColor,
    costume: features.costume || base.costume,
    props: features.prop || base.props,
    paletteTop: palette[0] || base.paletteTop,
    paletteBottom: palette[1] || base.paletteBottom,
    personality: features.personality || base.personality,
    identity: features.identity || base.identity,
  }
}

function compactDetails(features) {
  return [features.hair, features.eyes, features.costume, features.accessories, features.prop]
    .map((item) => String(item ?? '').trim())
    .filter((item) => item !== '')
    .join(', ')
    .slice(0, 700)
}

/* -------------------------------------------------------------- llm chat */

export async function resolveModel(ctx) {
  const llm = ctx.get('llm')
  if (!llm) throw new Error('宿主没有 llm 服务')
  let provider = ''
  let model = ''
  try {
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    provider = String(selection?.provider ?? '')
    model = String(selection?.model ?? '')
  } catch {
    // fall through to the first image capable provider
  }
  let providers = []
  try {
    providers = await llm.listProviders()
  } catch {
    providers = []
  }
  if (!Array.isArray(providers)) providers = []
  if (provider === '' || model === '') {
    for (const entry of providers) {
      let models = []
      try {
        models = await llm.listModels(entry.id)
      } catch {
        models = []
      }
      if (!Array.isArray(models)) models = []
      const pick = models.find((item) => Array.isArray(item.inputModalities) && item.inputModalities.includes('image')) ?? models[0]
      if (pick) {
        provider = entry.id
        model = pick.id
        break
      }
    }
  }
  if (provider === '' || model === '') throw new Error('没有可用的对话模型')
  let imageCapable = false
  try {
    const models = await llm.listModels(provider)
    imageCapable = Array.isArray(models) && models.some((item) => item.id === model && Array.isArray(item.inputModalities) && item.inputModalities.includes('image'))
  } catch {
    imageCapable = false
  }
  return { llm, provider, model, imageCapable }
}

export async function llmText(ctx, prompt, { images = [], maxTokens = 1200 } = {}) {
  const { llm, provider, model, imageCapable } = await resolveModel(ctx)
  const attachments = ctx.get('attachments')
  const content = []
  let usable = []
  if (imageCapable && attachments && images.length > 0) {
    for (const image of images.slice(0, 4)) {
      try {
        const ref = await attachments.saveImage({ data: new Uint8Array(image.data), mediaType: image.mediaType, name: image.name })
        content.push({ type: 'image', attachment: ref })
        usable.push(image.name)
      } catch {
        // skip an image the store refuses; text alone still helps
      }
    }
  }
  content.push({ type: 'text', text: prompt })
  let text = ''
  let failure = ''
  for await (const chunk of llm.stream({ provider, model, messages: [{ role: 'user', content }], maxTokens })) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    else if (chunk?.type === 'finish' && chunk.reason?.kind && chunk.reason.kind !== 'success') {
      failure = chunk.reason.failure?.message ?? `对话模型返回 ${chunk.reason.kind}`
      // A truncated JSON answer is still usable when the object closed in time.
      if (text.trim() === '') throw new Error(failure)
    }
  }
  if (text.trim() === '') throw new Error(failure || '对话模型没有返回内容')
  return text.trim()
}

function analysisPrompt({ character, series, mode, snippets }) {
  return `你是真人 cosplay 摄影的角色设定分析员。根据${mode === 'image' ? '用户上传的参考图（以及补充的图片资料）' : '联网检索到的资料和参考图片'}，提取这位角色在真人摄影里必须还原的外观特征。

角色：${character}${series ? `（作品：${series}）` : ''}

${snippets ? `检索到的文字资料（可能不完整，仅供核对）：\n${snippets}\n` : ''}
只输出一个 JSON 对象，不要输出解释、思考过程或 Markdown 代码块。字段全部是字符串（palette 是字符串数组）：
{
  "character": "角色通用名",
  "series": "作品名，未知填空字符串",
  "summary": "中文两三句：发型发色、瞳色、服装主色与结构、标志道具、性格",
  "hair": "英文：发型+发色+长度+发饰，具体到分缝和碎发",
  "eyes": "英文：瞳色与眼型",
  "face": "英文：脸型、眉、鼻、唇的真人化描述",
  "costume": "英文：服装逐件（上装/下装/外套/腰带/袜/鞋），含材质和颜色",
  "accessories": "英文：配饰，没有填空字符串",
  "prop": "英文：单手可握的标志道具；没有写 empty hands",
  "palette": ["英文背景上色", "英文背景下色"],
  "personality": "英文三个形容词",
  "identity": "英文身份短语",
  "distinct": "英文：任何标志性细节（纹样、宝石、翅膀、机械关节等）",
  "confidence": 0.0,
  "notes": "中文：哪些细节你不确定"
}`
}

function normalizeFeatures(value) {
  const source = value !== null && typeof value === 'object' ? value : {}
  const text = (key, fallback = '') => String(source[key] ?? fallback).trim()
  const palette = Array.isArray(source.palette) ? source.palette.map((item) => String(item ?? '').trim()).filter((item) => item !== '') : []
  return {
    character: text('character'),
    series: text('series'),
    summary: text('summary'),
    hair: text('hair'),
    eyes: text('eyes'),
    face: text('face'),
    costume: text('costume'),
    accessories: text('accessories'),
    prop: text('prop'),
    palette,
    personality: text('personality'),
    identity: text('identity'),
    distinct: text('distinct'),
    confidence: Math.max(0, Math.min(1, Number(source.confidence) || 0)),
    notes: text('notes'),
  }
}

export function parseJson(text) {
  const raw = String(text).replace(/```(?:json)?/gi, '')
  const start = raw.search(/[[{]/)
  const end = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']'))
  if (start < 0 || end <= start) throw new Error('分析结果里没有 JSON')
  return JSON.parse(raw.slice(start, end + 1))
}

/* ------------------------------------------------------- web + pictures */

async function searchWeb(ctx, query) {
  const web = ctx.get('web')
  if (!web) throw new Error('宿主没有 web 检索服务')
  // ctx.web.search needs a DeepSeek credential. A plugin HTTP handler has no
  // initiating agent session, so the account token is unavailable; fall back to
  // fetching a public search page through the credential-free fetch provider.
  try {
    if (typeof web.searchReady !== 'function' || await web.searchReady('deepseek-account')) {
      const result = await web.search({ query, maxResults: 6 })
      if (Array.isArray(result?.sources) && result.sources.length > 0) return result
    }
  } catch {
    // fall through to the HTML search
  }
  const html = await searchPageHtml(ctx, query)
  return { sources: parseSearchHtml(html), truncated: false }
}

async function searchPageHtml(ctx, query) {
  // Bing's HTML endpoint works without credentials; DuckDuckGo blocks the host.
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`
  try {
    const web = ctx.get('web')
    if (web && typeof web.fetch === 'function') {
      const page = await web.fetch({ url })
      if (page && page.statusCode < 400) {
        const body = String(page.body?.content ?? '')
        if (parseSearchHtml(body).length > 0) return body
      }
    }
  } catch {
    // fall through to a direct request
  }
  const response = await fetch(url, { headers: BROWSER_HEADERS })
  if (!response.ok) throw new Error(`搜索页返回 ${response.status}`)
  return response.text()
}

const BROWSER_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
}

/** Extract result links + snippets from a DuckDuckGo or Bing HTML page. */
function parseSearchHtml(html) {
  const text = String(html ?? '')
  const decode = (value) => String(value)
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  const strip = (value) => decode(String(value).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
  const sources = []
  const push = (url, title, snippet) => {
    let target = decode(url).trim()
    if (target.startsWith('//')) target = `https:${target}`
    const uddg = /[?&]uddg=([^&]+)/.exec(target)
    if (uddg) target = decodeURIComponent(uddg[1])
    if (!/^https?:/i.test(target) || sources.some((item) => item.url === target)) return
    sources.push({ url: target, title: strip(title).slice(0, 160), snippet: strip(snippet).slice(0, 300) })
  }
  // DuckDuckGo HTML results.
  const ddg = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  let match
  const ddgLinks = []
  while ((match = ddg.exec(text)) !== null) ddgLinks.push({ url: match[1], title: match[2] })
  const snippets = [...text.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map((item) => item[1])
  ddgLinks.forEach((link, index) => push(link.url, link.title, snippets[index] ?? ''))
  if (sources.length > 0) return sources
  // Bing organic results: one <li class="b_algo"> block per result.
  const blocks = text.split(/<li class="b_algo"/).slice(1)
  for (const block of blocks) {
    const link = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block)
    if (!link) continue
    const snippet = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block)
    push(link[1], link[2], snippet ? snippet[1] : '')
  }
  return sources
}

async function fetchPage(ctx, url) {
  const web = ctx.get('web')
  if (web && typeof web.fetch === 'function') {
    try {
      const page = await web.fetch({ url })
      if (page && page.statusCode < 400) {
        const html = String(page.body?.content ?? '')
        if (html.trim() !== '') return { html, url }
      }
    } catch {
      // fall through to a direct request
    }
  }
  try {
    const response = await fetch(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(20_000) })
    if (!response.ok) return null
    return { html: await response.text(), url }
  } catch {
    return null
  }
}

const BLOCKED_IMAGE_HOSTS = /(?:hanyuguoxue\.com|zdic\.net|gushici\.net|hanyu\.baidu\.com|zidian)/i

/** Image-search queries: the quoted exact name keeps Bing from matching one
 *  character of the name (薇斯纳 → 薇 → dictionary glyphs / plant photos). */
function imageSearchQueries(character, series) {
  const name = String(character ?? '').trim()
  if (name === '') return []
  const exact = `"${name}"`
  const work = String(series ?? '').trim()
  const suffix = work === '' ? '' : ` ${work}`
  return [
    `${exact}${suffix} cosplay`,
    `${exact}${suffix} 立绘`,
    `${exact}${suffix}`,
  ]
}

/**
 * Vision check for one downloaded candidate. Keeping a text screenshot or a
 * landscape photo poisons the analysis pass, so ask the model before saving.
 * If the model is unavailable the picture is accepted (research must not fail
 * just because the check cannot run).
 */
async function classifyReferenceImage(ctx, image, { character, series }) {
  try {
    const target = String(character ?? '').trim() === ''
      ? '（项目没有给出角色名，按上传的参考图判断）'
      : `目标角色：${String(character).trim()}${String(series ?? '').trim() === '' ? '' : `，作品：${String(series).trim()}`}`
    const prompt = `你在为真人 cosplay 项目挑选角色外观参考图。${target}

看这张图片，判断它能否作为角色的外观参考：角色立绘、官方设定图、动画/游戏截图、真人 cosplay 正片都算可用；文字截图、字典字帖、风景照、商品广告、无关人物、纯色/图标不算。
只输出一个 JSON 对象，不要解释：
{"usable":true,"kind":"character_art|cosplay|text|scenery|object|other","reason":"一句中文理由"}`
    const text = await llmText(ctx, prompt, { images: [image], maxTokens: 300 })
    const parsed = parseJson(text)
    return {
      usable: parsed?.usable === true,
      kind: String(parsed?.kind ?? 'other'),
      reason: String(parsed?.reason ?? '').slice(0, 60),
    }
  } catch {
    return { usable: true, kind: 'unverified', reason: '' }
  }
}

function imagesFromHtml(html, baseUrl) {
  const urls = []
  // Bing image results encode the full-size URL in an HTML-escaped JSON blob.
  const patterns = [/murl&quot;:&quot;([^&]+?)&quot;/g, /"murl":"([^"]+)"/g]
  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(html)) !== null && urls.length < 16) {
      const raw = String(match[1]).replace(/\\u002f/gi, '/').replace(/\\\//g, '/')
      if (/^https?:/i.test(raw) && !BLOCKED_IMAGE_HOSTS.test(raw) && !urls.includes(raw)) urls.push(raw)
    }
  }
  const imgPattern = /<img[^>]+(?:src|data-src|data-original|srcset)="([^"]+)"/gi
  let imgMatch
  while ((imgMatch = imgPattern.exec(html)) !== null && urls.length < 16) {
    const raw = imgMatch[1].split(' ')[0].trim()
    if (raw === '' || raw.startsWith('data:') || /\.svg(\?|$)/i.test(raw)) continue
    try {
      const absolute = new URL(raw, baseUrl).toString()
      if (/\.(jpe?g|png|webp)(\?|$)/i.test(absolute) && !urls.includes(absolute)) urls.push(absolute)
    } catch {
      // ignore malformed URLs
    }
  }
  return urls
}

async function downloadPicture(url) {
  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        accept: 'image/avif,image/webp,image/png,image/jpeg,*/*',
      },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) return null
    const mediaType = String(response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (!/^image\/(png|jpe?g|webp)$/.test(mediaType)) return null
    const length = Number(response.headers.get('content-length'))
    if (Number.isFinite(length) && length > 12 * 1024 * 1024) return null
    const data = Buffer.from(await response.arrayBuffer())
    if (data.length < 40 * 1024 || data.length > 12 * 1024 * 1024) return null
    const size = imageDimensions(data)
    if (size === null || Math.min(size.width, size.height) < 320) return null
    return { data, mediaType: mediaType === 'image/jpg' ? 'image/jpeg' : mediaType, ...size }
  } catch {
    return null
  }
}

function imageDimensions(buffer) {
  if (buffer.length > 24 && buffer[0] === 0x89 && buffer[1] === 0x50) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue }
      const marker = buffer[offset + 1]
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
      }
      offset += 2 + buffer.readUInt16BE(offset + 2)
    }
  }
  if (buffer.length > 30 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = buffer.toString('latin1', 12, 16)
    if (chunk === 'VP8X') return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) }
  }
  return null
}

function mediaTypeOf(name) {
  const ext = String(name).slice(String(name).lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  return 'image/jpeg'
}

/* ------------------------------------------------------------- random pick */

const RANDOM_SYSTEM = `你是一个真人 cosplay 选题策划。根据给定的近期热门资料，选一个外观辨识度高、适合做成真人 cosplay 套图的角色。只输出一个 JSON 对象，不要输出思考过程或 Markdown：{"character":"角色通用名","series":"作品名","reason":"一句中文理由"}。角色一律按 18 岁以上成年人处理。`

/** Pick a random but popular character from web results, then create + research it. */
export async function createRandomProject(ctx, config) {
  const found = await searchWeb(ctx, '2025 2026 热门 二次元 游戏 角色 cosplay 人气 排行')
  const snippets = (found?.sources ?? [])
    .map((source) => `${source.title ?? ''}：${source.snippet ?? ''}`)
    .filter((line) => line.trim() !== '')
    .slice(0, 15)
    .join('\n')
  if (snippets === '' && !found?.content) throw new Error('联网检索没有返回内容')
  const text = await llmText(ctx, `${RANDOM_SYSTEM}\n\n资料：\n${snippets || String(found?.content ?? '').slice(0, 4000)}`, { maxTokens: 1500 })
  const pick = parseJson(text)
  const character = String(pick.character ?? '').trim()
  if (character === '') throw new Error('模型没有选出角色')
  const series = String(pick.series ?? '').trim()
  return { character, series, reason: String(pick.reason ?? '') }
}

export { DEFAULT_POSE, referenceBasePrompt, shotPrompt }
