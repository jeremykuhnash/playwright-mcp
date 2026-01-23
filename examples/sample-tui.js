#!/usr/bin/env node
/**
 * Sample TUI for testing the terminal MCP tools
 *
 * A simple interactive menu that responds to keyboard input.
 * No dependencies - uses raw Node.js TTY APIs.
 */

const readline = require('readline');

// ANSI escape codes
const ESC = '\x1b';
const CLEAR = `${ESC}[2J${ESC}[H`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const RESET = `${ESC}[0m`;
const RED = `${ESC}[31m`;
const GREEN = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;
const BLUE = `${ESC}[34m`;
const CYAN = `${ESC}[36m`;
const BG_BLUE = `${ESC}[44m`;
const WHITE = `${ESC}[37m`;

const menuItems = [
  { label: 'Say Hello', action: 'hello' },
  { label: 'Show Counter', action: 'counter' },
  { label: 'Input Test', action: 'input' },
  { label: 'Exit', action: 'exit' },
];

let selectedIndex = 0;
let counter = 0;
let currentView = 'menu';
let inputBuffer = '';
let lastMessage = '';

function drawBox(x, y, width, height, title = '') {
  let output = '';
  // Top border
  output += `${ESC}[${y};${x}H┌${'─'.repeat(width - 2)}┐`;
  if (title) {
    output += `${ESC}[${y};${x + 2}H ${BOLD}${title}${RESET} `;
  }
  // Sides
  for (let i = 1; i < height - 1; i++) {
    output += `${ESC}[${y + i};${x}H│${' '.repeat(width - 2)}│`;
  }
  // Bottom border
  output += `${ESC}[${y + height - 1};${x}H└${'─'.repeat(width - 2)}┘`;
  return output;
}

function render() {
  let output = CLEAR;

  // Header
  output += `${ESC}[1;1H${BG_BLUE}${WHITE}${BOLD}`;
  output += ' Sample TUI - Terminal Testing Demo '.padEnd(60);
  output += `${RESET}\n\n`;

  if (currentView === 'menu') {
    output += drawBox(2, 4, 40, menuItems.length + 4, 'Menu');

    menuItems.forEach((item, index) => {
      const selected = index === selectedIndex;
      const prefix = selected ? `${GREEN}▶ ` : '  ';
      const style = selected ? `${BOLD}${GREEN}` : DIM;
      output += `${ESC}[${6 + index};4H${prefix}${style}${item.label}${RESET}`;
    });

    output += `${ESC}[${12};2H${DIM}Use ↑/↓ to navigate, Enter to select, q to quit${RESET}`;

  } else if (currentView === 'hello') {
    output += drawBox(2, 4, 50, 6, 'Hello');
    output += `${ESC}[6;4H${CYAN}Hello from the Sample TUI!${RESET}`;
    output += `${ESC}[7;4H${DIM}Press any key to return...${RESET}`;

  } else if (currentView === 'counter') {
    output += drawBox(2, 4, 50, 8, 'Counter');
    output += `${ESC}[6;4HCounter value: ${YELLOW}${BOLD}${counter}${RESET}`;
    output += `${ESC}[7;4H${DIM}Press + to increment, - to decrement${RESET}`;
    output += `${ESC}[8;4H${DIM}Press any other key to return${RESET}`;

  } else if (currentView === 'input') {
    output += drawBox(2, 4, 50, 8, 'Input Test');
    output += `${ESC}[6;4HType something: ${GREEN}${inputBuffer}${RESET}█`;
    output += `${ESC}[7;4H${DIM}Press Enter to submit, Escape to cancel${RESET}`;
    if (lastMessage) {
      output += `${ESC}[9;4H${CYAN}Last input: ${lastMessage}${RESET}`;
    }
  }

  // Status bar
  output += `${ESC}[20;1H${'─'.repeat(60)}`;
  output += `${ESC}[21;1H${DIM}View: ${currentView} | Counter: ${counter}${RESET}`;

  process.stdout.write(output);
}

function handleKey(key) {
  if (currentView === 'menu') {
    if (key === '\x1b[A' || key === 'k') { // Up arrow or k
      selectedIndex = (selectedIndex - 1 + menuItems.length) % menuItems.length;
    } else if (key === '\x1b[B' || key === 'j') { // Down arrow or j
      selectedIndex = (selectedIndex + 1) % menuItems.length;
    } else if (key === '\r' || key === '\n') { // Enter
      const action = menuItems[selectedIndex].action;
      if (action === 'exit') {
        cleanup();
        process.exit(0);
      } else {
        currentView = action;
        inputBuffer = '';
      }
    } else if (key === 'q') {
      cleanup();
      process.exit(0);
    }
  } else if (currentView === 'hello') {
    currentView = 'menu';
  } else if (currentView === 'counter') {
    if (key === '+' || key === '=') {
      counter++;
    } else if (key === '-' || key === '_') {
      counter--;
    } else {
      currentView = 'menu';
    }
  } else if (currentView === 'input') {
    if (key === '\x1b') { // Escape
      inputBuffer = '';
      currentView = 'menu';
    } else if (key === '\r' || key === '\n') { // Enter
      lastMessage = inputBuffer;
      inputBuffer = '';
      currentView = 'menu';
    } else if (key === '\x7f') { // Backspace
      inputBuffer = inputBuffer.slice(0, -1);
    } else if (key.length === 1 && key >= ' ') {
      inputBuffer += key;
    }
  }
  render();
}

function cleanup() {
  process.stdout.write(`${CLEAR}${ESC}[?25h`); // Clear and show cursor
  process.stdin.setRawMode(false);
}

function main() {
  // Hide cursor
  process.stdout.write(`${ESC}[?25l`);

  // Set up raw mode for keyboard input
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  process.stdin.on('data', (key) => {
    // Ctrl+C
    if (key === '\x03') {
      cleanup();
      process.exit(0);
    }
    handleKey(key);
  });

  // Handle resize
  process.stdout.on('resize', render);

  // Clean exit
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

  render();
}

main();
