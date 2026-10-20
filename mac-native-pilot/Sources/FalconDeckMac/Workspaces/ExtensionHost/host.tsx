import React, { Component, useCallback, useLayoutEffect, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import type { ExtensionAppPanelProps } from '@falcondeck/extension-sdk/app';
import { registrations } from './registry';
import { LIGHT_COLOR_THEME_OPTIONS, DARK_COLOR_THEME_OPTIONS, resolveSansStack, resolveMonoStack, type AppearanceSettings } from '../../../../../packages/ui/src/lib/appearance';
import './host.css';

type Data = Pick<ExtensionAppPanelProps, 'extensionId' | 'threads' | 'workspaces' | 'views'> & {
  panelId: string; permissions: string[]; appearance: string; appearanceSettings?: Partial<AppearanceSettings>;
  toolResult?: { toolId: string; arguments: unknown; result: unknown; presentation: 'inline' | 'detail'; canOpenDetails: boolean };
};
declare global {
  interface Window {
    falconDeckPanelUpdate(data: Data): void;
    falconDeckPanelPrepareToClose(): Promise<void>;
    webkit: { messageHandlers: { extension: { postMessage(message: unknown): Promise<any> } } };
  }
}
let current: Data | null = null;
const listeners = new Set<() => void>();
window.falconDeckPanelUpdate = (data) => {
  if (JSON.stringify(data) === JSON.stringify(current)) return;
  current = data;
  const root = document.documentElement;
  root.dataset.theme = data.appearance;
  const settings = data.appearanceSettings ?? {};
  const options = data.appearance === 'light' ? LIGHT_COLOR_THEME_OPTIONS : DARK_COLOR_THEME_OPTIONS;
  const selected = options.find(option => option.value === (data.appearance === 'light' ? settings.lightColorTheme : settings.darkColorTheme)) ?? options[0];
  if (selected.palette === 'falcon') delete root.dataset.palette; else root.dataset.palette = selected.palette;
  root.style.setProperty('--fd-font-sans', resolveSansStack(settings.sansFont ?? 'system', settings.sansFontCustom ?? '') ?? 'system-ui, sans-serif');
  root.style.setProperty('--fd-font-mono', resolveMonoStack(settings.monoFont ?? 'system-mono', settings.monoFontCustom ?? '') ?? 'ui-monospace, monospace');
  root.style.setProperty('--fd-font-scale', String(settings.fontScale ?? 1.05));
  for (const [field, property] of Object.entries({ sidebarScale: '--fd-scale-sidebar', chatScale: '--fd-scale-chat', codeScale: '--fd-scale-code', uiWeight: '--fd-weight-ui', sidebarWeight: '--fd-weight-sidebar', chatWeight: '--fd-weight-chat', codeWeight: '--fd-weight-code' })) {
    const value = settings[field as keyof AppearanceSettings];
    if (typeof value === 'number' && value !== 0) root.style.setProperty(property, String(value)); else root.style.removeProperty(property);
  }
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); };
const snapshot = () => current;
const pending = new Set<Promise<unknown>>();
function bridge(message: unknown) {
  const request = window.webkit.messageHandlers.extension.postMessage(message);
  pending.add(request);
  void request.then(() => pending.delete(request), () => pending.delete(request));
  return request;
}
class Boundary extends Component<{ children: React.ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  componentDidCatch() { void bridge({ kind: 'renderFailure' }); }
  render() { return this.state.error ? <div role="alert" className="p-6 text-danger">This extension could not render. Close and reopen the panel to retry.</div> : this.props.children; }
}
function Host() {
  const data = useSyncExternalStore(subscribe, snapshot);
  const invokeAction = useCallback(async (actionId: string, input?: unknown, target?: { kind: string; id: string } | null) => {
    return await bridge({ kind: 'action', actionId, input: input ?? null, target: target ?? null });
  }, []);
  const openThread = useCallback((workspaceId: string, threadId: string) => { void bridge({ kind: 'openThread', workspaceId, threadId }); }, []);
  const startTask = useCallback((draft: string) => { void bridge({ kind: 'startTask', draft }); }, []);
  const openExtensionSettings = useCallback(() => { void bridge({ kind: 'settings' }); }, []);
  const hasPermission = useCallback((permission: string) => data?.permissions.includes(permission) ?? false, [data?.permissions]);
  useLayoutEffect(() => {
    if (data?.toolResult?.presentation !== 'inline' || typeof ResizeObserver === 'undefined') return;
    const content = document.getElementById('root')!;
    const report = () => { void bridge({ kind: 'contentSize', height: Math.ceil(content.scrollHeight) }); };
    const observer = new ResizeObserver(report);
    observer.observe(content);
    report();
    return () => observer.disconnect();
  }, [data?.toolResult]);
  if (!data) return <div className="p-6 text-fg-muted">Loading panel…</div>;
  const app = registrations.find(item => item.extensionId === data.extensionId);
  document.documentElement.dataset.surface = data.toolResult ? (data.toolResult.presentation === 'detail' ? 'tool-detail' : 'tool-result') : 'panel';
  if (data.toolResult) {
    const registration = app?.agentToolResults.find(item => item.toolId === data.toolResult?.toolId);
    if (!registration || !data.permissions.includes('agent-tools:register')) return <div role="alert" className="p-6 text-fg-muted">This result is available in the ordinary tool transcript.</div>;
    const ToolResult = registration.component;
    const result = data.toolResult;
    return <Boundary key={`${data.extensionId}:${result.toolId}`}><ToolResult extensionId={data.extensionId} toolId={result.toolId} arguments={result.arguments} result={result.result} views={data.views} presentation={result.presentation} invokeAction={invokeAction} openDetails={registration.detail && result.canOpenDetails ? () => { void bridge({ kind: 'openDetails' }); } : undefined} /></Boundary>;
  }
  const registration = app?.panels.find(item => item.id === data.panelId);
  if (!registration) return <div role="alert" className="p-6 text-danger">This panel is not registered by a bundled official extension.</div>;
  const Panel = registration.component;
  return <Boundary key={`${data.extensionId}:${data.panelId}`}><Panel {...data} hasPermission={hasPermission} invokeAction={invokeAction} openThread={openThread} startTask={startTask} openExtensionSettings={openExtensionSettings} /></Boundary>;
}
const root = createRoot(document.getElementById('root')!);
root.render(<Host />);
window.falconDeckPanelPrepareToClose = async () => {
  // Unmount runs the official Notes editor's final dirty-draft save.
  root.unmount();
  await Promise.allSettled([...pending]);
};
void bridge({ kind: 'ready' });
