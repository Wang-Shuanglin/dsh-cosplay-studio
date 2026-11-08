// Character card + shot script: the textual core of the cosplay-photo-set skill (v2.1).
//
// The card is a nine-paragraph English prompt (opening + BACKDROP / AGE / HEAD AND
// HAIR / FACE / SKIN / COSTUME / POSE / HANDS / LIGHTING) whose POSE paragraph is
// the only placeholder. Every shot reuses the card verbatim and swaps only the POSE
// line, which is what keeps the same face / costume / backdrop across the whole set.
//
// When the user configured an OpenAI-compatible chat model the plugin asks it for
// the character details and for the shooting script; otherwise it falls back to the
// rule based writer below (character name + palette + safe poses).

// Fixed by the skill: only this sentence reliably keeps the feet inside the frame.
const FRAMING = 'full-length portrait on a clean seamless paper backdrop, framed from a distance of a few steps so the whole figure fits inside the frame, the body occupying about two thirds of the frame height, with a generous strip of empty backdrop above her head and a wide strip of empty floor below her shoes.'

export const DEFAULT_POSE = 'standing in a relaxed three-quarter turn toward the camera, weight on the back leg, chin slightly lowered, eyes meeting the lens, shoulders relaxed'

// HANDS is a fixed paragraph in v2.1 — it never changes across shots.
export const DEFAULT_HANDS = 'exactly five fingers on each hand, fingers clearly separated, natural knuckles, no extra or fused fingers'

// Poses with a turned body tend to crop the legs. This sentence rides along in
// the POSE line so every shot still frames the whole figure head to shoes.
const POSE_FRAMING = 'The entire figure stays inside the frame from the top of the head down to the shoes, with empty backdrop above the head and empty floor around the feet.'

// Backdrops stay off the beige / sand / terracotta corner of the colour wheel:
// the P7b body-makeup mask treats low-saturation tan as skin, so a skin-toned
// paper backdrop gets brightened and left with visible streaks.
const PALETTES = [
  ['ivory white', 'dusty rose'],
  ['sky blue', 'pale grey'],
  ['soft lilac', 'deep plum'],
  ['mint green', 'sage grey'],
  ['cherry red', 'pale grey'],
  ['midnight navy', 'silver grey'],
  ['rose pink', 'mauve'],
  ['teal green', 'charcoal grey'],
]

const SKIN_TONES = ['warm light beige', 'cool fair porcelain', 'warm honey beige']

const DEFAULT_BANGS = 'fine feathery bangs lifted slightly off the forehead'

const DEFAULT_FACE = 'a soft oval face with a soft jawline, dark brown almond eyes with the outer corner slightly upturned, gently arched brows, a small straight nose, soft coral lips with the lower lip slightly fuller'

function hashText(text) {
  let hash = 0
  for (const char of String(text)) hash = (hash * 31 + char.codePointAt(0)) % 1_000_003
  return hash
}

export function defaultDetails(character, series = '') {
  const palette = PALETTES[hashText(character + series) % PALETTES.length]
  return {
    character: String(character ?? '').trim() || 'a mysterious heroine',
    series: String(series ?? '').trim(),
    genderWord: 'woman',
    hair: 'long straight jet-black hair falling past the shoulder blades, the ends cleanly cut, a few fine strands framing the jaw',
    face: DEFAULT_FACE,
    eyeColor: 'dark brown',
    skinTone: SKIN_TONES[hashText(character) % SKIN_TONES.length],
    bangsRule: DEFAULT_BANGS,
    eyeCover: '',
    braid: '',
    costume: `a faithful, well-made cosplay rendition of ${String(character ?? 'the character').trim()}'s signature outfit, covering the exact top, skirt or trousers, sleeves, belt and accessories, made in fabric and leather with visible stitching, believable material weight and clean seams, worn over a natural body with realistic proportions, together with the character's matching boots worn on both feet and, where the design calls for them, her gloves`,
    paletteTop: palette[0],
    paletteBottom: palette[1],
    props: 'empty hands',
    personality: 'composed, quietly confident, a little guarded',
    identity: 'a wandering swordswoman',
    element: 'wind',
  }
}

