/**
 * 合规文案（用户协议 / 隐私披露 / 客服 / 概率公示版本）。
 *
 * ## 为什么单独抽一个模块
 *
 * 合规文案是**会被审**的内容，必须有唯一出处：
 * 界面（ComplianceView）只负责渲染，**不自己拼任何条款文字**；
 * 要改条款只改这里，避免「界面写一套、文档写一套、实际执行又是另一套」。
 *
 * ## 数字用占位符，不写死
 *
 * 涉及概率、保底、印记折算的数值一律写成 `{key}` 占位符，
 * 由界面在渲染时用 core 的实时值填充（公示 = 实际）。
 * 占位符没被填充时会原样显示 `{key}`，方便一眼看出漏配。
 *
 * ## 运营联系方式从哪来
 *
 * 客服邮箱走构建期环境变量 `VITE_CONTACT_EMAIL`：
 * 未配置时展示「尚未配置」，而不是留一个假地址糊弄玩家。
 * 正式发布前必须在 `.env` 里填成真实邮箱（见 .env.example）。
 */

/** 概率公示版本号。规则或概率一变就要 +1 并更新生效日期。 */
export const RATES_PUBLICATION = {
  version: 'v1',
  /** 公示生效日期（YYYY-MM-DD） */
  effectiveFrom: '2026-11-18',
} as const

/**
 * 读取构建期环境变量。
 * 用 cast 而不是直接 `import.meta.env.X`：本模块也可能被 Node 侧脚本引用，
 * 那里 `import.meta.env` 不存在，直接取属性会抛错。
 */
function readEnv(key: string): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  return env?.[key]?.trim() ?? ''
}

/** 运营联系方式 */
export const CONTACT = {
  /** 客服 / 运营邮箱（构建期注入；未配置时为空串） */
  email: readEnv('VITE_CONTACT_EMAIL'),
  /** 邮箱没配时的兜底文案 */
  missing: '尚未配置（正式发布前必须填写 .env 的 VITE_CONTACT_EMAIL）',
  /** 响应时限 */
  replyTime: '7 个工作日内',
} as const

export interface ComplianceSection {
  /** 章节标识（供测试与锚点引用） */
  id: string
  title: string
  /**
   * 条目文案。`**粗体**` 会被渲染成加粗片段（不走 v-html，避免注入风险）。
   * `{key}` 是占位符，由界面用实时值填充。
   */
  items: string[]
}

/** 一、召唤概率公示（表格由界面按实时概率渲染，这里是表下注记） */
export const RATES_TABLE_NOTES: ComplianceSection = {
  id: 'rates',
  title: '召唤概率公示',
  items: [
    '基础概率为单抽概率，各卡池四档之和均为 100.00 个百分点。',
    '综合概率指一次十连内至少出现 1 次该稀有度或更高品质的概率。',
    '综合概率由**精确动态规划**求解，与实际召唤使用同一套概率函数，不含模拟误差。',
    '十连保底规则保证十连内至少出现 1 个 {tenPullFloor} 及以上品质，'
      + '故对应行显示 100.00 个百分点。',
    '未收录稀有度的单抽概率并入该池最低稀有度。十连综合概率仍按该稀有度或更高品质统计。',
    '本页数值随当前保底进度实时刷新，抽取结果以实际结算为准。',
  ],
}

/** 二、保底规则 */
export const PITY_RULES: ComplianceSection = {
  id: 'pity',
  title: '保底规则',
  items: [
    '大保底上限：{pityMax} 抽。保底计数达到上限后，下一抽由保底规则直接结算为 SSR 品质。',
    '软保底起点：第 {softPityStart} 抽起，SSR 概率随保底计数线性提升。',
    '十连保底：一次十连内若未出现 {tenPullFloor} 及以上品质，最后一抽由保底规则结算。',
    '首次十连至少获得一位 SSR。账号尚有该资格时，各适用卡池的综合概率均计入该规则。',
    '保底计数跨卡池继承，在各卡池之间共用同一份计数，不会因切换卡池而重置。',
    '当前保底进度：距保底结算还差 {pityRemaining} 抽。',
  ],
}

