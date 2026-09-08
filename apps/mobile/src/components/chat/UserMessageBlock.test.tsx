import React from 'react';
import { afterEach, expect, it } from 'vitest';
import { cleanup, renderComponent, textOf } from '@/test/render';
import { UserMessageBlock } from './UserMessageBlock';

afterEach(cleanup);

it('labels automated sends and leaves manual sends unlabelled', () => {
  const item = { kind: 'user_message' as const, id: 'message', text: 'Check the build', attachments: [], created_at: '2026-09-08T10:00:00Z' };
  const scheduled = renderComponent(<UserMessageBlock item={{ ...item, automated: true }} />);
  expect(textOf(scheduled)).toContain('Sent by scheduled task');
  cleanup();
  const manual = renderComponent(<UserMessageBlock item={item} />);
  expect(textOf(manual)).not.toContain('Sent by scheduled task');
});
