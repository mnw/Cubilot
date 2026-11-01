// Fake TUI for the terminal transport spike (tests/spike/terminal-transport.test.ts).
// usage: bun fake-tui.ts <hex-file> <size-file> <go-file>
// Waits for <go-file>, then prints the cases of design decision 1, reports its size at start and on SIGWINCH,
// and appends every received byte as two hex digits to <hex-file>.
import { appendFileSync, existsSync } from "node:fs";

const [hexFile, sizeFile, goFile] = process.argv.slice(2);
const ESC = "\x1b";
const out = (s: string) => process.stdout.write(s);

// `stty size` on the inherited tty: process.stdout.columns is not refreshed by Bun on SIGWINCH.
const winSize = (): [number, number] => {
  const [r, c] = Bun.spawnSync(["stty", "size"], { stdin: "inherit" }).stdout.toString().trim().split(" ").map(Number);
  return [c, r];
};
const size = () => winSize().join("x");
const reportSize = () => {
  appendFileSync(sizeFile, `${size()}\n`);
  out(`${ESC}7${ESC}[1;1H${ESC}[2KSIZE ${size()}${ESC}8`);
};

function printCases() {
  out(`${ESC}[?2004h`); // bracketed paste on
  out(`${ESC}[?1049h${ESC}[2J`); // alternate screen
  out(`${ESC}[2;1H${ESC}[38;5;196mSGR256${ESC}[0m ${ESC}[1;32mBOLDGREEN${ESC}[0m`);
  out(`${ESC}[3;1H${ESC}[38;2;0;128;255mTRUECOLOR${ESC}[0m`);
  out(`${ESC}[5;10H${ESC}[38;2;255;0;0mR${ESC}[0m`); // red cell at row 5, column 10
  out(`${ESC}[7;1H🦀`);
  reportSize();
}

// 'R' on stdin: 60 full-screen frames, one SGR per cell, for the bytes-per-second figure.
function fullRedraw() {
  const [cols, rows] = winSize();
  for (let f = 0; f < 60; f++) {
    let s = `${ESC}[H`;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) s += `${ESC}[38;5;${(r * 7 + c * 3 + f) % 256}m${String.fromCharCode(33 + ((r + c + f) % 90))}`;
      if (r < rows - 1) s += "\r\n";
    }
    out(s + `${ESC}[0m`);
  }
  out(`${ESC}[1;1H${ESC}[2KREDRAW-DONE`);
}

function start() {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.on("SIGWINCH", reportSize);
  process.stdin.on("data", (b: Buffer) => {
    appendFileSync(hexFile, [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ") + " ");
    if (b.length === 1 && b[0] === 0x52) fullRedraw(); // 'R'
    if (b.length === 1 && b[0] === 0x78) out(`${ESC}[?1049l\r\nBACK-ON-MAIN`); // 'x'
  });
  printCases();
}

const wait = setInterval(() => {
  if (existsSync(goFile)) { clearInterval(wait); start(); }
}, 20);