export function buildCard(details) {
  const d = { ...defaultDetails(details.character ?? '', details.series ?? ''), ...details }
  const from = d.series ? ` from ${d.series}` : ''
  const bangs = String(d.bangsRule ?? '').trim()
  const eyeCover = String(d.eyeCover ?? '').trim()
  const braid = String(d.braid ?? '').trim()
  const skinTone = String(d.skinTone ?? '').trim() || 'warm light beige'
  return [
    `Photorealistic live-action cosplay photograph of a real 18-year-old East Asian ${d.genderWord} cosplaying ${d.character}${from}, ${FRAMING}`,
    '',
    `BACKDROP: a flat seamless paper backdrop with an extremely smooth vertical gradient from ${d.paletteTop} at the top to ${d.paletteBottom} at the bottom, colors taken from the character's signature palette, perfectly smooth, evenly lit and completely empty, the shot contains only the person against the empty backdrop.`,
    '',
    'AGE: eighteen years old, young adult, fresh youthful face, adolescent-to-young-adult proportions, no mature adult styling, no heavy grown-up makeup.',
    '',
    `HEAD AND HAIR: ${d.hair}.${bangs === '' ? '' : ` ${bangs}.`}${eyeCover === '' ? '' : ` ${eyeCover}`} The forehead is kept smooth and clear, no dark patches, no markings.${braid === '' ? '' : ` ${braid}`} The crown is smooth and flat against the head, the hair hanging down in clean smooth locks close to the body, built from very fine thin individual strands, softly separated with soft light between them, matte with no plastic sheen, no greasy clumps, no wet-look shine.`,
    '',
    `FACE: young East Asian bone structure of an eighteen-year-old, ${d.face}, ${d.eyeColor ?? 'dark brown'} eyes of natural size (not oversized, not doll eyes), thin natural eyeliner, soft coral lips. Realistic skin with visible fine pores, one clean natural warm skin tone, dry powder-matte finish on the face, shoulders, arms and back, skin looks freshly powdered like a real cosplayer at a shoot. No beauty retouching, no airbrushing.`,
    '',
    `SKIN: one even ${skinTone} skin tone with a soft peach undertone from her face all the way down to her feet, the neck, shoulders, arms, thighs, knees, shins, ankles and the tops of her feet all the same healthy tone, softly powdered and evenly toned like a sheer body foundation, gentle natural shading kept along the calves and knees, smooth clear skin with fine real texture, the legs warm and softly lit, the same tone as her face, like a cosplayer who has applied body makeup before the shoot.`,
    '',
    `COSTUME: ${d.costume}.`,
    '',
    `POSE: ${DEFAULT_POSE}.`,
    '',
    `HANDS: ${DEFAULT_HANDS}.`,
    '',
    'LIGHTING AND CAMERA: soft key light from camera left slightly above eye level, soft fill from the right, gentle falloff, even exposure with natural skin tone, highlights are soft and controlled. Sony A7R IV, 85mm f/1.8, ISO 800, shallow depth of field, fine film grain. The face and eyes are tack-sharp and in critical focus, no motion blur on the subject, the backdrop stays a smooth even gradient top to bottom. Ultra photorealistic, looks like a real person photographed at a cosplay shoot, not anime, not illustration, not 3D render, no plastic waxy skin. Vertical 9:16 composition.',
  ].join('\n')
}

/** Replace only the POSE line; HANDS / every other paragraph stays verbatim. */
export function shotPrompt(card, shot) {
  const pose = String(shot.pose ?? '').trim() || DEFAULT_POSE
  const hands = String(shot.hands ?? '').trim()
  const props = String(shot.props ?? '').trim()
  const parts = [pose]
  if (hands !== '') parts.push(hands)
  parts.push(
    props === '' || /^(no props|empty hands|none)$/i.test(props)
      ? 'her hands are empty and relaxed'
      : `she holds ${props} lightly in one hand`,
  )
  if (!/inside the frame/i.test(pose)) parts.push(POSE_FRAMING)
  const line = parts.join('. ').replace(/\.\.+/g, '.').replace(/\.$/, '')
  return card.replace(/^POSE: .*$/m, `POSE: ${line}.`)
}

