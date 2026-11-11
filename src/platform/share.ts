/**
 * 分享适配层 —— 首发为 no-op。
 */
export interface ShareAdapter {
  share(title: string, text: string, url?: string): Promise<boolean>
}

export class NoopShareAdapter implements ShareAdapter {
  async share(_title: string, _text: string, _url?: string): Promise<boolean> {
    return false
  }
}

export const share: ShareAdapter = new NoopShareAdapter()
