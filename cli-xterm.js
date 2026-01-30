#!/usr/bin/env node
/**
 * Playwright MCP with tmux-based terminal support for TUI testing
 *
 * Uses tmux for robust terminal session management, enabling:
 * - Session persistence and detach/reattach
 * - Built-in screen capture (capture-pane)
 * - Text dump and reload
 * - Window/pane management
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { spawn, execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ============================================================================
// Tmux Terminal Manager
// ============================================================================

class TmuxManager {
  constructor() {
    this.sessions = new Map();
    this.recordings = new Map();  // sessionId -> { frames: [], interval, timer }
    this.sessionPrefix = `mcp_term_${process.pid}`;
    this.nextId = 1;
    this.tmpDir = path.join(os.tmpdir(), 'playwright-mcp-terminals');

    // Ensure tmp directory exists
    if (!fs.existsSync(this.tmpDir)) {
      fs.mkdirSync(this.tmpDir, { recursive: true });
    }

    // Check tmux availability
    try {
      execSync('which tmux', { stdio: 'pipe' });
    } catch {
      console.error('Warning: tmux not found. Terminal tools will not work.');
    }
  }

  /**
   * Create a new tmux session running the specified command
   */
  spawn(command, args = [], options = {}) {
    const id = `${this.sessionPrefix}_${this.nextId++}`;
    const cols = options.cols ?? 80;
    const rows = options.rows ?? 24;
    const cwd = options.cwd ?? process.cwd();

    const fullCommand = args.length > 0 ? `${command} ${args.join(' ')}` : command;

    // Create new tmux session
    const tmuxArgs = [
      'new-session',
      '-d',                    // Detached
      '-s', id,                // Session name
      '-x', cols.toString(),   // Width
      '-y', rows.toString(),   // Height
      fullCommand,
    ];

    const result = spawnSync('tmux', tmuxArgs, {
      cwd,
      env: { ...process.env, ...options.env },
      stdio: 'pipe',
    });

    if (result.status !== 0) {
      throw new Error(`Failed to create tmux session: ${result.stderr?.toString() || 'unknown error'}`);
    }

    this.sessions.set(id, { id, cols, rows, command: fullCommand, cwd });
    return id;
  }

  /**
   * Send keys/text to a tmux session
   */
  sendKeys(id, keys) {
    if (!this.sessions.has(id)) throw new Error(`Session ${id} not found`);

    const result = spawnSync('tmux', ['send-keys', '-t', id, keys], { stdio: 'pipe' });
    if (result.status !== 0) {
      throw new Error(`Failed to send keys: ${result.stderr?.toString()}`);
    }
  }

  /**
   * Send literal text (not interpreted as key names)
   */
  sendText(id, text) {
    if (!this.sessions.has(id)) throw new Error(`Session ${id} not found`);

    const result = spawnSync('tmux', ['send-keys', '-t', id, '-l', text], { stdio: 'pipe' });
    if (result.status !== 0) {
      throw new Error(`Failed to send text: ${result.stderr?.toString()}`);
    }
  }

  /**
   * Capture the current pane content (plain text, no ANSI)
   */
  capturePane(id, options = {}) {
    if (!this.sessions.has(id)) throw new Error(`Session ${id} not found`);

    const args = ['capture-pane', '-t', id, '-p'];

    // Include history?
    if (options.history) {
      args.push('-S', '-');  // Start from beginning of history
    }

    // Escape sequences?
    if (options.ansi) {
      args.push('-e');  // Include escape sequences
    }

    const result = spawnSync('tmux', args, { stdio: 'pipe', maxBuffer: 10 * 1024 * 1024 });
    if (result.status !== 0) {
      throw new Error(`Failed to capture pane: ${result.stderr?.toString()}`);
    }

    return result.stdout.toString();
  }

  /**
   * Save pane content to a file
   */
  savePaneToFile(id, filePath, options = {}) {
    const content = this.capturePane(id, options);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  /**
   * Resize a tmux session
   */
  resize(id, cols, rows) {
    if (!this.sessions.has(id)) throw new Error(`Session ${id} not found`);

    const result = spawnSync('tmux', [
      'resize-window', '-t', id, '-x', cols.toString(), '-y', rows.toString()
    ], { stdio: 'pipe' });

    if (result.status !== 0) {
      throw new Error(`Failed to resize: ${result.stderr?.toString()}`);
    }

    const session = this.sessions.get(id);
    session.cols = cols;
    session.rows = rows;
  }

  /**
   * Kill a tmux session
   */
  kill(id) {
    if (!this.sessions.has(id)) throw new Error(`Session ${id} not found`);

    spawnSync('tmux', ['kill-session', '-t', id], { stdio: 'pipe' });
    this.sessions.delete(id);
  }

  /**
   * List all managed sessions
   */
  list() {
    // Also verify sessions still exist in tmux
    const result = spawnSync('tmux', ['list-sessions', '-F', '#{session_name}'], { stdio: 'pipe' });
    const activeSessions = result.status === 0
      ? result.stdout.toString().trim().split('\n').filter(Boolean)
      : [];

    // Clean up any sessions that no longer exist
    for (const [id] of this.sessions) {
      if (!activeSessions.includes(id)) {
        this.sessions.delete(id);
      }
    }

    return Array.from(this.sessions.values());
  }

  /**
   * Check if a session exists
   */
  has(id) {
    return this.sessions.has(id);
  }

  /**
   * Get session info
   */
  get(id) {
    return this.sessions.get(id);
  }

  /**
   * Clean up all sessions
   */
  dispose() {
    for (const [id] of this.sessions) {
      try {
        spawnSync('tmux', ['kill-session', '-t', id], { stdio: 'pipe' });
      } catch {}
    }
    this.sessions.clear();
  }

  // ===========================================================================
  // Session Attachment
  // ===========================================================================

  /**
   * List all tmux sessions (including external ones)
   */
  listAllSessions() {
    const result = spawnSync('tmux', [
      'list-sessions',
      '-F', '#{session_name}:#{session_width}:#{session_height}:#{session_windows}'
    ], { stdio: 'pipe' });

    if (result.status !== 0) {
      return [];
    }

    return result.stdout.toString().trim().split('\n').filter(Boolean).map(line => {
      const [name, width, height, windows] = line.split(':');
      return {
        name,
        cols: parseInt(width, 10),
        rows: parseInt(height, 10),
        windows: parseInt(windows, 10),
        managed: this.sessions.has(name),
      };
    });
  }

  /**
   * Attach to an existing tmux session (not created by this MCP)
   */
  attach(sessionName) {
    // Verify session exists
    const result = spawnSync('tmux', ['has-session', '-t', sessionName], { stdio: 'pipe' });
    if (result.status !== 0) {
      throw new Error(`Session ${sessionName} does not exist`);
    }

    // Get session info
    const infoResult = spawnSync('tmux', [
      'display-message', '-t', sessionName, '-p',
      '#{session_width}:#{session_height}'
    ], { stdio: 'pipe' });

    const [cols, rows] = infoResult.stdout.toString().trim().split(':').map(n => parseInt(n, 10));

    this.sessions.set(sessionName, {
      id: sessionName,
      cols: cols || 80,
      rows: rows || 24,
      command: '(attached)',
      cwd: process.cwd(),
      external: true,
    });

    return sessionName;
  }

  /**
   * Detach from a session (remove from managed list, but don't kill it)
   */
  detach(id) {
    if (!this.sessions.has(id)) throw new Error(`Session ${id} not found`);
    this.sessions.delete(id);
  }

  // ===========================================================================
  // Window/Pane Management
  // ===========================================================================

  /**
   * Split the current pane
   */
  splitPane(id, options = {}) {
    if (!this.sessions.has(id)) throw new Error(`Session ${id} not found`);

    const args = ['split-window', '-t', id];

    if (options.horizontal) {
      args.push('-h');  // Horizontal split (side by side)
    } else {
      args.push('-v');  // Vertical split (stacked)
    }

    if (options.percent) {
      args.push('-p', options.percent.toString());
    }

    if (options.command) {
      args.push(options.command);
    }

    const result = spawnSync('tmux', args, { stdio: 'pipe' });
    if (result.status !== 0) {
      throw new Error(`Failed to split pane: ${result.stderr?.toString()}`);
    }

    // Get the new pane ID
    const paneResult = spawnSync('tmux', [
      'display-message', '-t', id, '-p', '#{pane_id}'
    ], { stdio: 'pipe' });

    return paneResult.stdout.toString().trim();
  }

  /**
   * Select a specific pane
   */
  selectPane(id, paneIndex) {
    if (!this.sessions.has(id)) throw new Error(`Session ${id} not found`);

    const target = paneIndex !== undefined ? `${id}.${paneIndex}` : id;
    const result = spawnSync('tmux', ['select-pane', '-t', target], { stdio: 'pipe' });

    if (result.status !== 0) {
      throw new Error(`Failed to select pane: ${result.stderr?.toString()}`);
    }
  }

  /**
   * List panes in a session
   */
  listPanes(id) {
    if (!this.sessions.has(id)) throw new Error(`Session ${id} not found`);

    const result = spawnSync('tmux', [
      'list-panes', '-t', id,
      '-F', '#{pane_index}:#{pane_width}:#{pane_height}:#{pane_active}:#{pane_current_command}'
    ], { stdio: 'pipe' });

    if (result.status !== 0) {
      throw new Error(`Failed to list panes: ${result.stderr?.toString()}`);
    }

    return result.stdout.toString().trim().split('\n').filter(Boolean).map(line => {
      const [index, width, height, active, command] = line.split(':');
      return {
        index: parseInt(index, 10),
        cols: parseInt(width, 10),
        rows: parseInt(height, 10),
        active: active === '1',
        command,
      };
    });
  }

  /**
   * Create a new window in a session
   */
  newWindow(id, options = {}) {
    if (!this.sessions.has(id)) throw new Error(`Session ${id} not found`);

    const args = ['new-window', '-t', id];

    if (options.name) {
      args.push('-n', options.name);
    }

    if (options.command) {
      args.push(options.command);
    }

    const result = spawnSync('tmux', args, { stdio: 'pipe' });
    if (result.status !== 0) {
      throw new Error(`Failed to create window: ${result.stderr?.toString()}`);
    }

    // Get window index
    const winResult = spawnSync('tmux', [
      'display-message', '-t', id, '-p', '#{window_index}'
    ], { stdio: 'pipe' });

    return parseInt(winResult.stdout.toString().trim(), 10);
  }

  /**
   * Select a window by index
   */
  selectWindow(id, windowIndex) {
    if (!this.sessions.has(id)) throw new Error(`Session ${id} not found`);

    const result = spawnSync('tmux', [
      'select-window', '-t', `${id}:${windowIndex}`
    ], { stdio: 'pipe' });

    if (result.status !== 0) {
      throw new Error(`Failed to select window: ${result.stderr?.toString()}`);
    }
  }

  /**
   * List windows in a session
   */
  listWindows(id) {
    if (!this.sessions.has(id)) throw new Error(`Session ${id} not found`);

    const result = spawnSync('tmux', [
      'list-windows', '-t', id,
      '-F', '#{window_index}:#{window_name}:#{window_active}:#{window_panes}'
    ], { stdio: 'pipe' });

    if (result.status !== 0) {
      throw new Error(`Failed to list windows: ${result.stderr?.toString()}`);
    }

    return result.stdout.toString().trim().split('\n').filter(Boolean).map(line => {
      const [index, name, active, panes] = line.split(':');
      return {
        index: parseInt(index, 10),
        name,
        active: active === '1',
        panes: parseInt(panes, 10),
      };
    });
  }

  /**
   * Send keys to a specific pane
   */
  sendKeysToPane(id, paneIndex, keys) {
    if (!this.sessions.has(id)) throw new Error(`Session ${id} not found`);

    const target = `${id}.${paneIndex}`;
    const result = spawnSync('tmux', ['send-keys', '-t', target, keys], { stdio: 'pipe' });

    if (result.status !== 0) {
      throw new Error(`Failed to send keys to pane: ${result.stderr?.toString()}`);
    }
  }

  /**
   * Capture a specific pane
   */
  capturePaneByIndex(id, paneIndex, options = {}) {
    if (!this.sessions.has(id)) throw new Error(`Session ${id} not found`);

    const target = `${id}.${paneIndex}`;
    const args = ['capture-pane', '-t', target, '-p'];

    if (options.history) {
      args.push('-S', '-');
    }
    if (options.ansi) {
      args.push('-e');
    }

    const result = spawnSync('tmux', args, { stdio: 'pipe', maxBuffer: 10 * 1024 * 1024 });
    if (result.status !== 0) {
      throw new Error(`Failed to capture pane: ${result.stderr?.toString()}`);
    }

    return result.stdout.toString();
  }

  // ===========================================================================
  // Recording & Dump/Rehydrate
  // ===========================================================================

  /**
   * Start recording session frames
   */
  startRecording(id, intervalMs = 100) {
    if (!this.sessions.has(id)) throw new Error(`Session ${id} not found`);

    // Stop any existing recording
    this.stopRecording(id);

    const recording = {
      frames: [],
      startTime: Date.now(),
      interval: intervalMs,
      timer: null,
    };

    // Capture frames at interval
    recording.timer = setInterval(() => {
      try {
        const screen = this.capturePane(id, { ansi: true });
        recording.frames.push({
          timestamp: Date.now() - recording.startTime,
          content: screen,
        });
      } catch (e) {
        // Session might be gone
        this.stopRecording(id);
      }
    }, intervalMs);

    this.recordings.set(id, recording);
  }

  /**
   * Stop recording and return frames
   */
  stopRecording(id) {
    const recording = this.recordings.get(id);
    if (!recording) return null;

    if (recording.timer) {
      clearInterval(recording.timer);
      recording.timer = null;
    }

    this.recordings.delete(id);
    return {
      duration: Date.now() - recording.startTime,
      frameCount: recording.frames.length,
      interval: recording.interval,
      frames: recording.frames,
    };
  }

  /**
   * Check if recording is active
   */
  isRecording(id) {
    return this.recordings.has(id);
  }

  /**
   * Get recording data without stopping
   */
  getRecording(id) {
    const recording = this.recordings.get(id);
    if (!recording) return null;

    return {
      duration: Date.now() - recording.startTime,
      frameCount: recording.frames.length,
      interval: recording.interval,
      frames: [...recording.frames],
    };
  }

  /**
   * Create a complete state dump
   */
  createDump(id, includeHistory = true) {
    if (!this.sessions.has(id)) throw new Error(`Session ${id} not found`);

    const session = this.sessions.get(id);
    const screen = this.capturePane(id, { ansi: false });
    const screenAnsi = this.capturePane(id, { ansi: true });
    const history = includeHistory ? this.capturePane(id, { history: true, ansi: false }) : null;

    return {
      version: 1,
      timestamp: new Date().toISOString(),
      session: {
        id: session.id,
        cols: session.cols,
        rows: session.rows,
        command: session.command,
      },
      screen: {
        plain: screen,
        ansi: screenAnsi,
      },
      history: history,
    };
  }

  /**
   * Compare current state to a dump
   */
  compareToDump(id, dump, ignoreWhitespace = false) {
    const current = this.createDump(id, false);

    const normalize = (str) => {
      if (ignoreWhitespace) {
        return str.split('\n').map(line => line.trimEnd()).join('\n').trim();
      }
      return str;
    };

    const currentScreen = normalize(current.screen.plain);
    const expectedScreen = normalize(dump.screen.plain);

    if (currentScreen === expectedScreen) {
      return { match: true, diff: null };
    }

    // Simple line-by-line diff
    const currentLines = currentScreen.split('\n');
    const expectedLines = expectedScreen.split('\n');
    const diffs = [];

    const maxLines = Math.max(currentLines.length, expectedLines.length);
    for (let i = 0; i < maxLines; i++) {
      const current = currentLines[i] || '';
      const expected = expectedLines[i] || '';
      if (current !== expected) {
        diffs.push({
          line: i + 1,
          expected: expected,
          actual: current,
        });
      }
    }

    return { match: false, diff: diffs };
  }
}