/** 三、重复获取规则 */
export const DUPLICATE_RULES: ComplianceSection = {
  id: 'duplicate',
  title: '重复获取规则',
  items: [
    '**重复英灵不直接提升强度**，统一转化为通用英灵印记。',
    '重复获得的英灵按品质折算印记：SSR {dupSsr} · SR {dupSr} · R {dupR} · N {dupN}。',
    '重复的 SSR 另附同名碎片 {ssrShards}，重复的 N 另附银两 {nSilver}。',
    '星级提升需要同名碎片与印记，属于独立养成路线，重复召唤本身不提升星级或等级。',
  ],
}

/** 四、竞技场产出隔离 */
export const ARENA_ISOLATION: ComplianceSection = {
  id: 'arena',
  title: '竞技场产出隔离',
  items: [
    '竞技场只产出竞技专属资源（竞技勋章、竞技材料、兑换券）。',
    '竞技场**不产出银两、经验、强化石、圣杯结晶**，产出不会回流主线养成经济。',
    '竞技对战使用归一化规则：单位属性按定位模板重置，'
      + '等级、遗物强化等级、遗物随机词条与永久加成不参与计算。',
    '竞技勋章设有每周获取上限，避免竞技产出影响整体养成节奏。',
  ],
}

/** 五、付费与广告 */
export const PAYMENT_AND_ADS: ComplianceSection = {
  id: 'payment',
  title: '付费与广告',
  items: [
    '首发版本不提供真实货币充值入口，也没有内购项目。',
    '首发版本不接入广告 SDK，不展示任何广告内容。',
    '平台层仅预留支付与广告适配接口，便于后续按需接入。',
  ],
}

/** 六、隐私披露 */
export const PRIVACY: ComplianceSection = {
  id: 'privacy',
  title: '隐私披露',
  items: [
    '本游戏收集的信息仅限维持账号与进度所必需的范围：账号名、口令哈希、'
      + '游戏进度（英灵、遗物、资源与关卡进度）以及登录会话凭据。',
    '本游戏不收集手机号、身份证件、精确位置、通讯录、相册与麦克风等敏感信息，'
      + '也不读取设备上的其他应用数据。',
    '上述信息用于提供账号登录与云端存档同步、排查异常与防止作弊，'
      + '不会用于广告投放，也不会向第三方出售。',
    '游戏进度保存在运营方的服务器数据库中；本地浏览器缓存仅用于加速首屏与'
      + '断网查看，属于可丢弃的只读副本。',
    '玩家可通过客服邮箱申请导出或删除自己的账号数据；'
      + '删除后该账号的云端进度将无法恢复。',
  ],
}

/** 七、账号与数据 */
export const ACCOUNT_AND_DATA: ComplianceSection = {
  id: 'account',
  title: '账号与数据',
  items: [
    '游戏需要玩家自设用户名与口令登录，账号仅用于保存进度，不与真实身份绑定。',
    '口令以加盐的不可逆哈希形式保存，服务端不保存也不回传口令明文。',
    '游戏进度随账号保存在服务端，登录同一账号可在其他设备继续；本机同时保留一份副本。',
    '玩家可在设置页导出存档串作为备份，也可退出登录或注销账号；'
      + '注销账号会一并删除该账号的云端存档与登录状态。',
    '删除账号、退出登录与清空本机存档均可由玩家随时发起，不需要联系客服。',
  ],
}

/** 八、用户协议要点 */
export const USER_AGREEMENT: ComplianceSection = {
  id: 'agreement',
  title: '用户协议要点',
  items: [
    '本游戏为免费试玩版本，游戏内不设任何付费内容，也不存在付费抽卡。',
    '账号由玩家自行注册：一个账号对应一份云端存档；账号之间不互通，'
      + '请妥善保管登录凭据。',
    '当前版本不提供账号自助找回。若无法登录，可通过下方客服邮箱联系运营，'
      + '由运营在核实后协助处理。',
    '游戏内容为基于历史人物的架空演绎，人物设定与史实并不等同，'
      + '传记段落仅作史实叙述之用。',
    '禁止使用外挂、脚本、多开或其他自动化手段获取游戏进度；'
      + '违规账号的存档可能被清理。',
  ],
}

