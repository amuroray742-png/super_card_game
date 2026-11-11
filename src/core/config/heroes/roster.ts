/**
 * 英灵名册（§8）。
 *
 * 数据驱动：新增英灵只在此追加条目，不改逻辑代码。
 * 人物均为史册可考的历史人物；原文传（且史料有载）者标注于 era 字段。
 *
 * 定位与五行分布经过平衡（§5.5）：五行俱全的羁绊要求玩家跨属性搭配。
 */
import type { Element, Rarity, Role } from '../../model/types.ts'

/** 数值档位：决定基础属性与成长系数 */
export type Tier = 1 | 2 | 3 | 4

/** 宝具效果类型，决定固有技能的形态 */
export type UltimateEffect =
  | 'burst'
  | 'aoe'
  | 'buff'
  | 'control'
  | 'heal'
  | 'dot'
  | 'pierce'

export interface RosterEntry {
  id: string
  name: string
  pinyin: string
  era: string
  region: string
  rarity: Rarity
  role: Role
  element: Element
  tier: Tier
  /** 宝具（固有技能）名称 */
  ultimate: string
  /** 宝具描述（史实意象，不评功过） */
  ultimateDesc: string
  ultimateEffect: UltimateEffect
  /** 一句话简介（图鉴与 R/N 传记用） */
  brief: string
  accent: string
}

