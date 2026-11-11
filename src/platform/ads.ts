/**
 * 激励视频适配层 —— 首发为 no-op（不接任何广告 SDK）。
 *
 * 离线结算弹窗预留「立即结算」按钮位，后续可在此接入。
 */
export interface AdAdapter {
  isRewardedReady(placement: string): Promise<boolean>
  showRewarded(placement: string): Promise<{ completed: boolean }>
}

export class NoopAdAdapter implements AdAdapter {
  async isRewardedReady(_placement: string): Promise<boolean> {
    return false
  }

  async showRewarded(_placement: string): Promise<{ completed: boolean }> {
    return { completed: false }
  }
}

export const ads: AdAdapter = new NoopAdAdapter()

/** 激励位 id */
export const AD_PLACEMENTS = {
  OFFLINE_INSTANT: 'offline_instant',
  DOUBLE_EXP: 'double_exp',
} as const
