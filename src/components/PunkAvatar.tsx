"use client";

import { useMemo } from "react";

interface PunkAvatarProps {
  address: string;
  size?: number;
  className?: string;
}

// CryptoPunk-style pixel art generator based on address
// This creates a deterministic punk based on the wallet address hash
export function PunkAvatar({
  address,
  size = 64,
  className = "",
}: PunkAvatarProps) {
  const punkData = useMemo(() => generatePunkFromAddress(address), [address]);

  // Calculate pixel size for crisp rendering
  const pixelSize = size / 24; // 24x24 grid

  return (
    <div
      className={`punk-avatar ${className}`}
      style={{
        width: size,
        height: size,
        backgroundColor: punkData.backgroundColor,
        borderRadius: "2px",
        overflow: "hidden",
        imageRendering: "pixelated",
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        style={{ imageRendering: "pixelated" }}
      >
        {/* Background */}
        <rect width="24" height="24" fill={punkData.backgroundColor} />

        {/* Skin */}
        {punkData.skinPixels.map((pixel, i) => (
          <rect
            key={`skin-${i}`}
            x={pixel.x}
            y={pixel.y}
            width="1"
            height="1"
            fill={punkData.skinColor}
          />
        ))}

        {/* Hair */}
        {punkData.hairPixels.map((pixel, i) => (
          <rect
            key={`hair-${i}`}
            x={pixel.x}
            y={pixel.y}
            width="1"
            height="1"
            fill={punkData.hairColor}
          />
        ))}

        {/* Eyes */}
        {punkData.eyePixels.map((pixel, i) => (
          <rect
            key={`eye-${i}`}
            x={pixel.x}
            y={pixel.y}
            width="1"
            height="1"
            fill={pixel.color}
          />
        ))}

        {/* Mouth */}
        {punkData.mouthPixels.map((pixel, i) => (
          <rect
            key={`mouth-${i}`}
            x={pixel.x}
            y={pixel.y}
            width="1"
            height="1"
            fill={pixel.color}
          />
        ))}

        {/* Accessories */}
        {punkData.accessoryPixels.map((pixel, i) => (
          <rect
            key={`acc-${i}`}
            x={pixel.x}
            y={pixel.y}
            width="1"
            height="1"
            fill={pixel.color}
          />
        ))}
      </svg>
    </div>
  );
}

interface Pixel {
  x: number;
  y: number;
  color?: string;
}

interface PunkData {
  backgroundColor: string;
  skinColor: string;
  hairColor: string;
  skinPixels: Pixel[];
  hairPixels: Pixel[];
  eyePixels: Pixel[];
  mouthPixels: Pixel[];
  accessoryPixels: Pixel[];
}

// Background colors - vibrant punk-style backgrounds
const BACKGROUNDS = [
  "#639bff", // Blue
  "#c9a0ff", // Purple
  "#ff638d", // Pink
  "#8bff63", // Green
  "#ffb863", // Orange
  "#63fff2", // Cyan
  "#ff6363", // Red
  "#ffe063", // Yellow
];

// Skin tones
const SKIN_TONES = [
  "#ffd8b1", // Light
  "#e0b088", // Medium light
  "#c68f5a", // Medium
  "#a57038", // Medium dark
  "#8b5a2b", // Dark
  "#5c3a1e", // Darker
  "#71aa34", // Alien green
  "#7fd8ff", // Zombie blue
  "#ffd700", // Ape gold
];

// Hair colors
const HAIR_COLORS = [
  "#000000", // Black
  "#4a3728", // Dark brown
  "#8b4513", // Brown
  "#ffd700", // Blonde
  "#ff6347", // Red
  "#9400d3", // Purple
  "#00ced1", // Cyan
  "#ff1493", // Hot pink
  "#c0c0c0", // Silver
  "#ffffff", // White
];

// Generate deterministic random from address
function hashAddress(address: string): number[] {
  const hash: number[] = [];
  const cleanAddr = address.toLowerCase().replace("0x", "");

  for (let i = 0; i < cleanAddr.length; i += 2) {
    hash.push(parseInt(cleanAddr.substr(i, 2), 16));
  }

  return hash;
}

// Seeded random based on hash
function seededRandom(hash: number[], index: number): number {
  const idx = index % hash.length;
  return hash[idx] / 255;
}

// Hair style generators
const HAIR_STYLES = [
  // Mohawk
  (hash: number[]) => {
    const pixels: Pixel[] = [];
    for (let y = 3; y < 8; y++) {
      pixels.push({ x: 11, y });
      pixels.push({ x: 12, y });
    }
    for (let y = 8; y < 10; y++) {
      for (let x = 10; x < 14; x++) {
        pixels.push({ x, y });
      }
    }
    return pixels;
  },
  // Messy
  (hash: number[]) => {
    const pixels: Pixel[] = [];
    for (let x = 8; x < 16; x++) {
      const topY = 7 + Math.floor(seededRandom(hash, x) * 3) - 1;
      for (let y = topY; y < 10; y++) {
        pixels.push({ x, y });
      }
    }
    // Side hair
    for (let y = 10; y < 15; y++) {
      if (seededRandom(hash, y) > 0.5) pixels.push({ x: 7, y });
      if (seededRandom(hash, y + 10) > 0.5) pixels.push({ x: 16, y });
    }
    return pixels;
  },
  // Bald
  () => [],
  // Top spiky
  (hash: number[]) => {
    const pixels: Pixel[] = [];
    for (let x = 8; x < 16; x++) {
      const spike = x % 2 === 0;
      const topY = spike ? 5 : 7;
      for (let y = topY; y < 10; y++) {
        pixels.push({ x, y });
      }
    }
    return pixels;
  },
  // Wild
  (hash: number[]) => {
    const pixels: Pixel[] = [];
    for (let x = 6; x < 18; x++) {
      const topY = 5 + Math.floor(seededRandom(hash, x) * 5);
      for (let y = topY; y < 10; y++) {
        pixels.push({ x, y });
      }
    }
    // Extra wild strands
    for (let i = 0; i < 5; i++) {
      const x = 6 + Math.floor(seededRandom(hash, i + 30) * 12);
      const y = 4 + Math.floor(seededRandom(hash, i + 40) * 3);
      pixels.push({ x, y });
    }
    return pixels;
  },
  // Cap/beanie
  (hash: number[]) => {
    const pixels: Pixel[] = [];
    for (let x = 7; x < 17; x++) {
      for (let y = 6; y < 10; y++) {
        pixels.push({ x, y });
      }
    }
    // Brim
    for (let x = 6; x < 18; x++) {
      pixels.push({ x, y: 10 });
    }
    return pixels;
  },
  // Pigtails
  (hash: number[]) => {
    const pixels: Pixel[] = [];
    // Top
    for (let x = 8; x < 16; x++) {
      for (let y = 7; y < 10; y++) {
        pixels.push({ x, y });
      }
    }
    // Left pigtail
    for (let y = 10; y < 18; y++) {
      pixels.push({ x: 6, y });
      pixels.push({ x: 7, y });
    }
    // Right pigtail
    for (let y = 10; y < 18; y++) {
      pixels.push({ x: 16, y });
      pixels.push({ x: 17, y });
    }
    return pixels;
  },
  // Hoodie
  (hash: number[]) => {
    const pixels: Pixel[] = [];
    // Top of hood
    for (let x = 6; x < 18; x++) {
      for (let y = 5; y < 10; y++) {
        pixels.push({ x, y });
      }
    }
    // Sides of hood going down
    for (let y = 10; y < 19; y++) {
      pixels.push({ x: 5, y });
      pixels.push({ x: 6, y });
      pixels.push({ x: 17, y });
      pixels.push({ x: 18, y });
    }
    return pixels;
  },
];

// Eye styles
const EYE_STYLES = [
  // Normal
  () => [
    { x: 9, y: 12, color: "#000000" },
    { x: 14, y: 12, color: "#000000" },
  ],
  // Sunglasses
  () => [
    { x: 8, y: 12, color: "#000000" },
    { x: 9, y: 12, color: "#111111" },
    { x: 10, y: 12, color: "#000000" },
    { x: 13, y: 12, color: "#000000" },
    { x: 14, y: 12, color: "#111111" },
    { x: 15, y: 12, color: "#000000" },
    { x: 11, y: 12, color: "#000000" },
    { x: 12, y: 12, color: "#000000" },
  ],
  // 3D glasses
  () => [
    { x: 8, y: 12, color: "#ff0000" },
    { x: 9, y: 12, color: "#ff0000" },
    { x: 10, y: 12, color: "#ff0000" },
    { x: 11, y: 12, color: "#000000" },
    { x: 12, y: 12, color: "#000000" },
    { x: 13, y: 12, color: "#00ffff" },
    { x: 14, y: 12, color: "#00ffff" },
    { x: 15, y: 12, color: "#00ffff" },
  ],
  // Big eyes
  () => [
    { x: 9, y: 11, color: "#ffffff" },
    { x: 9, y: 12, color: "#000000" },
    { x: 14, y: 11, color: "#ffffff" },
    { x: 14, y: 12, color: "#000000" },
  ],
  // VR headset
  () => [
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
  ],
  // Laser eyes
  () => [
    { x: 9, y: 12, color: "#ff0000" },
    { x: 14, y: 12, color: "#ff0000" },
    { x: 8, y: 12, color: "#ff6666" },
    { x: 15, y: 12, color: "#ff6666" },
  ],
];

// Mouth styles
const MOUTH_STYLES = [
  // Neutral
  () => [
    { x: 11, y: 15, color: "#000000" },
    { x: 12, y: 15, color: "#000000" },
  ],
  // Smile
  () => [
    { x: 10, y: 15, color: "#000000" },
    { x: 11, y: 16, color: "#000000" },
    { x: 12, y: 16, color: "#000000" },
    { x: 13, y: 15, color: "#000000" },
  ],
  // Cigarette
  () => [
    { x: 11, y: 15, color: "#000000" },
    { x: 12, y: 15, color: "#000000" },
    { x: 13, y: 15, color: "#ffffff" },
    { x: 14, y: 15, color: "#ffffff" },
    { x: 15, y: 15, color: "#ff6600" },
  ],
  // Open mouth
  () => [
    { x: 10, y: 15, color: "#000000" },
    { x: 11, y: 15, color: "#8b0000" },
    { x: 12, y: 15, color: "#8b0000" },
    { x: 13, y: 15, color: "#000000" },
    { x: 11, y: 16, color: "#000000" },
    { x: 12, y: 16, color: "#000000" },
  ],
  // Pipe
  () => [
    { x: 11, y: 15, color: "#000000" },
    { x: 12, y: 15, color: "#8b4513" },
    { x: 13, y: 15, color: "#8b4513" },
    { x: 14, y: 15, color: "#8b4513" },
    { x: 14, y: 14, color: "#8b4513" },
    { x: 14, y: 13, color: "#8b4513" },
  ],
];

// Accessory generators
const ACCESSORIES = [
  // None
  () => [],
  // Earring
  () => [{ x: 7, y: 14, color: "#ffd700" }],
  // Chain
  () => [
    { x: 10, y: 18, color: "#ffd700" },
    { x: 11, y: 18, color: "#ffd700" },
    { x: 12, y: 18, color: "#ffd700" },
    { x: 13, y: 18, color: "#ffd700" },
    { x: 11, y: 19, color: "#ffd700" },
    { x: 12, y: 19, color: "#ffd700" },
  ],
  // Nose ring
  () => [{ x: 12, y: 14, color: "#ffd700" }],
  // Bandana
  (hash: number[]) => {
    const color =
      HAIR_COLORS[Math.floor(seededRandom(hash, 50) * HAIR_COLORS.length)];
    return [
      { x: 7, y: 10, color },
      { x: 8, y: 10, color },
      { x: 9, y: 10, color },
      { x: 10, y: 10, color },
      { x: 11, y: 10, color },
      { x: 12, y: 10, color },
      { x: 13, y: 10, color },
      { x: 14, y: 10, color },
      { x: 15, y: 10, color },
      { x: 16, y: 10, color },
      { x: 6, y: 11, color },
      { x: 5, y: 12, color },
    ];
  },
  // Choker
  () => [
    { x: 9, y: 17, color: "#000000" },
    { x: 10, y: 17, color: "#000000" },
    { x: 11, y: 17, color: "#ff0000" },
    { x: 12, y: 17, color: "#ff0000" },
    { x: 13, y: 17, color: "#000000" },
    { x: 14, y: 17, color: "#000000" },
  ],
];

function generatePunkFromAddress(address: string): PunkData {
  const hash = hashAddress(address);

  // Select colors based on hash
  const bgIndex = Math.floor(seededRandom(hash, 0) * BACKGROUNDS.length);
  const skinIndex = Math.floor(seededRandom(hash, 1) * SKIN_TONES.length);
  const hairColorIndex = Math.floor(seededRandom(hash, 2) * HAIR_COLORS.length);

  const backgroundColor = BACKGROUNDS[bgIndex];
  const skinColor = SKIN_TONES[skinIndex];
  const hairColor = HAIR_COLORS[hairColorIndex];

  // Generate base face shape (same for all punks)
  const skinPixels: Pixel[] = [];

  // Face - more detailed punk-style
  for (let y = 10; y < 18; y++) {
    for (let x = 8; x < 16; x++) {
      // Skip eyes area
      if (y === 12 && (x === 9 || x === 14)) continue;
      // Skip mouth area
      if (y >= 15 && y <= 16 && x >= 10 && x <= 13) continue;
      skinPixels.push({ x, y });
    }
  }

  // Neck
  for (let y = 18; y < 21; y++) {
    for (let x = 10; x < 14; x++) {
      skinPixels.push({ x, y });
    }
  }

  // Ears
  skinPixels.push({ x: 7, y: 12 });
  skinPixels.push({ x: 7, y: 13 });
  skinPixels.push({ x: 7, y: 14 });
  skinPixels.push({ x: 16, y: 12 });
  skinPixels.push({ x: 16, y: 13 });
  skinPixels.push({ x: 16, y: 14 });

  // Nose
  skinPixels.push({ x: 11, y: 13 });
  skinPixels.push({ x: 12, y: 13 });
  skinPixels.push({ x: 11, y: 14 });
  skinPixels.push({ x: 12, y: 14 });

  // Select styles based on hash
  const hairStyleIndex = Math.floor(seededRandom(hash, 3) * HAIR_STYLES.length);
  const eyeStyleIndex = Math.floor(seededRandom(hash, 4) * EYE_STYLES.length);
  const mouthStyleIndex = Math.floor(
    seededRandom(hash, 5) * MOUTH_STYLES.length
  );
  const accessoryIndex = Math.floor(seededRandom(hash, 6) * ACCESSORIES.length);

  const hairPixels = HAIR_STYLES[hairStyleIndex](hash);
  const eyePixels = EYE_STYLES[eyeStyleIndex]();
  const mouthPixels = MOUTH_STYLES[mouthStyleIndex]();
  const accessoryPixels = ACCESSORIES[accessoryIndex](hash);

  return {
    backgroundColor,
    skinColor,
    hairColor,
    skinPixels,
    hairPixels,
    eyePixels,
    mouthPixels,
    accessoryPixels,
  };
}

// Export a simpler blockie-style generator for smaller sizes
export function PunkBlockie({
  address,
  size = 32,
  className = "",
}: PunkAvatarProps) {
  const colors = useMemo(() => {
    const hash = hashAddress(address);
    return {
      bg: BACKGROUNDS[Math.floor(seededRandom(hash, 0) * BACKGROUNDS.length)],
      primary:
        SKIN_TONES[Math.floor(seededRandom(hash, 1) * SKIN_TONES.length)],
      secondary:
        HAIR_COLORS[Math.floor(seededRandom(hash, 2) * HAIR_COLORS.length)],
    };
  }, [address]);

  const pattern = useMemo(() => {
    const hash = hashAddress(address);
    const pixels: boolean[][] = [];

    // 8x8 grid, mirrored horizontally
    for (let y = 0; y < 8; y++) {
      pixels[y] = [];
      for (let x = 0; x < 4; x++) {
        const val = seededRandom(hash, y * 4 + x) > 0.5;
        pixels[y][x] = val;
        pixels[y][7 - x] = val; // Mirror
      }
    }

    return pixels;
  }, [address]);

  const pixelSize = size / 8;

  return (
    <div
      className={`punk-blockie ${className}`}
      style={{
        width: size,
        height: size,
        borderRadius: "2px",
        overflow: "hidden",
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 8 8"
        style={{ imageRendering: "pixelated" }}
      >
        <rect width="8" height="8" fill={colors.bg} />
        {pattern.map((row, y) =>
          row.map((filled, x) =>
            filled ? (
              <rect
                key={`${x}-${y}`}
                x={x}
                y={y}
                width="1"
                height="1"
                fill={y < 4 ? colors.secondary : colors.primary}
              />
            ) : null
          )
        )}
      </svg>
    </div>
  );
}

export default PunkAvatar;
