/**
 * 合规文案模块（Stage D · roadmap P1-3）。
 *
 * 合规文案是**会被审**的内容：必须有唯一出处、必须有版本与生效日期、
 * 数字必须由 core 的实时值填充（公示 = 实际）。
 */
import { describe, expect, it } from 'vitest'
import {
  COMPLIANCE_SECTIONS,
  CONTACT,
  RATES_PUBLICATION,
  chineseOrdinal,
  fillSection,
  fillTemplate,
  richParts,
} from '../../src/content/compliance/index.ts'

describe('合规文案：结构', () => {
  it('章节 id 唯一、标题与条目齐全', () => {
    const ids = COMPLIANCE_SECTIONS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const section of COMPLIANCE_SECTIONS) {
      expect(section.title.length).toBeGreaterThan(0)
      expect(section.items.length).toBeGreaterThan(0)
      for (const item of section.items) expect(item.trim().length).toBeGreaterThan(0)
    }
  })

  it('概率公示带版本号与生效日期', () => {
    expect(RATES_PUBLICATION.version).toMatch(/^v\d+$/)
    expect(RATES_PUBLICATION.effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('客服邮箱未配置时给出兜底文案，而不是假地址', () => {
    // 测试环境没有注入 VITE_CONTACT_EMAIL
    expect(CONTACT.email).toBe('')
    expect(CONTACT.missing.length).toBeGreaterThan(0)
    expect(CONTACT.replyTime.length).toBeGreaterThan(0)
  })
})

describe('合规文案：占位符与序号', () => {
  it('占位符被替换；未提供的键原样保留（宁可看到 {x} 也不要显示成空白）', () => {
    expect(fillTemplate('保底 {pityMax} 抽', { pityMax: 90 })).toBe('保底 90 抽')
    expect(fillTemplate('保底 {pityMax} 抽', {})).toBe('保底 {pityMax} 抽')
  })

  it('章节填充后不再残留已提供的占位符', () => {
    const filled = fillSection(COMPLIANCE_SECTIONS[1], {
      pityMax: 90,
      softPityStart: 75,
      pityRemaining: 12,
      tenPullFloor: 'SR',
    })
    for (const item of filled) expect(item).not.toMatch(/\{(pityMax|softPityStart|pityRemaining|tenPullFloor)\}/)
  })

  it('中文序号：一 … 十二', () => {
    expect(chineseOrdinal(1)).toBe('一')
    expect(chineseOrdinal(9)).toBe('九')
    expect(chineseOrdinal(10)).toBe('十')
    expect(chineseOrdinal(11)).toBe('十一')
    expect(chineseOrdinal(12)).toBe('十二')
  })

  it('粗体标记被拆成片段，且不带 HTML', () => {
    const parts = richParts('**重复英灵不直接提升强度**，统一转化')
    expect(parts.some((p) => p.bold && p.text === '重复英灵不直接提升强度')).toBe(true)
    expect(parts.map((p) => p.text).join('')).toBe('重复英灵不直接提升强度，统一转化')
    for (const part of parts) expect(part.text).not.toMatch(/[<>]/)
  })
})
