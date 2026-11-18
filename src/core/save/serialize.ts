/**
 * 存档序列化与反序列化（**存档分包**）。
 *
 * ── 为什么分包 ────────────────────────────────────────────────────────
 * 遗物是唯一会随挂机时长线性增长的存档字段：12 小时离线可积出数千件，
 * 整份存档会涨到 MB 级。而心跳每 5 秒一次、每次都整份重写存档并整份回包
 * → 写库量与带宽都被遗物数量绑架。
 *
 * 所以把存档拆成两层：
 *   - **主体（body）**：玩家 / 英灵 / 编队 / 任务 / 竞技 / 挂机账本……
 *     体积与遗物数量无关（数十 KB）。
 *   - **遗物实例**：每件一行，存在独立的表里，仓库按页查询。
 *
 * ⚠ **core 仍然只有一份 `SaveData` 真源**：分包只发生在
 *   「持久化表示」与「线上协议」两层，core 的动作层看到的仍是完整的存档。
 */
import type { RelicInstance, SaveData } from '../model/types.ts'
import { migrate, normalizeSave, SAVE_VERSION } from './schema.ts'

/** 存档主体（不含遗物实例数组） */
export type SaveBody = Omit<SaveData, 'relics'>

/** 存档 + 遗物的分离形态 */
export interface SplitSave {
  /** 存档主体 */
  body: SaveBody
  /** 全部遗物实例 */
  relics: RelicInstance[]
}

/** 拆分：完整存档 → 主体 + 遗物 */
export function splitSave(save: SaveData): SplitSave {
  const { relics, ...body } = save
  return { body, relics }
}

/** 合并：主体 + 遗物 → 完整存档 */
export function joinSave(split: SplitSave): SaveData {
  return { ...split.body, relics: split.relics } as SaveData
}

/** 存档中**已装备**的遗物实例（客户端镜像只需要这些） */
export function equippedRelicsOf(save: SaveData): RelicInstance[] {
  const ids = new Set(Object.values(save.equipped).map((entry) => entry.relicId))
  return save.relics.filter((relic) => ids.has(relic.uid))
}

// ─────────────────────────── 主体（服务端持久化） ───────────────────────────

/**
 * 序列化存档主体（含随机状态 —— 服务端权威，随存档落库）。
 *
 * 遗物不在这里：它们存在 `relic_instances` 表里。
 */
export function serializeSaveBody(save: SaveData): string {
  return JSON.stringify(splitSave(save).body)
}

/**
 * 读取存档主体。
 *
 * ⚠ 兼容旧格式：早期版本的 payload 是一整份存档（顶层带 `relics` 数组）。
 *   读到这种 payload 时，主体照常取出，遗物数组一并交回给调用方去拆表。
 */
export function readSaveBody(text: string): {
  body: SaveBody
  /** 旧格式 payload 里带出来的遗物；新格式为 null */
  legacyRelics: RelicInstance[] | null
} {
  const raw = JSON.parse(text) as Partial<SaveData> & { relics?: RelicInstance[] }
  if (raw && Array.isArray(raw.relics)) {
    const { relics, ...body } = raw
    return { body: body as SaveBody, legacyRelics: relics }
  }
  return { body: raw as SaveBody, legacyRelics: null }
}

/** 由主体 + 遗物还原成完整存档（含迁移链） */
export function restoreSave(body: SaveBody, relics: RelicInstance[]): SaveData {
  const merged = normalizeSave({ ...body, relics })
  const version = body.version
  merged.version = typeof version === 'number' && Number.isSafeInteger(version) && version > 0 ? version : 1
  return migrate(merged)
}

// ─────────────────────────── 客户端投影 ───────────────────────────

/**
 * 客户端存档投影。
 *
 * = 主体（去掉权威随机状态）+ **已装备**遗物。
 *
 * 仓库里的其它遗物**不在镜像里**：它们由 `GET /api/relics` 分页查询提供，
 * 否则首屏就得把整仓库拉下来（与分包的目的相反）。
 *
 * ⚠ 形状保持**扁平**（与分包前的整份存档同构）：`relics` 数组里装的只是
 *   已装备件。老客户端读得懂，新客户端也只需换一处取值口径。
 */
export function serializePublicSave(save: SaveData): string {
  const { body } = splitSave(save)
  const { rng: _privateRng, ...publicBody } = body
  return JSON.stringify({ ...publicBody, relics: equippedRelicsOf(save) })
}

/**
 * 客户端读取投影 → 存档形态（`relics` 只含已装备遗物）。
 *
 * 随机状态在客户端一律清零——权威序列只在服务端（铁律 #24）。
 */
export function deserializePublicSave(text: string): SaveData {
  const save = deserialize(text)
  save.rng = { seed: 0, counter: 0 }
  return save
}

// ─────────────────────────── 完整存档（导出 / 导入） ───────────────────────────

/** 序列化完整存档（含遗物；服务端内部用） */
export function serialize(save: SaveData): string {
  return JSON.stringify(save)
}

/** 反序列化完整存档（含遗物；旧版本走迁移链） */
export function deserialize(text: string): SaveData {
  const raw = JSON.parse(text) as Partial<SaveData> | null
  const normalized = normalizeSave(raw)
  const version = raw?.version
  normalized.version = typeof version === 'number' && Number.isSafeInteger(version) && version > 0 ? version : 1
  return migrate(normalized)
}

/**
 * 导出为可分享的存档串（base64）。
 *
 * ⚠ **必须包含全部遗物** —— 这是玩家备份串，少了遗物就不是备份。
 *   分包后客户端镜像里只有已装备遗物，所以导出串由**服务端**产出
 *   （`GET /api/save/export`），客户端不再自己拼。
 *
 * 超过导入通道上限（`SAVE_IMPORT.MAX_ENCODED_CHARS`）的大档**无法**靠导出串恢复，
 * 正式恢复路径是数据库备份（见 roadmap P1-1 / P1-3）。
 */
export function exportSave(save: SaveData): string {
  const json = serializePublicSaveFull(save)
  const bytes = new TextEncoder().encode(json)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

/** 完整存档的公开投影（保留全部遗物，只剥离权威随机状态） */
export function serializePublicSaveFull(save: SaveData): string {
  const { rng: _privateRng, ...rest } = save
  return JSON.stringify(rest)
}

/** 从存档串导入 */
export function importSave(text: string): SaveData {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const json = new TextDecoder().decode(bytes)
  return deserialize(json)
}

export { SAVE_VERSION }
