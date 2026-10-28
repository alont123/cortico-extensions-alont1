/**
 * 电脑操作（cua）的配置。
 *
 * 这里是**唯一**的开关来源：World 的 enabled 由它给，输入能力由 allowInput 给。
 * 默认 allowInput=false——看得见可以，动手要有主人的明确授权。
 */
import type { ConfigGroup } from 'cortico/core/config-schema.ts';

export interface CuaConfigSection {
  /** 挂不挂这个 World。看截图不算"动手"，但整个扩展关掉就什么都不做。 */
  enabled: boolean;
  /** 截图缩放到的最长边（像素）。模型看到的坐标按这张缩小图算。 */
  shot: number;
  /** JPEG 质量 1-100。 */
  quality: number;
  /** 使用者动过键鼠后，等这么多毫秒再动手；使用者一直在动就不动手。 */
  idleMs: number;
  /**
   * 是否允许**输入**（点击/打字/按键）。
   * 关着的时候只有只读能力：截图、列窗口、等待。
   */
  allowInput: boolean;
  /** 自由玩：批准后她可以自己操作一段时间，危险动作另外问。 */
  freePlay: {
    /** 开了才有「申请自己玩」这条路；每次仍要主人批准。 */
    enabled: boolean;
    /** 一次批准多少分钟。 */
    minutesPerSession: number;
    /** 一天最多批准几次。 */
    maxSessionsPerDay: number;
    /** 越过危险线时是否停下来问主人（关掉等于全权信任，不建议）。 */
    askDangerous: boolean;
    /** 空闲多少分钟后提醒她可以申请自己玩。 */
    idleMinutes: number;
  };
}

export const CUA_DEFAULTS: CuaConfigSection = {
  enabled: false,
  shot: 1280,
  quality: 70,
  idleMs: 1200,
  allowInput: false,
  freePlay: {
    enabled: false,
    minutesPerSession: 20,
    maxSessionsPerDay: 3,
    askDangerous: true,
    idleMinutes: 15,
  },
};

export const CUA_CONFIG_GROUP: ConfigGroup = {
  id: 'world:cua',
  owner: 'world:cua',
  schema: {
    type: 'object',
    title: '电脑操作',
    description: '看见并操作这台电脑的主屏幕。',
    properties: {
      'worlds.cua.enabled': { type: 'boolean', title: '启用', 'x-hot': true, description: '关掉后这个 World 整个不挂。' },
      'worlds.cua.shot': { type: 'integer', title: '截图最长边', minimum: 480, maximum: 2048, 'x-hot': true, description: '截图缩放到的最长边像素；模型给的坐标按这张图算。' },
      'worlds.cua.quality': { type: 'integer', title: 'JPEG 质量', minimum: 30, maximum: 95, description: '太低看不清小字，太高费 token。' },
      'worlds.cua.idleMs': { type: 'integer', title: '使用者静止多久才动手', minimum: 0, maximum: 10000, description: '使用者动过键鼠后要等这么久；使用者一直在用就不动手。' },
      'worlds.cua.allowInput': { type: 'boolean', title: '允许操作键鼠', 'x-hot': true, description: '关着=只能看（截图/列窗口/等待）。打开后她才能点击、打字、按键。' },
      'worlds.cua.freePlay.enabled': { type: 'boolean', title: '允许她申请自己玩', description: '开了之后她可以申请一段自由时间；每次都要主人批准。' },
      'worlds.cua.freePlay.minutesPerSession': { type: 'integer', title: '一次批准多少分钟', minimum: 1, maximum: 120, description: '每次申请的时长；主人批准时可以改。' },
      'worlds.cua.freePlay.maxSessionsPerDay': { type: 'integer', title: '一天最多几次', minimum: 1, maximum: 10, description: '防止她一天到晚申请。' },
      'worlds.cua.freePlay.askDangerous': { type: 'boolean', title: '危险动作先问', description: '支付/密码/删除/设置这类窗口和输入，先问主人允许不允许。关掉等于全权信任。' },
      'worlds.cua.freePlay.idleMinutes': { type: 'integer', title: '空闲多久提醒她可以玩', minimum: 1, maximum: 240, description: '主人离开这么多分钟后，她会收到一句「你可以申请自己玩」。' },
    },
  },
};

/** 把部署配置折成这个 World 的配置；没声明的字段一律不认。 */
export function normalizeCuaConfig(raw: unknown): CuaConfigSection {
  const c = structuredClone(CUA_DEFAULTS);
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    if (typeof r.enabled === 'boolean') c.enabled = r.enabled;
    if (typeof r.shot === 'number' && Number.isFinite(r.shot)) c.shot = Math.min(2048, Math.max(480, Math.round(r.shot)));
    if (typeof r.quality === 'number' && Number.isFinite(r.quality)) c.quality = Math.min(95, Math.max(30, Math.round(r.quality)));
    if (typeof r.idleMs === 'number' && Number.isFinite(r.idleMs)) c.idleMs = Math.min(10000, Math.max(0, Math.round(r.idleMs)));
    if (typeof r.allowInput === 'boolean') c.allowInput = r.allowInput;
    if (r.freePlay && typeof r.freePlay === 'object') {
      const f = r.freePlay as Record<string, unknown>;
      if (typeof f.enabled === 'boolean') c.freePlay.enabled = f.enabled;
      if (typeof f.minutesPerSession === 'number' && Number.isFinite(f.minutesPerSession)) c.freePlay.minutesPerSession = Math.min(120, Math.max(1, Math.round(f.minutesPerSession)));
      if (typeof f.maxSessionsPerDay === 'number' && Number.isFinite(f.maxSessionsPerDay)) c.freePlay.maxSessionsPerDay = Math.min(10, Math.max(1, Math.round(f.maxSessionsPerDay)));
      if (typeof f.askDangerous === 'boolean') c.freePlay.askDangerous = f.askDangerous;
      if (typeof f.idleMinutes === 'number' && Number.isFinite(f.idleMinutes)) c.freePlay.idleMinutes = Math.min(240, Math.max(1, Math.round(f.idleMinutes)));
    }
  }
  return c;
}
