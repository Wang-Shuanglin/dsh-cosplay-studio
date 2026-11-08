// Hot-character proposals (skill P0 entry C): no name and no reference image.
//
// A curated pool of characters that were heavily cosplayed recently, each with
// enough card fields to build a real prompt without any model call. When the
// user configured a chat model we additionally ask it for a few current picks
// and merge them in; the curated pool stays the offline fallback.

import { chatComplete, llmConfigured } from './card.js'

export const HOT = [
  {
    character: 'Raiden Shogun', series: 'Genshin Impact', tags: ['原神', '和风', '高冷'],
    hook: '刚结束一场检阅，她停在原地，抬手按住被风吹乱的发梢。',
    palette: ['pale lilac', 'deep indigo violet'], skinTone: 'warm light beige',
    hair: 'long straight deep violet hair gathered into a low ponytail, a blunt fringe across the brow, one loose lock framing the cheek',
    costume: 'a fitted purple and white kimono-style bodice with a dark violet obi, detached wide sleeves showing the shoulders, a long purple skirt slit at the sides, dark tights and black lacquered sandals, a golden hairpin and a small violet gem at the collar',
    props: 'a folded paper fan', personality: 'composed, authoritative, quietly warm',
    identity: 'the ruler of a storm-wrapped nation', element: 'lightning',
  },
  {
    character: 'Hu Tao', series: 'Genshin Impact', tags: ['原神', '古灵精怪'],
    hook: '她像刚想起一个坏主意，斜着头看向镜头，指尖敲着帽檐。',
    palette: ['deep crimson', 'charcoal grey'], skinTone: 'warm light beige',
    hair: 'long dark brown hair in twin low tails with red tips, a wide black hat with a red plum blossom ornament',
    costume: 'a dark brown mandarin-collar jacket with red trim and a plum blossom emblem, wide sleeves, a short black pleated skirt over dark shorts, brown leather boots and a red tassel at the waist',
    props: 'a small paper lantern', personality: 'playful, mischievous, sharp',
    identity: 'the director of a funeral parlour', element: 'pyro',
  },
  {
    character: 'Ganyu', series: 'Genshin Impact', tags: ['原神', '清冷', '仙气'],
    hook: '她低头整理袖口的流苏，抬眼时刚好对上镜头。',
    palette: ['pale ice blue', 'soft periwinkle'], skinTone: 'cool fair porcelain',
    hair: 'long pale blue hair with a slight wave, a side-swept fringe, two small horns rising from the crown and a silver hairpin',
    costume: 'a white and pale blue changshan-style bodice with a high collar, a fitted blue skirt with a long pale back panel, gold trim, a dark blue sash and white boots',
    props: 'a small bell', personality: 'gentle, reserved, dutiful',
    identity: 'a half-qilin secretary of a celestial court', element: 'cryo',
  },
  {
    character: 'Furina', series: 'Genshin Impact', tags: ['原神', '华丽', '戏剧感'],
    hook: '她刚结束一段独白，裙摆还停在转身的半空。',
    palette: ['pearl white', 'pale aqua'], skinTone: 'cool fair porcelain',
    hair: 'short pale blue hair with soft curls at the ends, a small dark blue top hat tilted to one side',
    costume: 'a white and deep blue stage costume with a high ruffled collar, puffed sleeves, a corset-like bodice with gold buttons, a layered short skirt over a longer ruffled petticoat, white gloves and blue heeled boots',
    props: 'a small conductor baton', personality: 'theatrical, proud, fragile underneath',
    identity: 'a beloved stage idol of a water city', element: 'hydro',
  },
  {
    character: 'Yae Miko', series: 'Genshin Impact', tags: ['原神', '御姐', '狐'],
    hook: '她半坐在矮桌上，垂眼看着镜头，像在等你先开口。',
    palette: ['soft pink', 'deep violet'], skinTone: 'warm light beige',
    hair: 'long pink hair with a blunt fringe, low twin tails bound in red cords, two pointed fox ears',
    costume: 'a white and purple shrine maiden outfit with detached wide sleeves, a red and purple obi, a short purple skirt, white tabi socks and red sandals, a golden bell ornament',
    props: 'a folding fan', personality: 'elegant, teasing, dangerous',
    identity: 'the head shrine maiden of a fox shrine', element: 'electro',
  },
  {
    character: 'Nahida', series: 'Genshin Impact', tags: ['原神', '清新', '少女感'],
    hook: '她蹲下来看一朵不存在的花，然后抬头笑了一下。',
    palette: ['pale mint', 'soft sage grey'], skinTone: 'warm light beige',
    hair: 'short white hair with pale green tips, a small braid at the side and a leaf-shaped hairpin',
    costume: 'a white and green dress with a high collar, layered leaf-shaped panels at the waist, puffed short sleeves, white stockings and green boots',
    props: 'a small glowing leaf', personality: 'curious, gentle, wise',
    identity: 'a young-looking forest deity', element: 'dendro',
  },
  {
    character: 'Yelan', series: 'Genshin Impact', tags: ['原神', '御姐', '神秘'],
    hook: '她把骰子抛起又接住，视线一直没有离开你。',
    palette: ['deep teal', 'charcoal navy'], skinTone: 'warm light beige',
    hair: 'asymmetric dark blue-black hair, short on one side and long on the other, a thin braid and a red cord',
    costume: 'a dark teal sleeveless bodice with a high collar, a white shirt panel underneath, a fitted black skirt with a high slit, a fur-trimmed short cape, black tights and heeled boots',
    props: 'a pair of dice', personality: 'sly, confident, in control',
    identity: 'an intelligence broker', element: 'hydro',
  },
  {
    character: 'Shenhe', series: 'Genshin Impact', tags: ['原神', '冷冽', '仙气'],
    hook: '她站在空旷处一动不动，只有衣袖在风里轻轻起伏。',
    palette: ['ice white', 'pale slate blue'], skinTone: 'cool fair porcelain',
    hair: 'long icy white hair in a high ponytail with a braided crown, a long fringe over one brow',
    costume: 'a white and pale blue sleeveless bodice with a high collar, detached flowing sleeves, a long pale skirt with a high slit, silver ornaments and white boots',
    props: 'a talisman slip', personality: 'aloof, restrained, protective',
    identity: 'a disciple raised in the mountains', element: 'cryo',
  },
  {
    character: 'Changli', series: 'Wuthering Waves', tags: ['鸣潮', '烈焰', '御姐'],
    hook: '她抬手收起一枚火苗，火光在指缝里消失。',
    palette: ['deep crimson', 'charcoal navy'], skinTone: 'warm honey beige',
    hair: 'long dark red hair with loose waves, a side part and a golden hairpin',
    costume: 'a fitted dark red cheongsam-inspired outfit with gold trim, a high slit skirt, wide sleeves with flame embroidery, a black sash, thigh-high dark stockings and heeled boots',
    props: 'a burning feather', personality: 'composed, warm, decisive',
    identity: 'a wandering flame adept', element: 'fire',
  },
  {
    character: 'Jinhsi', series: 'Wuthering Waves', tags: ['鸣潮', '端庄', '东方'],
    hook: '她刚看完一份卷宗，把纸页轻轻按在桌上。',
    palette: ['pale jade', 'deep teal green'], skinTone: 'cool fair porcelain',
    hair: 'long black hair half-bound with a jade ornament, a straight fringe and two long ribbons',
    costume: 'an elegant white and jade green dress with a high collar, layered translucent outer panels, gold embroidery, a wide sash and white heeled shoes',
    props: 'a jade tablet', personality: 'composed, thoughtful, steady',
    identity: 'the magistrate of a coastal city', element: 'light',
  },
  {
    character: 'Firefly', series: 'Honkai: Star Rail', tags: ['崩铁', '清透', '甜'],
    hook: '她坐在台阶边缘，抬头时眼睛亮了一下。',
    palette: ['pale sky blue', 'soft white'], skinTone: 'cool fair porcelain',
    hair: 'shoulder-length pale silver hair with a soft fringe, a small blue ribbon at one side',
    costume: 'a white and pale blue dress with a sailor-like collar, a layered pleated skirt, a thin blue belt, white thigh-high socks and blue and white sneakers',
    props: 'a small paper crane', personality: 'gentle, hopeful, a little shy',
    identity: 'a girl who travels with a stellaron hunter', element: 'fire',
  },
  {
    character: 'Sparkle', series: 'Honkai: Star Rail', tags: ['崩铁', '疯批', '戏剧'],
    hook: '她戴着面具歪头看你，面具下面的笑藏不住。',
    palette: ['cherry red', 'pale cream'], skinTone: 'warm light beige',
    hair: 'long dark red twin tails with pale highlights, a small black hat with a red ribbon',
    costume: 'a red and cream harlequin-inspired dress with puffed sleeves, a corset bodice, asymmetric layered skirt panels, black gloves, mismatched stockings and heeled boots',
    props: 'a fox mask', personality: 'playful, unpredictable, theatrical',
    identity: 'a masked performer', element: 'quantum',
  },
  {
    character: 'Acheron', series: 'Honkai: Star Rail', tags: ['崩铁', '冷艳', '御姐'],
    hook: '她撑着伞站在雨里，伞沿压低，只露出半张脸。',
    palette: ['deep violet', 'near black'], skinTone: 'cool fair porcelain',
    hair: 'long dark purple hair with straight cut ends, a blunt fringe and a single red hair ornament',
    costume: 'a black and violet sleeveless coat-dress with a high collar, a long asymmetric hem, silver clasps, black gloves, a dark sash and tall black boots',
    props: 'a long katana resting point-down', personality: 'calm, distant, unstoppable',
    identity: 'a nameless swordsman', element: 'lightning',
  },
  {
    character: 'Jingliu', series: 'Honkai: Star Rail', tags: ['崩铁', '冷冽', '剑'],
    hook: '她刚收剑入鞘，冰霜还在剑锋上碎开。',
    palette: ['pale ice blue', 'deep navy'], skinTone: 'cool fair porcelain',
    hair: 'long pale blue-white hair in a high ponytail, a dark ribbon and a straight fringe',
    costume: 'a white and dark blue fitted bodice with a high collar, detached flowing sleeves, a long layered skirt with a dark outer panel, silver ornaments and white boots',
    props: 'a slender ice sword', personality: 'cold, disciplined, sorrowful',
    identity: 'a swordmaster of a frozen order', element: 'ice',
  },
  {
    character: 'Kafka', series: 'Honkai: Star Rail', tags: ['崩铁', '御姐', '危险'],
    hook: '她把墨镜往下推了一点，越过镜框看着你。',
    palette: ['magenta', 'charcoal black'], skinTone: 'warm light beige',
    hair: 'long deep magenta hair with a side part and a single loose wave over one shoulder',
    costume: 'a black fitted bodice with a deep neckline under a cropped black jacket, a long black coat with a purple lining, tight black trousers, a thin belt and heeled boots',
    props: 'a small pistol', personality: 'controlled, amused, merciless',
    identity: 'a hunter who collects destinies', element: 'lightning',
  },
  {
    character: 'Silver Wolf', series: 'Honkai: Star Rail', tags: ['崩铁', '电竞', '酷'],
    hook: '她拿下耳机，随手把掌机往腿上一放。',
    palette: ['soft grey', 'electric violet'], skinTone: 'cool fair porcelain',
    hair: 'short silver-blue hair in a messy bob with a long strand over the face, a star-shaped hair clip',
    costume: 'an oversized grey and violet hoodie with a star print, a black crop top, black shorts over fishnet tights, chunky sneakers and an ID lanyard',
    props: 'a handheld console', personality: 'sarcastic, playful, brilliant',
    identity: 'a hacker who bends reality', element: 'quantum',
  },
  {
    character: 'Ruan Mei', series: 'Honkai: Star Rail', tags: ['崩铁', '知性', '清冷'],
    hook: '她从实验记录上抬起眼睛，笔尖停在半空。',
    palette: ['plum purple', 'pale champagne'], skinTone: 'cool fair porcelain',
    hair: 'long dark brown hair with a soft fringe, a loose low bun and a jade hairpin',
    costume: 'a plum and ivory cheongsam-inspired bodice with a high collar, a fitted long skirt with a high slit, a translucent outer robe, gold trim and heeled boots',
    props: 'a glass vial', personality: 'curious, detached, precise',
    identity: 'a biologist of creation', element: 'ice',
  },
  {
    character: 'Frieren', series: 'Frieren: Beyond Journey\'s End', tags: ['芙莉莲', '魔法', '安静'],
    hook: '她蹲在路边盯着一株普通的草，像在研究一门新魔法。',
    palette: ['soft white', 'muted sage green'], skinTone: 'cool fair porcelain',
    hair: 'long silver-white hair in twin low tails with a straight fringe, pointed elf ears',
    costume: 'a white blouse with a small collar under a long pale gold coat with a high back collar, a dark teal short cape, a white skirt, dark leggings and brown boots',
    props: 'a small grimoire', personality: 'calm, curious, detached',
    identity: 'a thousand-year-old elf mage', element: 'magic',
  },
  {
    character: 'Fern', series: 'Frieren: Beyond Journey\'s End', tags: ['芙莉莲', '少女', '魔法'],
    hook: '她把魔杖收进袖子里，皱着眉看你一眼。',
    palette: ['soft purple', 'pale cream'], skinTone: 'warm light beige',
    hair: 'shoulder-length purple hair with a straight fringe and two small side tails',
    costume: 'a white blouse under a dark purple short cape, a purple skirt with a white apron panel, dark stockings and brown boots',
    props: 'a wooden staff', personality: 'practical, blunt, loyal',
    identity: 'a young human mage', element: 'magic',
  },
  {
    character: 'Ai Hoshino', series: 'Oshi no Ko', tags: ['我推的孩子', '偶像', '闪'],
    hook: '她把手举到脸旁比了个心，眼睛弯成一条线。',
    palette: ['soft pink', 'pearl white'], skinTone: 'cool fair porcelain',
    hair: 'long pink hair with pale highlights and a side braid, a star-shaped hair ornament and a white hairband',
    costume: 'a white and pink idol stage dress with puffed sleeves, a corset bodice, a layered frilled skirt, a pink ribbon at the back, white gloves and white heeled boots',
    props: 'a handheld microphone', personality: 'radiant, fragile, magnetic',
    identity: 'an idol who lights up the stage', element: 'star',
  },
  {
    character: 'Hitori Gotoh', series: 'Bocchi the Rock!', tags: ['孤独摇滚', '社恐', '青春'],
    hook: '她抱着吉他缩在角落，发现被拍了才慌忙抬头。',
    palette: ['soft pink', 'charcoal grey'], skinTone: 'warm light beige',
    hair: 'long dark pink hair with a straight fringe, a blue and yellow hair clip and a long strand over the face',
    costume: 'a pink and black tracksuit jacket over a white tee, a short pleated skirt, black over-knee socks and white sneakers',
    props: 'an electric guitar', personality: 'anxious, sincere, talented',
    identity: 'a bedroom guitarist', element: 'sound',
  },
  {
    character: 'Lucy', series: 'Cyberpunk: Edgerunners', tags: ['赛博朋克', '未来', '冷'],
    hook: '她摘下透明面罩，霓虹灯从侧脸划过去。',
    palette: ['neon cyan', 'deep night black'], skinTone: 'cool fair porcelain',
    hair: 'short pale cyan hair with shaved sides and a long strand over the cheek, a thin headset frame',
    costume: 'a black and white high-collar bodysuit jacket with neon accents, a short black skirt, a transparent raincoat, cybernetic markings on the arms and dark boots',
    props: 'a small cyberdeck', personality: 'cold, guarded, tender',
    identity: 'a netrunner who runs the edge', element: 'net',
  },
  {
    character: '2B', series: 'NieR: Automata', tags: ['尼尔', '机械', '冷艳'],
    hook: '她收起武器，裙摆在转身时划出一道弧。',
    palette: ['deep black', 'pale ivory'], skinTone: 'cool fair porcelain',
    hair: 'short silver-white bob hair with a straight fringe, a black hairband and a beauty mark under the mouth',
    costume: 'a black and ivory combat dress with a high collar, a cut-out chest panel with a white ruffled underlayer, puffed short sleeves with white cuffs, a short pleated skirt over white under-shorts, white gloves, black over-knee boots',
    props: 'a slender white blade', personality: 'reserved, dutiful, quietly kind',
    identity: 'an android soldier', element: 'steel',
  },
  {
    character: 'A2', series: 'NieR: Automata', tags: ['尼尔', '野性', '战斗'],
    hook: '她把湿发往后一撩，长刀已经搭在肩上。',
    palette: ['moss green', 'charcoal black'], skinTone: 'warm light beige',
    hair: 'long tangled white hair left loose, a straight fringe over one eye',
    costume: 'a torn black and white combat garment with a cut-out chest, a ragged long skirt over shorts, black gloves, bandages on the arms and dark boots',
    props: 'a chipped longsword', personality: 'feral, angry, grieving',
    identity: 'a rogue android prototype', element: 'steel',
  },
  {
    character: 'Amiya', series: 'Arknights', tags: ['明日方舟', '指挥', '沉静'],
    hook: '她放下终端，指尖还停在耳边的通讯器上。',
    palette: ['deep blue', 'smoky grey'], skinTone: 'warm light beige',
    hair: 'long dark brown hair with pointed ears, a straight fringe and a black headband',
    costume: 'a black and blue military-style coat with a high collar, a white shirt underneath, a short pleated skirt, thigh-high black stockings and ankle boots, a round command emblem at the collar',
    props: 'a folded tactical map', personality: 'steady, compassionate, burdened',
    identity: 'the commander of a mobile force', element: 'originium arts',
  },
  {
    character: 'Texas', series: 'Arknights', tags: ['明日方舟', '利落', '酷'],
    hook: '她夹着一支没点燃的烟，抬眼看过来。',
    palette: ['deep crimson', 'charcoal grey'], skinTone: 'warm light beige',
    hair: 'short dark hair with a long side strand and a small braid, animal ears',
    costume: 'a black coat over an orange shirt, a dark vest, slim black trousers with a holster belt and short boots',
    props: 'a lighter', personality: 'quiet, blunt, dependable',
    identity: 'a courier with a shadowed past', element: 'sword arts',
  },
  {
    character: 'Shiroko', series: 'Blue Archive', tags: ['蔚蓝档案', '清爽', '枪'],
    hook: '她把步枪背好，抬手压住被风掀起的发梢。',
    palette: ['soft white', 'pale cobalt blue'], skinTone: 'cool fair porcelain',
    hair: 'short grey-blue hair with a straight fringe and pale blue highlights, wolf ears',
    costume: 'a white and navy sailor-style uniform with a blue collar, a wide navy skirt, a dark ribbon at the chest, white over-knee socks and navy sneakers',
    props: 'a compact rifle', personality: 'earnest, straightforward, dependable',
    identity: 'a member of a school countermeasure club', element: 'tactics',
  },
  {
    character: 'Malenia', series: 'Elden Ring', tags: ['艾尔登法环', '神话', '悲壮'],
    hook: '她扶住空荡荡的肩，铠甲缝隙里透出金色微光。',
    palette: ['deep burgundy', 'charcoal grey'], skinTone: 'warm light beige',
    hair: 'long flowing red hair escaping from under a gold-trimmed helmet',
    costume: 'ornate gold and burgundy plate armour with a flowing cloak, a prosthetic golden arm, a high-collared cape and armoured boots',
    props: 'a long golden katana', personality: 'proud, sorrowful, unyielding',
    identity: 'a blade of a dying golden order', element: 'rot',
  },
]

