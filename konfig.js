// Společné ovládání konfigurátorů: validace, náhled, cena, poptávka a práce s textem.
// Stránka dodá funkci compute(), která ze zadání vrátí model; zbytek je stejný pro všechny.
(function () {
  const { CALC, csNum, measure, estimate, fitsBed, handoff, ownerMode, download, createViewer } = window.Sulc3D;
  const $ = id => document.getElementById(id);
  const num = id => parseFloat(String($(id).value).replace(',', '.'));
  const mm = v => csNum(v, Number.isInteger(Math.round(v * 10) / 10) ? 0 : 1);
  const dims3 = s => s.map(mm).join(' × ') + ' mm';
  const MAX_TRIS = 150000; // ~7,5 MB STL, aby se příloha vešla do limitu formuláře

  const FONTS = {
    inter:   { label: 'Tučné rovné',  family: 'Inter',      weight: 800 },
    fredoka: { label: 'Zaoblené',     family: 'Fredoka',    weight: 600 },
    bebas:   { label: 'Úzké verzálky', family: 'Bebas Neue', weight: 400 },
    pacifico: { label: 'Psací',       family: 'Pacifico',   weight: 400 },
    lobster: { label: 'Ozdobné',      family: 'Lobster',    weight: 400 }
  };
  const fontCss = (key, px) => `${FONTS[key].weight} ${px}px "${FONTS[key].family}", sans-serif`;

  // Počkat na načtení písma (včetně znaků s diakritikou)
  function loadFont(key, text) {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    return document.fonts.load(fontCss(key, 100), text || 'Příliš žluťoučký').catch(() => {});
  }

  /**
   * Rozvrh textu: největší písmo, se kterým se řádky vejdou do maxW × maxH (v pixelech rastru).
   * Vrací { px, width, height, draw(ctx, cx, cy) }; draw vykreslí blok vystředěný na (cx, cy).
   */
  function layoutText(ctx, lines, fontKey, maxW, maxH, maxPx) {
    const REF = 100, LINE = 1.18;
    ctx.font = fontCss(fontKey, REF);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const m = lines.map(t => ctx.measureText(t));
    const inkW = Math.max(...m.map(x => x.actualBoundingBoxLeft + x.actualBoundingBoxRight), 1);
    const asc = m[0].actualBoundingBoxAscent, desc = m[m.length - 1].actualBoundingBoxDescent;
    const blockH = Math.max(asc + desc + (lines.length - 1) * REF * LINE, 1);
    let k = Math.min(maxW / inkW, maxH / blockH);
    if (maxPx) k = Math.min(k, maxPx / REF);
    const px = REF * k;
    return {
      px, width: inkW * k, height: blockH * k,
      draw(target, cx, cy, mode = 'fill', lineWidth = 0) {
        target.font = fontCss(fontKey, px);
        target.textAlign = 'left';
        target.textBaseline = 'alphabetic';
        target.lineJoin = 'round';
        target.lineCap = 'round';
        const top = cy - blockH * k / 2;
        lines.forEach((t, i) => {
          const left = m[i].actualBoundingBoxLeft * k, right = m[i].actualBoundingBoxRight * k;
          const x = cx - (right - left) / 2, y = top + asc * k + i * px * LINE;
          if (mode === 'stroke') { target.lineWidth = lineWidth; target.strokeText(t, x, y); }
          else target.fillText(t, x, y);
        });
      }
    };
  }

  // Plátno o velikosti rastru; mask() vrátí Uint8Array (1 = vykresleno), řádek 0 je dole (osa Y nahoru)
  function raster(nx, ny) {
    const canvas = document.createElement('canvas');
    canvas.width = nx;
    canvas.height = ny;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return {
      ctx, nx, ny,
      clear() { ctx.globalCompositeOperation = 'source-over'; ctx.clearRect(0, 0, nx, ny); ctx.fillStyle = '#000'; ctx.strokeStyle = '#000'; },
      mask() {
        const d = ctx.getImageData(0, 0, nx, ny).data, out = new Uint8Array(nx * ny);
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
          if (d[((ny - 1 - j) * nx + i) * 4 + 3] >= 128) out[j * nx + i] = 1;
        }
        return out;
      }
    };
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /**
   * Spustí konfigurátor. Stránka musí mít prvky #cfg, #canvas, #material, #kusu, #rWeight, #rPrice,
   * #messages, #order a #stlBtn.
   * cfg.compute(ctx) → { pos, name, popis, rows?, shown?, viewOpts?, multi?, count?, fitSize?, partName?, priceFactor? }
   *   ctx.error(text), ctx.warn(text), ctx.range(hodnota, od, do, název[, jednotka]) → true/false
   * cfg.debounce: ms, o kolik odložit přepočet při psaní (pro náročnější modely)
   */
  function init(cfg) {
    const viewer = createViewer($('canvas'));
    const order = $('order'), stlBtn = $('stlBtn');
    let current = null, token = 0, timer = 0;

    async function run() {
      const my = ++token;
      const errors = [], warnings = [];
      const ctx = {
        error: t => { errors.push(t); },
        warn: t => { warnings.push(t); },
        range(v, lo, hi, name, unit = ' mm') {
          if (v >= lo && v <= hi) return true;
          errors.push(`${name} musí být v rozmezí ${mm(lo)}–${mm(hi)}${unit}.`);
          return false;
        }
      };
      let res = null;
      try {
        res = await cfg.compute(ctx);
      } catch (e) {
        console.error(e);
        errors.push('Model se nepodařilo vytvořit. Zkuste změnit zadání.');
      }
      if (my !== token) return; // mezitím přišlo novější zadání

      let est = null, model = null;
      if (!errors.length && res) {
        model = measure(res.pos);
        const pieces = Math.max(1, parseInt($('kusu').value, 10) || 1) * (res.count || 1);
        est = estimate(model, $('material').value, pieces, res.priceFactor || 1);
        if (!fitsBed(res.fitSize || model.size)) {
          errors.push(`${res.partName || 'Díl'} se nevejde do tiskového prostoru ${CALC.maxSize.join(' × ')} mm. Zmenšete rozměry.`);
        }
      }

      $('messages').innerHTML = '';
      const add = (cls, t) => { const li = document.createElement('li'); li.className = cls; li.textContent = t; $('messages').append(li); };
      errors.forEach(t => add('error', t));
      warnings.forEach(t => add('warn', t));

      const ok = !errors.length && !!res;
      order.setAttribute('aria-disabled', String(!ok));
      order.tabIndex = ok ? 0 : -1;
      stlBtn.disabled = !ok;
      if (!ok) {
        current = null;
        ['rWeight', 'rPrice'].forEach(id => { $(id).textContent = '–'; });
        return;
      }

      const shown = res.shown || res.pos;
      if (viewer) viewer.setModel(shown, res.shown ? measure(shown) : model, true, res.viewOpts);
      else $('canvas').hidden = true;
      for (const [id, text] of Object.entries(res.rows || {})) {
        const row = $(id).closest('.res-row');
        if (row) row.hidden = text === null;
        if (text !== null) $(id).textContent = text;
      }
      $('rWeight').textContent = est.weight + (est.qty > 1 ? ' / ks' : '');
      $('rPrice').textContent = est.price + (est.qty > 1 ? ` za ${est.qty} ks` : '');

      current = { pos: res.pos, name: res.name.replace(/,/g, '_'), multi: !!res.multi, factor: res.priceFactor || 1 };
      const popis = `${res.popis} Orientační odhad: ${est.weight}${est.qty > 1 ? ' na kus' : ''}, ${est.price}${est.qty > 1 ? ` za ${est.qty} ks` : ''}.`;
      const home = location.protocol === 'file:' ? 'index.html' : '/';
      order.href = home + '?' + new URLSearchParams({ popis, material: $('material').value, kusu: est.qty }) + '#naceneni';
    }

    const schedule = () => {
      clearTimeout(timer);
      if (cfg.debounce) timer = setTimeout(run, cfg.debounce);
      else run();
    };
    $('cfg').addEventListener('input', schedule);
    $('cfg').addEventListener('submit', e => e.preventDefault());
    // Při poptávce přiložit vygenerovaný model: nejdřív ho uložit, pak teprve přejít na formulář
    order.addEventListener('click', e => {
      if (!current || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      const href = order.href;
      handoff(current.pos, current.name, current.multi, current.factor).then(() => { location.href = href; });
    });
    // Stažení STL jen s adresou ?stl=1
    stlBtn.hidden = !ownerMode();
    stlBtn.addEventListener('click', () => { if (current) download(current.pos, current.name); });
    run();
    return { run, schedule };
  }

  window.Sulc3DKonfig = { $, num, mm, dims3, MAX_TRIS, FONTS, loadFont, layoutText, raster, roundRect, init };
})();
