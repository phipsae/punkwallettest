const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Create OG image SVG (1200x630)
const ogSvg = `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <!-- Dark gradient background -->
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#16082e"/>
      <stop offset="100%" style="stop-color:#0a0414"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  
  <!-- Punk Avatar (scaled up, centered left) -->
  <g transform="translate(200, 115) scale(16.67)">
    <!-- Zombie skin face -->
    <rect x="8" y="10" width="8" height="8" fill="#7fd8ff"/>
    <rect x="7" y="12" width="1" height="3" fill="#7fd8ff"/>
    <rect x="16" y="12" width="1" height="3" fill="#7fd8ff"/>
    <rect x="10" y="18" width="4" height="3" fill="#7fd8ff"/>
    <rect x="11" y="13" width="2" height="2" fill="#7fd8ff"/>
    <!-- Green Mohawk -->
    <rect x="11" y="3" width="2" height="5" fill="#84cc16"/>
    <rect x="10" y="8" width="4" height="2" fill="#84cc16"/>
    <!-- Sunglasses -->
    <rect x="8" y="12" width="3" height="1" fill="#000"/>
    <rect x="13" y="12" width="3" height="1" fill="#000"/>
    <rect x="11" y="12" width="2" height="1" fill="#000"/>
    <!-- Mouth + Cigarette -->
    <rect x="11" y="15" width="2" height="1" fill="#000"/>
    <rect x="13" y="15" width="2" height="1" fill="#fff"/>
    <rect x="15" y="15" width="1" height="1" fill="#ff6600"/>
    <!-- Gold chain -->
    <rect x="10" y="18" width="4" height="1" fill="#ffd700"/>
    <rect x="11" y="19" width="2" height="1" fill="#ffd700"/>
  </g>
  
  <!-- Text -->
  <text x="620" y="270" font-family="system-ui, -apple-system, sans-serif" font-size="72" font-weight="bold" fill="#84cc16">Punk</text>
  <text x="815" y="270" font-family="system-ui, -apple-system, sans-serif" font-size="72" font-weight="bold" fill="#ffffff">Wallet</text>
  
  <text x="620" y="340" font-family="system-ui, -apple-system, sans-serif" font-size="28" fill="#a0a0a0">Self-custodial Ethereum wallet</text>
  <text x="620" y="380" font-family="system-ui, -apple-system, sans-serif" font-size="28" fill="#a0a0a0">secured by passkeys</text>
  
  <!-- Features -->
  <text x="620" y="460" font-family="system-ui, -apple-system, sans-serif" font-size="22" fill="#84cc16">✓</text>
  <text x="650" y="460" font-family="system-ui, -apple-system, sans-serif" font-size="22" fill="#ffffff">No seed phrases</text>
  
  <text x="850" y="460" font-family="system-ui, -apple-system, sans-serif" font-size="22" fill="#84cc16">✓</text>
  <text x="880" y="460" font-family="system-ui, -apple-system, sans-serif" font-size="22" fill="#ffffff">Face ID / Touch ID</text>
  
  <text x="620" y="500" font-family="system-ui, -apple-system, sans-serif" font-size="22" fill="#84cc16">✓</text>
  <text x="650" y="500" font-family="system-ui, -apple-system, sans-serif" font-size="22" fill="#ffffff">WalletConnect</text>
  
  <text x="850" y="500" font-family="system-ui, -apple-system, sans-serif" font-size="22" fill="#84cc16">✓</text>
  <text x="880" y="500" font-family="system-ui, -apple-system, sans-serif" font-size="22" fill="#ffffff">Self-custodial</text>
</svg>`;

// Save SVG
const svgPath = path.join(__dirname, 'og-image.svg');
fs.writeFileSync(svgPath, ogSvg);
console.log('✅ OG SVG saved');

// Convert to PNG
const pngPath = path.join(__dirname, '..', 'public', 'og-image.png');
try {
  execSync(`/opt/homebrew/bin/magick "${svgPath}" -resize 1200x630 "${pngPath}"`, { stdio: 'pipe' });
  console.log('✅ OG image saved to: public/og-image.png');
} catch (e) {
  console.log('❌ Could not convert to PNG. Install ImageMagick or convert manually.');
}
