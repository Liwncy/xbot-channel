// OpenClaw 在 agent 出错时会把系统提示当作普通回复投递过来，
// 这类文案对微信用户没意义，直接吞掉并写日志。
const ERROR_NOTICE_PATTERNS: RegExp[] = [
  /^\W*openclaw couldn'?t finish this request/i,
  /^\W*tool call failed/i,
  /^\W*the request took too long/i,
  /^\W*agent run failed/i,
  /openclaw logs --follow/i,
];

export function isAgentErrorNotice(text: unknown): boolean {
  const normalized = (typeof text === 'string' ? text : String(text ?? '')).trim();
  if (!normalized) return false;
  return ERROR_NOTICE_PATTERNS.some((pattern) => pattern.test(normalized));
}
