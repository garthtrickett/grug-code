// File: ./scripts/build-sidecar.js
// ==============================================================================
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

console.error("[Build Sidecar] Compiling Bun sidecar daemon...");

const rustInfo = execSync("rustc -vV", { encoding: "utf-8" });
const targetTripleMatch = /host: (\S+)/.exec(rustInfo);
if (!targetTripleMatch) {
  throw new Error("Could not extract target triple from rustc");
}
const targetTriple = targetTripleMatch[1];
console.error(`[Build Sidecar] Detected target triple: ${targetTriple}`);

const binDir = path.resolve("src-tauri/bin");
if (!fs.existsSync(binDir)) {
  fs.mkdirSync(binDir, { recursive: true });
}

const distDir = path.resolve("dist");
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

// Compile the main server binary using Bun (targeting the correct Elysia entry-point)
execSync("bun build --compile src/server/index.ts --outfile dist/grug-daemon", {
  cwd: ".",
  stdio: "inherit"
});

const source = path.resolve("dist/grug-daemon");
if (!fs.existsSync(source)) {
  throw new Error(`Compiled daemon binary not found at: ${source}`);
}

const ext = process.platform === "win32" ? ".exe" : "";
const dest = path.resolve(binDir, `grug-daemon-${targetTriple}${ext}`);

fs.copyFileSync(source, dest);

// Apply execute permissions on non-Windows platforms
if (process.platform !== "win32") {
  fs.chmodSync(dest, 0o755);
}

console.error(`[Build Sidecar] Cleanly compiled and copied sidecar to: ${dest}`);

// Create minimal placeholder icons to prevent Tauri compiler panics on empty assets
console.error("[Build Sidecar] Verifying desktop bundling icons...");
const iconDir = path.resolve("src-tauri/icons");
if (!fs.existsSync(iconDir)) {
  fs.mkdirSync(iconDir, { recursive: true });
}

// 1x1 transparent 32-bit RGBA PNG representation
const minPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
const pngBuffer = Buffer.from(minPngBase64, "base64");

const requiredPngs = [
  "32x32.png",
  "128x128.png",
  "128x128@2x.png",
  "icon.png"
];

// Clean up any stale/un-parseable placeholder PNGs first
for (const png of requiredPngs) {
  const pngPath = path.resolve(iconDir, png);
  try {
    if (fs.existsSync(pngPath)) {
      fs.unlinkSync(pngPath);
    }
  } catch {}
  fs.writeFileSync(pngPath, pngBuffer);
  console.error(`  - Created 32-bit RGBA placeholder icon: ${png}`);
}

// Stub standard platform specific wrapper packages
const icoPath = path.resolve(iconDir, "icon.ico");
if (!fs.existsSync(icoPath)) {
  fs.writeFileSync(icoPath, pngBuffer);
  console.error("  - Created placeholder icon: icon.ico");
}

const icnsPath = path.resolve(iconDir, "icon.icns");
if (!fs.existsSync(icnsPath)) {
  fs.writeFileSync(icnsPath, pngBuffer);
  console.error("  - Created placeholder icon: icon.icns");
}

console.error("[Build Sidecar] Icon check complete.");
