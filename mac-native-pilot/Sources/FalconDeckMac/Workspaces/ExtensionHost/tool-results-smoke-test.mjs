import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const source = dirname(fileURLToPath(import.meta.url));
const built = await build({
  entryPoints: [resolve(source, 'host.tsx')], bundle: true, write: false, format: 'iife', platform: 'browser',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') }, jsx: 'automatic',
  plugins: [{
    name: 'owned-result-fixture',
    setup(build) {
      build.onResolve({ filter: /^\.\/registry$/ }, () => ({ path: 'fixture', namespace: 'result-fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'result-fixture' }, () => ({ resolveDir: source, contents: `
        import React from 'react';
        import { collectExtensionApp, defineExtensionApp } from '@falcondeck/extension-sdk/app';
        export const registrations = [collectExtensionApp(defineExtensionApp('test.artifacts', app => {
          app.agentToolResults.register({ toolId: 'draft-item', detail: { title: 'Draft details' }, component: props => {
            if (props.result.crash) throw new Error('fixture failure');
            return React.createElement('section', null,
              React.createElement('h2', null, props.result.title),
              React.createElement('span', null, props.presentation),
              React.createElement('span', null, props.views[0]?.value?.summary ?? ''),
              props.openDetails && React.createElement('button', { onClick: props.openDetails }, 'Open details'),
              React.createElement('button', { onClick: () => props.invokeAction('approve', { id: props.result.id }) }, 'Approve'));
          }});
        }))];`, loader: 'js' }));
      build.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'empty' }));
    },
  }],
});
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true });
const calls = [];
const expectedErrors = [];
const reportError = dom.window.console.error;
dom.window.console.error = (error, ...rest) => {
  if (String(error).includes('fixture failure')) expectedErrors.push(error);
  else reportError(error, ...rest);
};
dom.window.webkit = { messageHandlers: { extension: { async postMessage(message) { calls.push(message); return { result: { approved: true }, updatedViews: [] }; } } } };
dom.window.eval(built.outputFiles[0].text);
const settle = () => new Promise(resolve => setTimeout(resolve, 70));
const base = { extensionId: 'test.artifacts', panelId: '', threads: [], workspaces: [], permissions: ['agent-tools:register'], views: [{ viewId: 'draft', value: { summary: 'Owned synchronized view' }, updatedAt: '' }], appearance: 'light' };
const result = { toolId: 'draft-item', arguments: { objective: 'Ship' }, result: { id: 'd1', title: 'Review draft' }, presentation: 'inline', canOpenDetails: true };
dom.window.falconDeckPanelUpdate({ ...base, toolResult: result });
await settle();
assert.ok(dom.window.document.body.textContent.includes('Review draft'));
assert.ok(dom.window.document.body.textContent.includes('inline'));
assert.ok(dom.window.document.body.textContent.includes('Owned synchronized view'));
for (const label of ['Open details', 'Approve']) [...dom.window.document.querySelectorAll('button')].find(button => button.textContent === label).click();
await settle();
assert.ok(calls.some(call => call.kind === 'openDetails'), 'Details use native host-owned surface');
assert.ok(calls.some(call => call.kind === 'action' && call.actionId === 'approve' && call.input.id === 'd1'), 'Action stays on constrained bridge');
dom.window.falconDeckPanelUpdate({ ...base, toolResult: { ...result, presentation: 'detail', canOpenDetails: false } });
await settle();
assert.ok(dom.window.document.body.textContent.includes('detail'));
assert.equal(dom.window.document.documentElement.dataset.surface, 'tool-detail');
assert.equal([...dom.window.document.querySelectorAll('button')].filter(button => button.textContent === 'Open details').length, 0);
dom.window.falconDeckPanelUpdate({ ...base, permissions: [], toolResult: result });
await settle();
assert.ok(dom.window.document.body.textContent.includes('ordinary tool transcript'), 'Revoked grant preserves ordinary-result fallback');
dom.window.falconDeckPanelUpdate({ ...base, toolResult: { ...result, toolId: 'not-registered' } });
await settle();
assert.ok(dom.window.document.body.textContent.includes('ordinary tool transcript'), 'Unregistered tools cannot select a component');
dom.window.falconDeckPanelUpdate({ ...base, toolResult: { ...result, result: { crash: true } } });
await settle();
assert.ok(dom.window.document.body.textContent.includes('could not render'));
assert.ok(calls.some(call => call.kind === 'renderFailure'), 'Frontend failure reports fallback without replacing ordinary MCP row');
assert.equal(expectedErrors.length, 1, 'Expected renderer failure stays contained by the boundary');
await dom.window.falconDeckPanelPrepareToClose();
dom.window.close();
console.log('Extension result smoke passed: registered owner, views, inline/detail, action, revocation, missing registration, failure fallback.');
