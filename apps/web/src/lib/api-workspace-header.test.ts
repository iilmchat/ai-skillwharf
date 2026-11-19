import { AxiosHeaders, type InternalAxiosRequestConfig } from 'axios';
import { describe, expect, it } from 'vitest';
import { applyWorkspaceHeader } from './api';
import { useWorkspaceStore } from '../store/workspace.store';

function config(): InternalAxiosRequestConfig {
  return { headers: new AxiosHeaders() } as InternalAxiosRequestConfig;
}

describe('applyWorkspaceHeader', () => {
  it('добавляет X-Workspace-Id из активного воркспейса', () => {
    useWorkspaceStore.getState().setActiveWorkspace('ws-7');

    const result = applyWorkspaceHeader(config());

    expect(result.headers.get('X-Workspace-Id')).toBe('ws-7');
    useWorkspaceStore.getState().reset();
  });

  it('не добавляет заголовок, если воркспейс не выбран', () => {
    useWorkspaceStore.getState().reset();

    const result = applyWorkspaceHeader(config());

    expect(result.headers.get('X-Workspace-Id')).toBeUndefined();
  });
});