const tmux = new TmuxManager();

// ============================================================================
// Terminal Tools Definition
// ============================================================================

function applyTerminalToolAnnotations(tools) {
  const titleOverrides = {
    spawn: 'Spawn terminal',
    send_keys: 'Send keys',
    send_text: 'Send text',
    snapshot: 'Snapshot terminal',
    save: 'Save terminal',
    resize: 'Resize terminal',
    kill: 'Kill terminal',
    wait: 'Wait for output',
    wait_idle: 'Wait for idle',
    wait_prompt: 'Wait for prompt',
    list: 'List sessions',
    list_all: 'List tmux sessions',
    attach: 'Attach to session',
    detach: 'Detach from session',
    split: 'Split pane',
    list_panes: 'List panes',
    select_pane: 'Select pane',
    dump: 'Dump state',
    compare: 'Compare to dump',
    assert: 'Assert content',
    record_start: 'Start recording',
    record_stop: 'Stop recording',
    record_save: 'Save recording',
    send_to_pane: 'Send keys to pane',
    capture_pane: 'Capture pane',
    new_window: 'Create window',
    list_windows: 'List windows',
    select_window: 'Select window',
  };

  const readOnlyTools = new Set([
    'terminal_snapshot',
    'terminal_list',
    'terminal_wait',
    'terminal_wait_idle',
    'terminal_wait_prompt',
    'terminal_list_all',
    'terminal_list_panes',
    'terminal_capture_pane',
    'terminal_list_windows',
    'terminal_compare',
    'terminal_assert',
  ]);

  const nonDestructiveTools = new Set([
    'terminal_attach',
    'terminal_detach',
    'terminal_select_pane',
    'terminal_select_window',
    'terminal_record_start',
    'terminal_record_stop',
  ]);

  const toSentenceCase = (snake) => {
    const words = snake.split('_').filter(Boolean);
    if (!words.length) return snake;
    return [words[0][0].toUpperCase() + words[0].slice(1), ...words.slice(1)].join(' ');
  };

  for (const tool of tools) {
    const key = tool.name.replace(/^terminal_/, '');
    const readOnlyHint = readOnlyTools.has(tool.name);
    const destructiveHint = !readOnlyHint && !nonDestructiveTools.has(tool.name);
    const title = titleOverrides[key] ?? toSentenceCase(key);

    tool.annotations = {
      title,
      readOnlyHint: readOnlyHint || undefined,
      destructiveHint: destructiveHint || undefined,
      idempotentHint: readOnlyHint || undefined,
      openWorldHint: true,
    };
  }
}

