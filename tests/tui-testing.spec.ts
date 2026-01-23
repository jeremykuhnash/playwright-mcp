/**
 * TUI Testing with Terminal MCP - Playwright Test Suite
 *
 * Demonstrates TDD workflow for TUI application development:
 * 1. Write test for expected behavior
 * 2. Run test (fails - feature doesn't exist)
 * 3. Implement feature
 * 4. Run test (passes)
 * 5. Save golden state for regression testing
 */

import path from 'path';
import fs from 'fs';
import { test as baseTest, expect } from '@playwright/test';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

const test = baseTest.extend<{ client: Client; terminalId: string | null }>({
  client: async ({}, use) => {
    const client = new Client({ name: 'tui-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: 'node',
      args: [path.join(__dirname, '../cli-xterm.js')],
      stderr: 'pipe',
    });
    await client.connect(transport);
    await use(client);
    await client.close();
  },

  terminalId: async ({}, use) => {
    // Placeholder - tests will set this
    await use(null);
  },
});

// Helper to extract terminal ID from spawn result
function extractTerminalId(result: any): string {
  const text = result.content[0].text;
  const match = text.match(/ID: (mcp_term_\d+_\d+)/);
  if (!match) throw new Error('Failed to extract terminal ID');
  return match[1];
}

// Helper to get screen text
function getScreenText(result: any): string {
  return result.content[0].text;
}

test.describe('Sample TUI - Basic Functionality', () => {
  test('displays main menu on startup', async ({ client }) => {
    // Spawn the TUI
    const spawnResult = await client.callTool({
      name: 'terminal_spawn',
      arguments: {
        command: 'node',
        args: [path.join(__dirname, '../examples/sample-tui.js')],
        cols: 80,
        rows: 24,
      },
    });
    const terminalId = extractTerminalId(spawnResult);

    try {
      // Wait for TUI to render
      await client.callTool({
        name: 'terminal_wait',
        arguments: { id: terminalId, pattern: 'Sample TUI', timeout: 3000 },
      });

      // Assert expected elements are present
      const assertResult = await client.callTool({
        name: 'terminal_assert',
        arguments: {
          id: terminalId,
          contains: 'Menu',
        },
      });
      expect(getScreenText(assertResult)).toContain('✅');

      // Verify all menu items
      const snapshot = await client.callTool({
        name: 'terminal_snapshot',
        arguments: { id: terminalId },
      });
      const screen = getScreenText(snapshot);

      expect(screen).toContain('Say Hello');
      expect(screen).toContain('Show Counter');
      expect(screen).toContain('Input Test');
      expect(screen).toContain('Exit');

    } finally {
      await client.callTool({
        name: 'terminal_kill',
        arguments: { id: terminalId },
      });
    }
  });

  test('keyboard navigation works', async ({ client }) => {
    const spawnResult = await client.callTool({
      name: 'terminal_spawn',
      arguments: {
        command: 'node',
        args: [path.join(__dirname, '../examples/sample-tui.js')],
        cols: 80,
        rows: 24,
      },
    });
    const terminalId = extractTerminalId(spawnResult);

    try {
      await client.callTool({
        name: 'terminal_wait',
        arguments: { id: terminalId, pattern: 'Menu', timeout: 3000 },
      });

      // First item should be selected initially (▶ indicator)
      let snapshot = await client.callTool({
        name: 'terminal_snapshot',
        arguments: { id: terminalId },
      });
      expect(getScreenText(snapshot)).toMatch(/▶.*Say Hello/);

      // Navigate down
      await client.callTool({
        name: 'terminal_send_keys',
        arguments: { id: terminalId, keys: 'Down' },
      });
      await new Promise(r => setTimeout(r, 100));

      snapshot = await client.callTool({
        name: 'terminal_snapshot',
        arguments: { id: terminalId },
      });
      expect(getScreenText(snapshot)).toMatch(/▶.*Show Counter/);

      // Navigate down again
      await client.callTool({
        name: 'terminal_send_keys',
        arguments: { id: terminalId, keys: 'Down' },
      });
      await new Promise(r => setTimeout(r, 100));

      snapshot = await client.callTool({
        name: 'terminal_snapshot',
        arguments: { id: terminalId },
      });
      expect(getScreenText(snapshot)).toMatch(/▶.*Input Test/);

    } finally {
      await client.callTool({
        name: 'terminal_kill',
        arguments: { id: terminalId },
      });
    }
  });

  test('counter view increments and decrements', async ({ client }) => {
    const spawnResult = await client.callTool({
      name: 'terminal_spawn',
      arguments: {
        command: 'node',
        args: [path.join(__dirname, '../examples/sample-tui.js')],
        cols: 80,
        rows: 24,
      },
    });
    const terminalId = extractTerminalId(spawnResult);

    try {
      await client.callTool({
        name: 'terminal_wait',
        arguments: { id: terminalId, pattern: 'Menu', timeout: 3000 },
      });

      // Navigate to Counter (second item)
      await client.callTool({
        name: 'terminal_send_keys',
        arguments: { id: terminalId, keys: 'j' },  // vim-style down
      });
      await client.callTool({
        name: 'terminal_wait_idle',
        arguments: { id: terminalId, idle_ms: 200, timeout: 2000 },
      });

      // Enter the counter view
      await client.callTool({
        name: 'terminal_send_keys',
        arguments: { id: terminalId, keys: 'Enter' },
      });

      // Wait for Counter view to appear
      const waitResult = await client.callTool({
        name: 'terminal_wait',
        arguments: { id: terminalId, pattern: 'Counter value:', timeout: 3000 },
      });
      expect(getScreenText(waitResult)).toContain('found');

      // Initial value should be 0
      let assertResult = await client.callTool({
        name: 'terminal_assert',
        arguments: { id: terminalId, contains: 'Counter value:' },
      });
      expect(getScreenText(assertResult)).toContain('✅');

      // Increment 3 times (one at a time for reliability)
      for (let i = 0; i < 3; i++) {
        await client.callTool({
          name: 'terminal_send_keys',
          arguments: { id: terminalId, keys: '+' },
        });
        await client.callTool({
          name: 'terminal_wait_idle',
          arguments: { id: terminalId, idle_ms: 100, timeout: 1000 },
        });
      }

      // Verify counter shows 3
      const snapshot = await client.callTool({
        name: 'terminal_snapshot',
        arguments: { id: terminalId },
      });
      expect(getScreenText(snapshot)).toContain('3');

      // Decrement once
      await client.callTool({
        name: 'terminal_send_keys',
        arguments: { id: terminalId, keys: '-' },
      });
      await client.callTool({
        name: 'terminal_wait_idle',
        arguments: { id: terminalId, idle_ms: 100, timeout: 1000 },
      });

      // Verify counter shows 2
      const snapshot2 = await client.callTool({
        name: 'terminal_snapshot',
        arguments: { id: terminalId },
      });
      expect(getScreenText(snapshot2)).toContain('2');

    } finally {
      await client.callTool({
        name: 'terminal_kill',
        arguments: { id: terminalId },
      });
    }
  });
});

