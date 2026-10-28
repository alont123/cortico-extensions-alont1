/** Persona-owned limits for retained dialogue, source verification and repetition fallback. */
export interface ConversationPolicy {
  dialogueWindowMinutes: number;
  dialogueMaxMessages: number;
  dialogueReserveTokens: number;
  prioritizeSenderKeys: string;
  sourceRetentionHours: number;
  sourceMaxEvents: number;
  sourceMaxChars: number;
  answeredTopicWindowMinutes: number;
  repeatQuestionFallbackEnabled: boolean;
}

export const CONVERSATION_DEFAULTS: ConversationPolicy = {
  dialogueWindowMinutes: 120,
  dialogueMaxMessages: 30,
  dialogueReserveTokens: 2048,
  prioritizeSenderKeys: '',
  sourceRetentionHours: 168,
  sourceMaxEvents: 500,
  sourceMaxChars: 8192,
  answeredTopicWindowMinutes: 240,
  repeatQuestionFallbackEnabled: true,
};

export function conversationPolicy(input: Partial<ConversationPolicy> | undefined): ConversationPolicy {
  const result = { ...CONVERSATION_DEFAULTS };
  const ranges: Record<string, [number, number]> = {
    dialogueWindowMinutes: [1, 1440], dialogueMaxMessages: [1, 100],
    dialogueReserveTokens: [128, 8192], sourceRetentionHours: [1, 720],
    sourceMaxEvents: [30, 3000], sourceMaxChars: [256, 32000],
    answeredTopicWindowMinutes: [1, 1440],
  };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    const value = input?.[key as keyof ConversationPolicy];
    if (typeof value === 'number' && Number.isFinite(value)) {
      (result as unknown as Record<string, unknown>)[key] = Math.max(min, Math.min(max, Math.trunc(value)));
    }
  }
  if (typeof input?.prioritizeSenderKeys === 'string') result.prioritizeSenderKeys = input.prioritizeSenderKeys.trim().slice(0, 2048);
  if (typeof input?.repeatQuestionFallbackEnabled === 'boolean') result.repeatQuestionFallbackEnabled = input.repeatQuestionFallbackEnabled;
  return result;
}

export function prioritySenders(policy: ConversationPolicy): string[] {
  return [...new Set(policy.prioritizeSenderKeys.split(/[\s,，]+/).filter(Boolean))];
}

/** A bot may use an explicitly configured QQ owner without requiring that World to be installed. */
export function withConfiguredOwner(policy: ConversationPolicy, worlds: unknown): ConversationPolicy {
  if (prioritySenders(policy).length || !worlds || typeof worlds !== 'object') return policy;
  const sections = worlds as Record<string, { ownerQQ?: unknown } | undefined>;
  const owner = sections.qqbot?.ownerQQ ?? sections.qq?.ownerQQ;
  if (typeof owner !== 'number' || !Number.isSafeInteger(owner) || owner <= 0) return policy;
  return { ...policy, prioritizeSenderKeys: 'private:' + owner };
}
