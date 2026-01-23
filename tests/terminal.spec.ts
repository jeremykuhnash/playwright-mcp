/**
 * Terminal tools tests (tmux-based)
 */

import path from 'path';
import { test as baseTest, expect } from '@playwright/test';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

const test = baseTest.extend<{ client: Client }>({
  client: async ({}, use) => {
    const client = new Client({ name: 'terminal-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: 'node',
      args: [path.join(__dirname, '../cli-xterm.js')],
      stderr: 'pipe',
    });
    await client.connect(transport);
    await use(client);
    await client.close();
  },
});

test.describe('Terminal MCP Tools (tmux)', () => {
  test('lists terminal tools', async ({ client }) => {
    const { tools } = await client.listTools();
    const toolNames = tools.map(t => t.name);

    expect(toolNames).toContain('terminal_spawn');
    expect(toolNames).toContain('terminal_send_keys');
    expect(toolNames).toContain('terminal_send_text');
    expect(toolNames).toContain('terminal_snapshot');
    expect(toolNames).toContain('terminal_save');
    expect(toolNames).toContain('terminal_resize');
    expect(toolNames).toContain('terminal_kill');
    expect(toolNames).toContain('terminal_list');
    expect(toolNames).toContain('terminal_wait');
  });

  test('spawns and interacts with terminal', async ({ client }) => {
    // Spawn a shell
    const spawnResult = await client.callTool({
      name: 'terminal_spawn',
      arguments: { command: '/bin/bash', cols: 80, rows: 24 },
    });
    expect(spawnResult.content[0]).toHaveProperty('text');
    const spawnText = (spawnResult.content[0] as { text: string }).text;
    expect(spawnText).toContain('mcp_term_');

    // Extract terminal ID
    const idMatch = spawnText.match(/ID: (mcp_term_\d+_\d+)/);
    expect(idMatch).toBeTruthy();
    const terminalId = idMatch![1];

    // List terminals
    const listResult = await client.callTool({
      name: 'terminal_list',
      arguments: {},
    });
    expect((listResult.content[0] as { text: string }).text).toContain(terminalId);

    // Send a command using send_text + send_keys
    await client.callTool({
      name: 'terminal_send_text',
      arguments: { id: terminalId, text: 'echo hello' },
    });
    await client.callTool({
      name: 'terminal_send_keys',
      arguments: { id: terminalId, keys: 'Enter' },
    });

    // Wait a moment for output
    await new Promise(r => setTimeout(r, 300));

    // Get snapshot
    const snapshotResult = await client.callTool({
      name: 'terminal_snapshot',
      arguments: { id: terminalId },
    });
    const snapshotText = (snapshotResult.content[0] as { text: string }).text;
    expect(snapshotText).toContain('hello');

    // Kill terminal
    const killResult = await client.callTool({
      name: 'terminal_kill',
      arguments: { id: terminalId },
    });
    expect((killResult.content[0] as { text: string }).text).toContain('killed');

    // Verify it's gone
    const listResult2 = await client.callTool({
      name: 'terminal_list',
      arguments: {},
    });
    expect((listResult2.content[0] as { text: string }).text).not.toContain(terminalId);
  });

  test('terminal_wait finds pattern', async ({ client }) => {
    // Spawn shell
    const spawnResult = await client.callTool({
      name: 'terminal_spawn',
      arguments: { command: '/bin/bash' },
    });
    const idMatch = (spawnResult.content[0] as { text: string }).text.match(/ID: (mcp_term_\d+_\d+)/);
    expect(idMatch).toBeTruthy();
    const terminalId = idMatch![1];

    // Send command that will produce output
    await client.callTool({
      name: 'terminal_send_text',
      arguments: { id: terminalId, text: 'echo "MARKER_12345"' },
    });
    await client.callTool({
      name: 'terminal_send_keys',
      arguments: { id: terminalId, keys: 'Enter' },
    });

    // Wait for the marker
    const waitResult = await client.callTool({
      name: 'terminal_wait',
      arguments: { id: terminalId, pattern: 'MARKER_12345', timeout: 3000 },
    });
    expect((waitResult.content[0] as { text: string }).text).toContain('found');

    // Cleanup
    await client.callTool({
      name: 'terminal_kill',
      arguments: { id: terminalId },
    });
  });

  test('terminal_resize changes dimensions', async ({ client }) => {
    const spawnResult = await client.callTool({
      name: 'terminal_spawn',
      arguments: { command: '/bin/bash', cols: 80, rows: 24 },
    });
    const idMatch = (spawnResult.content[0] as { text: string }).text.match(/ID: (mcp_term_\d+_\d+)/);
    expect(idMatch).toBeTruthy();
    const terminalId = idMatch![1];

    // Resize
    const resizeResult = await client.callTool({
      name: 'terminal_resize',
      arguments: { id: terminalId, cols: 120, rows: 40 },
    });
    expect((resizeResult.content[0] as { text: string }).text).toContain('120x40');

    // Cleanup
    await client.callTool({
      name: 'terminal_kill',
      arguments: { id: terminalId },
    });
  });

  test('terminal_save writes to file', async ({ client }) => {
    const spawnResult = await client.callTool({
      name: 'terminal_spawn',
      arguments: { command: '/bin/bash' },
    });
    const idMatch = (spawnResult.content[0] as { text: string }).text.match(/ID: (mcp_term_\d+_\d+)/);
    expect(idMatch).toBeTruthy();
    const terminalId = idMatch![1];

    // Generate some output
    await client.callTool({
      name: 'terminal_send_text',
      arguments: { id: terminalId, text: 'echo "SAVED_CONTENT"' },
    });
    await client.callTool({
      name: 'terminal_send_keys',
      arguments: { id: terminalId, keys: 'Enter' },
    });
    await new Promise(r => setTimeout(r, 200));

    // Save to file
    const tmpFile = `/tmp/terminal_test_${Date.now()}.txt`;
    const saveResult = await client.callTool({
      name: 'terminal_save',
      arguments: { id: terminalId, path: tmpFile },
    });
    expect((saveResult.content[0] as { text: string }).text).toContain(tmpFile);

    // Cleanup
    await client.callTool({
      name: 'terminal_kill',
      arguments: { id: terminalId },
    });
  });
});
