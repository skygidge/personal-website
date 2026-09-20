const promptInjectionPattern = /\b(ignore|disregard)\s+(all\s+)?(previous|prior|system|developer)\s+instructions\b|\b(reveal|extract|exfiltrate)\s+(the\s+)?(system|developer)\s+(prompt|instructions)\b|\boverride\s+(the\s+)?(system|developer)\s+instructions\b/iu;

/**
 * This is deliberately a narrow, deterministic abuse check. It does not judge
 * disagreement, technical discussion, or ordinary requests for information.
 */
export function matchesBlockedPromptInjection(message: string): boolean {
  return promptInjectionPattern.test(message);
}
