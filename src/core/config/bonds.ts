/**
 * 羁绊表（§5.5）。
 *
 * 羁绊是编队策略的价值来源：凑标签触发额外乘区。
 * 竞技模式下羁绊系数打折（×0.6），且不影响数值大小，只影响策略宽度。
 */
import type { BondDef } from '../model/types.ts'

export const BONDS: readonly BondDef[] = [
  {
    id: 'hundred_warriors',
    name: '百战之师',
    desc: '编入 4 名猛将，全队攻击提升',
    condition: { type: 'role', role: '猛将', count: 4 },
    effects: [
      {
        desc: '全队攻击 +15%',
        mods: [{ stat: 'atk', kind: 'pct', value: 0.15, zone: 'bond' }],
      },
    ],
  },
  {
    id: 'strategy',
    name: '运筹帷幄',
    desc: '编入 3 名谋士，暴击提升且技能冷却缩减',
    condition: { type: 'role', role: '谋士', count: 3 },
    effects: [
      {
        desc: '全队暴击 +10%',
        mods: [{ stat: 'crit', kind: 'pct', value: 0.1, zone: 'bond' }],
      },
      { desc: '谋士技能冷却 -15%', mods: [], extra: { type: 'cooldownReduction', value: 0.15 } },
    ],
  },
  {
    id: 'benevolence',
    name: '仁心济世',
    desc: '编入 3 名医者，治疗效果提升',
    condition: { type: 'role', role: '医者', count: 3 },
    effects: [
      {
        desc: '全队生命 +10%',
        mods: [{ stat: 'hp', kind: 'pct', value: 0.1, zone: 'bond' }],
      },
      { desc: '受到的治疗 +20%', mods: [], extra: { type: 'healingBonus', value: 0.2 } },
    ],
  },
  {
    id: 'craftwork',
    name: '奇械百工',
    desc: '编入 3 名器者，异常伤害提升',
    condition: { type: 'role', role: '器者', count: 3 },
    effects: [
      { desc: '异常伤害 +25%', mods: [], extra: { type: 'dotDamage', value: 0.25 } },
    ],
  },
  {
    id: 'earth_bearing',
    name: '承天之土',
    desc: '编入 3 名土属性英灵，防御提升',
    condition: { type: 'element', element: '土', count: 3 },
    effects: [
      {
        desc: '全队防御 +20%',
        mods: [{ stat: 'def', kind: 'pct', value: 0.2, zone: 'bond' }],
      },
    ],
  },
  {
    id: 'five_elements',
    name: '五行俱全',
    desc: '编入 5 种不同五行，全属性提升',
    condition: { type: 'distinctElements', count: 5 },
    effects: [
      {
        desc: '全属性 +12%',
        mods: [
          { stat: 'atk', kind: 'pct', value: 0.12, zone: 'bond' },
          { stat: 'def', kind: 'pct', value: 0.12, zone: 'bond' },
          { stat: 'hp', kind: 'pct', value: 0.12, zone: 'bond' },
          { stat: 'spd', kind: 'pct', value: 0.12, zone: 'bond' },
        ],
      },
    ],
  },
  {
    id: 'forged_steel',
    name: '百炼成钢',
    desc: '编入 4 名金属性英灵，攻击与暴击提升',
    condition: { type: 'element', element: '金', count: 4 },
    effects: [
      {
        desc: '全队攻击 +10%，暴击 +5%',
        mods: [
          { stat: 'atk', kind: 'pct', value: 0.1, zone: 'bond' },
          { stat: 'crit', kind: 'pct', value: 0.05, zone: 'bond' },
        ],
      },
    ],
  },
  {
    id: 'evergreen',
    name: '生生不息',
    desc: '编入 4 名木属性英灵，生命与治疗提升',
    condition: { type: 'element', element: '木', count: 4 },
    effects: [
      {
        desc: '全队生命 +15%',
        mods: [{ stat: 'hp', kind: 'pct', value: 0.15, zone: 'bond' }],
      },
      { desc: '受到的治疗 +10%', mods: [], extra: { type: 'healingBonus', value: 0.1 } },
    ],
  },
  {
    id: 'wisdom',
    name: '智计百出',
    desc: '编入 4 名水属性英灵，暴击与速度提升',
    condition: { type: 'element', element: '水', count: 4 },
    effects: [
      {
        desc: '全队暴击 +8%，速度 +10%',
        mods: [
          { stat: 'crit', kind: 'pct', value: 0.08, zone: 'bond' },
          { stat: 'spd', kind: 'pct', value: 0.1, zone: 'bond' },
        ],
      },
    ],
  },
  {
    id: 'blaze',
    name: '烈焰燎原',
    desc: '编入 4 名火属性英灵，攻击与异常伤害提升',
    condition: { type: 'element', element: '火', count: 4 },
    effects: [
      {
        desc: '全队攻击 +12%',
        mods: [{ stat: 'atk', kind: 'pct', value: 0.12, zone: 'bond' }],
      },
      { desc: '异常伤害 +15%', mods: [], extra: { type: 'dotDamage', value: 0.15 } },
    ],
  },
  {
    id: 'sovereign',
    name: '王者之师',
    desc: '编入 2 名统帅，攻防同步提升',
    condition: { type: 'role', role: '统帅', count: 2 },
    effects: [
      {
        desc: '全队攻击 +8%，防御 +8%',
        mods: [
          { stat: 'atk', kind: 'pct', value: 0.08, zone: 'bond' },
          { stat: 'def', kind: 'pct', value: 0.08, zone: 'bond' },
        ],
      },
    ],
  },
  {
    id: 'full_roster',
    name: '众志成城',
    desc: '编满 6 名英灵，全属性小幅提升',
    condition: { type: 'rarity', rarity: 'N', count: 6 },
    effects: [
      {
        desc: '全属性 +6%',
        mods: [
          { stat: 'atk', kind: 'pct', value: 0.06, zone: 'bond' },
          { stat: 'def', kind: 'pct', value: 0.06, zone: 'bond' },
          { stat: 'hp', kind: 'pct', value: 0.06, zone: 'bond' },
          { stat: 'spd', kind: 'pct', value: 0.06, zone: 'bond' },
        ],
      },
    ],
  },
]

export const BOND_INDEX = new Map(BONDS.map((b) => [b.id, b]))
