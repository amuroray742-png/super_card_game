/**
 * 推征页「一屏可达」的**静态**守护（AGENTS.md 铁律 #68）。
 *
 * ## 为什么要单测守「布局」
 *
 * 「一屏」是个**版面契约**，不是功能：单测跑不出像素，
 * E2E 能跑但慢且脆（改个字号就红一片）。
 * 所以这里守**结构层面的因**——那些「一长出来就必然把页面撑到第二屏」的块，
 * 一旦被重新塞回推征页模板，测试立刻红。
 *
 * 配套的**果**（真机上有没有滚动）由
 * `tests/e2e/expedition-one-screen.spec.ts` 在 360×640 视口下量。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const EXPEDITION = fileURLToPath(
  new URL('../../src/presentation/views/ExpeditionView.vue', import.meta.url),
)
const GLOBAL_CSS = fileURLToPath(
  new URL('../../src/presentation/styles/global.css', import.meta.url),
)

/** 取出 `<template>` 段并去掉 HTML 注释 */
function templateTextOf(source: string): string {
  const start = source.indexOf('<template>')
  if (start < 0) return ''
  const end = source.lastIndexOf('</template>')
  const body = source.slice(start, end < 0 ? undefined : end)
  return body.replace(/<!--[\s\S]*?-->/g, '')
}

/** 去掉 CSS 注释（注释里提到旧写法不算数） */
function stripCssComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

describe('推征页：一屏可达（AGENTS.md 铁律 #68）', () => {
  it('推征页模板里不得再渲染「会长出第二屏」的老结构', () => {
    const tpl = templateTextOf(readFileSync(EXPEDITION, 'utf-8'))

    // 这些块都已下沉到二级页 / 抽屉 / 底栏标签页
    const relocated: Record<string, string> = {
      'stage-grid': '关卡网格已下沉到 L2 `/stages`',
      'team-row': '编队概览已下沉到底栏「阵位」',
      'chan-card': '通道明细已改成一行式摘要（明细在抽屉里）',
      'bonds': '羁绊标签已下沉到 L2 `/stages`',
    }
    for (const [marker, reason] of Object.entries(relocated)) {
      expect(tpl, `推征页不该再渲染 ${marker} —— ${reason}`).not.toContain(marker)
    }
  })

  it('`.page` 不得为底栏预留叠底空间（底栏是 flex 兄弟节点，不叠内容）', () => {
    const css = stripCssComments(readFileSync(GLOBAL_CSS, 'utf-8'))
    const rule = /\.page\s*\{([^}]*)\}/.exec(css)
    expect(rule, 'global.css 里找不到 `.page` 规则（路径写错了？）').toBeTruthy()
    expect(
      rule![1],
      '`.page` 又开始用 `var(--tab-h)` 预留底栏了 ⇒ 每个页面底部又多了 66~78px 死区',
    ).not.toContain('var(--tab-h)')
  })

  it('全局样式里留着覆盖层 / 抽屉 / 通道行 / 关卡网格的底座', () => {
    const css = readFileSync(GLOBAL_CSS, 'utf-8')
    for (const cls of ['.overlay', '.sheet-mask', '.chan-row', '.stage-grid']) {
      expect(css, `全局样式里少了 ${cls}`).toContain(cls)
    }
  })

  it('战斗回放组件已经是全屏覆盖层（不再内联插在页面里）', () => {
    const replay = readFileSync(
      fileURLToPath(new URL('../../src/presentation/components/ChallengeReplay.vue', import.meta.url)),
      'utf-8',
    )
    expect(replay, '回放组件里找不到 `.overlay`（说明还是内联面板）').toContain('class="overlay"')
    // 旧的内联面板写法：`<section class="panel" data-testid="challenge-replay">`
    expect(replay, '回放组件还在用内联 `<section class="panel">`').not.toContain(
      '<section class="panel" data-testid="challenge-replay"',
    )
  })
})

/**
 * **背包页一屏化 v14** 的静态守护（AGENTS.md 铁律 #69）。
 *
 * ## 为什么背包页的口径与推征页不同
 *
 * 推征页是「一屏决策页」⇒ 整页不许有纵向滚动。
 * 背包页是**列表型**页面（仓库 60 件、碎片按英灵分堆）⇒ 列表可以滚，
 * 但**主操作必须在首屏**（E2E 在 360×640 上量）。
 *
 * 所以这里守的是**结构层面的因**：
 * 那些「一长出来就必然把主操作挤出首屏」的块，不许回流。
 */
