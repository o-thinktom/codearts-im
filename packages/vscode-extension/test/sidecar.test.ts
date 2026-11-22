import { EventEmitter } from "node:events";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SidecarStatus } from "../src/sidecar.js";
import { SidecarSupervisor } from "../src/sidecar.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("vscode", () => ({
  workspace: { getConfiguration: () => ({ get: () => undefined }) },
  ThemeColor: class {},
  ViewColumn: { Active: 1 },
  window: {},
}));

vi.mock("node:fs", () => ({ existsSync: () => true }));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));


class FakeChild extends EventEmitter {
  readonly stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  readonly stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  exitCode: number | null = null;
  readonly kill = vi.fn(() => {
    this.exitCode = 0;
    this.emit("exit", null, "SIGTERM");
  });
}

function setup(): { supervisor: InstanceType<typeof SidecarSupervisor>; statuses: SidecarStatus[]; children: FakeChild[] } {
  const children: FakeChild[] = [];
  spawnMock.mockImplementation(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });

  const statuses: SidecarStatus[] = [];
  const log = { appendLine: vi.fn(), append: vi.fn() };
  const supervisor = new SidecarSupervisor(
    { asAbsolutePath: (p: string) => path.join("C:/ext", p), globalStorageUri: { fsPath: "C:/storage" } } as never,
    log as never,
    (status) => statuses.push(status),
    () => [],
  );
  return { supervisor, statuses, children };
}

describe("SidecarSupervisor 重启语义", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("restart 只拉起一个新进程，旧进程退出不会触发额外重启", () => {
    const { supervisor, children } = setup();
    supervisor.start();
    children[0]?.emit("spawn");
    expect(spawnMock).toHaveBeenCalledTimes(1);

    supervisor.restart();
    expect(children[0]?.kill).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(350);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    children[1]?.emit("spawn");
    expect(supervisor.status.state).toBe("running");

    // 旧进程的退出事件不得再安排一次重启
    vi.advanceTimersByTime(10_000);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(supervisor.status.state).toBe("running");
  });

  it("主动 stop 后不再重启", () => {
    const { supervisor, children } = setup();
    supervisor.start();
    children[0]?.emit("spawn");

    supervisor.stop();
    vi.advanceTimersByTime(10_000);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(supervisor.status.state).toBe("stopped");
  });

  it("非主动退出仍按退避重启", () => {
    const { supervisor, children } = setup();
    supervisor.start();
    children[0]?.emit("spawn");
    children[0]!.exitCode = 1;
    children[0]!.emit("exit", 1, null);

    expect(supervisor.status.state).toBe("failed");
    vi.advanceTimersByTime(5_100);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});