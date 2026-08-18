/* Mobile Trading — Local frontend → Google Sheets via Apps Script API */

let masters = { brands: [], models: [], colors: [], storage: [], suppliers: [], customers: [], parties: [] };
let items = [];
let scanner = null, scanTarget = null;
let editingPartyID = null;

/* ---- Lazy-load state (invoices + parties) ---- */
const invState = { page: 0, hasMore: true, loading: false, rows: [] };
const partyState = { page: 0, hasMore: true, loading: false, rows: [], q: '' };
let partyObserver = null, invObserver = null;

function makeObserver(sentinelId, onHit) {
  const el = $(sentinelId);
  if (!el) return null;
  const obs = new IntersectionObserver(entries => {
    entries.forEach(e => { if (e.isIntersecting) onHit(); });
  }, { root: null, rootMargin: '200px' });
  obs.observe(el);
  return obs;
}

const $ = id => document.getElementById(id);
function toast(msg, ok = true) {
  const t = $('toast');
  t.textContent = msg;
  t.style.display = 'block';
  t.style.background = ok ? '#111827' : '#991b1b';
  setTimeout(() => { t.style.display = 'none'; }, 3500);
}
function money(n) { return 'Rs ' + Number(n || 0).toLocaleString(); }
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
}
function fmtDate(v) {
  if (!v) return '';
  try { return new Date(v).toLocaleDateString(); } catch (e) { return String(v); }
}

/** Call Apps Script API */
async function api(action, data) {
  if (!API_URL || API_URL.includes('PASTE_YOUR')) {
    throw new Error('js/config.js mein API_URL set karo (Apps Script Deploy → /exec URL)');
  }
  const isWrite = data !== undefined && data !== null;
  let res;
  if (!isWrite) {
    // GET
    const url = API_URL + (API_URL.includes('?') ? '&' : '?') + 'action=' + encodeURIComponent(action) +
      (data && data.imei ? '&imei=' + encodeURIComponent(data.imei) : '') +
      (data && data.type ? '&type=' + encodeURIComponent(data.type) : '') +
      (data && data.partyID ? '&partyID=' + encodeURIComponent(data.partyID) : '');
    res = await fetch(url, { method: 'GET', redirect: 'follow' });
  } else {
    // POST — text/plain avoids CORS preflight issues with Apps Script
    res = await fetch(API_URL, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, data })
    });
  }
  if (!res.ok) throw new Error('API HTTP ' + res.status);
  const json = await res.json();
  if (json && json.ok === false && json.error) throw new Error(json.error);
  return json;
}

function nav(page) {
  document.querySelectorAll('.page').forEach(x => x.classList.remove('active'));
  $(page).classList.add('active');
  document.querySelectorAll('[data-page]').forEach(x => x.classList.toggle('active', x.dataset.page === page));
  const titles = { dashboard: 'Dashboard', transaction: 'Purchase / Sale', parties: 'Parties', ledger: 'Party Ledger', imei: 'IMEI History', masters: 'Masters' };
  $('title').textContent = titles[page] || page;
  if (page === 'ledger') fillLedgerParty();
}
document.querySelectorAll('[data-page]').forEach(b => b.onclick = () => nav(b.dataset.page));

async function loadAll() {
  try {
    const d = await api('getDashboard');
    $('dStock').textContent = d.stock || 0;
    $('dSold').textContent = d.sold || 0;
    $('dPurchase').textContent = money(d.purchaseAmount);
    $('dSales').textContent = money(d.saleAmount);
    $('dProfit').textContent = money(d.profit);
    hideApiBanner();
  } catch (e) {
    toast(e.message, false);
    showApiBanner(e.message);
  }
  resetInvoiceLazyLoad();
  try {
    const m = await api('getMasters');
    masters = m;
    renderMasters();
    resetParty();
    fillSelects();
    fillLedgerParty();
    hideApiBanner();
  } catch (e) {
    toast(e.message, false);
    showApiBanner(e.message);
  }
  resetPartyLazyLoad();
}

