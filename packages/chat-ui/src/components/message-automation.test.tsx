import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { MessageCard } from './message';

it('labels automated messages above the bubble and clears the label for manual messages', () => {
  const item = { kind: 'user_message' as const, id: 'message', text: 'Check the build', attachments: [], created_at: '2026-09-08T10:00:00Z' };
  const { rerender } = render(<MessageCard item={{ ...item, automated: true }} />);
  expect(screen.getByText('Sent by scheduled task')).toBeTruthy();
  expect(screen.getByText('Check the build')).toBeTruthy();
  rerender(<MessageCard item={item} />);
  expect(screen.queryByText('Sent by scheduled task')).toBeNull();
});
