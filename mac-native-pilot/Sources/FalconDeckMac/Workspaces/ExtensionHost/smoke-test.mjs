import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
const source = dirname(fileURLToPath(import.meta.url));
const script = await readFile(resolve(source, '../ExtensionResources/host.js'), 'utf8');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://extension.invalid' });
const calls = [];
let notes = [];
let threadStages = {};
dom.window.webkit = { messageHandlers: { extension: { async postMessage(message) {
  calls.push(message);
  if (message.kind !== 'action') return null;
  if (message.actionId === 'notes') {
    if (message.input.operation === 'create') notes = [{ id: 'test-note', title: 'Test note', body: message.input.body, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }];
    return { result: { notes }, updatedViews: [] };
  }
  if (message.actionId === 'manage-tags') return { result: { stages: [{ id: 'in_progress', label: 'In progress', color: 'green' }], threadStages }, updatedViews: [] };
  throw new Error('Unexpected action');
} } } };
dom.window.eval(script);
const settle = () => new Promise(resolve => setTimeout(resolve, 70));
const base = { threads: [], workspaces: [], views: [], permissions: [], appearance: 'dark', appearanceSettings: { darkColorTheme: 'nord', fontScale: 1.2 } };
dom.window.falconDeckPanelUpdate({ ...base, extensionId: 'falcondeck.notes', panelId: 'library' });
await settle();
await settle();
assert.ok(calls.some(call => call.actionId === 'notes' && call.input.operation === 'read'), 'Notes reads through native bridge');
assert.ok(dom.window.document.body.textContent.includes('No notes yet'));
dom.window.document.querySelector('button[aria-label="New note"]').click();
await settle();
assert.ok(calls.some(call => call.actionId === 'notes' && call.input.operation === 'create'), 'Notes creates through native bridge');
assert.ok(dom.window.document.querySelector('textarea'), 'Notes editor renders real official frontend');
dom.window.falconDeckPanelUpdate({ ...base, extensionId: 'falcondeck.thread-tags', panelId: 'board' });
await settle();
assert.ok(dom.window.document.body.textContent.includes('Allow thread summaries'), 'Kanban respects denied permission');
assert.equal(calls.filter(call => call.actionId === 'manage-tags').length, 0);
dom.window.falconDeckPanelUpdate({ ...base, extensionId: 'falcondeck.thread-tags', panelId: 'board', permissions: ['threads:read'], threads: [{ id: 'task', workspaceId: 'workspace', title: 'Native smoke task', status: 'idle', updatedAt: new Date().toISOString(), pendingApprovalCount: 0, pendingQuestionCount: 0 }], workspaces: [{ id: 'workspace', name: 'Project', kind: 'project' }] });
await settle();
await settle();
assert.ok(calls.some(call => call.actionId === 'manage-tags'), 'Kanban reads through native bridge once allowed');
assert.ok(dom.window.document.body.textContent.includes('Native smoke task'));
const card = [...dom.window.document.querySelectorAll('button')].find(button => button.textContent.includes('Native smoke task'));
card.click();
await settle();
assert.ok(calls.some(call => call.kind === 'openThread' && call.threadId === 'task'), 'Kanban navigates with identifiers only');
assert.equal(dom.window.document.documentElement.dataset.theme, 'dark');
assert.equal(dom.window.document.documentElement.dataset.palette, 'nord');
assert.equal(dom.window.document.documentElement.style.getPropertyValue('--fd-font-scale'), '1.2');
// Each WK bridge is already bound to a host. Its task summaries, view scopes,
// action results and navigation messages must all use that host's raw IDs.
dom.window.falconDeckPanelUpdate({ ...base, extensionId: 'falcondeck.notes', panelId: 'library' });
await settle();
threadStages = { 'remote-task': 'in_progress' };
dom.window.falconDeckPanelUpdate({
  ...base, extensionId: 'falcondeck.thread-tags', panelId: 'board', permissions: ['threads:read'],
  threads: [{ id: 'remote-task', workspaceId: 'remote-workspace', title: 'Previously staged remote task', status: 'idle', updatedAt: new Date().toISOString(), pendingApprovalCount: 0, pendingQuestionCount: 0 }],
  workspaces: [{ id: 'remote-workspace', name: 'Remote project', kind: 'project' }],
  views: [{ viewId: 'thread-tags', scope: { kind: 'thread', id: 'remote-task' }, value: { tagIds: ['in_progress'] }, updatedAt: '2026-01-01T00:00:00Z' }],
});
await settle();
await settle();
const stagedColumn = dom.window.document.querySelector('section[aria-label="In progress"]');
assert.ok(stagedColumn?.textContent.includes('Previously staged remote task'), 'Remote Kanban preserves an existing raw-ID assignment after its read response');
assert.ok(!dom.window.document.querySelector('section[aria-label="No stage"]')?.textContent.includes('Previously staged remote task'));
const remoteCard = [...stagedColumn.querySelectorAll('button')].find(button => button.textContent.includes('Previously staged remote task'));
remoteCard.click();
await settle();
assert.ok(calls.some(call => call.kind === 'openThread' && call.workspaceId === 'remote-workspace' && call.threadId === 'remote-task'), 'Remote Kanban sends host-local navigation identifiers');
dom.window.falconDeckPanelUpdate({ ...base, extensionId: 'falcondeck.notes', panelId: 'library' });
await settle();
await settle();
const editor = dom.window.document.querySelector('textarea');
Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set.call(editor, 'Final unsaved edit');
editor.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
await settle();
await dom.window.falconDeckPanelPrepareToClose();
assert.ok(calls.some(call => call.actionId === 'notes' && call.input.operation === 'save' && call.input.body === 'Final unsaved edit'), 'Panel teardown flushes the final note edit before removing bridge');
dom.window.close();
console.log('Extension compatibility smoke passed: Notes read/create/final-save, Kanban permissions/read/navigation and remote stage identity.');
