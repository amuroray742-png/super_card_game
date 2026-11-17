/**
 * 遗物图标生成器。
 *
 * 遗物原本**完全没有图标**：RelicDef 没有 icon 字段，界面只能显示
 * 「稀有度标签 + 名称」——60 件遗物在仓库里长得一模一样，玩家认不出哪件是哪件。
 *
 * 本脚本产出 60 张**确定性程序化 SVG 徽章**（`public/relics/<defId>.svg`）：
 *   - 底色 / 外环 / 角标 → **稀有度**（SSR 最厚重，N 最素淡）
 *   - 中央大符号 + 内圈色 → **套装**（12 套各一个原创几何符号与专属色，
 *     让「这套能不能凑 2/4/6 件」一眼可辨——套装是核心玩法，图标必须服务它）
 *   - 底部小徽 → **主词条类型**（攻 / 防 / 生 / 速 / 暴 / 暴伤）
 *   - 底纹斜纹角度 → **遗物 id 的确定性哈希**（同一 id 恒定产出同一张图）
 *
 * 全部符号均为**原创几何图形**，不引用任何现成作品符号（合规要求）。
 * 路径口径由 `src/core/config/art.ts` 的 `relicIconPath()` 独家产出，
 * 表现层禁止自行拼接 `/relics/xxx.svg`（AGENTS.md 铁律 #8）。
 *
 * 后续若要接 AI 生图，只需按同名规则产出 PNG 并改 `RELIC_ICON_EXT`，
 * 界面与逻辑都不用动（美术与逻辑解耦，与英灵卡面同一套路）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RELICS, RELIC_SET_INDEX } from '../../src/core/config/relics.ts'
import { hashSeed } from '../../src/core/rng.ts'
import type { Rarity, StatKey } from '../../src/core/model/types.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const RELIC_DIR = join(ROOT, 'public/relics')

mkdirSync(RELIC_DIR, { recursive: true })

/** 稀有度调色盘：底色 / 边框 / 文字 / 外环宽度（遗物偏"器物"质感，比头像更沉） */
const RARITY_PALETTE: Record<
  Rarity,
  { bg: [string, string]; border: string; text: string; ring: number }
> = {
  SSR: { bg: ['#3A2A12', '#6B4A18'], border: '#F0D089', text: '#FFF6DC', ring: 5 },
  SR: { bg: ['#17293F', '#2F4A72'], border: '#A8CBF2', text: '#EAF3FF', ring: 4 },
  R: { bg: ['#16302A', '#2E5A49'], border: '#8FD6AE', text: '#E6FFF2', ring: 3 },
  N: { bg: ['#232329', '#3A3A44'], border: '#A8A8B3', text: '#EDEDF2', ring: 2 },
}

/**
 * 套装专属色（12 套）。
 *
 * 色相刻意拉开距离：相邻两套在仓库里并排出现时不能撞色，
 * 否则玩家会把「四件套进度」看错。
 */
const SET_COLORS: Record<string, string> = {
  set_zhanshen: '#E05B4B',
  set_bingjie: '#6FC3E8',
  set_jiangtun: '#C98F3F',
  set_shangzhan: '#9AA6BC',
  set_tanpo: '#B37BE8',
  set_liuhe: '#E2C25A',
  set_huichun: '#7FD08A',
  set_shengming: '#4FBF8B',
  set_jixie: '#E8964A',
  set_lingqi: '#5FD2D2',
  set_xuanwu: '#6E7FA8',
  set_qingming: '#A8E86A',
}

/**
 * 套装符号（12 个原创几何图形，画在中央 64×64 区域，坐标基准 0..64）。
 *
 * 全部为自绘几何，不引用现成符号或标志。
 */
