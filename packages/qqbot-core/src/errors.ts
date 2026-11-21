export const ErrorCode = {
  CREDENTIAL_INVALID: "QB-1001",
  WS_CONNECT_FAILED: "QB-1002",
  WS_DISCONNECTED: "QB-1003",
  KERNEL_NOT_READY: "QB-2001",
  SESSION_CREATE_FAILED: "QB-2002",
  SESSION_RESUME_FAILED: "QB-2003",
  TURN_TIMEOUT: "QB-3001",
  QUOTA_EXCEEDED: "QB-3002",
  ACCESS_DENIED: "QB-4001",
  PATH_NOT_ALLOWED: "QB-4002",
  MESSAGE_TOO_LONG: "QB-5001",
  QUEUE_FULL: "QB-5002",
  CONFIG_INVALID: "QB-6001",
  REVISION_CONFLICT: "QB-6002",
  PAIRING_INVALID: "QB-6003",
  INTERNAL: "QB-9999",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

const USER_MESSAGES: Record<ErrorCodeValue, string> = {
  "QB-1001": "QQ 机器人密钥无效，请重新绑定",
  "QB-1002": "正在重连 QQ，请稍候",
  "QB-1003": "与 QQ 的连接已断开，正在恢复",
  "QB-2001": "码道内核未启动，点此重启",
  "QB-2002": "会话创建失败，请稍后重试",
  "QB-2003": "上次会话无法恢复，已为你新建",
  "QB-3001": "本次任务超时已中止，可重新发起",
  "QB-3002": "当前账号额度不足，去查看用量",
  "QB-4001": "你不在本机器人的使用名单中",
  "QB-4002": "该文件不在允许发送的范围内",
  "QB-5001": "内容过长，已分成多条发送",
  "QB-5002": "当前排队较多，请稍后重试",
  "QB-6001": "插件配置有误，请检查设置",
  "QB-6002": "配置已被其他窗口修改，请刷新后重试",
  "QB-6003": "配对码无效或已过期",
  "QB-9999": "处理消息时出现异常，请稍后重试",
};

export class QqbotError extends Error {
  readonly code: ErrorCodeValue;
  readonly userMessage: string;
  readonly retryable: boolean;
  override readonly cause?: unknown;

  constructor(code: ErrorCodeValue, detail?: string, options?: { retryable?: boolean; cause?: unknown }) {
    super(detail ?? code);
    this.name = "QqbotError";
    this.code = code;
    this.userMessage = USER_MESSAGES[code];
    this.retryable = options?.retryable ?? false;
    if (options?.cause !== undefined) this.cause = options.cause;
  }

  toUserText(): string {
    return `⚠️ ${this.userMessage}`;
  }
}

export function userMessageOf(code: ErrorCodeValue): string {
  return USER_MESSAGES[code];
}

export function isQqbotError(value: unknown, code?: ErrorCodeValue): value is QqbotError {
  if (!(value instanceof QqbotError)) return false;
  return code === undefined || value.code === code;
}

export function toUserText(err: unknown): string {
  return err instanceof QqbotError ? err.toUserText() : `⚠️ ${USER_MESSAGES["QB-9999"]}`;
}