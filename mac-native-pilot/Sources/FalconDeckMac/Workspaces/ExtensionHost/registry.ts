import { collectExtensionApp } from '@falcondeck/extension-sdk/app';
import notes from '../../../../../extensions/official/notes/app';
import kanban from '../../../../../extensions/official/thread-tags/app';

// Only source reviewed and compiled into the signed application can supply UI.
// Catalog entries never supply JavaScript or module locations to this host.
export const registrations = [notes, kanban].map(collectExtensionApp);

export const registrationManifest = registrations.map(({ extensionId, panels, agentToolResults }) => ({
  extensionId,
  panels: panels.map(({ id, title }) => ({ id, title })),
  agentToolResults: agentToolResults.map(({ toolId, detail }) => ({ toolId, detail: detail ?? null })),
}));
