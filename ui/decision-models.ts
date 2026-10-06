/** Explicit application support list, NOT a model-availability guarantee.
 * Add models only after verifying their native System One contract. The public
 * chat catalog and model-name substrings are not capability checks.
 */
export const NATIVE_DECISION_MODELS = ['inception/mercury-decide:free'] as const;
export const NATIVE_DECISIONS = Object.freeze({
  base: 'https://openrouter.ai/api/alpha',
  path: '/decisions',
  protocol: 'systemone' as const,
});
export function isNativeDecisionModel(model: string): boolean {
  return NATIVE_DECISION_MODELS.some(id => id === model.trim());
}
export function assertNativeDecisionModel(model: string): void {
  if (!isNativeDecisionModel(model)) {
    throw new Error('此決策模型不在本程式支援的 native Decisions 清單；請重新選擇決策模型。瀏覽器模式不會自動改用 chat endpoint。');
  }
}
