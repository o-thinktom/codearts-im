export interface RuntimeConfig {
  appId: string;
  workspace: string;
  agent?: string;
  provider?: string;
  model?: string;
  requireMention: boolean;
  streaming: boolean;
  textChunkLimit: number;
  showToolResults: boolean;
  processingTimeoutMs: number;
  maxQueue: number;
  access: {
    c2cMode: "open" | "allowlist" | "disabled";
    groupMode: "open" | "allowlist" | "disabled";
    commandMode: "open" | "allowlist" | "disabled";
  };
  media: {
    enabled: boolean;
    maxMB: number;
    ttlHours: number;
  };
  sendFile: {
    restrict: boolean;
    extraRoots: string[];
  };
}

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  appId: "",
  workspace: ".",
  requireMention: true,
  streaming: true,
  textChunkLimit: 4500,
  showToolResults: false,
  processingTimeoutMs: 30 * 60 * 1000,
  maxQueue: 20,
  access: {
    c2cMode: "open",
    groupMode: "allowlist",
    commandMode: "allowlist",
  },
  media: {
    enabled: true,
    maxMB: 200,
    ttlHours: 24,
  },
  sendFile: {
    restrict: true,
    extraRoots: [],
  },
};

export function normalizeConfig(partial: Partial<RuntimeConfig>): RuntimeConfig {
  const merged: RuntimeConfig = {
    ...DEFAULT_RUNTIME_CONFIG,
    ...partial,
    access: { ...DEFAULT_RUNTIME_CONFIG.access, ...(partial.access ?? {}) },
    media: { ...DEFAULT_RUNTIME_CONFIG.media, ...(partial.media ?? {}) },
    sendFile: { ...DEFAULT_RUNTIME_CONFIG.sendFile, ...(partial.sendFile ?? {}) },
  };
  if (!Number.isFinite(merged.textChunkLimit) || merged.textChunkLimit < 500) merged.textChunkLimit = 4500;
  if (!Number.isFinite(merged.maxQueue) || merged.maxQueue < 1) merged.maxQueue = 20;
  if (!Number.isFinite(merged.processingTimeoutMs) || merged.processingTimeoutMs < 1000) {
    merged.processingTimeoutMs = DEFAULT_RUNTIME_CONFIG.processingTimeoutMs;
  }
  if (!Number.isFinite(merged.media.maxMB) || merged.media.maxMB < 1) merged.media.maxMB = 200;
  if (!Number.isFinite(merged.media.ttlHours) || merged.media.ttlHours < 1) merged.media.ttlHours = 24;
  return merged;
}