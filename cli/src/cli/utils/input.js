const readline = require("readline");

const COLORS = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  underline: "\x1b[4m",
  reverse: "\x1b[7m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  white: "\x1b[37m",
  bgGreen: "\x1b[42m",
  bgBlue: "\x1b[44m",
  black: "\x1b[30m",
  terracotta: "\x1b[38;2;217;119;87m",
  bgTerracotta: "\x1b[48;2;217;119;87m"
};

// ---------------------------------------------------------------------------
// Simple (line-based) mode
//
// Consoles like Pterodactyl's web console only send whole lines (text + Enter):
// they cannot send arrow keys, and stdin may not even be a TTY. In that case we
// fall back to numbered menus: type a number, press Enter.
//
// Force on : NINEROUTER_SIMPLE_MENU=1  or  --simple-menu
// Force off: NINEROUTER_SIMPLE_MENU=0   (keep arrow-key menus)
// Auto-on  : stdin is not a TTY, or a Pterodactyl container is detected
// ---------------------------------------------------------------------------
function detectSimpleMode() {
  const env = String(process.env.NINEROUTER_SIMPLE_MENU || "").toLowerCase();
  if (["0", "false", "off", "no"].includes(env)) return false;
  if (["1", "true", "on", "yes"].includes(env)) return true;
  if (process.argv.includes("--simple-menu")) return true;
  if (!process.stdin.isTTY) return true;
  if (process.env.P_SERVER_UUID || process.env.P_SERVER_LOCATION) return true; // Pterodactyl
  return false;
}
const SIMPLE_MODE = detectSimpleMode();

// One shared line reader for the whole process. Creating/closing a readline
// interface per prompt loses buffered lines and can end piped stdin.
let lineRl = null;
let stdinClosed = false;
const lineQueue = [];
const lineWaiters = [];

function ensureLineReader() {
  if (lineRl) return;
  lineRl = readline.createInterface({ input: process.stdin, terminal: false });
  lineRl.on("line", (line) => {
    const waiter = lineWaiters.shift();
    if (waiter) waiter(line);
    else lineQueue.push(line);
  });
  lineRl.on("close", () => {
    stdinClosed = true;
    while (lineWaiters.length) lineWaiters.shift()(null);
  });
}

// Resolves with the next line typed by the user, or null if stdin was closed.
function readLine(question = "") {
  ensureLineReader();
  // Web consoles (Pterodactyl and similar) usually render output line-by-line:
  // a line is only painted once a "\n" arrives. Our prompts used to end in
  // ": " with no newline so a real TTY could echo the answer inline, but on
  // those consoles that left the prompt stuck in an unterminated buffer -
  // invisible until some later write happened to flush it (often together
  // with the *next* menu, well after the user already answered blind). Force
  // a trailing newline so the prompt always shows immediately.
  if (question) process.stdout.write(question.endsWith("\n") ? question : question + "\n");
  if (lineQueue.length) return Promise.resolve(lineQueue.shift());
  if (stdinClosed) return Promise.resolve(null);
  return new Promise((resolve) => lineWaiters.push(resolve));
}

// Prime stdin once globally. Toggling raw mode between menus adds latency on
// macOS, so we keep raw mode on for the whole TUI session.
let rawPrimed = false;
function primeRawOnce() {
  if (rawPrimed || !process.stdin.isTTY) return;
  try {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    rawPrimed = true;
  } catch {}
}

function suspendRawFor(fn) {
  // Temporarily drop raw mode so readline.question can buffer line input.
  const wasPrimed = rawPrimed;
  if (wasPrimed && process.stdin.isTTY) {
    try { process.stdin.setRawMode(false); } catch {}
  }
  return fn().finally(() => {
    if (wasPrimed && process.stdin.isTTY) {
      try { process.stdin.setRawMode(true); } catch {}
      process.stdin.resume();
    }
  });
}

async function prompt(question) {
  if (SIMPLE_MODE) {
    const line = await readLine(question);
    return (line || "").trim();
  }
  return suspendRawFor(() => new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve((answer || "").trim());
    });
  }));
}

async function select(question, options) {
  console.log(question);
  options.forEach((opt, i) => console.log(`  ${i + 1}. ${opt}`));
  while (true) {
    const answer = await prompt("\nSelect option (number): ");
    if (SIMPLE_MODE && stdinClosed) return -1;
    const num = parseInt(answer, 10);
    if (!isNaN(num) && num >= 1 && num <= options.length) return num - 1;
    console.log(`Invalid selection. Please enter a number between 1 and ${options.length}`);
  }
}

async function confirm(question) {
  while (true) {
    const answer = await prompt(`${question} (y/n): `);
    if (SIMPLE_MODE && stdinClosed) return false;
    const lower = answer.toLowerCase();
    if (lower === "y" || lower === "yes") return true;
    if (lower === "n" || lower === "no") return false;
    console.log("Please answer 'y' or 'n'");
  }
}

async function pause(message = "Press Enter to continue...") {
  if (SIMPLE_MODE) {
    await readLine(message);
    return;
  }
  return suspendRawFor(() => new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, () => { rl.close(); resolve(); });
  }));
}

/**
 * Numbered menu for consoles without arrow keys (Pterodactyl, piped stdin...).
 * Type the number of an item and press Enter. "0", "b" or "q" = back/cancel
 * (the item flagged `back: true`, or -1 like ESC when there is none).
 * Returns the item index.
 */