const SET_GLYPHS: Record<string, string> = {
  // 战神：上挑双角
  set_zhanshen:
    'M12 46 L26 18 L32 34 L38 18 L52 46 L32 36 Z',
  // 冰界：六角霜枝
  set_bingjie:
    'M32 8 L36 24 L52 16 L44 32 L60 32 L44 40 L52 56 L36 44 L32 60 L28 44 L12 56 L20 40 L4 32 L20 24 L12 8 L28 20 Z',
  // 疆土：层叠山台
  set_jiangtun: 'M32 10 L50 32 L14 32 Z M14 38 L50 38 L50 48 L14 48 Z M20 54 L44 54 L44 62 L20 62 Z',
  // 尚战：十字方章
  set_shangzhan: 'M26 10 L38 10 L38 26 L54 26 L54 38 L38 38 L38 54 L26 54 L26 38 L10 38 L10 26 L26 26 Z',
  // 探破：梭形洞察之眼
  set_tanpo: 'M32 10 L54 32 L32 54 L10 32 Z M32 22 L42 32 L32 42 L22 32 Z',
  // 六合：六边环
  set_liuhe: 'M32 8 L54 20 L54 44 L32 56 L10 44 L10 20 Z M32 18 L22 24 L22 38 L32 44 L42 38 L42 24 Z',
  // 回春：双芽
  set_huichun:
    'M32 58 L32 34 M32 34 C32 22 22 16 12 18 C14 30 22 36 32 36 Z M32 34 C32 24 40 18 50 20 C48 30 40 36 32 36 Z',
  // 生命：环中十字
  set_shengming:
    'M32 8 A24 24 0 1 1 31.9 8 Z M27 27 L37 27 L37 20 L41 20 L41 32 L48 32 L48 36 L41 36 L41 48 L37 48 L37 37 L27 37 L27 32 L20 32 L20 28 L27 28 Z',
  // 机括：轮齿
  set_jixie:
    'M32 8 L38 8 L39 15 L45 13 L50 17 L47 23 L54 25 L54 31 L47 32 L50 38 L45 42 L39 40 L38 47 L32 47 L31 40 L25 42 L20 38 L23 32 L16 31 L16 25 L23 24 L20 18 L25 13 L31 15 Z M32 22 A10 10 0 1 0 32.1 22 Z',
  // 灵气：三重灵弧
  set_lingqi: 'M10 46 A24 24 0 0 1 54 46 M16 38 A18 18 0 0 1 48 38 M22 30 A12 12 0 0 1 42 30 L32 18 Z',
  // 玄武：龟甲网格
  set_xuanwu:
    'M32 8 L52 20 L52 44 L32 56 L12 44 L12 20 Z M32 8 L32 56 M12 20 L52 44 M52 20 L12 44 M12 32 L52 32',
  // 青冥：双羽
  set_qingming: 'M12 52 L26 14 L32 30 L38 12 L54 50 L32 40 Z M26 14 L32 30 M38 12 L32 30',
}

/**
 * 主词条符号（6 种，原创几何，画在底部小徽里，坐标基准 0..32）。
 */
const STAT_GLYPHS: Record<StatKey, string> = {
  // 攻：交叉双刃
  atk: 'M6 4 L26 28 L20 30 L4 12 Z M26 4 L6 28 L12 30 L28 12 Z',
  // 防：盾
  def: 'M16 3 L28 8 L28 18 C28 25 23 29 16 30 C9 29 4 25 4 18 L4 8 Z',
  // 生：心
  hp: 'M16 29 C4 21 3 13 8 8 C13 3 18 6 16 11 C14 6 19 3 24 8 C29 13 28 21 16 29 Z',
  // 速：风羽
  spd: 'M3 12 L16 12 L13 5 L26 14 L13 23 L16 16 L3 16 Z M20 22 L29 22 L27 17 L34 23 L27 29 L29 24 L20 24 Z',
  // 暴：四角星芒
  crit: 'M16 2 L20 12 L30 8 L24 16 L32 20 L21 21 L16 31 L12 21 L2 20 L10 15 L4 8 L13 12 Z',
  // 暴伤：爆裂环
  cdmg: 'M16 5 L20 12 L27 8 L25 15 L31 19 L23 22 L24 29 L17 25 L12 30 L11 23 L4 21 L10 16 L7 9 L14 12 Z',
}

/** 稀有度角标文字 */
const RARITY_LABEL: Record<Rarity, string> = { SSR: 'SSR', SR: 'SR', R: 'R', N: 'N' }

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * 生成一张遗物图标。
 *
 * @param defId  遗物定义 id（文件名与路径口径都用它）
 * @param name   遗物名（写进 aria-label，无障碍用）
 * @param rarity 稀有度
 * @param setId  套装 id
 * @param stat   主词条类型（取第一条主词条）
 */