test.describe('Sample TUI - Recording & Snapshots', () => {
  test('can record and save session', async ({ client }, testInfo) => {
    const spawnResult = await client.callTool({
      name: 'terminal_spawn',
      arguments: {
        command: 'node',
        args: [path.join(__dirname, '../examples/sample-tui.js')],
        cols: 80,
        rows: 24,
      },
    });
    const terminalId = extractTerminalId(spawnResult);

    try {
      await client.callTool({
        name: 'terminal_wait',
        arguments: { id: terminalId, pattern: 'Menu', timeout: 3000 },
      });

      // Start recording
      await client.callTool({
        name: 'terminal_record_start',
        arguments: { id: terminalId, interval_ms: 50 },
      });

      // Perform some actions
      await client.callTool({
        name: 'terminal_send_keys',
        arguments: { id: terminalId, keys: 'Down' },
      });
      await new Promise(r => setTimeout(r, 200));

      await client.callTool({
        name: 'terminal_send_keys',
        arguments: { id: terminalId, keys: 'Down' },
      });
      await new Promise(r => setTimeout(r, 200));

      await client.callTool({
        name: 'terminal_send_keys',
        arguments: { id: terminalId, keys: 'Up' },
      });
      await new Promise(r => setTimeout(r, 200));

      // Save recording
      const recordingPath = testInfo.outputPath('session-recording.json');
      const saveResult = await client.callTool({
        name: 'terminal_record_save',
        arguments: { id: terminalId, path: recordingPath },
      });

      expect(getScreenText(saveResult)).toContain('Recording saved');
      expect(fs.existsSync(recordingPath)).toBe(true);

      // Verify recording content
      const recording = JSON.parse(fs.readFileSync(recordingPath, 'utf8'));
      expect(recording.frames.length).toBeGreaterThan(5);
      expect(recording.sessionId).toBe(terminalId);

    } finally {
      await client.callTool({
        name: 'terminal_kill',
        arguments: { id: terminalId },
      });
    }
  });

  test('can dump and compare state', async ({ client }, testInfo) => {
    const spawnResult = await client.callTool({
      name: 'terminal_spawn',
      arguments: {
        command: 'node',
        args: [path.join(__dirname, '../examples/sample-tui.js')],
        cols: 80,
        rows: 24,
      },
    });
    const terminalId = extractTerminalId(spawnResult);

    try {
      await client.callTool({
        name: 'terminal_wait',
        arguments: { id: terminalId, pattern: 'Menu', timeout: 3000 },
      });

      // Navigate to a specific state
      await client.callTool({
        name: 'terminal_send_keys',
        arguments: { id: terminalId, keys: 'Down' },
      });
      await new Promise(r => setTimeout(r, 100));

      // Dump the state
      const dumpPath = testInfo.outputPath('golden-state.json');
      await client.callTool({
        name: 'terminal_dump',
        arguments: { id: terminalId, path: dumpPath, include_history: false },
      });

      expect(fs.existsSync(dumpPath)).toBe(true);

      // Compare current state to dump (should match)
      const compareResult = await client.callTool({
        name: 'terminal_compare',
        arguments: { id: terminalId, expected_path: dumpPath, ignore_whitespace: true },
      });
      expect(getScreenText(compareResult)).toContain('✅');

      // Change state
      await client.callTool({
        name: 'terminal_send_keys',
        arguments: { id: terminalId, keys: 'Down' },
      });
      await new Promise(r => setTimeout(r, 100));

      // Compare again (should NOT match)
      const compareResult2 = await client.callTool({
        name: 'terminal_compare',
        arguments: { id: terminalId, expected_path: dumpPath, ignore_whitespace: true },
      });
      expect(getScreenText(compareResult2)).toContain('❌');

    } finally {
      await client.callTool({
        name: 'terminal_kill',
        arguments: { id: terminalId },
      });
    }
  });
});