/* ---- Recent invoices: lazy loaded page by page (fast — only fetches what's shown) ---- */
function resetInvoiceLazyLoad() {
  invState.page = 0; invState.hasMore = true; invState.loading = false; invState.rows = [];
  $('recent').innerHTML = '';
  loadMoreInvoices();
  if (!invObserver) invObserver = makeObserver('recentSentinel', loadMoreInvoices);
}
async function loadMoreInvoices() {
  if (invState.loading || !invState.hasMore) return;
  invState.loading = true;
  $('recentSentinel').textContent = 'Loading...';
  try {
    const res = await api('getInvoicesPage', { page: invState.page + 1, pageSize: 15 });
    invState.page++;
    invState.hasMore = !!res.hasMore;
    const rows = res.rows || [];
    invState.rows.push(...rows);
    const html = rows.map(r => `<tr>
      <td>${esc(r.InvoiceNo)}</td><td>${esc(r.Type)}</td><td>${fmtDate(r.Date)}</td><td>${esc(r.PartyName)}</td>
      <td>${money(r.TotalAmount)}</td><td>${money(r.NetTotal != null && r.NetTotal !== '' ? r.NetTotal : r.TotalAmount)}</td><td>${money(r.PaidAmount)}</td>
      <td><button class="btn small" onclick="openEditInvoice('${r.InvoiceID}')">Edit</button>
      <button class="btn danger small" onclick="removeInvoice('${r.InvoiceID}','${esc(r.InvoiceNo)}')">Delete</button></td>
    </tr>`).join('');
    $('recent').insertAdjacentHTML('beforeend', html);
    if (!invState.rows.length) $('recent').innerHTML = '<tr><td colspan="8">No invoices yet</td></tr>';
    $('recentSentinel').textContent = invState.hasMore ? '' : (invState.rows.length ? 'End of list' : '');
  } catch (e) {
    $('recentSentinel').textContent = '';
    toast(e.message, false);
  } finally {
    invState.loading = false;
  }
}
function openEditInvoice(invoiceID) {
  const inv = invState.rows.find(r => r.InvoiceID === invoiceID);
  if (!inv) return;
  const netTotal = inv.NetTotal != null && inv.NetTotal !== '' ? inv.NetTotal : inv.TotalAmount;
  const discount = prompt('Discount (Rs):', inv.Discount || 0);
  if (discount === null) return;
  const paid = prompt('Paid Amount (Rs):', inv.PaidAmount || 0);
  if (paid === null) return;
  const remarks = prompt('Remarks:', inv.Remarks || '');
  if (remarks === null) return;
  api('updateTransaction', { invoiceID, discount: Number(discount || 0), paidAmount: Number(paid || 0), remarks })
    .then(() => { toast('Invoice updated'); resetInvoiceLazyLoad(); loadAll(); })
    .catch(e => toast(e.message, false));
}
async function removeInvoice(invoiceID, invoiceNo) {
  if (!confirm('Invoice ' + invoiceNo + ' delete karna hai? Stock revert ho jayega.')) return;
  try {
    await api('deleteTransaction', { invoiceID });
    toast('Invoice deleted');
    resetInvoiceLazyLoad();
    loadAll();
  } catch (e) { toast(e.message, false); }
}

function showApiBanner(msg) {
  const b = $('apiBanner');
  if (!b) return;
  b.style.display = 'block';
  b.innerHTML = '<b>API / Config error:</b> ' + esc(msg) +
    '<br>1) <code>js/config.js</code> mein API_URL set karo &nbsp; 2) Code.gs mein DATA_SHEET_ID set karo &nbsp; 3) setup() + Deploy (Anyone)';
}
function hideApiBanner() {
  const b = $('apiBanner');
  if (b) b.style.display = 'none';
}

