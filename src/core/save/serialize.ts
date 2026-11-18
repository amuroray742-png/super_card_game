/**
 * 存档序列化与反序列化。
 */
import type { SaveData } from '../model/types.ts'
import { migrate, normalizeSave, SAVE_VERSION } from './schema.ts'

export function serialize(save: SaveData): string {
  return JSON.stringify(save)
}

/** 客户端存档投影。权威随机状态只写入服务端数据库。 */
export function serializePublicSave({ rng: _privateRng, ...publicSave }: SaveData): string {
  return JSON.stringify(publicSave)
}

export function deserialize(text: string): SaveData {
  const raw = JSON.parse(text) as Partial<SaveData> | null
  const normalized = normalizeSave(raw)
  const version = raw?.version
  normalized.version = typeof version === 'number' && Number.isSafeInteger(version) && version > 0 ? version : 1
  return migrate(normalized)
}

export function deserializePublicSave(text: string): SaveData {
  const save = deserialize(text)
  save.rng = { seed: 0, counter: 0 }
  return save
}

/** 导出为可分享的存档串（base64） */
export function exportSave(save: SaveData): string {
  const json = serializePublicSave(save)
  const bytes = new TextEncoder().encode(json)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
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
