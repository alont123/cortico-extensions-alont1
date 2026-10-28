import type { ToolDef } from 'cortico/core/types.ts';

export const CUA_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    "name": "cua_screenshot",
    "tags": [
      "read"
    ],
    "description": "截取主屏幕：返回缩放后的图片（画着光标位置）。所有工具的坐标都用这张截图的像素。",
    "parameters": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "cua_move",
    "tags": [
      "write"
    ],
    "description": "把鼠标移到 (x, y)，不点击；用于悬停出提示或菜单。坐标用最近一张截图。",
    "parameters": {
      "type": "object",
      "properties": {
        "x": {
          "type": "number"
        },
        "y": {
          "type": "number"
        }
      },
      "required": [
        "x",
        "y"
      ]
    }
  },
  {
    "name": "cua_click",
    "tags": [
      "write"
    ],
    "description": "把鼠标移到 (x, y) 并点击。clicks：1 单击（默认）、2 双击、3 三击。button：left/right/middle。",
    "parameters": {
      "type": "object",
      "properties": {
        "x": {
          "type": "number"
        },
        "y": {
          "type": "number"
        },
        "button": {
          "type": "string",
          "enum": [
            "left",
            "right",
            "middle"
          ]
        },
        "clicks": {
          "type": "integer"
        }
      },
      "required": [
        "x",
        "y"
      ]
    }
  },
  {
    "name": "cua_drag",
    "tags": [
      "write"
    ],
    "description": "按住左键从 (fromX, fromY) 拖到 (toX, toY) 再松开。",
    "parameters": {
      "type": "object",
      "properties": {
        "fromX": {
          "type": "number"
        },
        "fromY": {
          "type": "number"
        },
        "toX": {
          "type": "number"
        },
        "toY": {
          "type": "number"
        }
      },
      "required": [
        "fromX",
        "fromY",
        "toX",
        "toY"
      ]
    }
  },
  {
    "name": "cua_scroll",
    "tags": [
      "write"
    ],
    "description": "把鼠标移到 (x, y) 滚动滚轮。delta 为正向下、为负向上（单位=一\"格\"）。",
    "parameters": {
      "type": "object",
      "properties": {
        "x": {
          "type": "number"
        },
        "y": {
          "type": "number"
        },
        "delta": {
          "type": "integer"
        }
      },
      "required": [
        "x",
        "y",
        "delta"
      ]
    }
  },
  {
    "name": "cua_type",
    "tags": [
      "write"
    ],
    "description": "在当前输入焦点处打字（任何语言，与输入法状态无关）。打之前先点中输入框。",
    "parameters": {
      "type": "object",
      "properties": {
        "text": {
          "type": "string"
        }
      },
      "required": [
        "text"
      ]
    }
  },
  {
    "name": "cua_key",
    "tags": [
      "write"
    ],
    "description": "按键或组合键。组合用 + 连：ctrl+s、alt+tab、shift+enter；多个键用逗号分先后：ctrl+a, delete。",
    "parameters": {
      "type": "object",
      "properties": {
        "keys": {
          "type": "string",
          "description": "如 ctrl+s 或 ctrl+a, delete"
        }
      },
      "required": [
        "keys"
      ]
    }
  },
  {
    "name": "cua_windows",
    "tags": [
      "read"
    ],
    "description": "列出可见的顶层窗口：标题、位置（物理像素）、是否最小化、是否前台。",
    "parameters": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "cua_focus",
    "tags": [
      "write"
    ],
    "description": "把一个窗口切到前台（最小化的先还原）。title 用标题里的连续几个字，不必写全。",
    "parameters": {
      "type": "object",
      "properties": {
        "title": {
          "type": "string"
        }
      },
      "required": [
        "title"
      ]
    }
  },
  {
    "name": "cua_wait",
    "tags": [
      "read"
    ],
    "description": "等待若干秒（最多 30）让界面加载，然后附一张截图。等待本身不消耗别的东西。",
    "parameters": {
      "type": "object",
      "properties": {
        "seconds": {
          "type": "number"
        }
      },
      "required": [
        "seconds"
      ]
    }
  },
  {
    "name": "cua_free_play",
    "tags": [
      "write"
    ],
    "description": "申请一段自己玩电脑的时间。这一步只是记一笔；主人在聊天里（QQ/控制台都算）说「行/好/允许」之后，你自己调 cua_free_allow 开时间，不需要他点任何按钮。",
    "parameters": {
      "type": "object",
      "properties": {
        "minutes": {
          "type": "integer",
          "description": "想玩几分钟；不填用配置值。"
        }
      }
    }
  },
  {
    "name": "cua_free_allow",
    "tags": [
      "write"
    ],
    "description": "主人已经同意（聊天里说「行/好/允许」都算）：调它给自己开一段自由时间。minutes 可不填，用配置值。",
    "parameters": {
      "type": "object",
      "properties": {
        "minutes": {
          "type": "integer"
        }
      }
    }
  },
  {
    "name": "cua_free_deny",
    "tags": [
      "write"
    ],
    "description": "主人没同意：记一下，回去做自己的事。",
    "parameters": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "cua_free_status",
    "tags": [
      "read"
    ],
    "description": "看自己玩的状态：还剩多久、今天批过几次。",
    "parameters": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "cua_danger_allow",
    "tags": [
      "write"
    ],
    "description": "主人已经同意那条危险动作：用挂起时给的编号执行。",
    "parameters": {
      "type": "object",
      "properties": {
        "id": {
          "type": "integer"
        }
      },
      "required": [
        "id"
      ]
    }
  },
  {
    "name": "cua_danger_deny",
    "tags": [
      "write"
    ],
    "description": "主人不同意那条危险动作：用编号取消它。",
    "parameters": {
      "type": "object",
      "properties": {
        "id": {
          "type": "integer"
        }
      },
      "required": [
        "id"
      ]
    }
  }
];
