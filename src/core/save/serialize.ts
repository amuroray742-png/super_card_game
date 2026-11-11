/**
 * 存档序列化与反序列化。
 */
import type { SaveData } from '../model/types.ts'
import { migrate, normalizeSave, SAVE_VERSION } from './schema.ts'

export function serialize(save: SaveData): string {
  return JSON.stringify(save)
}

export function deserialize(text: string): SaveData {
  const raw = JSON.parse(text) as unknown
  const normalized = normalizeSave(raw)
  return migrate(normalized)
}

/** 导出为可分享的存档串（base64） */
export function exportSave(save: SaveData): string {
  const json = serialize(save)
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