function fillSelects() {
  $('brand').innerHTML = '<option value="">Select</option>' + (masters.brands || []).map(x => `<option value="${x.BrandID}">${esc(x.BrandName)}</option>`).join('');
  $('color').innerHTML = '<option value="">Select</option>' + (masters.colors || []).map(x => `<option value="${x.ColorName}">${esc(x.ColorName)}</option>`).join('');
  $('storage').innerHTML = '<option value="">Select</option>' + (masters.storage || []).map(x => `<option value="${x.StorageName}">${esc(x.StorageName)}</option>`).join('');
  filterModels();
  $('masterBrand').innerHTML = (masters.brands || []).map(x => `<option value="${x.BrandID}">${esc(x.BrandName)}</option>`).join('');
}
function filterModels() {
  const b = $('brand').value;
  $('model').innerHTML = '<option value="">Select</option>' + (masters.models || []).filter(x => !b || x.BrandID === b).map(x => `<option value="${x.ModelName}">${esc(x.ModelName)}</option>`).join('');
}
function resetParty() {
  const sale = $('txType').value === 'Sale';
  const arr = sale ? masters.customers : masters.suppliers;
  $('party').innerHTML = '<option value="">Select</option>' + (arr || []).map(x => `<option value="${x.PartyID}" data-name="${esc(x.Name)}">${esc(x.Name)}</option>`).join('');
}
function txTypeChanged() {
  $('partyLabel').textContent = $('txType').value === 'Sale' ? 'Customer' : 'Supplier';
  resetParty();
  items = [];
  renderItems();
  updatePriceBox();
}

async function addItem() {
  const imei1 = $('imei1').value.replace(/\D/g, '');
  const imei2 = $('imei2').value.replace(/\D/g, '');
  if (!/^\d{14,16}$/.test(imei1)) return toast('Valid IMEI 1 required', false);
  if (imei2 && !/^\d{14,16}$/.test(imei2)) return toast('Valid IMEI 2 required', false);
  if (imei2 && imei1 === imei2) return toast('IMEI 1 and 2 same nahi ho sakte', false);
  if (items.some(x => x.imei1 === imei1 || x.imei2 === imei1 || (imei2 && (x.imei1 === imei2 || x.imei2 === imei2)))) {
    return toast('IMEI already in this invoice', false);
  }
  const type = $('txType').value;
  try {
    const r = await api('checkIMEI', null);
    // GET with query
    const r1 = await fetch(
      API_URL + (API_URL.includes('?') ? '&' : '?') + 'action=checkIMEI&imei=' + encodeURIComponent(imei1) + '&type=' + encodeURIComponent(type),
      { redirect: 'follow' }
    ).then(x => x.json());
    if (!r1.ok) return toast(r1.message || 'IMEI check failed', false);
    if (imei2) {
      const r2 = await fetch(
        API_URL + (API_URL.includes('?') ? '&' : '?') + 'action=checkIMEI&imei=' + encodeURIComponent(imei2) + '&type=' + encodeURIComponent(type),
        { redirect: 'follow' }
      ).then(x => x.json());
      if (!r2.ok) return toast(r2.message || 'IMEI2 check failed', false);
    }
    let brandName = '', model = '', color = '', storage = '';
    let purchasePrice = Number($('purchasePrice').value || 0);
    let salePrice = Number($('salePrice').value || 0);
    if (r1.stock) {
      brandName = r1.stock.Brand || '';
      model = r1.stock.Model || '';
      color = r1.stock.Color || '';
      storage = r1.stock.Storage || '';
      if (!purchasePrice) purchasePrice = Number(r1.stock.PurchasePrice || 0);
      const brandOpt = [...$('brand').options].find(o => o.textContent === brandName);
      if (brandOpt) { $('brand').value = brandOpt.value; filterModels(); $('model').value = model; }
      $('color').value = color;
      $('storage').value = storage;
      if (!$('purchasePrice').value) $('purchasePrice').value = purchasePrice;
    } else {
      const b = (masters.brands || []).find(x => x.BrandID === $('brand').value);
      brandName = b ? b.BrandName : '';
      model = $('model').value;
      color = $('color').value;
      storage = $('storage').value;
    }
    items.push({ imei1, imei2, brand: brandName, model, color, storage, purchasePrice, salePrice });
    clearItemForm();
    renderItems();
    updatePriceBox();
  } catch (e) {
    toast(e.message, false);
  }
}
function clearItemForm() { ['imei1', 'imei2', 'purchasePrice', 'salePrice'].forEach(id => $(id).value = ''); }
function clearImei(id) { $(id).value = ''; }

