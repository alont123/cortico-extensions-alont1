/** 种子梗库：本地命中的直接返回；没命中的再联网搜。 */
export interface MemeFollowup { text: string; real: boolean; note: string }
export interface SeedMeme {
  id: string;
  aliases: string[];
  abbr?: string;
  full: string;
  meaning: string;
  origin: string;
  followups: MemeFollowup[];
  tone: string;
  source: string;
}

export const SEED_MEMES: readonly SeedMeme[] = [
  {
    "id": "kskbl",
    "aliases": [
      "kskbl",
      "KSKBL",
      "康神开播了"
    ],
    "full": "康神开播了",
    "abbr": "KSKBL",
    "meaning": "《无畏契约》电竞圈梗：弹幕刷「康神开播了」（康神指选手ZmjjKK/康康），是提醒/调侃他去开播的接头暗号；也指表哥查房那次经典直播切片。",
    "origin": "2025 年底到 2026 年初，主播表哥直播时被弹幕撺掇「康神开播了? 真的假的」，点进康康直播间正撞见康康撒娇说「没胖，我真比以前瘦了」，表哥绷不住笑。粉丝把「康神开播了」缩成 kskbl。",
    "followups": [
      {
        "text": "zdjd（真的假的）",
        "real": true,
        "note": "表哥当时的原话就是「康神开播了? 真的假的」，这是最经典的接法。"
      },
      {
        "text": "wkzkbl（我靠真开播了）",
        "real": true,
        "note": "衍生缩写，表示「我靠真开播了」。"
      }
    ],
    "tone": "调侃、玩梗，不是骂人；康粉康黑乐子人都在用。",
    "source": "https://m.ali213.net/news/gl2603/1755357.html"
  },
  {
    "id": "zdjd",
    "aliases": [
      "zdjd",
      "ZDJD",
      "真的假的"
    ],
    "full": "真的假的",
    "meaning": "「真的假的」的拼音首字母缩写。接 KSKBL 用来表示半信半疑/配合演出。",
    "origin": "KSKBL 名场面里表哥那句「康神开播了? 真的假的」，后来单独作为万能反应梗。",
    "followups": [],
    "tone": "半信半疑、配合玩梗。",
    "source": "https://www.dancihu.com/liuxingyu/k17511.html"
  },
  {
    "id": "wkzkbl",
    "aliases": [
      "wkzkbl",
      "WKZKBL"
    ],
    "full": "我靠真开播了",
    "meaning": "「我靠真开播了」的拼音首字母缩写，KSKBL 的衍生接茬。",
    "origin": "KSKBL 玩梗体系衍生。",
    "followups": [],
    "tone": "惊讶、起哄。",
    "source": "https://m.ali213.net/news/gl2603/1755357.html"
  },
  {
    "id": "wanla",
    "aliases": [
      "丸辣",
      "丸辣！"
    ],
    "full": "完了",
    "meaning": "「完了」的谐音，带哭腔/摆烂感，表示事情搞砸了或者要完蛋了。",
    "origin": "网络谐音梗，B站、贴吧、短视频评论区常见。",
    "followups": [],
    "tone": "自嘲、哀嚎，带点表演性。",
    "source": "网络通行梗，出处众说不一"
  },
  {
    "id": "city-bu-city",
    "aliases": [
      "city不city",
      "city不city啊",
      "city 不 city"
    ],
    "full": "City不City啊",
    "meaning": "2024 年热梗，问「洋不洋气/够不够都市」。原句来自外国博主保保熊，用来形容穿搭、地点、状态够不够 city。",
    "origin": "2024 年外国博主保保熊在短视频里的口头禅「city不city啊」。",
    "followups": [],
    "tone": "轻松、调侃、带点洋泾浜腔。",
    "source": "2024 年度热词"
  },
  {
    "id": "na-za-le",
    "aliases": [
      "那咋了",
      "那咋了？"
    ],
    "full": "那咋了",
    "meaning": "2024-2025 年流行的回应方式：主打一个理直气壮/摆烂，用「那咋了」怼掉一切指责。",
    "origin": "网络短视频/评论区流行语。",
    "followups": [],
    "tone": "理直气壮、摆烂、欠揍式自信。",
    "source": "网络通行梗，出处众说不一"
  },
  {
    "id": "bao-de",
    "aliases": [
      "包的",
      "包的！"
    ],
    "full": "包的",
    "meaning": "「包赢的/必须的」的缩写，表示肯定、稳了。",
    "origin": "游戏圈/直播圈口头禅。",
    "followups": [],
    "tone": "自信、爽快。",
    "source": "网络通行梗，出处众说不一"
  },
  {
    "id": "wo-ba-mvp",
    "aliases": [
      "我老爸得了MVP",
      "我老爸得了mvp",
      "老爸得了MVP"
    ],
    "full": "我老爸得了MVP",
    "meaning": "2025 年热梗，常被用来当作「我要溜了/我得走了」的离谱借口；也用来调侃在游戏里突然离线的人。",
    "origin": "出自游戏/直播场景的抽象借口式发言。",
    "followups": [],
    "tone": "一本正经地胡说八道。",
    "source": "2025 热梗榜（具体出处以搜索为准）"
  }
] as const;
