/**
 * 平台适配层：本地存档（首发实现）。
 *
 * presentation 层禁止直接访问 localStorage，一律经此接口（§12.3 铁律 #6）。
 */
import type { SaveData } from '../core/model/types.ts'
import { deserializePublicSave, exportSave, importSave, serializePublicSave } from '../core/save/serialize.ts'
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
    const key = this.key(slot)
    const text = localStorage.getItem(key)
    if (!text) return null
    try {
      const save = deserializePublicSave(text)
      if (slot !== ACCOUNT_STORAGE_KEYS.LEGACY_SAVE_SLOT && Object.hasOwn(JSON.parse(text) ?? {}, 'rng')) {
        // 清理旧版账号缓存，保留迁移通道中的原始旧档。
        try { localStorage.setItem(key, serializePublicSave(save)) } catch { /* 仍可只读查看 */ }
      }
      return save
    } catch {
      return null
    }
  }

  async save(slot: string, data: SaveData): Promise<void> {
    localStorage.setItem(this.key(slot), serializePublicSave(data))
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
      return deserializePublicSave(text)
    } catch {
      return null
    }
  }

  async save(slot: string, data: SaveData): Promise<void> {
    this.store.set(slot, serializePublicSave(data))
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

/**
 * 会话级标记（关掉标签页即失效）。
 *
 * ⚠ **与存档标记分开**：存档标记要跨会话保留（迁移只做一次）；
 *   而「已经兜底过几次」这种闩锁**必须随会话结束而清零**，
 *   否则玩家下次打开游戏还会被当成「已经试过了」→ 直接被回退到首页。
 *
 * ⚠ 表现层不直接碰 sessionStorage（铁律 #6：本地存储一律经平台层）。
 */
export const sessionFlags = {
  /** 读取标记（没有则 null） */
  get(key: string): string | null {
    try {
      return typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(key) : null
    } catch {
      return null
    }
  },
  /** 写入标记；null 表示清除 */
  set(key: string, value: string | null): void {
    try {
      if (typeof sessionStorage === 'undefined') return
      if (value === null) sessionStorage.removeItem(key)
      else sessionStorage.setItem(key, value)
    } catch {
      /* 隐私模式等场景写不进去：退化成「不兜底」，不影响主流程 */
    }
  },
  /** 读成计数（非数字 / 负数一律当 0） */
  count(key: string): number {
    const n = Number(this.get(key))
    return Number.isFinite(n) && n > 0 ? n : 0
  },
  /** 计数 +1，返回新值 */
  bump(key: string): number {
    const next = this.count(key) + 1
    this.set(key, String(next))
    return next
  },
  /** 清除标记 */
  clear(key: string): void {
    this.set(key, null)
  },
}
