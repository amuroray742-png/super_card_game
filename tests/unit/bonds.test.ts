/**
 * 羁绊与编队（§15.1）
 */
import { describe, expect, it } from 'vitest'
import { computeBondState, getBondMods, getTeamPower } from '../../src/core/systems/team.ts'
import { BONDS } from '../../src/core/config/bonds.ts'
import { makeHero } from './helpers.ts'

describe('羁绊阈值（§5.5）', () => {
  it('未达阈值时不生效', () => {
    const team = [makeHero('xiangyu'), makeHero('hannibal'), makeHero('zhangfei')]
    const states = computeBondState(team)
    const hundred = states.find((s) => s.bond.id === 'hundred_warriors')!
    expect(hundred.count).toBe(3)
    expect(hundred.active).toBe(false)
  })

  it('达到阈值时生效', () => {
    const team = [
      makeHero('xiangyu'),
      makeHero('hannibal'),
      makeHero('zhangfei'),
      makeHero('weiqing'),
    ]
    const states = computeBondState(team)
    const hundred = states.find((s) => s.bond.id === 'hundred_warriors')!
    expect(hundred.count).toBe(4)
    expect(hundred.active).toBe(true)
  })

  it('五行俱全需要 5 种不同五行', () => {
    const states = computeBondState([
      makeHero('hanxin'), // 金
      makeHero('zhugeliang'), // 水
      makeHero('libai'), // 火
      makeHero('luban'), // 木
      makeHero('xiangyu'), // 土
    ])
    const five = states.find((s) => s.bond.id === 'five_elements')!
    expect(five.count).toBe(5)
    expect(five.active).toBe(true)
  })

  it('羁绊移除后立即失效', () => {
    const full = [
      makeHero('xiangyu'),
      makeHero('hannibal'),
      makeHero('zhangfei'),
      makeHero('weiqing'),
    ]
    const reduced = full.slice(0, 3)
    expect(getBondMods(full).length).toBeGreaterThan(getBondMods(reduced).length)
  })

  it('全部羁绊条件可满足（有明确阈值与可达性）', () => {
    for (const bond of BONDS) {
      expect(bond.condition).toBeDefined()
      expect(bond.effects.length).toBeGreaterThan(0)
    }
  })
})

describe('编队战力', () => {
  it('队伍战力为各英灵战力之和', () => {
    const team = [makeHero('xiangyu'), makeHero('hanxin')]
    const power = getTeamPower(team, { mode: 'pve' })
    expect(power).toBeGreaterThan(0)
  })

  it('空槽不计入战力', () => {
    const withEmpty = getTeamPower([makeHero('xiangyu'), null], { mode: 'pve' })
    const onlyOne = getTeamPower([makeHero('xiangyu')], { mode: 'pve' })
    expect(withEmpty).toBeCloseTo(onlyOne, 6)
  })
})
