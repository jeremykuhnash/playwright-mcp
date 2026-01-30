#!/usr/bin/env node
/**
 * Unified Playwright MCP with Terminal Support
 *
 * Combines:
 * - All standard Playwright browser automation tools (browser_*)
 * - Terminal/TUI testing tools via tmux (terminal_*)
 *
 * Usage: node cli-unified.js [playwright args]
 * Example: node cli-unified.js --browser firefox --headless
 */

const { spawn, spawnSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

// ============================================================================
// Tmux Terminal Manager (from cli-xterm.js)
// ============================================================================

class TmuxManager {
  constructor() {
    this.sessions = new Map();
    this.recordings = new Map();
    this.sessionPrefix = `mcp_term_${process.pid}`;
    this.nextId = 1;
    this.tmpDir = path.join(os.tmpdir(), 'playwright-mcp-terminals');

    if (!fs.existsSync(this.tmpDir)) {
      fs.mkdirSync(this.tmpDir, { recursive: true });
    }

    try {
      execSync('which tmux', { stdio: 'pipe' });
    } catch {
      console.error('Warning: tmux not found. Terminal tools will not work.');
    }
  }

  spawn(command, args = [], options = {}) {
    const id = `${this.sessionPrefix}_${this.nextId++}`;
    const cols = options.cols ?? 80;
    const rows = options.rows ?? 24;
    const cwd = options.cwd ?? process.cwd();
    const fullCommand = args.length > 0 ? `${command} ${args.join(' ')}` : command;

    const result = spawnSync('tmux', [
      'new-session', '-d', '-s', id, '-x', cols.toString(), '-y', rows.toString(), fullCommand
    ], { cwd, env: { ...process.env, ...options.env }, stdio: 'pipe' });

    if (result.status !== 0) {
      throw new Error(`Failed to create tmux session: ${result.stderr?.toString() || 'unknown error'}`);
    }

    this.sessions.set(id, { id, cols, rows, command: fullCommand, cwd });
    return id;
  }

  sendKeys(id, keys) {
    if (!this.sessions.has(id)) throw new Error(`Session ${id} not found`);
    spawnSync('tmux', ['send-keys', '-t', id, keys], { stdio: 'pipe' });
  }

  sendText(id, text) {
    if (!this.sessions.has(id)) throw new Error(`Session ${id} not found`);
    spawnSync('tmux', ['send-keys', '-t', id, '-l', text], { stdio: 'pipe' });
  }

  capturePane(id, options = {}) {
    if (!this.sessions.has(id)) throw new Error(`Session ${id} not found`);
    const args = ['capture-pane', '-t', id, '-p'];
    if (options.history) args.push('-S', '-');
    if (options.ansi) args.push('-e');
    const result = spawnSync('tmux', args, { stdio: 'pipe', maxBuffer: 10 * 1024 * 1024 });
    return result.stdout.toString();
  }

  resize(id, cols, rows) {
    if (!this.sessions.has(id)) throw new Error(`Session ${id} not found`);
    spawnSync('tmux', ['resize-window', '-t', id, '-x', cols.toString(), '-y', rows.toString()], { stdio: 'pipe' });
    const session = this.sessions.get(id);
    session.cols = cols;
    session.rows = rows;
  }

  kill(id) {
    if (!this.sessions.has(id)) throw new Error(`Session ${id} not found`);
    spawnSync('tmux', ['kill-session', '-t', id], { stdio: 'pipe' });
    this.sessions.delete(id);
  }

  list() {
    const result = spawnSync('tmux', ['list-sessions', '-F', '#{session_name}'], { stdio: 'pipe' });
    const activeSessions = result.status === 0
      ? result.stdout.toString().trim().split('\n').filter(Boolean)
      : [];
    for (const [id] of this.sessions) {
      if (!activeSessions.includes(id)) this.sessions.delete(id);
    }
    return Array.from(this.sessions.values());
  }

  has(id) { return this.sessions.has(id); }
  get(id) { return this.sessions.get(id); }

  listAllSessions() {
    const result = spawnSync('tmux', ['list-sessions', '-F', '#{session_name}:#{session_width}:#{session_height}:#{session_windows}'], { stdio: 'pipe' });
    if (result.status !== 0) return [];
    return result.stdout.toString().trim().split('\n').filter(Boolean).map(line => {
      const [name, width, height, windows] = line.split(':');
      return { name, cols: parseInt(width), rows: parseInt(height), windows: parseInt(windows), managed: this.sessions.has(name) };
    });
  }

  attach(sessionName) {
    const result = spawnSync('tmux', ['has-session', '-t', sessionName], { stdio: 'pipe' });
    if (result.status !== 0) throw new Error(`Session ${sessionName} does not exist`);
    const infoResult = spawnSync('tmux', ['display-message', '-t', sessionName, '-p', '#{session_width}:#{session_height}'], { stdio: 'pipe' });
    const [cols, rows] = infoResult.stdout.toString().trim().split(':').map(n => parseInt(n, 10));
    this.sessions.set(sessionName, { id: sessionName, cols: cols || 80, rows: rows || 24, command: '(attached)', cwd: process.cwd(), external: true });
    return sessionName;
  }

  detach(id) {
    if (!this.sessions.has(id)) throw new Error(`Session ${id} not found`);
    this.sessions.delete(id);
  }

  splitPane(id, options = {}) {
    if (!this.sessions.has(id)) throw new Error(`Session ${id} not found`);
    const args = ['split-window', '-t', id];
    if (options.horizontal) args.push('-h');
    else args.push('-v');
    if (options.percent) args.push('-p', options.percent.toString());
    if (options.command) args.push(options.command);
    spawnSync('tmux', args, { stdio: 'pipe' });
  }

  listPanes(id) {
    if (!this.sessions.has(id)) throw new Error(`Session ${id} not found`);
    const result = spawnSync('tmux', ['list-panes', '-t', id, '-F', '#{pane_index}:#{pane_width}:#{pane_height}:#{pane_active}:#{pane_current_command}'], { stdio: 'pipe' });
    return result.stdout.toString().trim().split('\n').filter(Boolean).map(line => {
      const [index, width, height, active, command] = line.split(':');
      return { index: parseInt(index), cols: parseInt(width), rows: parseInt(height), active: active === '1', command };
    });
  }

  selectPane(id, paneIndex) {
    if (!this.sessions.has(id)) throw new Error(`Session ${id} not found`);
    spawnSync('tmux', ['select-pane', '-t', `${id}.${paneIndex}`], { stdio: 'pipe' });
  }

  sendKeysToPane(id, paneIndex, keys) {
    if (!this.sessions.has(id)) throw new Error(`Session ${id} not found`);
    spawnSync('tmux', ['send-keys', '-t', `${id}.${paneIndex}`, keys], { stdio: 'pipe' });
  }

  capturePaneByIndex(id, paneIndex, options = {}) {
    if (!this.sessions.has(id)) throw new Error(`Session ${id} not found`);
    const args = ['capture-pane', '-t', `${id}.${paneIndex}`, '-p'];
    if (options.history) args.push('-S', '-');
    if (options.ansi) args.push('-e');
    const result = spawnSync('tmux', args, { stdio: 'pipe', maxBuffer: 10 * 1024 * 1024 });
    return result.stdout.toString();
  }

  newWindow(id, options = {}) {
    if (!this.sessions.has(id)) throw new Error(`Session ${id} not found`);
    const args = ['new-window', '-t', id];
    if (options.name) args.push('-n', options.name);
    if (options.command) args.push(options.command);
    spawnSync('tmux', args, { stdio: 'pipe' });
    const result = spawnSync('tmux', ['display-message', '-t', id, '-p', '#{window_index}'], { stdio: 'pipe' });
    return parseInt(result.stdout.toString().trim(), 10);
  }

  selectWindow(id, windowIndex) {
    if (!this.sessions.has(id)) throw new Error(`Session ${id} not found`);
    spawnSync('tmux', ['select-window', '-t', `${id}:${windowIndex}`], { stdio: 'pipe' });
  }

  listWindows(id) {
    if (!this.sessions.has(id)) throw new Error(`Session ${id} not found`);
    const result = spawnSync('tmux', ['list-windows', '-t', id, '-F', '#{window_index}:#{window_name}:#{window_active}:#{window_panes}'], { stdio: 'pipe' });
    return result.stdout.toString().trim().split('\n').filter(Boolean).map(line => {
      const [index, name, active, panes] = line.split(':');
      return { index: parseInt(index), name, active: active === '1', panes: parseInt(panes) };
    });
  }

  startRecording(id, intervalMs = 100) {
    if (!this.sessions.has(id)) throw new Error(`Session ${id} not found`);
    this.stopRecording(id);
    const recording = { frames: [], startTime: Date.now(), interval: intervalMs, timer: null };
    recording.timer = setInterval(() => {
      try {
        recording.frames.push({ timestamp: Date.now() - recording.startTime, content: this.capturePane(id, { ansi: true }) });
      } catch { this.stopRecording(id); }
    }, intervalMs);
    this.recordings.set(id, recording);
  }

  stopRecording(id) {
    const recording = this.recordings.get(id);
    if (!recording) return null;
    if (recording.timer) clearInterval(recording.timer);
    this.recordings.delete(id);
    return { duration: Date.now() - recording.startTime, frameCount: recording.frames.length, interval: recording.interval, frames: recording.frames };
  }

  isRecording(id) { return this.recordings.has(id); }

  getRecording(id) {
    const recording = this.recordings.get(id);
    if (!recording) return null;
    return { duration: Date.now() - recording.startTime, frameCount: recording.frames.length, interval: recording.interval, frames: [...recording.frames] };
  }

  createDump(id, includeHistory = true) {
    if (!this.sessions.has(id)) throw new Error(`Session ${id} not found`);
    const session = this.sessions.get(id);
    return {
      version: 1,
      timestamp: new Date().toISOString(),
      session: { id: session.id, cols: session.cols, rows: session.rows, command: session.command },
      screen: { plain: this.capturePane(id), ansi: this.capturePane(id, { ansi: true }) },
      history: includeHistory ? this.capturePane(id, { history: true }) : null,
    };
  }

  compareToDump(id, dump, ignoreWhitespace = false) {
    const current = this.createDump(id, false);
    const normalize = (str) => ignoreWhitespace ? str.split('\n').map(l => l.trimEnd()).join('\n').trim() : str;
    const currentScreen = normalize(current.screen.plain);
    const expectedScreen = normalize(dump.screen.plain);
    if (currentScreen === expectedScreen) return { match: true, diff: null };
    const currentLines = currentScreen.split('\n');
    const expectedLines = expectedScreen.split('\n');
    const diffs = [];
    const maxLines = Math.max(currentLines.length, expectedLines.length);
    for (let i = 0; i < maxLines; i++) {
      if ((currentLines[i] || '') !== (expectedLines[i] || '')) {
        diffs.push({ line: i + 1, expected: expectedLines[i] || '', actual: currentLines[i] || '' });
      }
    }
    return { match: false, diff: diffs };
  }

  savePaneToFile(id, filePath, options = {}) {
    fs.writeFileSync(filePath, this.capturePane(id, options));
    return filePath;
  }

  dispose() {
    for (const [id] of this.sessions) {
      try { spawnSync('tmux', ['kill-session', '-t', id], { stdio: 'pipe' }); } catch {}
    }
    this.sessions.clear();
  }
}

const tmux = new TmuxManager();

// ============================================================================
// Terminal Tools
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
  { name: 'terminal_spawn', description: 'TUI testing: Launch a new terminal session for CLI apps, TUI programs (vim, htop, btop), or interactive shells. Returns a session ID.', inputSchema: { type: 'object', properties: { command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, cols: { type: 'number' }, rows: { type: 'number' }, cwd: { type: 'string' }, env: { type: 'object' } }, required: ['command'] } },
  { name: 'terminal_send_keys', description: 'TUI testing: Send keyboard input (Enter, Escape, C-c, arrows, etc) to a terminal session.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, keys: { type: 'string' } }, required: ['id', 'keys'] } },
  { name: 'terminal_send_text', description: 'TUI testing: Type literal text into a terminal session.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] } },
  { name: 'terminal_snapshot', description: 'TUI testing: Capture the current terminal screen as plain text. Returns what a user would see.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, history: { type: 'boolean' }, ansi: { type: 'boolean' } }, required: ['id'] } },
  { name: 'terminal_save', description: 'TUI testing: Save terminal screen content to a file for test artifacts.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, path: { type: 'string' }, history: { type: 'boolean' }, ansi: { type: 'boolean' } }, required: ['id', 'path'] } },
  { name: 'terminal_resize', description: 'TUI testing: Resize terminal to test responsive TUI layouts.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, cols: { type: 'number' }, rows: { type: 'number' } }, required: ['id', 'cols', 'rows'] } },
  { name: 'terminal_kill', description: 'TUI testing: End a terminal session and clean up.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'terminal_list', description: 'TUI testing: List all active terminal sessions.', inputSchema: { type: 'object', properties: {} } },
  { name: 'terminal_wait', description: 'TUI testing: Wait for text/pattern to appear in terminal output.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, pattern: { type: 'string' }, timeout: { type: 'number' } }, required: ['id', 'pattern'] } },
  { name: 'terminal_wait_idle', description: 'TUI testing: Wait until terminal output stops changing.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, idle_ms: { type: 'number' }, timeout: { type: 'number' } }, required: ['id'] } },
  { name: 'terminal_wait_prompt', description: 'TUI testing: Wait for a shell prompt to appear.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, prompt_pattern: { type: 'string' }, timeout: { type: 'number' } }, required: ['id'] } },
  { name: 'terminal_list_all', description: 'TUI testing: List all terminal sessions on the system including external ones.', inputSchema: { type: 'object', properties: {} } },
  { name: 'terminal_attach', description: 'TUI testing: Attach to an existing external terminal session.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'terminal_detach', description: 'TUI testing: Detach from a session without killing it.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'terminal_split', description: 'TUI testing: Split terminal into multiple panes for parallel testing.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, horizontal: { type: 'boolean' }, percent: { type: 'number' }, command: { type: 'string' } }, required: ['id'] } },
  { name: 'terminal_list_panes', description: 'TUI testing: List all panes in a terminal session.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'terminal_select_pane', description: 'TUI testing: Switch focus to a specific pane.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, pane: { type: 'number' } }, required: ['id', 'pane'] } },
  { name: 'terminal_send_to_pane', description: 'TUI testing: Send keyboard input to a specific pane without switching focus.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, pane: { type: 'number' }, keys: { type: 'string' } }, required: ['id', 'pane', 'keys'] } },
  { name: 'terminal_capture_pane', description: 'TUI testing: Read screen content from a specific pane.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, pane: { type: 'number' }, history: { type: 'boolean' }, ansi: { type: 'boolean' } }, required: ['id', 'pane'] } },
  { name: 'terminal_new_window', description: 'TUI testing: Create a new window (tab) in a terminal session.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, command: { type: 'string' } }, required: ['id'] } },
  { name: 'terminal_list_windows', description: 'TUI testing: List all windows in a terminal session.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'terminal_select_window', description: 'TUI testing: Switch to a specific window by index.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, window: { type: 'number' } }, required: ['id', 'window'] } },
  { name: 'terminal_record_start', description: 'TUI testing: Start recording a terminal session for playback.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, interval_ms: { type: 'number' } }, required: ['id'] } },
  { name: 'terminal_record_stop', description: 'TUI testing: Stop recording a terminal session.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'terminal_record_save', description: 'TUI testing: Save terminal recording to a JSON file.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, path: { type: 'string' } }, required: ['id', 'path'] } },
  { name: 'terminal_dump', description: 'TUI testing: Export terminal state as JSON baseline for snapshot testing.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, path: { type: 'string' }, include_history: { type: 'boolean' } }, required: ['id'] } },
  { name: 'terminal_compare', description: 'TUI testing: Compare current terminal state against a saved baseline. Returns diff.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, expected_path: { type: 'string' }, ignore_whitespace: { type: 'boolean' } }, required: ['id', 'expected_path'] } },
  { name: 'terminal_assert', description: 'TUI testing: Assert terminal screen contains/excludes expected text or matches a regex pattern.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, contains: { type: 'string' }, not_contains: { type: 'string' }, matches: { type: 'string' }, line: { type: 'number' } }, required: ['id'] } },
];

applyTerminalToolAnnotations(terminalTools);

async function executeTerminalTool(name, args) {
  const text = (t) => ({ content: [{ type: 'text', text: t }] });
  const err = (t) => ({ content: [{ type: 'text', text: t }], isError: true });

  try {
    switch (name) {
      case 'terminal_spawn': {
        const { command, args: cmdArgs = [], cols = 80, rows = 24, cwd, env } = args;
        const id = tmux.spawn(command, cmdArgs, { cols, rows, cwd, env });
        await new Promise(r => setTimeout(r, 200));
        return text(`Terminal spawned.\n\nID: ${id}\nCommand: ${command} ${cmdArgs.join(' ')}\nSize: ${cols}x${rows}`);
      }
      case 'terminal_send_keys': { tmux.sendKeys(args.id, args.keys); return text(`Keys sent: ${args.keys}`); }
      case 'terminal_send_text': { tmux.sendText(args.id, args.text); return text(`Text sent: ${JSON.stringify(args.text)}`); }
      case 'terminal_snapshot': { const s = tmux.get(args.id); return text(`Terminal ${args.id} (${s.cols}x${s.rows}):\n\n\`\`\`\n${tmux.capturePane(args.id, args)}\`\`\``); }
      case 'terminal_save': { tmux.savePaneToFile(args.id, args.path, args); return text(`Saved to: ${args.path}`); }
      case 'terminal_resize': { tmux.resize(args.id, args.cols, args.rows); return text(`Resized to ${args.cols}x${args.rows}`); }
      case 'terminal_kill': { tmux.kill(args.id); return text(`Killed ${args.id}`); }
      case 'terminal_list': { const s = tmux.list(); return text(s.length ? s.map(x => `- ${x.id} (${x.cols}x${x.rows}) - ${x.command}`).join('\n') : 'No terminals'); }
      case 'terminal_wait': {
        const { id, pattern, timeout = 5000 } = args;
        const regex = new RegExp(pattern);
        const start = Date.now();
        while (Date.now() - start < timeout) {
          if (regex.test(tmux.capturePane(id, { history: true }))) return text(`Pattern found:\n\`\`\`\n${tmux.capturePane(id)}\`\`\``);
          await new Promise(r => setTimeout(r, 100));
        }
        return err(`Timeout waiting for "${pattern}"\n\`\`\`\n${tmux.capturePane(id)}\`\`\``);
      }
      case 'terminal_wait_idle': {
        const { id, idle_ms = 500, timeout = 10000 } = args;
        const start = Date.now(); let last = '', lastChange = Date.now();
        while (Date.now() - start < timeout) {
          const c = tmux.capturePane(id);
          if (c !== last) { last = c; lastChange = Date.now(); }
          else if (Date.now() - lastChange >= idle_ms) return text(`Idle:\n\`\`\`\n${c}\`\`\``);
          await new Promise(r => setTimeout(r, 50));
        }
        return err(`Timeout waiting for idle`);
      }
      case 'terminal_wait_prompt': {
        const { id, prompt_pattern = '\\$\\s*$|#\\s*$|>\\s*$', timeout = 5000 } = args;
        const regex = new RegExp(prompt_pattern, 'm');
        const start = Date.now();
        while (Date.now() - start < timeout) {
          const c = tmux.capturePane(id);
          if (regex.test(c.trim().split('\n').slice(-3).join('\n'))) return text(`Prompt detected:\n\`\`\`\n${c}\`\`\``);
          await new Promise(r => setTimeout(r, 100));
        }
        return err(`Timeout waiting for prompt`);
      }
      case 'terminal_list_all': { const s = tmux.listAllSessions(); return text(s.length ? s.map(x => `- ${x.name} (${x.cols}x${x.rows})${x.managed ? ' [managed]' : ''}`).join('\n') : 'No sessions'); }
      case 'terminal_attach': { tmux.attach(args.name); return text(`Attached to ${args.name}`); }
      case 'terminal_detach': { tmux.detach(args.id); return text(`Detached from ${args.id}`); }
      case 'terminal_split': { tmux.splitPane(args.id, args); return text(`Split pane in ${args.id}`); }
      case 'terminal_list_panes': { return text(tmux.listPanes(args.id).map(p => `[${p.index}] ${p.cols}x${p.rows} ${p.active ? '(active)' : ''} - ${p.command}`).join('\n')); }
      case 'terminal_select_pane': { tmux.selectPane(args.id, args.pane); return text(`Selected pane ${args.pane}`); }
      case 'terminal_send_to_pane': { tmux.sendKeysToPane(args.id, args.pane, args.keys); return text(`Keys sent to pane ${args.pane}`); }
      case 'terminal_capture_pane': { return text(`Pane ${args.pane}:\n\`\`\`\n${tmux.capturePaneByIndex(args.id, args.pane, args)}\`\`\``); }
      case 'terminal_new_window': { const w = tmux.newWindow(args.id, args); return text(`Window ${w} created`); }
      case 'terminal_list_windows': { return text(tmux.listWindows(args.id).map(w => `[${w.index}] ${w.name} ${w.active ? '(active)' : ''}`).join('\n')); }
      case 'terminal_select_window': { tmux.selectWindow(args.id, args.window); return text(`Selected window ${args.window}`); }
      case 'terminal_record_start': { tmux.startRecording(args.id, args.interval_ms || 100); return text(`Recording started`); }
      case 'terminal_record_stop': { const r = tmux.stopRecording(args.id); return r ? text(`Stopped. ${r.frameCount} frames, ${r.duration}ms`) : err(`No recording`); }
      case 'terminal_record_save': {
        let r = tmux.getRecording(args.id);
        if (tmux.isRecording(args.id)) r = tmux.stopRecording(args.id);
        if (!r) return err(`No recording`);
        fs.writeFileSync(args.path, JSON.stringify({ version: 1, ...r }, null, 2));
        return text(`Saved to ${args.path}`);
      }
      case 'terminal_dump': {
        const d = tmux.createDump(args.id, args.include_history !== false);
        if (args.path) { fs.writeFileSync(args.path, JSON.stringify(d, null, 2)); return text(`Dumped to ${args.path}`); }
        return text(JSON.stringify(d, null, 2));
      }
      case 'terminal_compare': {
        const expected = JSON.parse(fs.readFileSync(args.expected_path, 'utf8'));
        const r = tmux.compareToDump(args.id, expected, args.ignore_whitespace);
        if (r.match) return text(`✅ Matches`);
        return err(`❌ Differs:\n${r.diff.slice(0, 5).map(d => `L${d.line}: "${d.actual}" vs "${d.expected}"`).join('\n')}`);
      }
      case 'terminal_assert': {
        const screen = tmux.capturePane(args.id);
        const check = args.line ? (screen.split('\n')[args.line - 1] || '') : screen;
        const errors = [];
        if (args.contains && !check.includes(args.contains)) errors.push(`Missing: "${args.contains}"`);
        if (args.not_contains && check.includes(args.not_contains)) errors.push(`Should not contain: "${args.not_contains}"`);
        if (args.matches && !new RegExp(args.matches).test(check)) errors.push(`No match for: ${args.matches}`);
        if (errors.length) return err(`❌ ${errors.join(', ')}\n\`\`\`\n${check}\`\`\``);
        return text(`✅ Assertion passed`);
      }
      default: return err(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return err(`Error: ${e.message}`);
  }
}

// ============================================================================
// JSON-RPC Proxy to Playwright MCP
// ============================================================================

async function main() {
  // Spawn the original playwright MCP
  const playwrightArgs = process.argv.slice(2);
  const playwright = spawn('node', [path.join(__dirname, 'cli-playwright.js'), ...playwrightArgs], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  const rl = readline.createInterface({ input: playwright.stdout, crlfDelay: Infinity });

  let playwrightTools = [];
  let initialized = false;

  // Handle incoming requests from Claude
  const stdinRl = readline.createInterface({ input: process.stdin });

  stdinRl.on('line', async (line) => {
    try {
      const msg = JSON.parse(line);

      if (msg.method === 'tools/list') {
        // Forward to playwright, then add our tools
        playwright.stdin.write(line + '\n');
      } else if (msg.method === 'tools/call' && msg.params?.name?.startsWith('terminal_')) {
        // Handle terminal tools locally
        const result = await executeTerminalTool(msg.params.name, msg.params.arguments || {});
        const response = { jsonrpc: '2.0', id: msg.id, result };
        process.stdout.write(JSON.stringify(response) + '\n');
      } else {
        // Forward everything else to playwright
        playwright.stdin.write(line + '\n');
      }
    } catch (e) {
      // Not JSON or error, forward anyway
      playwright.stdin.write(line + '\n');
    }
  });

  // Handle responses from playwright
  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line);

      // Intercept initialize response to add terminal instructions
      if (msg.result?.serverInfo) {
        const terminalInstructions = `This server also provides TUI testing tools (terminal_* prefix) for testing terminal/CLI/TUI applications like vim, htop, btop, nano, and custom TUI apps. TUI testing capabilities: terminal_spawn to launch sessions, terminal_send_keys/terminal_send_text for keyboard input, terminal_snapshot to read screen output, terminal_wait/terminal_wait_idle for synchronization, terminal_assert for test validation, terminal_compare/terminal_dump for snapshot testing, and terminal_record_* for session recording. Typical TUI testing workflow: terminal_spawn → send input → wait → snapshot → assert.`;
        msg.result.instructions = msg.result.instructions
          ? `${msg.result.instructions}\n\n${terminalInstructions}`
          : terminalInstructions;
      }

      // Intercept tools/list response to add our tools
      if (msg.result?.tools) {
        msg.result.tools = [...msg.result.tools, ...terminalTools];
      }

      process.stdout.write(JSON.stringify(msg) + '\n');
    } catch (e) {
      process.stdout.write(line + '\n');
    }
  });

  // Cleanup
  process.on('SIGINT', () => { tmux.dispose(); playwright.kill(); process.exit(0); });
  process.on('SIGTERM', () => { tmux.dispose(); playwright.kill(); process.exit(0); });
  playwright.on('exit', () => { tmux.dispose(); process.exit(0); });

  console.error('Unified Playwright+Terminal MCP running');
}

main().catch(console.error);
