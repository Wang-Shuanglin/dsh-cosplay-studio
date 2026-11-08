// Storage + configuration for the Cosplay Studio plugin.
//
// Everything the plugin persists lives under <DSH_HOME>/data/dsh-cosplay-studio:
//   config.json          user settings (ComfyUI path, model names, LLM endpoint, consent)
//   setup-log.json       deployment log lines, newest last, capped
//   projects/<id>/       one cosplay project per character (character_card.txt, shots.json, images)
//   downloads/           ComfyUI portable archive + model files while downloading

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const PLUGIN_ID = 'dsh-cosplay-studio'
export const API_PREFIX = '/api/cosplay-studio'
// No trailing slash: the Web host matches a prefix route against
// `<prefix>/…`, so a trailing slash would make every real request miss and
// fall through to the SPA fallback (which answers 401).
export const MEDIA_PREFIX = `${API_PREFIX}/media`

export function dshHome() {
  const fromEnv = (process.env.DSH_HOME ?? '').trim()
  return fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

export const DATA_DIR = join(dshHome(), 'data', PLUGIN_ID)
export const CONFIG_PATH = join(DATA_DIR, 'config.json')
export const LOG_PATH = join(DATA_DIR, 'setup-log.json')
export const PROJECTS_DIR = join(DATA_DIR, 'projects')
export const DOWNLOADS_DIR = join(DATA_DIR, 'downloads')

export const DEFAULT_MODELS = {
  unetFile: 'z_image_turbo_int8_convrot.safetensors',
  unetUrl: 'https://hf-mirror.com/Comfy-Org/z_image_turbo/resolve/main/split_files/diffusion_models/z_image_turbo_int8_convrot.safetensors',
  clipFile: 'qwen_3_4b_fp8_mixed.safetensors',
  clipType: 'lumina2',
  clipUrl: 'https://hf-mirror.com/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b_fp8_mixed.safetensors',
  vaeFile: 'ae.safetensors',
  vaeUrl: 'https://hf-mirror.com/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors',
}

export function defaultConfig() {
  return {
    version: 2,
    // Deployment
    consented: false,
    consentAt: '',
    comfyDir: '',
    comfyPort: 8188,
    pythonExe: '',
    autoStart: true,
    // Models used by the Z-Image-Turbo workflow
    models: { ...DEFAULT_MODELS },
    // Optional OpenAI-compatible chat endpoint used to research a character and
    // to write the shooting script. Empty = the built-in rule based writer.
    llm: { baseUrl: '', apiKey: '', model: '' },
    // Generation defaults
    steps: 6,
    cfg: 2,
    shift: 3,
    sampler: 'res_multistep',
    scheduler: 'simple',
    baseSize: '1152x2048',
    finalSize: '1440x2560',
    // Tiled VAE round-trip in the refine pass; larger tiles avoid seams on a
    // flat paper backdrop, smaller tiles save VRAM on 8 GB cards.
    vaeTileSize: 1024,
    vaeOverlap: 128,
    // P7 de-oil (flatten crushed highlights) and P7b body makeup (even the
    // face-to-feet skin tone); skill runs P7 before P7b.
    deoil: true,
    bodyMakeup: true,
    makeupStrength: 0.35,
    legStrength: 0.85,
    // UI
    showSidebar: true,
    shotCount: 6,
    negative: 'extra toes, six toes, seven toes, four toes, fused toes, malformed feet, deformed feet, extra fingers, mutated hands, extra limbs, bad anatomy, disfigured, lowres, jpeg artifacts',
    // Workspace layout
    outputRoot: join(DATA_DIR, 'projects'),
  }
}

function deepMerge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return base
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && base !== null && typeof base[key] === 'object') {
      out[key] = deepMerge(base[key], value)
    } else if (value !== undefined) {
      out[key] = value
    }
  }
  return out
}

export function ensureDirs() {
  for (const dir of [DATA_DIR, PROJECTS_DIR, DOWNLOADS_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
}

export function readConfig() {
  ensureDirs()
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8')
    return deepMerge(defaultConfig(), JSON.parse(raw))
  } catch {
    return defaultConfig()
  }
}

export function writeConfig(config) {
  ensureDirs()
  const tmp = `${CONFIG_PATH}.tmp`
  writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8')
  renameSync(tmp, CONFIG_PATH)
  return config
}

export function patchConfig(patch) {
  return writeConfig(deepMerge(readConfig(), patch))
}

const MAX_LOG = 400
let logLines = []
let logLoaded = false

function loadLog() {
  if (logLoaded) return
  logLoaded = true
  try {
    const parsed = JSON.parse(readFileSync(LOG_PATH, 'utf8'))
    if (Array.isArray(parsed)) logLines = parsed.slice(-MAX_LOG)
  } catch {
    logLines = []
  }
}

export function setupLog() {
  loadLog()
  return logLines
}

export function logLine(text, level = 'info') {
  loadLog()
  const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  logLines.push({ t: stamp, level, text: String(text) })
  if (logLines.length > MAX_LOG) logLines = logLines.slice(-MAX_LOG)
  const tmp = `${LOG_PATH}.tmp`
  try {
    ensureDirs()
    writeFileSync(tmp, JSON.stringify(logLines), 'utf8')
    renameSync(tmp, LOG_PATH)
  } catch {
    // Logging must never break a deployment step.
  }
}

export function clearLog() {
  logLoaded = true
  logLines = []
  try {
    writeFileSync(LOG_PATH, '[]', 'utf8')
  } catch {
    // ignore
  }
}

export function slugify(text) {
  const cleaned = String(text ?? '').trim()
  if (cleaned === '') return 'untitled'
  return cleaned.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60)
}
