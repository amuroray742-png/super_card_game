/**
 * 遗物与套装（§5.4）。
 *
 * 12 套 × 5 件 = 60 件。每套含 2/4/6 件套装效果。
 * 遗物是最大的乘区来源（zone 'relic'）。
 */
import type { Rarity, RelicDef, RelicSetDef, StatKey, StatMod } from '../model/types.ts'
import { registerRelics } from '../systems/relic.ts'

/** 副词条标准数值（生成时在此基础上浮动 ±20%） */
const SUB_BASE: Record<StatKey, number> = {
  atk: 0.03,
  def: 0.04,
  hp: 0.04,
  spd: 0.02,
  crit: 0.01,
  cdmg: 0.02,
}

type MainSpec = [StatKey, number]

interface RelicSpec {
  name: string
  rarity: Rarity
  main: MainSpec[]
  subPool: StatKey[]
}

interface SetSpec {
  id: string
  name: string
  desc: string
  bonuses: { pieces: number; desc: string; mods: MainSpec[] }[]
  relics: RelicSpec[]
}

function pct(stat: StatKey, value: number): StatMod {
  return { stat, kind: 'pct', value, zone: 'relic' }
}

const SET_SPECS: SetSpec[] = [
  {
    id: 'set_zhanshen',
    name: '战神',
    desc: '以锋锐破阵，攻击与暴击见长',
    bonuses: [
      { pieces: 2, desc: '攻击 +8%', mods: [['atk', 0.08]] },
      { pieces: 4, desc: '攻击 +14%，暴击 +5%', mods: [['atk', 0.14], ['crit', 0.05]] },
      { pieces: 6, desc: '攻击 +22%，暴伤 +20%', mods: [['atk', 0.22], ['cdmg', 0.2]] },
    ],
    relics: [
      { name: '破军战戟', rarity: 'SSR', main: [['atk', 0.12], ['crit', 0.06]], subPool: ['atk', 'crit', 'cdmg'] },
      { name: '玄铁重剑', rarity: 'SR', main: [['atk', 0.1]], subPool: ['atk', 'crit', 'hp'] },
      { name: '淬火护腕', rarity: 'R', main: [['atk', 0.08]], subPool: ['atk', 'def', 'hp'] },
      { name: '锐锋指环', rarity: 'R', main: [['crit', 0.05]], subPool: ['crit', 'atk', 'spd'] },
      { name: '磨损护手', rarity: 'N', main: [['atk', 0.05]], subPool: ['atk', 'hp'] },
    ],
  },
  {
    id: 'set_bingjie',
    name: '冰界',
    desc: '疾行如霜，速度与命中见长',
    bonuses: [
      { pieces: 2, desc: '速度 +6%', mods: [['spd', 0.06]] },
      { pieces: 4, desc: '速度 +10%，闪避提升', mods: [['spd', 0.1]] },
      { pieces: 6, desc: '速度 +16%，暴击 +8%', mods: [['spd', 0.16], ['crit', 0.08]] },
    ],
    relics: [
      { name: '寒霜之刃', rarity: 'SSR', main: [['spd', 0.1], ['crit', 0.05]], subPool: ['spd', 'crit', 'atk'] },
      { name: '霜纹长弓', rarity: 'SR', main: [['spd', 0.08]], subPool: ['spd', 'atk', 'crit'] },
      { name: '雪原腰佩', rarity: 'R', main: [['spd', 0.07]], subPool: ['spd', 'def', 'crit'] },
      { name: '凛冬指套', rarity: 'R', main: [['crit', 0.04]], subPool: ['crit', 'spd', 'hp'] },
      { name: '薄霜披风', rarity: 'N', main: [['spd', 0.05]], subPool: ['spd', 'def'] },
    ],
  },
  {
    id: 'set_jiangtun',
    name: '疆土',
    desc: '厚重沉稳，防御与生命见长',
    bonuses: [
      { pieces: 2, desc: '防御 +8%', mods: [['def', 0.08]] },
      { pieces: 4, desc: '防御 +14%，生命 +10%', mods: [['def', 0.14], ['hp', 0.1]] },
      { pieces: 6, desc: '防御 +22%，生命 +18%', mods: [['def', 0.22], ['hp', 0.18]] },
    ],
    relics: [
      { name: '镇岳玄碑', rarity: 'SSR', main: [['def', 0.12], ['hp', 0.1]], subPool: ['def', 'hp', 'atk'] },
      { name: '厚土胸甲', rarity: 'SR', main: [['def', 0.1]], subPool: ['def', 'hp', 'spd'] },
      { name: '岩纹护膝', rarity: 'R', main: [['def', 0.08]], subPool: ['def', 'hp', 'spd'] },
      { name: '沉沙肩铠', rarity: 'R', main: [['hp', 0.08]], subPool: ['hp', 'def', 'atk'] },
      { name: '夯土腕带', rarity: 'N', main: [['def', 0.05]], subPool: ['def', 'hp'] },
    ],
  },
  {
    id: 'set_shangzhan',
    name: '尚战',
    desc: '攻守均衡的通用套装',
    bonuses: [
      { pieces: 2, desc: '全属性 +4%', mods: [['atk', 0.04], ['def', 0.04], ['hp', 0.04]] },
      { pieces: 4, desc: '全属性 +7%，暴击 +4%', mods: [['atk', 0.07], ['def', 0.07], ['hp', 0.07], ['crit', 0.04]] },
      { pieces: 6, desc: '全属性 +11%，速度 +8%', mods: [['atk', 0.11], ['def', 0.11], ['hp', 0.11], ['spd', 0.08]] },
    ],
    relics: [
      { name: '百战之勋', rarity: 'SSR', main: [['atk', 0.1], ['hp', 0.08]], subPool: ['atk', 'hp', 'def', 'spd'] },
      { name: '行伍战旗', rarity: 'SR', main: [['atk', 0.08], ['def', 0.06]], subPool: ['atk', 'def', 'hp'] },
      { name: '砺石佩剑', rarity: 'R', main: [['atk', 0.07]], subPool: ['atk', 'def', 'spd'] },
      { name: '铁片肩甲', rarity: 'R', main: [['def', 0.07]], subPool: ['def', 'hp', 'crit'] },
      { name: '行军水囊', rarity: 'N', main: [['hp', 0.06]], subPool: ['hp', 'def'] },
    ],
  },
  {
    id: 'set_tanpo',
    name: '探破',
    desc: '洞察先机，暴击与暴伤见长',
    bonuses: [
      { pieces: 2, desc: '暴击 +5%', mods: [['crit', 0.05]] },
      { pieces: 4, desc: '暴击 +8%，暴伤 +15%', mods: [['crit', 0.08], ['cdmg', 0.15]] },
      { pieces: 6, desc: '暴击 +12%，暴伤 +25%，速度 +6%', mods: [['crit', 0.12], ['cdmg', 0.25], ['spd', 0.06]] },
    ],
    relics: [
      { name: '洞微之镜', rarity: 'SSR', main: [['crit', 0.1], ['cdmg', 0.12]], subPool: ['crit', 'cdmg', 'spd'] },
      { name: '锐眼护额', rarity: 'SR', main: [['crit', 0.08]], subPool: ['crit', 'cdmg', 'atk'] },
      { name: '明察指环', rarity: 'R', main: [['crit', 0.06]], subPool: ['crit', 'atk', 'spd'] },
      { name: '观风罗盘', rarity: 'R', main: [['cdmg', 0.1]], subPool: ['cdmg', 'crit', 'hp'] },
      { name: '旧式单片镜', rarity: 'N', main: [['crit', 0.04]], subPool: ['crit', 'atk'] },
    ],
  },
  {
    id: 'set_liuhe',
    name: '六合',
    desc: '五行并蓄，全面而均衡',
    bonuses: [
      { pieces: 2, desc: '全属性 +4%', mods: [['atk', 0.04], ['def', 0.04], ['hp', 0.04], ['spd', 0.04]] },
      { pieces: 4, desc: '全属性 +7%', mods: [['atk', 0.07], ['def', 0.07], ['hp', 0.07], ['spd', 0.07]] },
      { pieces: 6, desc: '全属性 +12%，暴击 +5%', mods: [['atk', 0.12], ['def', 0.12], ['hp', 0.12], ['spd', 0.12], ['crit', 0.05]] },
    ],
    relics: [
      { name: '六合玉衡', rarity: 'SSR', main: [['atk', 0.08], ['def', 0.08], ['hp', 0.08]], subPool: ['atk', 'def', 'hp', 'spd'] },
      { name: '五行佩', rarity: 'SR', main: [['atk', 0.06], ['hp', 0.06]], subPool: ['atk', 'hp', 'spd', 'crit'] },
      { name: '调律环', rarity: 'R', main: [['spd', 0.06]], subPool: ['spd', 'crit', 'hp'] },
      { name: '均衡符', rarity: 'R', main: [['def', 0.06]], subPool: ['def', 'atk', 'hp'] },
      { name: '素纹绦', rarity: 'N', main: [['hp', 0.05]], subPool: ['hp', 'spd'] },
    ],
  },
  {
    id: 'set_huichun',
    name: '回春',
    desc: '生生不息，偏向治疗支援',
    bonuses: [
      { pieces: 2, desc: '生命 +8%', mods: [['hp', 0.08]] },
      { pieces: 4, desc: '生命 +14%，防御 +8%', mods: [['hp', 0.14], ['def', 0.08]] },
      { pieces: 6, desc: '生命 +22%，防御 +14%', mods: [['hp', 0.22], ['def', 0.14]] },
    ],
    relics: [
      { name: '青囊玉瓶', rarity: 'SSR', main: [['hp', 0.12], ['def', 0.08]], subPool: ['hp', 'def', 'spd'] },
      { name: '悬壶锦囊', rarity: 'SR', main: [['hp', 0.1]], subPool: ['hp', 'def', 'spd'] },
      { name: '灵芝佩', rarity: 'R', main: [['hp', 0.08]], subPool: ['hp', 'def', 'atk'] },
      { name: '药囊扣', rarity: 'R', main: [['def', 0.06]], subPool: ['def', 'hp'] },
      { name: '素纱腕带', rarity: 'N', main: [['hp', 0.05]], subPool: ['hp', 'spd'] },
    ],
  },
  {
    id: 'set_shengming',
    name: '生命',
    desc: '生机不绝，生命与抗性见长',
    bonuses: [
      { pieces: 2, desc: '生命 +10%', mods: [['hp', 0.1]] },
      { pieces: 4, desc: '生命 +18%', mods: [['hp', 0.18]] },
      { pieces: 6, desc: '生命 +28%，速度 +5%', mods: [['hp', 0.28], ['spd', 0.05]] },
    ],
    relics: [
      { name: '不死鸟羽', rarity: 'SSR', main: [['hp', 0.15]], subPool: ['hp', 'def', 'spd'] },
      { name: '长生命树根', rarity: 'SR', main: [['hp', 0.12]], subPool: ['hp', 'def', 'atk'] },
      { name: '苔纹护符', rarity: 'R', main: [['hp', 0.1]], subPool: ['hp', 'def', 'spd'] },
      { name: '泉石坠', rarity: 'R', main: [['hp', 0.08]], subPool: ['hp', 'spd'] },
      { name: '新芽坠', rarity: 'N', main: [['hp', 0.06]], subPool: ['hp', 'def'] },
    ],
  },
  {
    id: 'set_jixie',
    name: '机括',
    desc: '机关轮转，异常伤害见长',
    bonuses: [
      { pieces: 2, desc: '攻击 +7%', mods: [['atk', 0.07]] },
      { pieces: 4, desc: '攻击 +12%，暴击 +5%', mods: [['atk', 0.12], ['crit', 0.05]] },
      { pieces: 6, desc: '攻击 +18%，暴伤 +20%，速度 +6%', mods: [['atk', 0.18], ['cdmg', 0.2], ['spd', 0.06]] },
    ],
    relics: [
      { name: '万机匣', rarity: 'SSR', main: [['atk', 0.11], ['cdmg', 0.1]], subPool: ['atk', 'cdmg', 'spd'] },
      { name: '连弩机括', rarity: 'SR', main: [['atk', 0.09]], subPool: ['atk', 'crit', 'spd'] },
      { name: '齿轮组', rarity: 'R', main: [['atk', 0.07]], subPool: ['atk', 'def', 'hp'] },
      { name: '簧片护腕', rarity: 'R', main: [['cdmg', 0.08]], subPool: ['cdmg', 'crit', 'atk'] },
      { name: '铜制小件', rarity: 'N', main: [['atk', 0.05]], subPool: ['atk', 'spd'] },
    ],
  },
  {
    id: 'set_lingqi',
    name: '灵气',
    desc: '五行灵韵，属性与速度并重',
    bonuses: [
      { pieces: 2, desc: '速度 +5%，攻击 +5%', mods: [['spd', 0.05], ['atk', 0.05]] },
      { pieces: 4, desc: '速度 +9%，攻击 +10%', mods: [['spd', 0.09], ['atk', 0.1]] },
      { pieces: 6, desc: '速度 +14%，攻击 +16%，生命 +10%', mods: [['spd', 0.14], ['atk', 0.16], ['hp', 0.1]] },
    ],
    relics: [
      { name: '五灵珠', rarity: 'SSR', main: [['spd', 0.1], ['atk', 0.1]], subPool: ['spd', 'atk', 'crit'] },
      { name: '聚灵玉佩', rarity: 'SR', main: [['spd', 0.08]], subPool: ['spd', 'atk', 'hp'] },
      { name: '引灵环', rarity: 'R', main: [['atk', 0.07]], subPool: ['atk', 'spd', 'crit'] },
      { name: '风息符', rarity: 'R', main: [['spd', 0.06]], subPool: ['spd', 'hp'] },
      { name: '聚气结', rarity: 'N', main: [['spd', 0.04]], subPool: ['spd', 'atk'] },
    ],
  },
  {
    id: 'set_xuanwu',
    name: '玄武',
    desc: '如龟如甲，防御与生命极高',
    bonuses: [
      { pieces: 2, desc: '防御 +10%', mods: [['def', 0.1]] },
      { pieces: 4, desc: '防御 +16%，生命 +14%', mods: [['def', 0.16], ['hp', 0.14]] },
      { pieces: 6, desc: '防御 +25%，生命 +22%', mods: [['def', 0.25], ['hp', 0.22]] },
    ],
    relics: [
      { name: '玄甲盾', rarity: 'SSR', main: [['def', 0.13], ['hp', 0.11]], subPool: ['def', 'hp', 'spd'] },
      { name: '龟甲胸铠', rarity: 'SR', main: [['def', 0.11]], subPool: ['def', 'hp', 'atk'] },
      { name: '重甲护心', rarity: 'R', main: [['def', 0.09]], subPool: ['def', 'hp', 'spd'] },
      { name: '墨鳞环', rarity: 'R', main: [['hp', 0.1]], subPool: ['hp', 'def', 'atk'] },
      { name: '旧甲片', rarity: 'N', main: [['def', 0.06]], subPool: ['def', 'hp'] },
    ],
  },
  {
    id: 'set_qingming',
    name: '青冥',
    desc: '轻灵迅捷，速度与暴击见长',
    bonuses: [
      { pieces: 2, desc: '速度 +6%', mods: [['spd', 0.06]] },
      { pieces: 4, desc: '速度 +11%，暴击 +6%', mods: [['spd', 0.11], ['crit', 0.06]] },
      { pieces: 6, desc: '速度 +17%，暴伤 +18%，攻击 +8%', mods: [['spd', 0.17], ['cdmg', 0.18], ['atk', 0.08]] },
    ],
    relics: [
      { name: '青冥羽衣', rarity: 'SSR', main: [['spd', 0.11], ['crit', 0.05]], subPool: ['spd', 'crit', 'cdmg'] },
      { name: '御风履', rarity: 'SR', main: [['spd', 0.09]], subPool: ['spd', 'atk', 'crit'] },
      { name: '流云绶', rarity: 'R', main: [['spd', 0.07]], subPool: ['spd', 'hp', 'atk'] },
      { name: '逐风佩', rarity: 'R', main: [['crit', 0.05]], subPool: ['crit', 'spd', 'cdmg'] },
      { name: '轻羽结', rarity: 'N', main: [['spd', 0.05]], subPool: ['spd', 'def'] },
    ],
  },
]

