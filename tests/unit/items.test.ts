/**
 * 道具登记表（`core/config/items.ts`）的口径守护。
 *
 * 守的是「**配置齐全 ≠ 资源齐全**」这条铁律（AGENTS.md 铁律 #22）：
 * 新增一个道具 id 而忘了登记名称 / 描述 / 图标 key，
 * 背包页就会显示出一个「没有名字也没有图标」的条目。
 *
 * 全部断言都对着**唯一出处**写，测试里不另写一份名称表（铁律 #8）。
 */
import { describe, expect, it } from 'vitest'
import {
  ITEM_DEFS,
  ITEM_IDS,
  ITEM_CATEGORY_NAMES,
  ITEM_CATEGORY_ORDER,
  ITEM_LIST,
  ITEM_BY_ELEMENT,
  RELIC_STONE_ITEM_BY_TIER,
  EXP_BOOK_ITEM_EXP,
  itemsOfCategory,
  isExpBook,
  itemDesc,
  itemName,
  itemText,
} from '../../src/core/config/items.ts'
import { RESOURCE_ICON_KEYS } from '../../src/core/config/art.ts'
import { RESOURCE_DEFS } from '../../src/core/config/resources.ts'
import { ELEMENTS } from '../../src/core/model/types.ts'
import { RELIC, EXP_BOOK } from '../../src/core/config/economy.ts'

/** 占位符匹配（与 `itemText` 同一口径） */
const PLACEHOLDER = /\{(\w+)\}/g

describe('道具登记表', () => {
  it('每个道具 id 都登记了完整定义（类型层面已保证，这里再验一遍内容）', () => {
    for (const id of ITEM_IDS) {
      const def = ITEM_DEFS[id]
      expect(def, `${id} 未登记`).toBeTruthy()
      expect(def.id).toBe(id)
      expect(def.name.trim(), `${id} 名称`).not.toBe('')
      expect(def.desc.trim(), `${id} 描述`).not.toBe('')
      expect(def.source.trim(), `${id} 来源`).not.toBe('')
    }
  })

  it('道具名称互不重复（同一个东西只能有一个名字）', () => {
    const names = ITEM_IDS.map((id) => ITEM_DEFS[id].name)
    expect(new Set(names).size, '道具名称出现重复').toBe(names.length)
  })

  it('描述里的占位符全部有取值，渲染后不残留 {xxx}', () => {
    for (const id of ITEM_IDS) {
      const rendered = itemDesc(id)
      expect(rendered.match(PLACEHOLDER), `${id} 渲染后仍有未填的占位符`).toBeNull()
    }
  })

  it('每个道具的图标 key 都在需要出图的清单里（漏出图会被单测拦下）', () => {
    for (const id of ITEM_IDS) {
      expect(RESOURCE_ICON_KEYS, `${id} 的图标 key 未登记`).toContain(ITEM_DEFS[id].iconKey)
    }
  })

  it('资源登记表转调道具定义，名称与描述不另写一份', () => {
    for (const id of ITEM_IDS) {
      expect(RESOURCE_DEFS[id].name).toBe(ITEM_DEFS[id].name)
      expect(RESOURCE_DEFS[id].desc).toBe(ITEM_DEFS[id].desc)
    }
  })
})

describe('道具分类', () => {
  it('分类名全部登记（背包页的标签取这里）', () => {
    for (const category of ITEM_CATEGORY_ORDER) {
      expect(ITEM_CATEGORY_NAMES[category], `${category} 未登记名称`).toBeTruthy()
    }
  })

  it('每个道具都落在某个已登记的分类里', () => {
    for (const id of ITEM_IDS) {
      expect(ITEM_CATEGORY_ORDER, `${id} 的分类不在展示顺序里`).toContain(ITEM_DEFS[id].category)
      expect(itemsOfCategory(ITEM_DEFS[id].category).map((d) => d.id)).toContain(id)
    }
  })

  it('三种分类各有道具（背包页 5 个分类里除遗物与碎片外的 3 类）', () => {
    expect(itemsOfCategory('skillMat')).toHaveLength(ELEMENTS.length)
    expect(itemsOfCategory('relicStone')).toHaveLength(RELIC.STONE_TIERS.length)
    expect(itemsOfCategory('expBook')).toHaveLength(2)
  })
})

describe('五行 → 技能材料', () => {
  it('每个五行都有对应的技能材料道具', () => {
    for (const element of ELEMENTS) {
      const id = ITEM_BY_ELEMENT[element]
      expect(id, `${element} 没有对应材料`).toBeTruthy()
      expect(ITEM_DEFS[id].category).toBe('skillMat')
      expect(ITEM_DEFS[id].iconKey).toBe(id)
    }
  })

  it('不同五行的材料互不相同（否则「选五行」没有意义）', () => {
    const ids = ELEMENTS.map((e) => ITEM_BY_ELEMENT[e])
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('强化石档位', () => {
  it('每档强化石都有对应的道具 id', () => {
    for (const tier of RELIC.STONE_TIERS) {
      const id = RELIC_STONE_ITEM_BY_TIER[tier.id]
      expect(id, `${tier.id} 没有对应道具`).toBeTruthy()
      expect(ITEM_DEFS[id].category).toBe('relicStone')
    }
  })

  it('档位区间连续且不重叠（Lv1~60 / 61~130 / 131~200）', () => {
    const tiers = RELIC.STONE_TIERS
    for (let i = 1; i < tiers.length; i++) {
      expect(tiers[i].minLevel).toBe(tiers[i - 1].maxLevel + 1)
    }
    expect(tiers[0].minLevel).toBe(RELIC.MIN_LEVEL)
    expect(tiers[tiers.length - 1].maxLevel).toBe(RELIC.MAX_LEVEL)
  })
})

describe('经验书', () => {
  it('只有两种经验书，且都登记了面额', () => {
    const books = ITEM_IDS.filter((id) => isExpBook(id))
    expect(books).toHaveLength(2)
    for (const id of books) {
      expect(EXP_BOOK_ITEM_EXP[id], `${id} 没登记面额`).toBeGreaterThan(0)
    }
  })

  it('面额取自 economy 配置（数值一改，描述跟着改）', () => {
    expect(EXP_BOOK_ITEM_EXP[EXP_BOOK.small.id]).toBe(EXP_BOOK.small.exp)
    expect(EXP_BOOK_ITEM_EXP[EXP_BOOK.large.id]).toBe(EXP_BOOK.large.exp)
    expect(EXP_BOOK.large.exp).toBeGreaterThan(EXP_BOOK.small.exp)
  })

  it('非经验书没有面额（避免把别的道具当成经验书喂）', () => {
    for (const id of ITEM_IDS) {
      if (!isExpBook(id)) {
        expect(EXP_BOOK_ITEM_EXP[id], `${id} 不该有面额`).toBeUndefined()
      }
    }
  })
})

describe('文案工具', () => {
  it('itemName / itemDesc 与登记表一致', () => {
    for (const id of ITEM_IDS) {
      expect(itemName(id)).toBe(ITEM_DEFS[id].name)
      expect(itemDesc(id)).toBe(itemText(ITEM_DEFS[id].desc))
    }
  })

  it('未提供的占位符原样保留（宁可看到 {x} 也不要显示成空白）', () => {
    expect(itemText('缺一个 {notAVar}')).toBe('缺一个 {notAVar}')
  })

  it('道具清单按 sort 稳定排序', () => {
    const sorts = ITEM_LIST.map((d) => d.sort)
    expect([...sorts].sort((a, b) => a - b)).toEqual(sorts)
    expect(ITEM_LIST).toHaveLength(ITEM_IDS.length)
  })
})
