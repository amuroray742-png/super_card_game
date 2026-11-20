/**
 * 玩家可见文案里不许出现 markdown 残留（`**粗体**`）。
 *
 * ## 为什么要守这条
 *
 * 文档 / 注释里写 `**只发所选材料**` 很自然，但 **Vue 模板不渲染 markdown**——
 * 它会把星号**原样印在玩家眼前**。实测截图里就出现过：
 * 「副本胜利**只**发所选的五行材料或石档」这种字面量。
 *
 * ⚠ 这是**纯文本插值**的问题：合规页有 `richParts` 解析器（`content/compliance`），
 *   顶栏资源弹窗现在也走同一份；但**其余模板都没有解析器**，
 *   所以那里的 `**` 一定是 bug。
 *
 * 两类地方允许出现 `**`：
 * ① HTML 注释（`<!-- … -->`）与 JS 注释（不进 DOM）；
 * ② 经 `richParts` 渲染的文案（合规页正文、资源弹窗说明）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ITEM_DEFS } from '../../src/core/config/items.ts'

const PRESENTATION_DIR = fileURLToPath(new URL('../../src/presentation', import.meta.url))

/** 递归列出目录下的所有 `.vue` 文件 */
function vueFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...vueFiles(full))
    else if (name.endsWith('.vue')) out.push(full)
  }
  return out
}

/**
 * 取出 `<template>` 段，并去掉 HTML 注释。
 *
 * ⚠ 只看 `<template>`：`<script>` 里的 `**` 是注释 / 文档，不进 DOM。
 */
function templateTextOf(source: string): string {
  const start = source.indexOf('<template>')
  if (start < 0) return ''
  const end = source.lastIndexOf('</template>')
  const body = source.slice(start, end < 0 ? undefined : end)
  return body.replace(/<!--[\s\S]*?-->/g, '')
}

describe('玩家可见文案：模板里不许有 markdown 残留', () => {
  const files = vueFiles(PRESENTATION_DIR)

  it('至少扫到一批视图文件（防止路径写错导致「全绿」）', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  it('`<template>` 段里没有字面量 `**`', () => {
    const offenders: string[] = []
    for (const file of files) {
      const text = templateTextOf(readFileSync(file, 'utf-8'))
      if (text.includes('**')) {
        offenders.push(file.replace(PRESENTATION_DIR, 'src/presentation'))
      }
    }
    expect(
      offenders,
      '模板里的 `**` 会被原样印给玩家（Vue 不渲染 markdown）：'
      + `${offenders.join('、')} —— 改成 <b>…</b> 或去掉星号`,
    ).toEqual([])
  })

  it('道具说明里没有 `**`（背包页是纯文本插值，没有解析器）', () => {
    const offenders = Object.entries(ITEM_DEFS)
      .filter(([, def]) => def.desc.includes('**'))
      .map(([id]) => id)
    expect(offenders, '道具说明会被背包页原样插值').toEqual([])
  })
})
