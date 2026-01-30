#!/usr/bin/env node
/**
 * Playwright MCP Server — unified entry point.
 *
 * Provides both browser automation (browser_*) and TUI/terminal testing
 * (terminal_*) tools. Delegates to cli-unified.js which proxies Playwright
 * browser tools and adds tmux-based terminal tools.
 *
 * For browser-only mode (no terminal tools), use cli-playwright.js directly.
 */

require('./cli-unified.js');
