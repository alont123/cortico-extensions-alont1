/** 画图（MOSS-Image via ComfyUI）的配置。 */
export interface DrawConfigSection {
  enabled: boolean;
  /** ComfyUI 的 HTTP 地址。 */
  httpUrl: string;
  /** 扩散模型文件名（ComfyUI/models/diffusion_models 下）。 */
  modelUnet: string;
  /** 文本编码器文件名（ComfyUI/models/text_encoders 下）。 */
  modelClip: string;
  /** VAE 文件名（ComfyUI/models/vae 下）。 */
  modelVae: string;
  /** 默认风格：anime（二次元日漫）/ chibi / real / watercolor / ink。 */
  style: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  shift: number;
  /** 文本编码器放哪：cpu 省显存（推荐 8G 卡）。 */
  textDevice: 'default' | 'cpu';
  /** 一次生成最多等多少秒。 */
  timeoutSec: number;
}

export const DRAW_DEFAULTS: DrawConfigSection = {
  enabled: false,
  httpUrl: 'http://127.0.0.1:8188',
  modelUnet: 'moss_image_sft_int8_convrot.safetensors',
  modelClip: 'qwen3.5_9b_w4a8_gptq.safetensors',
  modelVae: 'flux2-vae_small.safetensors',
  style: 'anime',
  width: 1024,
  height: 1024,
  steps: 30,
  cfg: 3,
  shift: 5,
  textDevice: 'cpu',
  timeoutSec: 600,
};

export const STYLE_PRESETS: Record<string, { label: string; positive: string; negative?: string }> = {
  anime: {
    label: '二次元日漫',
    positive: 'anime style, japanese anime illustration, cel shading, clean line art, vibrant colors, detailed eyes, best quality, highres',
  },
  chibi: {
    label: 'Q版',
    positive: 'chibi, cute, super deformed, anime style, cel shading, soft colors, best quality',
  },
  real: {
    label: '写实',
    positive: 'photorealistic, cinematic lighting, detailed skin texture, sharp focus, best quality, highres',
  },
  watercolor: {
    label: '水彩',
    positive: 'watercolor painting, soft edges, paper texture, delicate colors, illustration',
  },
  ink: {
    label: '水墨',
    positive: 'chinese ink painting, xieyi, ink wash, rice paper texture, minimal colors, elegant',
  },
};

export function normalizeDrawConfig(raw: unknown): DrawConfigSection {
  const c = { ...DRAW_DEFAULTS };
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    if (typeof r.enabled === 'boolean') c.enabled = r.enabled;
    if (typeof r.httpUrl === 'string' && r.httpUrl.trim()) c.httpUrl = r.httpUrl.trim();
    if (typeof r.modelUnet === 'string' && r.modelUnet.trim()) c.modelUnet = r.modelUnet.trim();
    if (typeof r.modelClip === 'string' && r.modelClip.trim()) c.modelClip = r.modelClip.trim();
    if (typeof r.modelVae === 'string' && r.modelVae.trim()) c.modelVae = r.modelVae.trim();
    if (typeof r.style === 'string' && STYLE_PRESETS[r.style]) c.style = r.style;
    if (typeof r.width === 'number' && Number.isFinite(r.width)) c.width = Math.min(2048, Math.max(256, Math.round(r.width / 16) * 16));
    if (typeof r.height === 'number' && Number.isFinite(r.height)) c.height = Math.min(2048, Math.max(256, Math.round(r.height / 16) * 16));
    if (typeof r.steps === 'number' && Number.isFinite(r.steps)) c.steps = Math.min(100, Math.max(10, Math.round(r.steps)));
    if (typeof r.cfg === 'number' && Number.isFinite(r.cfg)) c.cfg = Math.min(10, Math.max(1, r.cfg));
    if (typeof r.shift === 'number' && Number.isFinite(r.shift)) c.shift = Math.min(12, Math.max(1, r.shift));
    if (r.textDevice === 'default' || r.textDevice === 'cpu') c.textDevice = r.textDevice;
    if (typeof r.timeoutSec === 'number' && Number.isFinite(r.timeoutSec)) c.timeoutSec = Math.min(1800, Math.max(60, Math.round(r.timeoutSec)));
  }
  return c;
}
