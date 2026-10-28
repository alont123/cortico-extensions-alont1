import type { PanelGuide } from './panel-runtime.ts'
export const PANEL_GUIDE: PanelGuide = {
  "title": "画图",
  "purpose": "通过 ComfyUI 的已安装模型生成图片。",
  "setup": "先启动 ComfyUI，填写服务地址和已有模型文件名，再启用扩展。",
  "firstUse": "先让助手调用 draw_status 检查服务与模型，再用 draw_image 描述一张简单图片。",
  "troubleshoot": "连接失败查地址；缺模型查文件名；显存不足先缩小图片或调整文本编码器设备。",
  "fields": {
    "style": {
      "enum": [
        "anime",
        "chibi",
        "real",
        "watercolor",
        "ink"
      ],
      "title": "默认画风"
    },
    "textDevice": {
      "enum": [
        "default",
        "cpu"
      ],
      "title": "文本编码器设备"
    },
    "width": {
      "type": "integer",
      "minimum": 256,
      "maximum": 2048,
      "multipleOf": 16,
      "title": "图片宽度"
    },
    "height": {
      "type": "integer",
      "minimum": 256,
      "maximum": 2048,
      "multipleOf": 16,
      "title": "图片高度"
    },
    "steps": {
      "type": "integer",
      "minimum": 10,
      "maximum": 100,
      "title": "采样步数"
    },
    "cfg": {
      "minimum": 1,
      "maximum": 10,
      "title": "提示词强度",
      "multipleOf": 0.1
    },
    "shift": {
      "minimum": 1,
      "maximum": 12,
      "title": "偏移",
      "multipleOf": 0.1
    },
    "timeoutSec": {
      "type": "integer",
      "minimum": 60,
      "maximum": 1800,
      "title": "生成超时（秒）"
    }
  }
}
