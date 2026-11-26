// A drawing of each of the six positions, as SVG markup: line drawings in the text colour
// (currentColor) on a 64 × 64 grid, so that they follow light and dark mode. The four upright
// positions show the watch face-on, standing on a ground line with the crown pointing the named
// way. The two flat positions show it from a little above, lying on the ground line: dial up
// shows the dial and hands; dial down shows the case back, shaded, with the crown on the left
// because the watch has been turned over. Nothing here touches the page.

/** @typedef {import('./positions.js').PositionId} PositionId */

const STROKE = 'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"';
const GROUND_Y = 58;
/** Half the stroke width, so that what stands on the ground line touches it. */
const ON_GROUND = 1.1;
/** Half the width of a strap stub. */
const STRAP = 8;

/** @param {number} n */
const f = (n) => Number(n.toFixed(2));

/**
 * A point on a clock face, `deg` degrees clockwise from 12, squashed vertically by `squash`.
 * @param {number} deg
 * @param {number} r
 * @param {number} [squash]
 * @returns {[number, number]} offset from the centre
 */
function onFace(deg, r, squash = 1) {
  const a = (deg * Math.PI) / 180;
  return [f(r * Math.sin(a)), f(-r * squash * Math.cos(a))];
}

/** The watch face-on, crown at 3 o'clock, centred on 0,0, before it is turned. */
function faceOn() {
  const [hx, hy] = onFace(305, 7.5);
  const [mx, my] = onFace(60, 11);
  return [
    // Strap stubs at 12 and 6.
    `<path d="M${-STRAP} -16.5 L${-STRAP} -23 L${STRAP} -23 L${STRAP} -16.5 M${-STRAP} 16.5 L${-STRAP} 23 L${STRAP} 23 L${STRAP} 16.5"/>`,
    // Case and crown.
    '<circle r="17"/>',
    '<rect x="17" y="-3.5" width="4.5" height="7" rx="1.2" fill="currentColor"/>',
    // Hour marks at 12, 3, 6 and 9, and the hands at 10:10.
    '<path d="M0 -13.5 L0 -10.5 M13.5 0 L10.5 0 M0 13.5 L0 10.5 M-13.5 0 L-10.5 0" stroke-width="1.8"/>',
    `<path d="M${hx} ${hy} L0 0 L${mx} ${my}"/>`,
    '<circle r="1.4" fill="currentColor" stroke="none"/>',
  ].join('');
}

/** How far each upright position turns the face-on watch, and how far its lowest point lies below
 *  the centre (the case, the crown or a strap stub), so that it stands on the ground line. */
const UPRIGHT = /** @type {Record<string, {turn: number, below: number}>} */ ({
  crownUp: { turn: -90, below: 17 },
  crownDown: { turn: 90, below: 21.5 },
  crownLeft: { turn: 180, below: 23 },
  crownRight: { turn: 0, below: 23 },
});

/** @param {{turn: number, below: number}} pose */
function upright(pose) {
  return `<g transform="translate(32 ${f(GROUND_Y - ON_GROUND - pose.below)}) rotate(${pose.turn})">${faceOn()}</g>`;
}

/**
 * The watch lying flat, seen from a little above: a short cylinder whose round faces are squashed
 * to ellipses, with a strap stub rising behind it at 12 and coming down in front of it at 6 to the
 * ground, as a strap does when a watch lies on a table.
 * @param {boolean} dialUp
 */
function flat(dialUp) {
  const cx = 32;
  const rx = 21;
  const squash = 0.42;
  const ry = rx * squash;
  const depth = 6;
  const stub = 5;
  // How far the case's edge lies above or below its centre line where the stubs meet it.
  const edge = ry * Math.sqrt(1 - (STRAP / rx) ** 2);
  const top = GROUND_Y - ON_GROUND - stub - depth - edge;
  const bottom = top + depth;
  const inner = rx - 4;
  const parts = [
    `<path d="M${cx - STRAP} ${f(top - edge)} L${cx - STRAP} ${f(top - ry - 5)} L${cx + STRAP} ${f(top - ry - 5)} L${cx + STRAP} ${f(top - edge)}"/>`,
    `<path d="M${cx - STRAP} ${f(bottom + edge)} L${cx - STRAP} ${f(bottom + edge + stub)} L${cx + STRAP} ${f(bottom + edge + stub)} L${cx + STRAP} ${f(bottom + edge)}"/>`,
    // The case's side band, then its top face.
    `<path d="M${cx - rx} ${f(top)} L${cx - rx} ${f(bottom)} A${rx} ${f(ry)} 0 0 0 ${cx + rx} ${f(bottom)} L${cx + rx} ${f(top)}"/>`,
    `<ellipse cx="${cx}" cy="${f(top)}" rx="${rx}" ry="${f(ry)}"/>`,
    // The crown, on the side band: on the right dial up, on the left once turned over.
    `<rect x="${f(dialUp ? cx + rx : cx - rx - 4.5)}" y="${f(top + depth / 2 - 2.6)}" width="4.5" height="5.2" rx="1.2" fill="currentColor"/>`,
  ];
  if (dialUp) {
    /** @param {number} deg @param {number} r */
    const at = (deg, r) => {
      const [x, y] = onFace(deg, r, squash);
      return `${f(cx + x)} ${f(top + y)}`;
    };
    parts.push(`<path d="${[0, 90, 180, 270].map((d) => `M${at(d, inner)} L${at(d, inner - 3)}`).join(' ')}" stroke-width="1.8"/>`);
    parts.push(`<path d="M${at(305, 8)} L${cx} ${f(top)} L${at(60, 12)}"/>`);
    parts.push(`<ellipse cx="${cx}" cy="${f(top)}" rx="1.5" ry="1.1" fill="currentColor" stroke="none"/>`);
  } else {
    // The case back: shaded, with a plate and four screws, and no hands.
    parts.push(`<ellipse cx="${cx}" cy="${f(top)}" rx="${rx}" ry="${f(ry)}" fill="currentColor" fill-opacity="0.22" stroke="none"/>`);
    parts.push(`<ellipse cx="${cx}" cy="${f(top)}" rx="${inner}" ry="${f(inner * squash)}" stroke-width="1.8"/>`);
    for (const d of [45, 135, 225, 315]) {
      const [x, y] = onFace(d, inner + 2, squash);
      parts.push(`<ellipse cx="${f(cx + x)}" cy="${f(top + y)}" rx="1.3" ry="1" fill="currentColor" stroke="none"/>`);
    }
  }
  return parts.join('');
}

const GROUND = `<path d="M6 ${GROUND_Y} L58 ${GROUND_Y}" stroke-width="1.8" opacity="0.55"/>`;

/**
 * @param {PositionId} id
 * @returns {string} the drawing, as an <svg> element hidden from screen readers: the position's
 *   name is always written beside it
 */
function draw(id) {
  const body = id === 'dialUp' ? flat(true) : id === 'dialDown' ? flat(false) : upright(UPRIGHT[id]);
  return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><g ${STROKE}>${GROUND}${body}</g></svg>`;
}

/** The drawing of each position. */
export const POSITION_ICONS = /** @type {Readonly<Record<PositionId, string>>} */ (
  Object.freeze({
    dialUp: draw('dialUp'),
    dialDown: draw('dialDown'),
    crownUp: draw('crownUp'),
    crownDown: draw('crownDown'),
    crownLeft: draw('crownLeft'),
    crownRight: draw('crownRight'),
  })
);