const SKIN_TONES = ['warm light beige', 'cool fair porcelain', 'warm honey beige']

function shuffle(list) {
  const out = [...list]
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1))
    ;[out[index], out[swap]] = [out[swap], out[index]]
  }
  return out
}

/** Card fields for a curated entry, ready to pass to buildCard(). */
export function hotDetails(entry, fallbackCharacter = '') {
  return {
    character: entry.character || fallbackCharacter,
    series: entry.series || '',
    genderWord: 'woman',
    hair: entry.hair,
    face: 'a soft oval face with a soft jawline, dark almond eyes with the outer corner slightly upturned, gently arched brows, a small straight nose, soft coral lips with the lower lip slightly fuller',
    eyeColor: 'dark brown',
    skinTone: entry.skinTone || SKIN_TONES[0],
    costume: entry.costume,
    paletteTop: entry.palette?.[0] || 'ivory white',
    paletteBottom: entry.palette?.[1] || 'dusty rose',
    props: entry.props || 'empty hands',
    personality: entry.personality || 'composed, quietly confident, a little guarded',
    identity: entry.identity || 'a traveller between worlds',
    element: entry.element || 'light',
  }
}

const RECOMMEND_SYSTEM = `你是 cosplay 摄影策划。请给出当前(最近一年)在中文互联网上被大量 cosplay、适合做成真人写实 cosplay 套图的女性角色。
只输出 JSON：{"characters":[{"character":"角色中文名","series":"作品中文名","hook":"一句中文情境，能看出她的性格或标志动作"}]}
要求：3 个；角色必须 18 岁以上成人外形；不要同一部作品出现两次；不要编造角色。`

