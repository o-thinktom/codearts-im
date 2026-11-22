const PRESERVE = /^(set|empty|unknown|true|false|null|undefined)$/i;

export interface RedactionResult {
  text: string;
  /** 被替换的敏感字段数量 */
  redactions: number;
}

const KEY_VALUE_JSON =
  /("(?:appSecret|secret|token|accessToken|botToken|password|credential)"\s*:\s*")([^"]*)(")/gi;
const KEY_VALUE_INLINE = /\b(appSecret|secret|token|accessToken|botToken|password|credential)=([^\s,";}]+)/gi;

/**
 * 诊断包写出前的最后一道脱敏：
 * - `"secret":"xxx"` 保留键名、抹掉值；
 * - `token=xxx` 同样处理；
 * - `set / empty / unknown / true / false` 这类状态值保留，便于判断是否已配置。
 *
 * 采用保守替换而非拒绝导出：宁可少量信息缺失，也不把凭据写进用户要外发的文件。
 */
export function redactSecrets(input: string): RedactionResult {
  let redactions = 0;
  let text = input;

  text = text.replace(KEY_VALUE_JSON, (whole: string, head: string, value: string, tail: string) => {
    if (value.length === 0 || PRESERVE.test(value)) return whole;
    redactions += 1;
    return `${head}[REDACTED]${tail}`;
  });

  text = text.replace(KEY_VALUE_INLINE, (whole: string, key: string, value: string) => {
    if (PRESERVE.test(value)) return whole;
    redactions += 1;
    return `${key}=[REDACTED]`;
  });

  return { text, redactions };
}