import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useParakeetStatus } from "./parakeet";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const status = { supported: true, installed: true, loaded: false, busy: false, progress: null, phase: "", error: null };
beforeEach(() => {
  window.__TAURI_INTERNALS__ = {} as never;
  invoke.mockReset().mockResolvedValue(status);
});
afterEach(() => {
  vi.useRealTimers();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

it("reads cached status without downloading or loading a model", async () => {
  const { result } = renderHook(useParakeetStatus);
  await waitFor(() => expect(result.current.status).toEqual(status));
  expect(invoke.mock.calls).toEqual([["parakeet_status"]]);
});

it("downloads only when explicitly requested and exposes setup failures", async () => {
  const { result } = renderHook(useParakeetStatus);
  await waitFor(() => expect(result.current.status).toEqual(status));
  invoke.mockRejectedValueOnce("Download interrupted");
  await act(async () => { await result.current.prepare(); });
  expect(invoke).toHaveBeenLastCalledWith("prepare_parakeet", { force: false });
  expect(result.current.error).toBe("Download interrupted");
  expect(result.current.preparing).toBe(false);
  invoke.mockResolvedValueOnce({ ...status, loaded: true });
  await act(async () => { await result.current.prepare(); });
  expect(result.current.error).toBeNull();
  expect(result.current.status?.loaded).toBe(true);
});

it("coalesces repeated setup clicks while a download is running", async () => {
  const { result } = renderHook(useParakeetStatus);
  await waitFor(() => expect(result.current.status).toEqual(status));
  let finish!: (value: typeof status) => void;
  invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  let first!: Promise<void>;
  act(() => { first = result.current.prepare(); void result.current.prepare(); });
  expect(invoke.mock.calls.filter(([command]) => command === "prepare_parakeet")).toHaveLength(1);
  await act(async () => { finish(status); await first; });
});

it("does not let an older status poll overwrite completed setup", async () => {
  let finishPoll!: (value: typeof status) => void;
  invoke.mockImplementationOnce(() => new Promise(resolve => { finishPoll = resolve; }));
  const { result } = renderHook(useParakeetStatus);
  invoke.mockResolvedValueOnce({ ...status, loaded: true });
  await act(async () => { await result.current.prepare(); });
  expect(result.current.status?.loaded).toBe(true);
  await act(async () => { finishPoll({ ...status, installed: false }); });
  expect(result.current.status?.loaded).toBe(true);
});

it("requires an explicit repair request to force a fresh download", async () => {
  const { result } = renderHook(useParakeetStatus);
  await waitFor(() => expect(result.current.status).toEqual(status));
  await act(async () => { await result.current.prepare(true); });
  expect(invoke).toHaveBeenLastCalledWith("prepare_parakeet", { force: true });
});

it("clears a transient status error when polling recovers", async () => {
  vi.useFakeTimers();
  invoke.mockRejectedValueOnce("Status unavailable");
  const { result } = renderHook(useParakeetStatus);
  await act(async () => { await Promise.resolve(); });
  expect(result.current.error).toBe("Status unavailable");
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(result.current.error).toBeNull();
  expect(result.current.status).toEqual(status);
});

it("fails clearly outside the desktop without starting a download", async () => {
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  const { result } = renderHook(useParakeetStatus);
  await act(async () => { await result.current.prepare(); });
  expect(invoke).not.toHaveBeenCalled();
  expect(result.current.preparing).toBe(false);
  expect(result.current.error).toContain("FalconDeck Mac app");
});
