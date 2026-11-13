/**
 * 美术资源路径与头像裁取约定（§6.3 战斗演出 · AGENTS.md 铁律 #8）。
 *
 * 这些约定是 core 与表现层的**唯一口径**：表现层不得自行拼 `/enemies/xxx`，
 * 也不得自行剥敌人 id 的 `#序号` 后缀。
 */
import { describe, expect, it } from 'vitest'
import { portraitPath, enemyArtPath, AVATAR_CROP } from '../../src/core/config/art.ts'

describe('美术路径约定', () => {
  it('英灵：已产出 AI 卡面的走 WebP，其余回落 SVG 占位', () => {
    expect(portraitPath('xiangyu')).toBe('/portraits/xiangyu.webp')
    // 未在 AI_CARD_IDS 里的 id 回落占位头像
    expect(portraitPath('__not_a_hero__')).toBe('/portraits/__not_a_hero__.svg')
  })

  it('敌人：按基础定义 id 取占位头像', () => {
    expect(enemyArtPath('boss_abyss')).toBe('/enemies/boss_abyss.svg')
    expect(enemyArtPath('wanderer')).toBe('/enemies/wanderer.svg')
  })
})

describe('头像裁取约定', () => {
  it('比例取值合法（0,1] 且顶偏不越过图底', () => {
    for (const crop of [AVATAR_CROP.hero, AVATAR_CROP.enemy]) {
      expect(crop.sizeRatio).toBeGreaterThan(0)
      expect(crop.sizeRatio).toBeLessThanOrEqual(1)
      expect(crop.topRatio).toBeGreaterThanOrEqual(0)
      expect(crop.topRatio).toBeLessThan(1)
    }
  })

  it('源区是正方形：边长按图宽算，纵向偏移不越界', () => {
    // 英灵卡面 3:4（512×682）：头部在图高 8%~32%，取景区必须罩住这一段
    const hero = AVATAR_CROP.hero
    const heroSide = 512 * hero.sizeRatio
    const heroTop = 682 * hero.topRatio
    expect(heroTop).toBeLessThan(682 * 0.08)
    expect(heroTop + heroSide).toBeGreaterThan(682 * 0.32)
    expect(heroTop + heroSide).toBeLessThanOrEqual(682)

    // 敌人占位图 512×512：徽记中心在 y=250，底部名字条从 y=424 开始
    const enemy = AVATAR_CROP.enemy
    const enemySide = 512 * enemy.sizeRatio
    expect(enemySide).toBeGreaterThan(250)
    expect(enemySide).toBeLessThanOrEqual(424)
  })
})
