/**
 * 资源登记表口径（AGENTS.md 铁律 #4 / #8）。
 *
 * 资源名称与作用描述此前在**四处**各写一份（顶栏 / 结算面板 / 关卡页 / 生图提示词），
 * 已经对不上——同一个「强化石」在结算面板里叫「遗物强化石」。
 * 现在只此一处：`src/core/config/resources.ts` 的 `RESOURCE_DEFS`。
 *
 * 这条用例守三件事：
 * 1. **登记齐全**：有图标的资源必须同时有名字与描述（漏一条 → 玩家看到无名资源）；
 * 2. **数字不漂**：描述里的价格直接来自 `economy.ts`，数值一改，描述自动跟着改；
 * 3. **顶栏口径**：顶栏那一组必须都是 `player` 上的数值字段
 *    （`shards` 是「英灵 id → 碎片数」的映射，进不了顶栏）。
 */
import { describe, expect, it } from 'vitest'
import { RESOURCE_ICON_KEYS } from '../../src/core/config/art.ts'
import {
  RESOURCE_DEFS,
  RESOURCE_TEXT_VARS,
  TOP_BAR_RESOURCE_KEYS,
  resourceDesc,
  resourceName,
  resourceText,
} from '../../src/core/config/resources.ts'
import { GACHA, RELIC, SKILL } from '../../src/core/config/economy.ts'
import { createNewSave } from '../../src/core/save/schema.ts'

/** 占位符匹配（与 `resourceText` 同一口径） */
const PLACEHOLDER = /\{(\w+)\}/g

describe('资源登记表', () => {
  it('每个有图标的资源都登记了名称与作用描述', () => {
    for (const key of RESOURCE_ICON_KEYS) {
      const def = RESOURCE_DEFS[key]
      expect(def, `${key} 未登记`).toBeTruthy()
      expect(def.name.trim(), `${key} 名称`).not.toBe('')
      expect(def.desc.trim(), `${key} 描述`).not.toBe('')
    }
  })

  it('名称互不重复（同一个资源只能有一个名字）', () => {
    const names = Object.values(RESOURCE_DEFS).map((d) => d.name)
    expect(new Set(names).size, '资源名称出现重复').toBe(names.length)
  })

  it('描述里的占位符全部有取值，渲染后不残留 {xxx}', () => {
    for (const key of RESOURCE_ICON_KEYS) {
      const used = [...RESOURCE_DEFS[key].desc.matchAll(PLACEHOLDER)].map((m) => m[1])
      for (const placeholder of used) {
        expect(
          Object.keys(RESOURCE_TEXT_VARS),
          `${key} 的占位符 {${placeholder}} 没有取值`,
        ).toContain(placeholder)
      }
      const rendered = resourceDesc(key)
      expect(rendered.match(PLACEHOLDER), `${key} 渲染后仍有未填的占位符`).toBeNull()
    }
  })

  it('描述里的数字取自 economy 配置（数值一改，描述跟着改）', () => {
    // 占位符取值直接引用配置常量，不写死
    expect(RESOURCE_TEXT_VARS.gachaCost).toBe(GACHA.COST_SINGLE)
    expect(RESOURCE_TEXT_VARS.tenPullCount).toBe(GACHA.TEN_PULL_COUNT)
    expect(RESOURCE_TEXT_VARS.ticketPerPull).toBe(GACHA.TICKET_PER_PULL)
    expect(RESOURCE_TEXT_VARS.skillStoneCost).toBe(SKILL.SKILL_STONES_PER_LEVEL)
    expect(RESOURCE_TEXT_VARS.skillSilverCost).toBe(SKILL.SILVER_PER_LEVEL)
    expect(RESOURCE_TEXT_VARS.relicStoneCost).toBe(RELIC.STONES_PER_LEVEL)
    expect(RESOURCE_TEXT_VARS.relicSilverCost).toBe(RELIC.SILVER_PER_LEVEL)
    expect(RESOURCE_TEXT_VARS.overSegmentStart).toBe(RELIC.OVER_SEGMENT_START)

    // 渲染后的文案里确实出现了当前配置值（而不是模板里的旧数字）
    for (const key of RESOURCE_ICON_KEYS) {
      const used = [...RESOURCE_DEFS[key].desc.matchAll(PLACEHOLDER)].map((m) => m[1])
      for (const placeholder of used) {
        const value = RESOURCE_TEXT_VARS[placeholder as keyof typeof RESOURCE_TEXT_VARS]
        expect(resourceDesc(key), `${key} 的 {${placeholder}} 没有落到文案里`).toContain(String(value))
      }
    }
  })

  it('未提供的占位符原样保留（宁可看到 {x} 也不要显示成空白）', () => {
    expect(resourceText('缺一个 {notAVar}')).toBe('缺一个 {notAVar}')
  })
})

describe('顶栏资源口径', () => {
  it('顶栏项都是有图标的资源', () => {
    for (const key of TOP_BAR_RESOURCE_KEYS) {
      expect(RESOURCE_ICON_KEYS, `${key} 没有对应图标`).toContain(key)
    }
  })

  it('顶栏项都是 player 上的**数值**字段（shards 是映射，进不了顶栏）', () => {
    const save = createNewSave(1000, 7)
    for (const key of TOP_BAR_RESOURCE_KEYS) {
      expect(typeof save.player[key], `${key} 不是 player 上的数值字段`).toBe('number')
    }
    // 反例守口：碎片是「英灵 id → 碎片数」的映射
    expect(typeof save.player.shards).toBe('object')
    expect(TOP_BAR_RESOURCE_KEYS).not.toContain('shards')
  })

  it('只有抽卡类资源给出「前往召唤」入口（核心循环入口，AGENTS.md 铁律 #10）', () => {
    const withEntry = Object.entries(RESOURCE_DEFS)
      .filter(([, def]) => def.gachaEntry)
      .map(([key]) => key)
      .sort()
    expect(withEntry).toEqual(['crystals', 'tickets'])
  })

  it('取名与取描述的便捷函数与登记表一致', () => {
    for (const key of RESOURCE_ICON_KEYS) {
      expect(resourceName(key)).toBe(RESOURCE_DEFS[key].name)
      expect(resourceDesc(key)).toBe(resourceText(RESOURCE_DEFS[key].desc))
    }
  })
})
