/**
 * 占位头像生成器（Phase 8 / 美术两阶段的第一阶段）。
 *
 * 首发不接入 AI 生图前，先用**确定性程序化 SVG** 占位：
 *   - 同一英灵永远生成同一张图（基于 id 哈希）
 *   - 五行决定中心符号，稀有度决定底色与边框，定位决定角标
 *   - 全部本地生成，无网络依赖，可直接进版本库
 *
 * 产出：
 *   public/portraits/<heroId>.svg   —— 72 张英灵头像
 *   public/enemies/<enemyId>.svg    —— 40 张敌人头像（30 普通 + 10 BOSS）
 *
 * 后续接 AI 生图时，只需按同名规则产出 PNG 并改 HeroDef.portrait 的扩展名，
 * 游戏逻辑无需改动（美术与逻辑解耦）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HEROES } from '../../src/core/config/heroes/index.ts'
import { ENEMIES } from '../../src/core/config/enemies.ts'
import { hashSeed } from '../../src/core/rng.ts'
import type { Element, Rarity, Role } from '../../src/core/model/types.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const PORTRAIT_DIR = join(ROOT, 'public/portraits')
const ENEMY_DIR = join(ROOT, 'public/enemies')

mkdirSync(PORTRAIT_DIR, { recursive: true })
mkdirSync(ENEMY_DIR, { recursive: true })

/** 稀有度调色板：底色 / 边框 / 文字 */
const RARITY_PALETTE: Record<Rarity, { bg: [string, string]; border: string; text: string; ring: number }> = {
  SSR: { bg: ['#2A1C3D', '#5A2E52'], border: '#E8C87A', text: '#FFF4D6', ring: 4 },
  SR: { bg: ['#1E2A44', '#3B4C7A'], border: '#9FC6F0', text: '#EAF3FF', ring: 3 },
  R: { bg: ['#1D2E28', '#3E6152'], border: '#8FD6AE', text: '#E6FFF2', ring: 2 },
  N: { bg: ['#26262B', '#43434C'], border: '#A8A8B3', text: '#EDEDF2', ring: 1 },
}

/** 定位角标色 */
const ROLE_ACCENT: Record<Role, string> = {
  猛将: '#D9603B',
  统帅: '#C8A951',
  谋士: '#4E8FA8',
  医者: '#52BE80',
  器者: '#8E44AD',
}

/**
 * 五行中心符号（原创几何图形，不引用任何现成作品符号）。
 * 每个符号用一条 path 描述，配合 viewBox 512×512。
 */
const ELEMENT_PATHS: Record<Element, string> = {
  // 金：菱形刀锋
  金: 'M256 96 L330 236 L256 416 L182 236 Z M256 176 L296 236 L256 296 L216 236 Z',
  // 木：枝干十字
  木: 'M256 104 L286 208 L256 240 L226 208 Z M170 268 L342 268 L342 300 L170 300 Z M186 316 L326 316 L326 344 L186 344 Z M186 372 L326 372 L326 400 L186 400 Z',
  // 土：层叠山台
  土: 'M256 108 L360 236 L152 236 Z M152 268 L360 268 L360 304 L152 304 Z M176 340 L336 340 L336 376 L176 376 Z',
  // 水：三重波浪
  水: 'M136 200 Q192 152 248 200 T360 200 L360 240 Q304 192 248 240 T136 240 Z M136 288 Q192 240 248 288 T360 288 L360 328 Q304 280 248 328 T136 328 Z',
  // 火：焰形三角
  火: 'M256 96 C300 176 344 224 344 288 C344 360 306 408 256 408 C206 408 168 360 168 288 C168 236 210 204 226 152 C244 196 240 236 232 252 C252 226 258 164 256 96 Z',
}

const ELEMENT_LABEL: Record<Element, string> = {
  金: '金',
  木: '木',
  土: '土',
  水: '水',
  火: '火',
}

