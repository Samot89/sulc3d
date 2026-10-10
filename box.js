// Generátor sítě krabičky s přihrádkami (používá konfigurátor /krabicky).
// Síť je uzavřená a všechny díly sdílejí vrcholy, takže ji slicer bere bez oprav.
(function (root) {
  let ARC_STEPS = 10;                   // dílků na čtvrtkruh rohu, buildBox je volí podle poloměru
  const QUARTER = [[1, 0], [0, 1], [-1, 0], [0, -1]]; // přesné směry pro 0°, 90°, 180°, 270°

  // Jednotkový směr pro úhel (q + k / ARC_STEPS) · 90°, na koncích čtvrtkruhu přesně osový
  function dir(q, k) {
    if (k === 0) return QUARTER[q % 4];
    if (k === ARC_STEPS) return QUARTER[(q + 1) % 4];
    const a = (q + k / ARC_STEPS) * Math.PI / 2;
    return [Math.cos(a), Math.sin(a)];
  }

  // Body rohu dutiny: čtvrtkruh o poloměru ri, nebo jediný ostrý bod (pak s úhlopříčnou "normálou").
  // corner: 0 = levý dolní, 1 = pravý dolní, 2 = pravý horní, 3 = levý horní (proti směru hodin).
  function cornerPoints(corner, x, y, ri) {
    const sx = corner === 0 || corner === 3 ? -1 : 1, sy = corner < 2 ? -1 : 1;
    if (!(ri > 0)) return [{ x, y, nx: sx, ny: sy }];
    const cx = x - sx * ri, cy = y - sy * ri, q = (corner + 2) % 4;
    const pts = [];
    for (let k = 0; k <= ARC_STEPS; k++) {
      const d = dir(q, k);
      pts.push({ x: cx + ri * d[0], y: cy + ri * d[1], nx: d[0], ny: d[1] });
    }
    return pts;
  }

  /**
   * Krabička otevřená nahoru, dutina leží v x ∈ [0, w], y ∈ [0, d], dno na z = 0.
   * o: { w, d, h – vnitřní rozměry, wall – stěna, floor – dno, ri – vnitřní poloměr rohů,
   *      nx, ny – počet přihrádek, div – tloušťka přepážek }
   * Vrací Float32Array, 9 čísel na trojúhelník.
   */
  function buildBox(o) {
    const { w, d, h, wall, floor } = o;
    const nx = o.nx || 1, ny = o.ny || 1, div = o.div || 0;
    const ri = Math.max(0, Math.min(o.ri || 0, w / 2, d / 2));
    ARC_STEPS = Math.max(6, Math.min(24, Math.round(ri * 1.5)));
    const zf = floor, zt = floor + h;
    const out = [];
    const tri = (a, b, c) => {
      // vynechat trojúhelníky s nulovou plochou (splývající vrcholy)
      if ((a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) || (b[0] === c[0] && b[1] === c[1] && b[2] === c[2]) ||
          (a[0] === c[0] && a[1] === c[1] && a[2] === c[2])) return;
      out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    };

    // hranice přihrádek v obou osách
    const spans = (n, total) => {
      const size = (total - (n - 1) * div) / n, a = [], b = [];
      for (let i = 0; i < n; i++) { a.push(i * (size + div)); b.push(i === n - 1 ? total : i * (size + div) + size); }
      return { a, b };
    };
    const X = spans(nx, w), Y = spans(ny, d);

    // obrys dutiny proti směru hodin, včetně bodů, kde se přepážky napojují na stěnu
    const inner = [];
    inner.push(...cornerPoints(0, 0, 0, ri));
    for (let i = 0; i < nx - 1; i++) inner.push({ x: X.b[i], y: 0, nx: 0, ny: -1 }, { x: X.a[i + 1], y: 0, nx: 0, ny: -1 });
    inner.push(...cornerPoints(1, w, 0, ri));
    for (let j = 0; j < ny - 1; j++) inner.push({ x: w, y: Y.b[j], nx: 1, ny: 0 }, { x: w, y: Y.a[j + 1], nx: 1, ny: 0 });
    inner.push(...cornerPoints(2, w, d, ri));
    for (let i = nx - 1; i > 0; i--) inner.push({ x: X.a[i], y: d, nx: 0, ny: 1 }, { x: X.b[i - 1], y: d, nx: 0, ny: 1 });
    inner.push(...cornerPoints(3, 0, d, ri));
    for (let j = ny - 1; j > 0; j--) inner.push({ x: 0, y: Y.a[j], nx: -1, ny: 0 }, { x: 0, y: Y.b[j - 1], nx: -1, ny: 0 });
    const outer = inner.map(p => ({ x: p.x + p.nx * wall, y: p.y + p.ny * wall }));
    const N = inner.length;

    for (let k = 0; k < N; k++) {
      const i0 = inner[k], i1 = inner[(k + 1) % N], o0 = outer[k], o1 = outer[(k + 1) % N];
      // horní hrana stěny
      tri([i0.x, i0.y, zt], [o0.x, o0.y, zt], [o1.x, o1.y, zt]);
      tri([i0.x, i0.y, zt], [o1.x, o1.y, zt], [i1.x, i1.y, zt]);
      // vnější plášť
      tri([o0.x, o0.y, 0], [o1.x, o1.y, 0], [o1.x, o1.y, zt]);
      tri([o0.x, o0.y, 0], [o1.x, o1.y, zt], [o0.x, o0.y, zt]);
      // spodek dna
      tri([w / 2, d / 2, 0], [o1.x, o1.y, 0], [o0.x, o0.y, 0]);
    }

    // přihrádky: stěny dovnitř a dno
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      const xa = X.a[i], xb = X.b[i], ya = Y.a[j], yb = Y.b[j];
      const first = (i === 0), last = (i === nx - 1), bottom = (j === 0), top = (j === ny - 1);
      const poly = [
        ...cornerPoints(0, xa, ya, first && bottom ? ri : 0),
        ...cornerPoints(1, xb, ya, last && bottom ? ri : 0),
        ...cornerPoints(2, xb, yb, last && top ? ri : 0),
        ...cornerPoints(3, xa, yb, first && top ? ri : 0)
      ];
      const cx = (xa + xb) / 2, cy = (ya + yb) / 2;
      for (let k = 0; k < poly.length; k++) {
        const a = poly[k], b = poly[(k + 1) % poly.length];
        tri([a.x, a.y, zf], [b.x, b.y, zt], [b.x, b.y, zf]);
        tri([a.x, a.y, zf], [a.x, a.y, zt], [b.x, b.y, zt]);
        tri([cx, cy, zf], [a.x, a.y, zf], [b.x, b.y, zf]);
      }
    }

    // horní plochy přepážek: obdélníky mřížky, kde aspoň jedna osa leží v přepážce
    const cuts = S => {
      const list = [];
      for (let i = 0; i < S.a.length; i++) {
        list.push({ a: S.a[i], b: S.b[i], gap: false });
        if (i < S.a.length - 1) list.push({ a: S.b[i], b: S.a[i + 1], gap: true });
      }
      return list;
    };
    for (const cx of cuts(X)) for (const cy of cuts(Y)) {
      if (!cx.gap && !cy.gap) continue;
      tri([cx.a, cy.a, zt], [cx.b, cy.a, zt], [cx.b, cy.b, zt]);
      tri([cx.a, cy.a, zt], [cx.b, cy.b, zt], [cx.a, cy.b, zt]);
    }

    return new Float32Array(out);
  }

  // Posun a volitelné otočení o 180° kolem osy X (víko nasazené na krabičce)
  function place(pos, dx, dy, dz, flip) {
    const out = new Float32Array(pos.length);
    for (let i = 0; i < pos.length; i += 3) {
      out[i] = pos[i] + dx;
      out[i + 1] = (flip ? -pos[i + 1] : pos[i + 1]) + dy;
      out[i + 2] = (flip ? -pos[i + 2] : pos[i + 2]) + dz;
    }
    return out;
  }

  function join(...parts) {
    const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }

  const api = { buildBox, place, join };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Sulc3DBox = api;
})(typeof window !== 'undefined' ? window : globalThis);
