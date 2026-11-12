/**
 * 平台适配层：本地存档（首发实现）。
 *
 * presentation 层禁止直接访问 localStorage，一律经此接口（§12.3 铁律 #6）。
 */
import type { SaveData } from '../core/model/types.ts'
import { deserialize, exportSave, importSave, serialize } from '../core/save/serialize.ts'
import { ACCOUNT_STORAGE_KEYS } from '../core/config/account.ts'

export interface StorageAdapter {
  load(slot: string): Promise<SaveData | null>
  save(slot: string, data: SaveData): Promise<void>
  export(data: SaveData): Promise<string>
  import(text: string): Promise<SaveData>
  clear(slot: string): Promise<void>
  /** 读取布尔标记（键名**不带**存档前缀，如「存量档已迁走」） */
  getFlag(key: string): Promise<boolean>
  /** 写入布尔标记；false 表示清除 */
  setFlag(key: string, value: boolean): Promise<void>
}

/** 槽位键前缀（唯一口径，见 core/config/account.ts） */
const PREFIX = ACCOUNT_STORAGE_KEYS.SAVE_SLOT_PREFIX

export class LocalStorageAdapter implements StorageAdapter {
  private key(slot: string): string {
    return `${PREFIX}${slot}`
  }

  async load(slot: string): Promise<SaveData | null> {
    const text = localStorage.getItem(this.key(slot))
    if (!text) return null
    try {
      return deserialize(text)
    } catch {
      return null
    }
  }

  async save(slot: string, data: SaveData): Promise<void> {
    localStorage.setItem(this.key(slot), serialize(data))
  }

  async export(data: SaveData): Promise<string> {
    return exportSave(data)
  }

  async import(text: string): Promise<SaveData> {
    return importSave(text)
  }

  async clear(slot: string): Promise<void> {
    localStorage.removeItem(this.key(slot))
  }

  async getFlag(key: string): Promise<boolean> {
    return localStorage.getItem(key) === '1'
  }

  async setFlag(key: string, value: boolean): Promise<void> {
    if (value) localStorage.setItem(key, '1')
    else localStorage.removeItem(key)
  }
}

/** 内存适配器（测试与无存储环境） */
export class MemoryStorageAdapter implements StorageAdapter {
  private store = new Map<string, string>()

  async load(slot: string): Promise<SaveData | null> {
    const text = this.store.get(slot)
    if (!text) return null
    try {
      return deserialize(text)
    } catch {
      return null
    }
  }

  async save(slot: string, data: SaveData): Promise<void> {
    this.store.set(slot, serialize(data))
  }

  async export(data: SaveData): Promise<string> {
    return exportSave(data)
  }

  async import(text: string): Promise<SaveData> {
    return importSave(text)
  }

  async clear(slot: string): Promise<void> {
    this.store.delete(slot)
  }

  async getFlag(key: string): Promise<boolean> {
    return this.store.get(key) === '1'
  }

  async setFlag(key: string, value: boolean): Promise<void> {
    if (value) this.store.set(key, '1')
    else this.store.delete(key)
  }
}

export const storage: StorageAdapter =
  typeof localStorage !== 'undefined' ? new LocalStorageAdapter() : new MemoryStorageAdapter()