test.describe('Sample TUI - Multi-Pane Testing', () => {
  test('can split terminal and run multiple TUIs', async ({ client }) => {
    // Spawn bash first
    const spawnResult = await client.callTool({
      name: 'terminal_spawn',
      arguments: { command: '/bin/bash', cols: 120, rows: 40 },
    });
    const terminalId = extractTerminalId(spawnResult);

    try {
      await client.callTool({
        name: 'terminal_wait_prompt',
        arguments: { id: terminalId, timeout: 3000 },
      });

      // Start TUI in pane 0
      await client.callTool({
        name: 'terminal_send_text',
        arguments: {
          id: terminalId,
          text: `node ${path.join(__dirname, '../examples/sample-tui.js')}`,
        },
      });
      await client.callTool({
        name: 'terminal_send_keys',
        arguments: { id: terminalId, keys: 'Enter' },
      });

      await client.callTool({
        name: 'terminal_wait',
        arguments: { id: terminalId, pattern: 'Sample TUI', timeout: 3000 },
      });

      // Split pane horizontally
      await client.callTool({
        name: 'terminal_split',
        arguments: { id: terminalId, horizontal: true },
      });

      // List panes
      const panesResult = await client.callTool({
        name: 'terminal_list_panes',
        arguments: { id: terminalId },
      });
      expect(getScreenText(panesResult)).toContain('[0]');
      expect(getScreenText(panesResult)).toContain('[1]');

      // Pane 0 should still show the TUI
      const pane0Result = await client.callTool({
        name: 'terminal_capture_pane',
        arguments: { id: terminalId, pane: 0 },
      });
      expect(getScreenText(pane0Result)).toContain('Sample TUI');

      // Pane 1 should have a shell prompt
      await new Promise(r => setTimeout(r, 500));
      const pane1Result = await client.callTool({
        name: 'terminal_capture_pane',
        arguments: { id: terminalId, pane: 1 },
      });
      // Just verify it captured something (shell prompt varies)
      expect(pane1Result.content[0].text).toBeTruthy();

    } finally {
      await client.callTool({
        name: 'terminal_kill',
        arguments: { id: terminalId },
      });
    }
  });
});
