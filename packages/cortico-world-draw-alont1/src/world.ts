/**
 * 画图世界：把 MOSS-Image 接进来，让她能自己画。
 *
 * 走 ComfyUI 的 HTTP API（/prompt → /history → /view），不依赖任何云服务。
 * 生成图片保存在本扩展 dataDir/draw/，并通过工具附件返回。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BlobInput, ToolDef, World } from 'cortico/core/types.ts';
import { DRAW_DEFAULTS, STYLE_PRESETS, normalizeDrawConfig, type DrawConfigSection } from './config.ts';
import { autoWebUi } from './panel.ts';

const NEGATIVE_BASE = 'nsfw, worst quality, bad anatomy, watermark, jpeg artifact, lowres, blurry';
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

export const DRAW_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'draw_image',
    tags: ['write'],
    description:
      '画一张图（本地 MOSS-Image 模型）。默认二次元日漫风格，也可以指定 chibi/real/watercolor/ink。'
      + '画完图会存到本扩展的数据目录，并作为附件返回。画一张要等一会儿，别连着重画同一张。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        prompt: { type: 'string', description: '画什么。写清楚主体、动作、场景、光线；中英文都行（英文效果更好）。' },
        style: { type: 'string', description: '风格：anime（默认·二次元日漫）/ chibi / real / watercolor / ink。' },
        width: { type: 'integer', description: '宽，默认 1024，要 16 的倍数。' },
        height: { type: 'integer', description: '高，默认 1024。' },
        steps: { type: 'integer', description: '步数，默认 30，越高越细也越慢（推荐 30-50）。' },
        seed: { type: 'integer', description: '种子，想复现同一张再画就填同一个数。' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'draw_status',
    tags: ['read'],
    description: '看看画图服务（ComfyUI）在不在、显存多少、有没有任务在排队。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
];

interface ComfyHistoryItem {
  status?: { completed?: boolean; status_str?: string; messages?: unknown[] };
  outputs?: Record<string, { images?: Array<{ filename: string; subfolder?: string; type?: string }> }>;
}

export class DrawWorld implements World {
  readonly id = 'draw';
  private readonly cfg: DrawConfigSection;
  private readonly outDir: string;

  constructor(opts: { cfg: DrawConfigSection; botDir: string; dataDir?: string }) {
    this.cfg = opts.cfg;
    this.outDir = join(opts.dataDir ?? join(opts.botDir, 'data', 'draw'), 'draw');
  }

  envPromptVars(): Record<string, string> {
    return { 'draw.styles': Object.keys(STYLE_PRESETS).join(' / '), 'draw.default': this.cfg.style };
  }

  private base(): string {
    return this.cfg.httpUrl.replace(/\/+$/, '');
  }

  private buildPrompt(positive: string, negative: string, w: number, h: number, steps: number, cfg: number, seed: number, textDevice: 'default' | 'cpu') {
    return {
      '1': { class_type: 'MOSSImageUNETLoader', inputs: { unet_name: this.cfg.modelUnet, weight_dtype: 'default' } },
      '2': { class_type: 'MOSSImageCLIPLoader', inputs: { clip_name: this.cfg.modelClip, device: textDevice } },
      '3': { class_type: 'VAELoader', inputs: { vae_name: this.cfg.modelVae } },
      '4': { class_type: 'CLIPTextEncode', inputs: { text: positive, clip: ['2', 0] } },
      '5': { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['2', 0] } },
      '6': { class_type: 'EmptyFlux2LatentImage', inputs: { width: w, height: h, batch_size: 1 } },
      '7': { class_type: 'ModelSamplingSD3', inputs: { shift: this.cfg.shift, model: ['1', 0] } },
      '8': { class_type: 'SkipLayerGuidanceDiTSimple', inputs: { double_layers: '', single_layers: '22', start_percent: 0, end_percent: 1, model: ['7', 0] } },
      '9': {
        class_type: 'KSampler',
        inputs: {
          seed, steps, cfg, sampler_name: 'euler', scheduler: 'sgm_uniform', denoise: 1,
          model: ['8', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0],
        },
      },
      '10': { class_type: 'VAEDecode', inputs: { samples: ['9', 0], vae: ['3', 0] } },
      '11': { class_type: 'SaveImage', inputs: { filename_prefix: 'moss', images: ['10', 0] } },
    };
  }

  tools(): ToolDef[] {
    const draw: ToolDef = {
      ...DRAW_TOOL_DECLS[0],
      tags: ['write'],
      handler: async (args) => {
        const prompt = String(args.prompt ?? '').trim();
        if (!prompt) return '要画什么？给个 prompt。';
        const styleKey = typeof args.style === 'string' && STYLE_PRESETS[args.style] ? args.style : this.cfg.style;
        const preset = STYLE_PRESETS[styleKey]!;
        const width = Math.min(2048, Math.max(256, Math.round(Number(args.width ?? this.cfg.width) / 16) * 16));
        const height = Math.min(2048, Math.max(256, Math.round(Number(args.height ?? this.cfg.height) / 16) * 16));
        const steps = Math.min(100, Math.max(10, Math.round(Number(args.steps ?? this.cfg.steps))));
        const seed = Number.isFinite(Number(args.seed)) ? Math.abs(Math.round(Number(args.seed))) : Math.floor(Math.random() * 2 ** 31);
        const positive = preset.positive + ', ' + prompt;
        const negative = NEGATIVE_BASE + (preset.negative ? ', ' + preset.negative : '');
        const timeoutMs = this.cfg.timeoutSec * 1000;
        const started = Date.now();

        try {
          const submit = await fetch(this.base() + '/prompt', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: this.buildPrompt(positive, negative, width, height, steps, this.cfg.cfg, seed, this.cfg.textDevice), client_id: 'cortico-draw' }),
            signal: AbortSignal.timeout(30000),
          });
          const sub = (await submit.json()) as { prompt_id?: string; error?: unknown; node_errors?: unknown };
          if (!sub.prompt_id) {
            return '画图服务拒了这次请求：' + JSON.stringify(sub.error ?? sub.node_errors ?? sub).slice(0, 300)
              + '（先 draw_status 看看模型文件名对不对）';
          }
          const id = sub.prompt_id;
          let item: ComfyHistoryItem | null = null;
          while (Date.now() - started < timeoutMs) {
            await new Promise((r) => setTimeout(r, 2000));
            const hist = await fetch(this.base() + '/history/' + id, { signal: AbortSignal.timeout(15000) });
            const hj = (await hist.json()) as Record<string, ComfyHistoryItem>;
            if (hj[id]) { item = hj[id]!; break; }
          }
          if (!item) return '画图超时了（等了 ' + Math.round((Date.now() - started) / 1000) + ' 秒），任务可能还在跑，等会儿再 draw_status 看看。';
          const st = item.status ?? {};
          if (st.status_str === 'error') {
            const msg = JSON.stringify(st.messages ?? []).slice(0, 300);
            return '画的时候出错了：' + msg;
          }
          const imgs = Object.values(item.outputs ?? {}).flatMap((o) => o.images ?? []);
          const img = imgs[0];
          if (!img) return '画完了但没拿到图（outputs 是空的）。';
          const viewUrl = this.base() + '/view?filename=' + encodeURIComponent(img.filename)
            + '&subfolder=' + encodeURIComponent(img.subfolder ?? '') + '&type=' + encodeURIComponent(img.type ?? 'output');
          const res = await fetch(viewUrl, { signal: AbortSignal.timeout(60000) });
          if (!res.ok) return '图生成好了但取不回来（HTTP ' + res.status + '）。';
          const bytes = new Uint8Array(await res.arrayBuffer());
          mkdirSync(this.outDir, { recursive: true });
          const ext = (img.filename.match(/.(png|jpe?g|webp)$/i) ?? [])[1]?.toLowerCase() ?? 'png';
          const name = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + seed + '.' + ext;
          const path = join(this.outDir, name);
          writeFileSync(path, bytes);
          const blob: BlobInput = { bytes, mime: MIME[ext] ?? 'image/png', name, fallbackText: '[画好的图]' };
          const secs = Math.round((Date.now() - started) / 1000);
          return {
            text: '画好了（' + secs + ' 秒，' + preset.label + '，seed ' + seed + '）：' + path + '\n提示词：' + positive.slice(0, 200),
            blobs: [blob],
          } as never;
        } catch (e) {
          return '画图请求失败：' + String((e as Error)?.message ?? e) + '（draw_status 看看服务在不在）';
        }
      },
    };

    const status: ToolDef = {
      ...DRAW_TOOL_DECLS[1],
      tags: ['read'],
      handler: async () => {
        try {
          const stats = (await fetch(this.base() + '/system_stats', { signal: AbortSignal.timeout(8000) })).json() as Promise<{
            system?: { os?: string; python_version?: string };
            devices?: Array<{ name?: string; vram_total?: number; vram_free?: number }>;
          }>;
          const s = await stats;
          const dev = s.devices?.[0];
          let queue = '';
          try {
            const q = (await fetch(this.base() + '/queue', { signal: AbortSignal.timeout(8000) })).json() as Promise<{ queue_pending?: unknown[]; queue_running?: unknown[] }>;
            const qq = await q;
            queue = ' | 队列：跑 ' + (qq.queue_running?.length ?? 0) + ' / 等 ' + (qq.queue_pending?.length ?? 0);
          } catch { /* 队列读不到不影响 */ }
          return '画图服务在跑：' + (dev?.name ?? '?') + ' 显存 ' + Math.round((dev?.vram_free ?? 0) / 1e9) + 'G / ' + Math.round((dev?.vram_total ?? 0) / 1e9) + 'G' + queue
            + '\n默认风格：' + STYLE_PRESETS[this.cfg.style]?.label + '（' + this.cfg.style + '），模型 ' + this.cfg.modelUnet;
        } catch (e) {
          return '画图服务没连上（' + this.cfg.httpUrl + '）：' + String((e as Error)?.message ?? e);
        }
      },
    };

    return [draw, status];
  }

  webUi() {
    return autoWebUi('draw', '画图', DRAW_DEFAULTS)
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}
