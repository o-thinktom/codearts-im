import type { Capability, KernelInfo } from "./port.js";

export const ALL_CAPABILITIES: Capability[] = [
  "session.create",
  "session.resume",
  "session.exists",
  "prompt",
  "event.stream",
  "event.delta",
  "compact",
  "model.set",
  "permission",
  "deliverable",
];

export const MINIMAL_CAPABILITIES: Capability[] = ["session.create", "prompt", "event.stream"];

export interface DegradePlan {
  streaming: boolean;
  resume: boolean;
  existsProbe: boolean;
  compact: boolean;
  modelSwitch: boolean;
  permission: boolean;
  deliverable: boolean;
  unknownKernel: boolean;
}

export function detectCapabilities(declared: Iterable<string> | undefined, info: Partial<KernelInfo> = {}): Set<Capability> {
  const set = new Set<Capability>();
  const known = new Set<string>(ALL_CAPABILITIES);
  for (const c of declared ?? []) {
    if (known.has(c)) set.add(c as Capability);
  }
  if (set.size === 0 && info.version !== undefined) {
    for (const c of MINIMAL_CAPABILITIES) set.add(c);
    set.add("session.resume");
  }
  return set;
}

export function degradePlan(capabilities: Iterable<Capability>): DegradePlan {
  const caps = new Set(capabilities);
  return {
    streaming: caps.has("event.delta"),
    resume: caps.has("session.resume"),
    existsProbe: caps.has("session.exists"),
    compact: caps.has("compact"),
    modelSwitch: caps.has("model.set"),
    permission: caps.has("permission"),
    deliverable: caps.has("deliverable"),
    unknownKernel: caps.size === 0,
  };
}

export function describeDegrade(plan: DegradePlan): string[] {
  const notes: string[] = [];
  if (plan.unknownKernel) notes.push("未识别内核能力，进入只读兼容模式");
  if (!plan.streaming) notes.push("内核不支持流式，已降级为整段发送");
  if (!plan.resume) notes.push("内核不支持恢复会话，重启后将新建会话");
  if (!plan.permission) notes.push("内核不支持审批回流，使用静态权限策略");
  if (!plan.deliverable) notes.push("内核不提供交付物事件，仅以文本告知路径");
  if (!plan.compact) notes.push("内核不支持上下文压缩");
  if (!plan.modelSwitch) notes.push("内核不支持运行时切换模型");
  if (!plan.existsProbe) notes.push("内核无会话存在性探测，重建策略按 fail-loud 处理");
  return notes;
}