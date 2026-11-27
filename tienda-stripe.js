/* =====================================================================
   PLANTILLA ATS · Conector de tienda (Stripe + Supabase)
   Se carga DESPUÉS del script principal de la web. No cambia el diseño:
   reemplaza el pago simulado por Stripe Checkout, lee el stock real,
   bloquea agotados, muestra el seguimiento real y las políticas legales.
   Si TIENDA_CFG no tiene datos, no hace nada (la web sigue igual).
   ===================================================================== */
(function () {
  const CFG = window.TIENDA_CFG || {};
  if (!CFG.supabaseUrl || !CFG.anonKey) return;           // sin configurar: no tocar nada
  const FN = CFG.supabaseUrl.replace(/\/$/, '') + '/functions/v1';
  const REST = CFG.supabaseUrl.replace(/\/$/, '') + '/rest/v1';
  const H = { apikey: CFG.anonKey };   // clave publicable (sb_publishable_...), segura en el navegador con RLS

  const PAGOS = CFG.pagosStripe !== false;   // false = catálogo/stock reales, pero se mantiene el pago anterior

  /* ---------- 1. Quitar avisos de demostración (solo cuando Stripe está activo) ---------- */
  if (PAGOS) {
    const css = document.createElement('style');
    css.textContent = '.demo-bar{display:none!important}';
    document.head.appendChild(css);
  }

  /* ---------- 2. Catálogo y stock reales desde Supabase (lo que la dueña carga en su panel) ---------- */
  const ORDEN_TALLAS = ['XXS','XS','S','M','L','XL','XXL','2XL','3XL','4XL','5XL','UNICA'];
  const ordenTalla = t => { const i = ORDEN_TALLAS.indexOf(t); return i < 0 ? 99 : i; };
  let cargado = false;
  async function cargarStock(rerender) {
    try {
      const [rp, rv] = await Promise.all([
        fetch(REST + '/productos?select=id,nombre,sku,precio_cents,activo,descripcion,categoria_web,imagenes,orden&order=orden.asc,creado.desc', { headers: H }),
        fetch(REST + '/stock_publico?select=producto_id,color,talla,stock', { headers: H }),
      ]);
      if (!rp.ok || !rv.ok) throw new Error(rp.status + '/' + rv.status);
      const prods = await rp.json(), filas = await rv.json();
      const porProd = {};
      filas.forEach(f => { (porProd[f.producto_id] = porProd[f.producto_id] || []).push(f); });
      const nuevos = [];
      prods.forEach(d => {
        const fs = porProd[d.id] || [];
        let p = (S.products || []).find(x => x.id === d.id);
        if (!p) {   // prenda nueva creada desde el panel: se arma con el mismo formato de la web
          const ref = (d.sku || '').replace(/^REF-/i, '');
          p = { id: d.id, ref, sku: d.sku || d.id.toUpperCase(), name: d.nombre, cat: d.categoria_web, price: d.precio_cents / 100,
            desc: d.descripcion || '', images: [], video: '', active: true, featured: false, isNew: true, best: false, related: [],
            sizeTable: 'tabla-fajas', demo: false, stockDemo: false, colors: [], sizes: [], stock: {}, compression: 5,
            material: '', care: '' };
          nuevos.push(p);
        }
        p.name = d.nombre || p.name;
        p.price = d.precio_cents / 100;
        p.active = !!d.activo && fs.length > 0;
        if (d.categoria_web) p.cat = d.categoria_web;
        if (d.descripcion) p.desc = d.descripcion;
        if (d.imagenes && d.imagenes.length) p.images = d.imagenes.slice();
        const st = {}; fs.forEach(f => { st[f.color + '|' + f.talla] = f.stock; });
        p.stock = st;
        p.colors = [...new Set(fs.map(f => f.color))];
        p.sizes = [...new Set(fs.map(f => f.talla))].sort((a, b) => ordenTalla(a) - ordenTalla(b));
        p.stockDemo = false;
      });
      if (nuevos.length) S.products = nuevos.concat(S.products || []);
      // Productos de ejemplo (sin inventario real) no se venden en línea
      if (CFG.soloInventarioReal) { const ids = new Set(prods.map(d => d.id)); S.products.forEach(p => { if (!ids.has(p.id)) p.active = false; }); }
      // Ajustar el carrito si algo se agotó
      CART = CART.filter(l => { const p = prod(l.pid); return p && p.active; });
      CART.forEach(l => { const p = prod(l.pid); const d = +p.stock[l.color + '|' + l.size] || 0; if (l.qty > d) l.qty = d; });
      CART = CART.filter(l => l.qty > 0); saveCart();
      cargado = true;
      if (rerender || nuevos.length) { const h = (location.hash || '').slice(1); if (!h.startsWith('gracias-stripe-') && h !== 'checkout') route(); }
    } catch (e) { console.warn('Catálogo no disponible', e); }
  }
  cargarStock(true);
  setInterval(() => cargarStock(false), 60000);

  if (PAGOS) {
  /* ---------- 3. Checkout con Stripe ---------- */
  const origView = window.viewCheckout;
  window.viewCheckout = function () {
    let h = origView();
    if (CO.pay === 'card' || !CO.pay) {
      h = h.replace(/<div id="cardBox"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>(\s*<label class="check">)/,
        `<div id="cardBox" class="card-form"><div class="row" style="align-items:center;flex-wrap:wrap"><div class="brands"><span>VISA</span><span>MASTERCARD</span><span>AMEX</span><span>DISCOVER</span></div><span class="secure">🔒 Pago seguro con Stripe</span></div><p class="muted small">Al continuar irás a la página segura de Stripe para pagar con tarjeta, Apple Pay o Google Pay. El dinero llega directo a Bella Boutique. Recibirás el recibo por correo.</p></div></div>$1`);
      h = h.replace(/Pago inmediato\. El dinero llega a la cuenta bancaria de Bella Boutique\./, 'Pago inmediato y seguro con Stripe (tarjeta, Apple Pay o Google Pay).');
    }
    return h;
  };

  const origPlace = window.placeOrder;
  window.placeOrder = async function (e) {
    if (CO.pay !== 'card') return origPlace(e);           // transferencia / WhatsApp siguen igual
    e.preventDefault();
    const v = id => (document.getElementById(id)?.value || '').trim();
    const errs = [];
    if (v('cName').length < 3) errs.push('Escribe tu nombre completo.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v('cEmail'))) errs.push('Revisa tu correo electrónico.');
    if (v('cPhone').replace(/\D/g, '').length < 7) errs.push('Escribe un teléfono válido.');
    if (!$('#cTerms').checked) errs.push('Debes aceptar los términos para continuar.');
    if (!CART.length) errs.push('Tu carrito está vacío.');
    if (errs.length) { $('#coErr').innerHTML = errs.map(esc).join('<br>'); return; }
    const btn = e.target.querySelector('button[type=submit],button:not([type])');
    if (btn) { btn.disabled = true; btn.dataset.t = btn.textContent; btn.textContent = 'Conectando con Stripe…'; }
    $('#coErr').innerHTML = '';
    try {
      const r = await fetch(FN + '/crear-pago', {
        method: 'POST', headers: { ...H, 'content-type': 'application/json' },
        body: JSON.stringify({
          items: CART.map(l => ({ pid: l.pid, color: l.color, size: l.size, qty: l.qty })),
          entrega: CO.zone === 'pickup' ? 'retiro' : 'envio',
          email: v('cEmail').toLowerCase(), nombre: v('cName'), telefono: v('cPhone'),
        }),
      });
      const d = await r.json();
      if (r.status === 409) {
        $('#coErr').innerHTML = 'Algunas tallas se agotaron mientras comprabas:<br>' + (d.agotados || []).map(esc).join('<br>') + '<br>Actualizamos tu carrito.';
        await cargarStock(false); refreshCO(); return;
      }
      if (!r.ok || !d.url) throw new Error(d.error || 'No se pudo iniciar el pago');
      try { sessionStorage.setItem('bb_pago_pendiente', d.numero); } catch (_) {}
      track('begin_checkout_stripe', { numero: d.numero });
      // La web vive dentro de GoHighLevel (iframe): Stripe debe abrirse en la ventana principal
      try { (window.top || window).location.href = d.url; } catch (_) { window.open(d.url, '_blank') || (location.href = d.url); }
    } catch (err) {
      $('#coErr').innerHTML = esc(err.message || 'Error de conexión') + '. Intenta de nuevo o escríbenos por WhatsApp.';
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = btn.dataset.t || 'Pagar'; }
    }
  };

  /* ---------- 4. Página de gracias después de pagar ---------- */
  function gracias() {
    const h = (location.hash || '').slice(1);
    if (!h.startsWith('gracias-stripe-')) return;
    const num = h.slice('gracias-stripe-'.length);
    CART = []; saveCart();
    try { sessionStorage.removeItem('bb_pago_pendiente'); } catch (_) {}
    $('#view').innerHTML = `<div class="wrap" style="max-width:760px;padding-block:56px 80px;display:flex;flex-direction:column;gap:18px">
      <div class="eyebrow">Pago recibido</div><h1 style="font-size:clamp(34px,5vw,54px)">¡Gracias por tu compra!</h1>
      <p class="muted">Tu número de pedido es <b style="color:var(--ink)">${esc(num)}</b>. Te enviamos el recibo de pago a tu correo.</p>
      <p class="muted">Puedes consultar el estado de tu pedido y el número de guía en <a href="#seguimiento">Seguimiento de pedido</a> con tu número de pedido y tu correo.</p>
      <p><a class="btn" href="#tienda">Seguir comprando</a> <a class="btn ghost" target="_blank" rel="noopener" href="https://wa.me/${(S.settings.whatsapp||'16462396846').replace(/\D/g,'')}?text=${encodeURIComponent('Hola Bella Boutique, hice el pedido ' + num)}">Escribir por WhatsApp</a></p></div>`;
    scrollTo(0, 0);
    track('purchase_stripe', { numero: num });
  }
  addEventListener('hashchange', gracias);
  setTimeout(gracias, 0);

  /* ---------- 5. Seguimiento real del pedido ---------- */
  const origTrack = window.doTrack;
  window.doTrack = async function (e) {
    e.preventDefault();
    const n = $('#tNum').value.trim(), m = $('#tEmail').value.trim().toLowerCase();
    $('#tOut').innerHTML = '<p class="muted">Buscando…</p>';
    try {
      const r = await fetch(FN + '/pedido?n=' + encodeURIComponent(n) + '&e=' + encodeURIComponent(m), { headers: H });
      const d = await r.json();
      if (!r.ok) { if (origTrack) return origTrack(e); $('#tOut').innerHTML = `<p class="err">${esc(d.error)}</p>`; return; }
      const guia = d.guia ? `<p>Envío: <b>${esc(d.transportista || '')}</b> · Guía <b>${esc(d.guia)}</b>${d.url_seguimiento ? ` · <a target="_blank" rel="noopener" href="${esc(d.url_seguimiento)}">Rastrear envío</a>` : ''}</p>` : '';
      $('#tOut').innerHTML = `<div class="card-box"><h2 style="font-size:24px">Pedido ${esc(d.numero)}</h2>
        <p style="margin-top:6px"><b>${esc(d.estado_texto)}</b></p>${guia}
        <ul style="margin-top:10px">${(d.items || []).map(i => `<li>${i.cantidad} × ${esc(i.nombre)} · ${esc(i.color)} · ${esc(i.talla)}</li>`).join('')}</ul>
        <p class="muted small" style="margin-top:8px">Total: ${money(d.total)} · ${d.entrega === 'retiro' ? 'Retiro en tienda (Levittown, NY)' : 'Envío a domicilio'}</p></div>`;
    } catch (_) { if (origTrack) origTrack(e); }
  };

  } // fin PAGOS

  /* ---------- 6. Políticas legales y preguntas frecuentes ---------- */
  if (window.POLITICAS_TIENDA) {
    S.settings.policies = Object.assign({}, S.settings.policies, window.POLITICAS_TIENDA);
  }
  if (PAGOS) (S.faqs || []).forEach(f => {
    if (/métodos de pago/i.test(f.q)) f.a = 'Tarjeta de crédito o débito (Visa, Mastercard, American Express, Discover), Apple Pay y Google Pay con pago seguro de Stripe. Por ahora solo aceptamos pagos con tarjeta.';
  });
})();
