/** 下载管家 World 的配置。 */
export interface DownloadsConfigSection {
  enabled: boolean
  /** 下载目录；留空用系统默认（home/Downloads）。 */
  dir: string
  /** 扫描间隔（秒）。 */
  scanSec: number
}

export const DOWNLOADS_DEFAULTS: DownloadsConfigSection = {
  enabled: false,
  dir: '',
  scanSec: 60,
}