async function selectMenuSimple(title, items, defaultIndex = 0, subtitle = "", headerContent = "", breadcrumb = []) {
  const width = Math.min(process.stdout.columns || 40, 40);
  console.log(`\n${COLORS.terracotta}${"=".repeat(width)}${COLORS.reset}`);
  console.log(`  ${COLORS.bright}${COLORS.terracotta}${title}${COLORS.reset}`);
  if (subtitle) console.log(`  ${COLORS.dim}${subtitle}${COLORS.reset}`);
  console.log(`${COLORS.terracotta}${"=".repeat(width)}${COLORS.reset}`);
  if (breadcrumb.length > 0) console.log(`  ${COLORS.dim}${breadcrumb.join(" > ")}${COLORS.reset}`);
  console.log();
  if (headerContent) { console.log(headerContent); console.log(); }

  // Items flagged `back: true` are shown as "0" (so the real choices start at 1).
  const numbered = []; // numbered[n - 1] = index into items
  let backIndex = -1;
  items.forEach((item, index) => {
    if (item.back && backIndex === -1) backIndex = index;
    else numbered.push(index);
  });
  const pad = String(numbered.length).length;
  if (backIndex !== -1) console.log(`  ${COLORS.bright}${"0".padStart(pad)}${COLORS.reset}. ${items[backIndex].label}`);
  numbered.forEach((itemIndex, n) => {
    console.log(`  ${COLORS.bright}${String(n + 1).padStart(pad)}${COLORS.reset}. ${items[itemIndex].label}`);
  });
  console.log();

  const hint = `Type a number (1-${numbered.length}) + Enter, 0 = back: `;
  while (true) {
    const line = await readLine(hint);
    if (line === null) return -1; // stdin closed
    const answer = line.trim().toLowerCase();
    if (answer === "") continue; // ignore stray Enter, avoids accidental "Back"
    if (["0", "b", "back", "q", "esc"].includes(answer)) return backIndex; // -1 when no back item
    if (/^\d+$/.test(answer)) {
      const num = parseInt(answer, 10);
      if (num >= 1 && num <= numbered.length) return numbered[num - 1];
    }
    console.log(`Invalid choice "${line.trim()}". Enter a number from 1 to ${numbered.length}, or 0 to go back.`);
  }
}

/**
 * Interactive arrow-key menu. Renders ★/☆ icons; selected line uses reverse+bright
 * (no underline). Uses readline keypress + raw 'data' fallback to prevent
 * arrow-key escape sequence leaks on macOS.
 */
async function selectMenu(title, items, defaultIndex = 0, subtitle = "", headerContent = "", breadcrumb = []) {
  if (SIMPLE_MODE) {
    return selectMenuSimple(title, items, defaultIndex, subtitle, headerContent, breadcrumb);
  }
  return new Promise((resolve) => {
    let selectedIndex = defaultIndex;
    let isActive = true;

    primeRawOnce();
    if (!process.stdin.isTTY) { resolve(-1); return; }

    const renderMenu = () => {
      if (!isActive) return;
      process.stdout.write("\x1b[2J\x1b[H");
      const width = Math.min(process.stdout.columns || 40, 40);
      console.log(`\n${COLORS.terracotta}${"=".repeat(width)}${COLORS.reset}`);
      console.log(`  ${COLORS.bright}${COLORS.terracotta}${title}${COLORS.reset}`);
      if (subtitle) console.log(`  ${COLORS.dim}${subtitle}${COLORS.reset}`);
      console.log(`${COLORS.terracotta}${"=".repeat(width)}${COLORS.reset}`);
      if (breadcrumb.length > 0) console.log(`  ${COLORS.dim}${breadcrumb.join(" > ")}${COLORS.reset}`);
      console.log();
      if (headerContent) { console.log(headerContent); console.log(); }

      const isWin = process.platform === "win32";
      items.forEach((item, index) => {
        const isSelected = index === selectedIndex;
        const icon = isSelected ? (isWin ? ">" : "★") : (isWin ? " " : "☆");
        if (isSelected) {
          console.log(` ${COLORS.reverse}${COLORS.bright}${icon} ${item.label}${COLORS.reset}`);
        } else {
          console.log(`  ${icon} ${item.label}`);
        }
      });
    };

    const cleanup = () => {
      if (!isActive) return;
      isActive = false;
      process.stdin.removeListener("keypress", onKeypress);
    };

    const move = (delta) => {
      selectedIndex = (selectedIndex + delta + items.length) % items.length;
      renderMenu();
    };

    const onKeypress = (_str, key) => {
      if (!isActive || !key) return;
      if (key.name === "up") return move(-1);
      if (key.name === "down") return move(1);
      if (key.name === "return" || key.name === "enter") { cleanup(); resolve(selectedIndex); return; }
      if (key.name === "escape") { cleanup(); resolve(-1); return; }
      if (key.ctrl && key.name === "c") { cleanup(); process.exit(0); }
    };

    process.stdin.on("keypress", onKeypress);
    renderMenu();
  });
}

module.exports = {
  prompt,
  select,
  confirm,
  pause,
  selectMenu,
  isSimpleMode: SIMPLE_MODE,
  COLORS
};
