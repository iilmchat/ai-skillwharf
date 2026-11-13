import { McpClient } from './mcp-client.js';

describe('McpClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('передаёт Authorization: Bearer, если задан authToken', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('stop'));
    vi.stubGlobal('fetch', fetchMock);

    const client = new McpClient({
      baseUrl: 'http://mcp.local',
      authToken: 'secret-token',
    });

    await expect(client.callTool('ping', {})).rejects.toThrow('stop');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://mcp.local/sse',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer secret-token',
        }),
      }),
    );
  });

  it('не добавляет Authorization, если токен не задан', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('stop'));
    vi.stubGlobal('fetch', fetchMock);

    const client = new McpClient({ baseUrl: 'http://mcp.local' });

    await expect(client.callTool('ping', {})).rejects.toThrow('stop');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://mcp.local/sse',
      expect.objectContaining({
        headers: { Accept: 'text/event-stream' },
      }),
    );
  });
});
