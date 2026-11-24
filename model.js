// Sdílený kód pro 3D náhled, orientační kalkulaci a nastavení tisku (hlavní stránka + konfigurátory).
(function () {
  // Parametry orientačního odhadu – upravte podle skutečného ceníku.
  const CALC = {
    minPrice: 50,           // Kč za kus
    lineWidth: 0.4,         // mm, šířka jednoho perimetru (tryska 0,4)
    // Nastavení tisku, které volí zákazník. layers: výška vrstvy → koeficient ceny (čas tisku).
    print: {
      layers: {
        '0.12': { factor: 1.4, label: '0,12 mm – jemná, nejhladší' },
        '0.16': { factor: 1.2, label: '0,16 mm – kvalitní' },
        '0.20': { factor: 1.0, label: '0,20 mm – standard' },
        '0.28': { factor: 0.9, label: '0,28 mm – rychlá, hrubší' }
      },
      perimeters: { 2: '2 – lehký díl', 3: '3 – standard', 4: '4 – pevnější', 5: '5 – pevný', 6: '6 – velmi pevný' },
      // infill: výplň → koeficient ceny (čas tisku); uplatní se až po min. ceně, takže každá volba mění cenu
      infill: {
        10: { factor: 0.9, label: '10 % – dekorace' },
        15: { factor: 1.0, label: '15 % – standard' },
        20: { factor: 1.1, label: '20 %' },
        30: { factor: 1.2, label: '30 % – pevnější' },
        50: { factor: 1.4, label: '50 % – pevný díl' }
      },
      standard: { layer: '0.20', perimeters: 3, infill: 15 } // pro odhad, dokud zákazník nevybere
    },
    // Barvy filamentu (volitelné; prázdná volba = „Nezáleží“). rgb = barva 3D náhledu.
    colors: {
      cerna:  { label: 'Černá',  rgb: [0.17, 0.17, 0.19] },
      bila:   { label: 'Bílá',   rgb: [0.93, 0.93, 0.91] },
      seda:   { label: 'Šedá',   rgb: [0.55, 0.57, 0.6] },
      zluta:  { label: 'Žlutá',  rgb: [0.98, 0.78, 0.1] },
      zelena: { label: 'Zelená', rgb: [0.15, 0.66, 0.3] },
      modra:  { label: 'Modrá',  rgb: [0.18, 0.4, 0.92] }
    },
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

  // Předání vygenerovaných modelů poptávkovému formuláři na hlavní stránce.
  // Jde přes IndexedDB, protože větší modely (cedulky, lithofan) se do sessionStorage nevejdou.
  // Modely se sbírají jako do košíku: každé „Poptat…“ přidá další, formulář je pošle všechny
  // a seznam se smaže až odesláním poptávky (nebo odebráním souboru ve formuláři).
  const HANDOFF_MAX_AGE = 24 * 60 * 60 * 1000; // ms, starší model už k poptávce nepatří
  function handoffStore(mode, work) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open('sulc3d', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('handoff');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction('handoff', mode);
        const result = work(tx.objectStore('handoff'));
        tx.oncomplete = () => { open.result.close(); resolve(result); };
        tx.onerror = tx.onabort = () => { open.result.close(); reject(tx.error); };
      };
    });
  }

  const freshItems = list => (Array.isArray(list) ? list : []).filter(i => Date.now() - i.time < HANDOFF_MAX_AGE);
  // Upraví uložený seznam modelů: change(list) vrací nový seznam
  function changeHandoff(change) {
    return handoffStore('readwrite', store => {
      const get = store.get('items');
      get.onsuccess = () => store.put(change(freshItems(get.result)), 'items');
    });
  }

  // multi: soubor obsahuje víc dílů vedle sebe, takže celkový rozměr neříká nic o tiskovém prostoru.
  // href: odkaz na poptávku z konfigurátoru – z něj se k modelu uloží popis, materiál, počet kusů
  // a nastavení tisku (vrstva, perimetry, vypln).
  // Vrací Promise; na chybu se nečeká – rozměry jsou i tak v textu poptávky.
  function handoff(pos, name, multi, factor = 1, href = '') {
    const q = new URL(href || location.href, location.href).searchParams;
    const item = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      name, multi: !!multi, factor, data: toSTL(pos), time: Date.now(),
      popis: q.get('popis') || '', material: q.get('material') || '', kusu: parseInt(q.get('kusu'), 10) || 1,
      print: printFromQuery(q), color: validColor(q.get('barva')), color2: validColor(q.get('barva2'))
    };
    return changeHandoff(list => [...list, item]).catch(() => {});
  }

  // Všechny čerstvé předané modely (nemaže je); [] když žádné nejsou
  function listHandoff() {
    let found;
    return handoffStore('readonly', store => {
      const get = store.get('items');
      get.onsuccess = () => { found = get.result; };
    }).then(() => freshItems(found)).catch(() => []);
  }
  const removeHandoff = id => changeHandoff(list => list.filter(i => i.id !== id)).catch(() => {});
  const clearHandoff = () => handoffStore('readwrite', store => { store.delete('items'); store.delete('model'); }).catch(() => {});

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

  // ── Barva filamentu (nepovinná) ──
  const validColor = k => (k && CALC.colors[k] ? k : '');
  const colorLabel = k => (validColor(k) ? CALC.colors[k].label : '');
  const colorRgb = k => (validColor(k) ? CALC.colors[k].rgb : null);
  function fillColorSelect(el, value) {
    if (!el) return;
    el.replaceChildren(new Option('Nezáleží – poradíme', ''),
      ...Object.entries(CALC.colors).map(([k, c]) => new Option(c.label, k)));
    el.value = validColor(value);
  }

  // ── Košík v menu: počet modelů v poptávce u tlačítka „Nezávazná poptávka“ ──
  // Na hlavní stránce počet nastavuje formulář (setCartCount), jinde se čte z IndexedDB.
  function setCartCount(n) {
    document.querySelectorAll('.nav-cta').forEach(a => {
      let b = a.querySelector('.cart-badge');
      if (!b) {
        b = document.createElement('span');
        b.className = 'cart-badge';
        a.append(b);
      }
      b.textContent = n;
      b.hidden = !n;
      a.setAttribute('aria-label', n ? `Nezávazná poptávka – v poptávce ${n} ${n === 1 ? 'model' : n < 5 ? 'modely' : 'modelů'}` : 'Nezávazná poptávka');
    });
    // v konfigurátoru upozornit, že se nový model přidá k ostatním
    const order = document.getElementById('order');
    if (order && !document.getElementById('contactForm')) {
      let note = document.getElementById('cartNote');
      if (!note) {
        note = document.createElement('p');
        note.id = 'cartNote';
        note.className = 'cart-note';
        order.before(note);
      }
      note.hidden = !n;
      note.innerHTML = '';
      if (n) {
        note.append(`V poptávce už ${n === 1 ? 'máte 1 model' : `máte ${n} ${n < 5 ? 'modely' : 'modelů'}`} – tento se přidá k ${n === 1 ? 'němu' : 'nim'}. `);
        const a = document.createElement('a');
        a.href = '/#naceneni';
        a.textContent = 'Zobrazit poptávku';
        note.append(a);
      }
    }
  }
  if (!document.getElementById('contactForm')) {
    const refresh = () => listHandoff().then(l => setCartCount(l.length));
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refresh);
    else refresh();
    // návrat zpět tlačítkem prohlížeče (bfcache) – košík se mezitím mohl změnit
    window.addEventListener('pageshow', e => { if (e.persisted) refresh(); });
  }

  // ── Nastavení tisku: výška vrstvy, počet perimetrů, výplň ──
  // print = { layer: '0.20', perimeters: 3, infill: 15 }; null = zákazník ještě nevybral
  function validPrint(p) {
    const P = CALC.print;
    return !!p && !!P.layers[p.layer] && !!P.perimeters[p.perimeters] && !!P.infill[p.infill];
  }
  function printFromQuery(q) {
    const p = { layer: q.get('vrstva'), perimeters: parseInt(q.get('perimetry'), 10), infill: parseInt(q.get('vypln'), 10) };
    return validPrint(p) ? p : null;
  }
  const printQuery = p => (validPrint(p) ? { vrstva: p.layer, perimetry: p.perimeters, vypln: p.infill } : {});
  function printLabel(p) {
    if (!validPrint(p)) return 'nastavení tisku nevybráno';
    const per = p.perimeters;
    return `vrstva ${csNum(parseFloat(p.layer), 2)} mm, ${per} ${per < 5 ? 'perimetry' : 'perimetrů'}, výplň ${p.infill} %`;
  }

  // Naplní tři <select> volbami; první je prázdná „Vyberte…“, takže pole s atributem required
  // nepustí poptávku bez výběru. value: předvyplněné nastavení (nebo null).
  function fillPrintSelects(sel, value) {
    const P = CALC.print;
    const fill = (el, opts, current) => {
      if (!el) return;
      el.replaceChildren(new Option('Vyberte…', ''), ...Object.entries(opts).map(([v, o]) => new Option(typeof o === 'string' ? o : o.label, v)));
      el.value = current != null ? String(current) : '';
      el.required = true;
    };
    fill(sel.layer, P.layers, value && value.layer);
    fill(sel.perimeters, P.perimeters, value && value.perimeters);
    fill(sel.infill, P.infill, value && value.infill);
  }
  function readPrint(sel) {
    const p = { layer: sel.layer.value, perimeters: parseInt(sel.perimeters.value, 10), infill: parseInt(sel.infill.value, 10) };
    return validPrint(p) ? p : null;
  }

  // Orientační hmotnost a cena pro změřený model
  // factor: cenový koeficient pro výrobky s delším tiskem (např. lithofan)
  // print: nastavení tisku; bez něj se počítá se standardem (CALC.print.standard)
  function estimate(model, material, qtyValue, factor = 1, print = null) {
    const exact = !!CALC.materials[material];
    const matName = exact ? material : CALC.fallback;
    const mat = CALC.materials[matName];
    const qty = Math.max(1, parseInt(qtyValue, 10) || 1);
    const pr = validPrint(print) ? print : CALC.print.standard;
    // spotřeba materiálu: stěny (perimetry) + výplň zbytku objemu
    const shell = Math.min(model.volume, model.area * pr.perimeters * CALC.lineWidth);
    const grams = (shell + (model.volume - shell) * pr.infill / 100) / 1000 * mat.density;
    const piece = grams * mat.perGram * factor * CALC.print.layers[pr.layer].factor;
    const fill = CALC.print.infill[pr.infill].factor;
    // minimum platí vždy (i u 10% výplně), koeficient výplně až po zaokrouhlení na desetikoruny
    const round = v => Math.max(CALC.minPrice, Math.round(Math.max(CALC.minPrice, Math.round(v / 10) * 10) * fill));
    const lo = round(piece * CALC.spread[0]) * qty, hi = round(piece * CALC.spread[1]) * qty;
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
      // base.w > 0: barva filamentu base.rgb místo výchozí modré
      'precision mediump float; varying vec3 vn; varying float vz; uniform vec3 tint; uniform vec4 base; uniform vec4 base2;' +
      'void main(){ float d = abs(dot(normalize(vn), normalize(vec3(0.35, 0.55, 1.0))));' +
      'vec3 lo = vec3(0.13, 0.18, 0.40), hi = vec3(0.52, 0.64, 1.0), tl = vec3(0.16, 0.22, 0.50), th = vec3(0.95, 0.96, 1.0);' +
      'if (base.w > 0.5) { lo = base.rgb * 0.32 + 0.03; hi = min(base.rgb * 1.08 + 0.1, 1.0);' +
      'tl = base.rgb * 0.5 + 0.03; th = min(mix(base.rgb, vec3(1.0), 0.35) + 0.08, 1.0); }' +
      'vec3 c = mix(lo, hi, d);' +
      'if (tint.z > 0.5) { float t = clamp((vz - tint.x) / tint.y, 0.0, 1.0);' +
      'c = mix(tl, th, t) * (0.55 + 0.45 * d);' +
      // base2.w > 0: dvoubarevný reliéf – písmo v barvě base2.rgb (w = 2: písmo je zapuštěné, tedy dole)
      'if (base2.w > 0.5) { float k = smoothstep(0.3, 0.7, t); if (base2.w > 1.5) k = 1.0 - k;' +
      'vec3 b = base.w > 0.5 ? base.rgb : vec3(0.3, 0.42, 0.85);' +
      'c = mix(b, base2.rgb, k) * (0.45 + 0.6 * d) + 0.03; } }' +
      'gl_FragColor = vec4(c, 1.0); }'));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);
    gl.enable(gl.DEPTH_TEST);
    const posBuf = gl.createBuffer(), norBuf = gl.createBuffer();
    const aP = gl.getAttribLocation(prog, 'p'), aN = gl.getAttribLocation(prog, 'n');
    const uMvp = gl.getUniformLocation(prog, 'mvp'), uRot = gl.getUniformLocation(prog, 'rot');
    const uTint = gl.getUniformLocation(prog, 'tint'), uBase = gl.getUniformLocation(prog, 'base'), uBase2 = gl.getUniformLocation(prog, 'base2');
    gl.uniform4f(uBase, 0, 0, 0, 0);
    let text2 = null, textLow = false; // barva písma u dvoubarevného reliéfu
    const applyText = () => gl.uniform4f(uBase2, ...(text2 ? [text2[0], text2[1], text2[2], textLow ? 2 : 1] : [0, 0, 0, 0]));
    applyText();

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
      // rgb: [r, g, b] 0–1 = barva filamentu; null = výchozí modrá
      // textRgb: barva písma u reliéfu (cedulky, klíčenky); null = jednobarevně
      setColor(rgb, textRgb = null) {
        if (rgb) gl.uniform4f(uBase, rgb[0], rgb[1], rgb[2], 1);
        else gl.uniform4f(uBase, 0, 0, 0, 0);
        text2 = textRgb;
        applyText();
        draw();
      },
      // keepView: ponechat natočení (pro živé úpravy parametrů)
      // opts.tintZ: [z nejtmavší, z nejsvětlejší] v mm – barvení podle výšky
      // opts.textLow: písmo je zapuštěné (u dvoubarevného náhledu je dole)
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
        textLow = !!opts.textLow;
        applyText();
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

  window.Sulc3D = { CALC, csNum, parseSTL, toSTL, measure, estimate, fitsBed, handoff, listHandoff, removeHandoff, clearHandoff, validPrint, printQuery, printLabel, fillPrintSelects, readPrint, validColor, colorLabel, colorRgb, fillColorSelect, setCartCount, ownerMode, download, createViewer };
})();
