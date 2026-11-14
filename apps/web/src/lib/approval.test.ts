import { describe, expect, it } from 'vitest';
import {
  DZEN_PUBLISH_TOOL,
  approvalToolLabelKey,
  resolveApprovalAction,
} from './approval';

describe('resolveApprovalAction', () => {
  it('публикацию dzen-article отличает от обычного действия', () => {
    expect(resolveApprovalAction([DZEN_PUBLISH_TOOL])).toBe('dzen-publish');
    expect(resolveApprovalAction(['execute_sandbox_code'])).toBe('generic');
    expect(resolveApprovalAction([])).toBe('generic');
  });
});

describe('approvalToolLabelKey', () => {
  it('даёт ключ i18n только для известных инструментов', () => {
    expect(approvalToolLabelKey(DZEN_PUBLISH_TOOL)).toBe(
      'chat.approval.tools.publishToDzen',
    );
    expect(approvalToolLabelKey('unknown_tool')).toBeNull();
  });
});