/** 生成 RelicDef 列表 */
function buildRelics(specs: SetSpec[]): RelicDef[] {
  const out: RelicDef[] = []
  for (const set of specs) {
    set.relics.forEach((relic, i) => {
      const id = `${set.id}_${i + 1}`
      out.push({
        id,
        name: relic.name,
        setId: set.id,
        rarity: relic.rarity,
        mainStats: relic.main.map(([stat, value]) => pct(stat, value)),
        subStatPool: relic.subPool.map((stat) => pct(stat, SUB_BASE[stat])),
        desc: `${set.name}套装·${relic.name}`,
      })
    })
  }
  return out
}

function buildSets(specs: SetSpec[]): RelicSetDef[] {
  return specs.map((set) => ({
    id: set.id,
    name: set.name,
    desc: set.desc,
    bonuses: set.bonuses.map((b) => ({
      pieces: b.pieces,
      desc: b.desc,
      mods: b.mods.map(([stat, value]) => pct(stat, value)),
    })),
  }))
}

export const RELICS: readonly RelicDef[] = buildRelics(SET_SPECS)
export const RELIC_SETS: readonly RelicSetDef[] = buildSets(SET_SPECS)

export const RELIC_INDEX = new Map(RELICS.map((r) => [r.id, r]))
export const RELIC_SET_INDEX = new Map(RELIC_SETS.map((s) => [s.id, s]))

// 加载即注册，避免调用方忘记初始化索引
registerRelics(RELICS, RELIC_SETS)

/** 按稀有度返回遗物 id 列表（抽卡池用） */
export function relicIdsByRarity(rarity: Rarity): string[] {
  return RELICS.filter((r) => r.rarity === rarity).map((r) => r.id)
}

/** 按套装返回遗物 id 列表 */
export function relicIdsBySet(setId: string): string[] {
  return RELICS.filter((r) => r.setId === setId).map((r) => r.id)
}
