/** QQ 空间的配置段：worlds.qzone。 */
import type { ConfigGroup } from 'cortico/core/types.ts';

export interface QzoneConfigSection {
  enabled: boolean;
  /**
   * NapCat 的 HTTP 端点（含协议和端口）。
   *
   * 一台机器上跑多个实例时，每个实例的 NapCat 端口不一样，这里要填本实例的那个：填成别的
   * 实例的端口就是把说说发到了别人的账号上，而调用本身会成功，不会报错。
   */
  httpUrl: string;
  /** Explicit image library; empty uses this World's data directory. */
  stickerDir: string;
  /** 每天最多发几条 */
  maxPerDay: number;
  /** 发的时候带图的概率 */
  withImageChance: number;
  /** 带图时，图片体积上限（字节） */
  maxImageBytes: number;
  /** 静默时段：从几点到几点不发（本地时间，24 小时制） */
  quietFrom: number;
  quietTo: number;
  /** 发出去之后的可见范围。1 = 所有人可见，4 = 好友可见，16 = 部分好友可见，
   *  64 = 仅自己可见，128 = 部分好友不可见（NapCat 的定义） */
  ugcRight: number;
  /** 正文长度上限 */
  maxChars: number;
  /** 隔多久检查一次"要不要提醒它发说说"（分钟）。0 = 从不提醒 */
  nudgeEveryMinutes: number;
  /** 两次提醒之间至少隔多久（分钟）。这是真正的频率旋钮 */
  nudgeMinGapMinutes: number;
}

export const QZONE_DEFAULTS: QzoneConfigSection = {
  enabled: false,
  httpUrl: 'http://127.0.0.1:3000',
  stickerDir: '',
  maxPerDay: 1,
  withImageChance: 0.5,
  maxImageBytes: 1_048_576,
  quietFrom: 23,
  quietTo: 9,
  ugcRight: 1,
  maxChars: 200,
  nudgeEveryMinutes: 15,
  nudgeMinGapMinutes: 80,
};

export const QZONE_CONFIG_GROUP: ConfigGroup = {
  id: 'world:qzone',
  owner: 'world:qzone',
  schema: {
    type: 'object',
    title: 'QQ 空间',
    description: '让它能发说说。发出去就是真的发出去了，别人看得见。',
    properties: {
      'worlds.qzone.stickerDir': { type: 'string', title: '配图库目录', 'x-hot': false, description: '留空使用部署 dataDir/qzone/stickers；相对路径以 dataDir/qzone 为基准。不会扫描 Persona Memory 或其他扩展目录。保存后重新挂载。' },
      'worlds.qzone.httpUrl': {
        type: 'string', title: 'NapCat 端点', 'x-hot': false,
        description: '这台机器上那个实例的 NapCat HTTP 地址（如 http://127.0.0.1:3000）。'
          + '同机多开时**各填各的端口**，填错会把说说发到别的账号的空间里。改动重启生效。',
      },
      'worlds.qzone.maxPerDay': {
        type: 'integer', title: '每天最多几条', minimum: 0, maximum: 10,
        'x-suffix': '条', 'x-hot': true, description: '多了就像刷屏。',
      },
      'worlds.qzone.withImageChance': {
        type: 'number', title: '带图的概率', minimum: 0, maximum: 1,
        'x-hot': true, description: '带图时从它的表情包里随手挑一张。',
      },
      'worlds.qzone.quietFrom': {
        type: 'integer', title: '静默开始（点）', minimum: 0, maximum: 23,
        'x-suffix': '时', 'x-hot': true, description: '这个时间之后不发。',
      },
      'worlds.qzone.quietTo': {
        type: 'integer', title: '静默结束（点）', minimum: 0, maximum: 23,
        'x-suffix': '时', 'x-hot': true, description: '这个时间之前不发。',
      },
      'worlds.qzone.ugcRight': {
        type: 'integer', title: '可见范围', minimum: 1, maximum: 128,
        'x-hot': false,
        description: '1=所有人可见 4=好友可见 16=部分好友可见 64=仅自己可见 128=部分好友不可见。'
          + '改动重启生效。',
      },
      'worlds.qzone.maxChars': {
        type: 'integer', title: '正文长度上限', minimum: 20, maximum: 1000,
        'x-suffix': '字', 'x-hot': true, description: '说说不该是一篇小作文。',
      },
      'worlds.qzone.maxImageBytes': {
        type: 'integer', title: '配图体积上限', minimum: 65536, maximum: 10485760,
        multipleOf: 65536, 'x-scale': 1048576, 'x-suffix': 'MB',
        'x-hot': true, description: '超过这个大小的图不发。',
      },
      'worlds.qzone.nudgeMinGapMinutes': {
        type: 'integer', title: '多久提醒它一次', minimum: 0, maximum: 720,
        'x-suffix': '分钟', 'x-hot': true,
        description: '提醒只是「起个念」，发不发由它定。0 = 从不提醒（只会被动等你提）。',
      },
      'worlds.qzone.nudgeEveryMinutes': {
        type: 'integer', title: '检查间隔', minimum: 0, maximum: 120,
        'x-suffix': '分钟', 'x-hot': false,
        description: '节奏用的，一般不用改。只有这个键要重启 World 才生效。0 = 关掉提醒。',
      },
    },
  },
};