function relicSvg(
  defId: string,
  name: string,
  rarity: Rarity,
  setId: string,
  stat: StatKey,
): string {
  const pal = RARITY_PALETTE[rarity]
  const setColor = SET_COLORS[setId] ?? '#C9C9D2'
  const setGlyph = SET_GLYPHS[setId] ?? SET_GLYPHS.set_shangzhan
  const statGlyph = STAT_GLYPHS[stat] ?? STAT_GLYPHS.atk

  const seed = hashSeed(defId)
  const stripeAngle = seed % 90
  const stripeOffset = seed % 40
  // 角标字号随标签长度收窄（SSR 三个字要更小才塞得进圆里）
  const rarityFontSize = RARITY_LABEL[rarity].length >= 3 ? 11 : RARITY_LABEL[rarity].length === 2 ? 13 : 16
  // 装饰点：按 id 哈希落在外环上（同一 id 恒定）
  const dots = Array.from({ length: 3 }, (_, i) => {
    const angle = ((seed >> (i * 3)) % 12) * 30 - 180
    const rad = (angle * Math.PI) / 180
    const x = 64 + Math.cos(rad) * 54
    const y = 64 + Math.sin(rad) * 54
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${i === 0 ? 2.8 : 2}" fill="${pal.border}" fill-opacity="${0.8 - i * 0.15}"/>`
  }).join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128" role="img" aria-label="${esc(name)}图标">
  <defs>
    <radialGradient id="bg" cx="38%" cy="30%" r="78%">
      <stop offset="0%" stop-color="${pal.bg[1]}"/>
      <stop offset="100%" stop-color="${pal.bg[0]}"/>
    </radialGradient>
    <pattern id="stripes" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(${stripeAngle})">
      <rect width="7" height="14" fill="#FFFFFF" opacity="0.04"/>
    </pattern>
    <clipPath id="disc">
      <circle cx="64" cy="64" r="58"/>
    </clipPath>
  </defs>

  <!-- 底盘 -->
  <circle cx="64" cy="64" r="58" fill="url(#bg)"/>
  <g clip-path="url(#disc)">
    <rect width="128" height="128" fill="url(#stripes)" transform="translate(${stripeOffset} 0)"/>
  </g>

  <!-- 套装内圈：细描边 + 淡色晕，让套装归属一眼可辨 -->
  <circle cx="64" cy="64" r="44" fill="${setColor}" fill-opacity="0.12"/>
  <circle cx="64" cy="64" r="44" fill="none" stroke="${setColor}" stroke-opacity="0.55" stroke-width="1.5"/>

  <!-- 中央套装符号（上移，让位给底部的主词条小徽） -->
  <g transform="translate(31 20)" fill="${setColor}" fill-opacity="0.95" fill-rule="evenodd">
    <path d="${setGlyph}"/>
  </g>

  <!-- 主词条小徽（底部） -->
  <g transform="translate(47 82)">
    <circle cx="17" cy="17" r="17" fill="#000000" fill-opacity="0.55" stroke="${pal.border}" stroke-opacity="0.55" stroke-width="1.5"/>
    <g transform="translate(3.4 3.4) scale(0.9)" fill="${pal.text}" fill-opacity="0.96" fill-rule="evenodd">
      <path d="${statGlyph}"/>
    </g>
  </g>

  <!-- 外环装饰点 -->
  ${dots}

  <!-- 稀有度外环 -->
  <circle cx="64" cy="64" r="58" fill="none" stroke="${pal.border}" stroke-width="${pal.ring}" stroke-opacity="0.9"/>

  <!-- 稀有度角标 -->
  <g transform="translate(92 30)">
    <circle r="16" fill="#000000" fill-opacity="0.62" stroke="${pal.border}" stroke-opacity="0.85" stroke-width="2"/>
    <text y="5" text-anchor="middle" font-family="'Songti SC','SimSun',serif" font-size="${rarityFontSize}" fill="${pal.text}">${RARITY_LABEL[rarity]}</text>
  </g>
</svg>
`
}

// ─────────────────────────── 生成 ───────────────────────────

let count = 0
for (const relic of RELICS) {
  const set = RELIC_SET_INDEX.get(relic.setId)
  const stat = (relic.mainStats[0]?.stat ?? 'atk') as StatKey
  const svg = relicSvg(relic.id, relic.name, relic.rarity, relic.setId, stat)
  writeFileSync(join(RELIC_DIR, `${relic.id}.svg`), svg, 'utf8')
  count++
}

console.log('='.repeat(60))
console.log('遗物图标生成完成')
console.log('='.repeat(60))
console.log(`  遗物图标 ${count} 张 → public/relics/`)
console.log(`  套装 ${RELIC_SET_INDEX.size} 套 · 形状按主词条 · 配色按稀有度 · 角标按套装`)
console.log('  确定性哈希：同一 id 恒定产出同一张图')
