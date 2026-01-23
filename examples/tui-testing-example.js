#!/usr/bin/env node
/**
 * Example: TUI Testing with the Terminal MCP
 *
 * This demonstrates how to test a TUI application using the terminal MCP tools.
 * Run this with: node examples/tui-testing-example.js
 */

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const path = require('path');

async function main() {
  // Connect to the terminal MCP server
  const client = new Client({ name: 'tui-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: 'node',
    args: [path.join(__dirname, '../cli-xterm.js')],
    stderr: 'pipe',
  });
  await client.connect(transport);

  console.log('🚀 Connected to Terminal MCP\n');
  console.log('═'.repeat(60));
  console.log('TUI Testing Example: Testing the sample-tui.js app');
  console.log('═'.repeat(60) + '\n');

  try {
    // =========================================================================
    // Step 1: Spawn the TUI application
    // =========================================================================
    console.log('📦 Step 1: Spawning TUI application...');

    const spawnResult = await client.callTool({
      name: 'terminal_spawn',
      arguments: {
        command: 'node',
        args: [path.join(__dirname, 'sample-tui.js')],
        cols: 80,
        rows: 24,
      },
    });

    const idMatch = spawnResult.content[0].text.match(/ID: (mcp_term_\d+_\d+)/);
    const terminalId = idMatch[1];
    console.log(`   Terminal ID: ${terminalId}\n`);

    // Wait for TUI to render
    await client.callTool({
      name: 'terminal_wait',
      arguments: { id: terminalId, pattern: 'Sample TUI', timeout: 3000 },
    });

    // =========================================================================
    // Step 2: Capture initial state
    // =========================================================================
    console.log('📸 Step 2: Capturing initial screen...');

    let snapshot = await client.callTool({
      name: 'terminal_snapshot',
      arguments: { id: terminalId },
    });
    console.log(snapshot.content[0].text);

    // =========================================================================
    // Step 3: Test navigation - move down to "Show Counter"
    // =========================================================================
    console.log('\n⬇️  Step 3: Testing keyboard navigation...');

    await client.callTool({
      name: 'terminal_send_keys',
      arguments: { id: terminalId, keys: 'Down' },
    });
    await new Promise(r => setTimeout(r, 100));

    snapshot = await client.callTool({
      name: 'terminal_snapshot',
      arguments: { id: terminalId },
    });

    // Verify selection moved
    if (snapshot.content[0].text.includes('▶') && snapshot.content[0].text.includes('Counter')) {
      console.log('   ✅ Navigation working - cursor moved to "Show Counter"');
    } else {
      console.log('   ❌ Navigation test failed');
    }

    // =========================================================================
    // Step 4: Enter the Counter view
    // =========================================================================
    console.log('\n↩️  Step 4: Entering Counter view...');

    await client.callTool({
      name: 'terminal_send_keys',
      arguments: { id: terminalId, keys: 'Enter' },
    });

    // Wait for view change
    await client.callTool({
      name: 'terminal_wait',
      arguments: { id: terminalId, pattern: 'Counter value:', timeout: 2000 },
    });

    snapshot = await client.callTool({
      name: 'terminal_snapshot',
      arguments: { id: terminalId },
    });
    console.log(snapshot.content[0].text);

    // =========================================================================
    // Step 5: Test counter increment
    // =========================================================================
    console.log('\n➕ Step 5: Testing counter increment...');

    // Press + three times
    for (let i = 0; i < 3; i++) {
      await client.callTool({
        name: 'terminal_send_keys',
        arguments: { id: terminalId, keys: '+' },
      });
      await new Promise(r => setTimeout(r, 50));
    }

    snapshot = await client.callTool({
      name: 'terminal_snapshot',
      arguments: { id: terminalId },
    });

    if (snapshot.content[0].text.includes('Counter value:') &&
        snapshot.content[0].text.includes('3')) {
      console.log('   ✅ Counter incremented to 3');
    } else {
      console.log('   ❌ Counter increment failed');
      console.log(snapshot.content[0].text);
    }

    // =========================================================================
    // Step 6: Return to menu and test input
    // =========================================================================
    console.log('\n📝 Step 6: Testing text input...');

    // Press any key to return to menu
    await client.callTool({
      name: 'terminal_send_keys',
      arguments: { id: terminalId, keys: 'Escape' },
    });
    await new Promise(r => setTimeout(r, 100));

    // Navigate to Input Test
    await client.callTool({
      name: 'terminal_send_keys',
      arguments: { id: terminalId, keys: 'Down Down' },
    });
    await client.callTool({
      name: 'terminal_send_keys',
      arguments: { id: terminalId, keys: 'Enter' },
    });

    await client.callTool({
      name: 'terminal_wait',
      arguments: { id: terminalId, pattern: 'Type something', timeout: 2000 },
    });

    // Type some text
    await client.callTool({
      name: 'terminal_send_text',
      arguments: { id: terminalId, text: 'Hello from automated test!' },
    });

    snapshot = await client.callTool({
      name: 'terminal_snapshot',
      arguments: { id: terminalId },
    });

    if (snapshot.content[0].text.includes('Hello from automated test!')) {
      console.log('   ✅ Text input working');
    } else {
      console.log('   ❌ Text input failed');
    }

    // Submit the input
    await client.callTool({
      name: 'terminal_send_keys',
      arguments: { id: terminalId, keys: 'Enter' },
    });
    await new Promise(r => setTimeout(r, 100));

    // =========================================================================
    // Step 7: Test exit
    // =========================================================================
    console.log('\n🚪 Step 7: Testing exit...');

    // Press q to quit
    await client.callTool({
      name: 'terminal_send_keys',
      arguments: { id: terminalId, keys: 'q' },
    });

    // Wait for process to exit (terminal will become empty/show shell)
    await new Promise(r => setTimeout(r, 500));

    snapshot = await client.callTool({
      name: 'terminal_snapshot',
      arguments: { id: terminalId },
    });

    // TUI should have exited
    if (!snapshot.content[0].text.includes('Sample TUI')) {
      console.log('   ✅ TUI exited cleanly');
    } else {
      console.log('   ❌ TUI did not exit');
    }

    // =========================================================================
    // Cleanup
    // =========================================================================
    console.log('\n🧹 Cleaning up...');

    await client.callTool({
      name: 'terminal_kill',
      arguments: { id: terminalId },
    });

    console.log('\n' + '═'.repeat(60));
    console.log('✅ TUI Testing Example Complete!');
    console.log('═'.repeat(60));

  } catch (error) {
    console.error('❌ Error:', error.message);
  }

  await client.close();
}

main().catch(console.error);
