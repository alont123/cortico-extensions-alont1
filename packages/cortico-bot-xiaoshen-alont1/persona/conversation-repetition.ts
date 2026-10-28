/**
 * 可关闭的重复问句 fallback：只识别少数完整短问句与同一私聊中明确的规范化回答。
 * 结果只提供已观察证据，不判断当前状态，也不覆盖泛化主题相似性。
 */
import type { EventEnvelope } from 'cortico/core/types.ts';
import { collectDialogueEvents } from './dialogue-recovery.ts';

export type RepeatedQuestionTopic = 'meal' | 'activity' | 'sleep';
export interface RepeatedQuestionEvidence {
  topic: RepeatedQuestionTopic;
  sourceCursor: number;
  sourceTs: string;
  quote: string;
  sourceIndex?: number;
}
export interface RepeatedQuestionOptions {
  text: string;
  conversation: string;
  events: readonly EventEnvelope[];
  now: Date;
  windowMinutes: number;
}

const QUESTIONS: ReadonlyArray<[RepeatedQuestionTopic, RegExp]> = [
  ['meal', /^(?:你)?(?:吃(?:过)?(?:饭)?了吗|吃(?:过)?(?:饭)?了没)(?:呀|呢)?[？?]?$/],
  ['activity', /^(?:你)?(?:在干嘛|在做什么)(?:呀|呢)?[？?]?$/],
  ['sleep', /^(?:你)?(?:睡了吗|睡了没)(?:呀|呢)?[？?]?$/],
];
const ANSWERS: Record<RepeatedQuestionTopic, RegExp> = {
  meal: /^(?:我)?(?:已经|刚刚|刚|早就|早)?(?:吃(?:过|完)(?:早饭|午饭|晚饭|早餐|午餐|晚餐|饭)?了?|吃(?:早饭|午饭|晚饭|早餐|午餐|晚餐|饭)?(?:了|啦))(?:呀|呢|啦)?[。！!]*$/,
  activity: /^(?:我)?(?:现在)?(?:在|正在)(?:开会|工作|上班|上课|写作业|学习|看书|做饭|吃饭|打游戏|看电影|看视频|画画|整理房间|休息|散步|运动|通勤)(?:呀|呢)?[。！!]*$/,
  sleep: /^(?:我)?(?:已经|刚刚|刚|早就)?(?:睡醒了?|起床了|醒了|睡过了|睡了)(?:呀|呢|啦)?[。！!]*$/,
};
const AMBIGUOUS = /[“”「」『』‘’"'：:\n\r？?]|(?:不是|还没|没有|没|不|未|可能|好像|大概|也许|明天|昨天|待会|等会|准备|打算|将要|如果|假如|说过|他说|她说)/;
const CONTRADICTION: Record<RepeatedQuestionTopic, RegExp> = {
  meal: /(?:没|不|未).*(?:吃|饭)|(?:吃|饭).*(?:没|不|未)/,
  activity: /(?:没|不|未).*(?:在|工作|上班|上课|学习|开会)/,
  sleep: /(?:没|不|未).*(?:睡|起床|醒)/,
};

export function repeatedQuestionEvidence(options: RepeatedQuestionOptions): RepeatedQuestionEvidence | null {
  const question = options.text.trim();
  if (question.length > 32 || !/^private:[1-9]\d*$/.test(options.conversation)) return null;
  const topic = QUESTIONS.find(([, pattern]) => pattern.test(question))?.[0];
  const now = options.now.getTime();
  if (!topic || !Number.isFinite(now) || !Number.isFinite(options.windowMinutes) || options.windowMinutes <= 0) return null;
  const from = now - options.windowMinutes * 60_000;
  const candidates = collectDialogueEvents(options.events).filter(entry => {
    const at = Date.parse(entry.ts);
    return entry.role === 'user' && entry.conversation === options.conversation &&
      entry.textBasis === 'normalized-message' && !entry.truncated && at >= from && at <= now;
  }).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts) || b.cursor - a.cursor);
  for (const entry of candidates) {
    const answer = entry.text.trim();
    if (CONTRADICTION[topic].test(answer)) return null;
    if (answer.length > 80 || AMBIGUOUS.test(answer) || !ANSWERS[topic].test(answer)) continue;
    return {
      topic, sourceCursor: entry.cursor, sourceTs: entry.ts, quote: entry.text,
      ...(entry.sourceIndex === undefined ? {} : { sourceIndex: entry.sourceIndex }),
    };
  }
  return null;
}
