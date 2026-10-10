module.exports = {
  M04: `<svg width="420" height="330" viewBox="-40 -300 420 330" font-family="Times New Roman" font-size="18">
 <line x1="-20" y1="0" x2="360" y2="0" stroke="#000" stroke-width="1.5" marker-end="url(#a)"/><line x1="0" y1="20" x2="0" y2="-280" stroke="#000" stroke-width="1.5" marker-end="url(#a)"/>
 <defs><marker id="a" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 z"/></marker></defs>
 ${[1, 2, 3, 4].map((i) => `<line x1="${i * 70}" y1="0" x2="${i * 70}" y2="5" stroke="#000"/><text x="${i * 70 - 5}" y="24">${i}</text><line x1="0" y1="${-i * 70}" x2="-5" y2="${-i * 70}" stroke="#000"/><text x="-22" y="${-i * 70 + 6}">${i}</text>`).join('')}
 ${[1, 2, 3, 4].map((i) => `<line x1="${i * 70}" y1="0" x2="${i * 70}" y2="-280" stroke="#bbb" stroke-dasharray="3,4"/><line x1="0" y1="${-i * 70}" x2="300" y2="${-i * 70}" stroke="#bbb" stroke-dasharray="3,4"/>`).join('')}
 <polyline points="0,-140 140,0 210,-70 280,-210" fill="none" stroke="#000" stroke-width="2.5"/>
 <text x="-18" y="20">O</text><text x="350" y="22" font-style="italic">x</text><text x="8" y="-282" font-style="italic">y</text><text x="285" y="-215" font-style="italic">y=f(x)</text></svg>`,
  M11: `<svg width="460" height="400" viewBox="0 0 460 400" font-family="Times New Roman" font-size="20">
 <g stroke="#000" stroke-width="1.8" fill="none">
 <polyline points="130,330 330,330 400,270 400,70 330,130 130,130 130,330"/><line x1="330" y1="330" x2="330" y2="130"/><line x1="130" y1="130" x2="200" y2="70"/><line x1="200" y1="70" x2="400" y2="70"/>
 <line x1="130" y1="330" x2="200" y2="270" stroke-dasharray="6,5"/><line x1="200" y1="270" x2="400" y2="270" stroke-dasharray="6,5"/><line x1="200" y1="270" x2="200" y2="70" stroke-dasharray="6,5"/></g>
 <defs><marker id="b" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 z"/></marker></defs>
 <g stroke="#1a4fb3" stroke-width="1.6" marker-end="url(#b)"><line x1="200" y1="270" x2="80" y2="375"/><line x1="200" y1="270" x2="455" y2="270"/><line x1="200" y1="270" x2="200" y2="20"/></g>
 <text x="66" y="372" fill="#1a4fb3" font-style="italic">x</text><text x="440" y="262" fill="#1a4fb3" font-style="italic">y</text><text x="208" y="28" fill="#1a4fb3" font-style="italic">z</text>
 <text x="205" y="292">D</text><text x="108" y="345">A</text><text x="335" y="352">B</text><text x="405" y="292">C</text>
 <text x="180" y="62">D₁</text><text x="100" y="125">A₁</text><text x="336" y="152">B₁</text><text x="405" y="64">C₁</text></svg>`,
  P01: `<svg width="420" height="250" viewBox="0 0 420 250" font-family="Times New Roman" font-size="20"><polygon points="20,220 400,220 400,40" fill="#eee" stroke="#000" stroke-width="2"/>
 <g transform="translate(230,140) rotate(-25.3)"><rect x="-35" y="-52" width="70" height="50" fill="#fff" stroke="#000" stroke-width="2"/><text x="-10" y="-20" font-style="italic">m</text></g>
 <path d="M80,220 A60,60 0 0,0 74,195" fill="none" stroke="#000"/><text x="88" y="212" font-style="italic">θ</text></svg>`,
  P02: `<svg width="480" height="300" viewBox="0 0 480 300" font-family="Times New Roman" font-size="20"><g stroke="#000" stroke-width="2" fill="none">
 <polyline points="60,60 60,240 200,240"/><line x1="230" y1="240" x2="420" y2="240"/><polyline points="420,240 420,60 360,60"/><line x1="280" y1="60" x2="240" y2="60"/><line x1="160" y1="60" x2="120" y2="60"/><line x1="90" y1="60" x2="60" y2="60"/>
 <rect x="280" y="45" width="80" height="30" fill="#fff"/><rect x="160" y="45" width="80" height="30" fill="#fff"/>
 <line x1="200" y1="225" x2="200" y2="255"/><line x1="230" y1="232" x2="230" y2="248" stroke-width="4"/>
 <line x1="90" y1="60" x2="118" y2="44"/><circle cx="90" cy="60" r="3" fill="#000"/><circle cx="120" cy="60" r="3" fill="#000"/>
 <circle cx="420" cy="150" r="18" fill="#fff"/></g>
 <text x="190" y="40">R₁</text><text x="310" y="40">R₂</text><text x="196" y="285">E, r</text><text x="96" y="35">S</text><text x="412" y="157">A</text></svg>`,
};
