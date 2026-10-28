/**
 * 语音合成客户端。合成在外部服务里完成（模型常驻，避免每次合成重载权重），
 * 这里只把文本换成一串 WAV 字节。
 *
 * 服务只需要实现一个端点：
 *   POST <serviceUrl>/tts  {"text": "...", "voice": "...", "format": "wav"}  ->  audio/wav
 * 未配置地址时 disabled，调用方退回发文字。
 */
import type { QQWorldConfig } from './config.ts';

export class VoiceClient {
  readonly enabled: boolean;
  readonly maxChars: number;
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly voice: string;

  constructor(config: QQWorldConfig['voice']) {
    this.url = (config.serviceUrl ?? '').trim().replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs;
    this.maxChars = config.maxChars;
    this.voice = (config.voice ?? '').trim();
    this.enabled = this.url !== '';
  }

  /** 合成一段语音。失败抛错，由调用方决定退回文字。 */
  async synthesize(text: string): Promise<Uint8Array> {
    if (!this.enabled) throw new Error('语音服务未配置');
    const body: Record<string, unknown> = { text, format: 'wav' };
    if (this.voice) body.voice = this.voice;
    const res = await fetch(`${this.url}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`语音服务返回 ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength === 0) throw new Error('语音服务返回空音频');
    return buf;
  }
}