function renderItems() {
  const isPurchase = $('txType').value === 'Purchase';
  $('items').innerHTML = items.map((x, i) => {
    const profit = (Number(x.salePrice) || 0) - (Number(x.purchasePrice) || 0);
    return `<tr><td>${i + 1}</td><td>${x.imei1}</td><td>${x.imei2 || '-'}</td><td>${esc(x.brand)} ${esc(x.model)}</td><td>${esc(x.color)}</td><td>${money(x.purchasePrice)}</td><td>${money(x.salePrice)}</td><td>${isPurchase ? '-' : money(profit)}</td><td><button class="btn danger small" onclick="items.splice(${i},1);renderItems();updatePriceBox()">Remove</button></td></tr>`;
  }).join('');
  updatePriceBox();
}
function updatePriceBox() {
  const isPurchase = $('txType').value === 'Purchase';
  const sub = items.reduce((a, x) => a + (isPurchase ? Number(x.purchasePrice || 0) : Number(x.salePrice || 0)), 0);
  const disc = Math.max(0, Number($('discount').value || 0));
  const net = Math.max(0, sub - disc);
  const paidRaw = $('paidAmount').value;
  const paid = paidRaw === '' || paidRaw == null ? net : Math.max(0, Number(paidRaw) || 0);
  $('txSubtotal').textContent = money(sub);
  $('txDiscount').textContent = money(disc);
  $('txNet').textContent = money(net);
  $('txPaid').textContent = money(paid);
  $('txBalance').textContent = money(net - paid);
}

async function saveTx() {
  if (!items.length) return toast('Add at least one mobile', false);
  const p = $('party');
  const opt = p.options[p.selectedIndex];
  const isPurchase = $('txType').value === 'Purchase';
  const sub = items.reduce((a, x) => a + (isPurchase ? Number(x.purchasePrice || 0) : Number(x.salePrice || 0)), 0);
  const disc = Math.max(0, Number($('discount').value || 0));
  const net = Math.max(0, sub - disc);
  const paidRaw = $('paidAmount').value;
  const paid = paidRaw === '' || paidRaw == null ? net : Math.max(0, Number(paidRaw) || 0);
  try {
    const r = await api('saveTransaction', {
      type: $('txType').value,
      invoiceNo: $('invoiceNo').value,
      date: $('txDate').value,
      partyID: p.value,
      partyName: opt ? opt.dataset.name : '',
      paymentMethod: $('payment').value,
      remarks: $('remarks').value,
      discount: disc,
      paidAmount: paid,
      items
    });
    toast('Saved ' + r.invoiceNo + ' | Net ' + money(r.netTotal));
    items = [];
    renderItems();
    $('invoiceNo').value = '';
    $('remarks').value = '';
    $('discount').value = 0;
    $('paidAmount').value = '';
    updatePriceBox();
    loadAll();
  } catch (e) {
    toast(e.message, false);
  }
}

