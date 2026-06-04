// Generates StockPulse extension icons at 16, 48, and 128px.
// Run: node scripts/generate-icons.js

const { createCanvas } = require("canvas");
const fs = require("fs");
const path = require("path");

const sizes = [16, 48, 128];

function drawIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  const s = size / 128; // scale factor (design at 128, scale down)

  // Background — rounded dark square
  ctx.fillStyle = "#080C10";
  ctx.beginPath();
  const r = 20 * s;
  ctx.moveTo(r, 0);
  ctx.lineTo(size - r, 0);
  ctx.quadraticCurveTo(size, 0, size, r);
  ctx.lineTo(size, size - r);
  ctx.quadraticCurveTo(size, size, size - r, size);
  ctx.lineTo(r, size);
  ctx.quadraticCurveTo(0, size, 0, size - r);
  ctx.lineTo(0, r);
  ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.fill();

  // Subtle border
  ctx.strokeStyle = "#1A2530";
  ctx.lineWidth = 2 * s;
  ctx.stroke();

  // Pulse line — a stock chart line going up
  ctx.strokeStyle = "#00FF88";
  ctx.lineWidth = Math.max(2, 6 * s);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();

  // Chart points (designed at 128px scale)
  const points = [
    [20, 85],
    [35, 75],
    [50, 80],
    [65, 55],
    [75, 65],
    [90, 35],
    [108, 40],
  ];

  points.forEach(([x, y], i) => {
    const px = x * s;
    const py = y * s;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();

  // Glow effect on the line
  ctx.strokeStyle = "rgba(0, 255, 136, 0.3)";
  ctx.lineWidth = Math.max(4, 12 * s);
  ctx.beginPath();
  points.forEach(([x, y], i) => {
    const px = x * s;
    const py = y * s;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();

  // Small dot at the end of the line (latest price)
  const lastPoint = points[points.length - 1];
  ctx.fillStyle = "#00FF88";
  ctx.beginPath();
  ctx.arc(lastPoint[0] * s, lastPoint[1] * s, Math.max(2, 5 * s), 0, Math.PI * 2);
  ctx.fill();

  return canvas.toBuffer("image/png");
}

// Generate all sizes
const outDir = path.join(__dirname, "..", "public");
for (const size of sizes) {
  const buffer = drawIcon(size);
  const filePath = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(filePath, buffer);
  console.log(`Created ${filePath} (${buffer.length} bytes)`);
}