const terminalTools = [
  {
    name: 'terminal_spawn',
    description: 'TUI testing: Launch a new terminal session. Use this to start CLI apps, TUI programs (vim, htop, btop, nano), interactive shells, or any terminal-based application for testing. Returns a session ID used by all other terminal_* tools.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to run (e.g., "bash", "btop", "vim file.txt")' },
        args: { type: 'array', items: { type: 'string' }, description: 'Command arguments' },
        cols: { type: 'number', description: 'Terminal width (default: 80)' },
        rows: { type: 'number', description: 'Terminal height (default: 24)' },
        cwd: { type: 'string', description: 'Working directory' },
        env: { type: 'object', description: 'Additional environment variables' },
      },
      required: ['command'],
    },
  },
  {
    name: 'terminal_send_keys',
    description: 'TUI testing: Send keyboard input (special keys) to a terminal session. Use key names like "Enter", "Escape", "C-c" (Ctrl+C), "Up", "Down", "Tab", "Space", "BSpace", "C-d", "C-z", etc. For literal text, use terminal_send_text instead.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session ID from terminal_spawn' },
        keys: { type: 'string', description: 'Key sequence (e.g., "Enter", "C-c", "Escape", "Up Up Enter")' },
      },
      required: ['id', 'keys'],
    },
  },
  {
    name: 'terminal_send_text',
    description: 'TUI testing: Type literal text into a terminal session. The text is sent as-is without interpreting key names. Use this for typing commands, search queries, or any text input. For special keys like Enter or Ctrl+C, use terminal_send_keys instead.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session ID from terminal_spawn' },
        text: { type: 'string', description: 'Literal text to type' },
      },
      required: ['id', 'text'],
    },
  },
  {
    name: 'terminal_snapshot',
    description: 'TUI testing: Capture the current terminal screen as plain text. Returns exactly what a user would see on the terminal display. Essential for verifying TUI state, reading command output, or checking what a CLI app is showing.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session ID from terminal_spawn' },
        history: { type: 'boolean', description: 'Include scrollback history (default: false)' },
        ansi: { type: 'boolean', description: 'Include ANSI escape sequences (default: false)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'terminal_save',
    description: 'TUI testing: Save terminal screen content to a file. Useful for capturing TUI state as test artifacts, saving command output, or creating reference snapshots for later comparison.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session ID' },
        path: { type: 'string', description: 'File path to save to' },
        history: { type: 'boolean', description: 'Include scrollback history' },
        ansi: { type: 'boolean', description: 'Include ANSI escape sequences' },
      },
      required: ['id', 'path'],
    },
  },
  {
    name: 'terminal_resize',
    description: 'TUI testing: Resize a terminal session to test responsive TUI layouts or simulate different terminal sizes.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session ID' },
        cols: { type: 'number', description: 'New width in columns' },
        rows: { type: 'number', description: 'New height in rows' },
      },
      required: ['id', 'cols', 'rows'],
    },
  },
  {
    name: 'terminal_kill',
    description: 'TUI testing: End a terminal session and clean up resources.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'terminal_list',
    description: 'TUI testing: List all active terminal sessions managed by this server.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'terminal_wait',
    description: 'TUI testing: Wait for specific text or regex pattern to appear in terminal output. Use this to synchronize with command completion, wait for TUI elements to render, or confirm expected output before proceeding.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session ID' },
        pattern: { type: 'string', description: 'Text or regex pattern to wait for' },
        timeout: { type: 'number', description: 'Max wait time in ms (default: 5000)' },
      },
      required: ['id', 'pattern'],
    },
  },

  // ===========================================================================
  // Session Attachment Tools
  // ===========================================================================
  {
    name: 'terminal_list_all',
    description: 'TUI testing: List all terminal sessions on the system, including ones not created by this server. Shows which sessions are managed vs external.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'terminal_attach',
    description: 'TUI testing: Attach to an existing external terminal session. Lets you control and monitor terminal sessions that were started outside this server.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the tmux session to attach to' },
      },
      required: ['name'],
    },
  },
  {
    name: 'terminal_detach',
    description: 'TUI testing: Detach from a session without killing it. The terminal process continues running in the background.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session ID to detach from' },
      },
      required: ['id'],
    },
  },

  // ===========================================================================
  // Window/Pane Management Tools
  // ===========================================================================
  {
    name: 'terminal_split',
    description: 'TUI testing: Split the terminal into multiple panes. Creates side-by-side (horizontal) or stacked (vertical) layouts for running multiple processes in one session.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session ID' },
        horizontal: { type: 'boolean', description: 'If true, split side-by-side. If false (default), split stacked.' },
        percent: { type: 'number', description: 'Size of new pane as percentage (default: 50)' },
        command: { type: 'string', description: 'Command to run in new pane (default: shell)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'terminal_list_panes',
    description: 'TUI testing: List all panes in a terminal session with their indices, sizes, and running commands.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'terminal_select_pane',
    description: 'TUI testing: Switch focus to a specific pane by index.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session ID' },
        pane: { type: 'number', description: 'Pane index (from terminal_list_panes)' },
      },
      required: ['id', 'pane'],
    },
  },
  {
    name: 'terminal_send_to_pane',
    description: 'TUI testing: Send keyboard input to a specific pane without switching focus. Useful for controlling background processes in split layouts.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session ID' },
        pane: { type: 'number', description: 'Pane index' },
        keys: { type: 'string', description: 'Keys to send' },
      },
      required: ['id', 'pane', 'keys'],
    },
  },
  {
    name: 'terminal_capture_pane',
    description: 'TUI testing: Read screen content from a specific pane. Like terminal_snapshot but targets a particular pane in a split layout.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session ID' },
        pane: { type: 'number', description: 'Pane index' },
        history: { type: 'boolean', description: 'Include scrollback history' },
        ansi: { type: 'boolean', description: 'Include ANSI codes' },
      },
      required: ['id', 'pane'],
    },
  },
  {
    name: 'terminal_new_window',
    description: 'TUI testing: Create a new window (tab) in a terminal session. Each window is a separate full-screen terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session ID' },
        name: { type: 'string', description: 'Window name' },
        command: { type: 'string', description: 'Command to run (default: shell)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'terminal_list_windows',
    description: 'TUI testing: List all windows (tabs) in a terminal session.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'terminal_select_window',
    description: 'TUI testing: Switch to a specific window (tab) by index.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session ID' },
        window: { type: 'number', description: 'Window index' },
      },
      required: ['id', 'window'],
    },
  },

  // ===========================================================================
  // Sync Primitives
  // ===========================================================================
  {
    name: 'terminal_wait_idle',
    description: 'TUI testing: Wait until terminal output stops changing. Useful for waiting for a command to finish or a TUI to finish rendering before taking a snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session ID' },
        idle_ms: { type: 'number', description: 'How long output must be stable (default: 500ms)' },
        timeout: { type: 'number', description: 'Max total wait time (default: 10000ms)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'terminal_wait_prompt',
    description: 'TUI testing: Wait for a shell prompt to appear (e.g., "$", "#", ">"). Use after running a command to know when the shell is ready for the next input.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session ID' },
        prompt_pattern: { type: 'string', description: 'Regex for prompt (default: "\\\\$\\\\s*$|#\\\\s*$|>\\\\s*$")' },
        timeout: { type: 'number', description: 'Max wait time (default: 5000ms)' },
      },
      required: ['id'],
    },
  },

  // ===========================================================================
  // Recording & Playback
  // ===========================================================================
  {
    name: 'terminal_record_start',
    description: 'TUI testing: Start recording a terminal session. Captures periodic screen snapshots for later playback, debugging, or test evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session ID' },
        interval_ms: { type: 'number', description: 'Capture interval in ms (default: 100)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'terminal_record_stop',
    description: 'TUI testing: Stop recording a terminal session and return the captured frames.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'terminal_record_save',
    description: 'TUI testing: Save a terminal recording to a JSON file with frames and timing data.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session ID' },
        path: { type: 'string', description: 'File path to save recording' },
      },
      required: ['id', 'path'],
    },
  },
  {
    name: 'terminal_dump',
    description: 'TUI testing: Export complete terminal state as JSON (screen content, scrollback history, dimensions). Creates a baseline snapshot for use with terminal_compare.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session ID' },
        path: { type: 'string', description: 'File path to save dump (optional - returns JSON if not specified)' },
        include_history: { type: 'boolean', description: 'Include scrollback history (default: true)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'terminal_compare',
    description: 'TUI testing: Compare current terminal state against a saved baseline dump. Returns a diff of differences. Use with terminal_dump for snapshot testing of TUI apps.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session ID' },
        expected_path: { type: 'string', description: 'Path to expected state dump' },
        ignore_whitespace: { type: 'boolean', description: 'Ignore trailing whitespace differences' },
      },
      required: ['id', 'expected_path'],
    },
  },
  {
    name: 'terminal_assert',
    description: 'TUI testing: Assert that the terminal screen contains (or does not contain) expected text. Supports exact text matching, regex patterns, and line-specific checks. Use for validating TUI output in tests.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session ID' },
        contains: { type: 'string', description: 'Text that must be present' },
        not_contains: { type: 'string', description: 'Text that must NOT be present' },
        matches: { type: 'string', description: 'Regex pattern that must match' },
        line: { type: 'number', description: 'Specific line number to check (1-indexed)' },
      },
      required: ['id'],
    },
  },
];