/** 九、客服与账号找回 */
export const SUPPORT: ComplianceSection = {
  id: 'support',
  title: '客服与账号找回',
  items: [
    '客服邮箱：{contactEmail}；回复时限 {replyTime}。',
    '账号找回：当前版本不提供自助找回，请通过客服邮箱说明账号名与可验证信息，'
      + '由运营人工核实后处理。',
    '投诉与建议同样通过客服邮箱提交，我们会逐条阅读并回复。',
  ],
}

/** 十、概率公示说明 */
export const RATES_NOTES: ComplianceSection = {
  id: 'rates-notes',
  title: '概率公示说明',
  items: [
    `公示版本 ${RATES_PUBLICATION.version}，自 ${RATES_PUBLICATION.effectiveFrom} 起生效。`,
    '抽卡概率由服务端按公示数值计算，客户端不参与随机；'
      + '同一账号的抽卡序列不会因刷新或换设备而重放。',
    '基础概率为单抽概率；十连的实际概率按保底规则结算，'
      + '两列数值与实际抽卡结果使用同一套计算。',
    '重复获得的英灵会转化为通用养成材料，不直接提升该英灵强度。',
  ],
}

/** 十一、适龄提示 */
export const AGE_NOTICE: ComplianceSection = {
  id: 'age',
  title: '适龄提示',
  items: [
    '本游戏适合 16 周岁及以上人群游玩。',
    '请合理安排游戏时间，享受健康生活。',
    '本游戏不含玩家之间的社交互动、交易与实时对战内容，账号仅用于保存进度。',
  ],
}

/** 十二、史实说明 */
export const HISTORY_NOTICE: ComplianceSection = {
  id: 'history',
  title: '史实说明',
  items: [
    '英灵原型为史册可考的历史人物，仅作为正面友方形象出现。',
    '敌对角色全部为虚构的非历史人物形象，由灵体、妖异、幻想体与器械造物构成。',
    '人物传记仅述史实，不对历史人物作功过评价。',
    '游戏内的数值、称号与玩法设定均为虚构，不构成对历史记载的改动。',
  ],
}

/** 合规页展示的全部章节（顺序即页面顺序） */
export const COMPLIANCE_SECTIONS: ComplianceSection[] = [
  RATES_TABLE_NOTES,
  PITY_RULES,
  DUPLICATE_RULES,
  ARENA_ISOLATION,
  PAYMENT_AND_ADS,
  PRIVACY,
  ACCOUNT_AND_DATA,
  USER_AGREEMENT,
  SUPPORT,
  RATES_NOTES,
  AGE_NOTICE,
  HISTORY_NOTICE,
]

/** 占位符可用的变量表 */
export type ComplianceVars = Record<string, string | number>

/**
 * 填充 `{key}` 占位符。
 * 未提供的 key 原样保留（宁可看到 `{pityMax}` 也不要显示成空白或 0）。
 */
export function fillTemplate(text: string, vars: ComplianceVars): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in vars ? String(vars[key]) : match,
  )
}

/** 填充整节的文案 */
export function fillSection(section: ComplianceSection, vars: ComplianceVars): string[] {
  return section.items.map((item) => fillTemplate(item, vars))
}

/** 粗体片段（`**文字**`），供模板逐段渲染 */
export interface RichPart {
  text: string
  bold: boolean
}

/** 把带 `**` 标记的文案拆成粗体 / 普通片段（不走 v-html） */
export function richParts(text: string): RichPart[] {
  const parts: RichPart[] = []
  text.split(/(\*\*[^*]+\*\*)/g).forEach((chunk) => {
    if (!chunk) return
    const bold = chunk.startsWith('**') && chunk.endsWith('**') && chunk.length > 4
    parts.push({ text: bold ? chunk.slice(2, -2) : chunk, bold })
  })
  return parts.length > 0 ? parts : [{ text, bold: false }]
}

/** 中文序号：一、二、三 … 十二 */
export function chineseOrdinal(n: number): string {
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']
  if (n < 10) return digits[n] ?? String(n)
  if (n === 10) return '十'
  if (n < 20) return `十${digits[n - 10] ?? ''}`
  const tens = Math.floor(n / 10)
  const ones = n % 10
  return `${digits[tens] ?? ''}十${ones > 0 ? digits[ones] : ''}`
}
