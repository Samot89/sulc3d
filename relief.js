// Generátory sítí z rastru a rotačních profilů (cedulky, klíčenky, lithofan, kroužky a záslepky).
(function (root) {

  /**
   * Reliéf z rastru úrovní: každá buňka je sloupec od z = 0 do heights[úroveň], úroveň 0 je prázdno.
   * Řádek 0 leží u y = 0 (osa Y roste nahoru). Stejné úrovně v řádku se slučují do pásů,
   * hrany pásů se dělí podle sousedních řádků, takže na sebe díly navazují vrchol na vrchol.
   * o: { nx, ny, cell, levels: Uint8Array(nx·ny), heights: [0, h1, h2, …] }
   */
  function buildRelief(o) {
    const { nx, ny, cell, levels, heights } = o;
    const hs = [...new Set(heights)].sort((a, b) => a - b);
    const out = [];
    const tri = (ax, ay, az, bx, by, bz, cx, cy, cz) => out.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    const X = i => i * cell, Y = j => j * cell;

    // pásy řádku: hranice b (indexy sloupců) a úrovně l
    const runs = j => {
      if (j < 0 || j >= ny) return { b: [0, nx], l: [0] };
      const b = [0], l = [];
      let cur = levels[j * nx];
      for (let i = 1; i < nx; i++) {
        const v = levels[j * nx + i];
        if (v !== cur) { b.push(i); l.push(cur); cur = v; }
      }
      b.push(nx); l.push(cur);
      return { b, l };
    };

    // svislá stěna rozdělená po výškových úrovních; flip otáčí normálu
    const wall = (x0, y0, x1, y1, za, zb, flip) => {
      const lo = Math.min(za, zb), hi = Math.max(za, zb);
      for (let m = 0; m < hs.length - 1; m++) {
        const zl = hs[m], zh = hs[m + 1];
        if (zl < lo || zh > hi) continue;
        if (flip) { tri(x0, y0, zl, x1, y1, zh, x1, y1, zl); tri(x0, y0, zl, x0, y0, zh, x1, y1, zh); }
        else { tri(x0, y0, zl, x1, y1, zl, x1, y1, zh); tri(x0, y0, zl, x1, y1, zh, x0, y0, zh); }
      }
    };

    // body na hraně pásu <a, b> včetně hranic sousedního řádku uvnitř
    const chain = (a, b, other) => {
      const pts = [a];
      for (const v of other.b) if (v > a && v < b) pts.push(v);
      pts.push(b);
      return pts;
    };

    let prev = runs(-1), cur = runs(0);
    for (let j = 0; j < ny; j++) {
      const next = runs(j + 1);
      const y0 = Y(j), y1 = Y(j + 1);
      for (let k = 0; k < cur.l.length; k++) {
        const lv = cur.l[k], a = cur.b[k], b = cur.b[k + 1];
        const zr = heights[lv], zLeft = k === 0 ? 0 : heights[cur.l[k - 1]];
        // stěna na levé hraně pásu (a na pravém okraji řádku)
        if (zLeft !== zr) wall(X(a), y0, X(a), y1, zLeft, zr, zLeft < zr);
        if (k === cur.l.length - 1 && zr !== 0) wall(X(b), y0, X(b), y1, zr, 0, false);
        if (!lv) continue;
        // horní a spodní plocha pásu: "zip" mezi spodní a horní hranou
        const B = chain(a, b, prev), T = chain(a, b, next);
        let i = 0, t = 0;
        while (i < B.length - 1 || t < T.length - 1) {
          if (i < B.length - 1 && (t === T.length - 1 || B[i + 1] <= T[t + 1])) {
            tri(X(B[i]), y0, zr, X(B[i + 1]), y0, zr, X(T[t]), y1, zr);
            tri(X(B[i]), y0, 0, X(T[t]), y1, 0, X(B[i + 1]), y0, 0);
            i++;
          } else {
            tri(X(B[i]), y0, zr, X(T[t + 1]), y1, zr, X(T[t]), y1, zr);
            tri(X(B[i]), y0, 0, X(T[t]), y1, 0, X(T[t + 1]), y1, 0);
            t++;
          }
        }
      }
      // stěny mezi tímto a předchozím řádkem (na y0)
      between(prev, cur, y0);
      prev = cur; cur = next;
    }
    between(prev, runs(ny), Y(ny));

    function between(lower, upper, y) {
      let p = 0, q = 0, x = 0;
      while (x < nx) {
        const xe = Math.min(lower.b[p + 1], upper.b[q + 1]);
        const za = heights[lower.l[p]], zb = heights[upper.l[q]];
        // vyšší spodní řádek → stěna míří k +Y
        if (za !== zb) wall(X(x), y, X(xe), y, za, zb, za > zb);
        if (lower.b[p + 1] === xe) p++;
        if (upper.b[q + 1] === xe) q++;
        x = xe;
      }
    }

    return new Float32Array(out);
  }

  /**
   * Lithofan: deska s proměnnou tloušťkou zadanou ve vrcholech mřížky.
   * o: { nx, ny, cell, thick: Float32Array((nx + 1)·(ny + 1)) }, řádek 0 u y = 0.
   */
  function buildLitho(o) {
    const { nx, ny, cell, thick } = o;
    const out = new Float32Array((nx * ny * 2 + (nx + ny) * 2 * 3) * 9);
    let n = 0;
    const tri = (a, b, c) => { for (const p of [a, b, c]) { out[n++] = p[0]; out[n++] = p[1]; out[n++] = p[2]; } };
    const top = (i, j) => [i * cell, j * cell, thick[j * (nx + 1) + i]];
    const base = (i, j) => [i * cell, j * cell, 0];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      tri(top(i, j), top(i + 1, j), top(i + 1, j + 1));
      tri(top(i, j), top(i + 1, j + 1), top(i, j + 1));
    }
    // obvod proti směru hodin: záda vějířem ze středu a boční stěny
    const loop = [];
    for (let i = 0; i < nx; i++) loop.push([i, 0]);
    for (let j = 0; j < ny; j++) loop.push([nx, j]);
    for (let i = nx; i > 0; i--) loop.push([i, ny]);
    for (let j = ny; j > 0; j--) loop.push([0, j]);
    const centre = [nx * cell / 2, ny * cell / 2, 0];
    for (let k = 0; k < loop.length; k++) {
      const a = loop[k], b = loop[(k + 1) % loop.length];
      tri(centre, base(b[0], b[1]), base(a[0], a[1]));
      tri(base(a[0], a[1]), base(b[0], b[1]), top(b[0], b[1]));
      tri(base(a[0], a[1]), top(b[0], b[1]), top(a[0], a[1]));
    }
    return out;
  }

  /**
   * Rotační těleso z uzavřeného profilu [[r, z], …] zadaného proti směru hodin (r doprava, z nahoru).
   * Body na ose (r = 0) jsou povolené.
   */
  function revolve(profile, segments = 96) {
    const out = [];
    const pt = (p, k) => {
      const a = (k % segments) / segments * 2 * Math.PI;
      return [p[0] * Math.cos(a), p[0] * Math.sin(a), p[1]];
    };
    const tri = (a, b, c) => out.push(...a, ...b, ...c);
    for (let e = 0; e < profile.length; e++) {
      const a = profile[e], b = profile[(e + 1) % profile.length];
      if (a[0] === b[0] && a[1] === b[1]) continue;
      for (let k = 0; k < segments; k++) {
        if (a[0] > 0) tri(pt(a, k), pt(a, k + 1), pt(b, k + 1));
        if (b[0] > 0) tri(pt(a, k), pt(b, k + 1), pt(b, k));
      }
    }
    return new Float32Array(out);
  }

  const api = { buildRelief, buildLitho, revolve };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Sulc3DRelief = api;
})(typeof window !== 'undefined' ? window : globalThis);
