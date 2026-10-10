// Sdílený kód pro 3D náhled a orientační kalkulaci (hlavní stránka + konfigurátor redukcí).
(function () {
  // Parametry orientačního odhadu – upravte podle skutečného ceníku.
  const CALC = {
    minPrice: 50,           // Kč za kus
    wall: 1.2,              // mm, tloušťka stěn
    infill: 0.15,           // podíl výplně uvnitř dílu
    spread: [0.85, 1.25],   // rozptyl odhadu (od–do)
    fallback: 'PLA',        // materiál pro "Nevím" a "Jiný"
    maxSize: [235, 235, 250], // mm, tiskový prostor
    materials: {
      'PLA':       { density: 1.24, perGram: 3 },
      'PETG':      { density: 1.27, perGram: 3.5 },
      'ABS / ASA': { density: 1.05, perGram: 4 },
      'TPU':       { density: 1.21, perGram: 5 }
    }
  };

  const csNum = (v, d) => v.toLocaleString('cs-CZ', { minimumFractionDigits: d, maximumFractionDigits: d });

  // Binární i textové STL → Float32Array (9 čísel na trojúhelník)
  function parseSTL(buf) {
    if (buf.byteLength >= 84) {
      const dv = new DataView(buf);
      const n = dv.getUint32(80, true);
      if (n > 0 && 84 + n * 50 === buf.byteLength) {
        const pos = new Float32Array(n * 9);
        for (let i = 0, o = 96; i < n; i++, o += 50) {
          for (let k = 0; k < 9; k++) pos[i * 9 + k] = dv.getFloat32(o + k * 4, true);
        }
        return pos;
      }
    }
    const text = new TextDecoder().decode(buf);
    const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
    const nums = [];
    let m;
    while ((m = re.exec(text))) nums.push(+m[1], +m[2], +m[3]);
    if (nums.length < 9 || nums.length % 9) throw new Error('Neplatné STL');
    return new Float32Array(nums);
  }

  // Float32Array (9 čísel na trojúhelník) → binární STL
  function toSTL(pos) {
    const n = pos.length / 9;
    const buf = new ArrayBuffer(84 + n * 50), dv = new DataView(buf);
    const header = 'sulc3d.cz';
    for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
    dv.setUint32(80, n, true);
    for (let i = 0, o = 84; i < n; i++, o += 50) {
      const p = i * 9;
      const ux = pos[p + 3] - pos[p], uy = pos[p + 4] - pos[p + 1], uz = pos[p + 5] - pos[p + 2];
      const vx = pos[p + 6] - pos[p], vy = pos[p + 7] - pos[p + 1], vz = pos[p + 8] - pos[p + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      dv.setFloat32(o, nx / len, true);
      dv.setFloat32(o + 4, ny / len, true);
      dv.setFloat32(o + 8, nz / len, true);
      for (let k = 0; k < 9; k++) dv.setFloat32(o + 12 + k * 4, pos[p + k], true);
    }
    return buf;
  }

  // Rozměry, objem (mm³) a povrch (mm²)
  function measure(pos) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    let vol6 = 0, area2 = 0;
    for (let i = 0; i < pos.length; i += 9) {
      const ax = pos[i], ay = pos[i + 1], az = pos[i + 2];
      const bx = pos[i + 3], by = pos[i + 4], bz = pos[i + 5];
      const cx = pos[i + 6], cy = pos[i + 7], cz = pos[i + 8];
      for (let k = 0; k < 9; k++) {
        const v = pos[i + k], a = k % 3;
        if (v < min[a]) min[a] = v;
        if (v > max[a]) max[a] = v;
      }
      vol6 += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
      const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
      area2 += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    }
    const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    const volume = Math.abs(vol6) / 6, area = area2 / 2;
    if (!isFinite(volume) || !isFinite(area) || !(Math.max(...size) > 0)) throw new Error('Neplatné STL');
    return { min, max, size, volume, area };
  }

  // Vejde se díl v některé orientaci do tiskového prostoru?
  function fitsBed(size) {
    const sorted = [...size].sort((a, b) => a - b), bed = [...CALC.maxSize].sort((a, b) => a - b);
    return sorted.every((v, i) => v <= bed[i]);
  }

  // Předání vygenerovaného modelu poptávkovému formuláři na hlavní stránce.
  // Jde přes IndexedDB, protože větší modely (cedulky, lithofan) se do sessionStorage nevejdou.
  const HANDOFF_MAX_AGE = 10 * 60 * 1000; // ms, starší model už k poptávce nepatří
  function handoffStore(mode, work) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open('sulc3d', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('handoff');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction('handoff', mode);
        const result = work(tx.objectStore('handoff'));
        tx.oncomplete = () => { open.result.close(); resolve(result && result.result); };
        tx.onerror = tx.onabort = () => { open.result.close(); reject(tx.error); };
      };
    });
  }

  // multi: soubor obsahuje víc dílů vedle sebe, takže celkový rozměr neříká nic o tiskovém prostoru.
  // Vrací Promise; na chybu se nečeká – rozměry jsou i tak v textu poptávky.
  function handoff(pos, name, multi, factor = 1) {
    return handoffStore('readwrite', store => store.put({ name, multi: !!multi, factor, data: toSTL(pos), time: Date.now() }, 'model'))
      .catch(() => {});
  }

  // Vyzvednout (a smazat) předaný model; null, když žádný čerstvý není.
  function takeHandoff() {
    let found;
    return handoffStore('readwrite', store => {
      const get = store.get('model');
      get.onsuccess = () => { found = get.result; if (found) store.delete('model'); };
    }).then(() => (found && Date.now() - found.time < HANDOFF_MAX_AGE ? found : null)).catch(() => null);
  }

  // Stažení STL – tlačítko se v konfigurátorech ukáže jen s adresou ?stl=1
  const ownerMode = () => new URLSearchParams(location.search).get('stl') === '1';
  function download(pos, name) {
    const url = URL.createObjectURL(new Blob([toSTL(pos)], { type: 'model/stl' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Orientační hmotnost a cena pro změřený model
  // factor: cenový koeficient pro výrobky s delším tiskem (např. lithofan)
  function estimate(model, material, qtyValue, factor = 1) {
    const exact = !!CALC.materials[material];
    const matName = exact ? material : CALC.fallback;
    const mat = CALC.materials[matName];
    const qty = Math.max(1, parseInt(qtyValue, 10) || 1);
    // spotřeba materiálu: stěny + řídká výplň zbytku objemu
    const shell = Math.min(model.volume, model.area * CALC.wall);
    const grams = (shell + (model.volume - shell) * CALC.infill) / 1000 * mat.density;
    const piece = grams * mat.perGram * factor;
    const round10 = v => Math.max(CALC.minPrice, Math.round(v / 10) * 10);
    const lo = round10(piece * CALC.spread[0]) * qty, hi = round10(piece * CALC.spread[1]) * qty;
    return {
      matName, exact, qty, grams, lo, hi,
      fits: fitsBed(model.size),
      price: (lo === hi ? `cca ${csNum(lo, 0)}` : `${csNum(lo, 0)}–${csNum(hi, 0)}`) + ' Kč',
      dims: model.size.map(v => csNum(v, v < 10 ? 1 : 0)).join(' × ') + ' mm',
      vol: csNum(model.volume / 1000, 1) + ' cm³',
      weight: `cca ${csNum(grams, grams < 10 ? 1 : 0)} g`
    };
  }

  // Jednoduchý WebGL prohlížeč (bez knihoven)
  function createViewer(canvas) {
    const gl = canvas.getContext('webgl', { antialias: true, alpha: true });
    if (!gl) return null;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER,
      'attribute vec3 p; attribute vec3 n; uniform mat4 mvp; uniform mat4 rot; varying vec3 vn; varying float vz;' +
      'void main(){ vn = (rot * vec4(n, 0.0)).xyz; vz = p.z; gl_Position = mvp * vec4(p, 1.0); }'));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER,
      // tint.z > 0: barvit podle výšky (tint.x = spodní mez, tint.y = rozsah) – odliší text od podkladu
      'precision mediump float; varying vec3 vn; varying float vz; uniform vec3 tint;' +
      'void main(){ float d = abs(dot(normalize(vn), normalize(vec3(0.35, 0.55, 1.0))));' +
      'vec3 c = mix(vec3(0.13, 0.18, 0.40), vec3(0.52, 0.64, 1.0), d);' +
      'if (tint.z > 0.5) { float t = clamp((vz - tint.x) / tint.y, 0.0, 1.0);' +
      'c = mix(vec3(0.16, 0.22, 0.50), vec3(0.95, 0.96, 1.0), t) * (0.55 + 0.45 * d); }' +
      'gl_FragColor = vec4(c, 1.0); }'));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);
    gl.enable(gl.DEPTH_TEST);
    const posBuf = gl.createBuffer(), norBuf = gl.createBuffer();
    const aP = gl.getAttribLocation(prog, 'p'), aN = gl.getAttribLocation(prog, 'n');
    const uMvp = gl.getUniformLocation(prog, 'mvp'), uRot = gl.getUniformLocation(prog, 'rot');
    const uTint = gl.getUniformLocation(prog, 'tint');

    const mul = (a, b) => {
      const o = new Float32Array(16);
      for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
        o[c * 4 + r] = s;
      }
      return o;
    };
    const rotX = t => { const c = Math.cos(t), s = Math.sin(t); return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]; };
    const rotY = t => { const c = Math.cos(t), s = Math.sin(t); return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]; };

    let count = 0, yaw = 0.7, pitch = 0.45, spinning = false, raf = 0;

    function draw() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
      if (!w || !h) return;
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (!count) return;
      // STL má osu Z nahoru → otočit na Y nahoru
      const rot = mul(mul(rotX(pitch), rotY(yaw)), rotX(-Math.PI / 2));
      const f = 1 / Math.tan(15 * Math.PI / 180), near = 0.5, far = 5;
      const proj = [f / (w / h), 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, 2 * far * near / (near - far), 0];
      const view = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -2.2, 1];
      gl.uniformMatrix4fv(uRot, false, rot);
      gl.uniformMatrix4fv(uMvp, false, mul(mul(proj, view), rot));
      gl.drawArrays(gl.TRIANGLES, 0, count);
    }

    function loop() {
      // zastavit, když je plátno skryté
      if (!spinning || !canvas.clientWidth) { raf = 0; return; }
      yaw += 0.006;
      draw();
      raf = requestAnimationFrame(loop);
    }

    let drag = null;
    canvas.addEventListener('pointerdown', e => {
      drag = { x: e.clientX, y: e.clientY };
      spinning = false;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', e => {
      if (!drag) return;
      yaw += (e.clientX - drag.x) * 0.012;
      pitch = Math.max(-1.5, Math.min(1.5, pitch + (e.clientY - drag.y) * 0.012));
      drag = { x: e.clientX, y: e.clientY };
      draw();
    });
    const endDrag = () => { drag = null; };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    window.addEventListener('resize', draw);

    return {
      // keepView: ponechat natočení (pro živé úpravy parametrů)
      // opts.tintZ: [z nejtmavší, z nejsvětlejší] v mm – barvení podle výšky
      // opts.view: { yaw, pitch, spin } – výchozí pohled místo otáčení
      setModel(pos, m, keepView, opts = {}) {
        // vystředit a zmenšit tak, aby se model vešel do koule o poloměru 0,5
        const cx = (m.min[0] + m.max[0]) / 2, cy = (m.min[1] + m.max[1]) / 2, cz = (m.min[2] + m.max[2]) / 2;
        const scale = 1 / Math.hypot(m.size[0], m.size[1], m.size[2]);
        const p = new Float32Array(pos.length), n = new Float32Array(pos.length);
        for (let i = 0; i < pos.length; i += 9) {
          for (let k = 0; k < 9; k += 3) {
            p[i + k] = (pos[i + k] - cx) * scale;
            p[i + k + 1] = (pos[i + k + 1] - cy) * scale;
            p[i + k + 2] = (pos[i + k + 2] - cz) * scale;
          }
          const ux = p[i + 3] - p[i], uy = p[i + 4] - p[i + 1], uz = p[i + 5] - p[i + 2];
          const vx = p[i + 6] - p[i], vy = p[i + 7] - p[i + 1], vz = p[i + 8] - p[i + 2];
          const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
          for (let k = 0; k < 9; k += 3) { n[i + k] = nx; n[i + k + 1] = ny; n[i + k + 2] = nz; }
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
        gl.bufferData(gl.ARRAY_BUFFER, p, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(aP);
        gl.vertexAttribPointer(aP, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, norBuf);
        gl.bufferData(gl.ARRAY_BUFFER, n, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(aN);
        gl.vertexAttribPointer(aN, 3, gl.FLOAT, false, 0, 0);
        if (opts.tintZ && opts.tintZ[0] !== opts.tintZ[1]) {
          gl.uniform3f(uTint, (opts.tintZ[0] - cz) * scale, (opts.tintZ[1] - opts.tintZ[0]) * scale, 1);
        } else {
          gl.uniform3f(uTint, 0, 1, 0);
        }
        const first = !count;
        count = pos.length / 3;
        if (!keepView || first) {
          const v = opts.view || {};
          yaw = v.yaw === undefined ? 0.7 : v.yaw;
          pitch = v.pitch === undefined ? 0.45 : v.pitch;
          spinning = v.spin !== false && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        }
        draw();
        if (spinning && !raf) raf = requestAnimationFrame(loop);
      }
    };
  }

  window.Sulc3D = { CALC, csNum, parseSTL, toSTL, measure, estimate, fitsBed, handoff, takeHandoff, ownerMode, download, createViewer };
})();
