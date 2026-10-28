import type { ToolDef } from 'cortico/core/types.ts';

/** Metadata shared by live handlers and market self-description. */
export const QQ_ADDITIONAL_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    "name": "qqbot_sticker_save",
    "tags": [
      "write"
    ],
    "barrierAfter": true,
    "description": "收藏一张表情包：给图片 URL（http/https）或本机文件路径，下载/复制进表情包目录并登记索引。返回里会有真实文件名；之后把 [表情包:文件名] 写进回复文本就能把它发出去。",
    "parameters": {
      "type": "object",
      "properties": {
        "url": {
          "type": "string",
          "description": "图片 URL（http/https）。"
        },
        "path": {
          "type": "string",
          "description": "本机图片文件路径。"
        },
        "summary": {
          "type": "string",
          "description": "可选：这张表情包叫什么/什么情绪（会显示在列表里）。"
        }
      },
      "required": []
    }
  },
  {
    "name": "qqbot_poke",
    "tags": [
      "speak"
    ],
    "barrierAfter": false,
    "description": "戳一戳某个人（群戳一戳或私聊戳一戳）。target 为会话地址 group:<群号> 或 private:<QQ号>（原样复制事件 meta 里的 conv 字段）；user 为要戳的人的 QQ 号或群内昵称（私聊戳一戳时留空表示戳对话对象）。这是一个动作，不是文字消息。",
    "parameters": {
      "type": "object",
      "properties": {
        "target": {
          "type": "string",
          "description": "会话地址，原样复制事件 meta 里的 conv 字段。"
        },
        "user": {
          "type": "string",
          "description": "要戳的人的 QQ 号或群内昵称；私聊戳一戳时留空表示戳对话对象。"
        }
      },
      "required": [
        "target"
      ]
    }
  },
  {
    "name": "qqbot_note_save",
    "tags": [
      "write"
    ],
    "description": "把显式提供的 text 保存到本扩展本地笔记本；文本可由 qqbot_note_get 查看，不调用其他扩展或 Persona 的 Memory 工具。",
    "parameters": {
      "type": "object",
      "properties": {
        "text": {
          "type": "string",
          "description": "要记的内容"
        }
      },
      "required": [
        "text"
      ]
    }
  },
  {
    "name": "qqbot_note_list",
    "tags": [
      "read"
    ],
    "description": "列出私人笔记本里的全部条目（本地 notebook.jsonl）。用于回看你记过什么。",
    "parameters": {
      "type": "object",
      "properties": {},
      "required": []
    }
  },
  {
    "name": "qqbot_note_get",
    "tags": [
      "read"
    ],
    "description": "按 id 查看某条笔记本内容。id 来自 qqbot_note_list 的条目 id。",
    "parameters": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "description": "条目 id"
        }
      },
      "required": [
        "id"
      ]
    }
  },
  {
    "name": "qqbot_note_forget",
    "tags": [
      "write"
    ],
    "description": "删除一条笔记本（你确定不再需要它时）。id 来自 qqbot_note_list 的条目 id。",
    "parameters": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "description": "条目 id"
        }
      },
      "required": [
        "id"
      ]
    }
  }
];