/* --------------------------------------------------------------- script */

const SHOT_ARCHETYPES = [
  {
    type: 'A 情绪特写',
    title: '迎向镜头的瞬间',
    situation: 'the first second of meeting the viewer, before she has decided how to react',
    expression: 'lips slightly parted, eyes open and direct, a trace of guarded curiosity',
    pose: 'standing square to the camera, chin level, shoulders relaxed, weight even on both feet',
    hands: 'hands loose at her sides, fingers softly curled',
    camera: 'eye level, a few steps back, the full figure centred with air above and below',
    props: 'empty hands',
  },
  {
    type: 'B 不看她',
    title: '侧身望向远处',
    situation: 'she has turned slightly away and is looking past the frame at something we cannot see',
    expression: 'calm, faintly wistful, mouth closed',
    pose: 'body in a three-quarter turn away from the camera, head turned further to the side, one shoulder forward',
    hands: 'one hand resting lightly at her waist, the other hanging relaxed',
    camera: 'slightly off-axis to the side, same distance, full figure',
    props: 'empty hands',
  },
  {
    type: 'C 动态抓拍',
    title: '转身的余韵',
    situation: 'caught mid-motion just after a turn, hair and clothes still settling',
    expression: 'a small confident half-smile, eyes bright',
    pose: 'mid-step with one foot forward, torso twisted a little, hair and hem swinging',
    hands: 'one hand lifted to chest height with fingers open, the other swung back',
    camera: 'slightly lower than eye level, same framing distance',
    props: 'empty hands',
  },
  {
    type: 'D 标志动作 + 道具',
    title: '握着她的标志物',
    situation: 'she has just taken hold of her signature prop and is holding it ready',
    expression: 'steady, focused, a quiet confidence',
    pose: 'standing with the body angled, one hand raised to hold the prop at chest height',
    hands: 'the prop held lightly in one hand, the other hand relaxed at her side',
    camera: 'eye level, a step closer so the prop reads clearly in the frame',
    props: 'the character signature prop',
  },
  {
    type: 'E 极端机位',
    title: '从高处俯视',
    situation: 'seen from a high angle a few steps above her, the backdrop filling the frame around her',
    expression: 'looking up at the camera, calm and a little defiant',
    pose: 'standing still with her chin lifted, one hand on her hip, weight on one leg',
    hands: 'one hand on her hip, the other loose at her side',
    camera: 'high angle from slightly above, looking down, the whole figure kept inside the frame',
    props: 'empty hands',
  },
  {
    type: 'F 坐蹲卧',
    title: '坐在地上的片刻',
    situation: 'sitting on the floor in the middle of the backdrop, taking a quiet break',
    expression: 'relaxed, soft gaze lifted to the lens',
    pose: 'sitting on the floor with both knees drawn up and her arms wrapped around her shins, head tipped slightly to one side',
    hands: 'both hands clasped loosely around her knees',
    camera: 'slightly above her eye level, close enough to fill the frame with her while keeping both shoes inside',
    props: 'empty hands',
  },
]

/** Rule based script: the six archetypes, no model required. */
export function ruleScript(details, count = 6) {
  const wanted = Math.max(1, Math.min(SHOT_ARCHETYPES.length, Number(count) || 6))
  return SHOT_ARCHETYPES.slice(0, wanted).map((shot, index) => ({
    id: index + 1,
    type: shot.type,
    title: shot.title,
    situation: shot.situation,
    expression: shot.expression,
    pose: shot.pose,
    hands: shot.hands,
    camera: shot.camera,
    props: shot.props === 'the character signature prop' ? (details?.props || 'empty hands') : shot.props,
    prompt: `${shot.type}｜${shot.title}`,
  }))
}

