#!/usr/bin/env node
/**
 * Punk Wallet App Icon Generator
 *
 * Run with: node scripts/generate-icon.js
 *
 * This generates a 1024x1024 PNG icon featuring a CryptoPunk-style character.
 * Customize the settings below to create your perfect punk!
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ============================================
// 🎨 CUSTOMIZE YOUR PUNK HERE!
// ============================================

const PUNK_CONFIG = {
  // Background color - dark purple/black
  backgroundColor: "#16082e",

  // Skin tone options: 'light', 'medium', 'dark', 'alien', 'zombie', 'ape'
  skinType: "zombie",

  // Hair style: 'mohawk', 'messy', 'bald', 'spiky', 'wild', 'cap', 'pigtails', 'hoodie'
  hairStyle: "mohawk",

  // Hair color (hex) - accent green (same as "Punk" text)
  hairColor: "#84cc16",

  // Eye style: 'normal', 'sunglasses', '3d', 'big', 'vr', 'laser'
  eyeStyle: "sunglasses",

  // Mouth style: 'neutral', 'smile', 'cigarette', 'open', 'pipe'
  mouthStyle: "cigarette",

  // Accessories: 'none', 'earring', 'chain', 'nosering', 'bandana', 'choker'
  accessory: "chain",
};

// ============================================
// Skin tones
// ============================================
const SKIN_TONES = {
  light: "#ffd8b1",
  "medium-light": "#e0b088",
  medium: "#c68f5a",
  "medium-dark": "#a57038",
  dark: "#8b5a2b",
  darker: "#5c3a1e",
  alien: "#71aa34",
  zombie: "#7fd8ff",
  ape: "#ffd700",
};

// ============================================
// SVG Generation
// ============================================

function generateSkinPixels() {
  const pixels = [];

  // Face - detailed punk-style (24x24 grid, we'll scale it up)
  for (let y = 10; y < 18; y++) {
    for (let x = 8; x < 16; x++) {
      // Skip eyes area
      if (y === 12 && (x === 9 || x === 14)) continue;
      // Skip mouth area
      if (y >= 15 && y <= 16 && x >= 10 && x <= 13) continue;
      pixels.push({ x, y });
    }
  }

  // Neck
  for (let y = 18; y < 21; y++) {
    for (let x = 10; x < 14; x++) {
      pixels.push({ x, y });
    }
  }

  // Ears
  pixels.push({ x: 7, y: 12 });
  pixels.push({ x: 7, y: 13 });
  pixels.push({ x: 7, y: 14 });
  pixels.push({ x: 16, y: 12 });
  pixels.push({ x: 16, y: 13 });
  pixels.push({ x: 16, y: 14 });

  // Nose
  pixels.push({ x: 11, y: 13 });
  pixels.push({ x: 12, y: 13 });
  pixels.push({ x: 11, y: 14 });
  pixels.push({ x: 12, y: 14 });

  return pixels;
}

function generateHairPixels(style) {
  const pixels = [];

  switch (style) {
    case "mohawk":
      for (let y = 3; y < 8; y++) {
        pixels.push({ x: 11, y });
        pixels.push({ x: 12, y });
      }
      for (let y = 8; y < 10; y++) {
        for (let x = 10; x < 14; x++) {
          pixels.push({ x, y });
        }
      }
      break;

    case "messy":
      for (let x = 8; x < 16; x++) {
        const topY = 7 + Math.floor(Math.sin(x) * 1.5);
        for (let y = topY; y < 10; y++) {
          pixels.push({ x, y });
        }
      }
      for (let y = 10; y < 14; y++) {
        if (y % 2 === 0) pixels.push({ x: 7, y });
        if (y % 2 === 1) pixels.push({ x: 16, y });
      }
      break;

    case "bald":
      // No pixels
      break;

    case "spiky":
      for (let x = 8; x < 16; x++) {
        const spike = x % 2 === 0;
        const topY = spike ? 5 : 7;
        for (let y = topY; y < 10; y++) {
          pixels.push({ x, y });
        }
      }
      break;

    case "wild":
      for (let x = 6; x < 18; x++) {
        const topY = 5 + Math.floor(Math.abs(Math.sin(x * 0.8)) * 4);
        for (let y = topY; y < 10; y++) {
          pixels.push({ x, y });
        }
      }
      // Extra strands
      pixels.push({ x: 5, y: 6 });
      pixels.push({ x: 18, y: 7 });
      pixels.push({ x: 7, y: 4 });
      pixels.push({ x: 16, y: 5 });
      break;

    case "cap":
      for (let x = 7; x < 17; x++) {
        for (let y = 6; y < 10; y++) {
          pixels.push({ x, y });
        }
      }
      // Brim
      for (let x = 6; x < 18; x++) {
        pixels.push({ x, y: 10 });
      }
      break;

    case "pigtails":
      for (let x = 8; x < 16; x++) {
        for (let y = 7; y < 10; y++) {
          pixels.push({ x, y });
        }
      }
      for (let y = 10; y < 18; y++) {
        pixels.push({ x: 6, y });
        pixels.push({ x: 7, y });
        pixels.push({ x: 16, y });
        pixels.push({ x: 17, y });
      }
      break;

    case "hoodie":
      for (let x = 6; x < 18; x++) {
        for (let y = 5; y < 10; y++) {
          pixels.push({ x, y });
        }
      }
      for (let y = 10; y < 19; y++) {
        pixels.push({ x: 5, y });
        pixels.push({ x: 6, y });
        pixels.push({ x: 17, y });
        pixels.push({ x: 18, y });
      }
      break;
  }

  return pixels;
}

function generateEyePixels(style) {
  switch (style) {
    case "normal":
      return [
        { x: 9, y: 12, color: "#000000" },
        { x: 14, y: 12, color: "#000000" },
      ];

    case "sunglasses":
      return [
        { x: 8, y: 12, color: "#000000" },
        { x: 9, y: 12, color: "#111111" },
        { x: 10, y: 12, color: "#000000" },
        { x: 13, y: 12, color: "#000000" },
        { x: 14, y: 12, color: "#111111" },
        { x: 15, y: 12, color: "#000000" },
        { x: 11, y: 12, color: "#000000" },
        { x: 12, y: 12, color: "#000000" },
      ];

    case "3d":
      return [
        { x: 8, y: 12, color: "#ff0000" },
        { x: 9, y: 12, color: "#ff0000" },
        { x: 10, y: 12, color: "#ff0000" },
        { x: 11, y: 12, color: "#000000" },
        { x: 12, y: 12, color: "#000000" },
        { x: 13, y: 12, color: "#00ffff" },
        { x: 14, y: 12, color: "#00ffff" },
        { x: 15, y: 12, color: "#00ffff" },
      ];

    case "big":
      return [
        { x: 9, y: 11, color: "#ffffff" },
        { x: 9, y: 12, color: "#000000" },
        { x: 14, y: 11, color: "#ffffff" },
        { x: 14, y: 12, color: "#000000" },
      ];

    case "vr":
      return [
        { x: 7, y: 11, color: "#333333" },
        { x: 8, y: 11, color: "#444444" },
        { x: 9, y: 11, color: "#00ffff" },
        { x: 10, y: 11, color: "#444444" },
        { x: 11, y: 11, color: "#444444" },
        { x: 12, y: 11, color: "#444444" },
        { x: 13, y: 11, color: "#444444" },
        { x: 14, y: 11, color: "#00ffff" },
        { x: 15, y: 11, color: "#444444" },
        { x: 16, y: 11, color: "#333333" },
        { x: 7, y: 12, color: "#333333" },
        { x: 8, y: 12, color: "#444444" },
        { x: 9, y: 12, color: "#444444" },
        { x: 10, y: 12, color: "#444444" },
        { x: 11, y: 12, color: "#444444" },
        { x: 12, y: 12, color: "#444444" },
        { x: 13, y: 12, color: "#444444" },
        { x: 14, y: 12, color: "#444444" },
        { x: 15, y: 12, color: "#444444" },
        { x: 16, y: 12, color: "#333333" },
      ];

    case "laser":
      return [
        { x: 9, y: 12, color: "#ff0000" },
        { x: 14, y: 12, color: "#ff0000" },
        { x: 8, y: 12, color: "#ff6666" },
        { x: 15, y: 12, color: "#ff6666" },
        // Laser beams
        { x: 7, y: 12, color: "#ff3333" },
        { x: 6, y: 12, color: "#ff0000" },
        { x: 16, y: 12, color: "#ff3333" },
        { x: 17, y: 12, color: "#ff0000" },
      ];

    default:
      return [
        { x: 9, y: 12, color: "#000000" },
        { x: 14, y: 12, color: "#000000" },
      ];
  }
}

function generateMouthPixels(style) {
  switch (style) {
    case "neutral":
      return [
        { x: 11, y: 15, color: "#000000" },
        { x: 12, y: 15, color: "#000000" },
      ];

    case "smile":
      return [
        { x: 10, y: 15, color: "#000000" },
        { x: 11, y: 16, color: "#000000" },
        { x: 12, y: 16, color: "#000000" },
        { x: 13, y: 15, color: "#000000" },
      ];

    case "cigarette":
      return [
        { x: 11, y: 15, color: "#000000" },
        { x: 12, y: 15, color: "#000000" },
        { x: 13, y: 15, color: "#ffffff" },
        { x: 14, y: 15, color: "#ffffff" },
        { x: 15, y: 15, color: "#ff6600" },
      ];

    case "open":
      return [
        { x: 10, y: 15, color: "#000000" },
        { x: 11, y: 15, color: "#8b0000" },
        { x: 12, y: 15, color: "#8b0000" },
        { x: 13, y: 15, color: "#000000" },
        { x: 11, y: 16, color: "#000000" },
        { x: 12, y: 16, color: "#000000" },
      ];

    case "pipe":
      return [
        { x: 11, y: 15, color: "#000000" },
        { x: 12, y: 15, color: "#8b4513" },
        { x: 13, y: 15, color: "#8b4513" },
        { x: 14, y: 15, color: "#8b4513" },
        { x: 14, y: 14, color: "#8b4513" },
        { x: 14, y: 13, color: "#8b4513" },
      ];

    default:
      return [
        { x: 11, y: 15, color: "#000000" },
        { x: 12, y: 15, color: "#000000" },
      ];
  }
}

function generateAccessoryPixels(accessory, hairColor) {
  switch (accessory) {
    case "none":
      return [];

    case "earring":
      return [{ x: 7, y: 14, color: "#ffd700" }];

    case "chain":
      return [
        { x: 10, y: 18, color: "#ffd700" },
        { x: 11, y: 18, color: "#ffd700" },
        { x: 12, y: 18, color: "#ffd700" },
        { x: 13, y: 18, color: "#ffd700" },
        { x: 11, y: 19, color: "#ffd700" },
        { x: 12, y: 19, color: "#ffd700" },
      ];

    case "nosering":
      return [{ x: 12, y: 14, color: "#ffd700" }];

    case "bandana":
      return [
        { x: 7, y: 10, color: hairColor },
        { x: 8, y: 10, color: hairColor },
        { x: 9, y: 10, color: hairColor },
        { x: 10, y: 10, color: hairColor },
        { x: 11, y: 10, color: hairColor },
        { x: 12, y: 10, color: hairColor },
        { x: 13, y: 10, color: hairColor },
        { x: 14, y: 10, color: hairColor },
        { x: 15, y: 10, color: hairColor },
        { x: 16, y: 10, color: hairColor },
        { x: 6, y: 11, color: hairColor },
        { x: 5, y: 12, color: hairColor },
      ];

    case "choker":
      return [
        { x: 9, y: 17, color: "#000000" },
        { x: 10, y: 17, color: "#000000" },
        { x: 11, y: 17, color: "#ff0000" },
        { x: 12, y: 17, color: "#ff0000" },
        { x: 13, y: 17, color: "#000000" },
        { x: 14, y: 17, color: "#000000" },
      ];

    default:
      return [];
  }
}

function generatePunkSVG(config) {
  const skinColor = SKIN_TONES[config.skinType] || SKIN_TONES.medium;

  const skinPixels = generateSkinPixels();
  const hairPixels = generateHairPixels(config.hairStyle);
  const eyePixels = generateEyePixels(config.eyeStyle);
  const mouthPixels = generateMouthPixels(config.mouthStyle);
  const accessoryPixels = generateAccessoryPixels(
    config.accessory,
    config.hairColor
  );

  // Scale factor: 24x24 grid -> 1024x1024
  const scale = 1024 / 24;

  let svg = `<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
  <!-- Background -->
  <rect width="1024" height="1024" fill="${config.backgroundColor}"/>

  <!-- Skin -->
`;

  for (const pixel of skinPixels) {
    svg += `  <rect x="${pixel.x * scale}" y="${
      pixel.y * scale
    }" width="${scale}" height="${scale}" fill="${skinColor}"/>\n`;
  }

  svg += `\n  <!-- Hair -->\n`;
  for (const pixel of hairPixels) {
    svg += `  <rect x="${pixel.x * scale}" y="${
      pixel.y * scale
    }" width="${scale}" height="${scale}" fill="${config.hairColor}"/>\n`;
  }

  svg += `\n  <!-- Eyes -->\n`;
  for (const pixel of eyePixels) {
    svg += `  <rect x="${pixel.x * scale}" y="${
      pixel.y * scale
    }" width="${scale}" height="${scale}" fill="${pixel.color}"/>\n`;
  }

  svg += `\n  <!-- Mouth -->\n`;
  for (const pixel of mouthPixels) {
    svg += `  <rect x="${pixel.x * scale}" y="${
      pixel.y * scale
    }" width="${scale}" height="${scale}" fill="${pixel.color}"/>\n`;
  }

  svg += `\n  <!-- Accessories -->\n`;
  for (const pixel of accessoryPixels) {
    svg += `  <rect x="${pixel.x * scale}" y="${
      pixel.y * scale
    }" width="${scale}" height="${scale}" fill="${pixel.color}"/>\n`;
  }

  svg += `</svg>`;

  return svg;
}

// ============================================
// Main execution
// ============================================

const svg = generatePunkSVG(PUNK_CONFIG);

// Paths
const scriptsDir = path.dirname(__filename);
const projectRoot = path.join(scriptsDir, "..");
const outputSvgPath = path.join(scriptsDir, "AppIcon.svg");
const iosIconPath = path.join(
  projectRoot,
  "ios",
  "App",
  "App",
  "Assets.xcassets",
  "AppIcon.appiconset",
  "AppIcon-512@2x.png"
);

// Save SVG
fs.writeFileSync(outputSvgPath, svg);
console.log(`✅ SVG saved to: ${outputSvgPath}`);

// Try to convert to PNG automatically using ImageMagick
try {
  // Try 'magick' first (ImageMagick 7), then 'convert' (ImageMagick 6)
  let magickCmd = null;

  try {
    execSync("which magick", { stdio: "ignore" });
    magickCmd = "magick";
  } catch {
    try {
      execSync("which /opt/homebrew/bin/magick", { stdio: "ignore" });
      magickCmd = "/opt/homebrew/bin/magick";
    } catch {
      try {
        execSync("which convert", { stdio: "ignore" });
        magickCmd = "convert";
      } catch {
        try {
          execSync("which /opt/homebrew/bin/convert", { stdio: "ignore" });
          magickCmd = "/opt/homebrew/bin/convert";
        } catch {
          // No ImageMagick found
        }
      }
    }
  }

  if (magickCmd) {
    const cmd = `${magickCmd} "${outputSvgPath}" -resize 1024x1024 -background "${PUNK_CONFIG.backgroundColor}" -flatten "${iosIconPath}"`;
    execSync(cmd, { stdio: "pipe" });
    console.log(`✅ PNG icon saved to: ${iosIconPath}`);
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║                 🎸 PUNK ICON GENERATED! 🎸                    ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Your punk icon has been created and installed!              ║
║                                                              ║
║  Current settings:                                           ║
║  • Background: ${PUNK_CONFIG.backgroundColor.padEnd(40)}║
║  • Skin: ${PUNK_CONFIG.skinType.padEnd(45)}║
║  • Hair: ${PUNK_CONFIG.hairStyle.padEnd(45)}║
║  • Eyes: ${PUNK_CONFIG.eyeStyle.padEnd(45)}║
║  • Mouth: ${PUNK_CONFIG.mouthStyle.padEnd(44)}║
║  • Accessory: ${PUNK_CONFIG.accessory.padEnd(40)}║
║                                                              ║
║  📱 Rebuild your iOS app to see the new icon!                ║
║                                                              ║
║  📝 Edit PUNK_CONFIG at the top of this file to customize!   ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`);
  } else {
    throw new Error("ImageMagick not found");
  }
} catch (error) {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                    🎨 SVG GENERATED!                          ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  SVG created but PNG conversion requires ImageMagick.        ║
║                                                              ║
║  Install ImageMagick:                                        ║
║    brew install imagemagick                                  ║
║                                                              ║
║  Or manually convert:                                        ║
║  1. Open scripts/AppIcon.svg in browser                      ║
║  2. Screenshot or use online converter                       ║
║  3. Save as 1024x1024 PNG to:                                ║
║     ios/App/App/Assets.xcassets/AppIcon.appiconset/          ║
║     AppIcon-512@2x.png                                       ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`);
}