let llmCache = { at: 0, list: [] }

/** Ask the configured chat model for current picks; fall back to the curated pool. */
async function llmPicks(config, count) {
  if (!llmConfigured(config)) return []
  if (Date.now() - llmCache.at < 10 * 60 * 1000 && llmCache.list.length >= count) return llmCache.list
  try {
    const answer = await chatComplete(config, RECOMMEND_SYSTEM, '请给出 3 个推荐角色。')
    const start = answer.indexOf('{')
    const end = answer.lastIndexOf('}')
    const parsed = start >= 0 && end > start ? JSON.parse(answer.slice(start, end + 1)) : null
    const list = Array.isArray(parsed?.characters) ? parsed.characters : []
    const cleaned = list
      .map((item) => ({ character: String(item?.character ?? '').trim(), series: String(item?.series ?? '').trim(), hook: String(item?.hook ?? '').trim() }))
      .filter((item) => item.character !== '')
    if (cleaned.length > 0) {
      llmCache = { at: Date.now(), list: cleaned }
      return cleaned
    }
  } catch {
    // the curated pool below is the fallback
  }
  return []
}

/**
 * Recommend `count` characters. Curated picks from the pool are always included
 * (they carry full card fields); model picks are merged on top when configured.
 */
export async function recommend(config, count = 3) {
  const pool = shuffle(HOT).slice(0, Math.max(1, Math.min(6, count)))
  const picks = pool.map((entry) => ({
    character: entry.character,
    series: entry.series,
    hook: entry.hook,
    tags: entry.tags ?? [],
    palette: entry.palette,
    source: 'curated',
    details: hotDetails(entry),
  }))
  const extra = await llmPicks(config, count)
  for (const item of extra) {
    if (picks.some((pick) => pick.character === item.character)) continue
    const entry = HOT.find((candidate) => candidate.character === item.character)
    picks.push({
      character: item.character,
      series: item.series,
      hook: item.hook,
      tags: ['模型推荐'],
      palette: entry?.palette ?? ['ivory white', 'dusty rose'],
      source: 'model',
      details: entry === undefined
        ? { ...hotDetails({ character: item.character, series: item.series, hair: '', costume: '', props: '' }), character: item.character, series: item.series }
        : hotDetails(entry),
    })
  }
  return picks
}