/* --------------------------------------------------------- model helpers */

export function llmConfigured(config) {
  const llm = config?.llm ?? {}
  return typeof llm.baseUrl === 'string' && llm.baseUrl.trim() !== ''
    && typeof llm.model === 'string' && llm.model.trim() !== ''
}

/** One OpenAI-compatible chat completion. Throws on any failure. */
export async function chatComplete(config, system, user, timeoutMs = 120_000) {
  const llm = config.llm
  const base = String(llm.baseUrl).trim().replace(/\/+$/, '')
  const endpoint = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(llm.apiKey ? { authorization: `Bearer ${llm.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: llm.model,
        temperature: 0.8,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`对话模型返回 HTTP ${response.status}`)
    const data = await response.json()
    const text = data?.choices?.[0]?.message?.content
    if (typeof text !== 'string' || text.trim() === '') throw new Error('对话模型没有返回内容')
    return text.trim()
  } finally {
    clearTimeout(timer)
  }
}

function extractJson(text) {
  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i)
  const raw = fenced ? fenced[1] : String(text)
  const start = raw.search(/[[{]/)
  const end = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']'))
  if (start < 0 || end <= start) throw new Error('回复里没有 JSON')
  return JSON.parse(raw.slice(start, end + 1))
}

const DETAILS_SYSTEM = `你是「真人 cosplay 影棚」的角色情报整理员。给定角色名与作品名，输出这个角色的摄影可用设定，只输出一个 JSON 对象，不要解释。

硬性要求：
1. 角色一律按 18 岁以上成年人处理；不写任何年龄之外的性化描述。
2. 只写「画面里要出现什么」的正向描述。禁止出现 not / no / without / avoid 这类负向句，禁止把「不要的东西」写出来（写了反而会被画进画面）。
3. 禁止出现摄影棚器材实景词：softbox、light stand、strobe、reflector、studio、wide-angle、spotlight、vignette。
4. 背景永远是纯色渐变纸幕，不写任何实景、道具、家具、窗、植物；渐变颜色必须避开米色、沙色、驼色、浅棕这类与肤色接近的颜色，改用紫、蓝、粉、绿、深红、灰等有明确色相的颜色（否则后期身体化妆的肤色遮罩会把背景一起提亮，留下脏边）。
5. 服装逐件写清楚：上装、下装/裙、外套、腰带、袜、鞋、配饰，含材质与主色；有标志性靴子/手套必须写进 costume。
6. props 描一个能单手轻握的标志道具；没有就写 empty hands。
7. 所有描述都用英文，只有 note 用中文。

JSON 字段（全部字符串）：
{
  "character": "角色英文名",
  "series": "作品英文名，未知则空字符串",
  "genderWord": "woman 或 man",
  "hair": "发型发色，含长度、分缝、碎发、发饰",
  "bangsRule": "有刘海写 fine feathery bangs lifted slightly off the forehead；无刘海写 center-parted and swept back off the face",
  "eyeCover": "有一只眼被遮住时写一句英文（例 a long soft fringe swept low across her right brow and falling straight over her right eye, that one eye hidden behind the fringe, the rest of her face clear and her left eye open）；不遮眼写空字符串",
  "braid": "有细辫写一句英文（例 one slim braid falling in front of her right shoulder）；没有写空字符串",
  "eyeColor": "瞳色英文，例如 dark brown",
  "face": "脸型、眼型、眉、鼻、唇，含 18 岁的骨骼感",
  "skinTone": "warm light beige 或 cool fair porcelain 或 warm honey beige（按角色肤色冷暖选一个）",
  "costume": "整套服装逐件描述：上装、下装/裙、外套、腰带、袜、鞋、配饰，含材质与颜色",
  "paletteTop": "背景渐变上方颜色（英文颜色词，取自角色配色）",
  "paletteBottom": "背景渐变下方颜色",
  "props": "标志性道具的英文描述；没有写 empty hands",
  "personality": "性格三词（英文）",
  "identity": "身份设定（英文短语）",
  "element": "元素/能力（英文短语）",
  "note": "一句中文备注：你判断最难还原的一件配饰"
}`

const SCRIPT_SYSTEM = `你是真人 cosplay 棚拍的摄影指导。给定角色设定，设计一组镜头脚本，只输出 JSON 数组，不要解释。

硬性要求：
1. 每一镜必须同时给出六项：情境（situation）、表情（expression）、动作（pose）、手（hands）、机位（camera）、道具（props）。
2. 差异化：表情不重样；至少一镜不看镜头；机位至少两种；手的位置每镜不同；动作里包含站、坐/蹲、动态抓拍、道具镜头中的至少三种。
3. 姿势必须完整落在画面内：全身从头到鞋，头顶留空、脚下留地；不要写只拍半身或裁掉腿的机位。
4. 只写正向画面，禁止 not / no / without 这类负向句；禁止摄影棚器材实景词（softbox、light stand、strobe、reflector、studio、spotlight）。
5. 手部宁少勿多：能一手扶腰、一手垂放就够；道具只写单手轻握的一件；没有道具写 empty hands。
6. 角色一律 18 岁以上成年人；不写性化、暴露或暗示性动作。
7. 每组 4–6 镜，全部英文（type 与 title 用中文，title 不超过 12 个字）。

每镜字段：
{"type":"A 情绪特写|B 不看她|C 动态抓拍|D 标志动作 + 道具|E 极端机位|F 坐蹲卧","title":"中文小标题","situation":"...","expression":"...","pose":"...","hands":"...","camera":"...","props":"..."}`

/** Ask the chat model for the character details (throws when unavailable). */
export async function researchCharacter(config, { character, series = '' } = {}) {
  if (!llmConfigured(config)) throw new Error('未配置对话模型')
  const user = [
    `角色：${character}`,
    series ? `作品：${series}` : '作品：如果不确定，按这个角色最知名的作品写',
    '按系统提示输出一个 JSON 对象。',
  ].join('\n')
  const text = await chatComplete(config, DETAILS_SYSTEM, user)
  const parsed = extractJson(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('角色情报不是对象')
  return {
    ...defaultDetails(character, series),
    ...parsed,
    character: String(parsed.character ?? character).trim() || character,
    series: String(parsed.series ?? series).trim(),
  }
}

/** Ask the chat model for the shot script (throws when unavailable). */
export async function writeScript(config, details, count = 6) {
  if (!llmConfigured(config)) throw new Error('未配置对话模型')
  const user = [
    `角色：${details?.character ?? ''}（${details?.series || '作品未知'}）`,
    `性格：${details?.personality ?? ''}`,
    `身份：${details?.identity ?? ''}`,
    `元素/能力：${details?.element ?? ''}`,
    `标志道具：${details?.props ?? 'empty hands'}`,
    `镜头数量：${count}`,
    '按系统提示输出 JSON 数组。',
  ].join('\n')
  const text = await chatComplete(config, SCRIPT_SYSTEM, user)
  const list = extractJson(text)
  if (!Array.isArray(list) || list.length === 0) throw new Error('脚本不是数组')
  return list.slice(0, 8).map((item, index) => {
    const type = String(item.type ?? '').trim() || `${String.fromCharCode(65 + index)} 镜头`
    const title = String(item.title ?? '').trim() || `镜头${index + 1}`
    return {
      id: index + 1,
      type,
      title,
      situation: String(item.situation ?? '').trim(),
      expression: String(item.expression ?? '').trim(),
      pose: String(item.pose ?? '').trim(),
      hands: String(item.hands ?? '').trim(),
      camera: String(item.camera ?? '').trim(),
      props: String(item.props ?? 'empty hands').trim() || 'empty hands',
      prompt: `${type}｜${title}`,
    }
  })
}