/* Parties */
async function saveParty() {
  const name = $('pName').value.trim();
  if (!name) return toast('Name required', false);
  const payload = {
    type: $('pType').value, name,
    mobile: $('pMobile').value, address: $('pAddress').value,
    remarks: $('pRemarks').value, openingBalance: Number($('pOpening').value || 0)
  };
  try {
    if (editingPartyID) {
      await api('updateParty', Object.assign({ partyID: editingPartyID }, payload));
      toast('Party updated');
    } else {
      await api('saveParty', payload);
      toast('Party saved');
    }
    cancelEditParty();
    resetPartyLazyLoad();
    loadAll();
  } catch (e) { toast(e.message, false); }
}
function editParty(id) {
  const p = partyState.rows.find(x => x.PartyID === id);
  if (!p) return;
  editingPartyID = id;
  $('pType').value = p.PartyType;
  $('pName').value = p.Name;
  $('pMobile').value = p.Mobile;
  $('pAddress').value = p.Address;
  $('pRemarks').value = p.Remarks;
  $('pOpening').value = p.OpeningBalance || 0;
  $('partyFormTitle').textContent = 'Edit Party';
  $('partySaveBtn').textContent = 'Update Party';
  $('partyCancelBtn').style.display = 'inline-block';
  $('pName').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function cancelEditParty() {
  editingPartyID = null;
  ['pName', 'pMobile', 'pAddress', 'pRemarks'].forEach(id => $(id).value = '');
  $('pOpening').value = 0;
  $('partyFormTitle').textContent = 'Add Party';
  $('partySaveBtn').textContent = '+ Save Party';
  $('partyCancelBtn').style.display = 'none';
}
async function removeParty(id, name) {
  if (!confirm('Party "' + name + '" delete karni hai?')) return;
  try {
    await api('deleteParty', { partyID: id });
    toast('Party deleted');
    resetPartyLazyLoad();
    loadAll();
  } catch (e) { toast(e.message, false); }
}

function resetPartyLazyLoad() {
  partyState.page = 0; partyState.hasMore = true; partyState.loading = false; partyState.rows = [];
  $('partyList').innerHTML = '';
  loadMoreParties();
  if (!partyObserver) partyObserver = makeObserver('partySentinel', loadMoreParties);
}
function searchParties() {
  partyState.q = $('partySearch') ? $('partySearch').value.trim() : '';
  resetPartyLazyLoad();
}
async function loadMoreParties() {
  if (partyState.loading || !partyState.hasMore) return;
  partyState.loading = true;
  $('partySentinel').textContent = 'Loading...';
  try {
    const res = await api('getPartiesPage', { page: partyState.page + 1, pageSize: 20, q: partyState.q });
    partyState.page++;
    partyState.hasMore = !!res.hasMore;
    const rows = res.rows || [];
    partyState.rows.push(...rows);
    const html = rows.map(p => `<tr>
      <td>${esc(p.PartyID)}</td>
      <td><span class="badge ${p.PartyType === 'Supplier' ? 'sup' : 'cus'}">${p.PartyType}</span></td>
      <td>${esc(p.Name)}</td><td>${esc(p.Mobile)}</td>
      <td>${money(p.OpeningBalance)}</td><td>${esc(p.Address)}</td>
      <td>
        <button class="btn small primary" onclick="openLedgerFor('${p.PartyID}')">Ledger</button>
        <button class="btn small" onclick="editParty('${p.PartyID}')">Edit</button>
        <button class="btn danger small" onclick="removeParty('${p.PartyID}','${esc(p.Name)}')">Delete</button>
      </td>
    </tr>`).join('');
    $('partyList').insertAdjacentHTML('beforeend', html);
    if (!partyState.rows.length) $('partyList').innerHTML = '<tr><td colspan="7">No parties yet</td></tr>';
    $('partySentinel').textContent = partyState.hasMore ? '' : (partyState.rows.length ? 'End of list' : '');
  } catch (e) {
    $('partySentinel').textContent = '';
    toast(e.message, false);
  } finally {
    partyState.loading = false;
  }
}
function openLedgerFor(id) { nav('ledger'); $('ledgerParty').value = id; loadLedger(); }

/* Ledger */
function fillLedgerParty() {
  const list = masters.parties || [];
  $('ledgerParty').innerHTML = '<option value="">Select party</option>' + list.map(p => `<option value="${p.PartyID}">${esc(p.Name)} (${p.PartyType})</option>`).join('');
}
async function loadLedger() {
  const id = $('ledgerParty').value;
  if (!id) { $('ledgerResult').innerHTML = ''; return; }
  try {
    const data = await fetch(
      API_URL + (API_URL.includes('?') ? '&' : '?') + 'action=getPartyLedger&partyID=' + encodeURIComponent(id),
      { redirect: 'follow' }
    ).then(r => r.json());
    if (data.error) throw new Error(data.error);
    const s = data.summary, party = data.party;
    let html = `<div class="panel"><h3>${esc(party.Name)} <span class="badge ${party.PartyType === 'Supplier' ? 'sup' : 'cus'}">${party.PartyType}</span></h3>
      <p style="color:var(--muted);margin:4px 0 12px">${esc(party.Mobile || '')}</p>
      <div class="ledger-sum">
        <div class="card"><div class="label">Opening</div><div class="num">${money(s.opening)}</div></div>
        <div class="card"><div class="label">Invoices</div><div class="num">${money(s.totalInvoices)}</div></div>
        <div class="card"><div class="label">Paid</div><div class="num">${money(s.totalPaid)}</div></div>
        <div class="card"><div class="label">${esc(s.label)}</div><div class="num">${money(s.balance)}</div></div>
      </div>
      <div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>Type</th><th>Ref</th><th>Description</th><th>Debit</th><th>Credit</th><th>Balance</th></tr></thead><tbody>`;
    (data.rows || []).forEach(r => {
      html += `<tr><td>${fmtDate(r.date)}</td><td>${r.type}</td><td>${esc(r.ref)}</td><td>${esc(r.description)}</td><td>${r.debit ? money(r.debit) : '-'}</td><td>${r.credit ? money(r.credit) : '-'}</td><td><b>${money(r.balance)}</b></td></tr>`;
    });
    if (!(data.rows || []).length) html += '<tr><td colspan="7">No transactions</td></tr>';
    html += '</tbody></table></div></div>';
    $('ledgerResult').innerHTML = html;
  } catch (e) {
    $('ledgerResult').innerHTML = `<div class="panel" style="color:#b91c1c">${esc(e.message)}</div>`;
  }
}
function showPayForm() {
  if (!$('ledgerParty').value) return toast('Select party first', false);
  $('payForm').style.display = 'block';
  $('payDate').value = new Date().toISOString().slice(0, 10);
}
async function savePay() {
  const partyID = $('ledgerParty').value;
  const amount = Number($('payAmount').value || 0);
  if (!partyID || amount <= 0) return toast('Party + amount required', false);
  try {
    await api('savePayment', {
      partyID, amount, date: $('payDate').value,
      method: $('payMethod').value, remarks: $('payRemarks').value
    });
    toast('Payment saved');
    $('payAmount').value = '';
    $('payRemarks').value = '';
    $('payForm').style.display = 'none';
    loadLedger();
    loadAll();
  } catch (e) { toast(e.message, false); }
}

/* IMEI */
async function searchImei() {
  const v = $('searchImei').value.replace(/\D/g, '');
  if (!v) return toast('Enter IMEI', false);
  try {
    const r = await fetch(
      API_URL + (API_URL.includes('?') ? '&' : '?') + 'action=searchIMEI&imei=' + encodeURIComponent(v),
      { redirect: 'follow' }
    ).then(x => x.json());
    if (!r.found) { $('imeiResult').innerHTML = '<div class="panel">IMEI not found.</div>'; return; }
    const s = r.stock;
    $('imeiResult').innerHTML = `<div class="panel history"><h3>${esc(s.Brand)} ${esc(s.Model)} — ${esc(s.Color)}</h3>
      <p><b>IMEI 1:</b> ${s.IMEI1}<br><b>IMEI 2:</b> ${s.IMEI2 || '-'}<br><b>Status:</b> <span class="badge ${s.Status === 'Sold' ? 'sold' : ''}">${s.Status}</span></p>
      <hr><b>Purchase</b><br>Invoice: ${s.PurchaseInvoice}<br>Date: ${fmtDate(s.PurchaseDate)}<br>Supplier: ${esc(s.Supplier)}<br>Price: ${money(s.PurchasePrice)}
      <hr><b>Sale</b><br>Invoice: ${s.SaleInvoice || '-'}<br>Date: ${fmtDate(s.SaleDate)}<br>Customer: ${esc(s.Customer)}<br>Price: ${money(s.SalePrice)}
      <hr><b>Profit:</b> ${money((Number(s.SalePrice) || 0) - (Number(s.PurchasePrice) || 0))}</div>`;
  } catch (e) { toast(e.message, false); }
}

/* Masters */
function masterRow(type, id, label, extra) {
  return `<div class="master-row">
    <span>• ${esc(label)}${extra ? ' (' + esc(extra) + ')' : ''}</span>
    <span>
      <button class="btn small" onclick="editMaster('${type}','${id}')">Edit</button>
      <button class="btn danger small" onclick="removeMaster('${type}','${id}')">Delete</button>
    </span>
  </div>`;
}
function renderMasters() {
  $('brandList').innerHTML = (masters.brands || []).map(x => masterRow('Brand', x.BrandID, x.BrandName)).join('') || 'None';
  $('colorList').innerHTML = (masters.colors || []).map(x => masterRow('Color', x.ColorID, x.ColorName)).join('') || 'None';
  $('storageList').innerHTML = (masters.storage || []).map(x => masterRow('Storage', x.StorageID, x.StorageName)).join('') || 'None';
  $('modelList').innerHTML = (masters.models || []).map(x => {
    const bn = ((masters.brands || []).find(b => b.BrandID === x.BrandID) || {}).BrandName || '';
    return masterRow('Model', x.ModelID, x.ModelName, bn);
  }).join('') || 'None';
}
function masterTypeChanged() {
  $('masterBrandWrap').style.display = $('masterType').value === 'Model' ? 'block' : 'none';
}
async function saveMaster() {
  const t = $('masterType').value;
  const data = { type: t, name: $('masterName').value, brandID: $('masterBrand').value };
  if (!data.name) return toast('Enter name', false);
  try {
    await api('saveMaster', data);
    toast('Master saved');
    $('masterName').value = '';
    loadAll();
  } catch (e) { toast(e.message, false); }
}
function findMasterList(type) {
  return type === 'Brand' ? masters.brands : type === 'Model' ? masters.models : type === 'Color' ? masters.colors : masters.storage;
}
function masterNameKey(type) {
  return type === 'Brand' ? 'BrandName' : type === 'Model' ? 'ModelName' : type === 'Color' ? 'ColorName' : 'StorageName';
}
function masterIdKey(type) {
  return type === 'Brand' ? 'BrandID' : type === 'Model' ? 'ModelID' : type === 'Color' ? 'ColorID' : 'StorageID';
}
async function editMaster(type, id) {
  const item = (findMasterList(type) || []).find(x => x[masterIdKey(type)] === id);
  if (!item) return;
  const newName = prompt('New name for ' + type + ':', item[masterNameKey(type)]);
  if (newName === null || !newName.trim()) return;
  try {
    await api('updateMaster', { type, id, name: newName.trim(), brandID: item.BrandID });
    toast(type + ' updated');
    loadAll();
  } catch (e) { toast(e.message, false); }
}
async function removeMaster(type, id) {
  if (!confirm('Delete this ' + type + '?')) return;
  try {
    await api('deleteMaster', { type, id });
    toast(type + ' deleted');
    loadAll();
  } catch (e) { toast(e.message, false); }
}

/* Scanner */
async function openScanner(target) {
  scanTarget = target;
  $('modal').classList.add('open');
  $('scanStatus').textContent = 'Starting camera...';
  try {
    if (!window.Html5Qrcode) return setTimeout(() => openScanner(target), 500);
    scanner = new Html5Qrcode('reader');
    await scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 280, height: 140 } }, decoded => {
      const digits = decoded.replace(/\D/g, '');
      if (/^\d{14,16}$/.test(digits)) {
        $(scanTarget).value = digits;
        toast('IMEI scanned');
        closeScanner();
      } else $('scanStatus').textContent = 'Not a 14–16 digit IMEI';
    }, () => {});
  } catch (e) {
    $('scanStatus').textContent = 'Camera failed — use manual entry';
  }
}
async function closeScanner() {
  try { if (scanner) { await scanner.stop(); await scanner.clear(); } } catch (e) {}
  scanner = null;
  $('modal').classList.remove('open');
  $('reader').innerHTML = '';
}

function init() {
  const d = new Date();
  $('txDate').value = d.toISOString().slice(0, 10);
  if ($('payDate')) $('payDate').value = d.toISOString().slice(0, 10);
  if (!API_URL || API_URL.includes('PASTE_YOUR')) {
    showApiBanner('API_URL missing — open js/config.js');
  }
  loadAll();
}
window.addEventListener('load', init);
