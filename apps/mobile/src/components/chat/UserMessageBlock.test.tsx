import React from 'react';
import { afterEach, expect, it } from 'vitest';
import { cleanup, renderComponent, textOf } from '@/test/render';
import { UserMessageBlock } from './UserMessageBlock';

afterEach(cleanup);

function flattenStyle(style: unknown): Record<string, unknown> {
  if (style == null) return {};
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
  if (typeof style === 'object') return style as Record<string, unknown>;
  return {};
}

it('labels automated sends and leaves manual sends unlabelled', () => {
  const item = { kind: 'user_message' as const, id: 'message', text: 'Check the build', attachments: [], created_at: '2026-09-08T10:00:00Z' };
  const scheduled = renderComponent(<UserMessageBlock item={{ ...item, automated: true }} />);
  expect(textOf(scheduled)).toContain('Sent by scheduled task');
  cleanup();
  const manual = renderComponent(<UserMessageBlock item={item} />);
  expect(textOf(manual)).not.toContain('Sent by scheduled task');
});

it('packs a short bubble with UI leading instead of transcript prose spacing', () => {
  const renderer = renderComponent(
    <UserMessageBlock
      item={{
        kind: 'user_message',
        id: 'spacing',
        text: 'On mobile in the sidebar there\'s no "pin in project" icon',
        attachments: [],
        created_at: '2026-09-08T10:00:00Z',
      }}
    />,
  );

  const bubble = renderer.root.findAllByType('View' as never).find((node) => {
    const style = flattenStyle(node.props.style);
    return style.maxWidth === '80%';
  });
  expect(flattenStyle(bubble?.props.style)).toMatchObject({
    paddingHorizontal: 16,
    paddingVertical: 8,
  });

  const selectable = renderer.root
    .findAllByType('Text' as never)
    .find((node) => node.props.selectable === true);
  // Mock theme body is 16px; compact uses lineHeight.normal (1.5), not prose (1.78).
  expect(flattenStyle(selectable?.props.style).lineHeight).toBe(24);
});
