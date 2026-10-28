/**
 * 截图的缩放、画光标、编码。纯函数，不碰系统调用。
 *
 * 模型看的是缩小图；它给出的坐标也是这张缩小图的像素。
 * 换算回物理像素由调用方按 ShotResult.scale 做。
 */

/**
 * 把 BGRA 的整屏像素缩到最长边 maxEdge，返回 **RGBA**。
 *
 * 注意必须是 4 通道：jpeg-js 的 encode 按 RGBA 读数据，给 3 通道 RGB 会被错位解释，
 * 截图就是一片噪点（这个坑踩过——她一开始看到的花屏有一部分就是它）。
 * 按面积平均（不是最近邻），小字缩下去还能认。
 */
export function downscale(bgra: Buffer, width: number, height: number, maxEdge: number): { rgb: Buffer; width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  if (w === width && h === height) return { rgb: bgraToRgb(bgra, width, height), width, height };
  const out = Buffer.alloc(w * h * 4);
  // 每个目标像素覆盖的源区域
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * height) / h), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * width) / w), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / w));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        let si = (sy * width + x0) * 4;
        for (let sx = x0; sx < x1; sx++, si += 4) { b += bgra[si]; g += bgra[si + 1]; r += bgra[si + 2]; n++; }
      }
      const di = (y * w + x) * 4;
      out[di] = Math.round(r / n); out[di + 1] = Math.round(g / n); out[di + 2] = Math.round(b / n); out[di + 3] = 255;
    }
  }
  return { rgb: out, width: w, height: h };
}

function bgraToRgb(bgra: Buffer, width: number, height: number): Buffer {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < width * height * 4; i += 4, j += 4) {
    rgba[j] = bgra[i + 2]; rgba[j + 1] = bgra[i + 1]; rgba[j + 2] = bgra[i]; rgba[j + 3] = 255;
  }
  return rgba;
}

/** 在 RGBA 图的 (x,y) 上画一个高对比的小十字+圈，告诉模型光标在哪。 */
export function drawCursor(rgb: Buffer, width: number, height: number, x: number, y: number): void {
  const put = (px: number, py: number, c: [number, number, number]) => {
    if (px < 0 || py < 0 || px >= width || py >= height) return;
    const i = (py * width + px) * 4;
    rgb[i] = c[0]; rgb[i + 1] = c[1]; rgb[i + 2] = c[2]; rgb[i + 3] = 255;
  };
  const outer: [number, number, number] = [0, 0, 0];
  const inner: [number, number, number] = [255, 255, 255];
  const r = 9;
  // 黑边白芯，深色浅色背景上都能看见
  for (let d = -r; d <= r; d++) {
    if (Math.abs(d) <= 1) continue;
    put(x + d, y, outer); put(x, y + d, outer);
    put(x + d + 1, y, outer); put(x, y + d + 1, outer);
  }
  for (let d = -r + 2; d <= r - 2; d++) {
    if (Math.abs(d) <= 1) continue;
    put(x + d, y, inner); put(x, y + d, inner);
  }
  // 中心方块
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) put(x + dx, y + dy, [255, 0, 0]);
}