/** 定位角标符号（原创几何） */
const ROLE_MARKS: Record<Role, string> = {
  猛将: 'M40 372 L72 324 L104 372 Z',
  统帅: 'M40 336 L104 336 L104 368 L40 368 Z',
  谋士: 'M40 348 L64 320 L88 348 L64 376 Z',
  医者: 'M58 330 L74 330 L74 346 L90 346 L90 362 L74 362 L74 378 L58 378 L58 362 L42 362 L42 346 L58 346 Z',
  器者: 'M46 336 L98 336 L98 368 L46 368 Z M58 322 L86 322 L86 336 L58 336 Z',
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 生成英灵占位头像 */
function heroSvg(id: string, name: string, element: Element, rarity: Rarity, role: Role, accent: string): string {
  const pal = RARITY_PALETTE[rarity]
  const seed = hashSeed(id)
  // 确定性斜向条纹角度
  const stripeAngle = seed % 90
  const stripeOffset = seed % 60
  // 装饰环数量按定位区分
  const rings = role === '猛将' ? 3 : role === '统帅' ? 2 : 1

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="${esc(name)}占位头像">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${pal.bg[0]}"/>
      <stop offset="100%" stop-color="${pal.bg[1]}"/>
    </linearGradient>
    <pattern id="stripes" width="26" height="26" patternUnits="userSpaceOnUse" patternTransform="rotate(${stripeAngle})">
      <rect width="13" height="26" fill="#FFFFFF" opacity="0.035"/>
    </pattern>
    <radialGradient id="glow" cx="50%" cy="38%" r="62%">
      <stop offset="0%" stop-color="${accent}" stop-opacity="0.34"/>
      <stop offset="100%" stop-color="${accent}" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="512" height="512" fill="url(#bg)"/>
  <rect width="512" height="512" fill="url(#stripes)" transform="translate(${stripeOffset} 0)"/>
  <rect width="512" height="512" fill="url(#glow)"/>

  <!-- 装饰同心环 -->
  ${Array.from({ length: rings }, (_, i) => {
    const r = 196 - i * 34
    return `<circle cx="256" cy="238" r="${r}" fill="none" stroke="${pal.border}" stroke-opacity="${0.32 - i * 0.09}" stroke-width="2"/>`
  }).join('\n  ')}

  <!-- 五行中心符号 -->
  <g transform="translate(0 -14)" fill="${pal.border}" fill-opacity="0.92" fill-rule="evenodd">
    <path d="${ELEMENT_PATHS[element]}"/>
  </g>

  <!-- 五行角标 -->
  <g transform="translate(404 60)">
    <circle r="40" fill="#000000" fill-opacity="0.34" stroke="${pal.border}" stroke-opacity="0.5" stroke-width="2"/>
    <text y="13" text-anchor="middle" font-family="'Songti SC','SimSun',serif" font-size="38" fill="${pal.text}">${ELEMENT_LABEL[element]}</text>
  </g>

  <!-- 定位角标 -->
  <g transform="translate(38 300)" fill="${ROLE_ACCENT[role]}" fill-opacity="0.9">
    <path d="${ROLE_MARKS[role]}"/>
  </g>

  <!-- 稀有度边框 -->
  <rect x="6" y="6" width="500" height="500" rx="26" fill="none" stroke="${pal.border}" stroke-width="${pal.ring * 2}" stroke-opacity="0.85"/>

  <!-- 名牌 -->
  <rect x="0" y="424" width="512" height="88" fill="#000000" fill-opacity="0.5"/>
  <text x="256" y="482" text-anchor="middle" font-family="'Songti SC','SimSun',serif" font-size="46" fill="${pal.text}">${esc(name)}</text>
</svg>
`
}

/** 生成敌人占位头像（统一冷色调 + BOSS 警示色） */
function enemySvg(id: string, name: string, element: Element, isBoss: boolean): string {
  const seed = hashSeed(id)
  const angle = seed % 90
  const border = isBoss ? '#E05B4B' : '#6E7A8A'
  const bg = isBoss ? ['#3A1512', '#6B241C'] : ['#1A1E26', '#313847']
  const count = isBoss ? 4 : 3

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="${esc(name)}占位头像">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.7" y2="1">
      <stop offset="0%" stop-color="${bg[0]}"/>
      <stop offset="100%" stop-color="${bg[1]}"/>
    </linearGradient>
    <pattern id="spikes" width="30" height="30" patternUnits="userSpaceOnUse" patternTransform="rotate(${angle})">
      <path d="M0 30 L15 0 L30 30 Z" fill="#FFFFFF" opacity="0.05"/>
    </pattern>
  </defs>

  <rect width="512" height="512" fill="url(#bg)"/>
  <rect width="512" height="512" fill="url(#spikes)"/>

  ${Array.from({ length: count }, (_, i) => {
    const r = 150 + i * 34
    return `<circle cx="256" cy="250" r="${r}" fill="none" stroke="${border}" stroke-opacity="${0.4 - i * 0.07}" stroke-width="${isBoss ? 3 : 2}"/>`
  }).join('\n  ')}

  <g transform="translate(0 8) scale(0.82) translate(56 56)" fill="${border}" fill-opacity="0.85" fill-rule="evenodd">
    <path d="${ELEMENT_PATHS[element]}"/>
  </g>

  <rect x="6" y="6" width="500" height="500" rx="26" fill="none" stroke="${border}" stroke-width="${isBoss ? 8 : 3}" stroke-opacity="0.85"/>
  <rect x="0" y="424" width="512" height="88" fill="#000000" fill-opacity="0.5"/>
  <text x="256" y="480" text-anchor="middle" font-family="'Songti SC','SimSun',serif" font-size="${name.length > 4 ? 38 : 44}" fill="${isBoss ? '#FFD9D2' : '#DDE3EC'}">${esc(name)}</text>
</svg>
`
}

// ─────────────────────────── 生成 ───────────────────────────

let heroCount = 0
for (const hero of HEROES) {
  const svg = heroSvg(hero.id, hero.name, hero.element, hero.rarity, hero.role, hero.accent)
  writeFileSync(join(PORTRAIT_DIR, `${hero.id}.svg`), svg, 'utf8')
  heroCount++
}

let enemyCount = 0
for (const enemy of ENEMIES) {
  const svg = enemySvg(enemy.id, enemy.name, enemy.element, enemy.bossMechanic !== undefined)
  writeFileSync(join(ENEMY_DIR, `${enemy.id}.svg`), svg, 'utf8')
  enemyCount++
}

console.log('='.repeat(60))
console.log('占位头像生成完成')
console.log('='.repeat(60))
console.log(`  英灵头像 ${heroCount} 张 → public/portraits/`)
console.log(`  敌人头像 ${enemyCount} 张 → public/enemies/`)
console.log(`  确定性哈希：同一 id 恒定产出同一张图`)