export const ROSTER: readonly RosterEntry[] = [
  // ─────────── SSR（12） ───────────
  {
    id: 'xiangyu', name: '项羽', pinyin: 'xiàngyǔ', era: '秦末', region: '中国',
    rarity: 'SSR', role: '猛将', element: '土', tier: 4,
    ultimate: '力拔千钧', ultimateDesc: '举鼎之力，斩将夺旗，冲阵无前',
    ultimateEffect: 'burst', accent: '#B85C38',
    brief: '秦末起于江东，以举鼎破阵之勇名世，垓下之围后自刎乌江。',
  },
  {
    id: 'hanxin', name: '韩信', pinyin: 'hánxìn', era: '汉', region: '中国',
    rarity: 'SSR', role: '统帅', element: '金', tier: 4,
    ultimate: '多路奇袭', ultimateDesc: '分兵数路，避实击虚，合力破敌',
    ultimateEffect: 'buff', accent: '#C8A951',
    brief: '汉初三杰之一，以善于用兵著称，创背水一战之例。',
  },
  {
    id: 'zhugeliang', name: '诸葛亮', pinyin: 'zhūgěliàng', era: '三国', region: '中国',
    rarity: 'SSR', role: '谋士', element: '水', tier: 4,
    ultimate: '八阵图', ultimateDesc: '布阵成围，变化无穷，使敌不得其门',
    ultimateEffect: 'control', accent: '#4E8FA8',
    brief: '蜀汉丞相，隆中对为其定策，以治戎与政务见称。',
  },
  {
    id: 'libai', name: '李白', pinyin: 'lǐbái', era: '唐', region: '中国',
    rarity: 'SSR', role: '猛将', element: '火', tier: 4,
    ultimate: '诗剑', ultimateDesc: '斗酒诗百篇，长剑一杯，逸气凌云',
    ultimateEffect: 'burst', accent: '#D9603B',
    brief: '唐代诗人，兼善剑术，好游名山大川，诗风飘逸。',
  },
  {
    id: 'zuchongzhi', name: '祖冲之', pinyin: 'zǔchōngzhī', era: '南北朝', region: '中国',
    rarity: 'SSR', role: '器者', element: '水', tier: 4,
    ultimate: '圆之率', ultimateDesc: '密率精研，割之弥细，所穷者密',
    ultimateEffect: 'dot', accent: '#5B9BC0',
    brief: '南朝数学家、天文学家，推算圆周率至七位小数，制成指南车与水碓磨。',
  },
  {
    id: 'sunwu', name: '孙武', pinyin: 'sūn wǔ', era: '春秋', region: '中国',
    rarity: 'SSR', role: '统帅', element: '金', tier: 4,
    ultimate: '兵法十三篇', ultimateDesc: '令行禁止，部伍严明，百战之师由此成',
    ultimateEffect: 'buff', accent: '#C9A227',
    brief: '春秋齐国人，著《兵法》十三篇，被后世尊为兵圣。',
  },
  {
    id: 'alexander', name: '亚历山大大帝', pinyin: 'yàlìshāndà dàdì', era: '马其顿', region: '马其顿',
    rarity: 'SSR', role: '猛将', element: '火', tier: 4,
    ultimate: '冲阵', ultimateDesc: '亲率骑兵突入阵线，长驱直入不返',
    ultimateEffect: 'pierce', accent: '#C0392B',
    brief: '马其顿王，以少胜多远征至印度河流域，其名后以亚历山大里亚冠之。',
  },
  {
    id: 'napoleon', name: '拿破仑', pinyin: 'nàpólún', era: '近代', region: '法国',
    rarity: 'SSR', role: '统帅', element: '火', tier: 4,
    ultimate: '炮阵', ultimateDesc: '集中火炮于一点，射程覆盖压制',
    ultimateEffect: 'aoe', accent: '#8E44AD',
    brief: '法兰西第一执政与皇帝，以军团制与炮兵战术改写近代战史。',
  },
  {
    id: 'caesar', name: '凯撒', pinyin: 'kǎisā', era: '罗马', region: '罗马',
    rarity: 'SSR', role: '统帅', element: '金', tier: 4,
    ultimate: '凯旋', ultimateDesc: '我至，敌溃。斩将夺旗，积势待发',
    ultimateEffect: 'buff', accent: '#B7950B',
    brief: '罗马共和晚期统帅与 dictator 终身制者，著《高卢战记》。',
  },
  {
    id: 'hannibal', name: '汉尼拔', pinyin: 'hànníbá', era: '迦太基', region: '迦太基',
    rarity: 'SSR', role: '猛将', element: '土', tier: 4,
    ultimate: '坎尼会战', ultimateDesc: '越过阿尔卑斯山，围而歼之',
    ultimateEffect: 'dot', accent: '#A0522D',
    brief: '迦太基将领，率象兵翻越阿尔卑斯山，坎尼会战以包围战术著称。',
  },
  {
    id: 'archimedes', name: '阿基米德', pinyin: 'ājīmídé', era: '古希腊', region: '古希腊',
    rarity: 'SSR', role: '器者', element: '水', tier: 4,
    ultimate: '死亡杠杆', ultimateDesc: '以杠杆撬动万物，机关之理层层相叠',
    ultimateEffect: 'dot', accent: '#2E86AB',
    brief: '古希腊数学家与发明家，著《原理》，提出杠杆原理与阿基米德定律。',
  },
  {
    id: 'jeannedarc', name: '圣女贞德', pinyin: 'shèngnǚ zhēndé', era: '中世纪', region: '法兰西',
    rarity: 'SSR', role: '医者', element: '火', tier: 4,
    ultimate: '圣旗', ultimateDesc: '旌旗所向，同袍聚而不散',
    ultimateEffect: 'heal', accent: '#D96BA0',
    brief: '中世纪法兰西人物，在英法百年战争中率众驰援奥尔良。',
  },

  // ─────────── SR（24） ───────────
  {
    id: 'nangdengel', name: '南丁格尔', pinyin: 'nándīnggě\'ěr', era: '近代', region: '英国',
    rarity: 'SR', role: '医者', element: '水', tier: 3,
    ultimate: '提灯夜巡', ultimateDesc: '提灯照护伤者，昼夜不舍',
    ultimateEffect: 'heal', accent: '#7FB3D5',
    brief: '近代护理制度奠基人，改进了野战医院的管理与卫生统计。',
  },
  {
    id: 'tesla', name: '特斯拉', pinyin: 'tèsīlā', era: '近代', region: '美国',
    rarity: 'SR', role: '器者', element: '火', tier: 3,
    ultimate: '感应之轮', ultimateDesc: '转轮生电，电流随其意流转',
    ultimateEffect: 'dot', accent: '#E67E22',
    brief: '发明家，推动交流电系统普及，对电力工程影响深远。',
  },
  {
    id: 'turing', name: '图灵', pinyin: 'túlíng', era: '近代', region: '英国',
    rarity: 'SR', role: '谋士', element: '水', tier: 3,
    ultimate: '停机问题', ultimateDesc: '以规则推演不可判定之谜',
    ultimateEffect: 'control', accent: '#5DADE2',
    brief: '数学家与计算机科学先驱，著有可计算性理论著作。',
  },
  {
    id: 'luban', name: '鲁班', pinyin: 'lǔbān', era: '春秋', region: '中国',
    rarity: 'SR', role: '器者', element: '木', tier: 3,
    ultimate: '机关之巧', ultimateDesc: '削竹为鹊，三日不下',
    ultimateEffect: 'dot', accent: '#52BE80',
    brief: '相传为鲁班门工匠之祖，典籍中以巧匠形象流传。',
  },
  {
    id: 'chengjisihan', name: '成吉思汗', pinyin: 'chéngjísīhǎn', era: '蒙古', region: '蒙古',
    rarity: 'SR', role: '猛将', element: '金', tier: 3,
    ultimate: '怯薛连阵', ultimateDesc: '千骑列阵，长驱直入',
    ultimateEffect: 'pierce', accent: '#AF7AC5',
    brief: '蒙古帝国建立者，统一草原诸部并发动西征。',
  },
  {
    id: 'libing', name: '李冰', pinyin: 'lǐbīng', era: '战国', region: '中国',
    rarity: 'SR', role: '器者', element: '水', tier: 3,
    ultimate: '都江堰', ultimateDesc: '凿离堆，分水鱼嘴，泽被后世',
    ultimateEffect: 'dot', accent: '#45B7D1',
    brief: '战国蜀守，主持修建都江堰，灌溉成都平原千年。',
  },
  {
    id: 'zhangqian', name: '张骞', pinyin: 'zhāngqiān', era: '汉', region: '中国',
    rarity: 'SR', role: '谋士', element: '土', tier: 3,
    ultimate: '凿空西域', ultimateDesc: '持节西行，开通道路',
    ultimateEffect: 'buff', accent: '#C0392B',
    brief: '西汉使者，两度出使西域，开辟丝绸之路。',
  },
  {
    id: 'elizabeth', name: '伊丽莎白一世', pinyin: 'yīlìshābái', era: '近代', region: '英格兰',
    rarity: 'SR', role: '谋士', element: '水', tier: 3,
    ultimate: '海权之眼', ultimateDesc: '远航结盟，以海贸固邦',
    ultimateEffect: 'buff', accent: '#9B59B6',
    brief: '英格兰与爱尔兰女王，在位期间海权扩张，赞助航海事业。',
  },
  {
    id: 'galileo', name: '伽利略', pinyin: 'jiālìlüè', era: '近代', region: '意大利',
    rarity: 'SR', role: '器者', element: '水', tier: 3,
    ultimate: '望远镜', ultimateDesc: '镜筒所指，星宿列队可见',
    ultimateEffect: 'dot', accent: '#48C9B0',
    brief: '意大利学者，以望远镜观测天体，倡导实验与数学结合。',
  },
  {
    id: 'davinci', name: '达·芬奇', pinyin: 'dáfēnqí', era: '文艺复兴', region: '意大利',
    rarity: 'SR', role: '器者', element: '木', tier: 3,
    ultimate: '飞行之翼', ultimateDesc: '以鸟为师，造机载人',
    ultimateEffect: 'dot', accent: '#58D68D',
    brief: '文艺复兴时期的画家、工程师与解剖学者，留下大量手稿。',
  },
  {
    id: 'qijiguang', name: '戚继光', pinyin: 'qíjìguāng', era: '明', region: '中国',
    rarity: 'SR', role: '统帅', element: '金', tier: 3,
    ultimate: '鸳鸯阵', ultimateDesc: '长短相济，队形变换如一',
    ultimateEffect: 'buff', accent: '#D4AC0D',
    brief: '明代将领，编练戚家军抗击东南倭患，后镇守蓟镇。',
  },
  {
    id: 'zhouyu', name: '周瑜', pinyin: 'zhōuyú', era: '三国', region: '中国',
    rarity: 'SR', role: '统帅', element: '水', tier: 3,
    ultimate: '赤壁借火', ultimateDesc: '东风既起，烈火连舟',
    ultimateEffect: 'aoe', accent: '#5499C7',
    brief: '东吴大都督，赤壁之战中与孙权共同主持水陆并进之役。',
  },
  {
    id: 'newton', name: '牛顿', pinyin: 'niúdùn', era: '近代', region: '英格兰',
    rarity: 'SR', role: '器者', element: '水', tier: 3,
    ultimate: '万有引力', ultimateDesc: '万物相引，其力可算',
    ultimateEffect: 'dot', accent: '#5DADE2',
    brief: '英格兰学者，建立经典力学体系，著《自然哲学的数学原理》。',
  },
  {
    id: 'curie', name: '居里夫人', pinyin: 'jūlǐ fūrén', era: '近代', region: '波兰',
    rarity: 'SR', role: '器者', element: '水', tier: 3,
    ultimate: '镭', ultimateDesc: '自矿石中提出新元素，光华自现',
    ultimateEffect: 'dot', accent: '#AF7AC5',
    brief: '物理学家与化学家，发现钋与镭，两获诺贝尔奖。',
  },
  {
    id: 'liguang', name: '李广', pinyin: 'lǐguǎng', era: '汉', region: '中国',
    rarity: 'SR', role: '猛将', element: '金', tier: 3,
    ultimate: '飞将军', ultimateDesc: '矢石俱尽，白首而力不衰',
    ultimateEffect: 'pierce', accent: '#B7950B',
    brief: '汉武帝时将领，号飞将军，匈奴称之为汉之飞将军。',
  },
  {
    id: 'sunbin', name: '孙膑', pinyin: 'sūnbìn', era: '战国', region: '中国',
    rarity: 'SR', role: '谋士', element: '水', tier: 3,
    ultimate: '减灶诱敌', ultimateDesc: '示弱以骄，避实击虚',
    ultimateEffect: 'control', accent: '#45B7D1',
    brief: '战国军事家，齐国军师，以围魏救赵著于史册。',
  },
  {
    id: 'zhangliang', name: '张良', pinyin: 'zhāngliáng', era: '汉', region: '中国',
    rarity: 'SR', role: '谋士', element: '水', tier: 3,
    ultimate: '运筹帷幄', ultimateDesc: '谋定后动，拾遗策立',
    ultimateEffect: 'buff', accent: '#7F8C8D',
    brief: '汉初三杰之一，辅佐刘邦，屡次建策定策。',
  },
  {
    id: 'huoqingbing', name: '霍去病', pinyin: 'huòqùbìng', era: '汉', region: '中国',
    rarity: 'SR', role: '猛将', element: '金', tier: 3,
    ultimate: '封狼居胥', ultimateDesc: '北逐诸部，登临瀚海',
    ultimateEffect: 'pierce', accent: '#C0392B',
    brief: '汉武帝时将领，数次北击匈奴，曾至狼居胥山。',
  },
  {
    id: 'octave', name: '屋大维', pinyin: 'wūdàwé', era: '罗马', region: '罗马',
    rarity: 'SR', role: '统帅', element: '金', tier: 3,
    ultimate: '元老院之治', ultimateDesc: '明示授受，以制度安邦',
    ultimateEffect: 'buff', accent: '#9B59B6',
    brief: '罗马第一位皇帝，终结了内战，开创元老院体制下的和平。',
  },
  {
    id: 'aristotle', name: '亚里士多德', pinyin: 'yàlǐshìduōdé', era: '古希腊', region: '古希腊',
    rarity: 'SR', role: '谋士', element: '木', tier: 3,
    ultimate: '格物致知', ultimateDesc: '分类万有，追本溯源',
    ultimateEffect: 'buff', accent: '#52BE80',
    brief: '古希腊哲学家，创立吕克昂学派，著作涉及逻辑、形而上学与政治学。',
  },
  {
    id: 'huatuo', name: '华佗', pinyin: 'huátuó', era: '东汉', region: '中国',
    rarity: 'SR', role: '医者', element: '木', tier: 3,
    ultimate: '青囊之术', ultimateDesc: '汤药针灸，内外并施',
    ultimateEffect: 'heal', accent: '#58D68D',
    brief: '东汉名医，擅方术针灸，传说创制麻沸散与五禽戏。',
  },
  {
    id: 'bianque', name: '扁鹊', pinyin: 'biǎnquè', era: '战国', region: '中国',
    rarity: 'SR', role: '医者', element: '水', tier: 3,
    ultimate: '望诊知病', ultimateDesc: '察色按脉，未病而先知',
    ultimateEffect: 'heal', accent: '#48C9B0',
    brief: '战国名医，《史记》载其诊病多起沉疴于未显之时。',
  },
  {
    id: 'yuefei', name: '岳飞', pinyin: 'yuèfēi', era: '宋', region: '中国',
    rarity: 'SR', role: '猛将', element: '金', tier: 3,
    ultimate: '还我河山', ultimateDesc: '北伐中原，收复失地',
    ultimateEffect: 'burst', accent: '#A04000',
    brief: '南宋抗金将领，岳家军纪律严明，以北伐著称。',
  },
  {
    id: 'sugeliadi', name: '苏格拉底', pinyin: 'sūgélādì', era: '古希腊', region: '古希腊',
    rarity: 'SR', role: '谋士', element: '水', tier: 3,
    ultimate: '诘问之辩', ultimateDesc: '以问代答，破执见而明理',
    ultimateEffect: 'control', accent: '#5499C7',
    brief: '古希腊哲学家，以对话诘问的方式探究伦理与知识。',
  },

  // ─────────── R（24） ───────────
  {
    id: 'weiqing', name: '卫青', pinyin: 'wèiqīng', era: '汉', region: '中国',
    rarity: 'R', role: '猛将', element: '金', tier: 2,
    ultimate: '长驱漠北', ultimateDesc: '率骑深入，扫荡诸部',
    ultimateEffect: 'pierce', accent: '#B7950B',
    brief: '汉武帝时将领，数次北击匈奴，位居大将军。',
  },
  {
    id: 'mayuan', name: '马援', pinyin: 'mǎyuán', era: '东汉', region: '中国',
    rarity: 'R', role: '猛将', element: '土', tier: 2,
    ultimate: '马革裹尸', ultimateDesc: '渡水远征，志在边疆',
    ultimateEffect: 'pierce', accent: '#A0522D',
    brief: '东汉将领，曾奉命出征交趾，晚年请缨西征。',
  },
  {
    id: 'banchao', name: '班超', pinyin: 'bānchāo', era: '东汉', region: '中国',
    rarity: 'R', role: '统帅', element: '土', tier: 2,
    ultimate: '投笔从戎', ultimateDesc: '三十六人平西域',
    ultimateEffect: 'buff', accent: '#A0522D',
    brief: '东汉外交家与将领，长期经营西域三十余年。',
  },
  {
    id: 'caocao', name: '曹操', pinyin: 'càocāo', era: '三国', region: '中国',
    rarity: 'R', role: '统帅', element: '金', tier: 2,
    ultimate: '挟天子以令', ultimateDesc: '奉迎銮舆，挟以征讨',
    ultimateEffect: 'buff', accent: '#B7950B',
    brief: '东汉末政治家、军事家，奠定曹魏政权基础。',
  },
  {
    id: 'hanfei', name: '韩非', pinyin: 'hánfēi', era: '战国', region: '中国',
    rarity: 'R', role: '谋士', element: '水', tier: 2,
    ultimate: '法术势', ultimateDesc: '以法为绳，以术御下，以势立威',
    ultimateEffect: 'control', accent: '#5499C7',
    brief: '战国法家代表人物，著有《韩非子》。',
  },
  {
    id: 'shangyang', name: '商鞅', pinyin: 'shāngyāng', era: '战国', region: '中国',
    rarity: 'R', role: '统帅', element: '土', tier: 2,
    ultimate: '变法图强', ultimateDesc: '废井田、开阡陌，行法令于天下',
    ultimateEffect: 'buff', accent: '#A0522D',
    brief: '战国时期政治家，在秦主持变法，奠定秦国强盛的基础。',
  },
  {
    id: 'tiandan', name: '田单', pinyin: 'tiándān', era: '战国', region: '中国',
    rarity: 'R', role: '统帅', element: '火', tier: 2,
    ultimate: '火牛阵', ultimateDesc: '束火灌尾，燃牛出阵',
    ultimateEffect: 'aoe', accent: '#D9603B',
    brief: '战国齐国将领，以火牛阵破燕军，复齐七十余城。',
  },
  {
    id: 'zhaoyun', name: '赵云', pinyin: 'zhàoyún', era: '三国', region: '中国',
    rarity: 'R', role: '猛将', element: '金', tier: 2,
    ultimate: '一身是胆', ultimateDesc: '长坂坡单骑往返，护幼主全身而退',
    ultimateEffect: 'pierce', accent: '#B7950B',
    brief: '蜀汉将领，以勇毅与谨慎著称，长期追随刘备。',
  },
  {
    id: 'zhangfei', name: '张飞', pinyin: 'zhāngfēi', era: '三国', region: '中国',
    rarity: 'R', role: '猛将', element: '土', tier: 2,
    ultimate: '当阳桥头', ultimateDesc: '据水断桥，横矛怒喝退重兵',
    ultimateEffect: 'burst', accent: '#A0522D',
    brief: '蜀汉将领，以勇猛与治军严整著称。',
  },
  {
    id: 'huangzhong', name: '黄忠', pinyin: 'huángzhōng', era: '三国', region: '中国',
    rarity: 'R', role: '猛将', element: '金', tier: 2,
    ultimate: '百步穿杨', ultimateDesc: '挽弓劲射，弦响矢至',
    ultimateEffect: 'burst', accent: '#B7950B',
    brief: '蜀汉将领，晚年以勇烈著称，常随刘备征战。',
  },
  {
    id: 'mengtian', name: '蒙恬', pinyin: 'méngtián', era: '秦', region: '中国',
    rarity: 'R', role: '统帅', element: '金', tier: 2,
    ultimate: '北筑长城', ultimateDesc: '督军北边，连接旧塞',
    ultimateEffect: 'buff', accent: '#B7950B',
    brief: '秦朝将领，率军北击匈奴并主持修筑边塞。',
  },
  {
    id: 'fankuai', name: '樊哙', pinyin: 'fánkuài', era: '汉', region: '中国',
    rarity: 'R', role: '猛将', element: '金', tier: 2,
    ultimate: '鸿门宴上', ultimateDesc: '按剑盾而西，卫主而出',
    ultimateEffect: 'pierce', accent: '#B7950B',
    brief: '汉初将领，鸿门宴上护刘邦脱身，为重臣。',
  },
  {
    id: 'lijing', name: '李靖', pinyin: 'lǐjìng', era: '唐', region: '中国',
    rarity: 'R', role: '统帅', element: '金', tier: 2,
    ultimate: '奇袭阴山', ultimateDesc: '夜行急袭，一战定边',
    ultimateEffect: 'aoe', accent: '#B7950B',
    brief: '唐朝开国名将，以灭东突厥、平定吐谷浑著称。',
  },
  {
    id: 'yuchigong', name: '尉迟恭', pinyin: 'yùchígōng', era: '唐', region: '中国',
    rarity: 'R', role: '猛将', element: '土', tier: 2,
    ultimate: '单鞭夺槊', ultimateDesc: '赤手夺敌槊，阵前请战',
    ultimateEffect: 'burst', accent: '#A0522D',
    brief: '唐初将领，以勇猛与善治军著称。',
  },
  {
    id: 'suqin', name: '苏秦', pinyin: 'sūqín', era: '战国', region: '中国',
    rarity: 'R', role: '谋士', element: '水', tier: 2,
    ultimate: '合纵连横', ultimateDesc: '六国相印，其利在一',
    ultimateEffect: 'buff', accent: '#5499C7',
    brief: '战国纵横家，游说六国合纵抗秦，后事败逃亡。',
  },
  {
    id: 'fanli', name: '范蠡', pinyin: 'fànlǐ', era: '春秋', region: '中国',
    rarity: 'R', role: '谋士', element: '水', tier: 2,
    ultimate: '三聚三散', ultimateDesc: '既助霸业，又善治生',
    ultimateEffect: 'buff', accent: '#5499C7',
    brief: '春秋楚国政治家，辅越灭吴，后弃官经商，著《养鱼经》等。',
  },
  {
    id: 'direnjie', name: '狄仁杰', pinyin: 'dírénjié', era: '唐', region: '中国',
    rarity: 'R', role: '谋士', element: '水', tier: 2,
    ultimate: '明镜高悬', ultimateDesc: '善断疑狱，荐贤为国',
    ultimateEffect: 'control', accent: '#5499C7',
    brief: '唐代名臣，擅长司法与政务，两度拜相。',
  },
  {
    id: 'guoziyi', name: '郭子仪', pinyin: 'guōzǐyí', era: '唐', region: '中国',
    rarity: 'R', role: '统帅', element: '金', tier: 2,
    ultimate: '单骑退回纥', ultimateDesc: '免胄见虏，反定其心',
    ultimateEffect: 'heal', accent: '#B7950B',
    brief: '唐代名将，平安史之乱与回纥交涉中劳苦功高，寿终高龄。',
  },
  {
    id: 'likui', name: '李悝', pinyin: 'lǐkuī', era: '战国', region: '中国',
    rarity: 'R', role: '谋士', element: '水', tier: 2,
    ultimate: '法经变法', ultimateDesc: '著法经以为国制',
    ultimateEffect: 'buff', accent: '#5499C7',
    brief: '战国魏国政治家，推行变法，著《法经》。',
  },
  {
    id: 'shenkuo', name: '沈括', pinyin: 'shěnkuò', era: '宋', region: '中国',
    rarity: 'R', role: '器者', element: '水', tier: 2,
    ultimate: '梦溪笔谈', ultimateDesc: '录见闻，察物理',
    ultimateEffect: 'dot', accent: '#5499C7',
    brief: '北宋学者，著《梦溪笔谈》，涉及天文、数学、物理与地质。',
  },
  {
    id: 'bisheng', name: '毕昇', pinyin: 'bìshēng', era: '宋', region: '中国',
    rarity: 'R', role: '器者', element: '木', tier: 2,
    ultimate: '活字印刷', ultimateDesc: '胶泥刻字，火烧令坚',
    ultimateEffect: 'dot', accent: '#52BE80',
    brief: '北宋布衣，创制胶泥活字印刷术，《梦溪笔谈》载之。',
  },
  {
    id: 'cailun', name: '蔡伦', pinyin: 'càilún', era: '东汉', region: '中国',
    rarity: 'R', role: '器者', element: '木', tier: 2,
    ultimate: '造纸之法', ultimateDesc: '树肤麻以为纸，省费简牍',
    ultimateEffect: 'dot', accent: '#52BE80',
    brief: '东汉宦官，封侯，改进造纸术并奏上。',
  },
  {
    id: 'zhangheng', name: '张衡', pinyin: 'zhānghéng', era: '东汉', region: '中国',
    rarity: 'R', role: '器者', element: '水', tier: 2,
    ultimate: '浑天仪', ultimateDesc: '制仪测天，以候星移',
    ultimateEffect: 'dot', accent: '#5499C7',
    brief: '东汉科学家，制作浑天仪与候风地动仪，著《灵宪》。',
  },
  {
    id: 'xuanzang', name: '玄奘', pinyin: 'xuánzàng', era: '唐', region: '中国',
    rarity: 'R', role: '谋士', element: '木', tier: 2,
    ultimate: '西行求法', ultimateDesc: '越葱岭，历十七国',
    ultimateEffect: 'buff', accent: '#52BE80',
    brief: '唐代高僧，西行天竺求法，携经回译，著《大唐西域记》。',
  },

  // ─────────── N（12） ───────────
  {
    id: 'fuhao', name: '妇好', pinyin: 'fùhǎo', era: '商', region: '中国',
    rarity: 'N', role: '猛将', element: '土', tier: 1,
    ultimate: '妇好将军', ultimateDesc: '帥师征伐，屡见于甲骨卜辞',
    ultimateEffect: 'burst', accent: '#A0522D',
    brief: '商王武丁之妻，卜辞中多次记载其带兵出征。',
  },
  {
    id: 'caiwenji', name: '蔡文姬', pinyin: 'càiwénjī', era: '东汉', region: '中国',
    rarity: 'N', role: '谋士', element: '木', tier: 1,
    ultimate: '悲愤成辞', ultimateDesc: '作《胡笳十八拍》，寄哀思于弦管',
    ultimateEffect: 'control', accent: '#52BE80',
    brief: '东汉文学家、音乐家，善琴与辞章，传世作品见于《后汉书》。',
  },
  {
    id: 'banzhao', name: '班昭', pinyin: 'bānzhāo', era: '东汉', region: '中国',
    rarity: 'N', role: '谋士', element: '水', tier: 1,
    ultimate: '续修汉书', ultimateDesc: '奉诏续成《汉书》八表',
    ultimateEffect: 'buff', accent: '#5499C7',
    brief: '东汉史学家，班固之妹，续成《汉书》并奉诏教授经史。',
  },
  {
    id: 'wangzhaojun', name: '王昭君', pinyin: 'wángzhāojūn', era: '西汉', region: '中国',
    rarity: 'N', role: '谋士', element: '水', tier: 1,
    ultimate: '出塞和亲', ultimateDesc: '请行和亲，自请远适',
    ultimateEffect: 'buff', accent: '#5499C7',
    brief: '西汉宫女，出嫁匈奴呼韩邪单于，事见《汉书·匈奴传》。',
  },
  {
    id: 'caodajia', name: '曹大家', pinyin: 'cáodàjiā', era: '东汉', region: '中国',
    rarity: 'N', role: '谋士', element: '木', tier: 1,
    ultimate: '授书宫中', ultimateDesc: '以学者为诸贵人师',
    ultimateEffect: 'buff', accent: '#52BE80',
    brief: '东汉班昭之姊曹氏，通经史，马融曾受其业。',
  },
  {
    id: 'xianfuren', name: '冼夫人', pinyin: 'xiǎnfūrén', era: '隋唐', region: '中国',
    rarity: 'N', role: '统帅', element: '木', tier: 1,
    ultimate: '抚蛮安民', ultimateDesc: '岭南俚帅，隋唐之际保境安民',
    ultimateEffect: 'heal', accent: '#52BE80',
    brief: '岭南俚族首领，历梁陈隋三朝，受封谯国夫人。',
  },
  {
    id: 'taoyuanming', name: '陶渊明', pinyin: 'táoyuánmíng', era: '东晋', region: '中国',
    rarity: 'N', role: '谋士', element: '木', tier: 1,
    ultimate: '归园田居', ultimateDesc: '不为五斗米折腰',
    ultimateEffect: 'heal', accent: '#52BE80',
    brief: '东晋诗人，归隐田园，诗文平淡自然而意蕴深远。',
  },
  {
    id: 'zhenghe', name: '郑和', pinyin: 'zhènghé', era: '明', region: '中国',
    rarity: 'N', role: '统帅', element: '水', tier: 1,
    ultimate: '下西洋', ultimateDesc: '宝船远航，通诸国之好',
    ultimateEffect: 'buff', accent: '#5499C7',
    brief: '明朝宦官与航海家，七下西洋，编《郑和航海图》。',
  },
  {
    id: 'wentianxiang', name: '文天祥', pinyin: 'wéntiānxiáng', era: '宋', region: '中国',
    rarity: 'N', role: '统帅', element: '火', tier: 1,
    ultimate: '留取丹心', ultimateDesc: '兵败被俘，辞请归国',
    ultimateEffect: 'heal', accent: '#D9603B',
    brief: '南宋大臣，抗元被俘后拒降，从容就义。',
  },
  {
    id: 'yuanchonghuan', name: '袁崇焕', pinyin: 'yuánchónghuàn', era: '明', region: '中国',
    rarity: 'N', role: '统帅', element: '土', tier: 1,
    ultimate: '宁远城守', ultimateDesc: '据坚城以拒努尔哈赤',
    ultimateEffect: 'buff', accent: '#A0522D',
    brief: '明朝将领，长期主持辽东防务，以宁远之战著称。',
  },
  {
    id: 'lishizhen', name: '李时珍', pinyin: 'lǐshízhēn', era: '明', region: '中国',
    rarity: 'N', role: '器者', element: '木', tier: 1,
    ultimate: '本草纲目', ultimateDesc: '遍尝百草，考校旧典',
    ultimateEffect: 'heal', accent: '#52BE80',
    brief: '明朝医药学家，历二十七年编成《本草纲目》。',
  },
  {
    id: 'xuxiake', name: '徐霞客', pinyin: 'xúxiákè', era: '明', region: '中国',
    rarity: 'N', role: '谋士', element: '木', tier: 1,
    ultimate: '游历山河', ultimateDesc: '足迹遍西南，纪行成书',
    ultimateEffect: 'buff', accent: '#52BE80',
    brief: '明朝地理学家，游历名山大川三十余年，著《徐霞客游记》。',
  },
]

export const ROSTER_INDEX = new Map(ROSTER.map((r) => [r.id, r]))