applyTerminalToolAnnotations(terminalTools);

// ============================================================================
// Tool Execution
// ============================================================================

async function executeTerminalTool(name, args) {
  switch (name) {
    case 'terminal_spawn': {
      const { command, args: cmdArgs = [], cols = 80, rows = 24, cwd, env } = args;
      const id = tmux.spawn(command, cmdArgs, { cols, rows, cwd, env });
      await new Promise(r => setTimeout(r, 200)); // Let process start

      return {
        content: [{
          type: 'text',
          text: `Terminal spawned (tmux session).\n\nID: ${id}\nCommand: ${command} ${cmdArgs.join(' ')}\nSize: ${cols}x${rows}\n\nUse terminal_send_text to type commands, terminal_send_keys for special keys like "Enter".`,
        }],
      };
    }

    case 'terminal_send_keys': {
      const { id, keys } = args;
      tmux.sendKeys(id, keys);
      await new Promise(r => setTimeout(r, 50));

      return {
        content: [{
          type: 'text',
          text: `Keys sent to ${id}: ${keys}`,
        }],
      };
    }

    case 'terminal_send_text': {
      const { id, text } = args;
      tmux.sendText(id, text);
      await new Promise(r => setTimeout(r, 50));

      return {
        content: [{
          type: 'text',
          text: `Text sent to ${id}: ${JSON.stringify(text)}`,
        }],
      };
    }

    case 'terminal_snapshot': {
      const { id, history = false, ansi = false } = args;
      const content = tmux.capturePane(id, { history, ansi });
      const session = tmux.get(id);

      return {
        content: [{
          type: 'text',
          text: `Terminal ${id} (${session.cols}x${session.rows}):\n\n\`\`\`\n${content}\`\`\``,
        }],
      };
    }

    case 'terminal_save': {
      const { id, path: filePath, history = false, ansi = false } = args;
      const savedPath = tmux.savePaneToFile(id, filePath, { history, ansi });

      return {
        content: [{
          type: 'text',
          text: `Terminal content saved to: ${savedPath}`,
        }],
      };
    }

    case 'terminal_resize': {
      const { id, cols, rows } = args;
      tmux.resize(id, cols, rows);

      return {
        content: [{
          type: 'text',
          text: `Terminal ${id} resized to ${cols}x${rows}`,
        }],
      };
    }

    case 'terminal_kill': {
      const { id } = args;
      tmux.kill(id);

      return {
        content: [{
          type: 'text',
          text: `Terminal ${id} killed`,
        }],
      };
    }

    case 'terminal_list': {
      const sessions = tmux.list();
      const text = sessions.length === 0
        ? 'No active terminal sessions'
        : `Active terminal sessions:\n${sessions.map(s =>
            `- ${s.id} (${s.cols}x${s.rows}) - ${s.command}`
          ).join('\n')}`;

      return { content: [{ type: 'text', text }] };
    }

    case 'terminal_wait': {
      const { id, pattern, timeout = 5000 } = args;
      const regex = new RegExp(pattern);
      const start = Date.now();

      while (Date.now() - start < timeout) {
        const content = tmux.capturePane(id, { history: true });
        if (regex.test(content)) {
          const screen = tmux.capturePane(id);
          return {
            content: [{
              type: 'text',
              text: `Pattern "${pattern}" found in terminal ${id}\n\n\`\`\`\n${screen}\`\`\``,
            }],
          };
        }
        await new Promise(r => setTimeout(r, 100));
      }

      const screen = tmux.capturePane(id);
      return {
        content: [{
          type: 'text',
          text: `Timeout after ${timeout}ms waiting for "${pattern}" in terminal ${id}\n\nCurrent screen:\n\`\`\`\n${screen}\`\`\``,
        }],
        isError: true,
      };
    }

    // =========================================================================
    // Session Attachment
    // =========================================================================

    case 'terminal_list_all': {
      const sessions = tmux.listAllSessions();
      if (sessions.length === 0) {
        return { content: [{ type: 'text', text: 'No tmux sessions found on system' }] };
      }

      const text = `All tmux sessions:\n${sessions.map(s =>
        `- ${s.name} (${s.cols}x${s.rows}, ${s.windows} window${s.windows !== 1 ? 's' : ''})${s.managed ? ' [managed]' : ''}`
      ).join('\n')}`;

      return { content: [{ type: 'text', text }] };
    }

    case 'terminal_attach': {
      const { name } = args;
      tmux.attach(name);

      return {
        content: [{
          type: 'text',
          text: `Attached to external session: ${name}\n\nYou can now use terminal_* tools with this session ID.`,
        }],
      };
    }

    case 'terminal_detach': {
      const { id } = args;
      const session = tmux.get(id);
      tmux.detach(id);

      return {
        content: [{
          type: 'text',
          text: `Detached from session: ${id}\n\nSession continues running but is no longer managed by this MCP.`,
        }],
      };
    }

    // =========================================================================
    // Window/Pane Management
    // =========================================================================

    case 'terminal_split': {
      const { id, horizontal = false, percent, command } = args;
      const paneId = tmux.splitPane(id, { horizontal, percent, command });
      await new Promise(r => setTimeout(r, 100));

      const panes = tmux.listPanes(id);
      return {
        content: [{
          type: 'text',
          text: `Pane split ${horizontal ? 'horizontally' : 'vertically'}.\n\nCurrent panes:\n${panes.map(p =>
            `  [${p.index}] ${p.cols}x${p.rows} ${p.active ? '(active)' : ''} - ${p.command}`
          ).join('\n')}`,
        }],
      };
    }

    case 'terminal_list_panes': {
      const { id } = args;
      const panes = tmux.listPanes(id);

      return {
        content: [{
          type: 'text',
          text: `Panes in ${id}:\n${panes.map(p =>
            `  [${p.index}] ${p.cols}x${p.rows} ${p.active ? '(active)' : ''} - ${p.command}`
          ).join('\n')}`,
        }],
      };
    }

    case 'terminal_select_pane': {
      const { id, pane } = args;
      tmux.selectPane(id, pane);

      return {
        content: [{
          type: 'text',
          text: `Selected pane ${pane} in ${id}`,
        }],
      };
    }

    case 'terminal_send_to_pane': {
      const { id, pane, keys } = args;
      tmux.sendKeysToPane(id, pane, keys);
      await new Promise(r => setTimeout(r, 50));

      return {
        content: [{
          type: 'text',
          text: `Keys sent to pane ${pane} in ${id}: ${keys}`,
        }],
      };
    }

    case 'terminal_capture_pane': {
      const { id, pane, history = false, ansi = false } = args;
      const content = tmux.capturePaneByIndex(id, pane, { history, ansi });
      const panes = tmux.listPanes(id);
      const paneInfo = panes.find(p => p.index === pane);

      return {
        content: [{
          type: 'text',
          text: `Pane ${pane} in ${id} (${paneInfo?.cols}x${paneInfo?.rows}):\n\n\`\`\`\n${content}\`\`\``,
        }],
      };
    }

    case 'terminal_new_window': {
      const { id, name, command } = args;
      const windowIndex = tmux.newWindow(id, { name, command });
      await new Promise(r => setTimeout(r, 100));

      return {
        content: [{
          type: 'text',
          text: `New window created: index ${windowIndex}${name ? ` (${name})` : ''}`,
        }],
      };
    }

    case 'terminal_list_windows': {
      const { id } = args;
      const windows = tmux.listWindows(id);

      return {
        content: [{
          type: 'text',
          text: `Windows in ${id}:\n${windows.map(w =>
            `  [${w.index}] ${w.name} ${w.active ? '(active)' : ''} - ${w.panes} pane${w.panes !== 1 ? 's' : ''}`
          ).join('\n')}`,
        }],
      };
    }

    case 'terminal_select_window': {
      const { id, window: windowIndex } = args;
      tmux.selectWindow(id, windowIndex);

      return {
        content: [{
          type: 'text',
          text: `Selected window ${windowIndex} in ${id}`,
        }],
      };
    }

    // =========================================================================
    // Sync Primitives
    // =========================================================================

    case 'terminal_wait_idle': {
      const { id, idle_ms = 500, timeout = 10000 } = args;
      const start = Date.now();
      let lastContent = '';
      let lastChangeTime = Date.now();

      while (Date.now() - start < timeout) {
        const content = tmux.capturePane(id);

        if (content !== lastContent) {
          lastContent = content;
          lastChangeTime = Date.now();
        } else if (Date.now() - lastChangeTime >= idle_ms) {
          // Idle for long enough
          return {
            content: [{
              type: 'text',
              text: `Terminal ${id} idle for ${idle_ms}ms\n\n\`\`\`\n${content}\`\`\``,
            }],
          };
        }

        await new Promise(r => setTimeout(r, 50));
      }

      const screen = tmux.capturePane(id);
      return {
        content: [{
          type: 'text',
          text: `Timeout after ${timeout}ms waiting for idle in ${id}\n\nCurrent screen:\n\`\`\`\n${screen}\`\`\``,
        }],
        isError: true,
      };
    }

    case 'terminal_wait_prompt': {
      const { id, prompt_pattern = '\\$\\s*$|#\\s*$|>\\s*$', timeout = 5000 } = args;
      const regex = new RegExp(prompt_pattern, 'm');
      const start = Date.now();

      while (Date.now() - start < timeout) {
        const content = tmux.capturePane(id);
        // Check last few lines for prompt
        const lines = content.trim().split('\n');
        const lastLines = lines.slice(-3).join('\n');

        if (regex.test(lastLines)) {
          return {
            content: [{
              type: 'text',
              text: `Prompt detected in ${id}\n\n\`\`\`\n${content}\`\`\``,
            }],
          };
        }
        await new Promise(r => setTimeout(r, 100));
      }

      const screen = tmux.capturePane(id);
      return {
        content: [{
          type: 'text',
          text: `Timeout after ${timeout}ms waiting for prompt in ${id}\n\nCurrent screen:\n\`\`\`\n${screen}\`\`\``,
        }],
        isError: true,
      };
    }

    // =========================================================================
    // Recording & Playback
    // =========================================================================

    case 'terminal_record_start': {
      const { id, interval_ms = 100 } = args;
      tmux.startRecording(id, interval_ms);

      return {
        content: [{
          type: 'text',
          text: `Recording started for ${id}\nCapture interval: ${interval_ms}ms\n\nUse terminal_record_stop to finish recording.`,
        }],
      };
    }

    case 'terminal_record_stop': {
      const { id } = args;
      const recording = tmux.stopRecording(id);

      if (!recording) {
        return {
          content: [{ type: 'text', text: `No active recording for ${id}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Recording stopped for ${id}\n\nDuration: ${recording.duration}ms\nFrames captured: ${recording.frameCount}\nInterval: ${recording.interval}ms`,
        }],
      };
    }

    case 'terminal_record_save': {
      const { id, path: filePath } = args;

      // Get recording data (might still be active)
      let recording = tmux.getRecording(id);
      if (!recording) {
        // Maybe it was just stopped, try to get last recording from recent stop
        return {
          content: [{
            type: 'text',
            text: `No recording data for ${id}. Start recording with terminal_record_start first.`,
          }],
          isError: true,
        };
      }

      // Stop recording if still active
      if (tmux.isRecording(id)) {
        recording = tmux.stopRecording(id);
      }

      // Save to file
      const data = {
        version: 1,
        sessionId: id,
        timestamp: new Date().toISOString(),
        duration: recording.duration,
        interval: recording.interval,
        frameCount: recording.frameCount,
        frames: recording.frames,
      };

      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

      return {
        content: [{
          type: 'text',
          text: `Recording saved to: ${filePath}\n\nFrames: ${recording.frameCount}\nDuration: ${recording.duration}ms\nSize: ${(JSON.stringify(data).length / 1024).toFixed(1)} KB`,
        }],
      };
    }

    case 'terminal_dump': {
      const { id, path: filePath, include_history = true } = args;
      const dump = tmux.createDump(id, include_history);

      if (filePath) {
        fs.writeFileSync(filePath, JSON.stringify(dump, null, 2));
        return {
          content: [{
            type: 'text',
            text: `Terminal state dumped to: ${filePath}\n\nSession: ${dump.session.cols}x${dump.session.rows}\nHistory included: ${include_history}`,
          }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Terminal dump for ${id}:\n\n\`\`\`json\n${JSON.stringify(dump, null, 2)}\n\`\`\``,
        }],
      };
    }

    case 'terminal_compare': {
      const { id, expected_path, ignore_whitespace = false } = args;

      // Load expected dump
      const expectedData = JSON.parse(fs.readFileSync(expected_path, 'utf8'));
      const result = tmux.compareToDump(id, expectedData, ignore_whitespace);

      if (result.match) {
        return {
          content: [{
            type: 'text',
            text: `✅ Terminal state matches expected dump\n\nCompared against: ${expected_path}`,
          }],
        };
      }

      // Format diff
      const diffText = result.diff.slice(0, 10).map(d =>
        `Line ${d.line}:\n  Expected: ${JSON.stringify(d.expected)}\n  Actual:   ${JSON.stringify(d.actual)}`
      ).join('\n\n');

      const moreLines = result.diff.length > 10 ? `\n\n... and ${result.diff.length - 10} more differences` : '';

      return {
        content: [{
          type: 'text',
          text: `❌ Terminal state differs from expected\n\nDifferences:\n${diffText}${moreLines}`,
        }],
        isError: true,
      };
    }

    case 'terminal_assert': {
      const { id, contains, not_contains, matches, line } = args;
      const screen = tmux.capturePane(id);
      const lines = screen.split('\n');

      const errors = [];
      const checkContent = line ? (lines[line - 1] || '') : screen;

      if (contains && !checkContent.includes(contains)) {
        errors.push(`Expected to contain: "${contains}"`);
      }

      if (not_contains && checkContent.includes(not_contains)) {
        errors.push(`Expected NOT to contain: "${not_contains}"`);
      }

      if (matches) {
        const regex = new RegExp(matches);
        if (!regex.test(checkContent)) {
          errors.push(`Expected to match pattern: ${matches}`);
        }
      }

      if (errors.length > 0) {
        return {
          content: [{
            type: 'text',
            text: `❌ Assertion failed for ${id}${line ? ` (line ${line})` : ''}\n\n${errors.join('\n')}\n\nActual content:\n\`\`\`\n${checkContent}\`\`\``,
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: `✅ Assertion passed for ${id}${line ? ` (line ${line})` : ''}`,
        }],
      };
    }

    default:
      return {
        content: [{ type: 'text', text: `Unknown terminal tool: ${name}` }],
        isError: true,
      };
  }
}

// ============================================================================
// MCP Server Setup
// ============================================================================

async function main() {
  const server = new Server(
    { name: 'playwright-xterm', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions: `TUI testing and terminal automation server. This server enables testing of TUI (Text User Interface) applications, CLI tools, and interactive terminal programs like vim, htop, btop, nano, and custom TUI apps.

All tools are prefixed with terminal_* and support:
- Launching terminal sessions (terminal_spawn) and sending keyboard input (terminal_send_keys, terminal_send_text)
- Reading terminal screen output (terminal_snapshot) — captures exactly what a user sees
- Waiting for expected output (terminal_wait), idle state (terminal_wait_idle), or shell prompts (terminal_wait_prompt)
- TUI test assertions (terminal_assert) and snapshot comparison (terminal_compare with terminal_dump)
- Multi-pane split layouts and multi-window sessions for parallel terminal testing
- Session recording for debugging and test evidence (terminal_record_*)
- Attaching to external terminal sessions (terminal_attach)

Typical TUI testing workflow: terminal_spawn → terminal_send_keys/terminal_send_text → terminal_wait/terminal_wait_idle → terminal_snapshot → terminal_assert.`,
    }
  );

  // Handle tool listing
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: terminalTools };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (terminalTools.some(t => t.name === name)) {
      try {
        return await executeTerminalTool(name, args || {});
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    }

    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  });

  // Cleanup on exit
  process.on('SIGINT', () => {
    tmux.dispose();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    tmux.dispose();
    process.exit(0);
  });

  // Start server
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('Playwright xterm MCP server running');
}

main().catch(console.error);
