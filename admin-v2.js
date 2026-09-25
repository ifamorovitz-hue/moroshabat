(function(){
  'use strict';

  var GH_API = 'https://api.github.com';
  var DEALS_PATH = 'data/deals.json';
  var CONTENT_PATH = 'data/site-content.json';
  var VAULT_PATH = 'data/admin-auth.json';
  var conn = null;
  var contentCache = null; // {data, sha}
  var dealsCache = null;   // {data, sha}
  var editModeActive = false;
  var pendingImageFile = null;
  var editingDealId = null;
  var selDateFrom = null, selDateTo = null;
  var calViewYear, calViewMonth;
  var calToday = new Date(); calToday.setHours(0, 0, 0, 0);
  var HEBREW_MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  var ieTiersList = [];

  function ieEl(id){ return document.getElementById(id); }
  function ieShowStatus(id, type, msg){
    var c = ieEl(id);
    if (!msg) { c.innerHTML = ''; return; }
    c.innerHTML = '<div class="ie-status ' + type + '">' + escapeHTML(msg) + '</div>';
  }
  function escapeHtmlNl(str){ return escapeHTML(str).replace(/\n/g, '<br>'); }
  function pad2(n){ return String(n).length < 2 ? '0' + n : String(n); }
  function isoDate(y, m, d){ return y + '-' + pad2(m + 1) + '-' + pad2(d); }
  function parseIsoDate(iso){ var b = iso.split('-'); return new Date(parseInt(b[0],10), parseInt(b[1],10)-1, parseInt(b[2],10)); }
  function fullDateLabel(iso){ var d = parseIsoDate(iso); return pad2(d.getDate())+'/'+pad2(d.getMonth()+1)+'/'+d.getFullYear(); }
  function formatDatePart(iso){
    if (!iso) return '';
    var bits = iso.split('-');
    var y = parseInt(bits[0], 10), m = bits[1], day = bits[2];
    var thisYear = new Date().getFullYear();
    return y === thisYear ? (day + '/' + m) : (day + '/' + m + '/' + String(y).slice(-2));
  }
  function formatDateRange(fromIso, toIso, note){
    var range = '';
    if (fromIso && toIso) range = formatDatePart(fromIso) + '–' + formatDatePart(toIso);
    else if (fromIso) range = formatDatePart(fromIso);
    else if (toIso) range = formatDatePart(toIso);
    if (note) range = range ? (range + ' (' + note + ')') : note;
    return range;
  }

  // ---------- base64 + crypto (vault format) ----------
  function b64EncodeUnicode(str){
    return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, function(_, p1){ return String.fromCharCode('0x' + p1); }));
  }
  function b64DecodeUnicode(str){
    return decodeURIComponent(atob(str).split('').map(function(c){ return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2); }).join(''));
  }
  function bufToB64(buf){
    var bytes = new Uint8Array(buf), binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  function b64ToBuf(b64){
    var binary = atob(b64), bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }
  function ieDeriveKey(password, saltBuf){
    var enc = new TextEncoder();
    return crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']).then(function(km){
      return crypto.subtle.deriveKey({ name:'PBKDF2', salt:saltBuf, iterations:300000, hash:'SHA-256' }, km, { name:'AES-GCM', length:256 }, false, ['decrypt']);
    });
  }
  function ieDecryptVault(password, vault){
    var salt = b64ToBuf(vault.salt), iv = b64ToBuf(vault.iv);
    return ieDeriveKey(password, salt).then(function(key){
      return crypto.subtle.decrypt({ name:'AES-GCM', iv: iv }, key, b64ToBuf(vault.data));
    }).then(function(plainBuf){ return JSON.parse(new TextDecoder().decode(plainBuf)); });
  }

  // ---------- GitHub API ----------
  function ghHeaders(){ return { 'Authorization': 'token ' + conn.token, 'Accept': 'application/vnd.github+json' }; }
  function ghGetFile(path){
    return fetch(GH_API + '/repos/' + conn.owner + '/' + conn.repo + '/contents/' + path + '?ref=' + encodeURIComponent(conn.branch), { headers: ghHeaders() })
      .then(function(res){
        if (!res.ok) return res.json().then(function(e){ throw new Error(e.message || ('שגיאה ' + res.status)); });
        return res.json();
      });
  }
  function ghPutFile(path, base64Content, message, sha){
    var body = { message: message, content: base64Content, branch: conn.branch };
    if (sha) body.sha = sha;
    return fetch(GH_API + '/repos/' + conn.owner + '/' + conn.repo + '/contents/' + path, {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders()),
      body: JSON.stringify(body)
    }).then(function(res){
      if (!res.ok) return res.json().then(function(e){ throw new Error(e.message || ('שגיאה ' + res.status)); });
      return res.json();
    });
  }
  function ghDeleteFile(path, message){
    return ghGetFile(path).then(function(existing){
      return fetch(GH_API + '/repos/' + conn.owner + '/' + conn.repo + '/contents/' + path, {
        method: 'DELETE',
        headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders()),
        body: JSON.stringify({ message: message, sha: existing.sha, branch: conn.branch })
      }).then(function(res){
        if (!res.ok) return res.json().then(function(e){ throw new Error(e.message || ('שגיאה ' + res.status)); });
        return res.json();
      });
    });
  }
  function fileToBase64(file){
    return new Promise(function(resolve, reject){
      var reader = new FileReader();
      reader.onload = function(){ resolve(reader.result.split(',')[1]); };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }
  function safeFileName(name){
    var parts = name.split('.');
    var ext = parts.length > 1 ? parts.pop().toLowerCase() : '';
    var base = parts.join('.').toLowerCase().replace(/[^a-z0-9-_]+/g,'-').replace(/^-+|-+$/g,'') || 'img';
    return base + (ext ? '.' + ext : '');
  }
  function uploadImage(file){
    var path = 'uploads/' + Date.now() + '-' + safeFileName(file.name);
    return fileToBase64(file).then(function(base64){
      return ghPutFile(path, base64, 'העלאת תמונה: ' + file.name, null);
    }).then(function(){ return path; });
  }
  function genDealId(){ return 'deal-' + Date.now().toString(36) + Math.random().toString(36).slice(2,6); }

  // ---------- Public content load (runs for every visitor, no login needed) ----------
  var CONTENT_FIELD_MAP = [
    { id: 'c2-heroTitle', key: 'v2HeroTitle', label: 'כותרת ראשית (הירו)', render: 'heroTitle' },
    { id: 'c2-heroLede', key: 'v2HeroLede', label: 'תת-כותרת הירו', render: 'nl' },
    { id: 'c2-benefit1Title', key: 'v2Benefit1Title', label: 'יתרון 1 כותרת', render: 'text' },
    { id: 'c2-benefit1Text', key: 'v2Benefit1Text', label: 'יתרון 1 טקסט', render: 'nl' },
    { id: 'c2-benefit2Title', key: 'v2Benefit2Title', label: 'יתרון 2 כותרת', render: 'text' },
    { id: 'c2-benefit2Text', key: 'v2Benefit2Text', label: 'יתרון 2 טקסט', render: 'nl' },
    { id: 'c2-benefit3Title', key: 'v2Benefit3Title', label: 'יתרון 3 כותרת', render: 'text' },
    { id: 'c2-benefit3Text', key: 'v2Benefit3Text', label: 'יתרון 3 טקסט', render: 'nl' },
    { id: 'c2-benefit4Title', key: 'v2Benefit4Title', label: 'יתרון 4 כותרת', render: 'text' },
    { id: 'c2-benefit4Text', key: 'v2Benefit4Text', label: 'יתרון 4 טקסט', render: 'nl' },
    { id: 'c2-packagesTitle', key: 'v2PackagesTitle', label: 'כותרת מדור החבילות', render: 'text' },
    { id: 'c2-packagesLede', key: 'v2PackagesLede', label: 'תיאור מדור החבילות', render: 'nl' },
    { id: 'c2-aboutTitle', key: 'v2AboutTitle', label: 'כותרת אודות', render: 'text' },
    { id: 'c2-aboutText1', key: 'v2AboutText1', label: 'אודות פסקה 1', render: 'text' },
    { id: 'c2-aboutText2', key: 'v2AboutText2', label: 'אודות פסקה 2', render: 'text' },
    { id: 'c2-whyTitle', key: 'v2WhyTitle', label: 'כותרת "למה להזמין ולא לבד"', render: 'text' },
    { id: 'c2-why1Title', key: 'v2Why1Title', label: 'סיבה 1 כותרת', render: 'text' },
    { id: 'c2-why1Text', key: 'v2Why1Text', label: 'סיבה 1 טקסט', render: 'text' },
    { id: 'c2-why2Title', key: 'v2Why2Title', label: 'סיבה 2 כותרת', render: 'text' },
    { id: 'c2-why2Text', key: 'v2Why2Text', label: 'סיבה 2 טקסט', render: 'text' },
    { id: 'c2-why3Title', key: 'v2Why3Title', label: 'סיבה 3 כותרת', render: 'text' },
    { id: 'c2-why3Text', key: 'v2Why3Text', label: 'סיבה 3 טקסט', render: 'text' },
    { id: 'c2-why4Title', key: 'v2Why4Title', label: 'סיבה 4 כותרת', render: 'text' },
    { id: 'c2-why4Text', key: 'v2Why4Text', label: 'סיבה 4 טקסט', render: 'text' },
    { id: 'c2-contactTitle', key: 'v2ContactTitle', label: 'כותרת טופס יצירת קשר', render: 'nl' },
    { id: 'c2-contactLede', key: 'v2ContactLede', label: 'תיאור טופס יצירת קשר', render: 'nl' }
  ];

  function applyFieldValue(f, val){
    var el = ieEl(f.id);
    if (!el || val == null) return;
    if (f.render === 'nl') el.innerHTML = escapeHtmlNl(val);
    else if (f.render === 'heroTitle') {
      var parts = String(val).split('\n');
      el.innerHTML = escapeHTML(parts[0] || '') + '<br><em>' + escapeHTML(parts.slice(1).join('\n') || '') + '</em>';
    } else {
      el.textContent = val;
    }
  }
  function applyAllContent(data){
    CONTENT_FIELD_MAP.forEach(function(f){ applyFieldValue(f, data[f.key]); });
  }
  function loadPublicContent(){
    fetch(CONTENT_PATH, { cache: 'no-store' })
      .catch(function(){ return fetch('https://raw.githubusercontent.com/ifamorovitz-hue/moroshabat/main/' + CONTENT_PATH + '?t=' + Date.now(), { cache: 'no-store' }); })
      .then(function(r){ return r.json(); })
      .then(applyAllContent)
      .catch(function(){ /* keep the page's built-in default text */ });
  }
  loadPublicContent();

  // ---------- Login ----------
  var footerAdminLink = ieEl('footerAdminLink2');
  if (footerAdminLink) footerAdminLink.addEventListener('click', function(e){
    e.preventDefault();
    ieShowStatus('ieLoginStatus', '', '');
    ieEl('ieLoginOverlay').hidden = false;
  });
  ieEl('ieLoginCancelBtn').addEventListener('click', function(){ ieEl('ieLoginOverlay').hidden = true; });

  ieEl('ieLoginBtn').addEventListener('click', function(){
    var username = ieEl('ieUsername').value.trim();
    var password = ieEl('iePassword').value;
    if (!username || !password) { ieShowStatus('ieLoginStatus', 'error', 'יש למלא שם משתמש וסיסמה.'); return; }
    ieShowStatus('ieLoginStatus', 'info', 'מתחבר…');
    fetch('https://raw.githubusercontent.com/ifamorovitz-hue/moroshabat/main/' + VAULT_PATH + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(vault){
        if (!vault || username.toLowerCase() !== String(vault.username || '').toLowerCase()) throw new Error('שם משתמש או סיסמה שגויים.');
        return ieDecryptVault(password, vault);
      })
      .then(function(c){
        conn = c;
        return Promise.all([ghGetFile(DEALS_PATH), ghGetFile(CONTENT_PATH)]);
      })
      .then(function(results){
        dealsCache = { data: JSON.parse(b64DecodeUnicode(results[0].content)), sha: results[0].sha };
        contentCache = { data: JSON.parse(b64DecodeUnicode(results[1].content)), sha: results[1].sha };
        enterEditMode();
      })
      .catch(function(){
        conn = null;
        ieShowStatus('ieLoginStatus', 'error', 'שם משתמש או סיסמה שגויים, או שהטוקן השמור כבר לא תקף.');
      });
  });

  function refreshDealsView(){
    window.deals = dealsCache.data.filter(function(d){ return d.active !== false; }).sort(function(a,b){ return (a.order||0)-(b.order||0); });
    var activeBtn = document.querySelector('[data-filter].active');
    window.render(activeBtn ? activeBtn.dataset.filter : 'all');
    if (editModeActive) injectAdminButtons();
  }

  function enterEditMode(){
    ieEl('ieLoginOverlay').hidden = true;
    ieEl('iePassword').value = '';
    document.body.classList.add('edit-mode');
    editModeActive = true;
    applyAllContent(contentCache.data);
    attachContentPencils();
    refreshDealsView();
  }
  ieEl('ieLogoutBtn').addEventListener('click', function(){
    conn = null; contentCache = null; dealsCache = null; editModeActive = false;
    document.body.classList.remove('edit-mode');
    window.deals = window.deals || [];
    window.render(document.querySelector('[data-filter].active') ? document.querySelector('[data-filter].active').dataset.filter : 'all');
  });

  // ---------- Content pencils ----------
  var currentTextField = null;
  function pencilSvg(){
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>';
  }
  function trashSvg(){
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z"/></svg>';
  }
  function attachContentPencils(){
    CONTENT_FIELD_MAP.forEach(function(f){
      var el = ieEl(f.id);
      if (!el) return;
      el.setAttribute('data-editable', '');
      var old = el.querySelector('.edit-pencil');
      if (old) old.remove();
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'edit-pencil';
      btn.setAttribute('aria-label', 'עריכה');
      btn.innerHTML = pencilSvg();
      btn.addEventListener('click', function(e){ e.preventDefault(); e.stopPropagation(); openTextEditor(f); });
      el.appendChild(btn);
    });
  }
  function openTextEditor(f){
    currentTextField = f;
    ieEl('ieTextTitle').textContent = f.label;
    ieEl('ieTextValue').value = (contentCache && contentCache.data[f.key]) || '';
    ieShowStatus('ieTextStatus', '', '');
    ieEl('ieTextOverlay').hidden = false;
  }
  ieEl('ieTextCancelBtn').addEventListener('click', function(){ ieEl('ieTextOverlay').hidden = true; });
  ieEl('ieTextSaveBtn').addEventListener('click', function(){
    if (!currentTextField) return;
    var val = ieEl('ieTextValue').value;
    var btn = ieEl('ieTextSaveBtn');
    btn.disabled = true;
    ieShowStatus('ieTextStatus', 'info', 'שומר…');
    var updated = Object.assign({}, contentCache.data);
    updated[currentTextField.key] = val;
    var body = b64EncodeUnicode(JSON.stringify(updated, null, 2));
    ghPutFile(CONTENT_PATH, body, 'עדכון תוכן (גרסה 2): ' + currentTextField.label, contentCache.sha).then(function(res){
      contentCache.data = updated;
      contentCache.sha = res.content.sha;
      applyAllContent(contentCache.data);
      attachContentPencils();
      ieEl('ieTextOverlay').hidden = true;
    }).catch(function(err){
      ieShowStatus('ieTextStatus', 'error', 'שמירה נכשלה: ' + err.message);
    }).finally(function(){ btn.disabled = false; });
  });

  // ---------- Date-range calendar ----------
  function renderIeCalendar(){
    ieEl('ieCalMonthLabel').textContent = HEBREW_MONTHS[calViewMonth] + ' ' + calViewYear;
    var grid = ieEl('ieCalGrid');
    grid.innerHTML = '';
    var startWeekday = new Date(calViewYear, calViewMonth, 1).getDay();
    var daysInMonth = new Date(calViewYear, calViewMonth + 1, 0).getDate();
    for (var i = 0; i < startWeekday; i++) {
      var empty = document.createElement('span');
      empty.className = 'ie-cal-day ie-cal-day-empty';
      grid.appendChild(empty);
    }
    for (var day = 1; day <= daysInMonth; day++) {
      var iso = isoDate(calViewYear, calViewMonth, day);
      var thisDate = new Date(calViewYear, calViewMonth, day);
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ie-cal-day';
      btn.textContent = day;
      if (thisDate < calToday) { btn.disabled = true; }
      else {
        btn.addEventListener('click', (function(clickedIso){ return function(e){ e.stopPropagation(); onIeCalDayClick(clickedIso); }; })(iso));
      }
      if (selDateFrom === iso && selDateTo === iso) btn.classList.add('ie-cal-day-single');
      else if (selDateFrom === iso) btn.classList.add('ie-cal-day-start');
      else if (selDateTo === iso) btn.classList.add('ie-cal-day-end');
      else if (selDateFrom && selDateTo && iso > selDateFrom && iso < selDateTo) btn.classList.add('ie-cal-day-inrange');
      grid.appendChild(btn);
    }
    ieEl('ieCalPrev').disabled = (calViewYear === calToday.getFullYear() && calViewMonth === calToday.getMonth());
  }
  function onIeCalDayClick(iso){
    if (!selDateFrom || (selDateFrom && selDateTo)) { selDateFrom = iso; selDateTo = null; }
    else if (iso < selDateFrom) { selDateFrom = iso; selDateTo = null; }
    else { selDateTo = iso; }
    renderIeCalendar();
  }
  function updateIeDateRangeLabel(){
    var btn = ieEl('ieDateRangeBtn');
    if (selDateFrom && selDateTo) btn.textContent = fullDateLabel(selDateFrom) + '  –  ' + fullDateLabel(selDateTo);
    else if (selDateFrom) btn.textContent = fullDateLabel(selDateFrom) + '  –  …';
    else btn.textContent = 'בחירת טווח תאריכים';
  }
  function updateIeDatesPreview(){
    var text = formatDateRange(selDateFrom, selDateTo, ieEl('ie_dateNote').value.trim());
    ieEl('ieDatesPreview').textContent = text ? ('כך זה יוצג באתר: ' + text) : '';
  }
  ieEl('ieDateRangeBtn').addEventListener('click', function(e){
    e.stopPropagation();
    var pop = ieEl('ieCalPopover');
    if (pop.hidden) {
      var base = selDateFrom ? parseIsoDate(selDateFrom) : calToday;
      calViewYear = base.getFullYear(); calViewMonth = base.getMonth();
      renderIeCalendar();
      pop.hidden = false;
    } else pop.hidden = true;
  });
  ieEl('ieCalPrev').addEventListener('click', function(){ calViewMonth--; if (calViewMonth < 0) { calViewMonth = 11; calViewYear--; } renderIeCalendar(); });
  ieEl('ieCalNext').addEventListener('click', function(){ calViewMonth++; if (calViewMonth > 11) { calViewMonth = 0; calViewYear++; } renderIeCalendar(); });
  ieEl('ieCalClear').addEventListener('click', function(){ selDateFrom = null; selDateTo = null; renderIeCalendar(); });
  ieEl('ieCalApply').addEventListener('click', function(){ ieEl('ieCalPopover').hidden = true; updateIeDateRangeLabel(); updateIeDatesPreview(); });
  ieEl('ie_dateNote').addEventListener('input', updateIeDatesPreview);

  // ---------- Price-tier list editor ----------
  function renderIeTiers(){
    var c = ieEl('ieTiersEditor');
    c.innerHTML = '';
    ieTiersList.forEach(function(val, idx){
      var row = document.createElement('div');
      row.className = 'ie-list-item';
      row.innerHTML = '<input type="text" value="' + escapeHTML(val) + '"><button type="button" class="ie-list-remove">✕</button>';
      row.querySelector('input').addEventListener('input', function(e){ ieTiersList[idx] = e.target.value; });
      row.querySelector('button').addEventListener('click', function(){ ieTiersList.splice(idx, 1); renderIeTiers(); });
      c.appendChild(row);
    });
  }
  ieEl('ieAddTierRow').addEventListener('click', function(){ ieTiersList.push(''); renderIeTiers(); });

  // ---------- Admin buttons injected onto rendered deal cards ----------
  function injectAdminButtons(){
    document.querySelectorAll('.card, .featured').forEach(function(cardEl){
      var detailsBtn = cardEl.querySelector('[data-deal]');
      if (!detailsBtn) return;
      var dealId = detailsBtn.getAttribute('data-deal');
      var mediaEl = cardEl.classList.contains('featured') ? cardEl : cardEl.querySelector('.card-media');
      if (!mediaEl || mediaEl.querySelector('.pkg-admin-actions')) return;
      var actions = document.createElement('div');
      actions.className = 'pkg-admin-actions';
      actions.innerHTML =
        '<button type="button" class="pkg-edit-btn" data-edit-deal="' + escapeHTML(dealId) + '" aria-label="עריכה">' + pencilSvg() + '</button>' +
        '<button type="button" class="pkg-del-btn" data-del-deal="' + escapeHTML(dealId) + '" aria-label="מחיקה">' + trashSvg() + '</button>';
      mediaEl.appendChild(actions);
    });
  }

  // ---------- Deal editor open/save/delete ----------
  function openDealEditor(dealId){
    editingDealId = dealId;
    pendingImageFile = null;
    ieShowStatus('ieDealStatus', '', '');
    var d = dealId ? dealsCache.data.find(function(x){ return x.id === dealId; }) : {
      id: null, active: true,
      order: (dealsCache.data.reduce(function(m, x){ return Math.max(m, x.order || 0); }, 0) + 1),
      tag: '', title: '', image: '', imageAlt: '', meta: '', cardDesc: '', price: '', priceNote: '',
      dates: '', dateFrom: '', dateTo: '', dateNote: '', desc: '', note: '', priceTiers: []
    };
    ieEl('ieDealTitle').textContent = dealId ? 'עריכת חבילה' : 'הוספת חבילה חדשה';
    ieEl('ie_title').value = d.title || '';
    ieEl('ie_tag').value = d.tag || '';
    ieEl('ie_meta').value = d.meta || '';
    selDateFrom = d.dateFrom || null;
    selDateTo = d.dateTo || null;
    updateIeDateRangeLabel();
    ieEl('ie_dateNote').value = d.dateNote || (!d.dateFrom && d.dates ? d.dates : '');
    updateIeDatesPreview();
    ieEl('ie_price').value = d.price || '';
    document.querySelectorAll('input[name="iePriceNote"]').forEach(function(r){ r.checked = (r.value === d.priceNote); });
    ieEl('ie_cardDesc').value = d.cardDesc || '';
    ieEl('ie_desc').value = d.desc || '';
    ieEl('ie_note').value = d.note || '';
    ieEl('ie_order').value = d.order || 1;
    ieEl('ie_active').checked = d.active !== false;
    ieEl('ie_imageFile').value = '';
    if (d.image) { ieEl('ie_imagePreview').src = d.image; ieEl('ie_imagePreview').hidden = false; }
    else ieEl('ie_imagePreview').hidden = true;
    ieTiersList = (d.priceTiers || []).slice();
    renderIeTiers();
    ieEl('ieDealDeleteBtn').style.display = dealId ? '' : 'none';
    ieEl('ieDealOverlay').hidden = false;
  }
  ieEl('ieAddDealBtn').addEventListener('click', function(){ openDealEditor(null); });
  document.addEventListener('click', function(e){
    var editBtn = e.target.closest && e.target.closest('[data-edit-deal]');
    if (editBtn) { e.preventDefault(); e.stopPropagation(); openDealEditor(editBtn.getAttribute('data-edit-deal')); }
  });
  ieEl('ieDealCancelBtn').addEventListener('click', function(){ ieEl('ieDealOverlay').hidden = true; });
  ieEl('ie_imageFile').addEventListener('change', function(e){
    var file = e.target.files[0];
    pendingImageFile = file || null;
    if (file) {
      var reader = new FileReader();
      reader.onload = function(){ ieEl('ie_imagePreview').src = reader.result; ieEl('ie_imagePreview').hidden = false; };
      reader.readAsDataURL(file);
    }
  });

  function saveDealsToRepo(list, message){
    var body = b64EncodeUnicode(JSON.stringify(list, null, 2));
    return ghPutFile(DEALS_PATH, body, message, dealsCache.sha).then(function(res){
      dealsCache.data = list;
      dealsCache.sha = res.content.sha;
    });
  }

  ieEl('ieDealSaveBtn').addEventListener('click', function(){
    var title = ieEl('ie_title').value.trim();
    var tag = ieEl('ie_tag').value.trim();
    var meta = ieEl('ie_meta').value.trim();
    var dateFrom = selDateFrom, dateTo = selDateTo;
    var price = ieEl('ie_price').value.trim();
    var priceNoteEl = document.querySelector('input[name="iePriceNote"]:checked');
    var priceNote = priceNoteEl ? priceNoteEl.value : '';
    var cardDesc = ieEl('ie_cardDesc').value.trim();
    var existing = editingDealId ? dealsCache.data.find(function(x){ return x.id === editingDealId; }) : null;
    var hasImage = !!(pendingImageFile || (existing && existing.image));

    var missing = [];
    if (!title) missing.push('כותרת');
    if (!tag) missing.push('תגית');
    if (!meta) missing.push('משך');
    if (!dateFrom || !dateTo) missing.push('תאריכים');
    if (!price) missing.push('מחיר');
    if (!priceNote) missing.push('הערת מחיר');
    if (!cardDesc) missing.push('תיאור קצר');
    if (!hasImage) missing.push('תמונה');
    if (missing.length) { ieShowStatus('ieDealStatus', 'error', 'חסרים שדות חובה: ' + missing.join(', ')); return; }

    var d = existing || { id: genDealId() };
    d.title = title; d.tag = tag; d.meta = meta;
    d.dateFrom = dateFrom; d.dateTo = dateTo;
    d.dateNote = ieEl('ie_dateNote').value.trim();
    d.dates = formatDateRange(dateFrom, dateTo, d.dateNote);
    d.price = price; d.priceNote = priceNote; d.cardDesc = cardDesc;
    d.desc = ieEl('ie_desc').value.trim();
    d.note = ieEl('ie_note').value.trim();
    d.order = parseInt(ieEl('ie_order').value, 10) || 1;
    d.active = ieEl('ie_active').checked;
    d.imageAlt = title;
    d.priceTiers = ieTiersList.filter(Boolean);

    var saveBtn = ieEl('ieDealSaveBtn');
    saveBtn.disabled = true;
    ieShowStatus('ieDealStatus', 'info', 'שומר…');

    var imageStep = pendingImageFile ? uploadImage(pendingImageFile).then(function(path){ d.image = path; }) : Promise.resolve();

    imageStep.then(function(){
      var list = dealsCache.data.slice();
      if (existing) { var idx = list.findIndex(function(x){ return x.id === existing.id; }); list[idx] = d; }
      else list.push(d);
      return saveDealsToRepo(list, (existing ? 'עדכון חבילה: ' : 'חבילה חדשה: ') + d.title);
    }).then(function(){
      ieShowStatus('ieDealStatus', 'ok', 'נשמר!');
      refreshDealsView();
      setTimeout(function(){ ieEl('ieDealOverlay').hidden = true; }, 700);
    }).catch(function(err){
      ieShowStatus('ieDealStatus', 'error', 'שמירה נכשלה: ' + err.message);
    }).finally(function(){ saveBtn.disabled = false; });
  });

  ieEl('ieDealDeleteBtn').addEventListener('click', function(){
    if (!editingDealId) return;
    if (!confirm('למחוק את החבילה הזו לצמיתות? גם התמונה שלה תימחק מהריפו.')) return;
    var existing = dealsCache.data.find(function(x){ return x.id === editingDealId; });
    var list = dealsCache.data.filter(function(x){ return x.id !== editingDealId; });
    ieShowStatus('ieDealStatus', 'info', 'מוחק…');
    saveDealsToRepo(list, 'מחיקת חבילה: ' + (existing.title || '')).then(function(){
      if (existing.image && existing.image.indexOf('uploads/') === 0) {
        return ghDeleteFile(existing.image, 'מחיקת תמונה: ' + (existing.title || '')).catch(function(){});
      }
    }).then(function(){
      refreshDealsView();
      ieEl('ieDealOverlay').hidden = true;
    }).catch(function(err){
      ieShowStatus('ieDealStatus', 'error', 'מחיקה נכשלה: ' + err.message);
    });
  });

  document.addEventListener('click', function(e){
    var delBtn = e.target.closest && e.target.closest('[data-del-deal]');
    if (!delBtn) return;
    e.preventDefault(); e.stopPropagation();
    var id = delBtn.getAttribute('data-del-deal');
    var existing = dealsCache.data.find(function(x){ return x.id === id; });
    if (!existing) return;
    if (!confirm('למחוק את "' + existing.title + '" לצמיתות?')) return;
    var list = dealsCache.data.filter(function(x){ return x.id !== id; });
    saveDealsToRepo(list, 'מחיקת חבילה: ' + existing.title).then(function(){
      if (existing.image && existing.image.indexOf('uploads/') === 0) {
        return ghDeleteFile(existing.image, 'מחיקת תמונה: ' + existing.title).catch(function(){});
      }
    }).then(function(){ refreshDealsView(); });
  });

  // Re-inject admin buttons whenever a filter button changes the rendered cards
  document.addEventListener('click', function(e){
    var filterBtn = e.target.closest && e.target.closest('[data-filter]');
    if (filterBtn && editModeActive) setTimeout(injectAdminButtons, 0);
  });
})();