describe('背包页：主操作在首屏（AGENTS.md 铁律 #69）', () => {
  const BACKPACK = fileURLToPath(
    new URL('../../src/presentation/views/BackpackView.vue', import.meta.url),
  )
  const WAREHOUSE = fileURLToPath(
    new URL('../../src/presentation/components/RelicWarehouse.vue', import.meta.url),
  )
  const DETAIL_CONTENT = fileURLToPath(
    new URL('../../src/presentation/components/RelicDetailContent.vue', import.meta.url),
  )
  const DETAIL_SHEET = fileURLToPath(
    new URL('../../src/presentation/components/RelicDetailSheet.vue', import.meta.url),
  )
  const DETAIL_VIEW = fileURLToPath(
    new URL('../../src/presentation/views/RelicDetailView.vue', import.meta.url),
  )

  it('套装进度 / 保底进度 / 套装效果不许回流到背包页与仓库页', () => {
    // 这三块合计 ≈ 2160px，是旧版把遗物网格挤到第三屏的元凶
    const relocated: Record<string, string> = {
      套装进度: '已下沉到 L2「套装与保底」',
      保底进度: '已下沉到 L2「套装与保底」',
      套装效果: '已下沉到 L2「套装与保底」',
    }
    for (const [file, label] of [
      [BACKPACK, '背包页'],
      [WAREHOUSE, '遗物仓库'],
    ] as const) {
      const tpl = templateTextOf(readFileSync(file, 'utf-8'))
      for (const [marker, reason] of Object.entries(relocated)) {
        expect(tpl, `${label}不该再渲染「${marker}」—— ${reason}`).not.toContain(marker)
      }
    }
  })

  it('遗物详情不许再做成页内面板（必须在抽屉组件里）', () => {
    const tpl = templateTextOf(readFileSync(WAREHOUSE, 'utf-8'))
    // 「强化 +N」按钮属于抽屉（`RelicDetailSheet`），不在仓库模板里
    expect(
      tpl,
      '遗物详情又回到页内面板了 ⇒ 「强化 +N」排在网格下方，手机上要滚 3 屏才摸得到',
    ).not.toContain('relic-upgrade')
    // 仓库只负责「点开抽屉」
    expect(tpl, '仓库模板里找不到遗物详情抽屉的接线').toContain('RelicDetailSheet')
  })

  it('「可使用的英灵」不许再平铺成整列列表', () => {
    const tpl = templateTextOf(readFileSync(BACKPACK, 'utf-8'))
    // 旧写法：直接遍历 ownedHeroes 铺一整列（随玩家拥有量线性变长）
    expect(
      tpl,
      '「可使用的英灵」又变回整列列表了 ⇒ 它应当收进抽屉，L1 只留一行摘要',
    ).not.toContain('v-for="hero in store.ownedHeroes"')
    // 摘要入口必须还在（养成链路要够得着，铁律 #27）
    expect(tpl, '「可使用的英灵」抽屉的入口不见了').toContain('backpack-usable-heroes-open')
  })

  it('经验书分类不许再把英灵平铺成 chip（旧版是长度不设限的 chip 列表，吃掉首屏）', () => {
    const tpl = templateTextOf(readFileSync(BACKPACK, 'utf-8'))
    expect(
      tpl,
      '经验书分类又把英灵平铺成 chip 了 ⇒ 应当是「当前英灵 + 换」按钮 + 抽屉',
    ).not.toMatch(/v-for="hero in[^>]*class="chip"/)
    expect(tpl, '换人入口不见了').toContain('backpack-feed-pick-hero')
  })

  it('遗物详情**只有一份 UI**：抽屉与 `/relic/:uid` 页共用同一个内容组件', () => {
    const content = readFileSync(DETAIL_CONTENT, 'utf-8')
    expect(content, '共用内容组件里找不到强化按钮').toContain('relic-upgrade')
    expect(content, '共用内容组件里找不到锁定按钮').toContain('relic-lock')

    // 两处都引用它（历史上两处各写一套：页面有分解没装备，仓库有装备没分解）
    expect(
      readFileSync(DETAIL_SHEET, 'utf-8'),
      '抽屉没有引用共用的内容组件',
    ).toContain('RelicDetailContent')
    expect(
      readFileSync(DETAIL_VIEW, 'utf-8'),
      '`/relic/:uid` 详情页没有引用共用的内容组件 ⇒ 又写出第二套 UI 了',
    ).toContain('RelicDetailContent')
  })

  it('全局样式里留着吸顶 / 吸底条 / 抽屉选择行 / 横滚筛选行的底座', () => {
    const css = readFileSync(GLOBAL_CSS, 'utf-8')
    for (const cls of ['.sticky-top', '.sticky-bar', '.picker-row', '.scroll-row']) {
      expect(css, `全局样式里少了 ${cls}`).toContain(cls)
    }
  })
})
