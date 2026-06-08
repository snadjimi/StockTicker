// Generates StockPulse extension icons at 16, 48, and 128px.
// Run: node scripts/generate-icons.js

const { createCanvas } = require("canvas");
const fs = require("fs");
const path = require("path");

const sizes = [16, 48, 128];

const points = [
  [18, 88],
  [34, 78],
  [50, 84],
  [64, 58],
  [78, 68],
  [94, 38],
  [110, 26],
];

function roundedRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  const s = size / 128;

  const bg = ctx.createLinearGradient(0, 0, size, size);
  bg.addColorStop(0, "#0B1218");
  bg.addColorStop(1, "#070B0F");

  roundedRectPath(ctx, 0, 0, size, size, 26 * s);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.save();
  ctx.clip();

  const scaled = points.map(([x, y]) => [x * s, y * s]);

  const area = ctx.createLinearGradient(0, 20 * s, 0, size);
  area.addColorStop(0, "rgba(0, 255, 136, 0.28)");
  area.addColorStop(1, "rgba(0, 255, 136, 0)");
  ctx.beginPath();
  scaled.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.lineTo(scaled[scaled.length - 1][0], size);
  ctx.lineTo(scaled[0][0], size);
  ctx.closePath();
  ctx.fillStyle = area;
  ctx.fill();

  const line = ctx.createLinearGradient(0, size, size, 0);
  line.addColorStop(0, "#00C46A");
  line.addColorStop(1, "#3BFF9E");
  ctx.strokeStyle = line;
  ctx.lineWidth = Math.max(2, 7 * s);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = "rgba(0, 255, 136, 0.55)";
  ctx.shadowBlur = 12 * s;
  ctx.beginPath();
  scaled.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.stroke();

  const [ex, ey] = scaled[scaled.length - 1];
  ctx.fillStyle = "#EAFFF4";
  ctx.shadowBlur = 16 * s;
  ctx.beginPath();
  ctx.arc(ex, ey, Math.max(2, 6 * s), 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
  return canvas.toBuffer("image/png");
}

const outDir = path.join(__dirname, "..", "public");
for (const size of sizes) {
  const buffer = drawIcon(size);
  const filePath = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(filePath, buffer);
  console.log(`Created ${filePath} (${buffer.length} bytes)`);
}
