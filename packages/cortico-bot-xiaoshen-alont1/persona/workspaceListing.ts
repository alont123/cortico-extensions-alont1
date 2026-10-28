/**
 * 前缀里的工作区清单怎么排。
 *
 * 清单是给人看的，不是给机器看的：常驻前缀里每多一行，每个请求都多一次。
 * 所以小的、天天要看的一档一档列名字（`notes/`、`people/`），大的、按天流水
 * 的一族折成一行摘要（`memories/`、`handoffs/`、`blobs/`）——摘要里仍报件数
 * 和日期跨度，需要正文时 `list_files` 指定那个目录会列全。
 *
 * 逻辑抽在这里是为了能单测：`Cormini` 只是把 `memory.walkFiles()` 喂进来。
 */

/** 一族折叠：`match` 命中的文件不进清单，改由 `summary` 出一行。 */
export interface ListingFold {
  /** 判定某个路径属不属于这一族。 */
  match(path: string): boolean;
  /** 这一族的成员（调用方已保证非空），出一行替换掉逐行。 */
  summary(members: readonly string[]): string;
}

/** 光报件数的折叠，用于没有日期可摘、又长到不该逐个列名的家族。 */
export function countFold(prefix: string, hint: string): ListingFold {
  const dir = prefix.replace(/\/$/, '');
  return {
    match: (path) => path.startsWith(prefix),
    summary: (members) => `${prefix} (${members.length} 份;${hint} list_files 指定 dir 为 ${dir} 可列出全部)`,
  };
}

/**
 * 小的、她特意写下来备查的家族：仍逐个列名，但收在一行里。
 *
 * 名字本身就是信息——藏掉名字等于藏了她的工具箱，她会不知道自己写过什么。
 * 所以这一族不折成"几份"，折成"一份清单"；长到超过预算时退回件数，
 * 那时名字已经开始佔地方，值不值由 `maxNames` 决定。
 */
export function listFold(prefix: string, maxNames: number, hint = ''): ListingFold {
  const dir = prefix.replace(/\/$/, '');
  const inner = (path: string): string => path.slice(prefix.length);
  return {
    match: (path) => path.startsWith(prefix),
    summary: (members) => {
      if (members.length > maxNames) {
        return `${prefix} (${members.length} 份;${hint} list_files 指定 dir 为 ${dir} 可列出全部)`;
      }
      const names = members.map(inner).sort();
      const tail = hint ? `;${hint}` : '';
      return `${prefix} ${names.join('、')}${tail}`;
    },
  };
}

const DATE_IN_NAME = /(\d{4})-(\d{2})-(\d{2})/;

/**
 * 报件数与日期跨度的折叠：名字里带 `YYYY-MM-DD` 的家族（流水、日结）用它，
 * 读的人一眼知道最早到最近各是哪天，不读正文也知道这段有没有断。
 * 名字里没有日期的成员照算件数，只是不进跨度。
 */
export function dateRangeFold(prefix: string, hint: string): ListingFold {
  const dir = prefix.replace(/\/$/, '');
  return {
    match: (path) => path.startsWith(prefix),
    summary: (members) => {
      const dates = members
        .map((m) => DATE_IN_NAME.exec(m.slice(prefix.length))?.[0])
        .filter((d): d is string => d !== undefined)
        .sort();
      const span = dates.length === 0 ? ''
        : dates[0] === dates[dates.length - 1] ? `,${dates[0]}` : `,${dates[0]} 至 ${dates[dates.length - 1]}`;
      return `${prefix} (${members.length} 份${span};${hint} list_files 指定 dir 为 ${dir} 可列出全部)`;
    },
  };
}

/**
 * 拼清单。`folds` 里先命中的先算——同一族里更细的口子要写在更粗的前面
 * （`notes/playbook/` 在 `notes/` 前面）,否则细的那条永远轮不到。
 * 没有被任何一族认领的文件按原顺序逐行列名字。
 */
export function renderWorkspaceListing(files: readonly string[], folds: readonly ListingFold[]): string {
  if (files.length === 0) return 'Your workspace is empty.';
  const claimed = new Set<string>();
  const lines: string[] = [];
  for (const fold of folds) {
    const members = files.filter((f) => !claimed.has(f) && fold.match(f));
    if (members.length === 0) continue;
    for (const m of members) claimed.add(m);
    lines.push(fold.summary(members));
  }
  const loose = files.filter((f) => !claimed.has(f));
  if (loose.length > 0) {
    // 折叠行排在逐行列出的前面，读的人先看到"哪里还有东西"。
    return `Files in your workspace:\n${[...lines.map((l) => `- ${l}`), ...loose.map((f) => `- ${f}`)].join('\n')}`;
  }
  return `Files in your workspace:\n${lines.map((l) => `- ${l}`).join('\n')}`;
}
