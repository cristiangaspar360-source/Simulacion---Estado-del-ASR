'use strict';
/* ═══════════════════════════════════════════════════════
   CloudDB App Controller — views, formulas, integrations
   ═══════════════════════════════════════════════════════ */

/* ── Formula Engine ── */
class FormulaEngine {
  evaluate(formula, row, columns) {
    if (!formula || !formula.startsWith('=')) return formula;
    try {
      const expr = formula.slice(1);
      const colByName = {};
      columns.forEach(c => { colByName[c.name.replace(/\s+/g,'_')] = row[c.id]; });
      const ctx = { ...colByName };
      return this._eval(expr, ctx, row, columns);
    } catch(e) { return '#ERROR'; }
  }

  _eval(expr, ctx, row, cols) {
    // Replace field names with values
    let e = expr.trim();
    // Function calls
    e = e.replace(/SUM\(([^)]+)\)/gi, (_,a)=>this._sum(a,ctx,row,cols));
    e = e.replace(/AVG\(([^)]+)\)/gi, (_,a)=>this._avg(a,ctx,row,cols));
    e = e.replace(/MAX\(([^)]+)\)/gi, (_,a)=>this._max(a,ctx,row,cols));
    e = e.replace(/MIN\(([^)]+)\)/gi, (_,a)=>this._min(a,ctx,row,cols));
    e = e.replace(/COUNT\(([^)]+)\)/gi, (_,a)=>this._count(a,ctx,row,cols));
    e = e.replace(/IF\(([^,]+),([^,]+),([^)]+)\)/gi, (_,cond,t,f)=>{
      const cv = this._evalSimple(cond.trim(), ctx);
      return cv ? this._evalSimple(t.trim(),ctx) : this._evalSimple(f.trim(),ctx);
    });
    e = e.replace(/CONCAT\(([^)]+)\)/gi, (_,a)=>a.split(',').map(s=>String(this._evalSimple(s.trim(),ctx))).join(''));
    e = e.replace(/LEN\(([^)]+)\)/gi, (_,a)=>String(this._evalSimple(a.trim(),ctx)).length);
    e = e.replace(/UPPER\(([^)]+)\)/gi, (_,a)=>String(this._evalSimple(a.trim(),ctx)).toUpperCase());
    e = e.replace(/LOWER\(([^)]+)\)/gi, (_,a)=>String(this._evalSimple(a.trim(),ctx)).toLowerCase());
    e = e.replace(/ROUND\(([^,]+),([^)]+)\)/gi, (_,a,b)=>Number(this._evalSimple(a.trim(),ctx)).toFixed(Number(b)));
    e = e.replace(/ABS\(([^)]+)\)/gi, (_,a)=>Math.abs(Number(this._evalSimple(a.trim(),ctx))));
    e = e.replace(/NOW\(\)/gi, ()=>new Date().toISOString());
    e = e.replace(/TODAY\(\)/gi, ()=>new Date().toISOString().split('T')[0]);
    return this._evalSimple(e, ctx);
  }

  _getArgs(str, ctx, row, cols) {
    return str.split(',').map(s => {
      const v = this._evalSimple(s.trim(), ctx);
      return typeof v === 'string' ? parseFloat(v)||0 : Number(v)||0;
    });
  }
  _sum(a,ctx,row,cols) { return this._getArgs(a,ctx,row,cols).reduce((s,v)=>s+v,0); }
  _avg(a,ctx,row,cols) { const vs=this._getArgs(a,ctx,row,cols); return vs.length ? vs.reduce((s,v)=>s+v,0)/vs.length : 0; }
  _max(a,ctx,row,cols) { return Math.max(...this._getArgs(a,ctx,row,cols)); }
  _min(a,ctx,row,cols) { return Math.min(...this._getArgs(a,ctx,row,cols)); }
  _count(a,ctx,row,cols){ return this._getArgs(a,ctx,row,cols).filter(v=>v!=null&&v!=='').length; }

  _evalSimple(e, ctx) {
    e = e.trim();
    // Replace field refs
    const replaced = e.replace(/\b([A-Za-z][A-Za-z0-9_\s]*)\b/g, (m) => {
      const key = m.replace(/\s+/g,'_');
      if (ctx[key] !== undefined) return JSON.stringify(ctx[key]);
      return m;
    });
    try { return Function('"use strict"; return (' + replaced + ')')(); }
    catch { return e; }
  }
}

/* ── Column Type Renderers ── */
const Renderers = {
  text:        (v) => `<span class="cell-text">${esc(v)}</span>`,
  number:      (v) => `<span class="cell-num">${v != null ? Number(v).toLocaleString() : ''}</span>`,
  currency:    (v,col) => `<span class="cell-num">${v != null ? fmtCurrency(v, col?.options?.currency) : ''}</span>`,
  percent:     (v) => v != null ? `<div class="cell-pct"><div class="pct-bar" style="width:${Math.min(100,v)}%"></div><span>${v}%</span></div>` : '',
  boolean:     (v) => `<span class="cell-bool ${v?'bool-true':'bool-false'}">${v?'✓':'○'}</span>`,
  date:        (v) => v ? `<span class="cell-date">${fmtDate(v)}</span>` : '',
  datetime:    (v) => v ? `<span class="cell-date">${fmtDate(v,true)}</span>` : '',
  email:       (v) => v ? `<a href="mailto:${esc(v)}" class="cell-link" onclick="event.stopPropagation()">${esc(v)}</a>` : '',
  url:         (v) => v ? `<a href="${esc(v)}" target="_blank" class="cell-link" onclick="event.stopPropagation()">${esc(v)}</a>` : '',
  phone:       (v) => v ? `<a href="tel:${esc(v)}" class="cell-link" onclick="event.stopPropagation()">${esc(v)}</a>` : '',
  rating:      (v) => `<span class="cell-rating">${'★'.repeat(Math.min(5,v||0))}${'☆'.repeat(5-Math.min(5,v||0))}</span>`,
  select:      (v,col) => v ? `<span class="cell-tag" style="background:${tagColor(v,col)}">${esc(v)}</span>` : '',
  multiselect: (v,col) => (Array.isArray(v)?v:String(v||'').split(',')).filter(Boolean).map(t=>`<span class="cell-tag" style="background:${tagColor(t,col)}">${esc(t.trim())}</span>`).join(' '),
  formula:     (v) => `<span class="cell-formula">${esc(v)}</span>`,
  autonumber:  (v) => `<span class="cell-rn">${v}</span>`,
  created_at:  (v) => v ? `<span class="cell-date sys">${fmtDate(v,true)}</span>` : '',
  updated_at:  (v) => v ? `<span class="cell-date sys">${fmtDate(v,true)}</span>` : '',
  json:        (v) => `<span class="cell-json">${esc(typeof v==='object'?JSON.stringify(v):v)}</span>`,
};

/* ── Cell Editors ── */
const Editors = {
  text:     (v,col) => `<input type="text" value="${esc(v)}" class="cell-editor" />`,
  number:   (v,col) => `<input type="number" value="${v??''}" class="cell-editor" />`,
  currency: (v,col) => `<input type="number" step="0.01" value="${v??''}" class="cell-editor" />`,
  percent:  (v,col) => `<input type="number" min="0" max="100" value="${v??''}" class="cell-editor" />`,
  date:     (v,col) => `<input type="date" value="${v?.split('T')[0]??''}" class="cell-editor" />`,
  datetime: (v,col) => `<input type="datetime-local" value="${v?.slice(0,16)??''}" class="cell-editor" />`,
  email:    (v,col) => `<input type="email" value="${esc(v)}" class="cell-editor" />`,
  url:      (v,col) => `<input type="url" value="${esc(v)}" class="cell-editor" />`,
  phone:    (v,col) => `<input type="tel" value="${esc(v)}" class="cell-editor" />`,
  rating:   (v,col) => `<input type="number" min="1" max="5" value="${v??''}" class="cell-editor" />`,
  boolean:  (v,col) => `<input type="checkbox" ${v?'checked':''} class="cell-editor-check" />`,
  select:   (v,col) => {
    const opts = (col.options?.choices||[]).map(c=>`<option ${c===v?'selected':''}>${esc(c)}</option>`).join('');
    return `<select class="cell-editor"><option value=""></option>${opts}</select>`;
  },
  multiselect: (v,col) => {
    const selected = Array.isArray(v)?v:String(v||'').split(',').filter(Boolean);
    const opts = (col.options?.choices||[]).map(c=>`<option ${selected.includes(c)?'selected':''}>${esc(c)}</option>`).join('');
    return `<select class="cell-editor" multiple>${opts}</select>`;
  },
  text_area:(v,col) => `<textarea class="cell-editor">${esc(v)}</textarea>`,
};

/* ── Main App ── */
class CloudApp {
  constructor() {
    this.db = new DatabaseEngine();
    this.formula = new FormulaEngine();
    this.state = {
      tableId: null, viewId: null, view: null,
      rows: [], total: 0,
      filters: { operator:'AND', conditions:[] },
      sorts: [], search: '',
      page: 0, pageSize: 100,
      selected: new Set(),
      editCell: null,
      hiddenCols: new Set(),
    };
    this.COLORS = ['#3B82F6','#10B981','#F59E0B','#EF4444','#8B5CF6','#EC4899','#06B6D4','#F97316'];
  }

  async init() {
    await this.db.init();
    await this.db.seedDemo();
    this._buildShell();
    await this._loadSidebar();
    const tables = await this.db.getTables();
    if (tables.length) await this.selectTable(tables[0].id);
    this._bindGlobal();
    document.getElementById('app-loading').style.display = 'none';
    document.getElementById('app-shell').style.display = 'flex';
  }

  /* ── Shell ── */
  _buildShell() {
    document.getElementById('app-shell').innerHTML = `
      <aside id="sidebar">
        <div class="sidebar-header">
          <div class="sidebar-logo">
            <span class="logo-icon">⚡</span>
            <div><div class="logo-title">CloudDB</div><div class="logo-sub">Pro Platform</div></div>
          </div>
          <button class="btn-icon" id="btn-new-table" title="New Table">＋</button>
        </div>
        <div class="sidebar-search">
          <input id="sidebar-search" placeholder="Search tables…" />
        </div>
        <div id="table-list" class="table-list"></div>
        <div class="sidebar-footer">
          <button class="sidebar-nav-btn" id="btn-integrations">🔌 Integrations</button>
          <button class="sidebar-nav-btn" id="btn-automations">⚙️ Automations</button>
          <button class="sidebar-nav-btn" id="btn-api">📡 API Explorer</button>
          <button class="sidebar-nav-btn" id="btn-audit">📋 Audit Log</button>
        </div>
      </aside>
      <div id="main-area">
        <div id="table-header">
          <div id="table-title-area">
            <span id="table-icon">📋</span>
            <h1 id="table-title">Select a table</h1>
            <span id="table-row-count" class="row-count-badge"></span>
          </div>
          <div id="view-tabs"></div>
          <button class="btn-primary" id="btn-add-view">＋ View</button>
        </div>
        <div id="toolbar">
          <div class="toolbar-left">
            <button class="toolbar-btn" id="btn-add-row">＋ New record</button>
            <div class="toolbar-sep"></div>
            <button class="toolbar-btn" id="btn-filter">⚗ Filter</button>
            <button class="toolbar-btn" id="btn-sort">↕ Sort</button>
            <button class="toolbar-btn" id="btn-group">⊞ Group</button>
            <button class="toolbar-btn" id="btn-fields">⊟ Fields</button>
          </div>
          <div class="toolbar-center">
            <div class="search-wrap">
              <span class="search-icon">🔍</span>
              <input id="global-search" placeholder="Search records…" />
            </div>
          </div>
          <div class="toolbar-right">
            <button class="toolbar-btn" id="btn-import">⬆ Import</button>
            <button class="toolbar-btn" id="btn-export">⬇ Export</button>
            <button class="toolbar-btn" id="btn-share">↗ Share</button>
          </div>
        </div>
        <div id="active-filters"></div>
        <div id="view-container"></div>
        <div id="status-bar">
          <span id="status-total"></span>
          <span id="status-selected"></span>
          <div class="page-controls">
            <button class="btn-page" id="btn-prev-page">‹</button>
            <span id="page-info"></span>
            <button class="btn-page" id="btn-next-page">›</button>
          </div>
        </div>
      </div>
      <div id="record-panel" class="hidden"></div>
      <div id="modal-overlay" class="hidden"></div>
      <div id="toast-container"></div>
    `;

    // Bind sidebar buttons
    document.getElementById('btn-new-table').onclick = () => this.showNewTableModal();
    document.getElementById('btn-integrations').onclick = () => this.showIntegrationHub();
    document.getElementById('btn-automations').onclick = () => this.showAutomations();
    document.getElementById('btn-api').onclick = () => this.showApiExplorer();
    document.getElementById('btn-audit').onclick = () => this.showAuditLog(this.state.tableId);
    document.getElementById('btn-add-row').onclick = () => this.addRow();
    document.getElementById('btn-filter').onclick = () => this.showFilterPanel();
    document.getElementById('btn-sort').onclick = () => this.showSortPanel();
    document.getElementById('btn-fields').onclick = () => this.showFieldsPanel();
    document.getElementById('btn-import').onclick = () => this.showImportModal();
    document.getElementById('btn-export').onclick = () => this.showExportModal();
    document.getElementById('btn-add-view').onclick = () => this.showAddViewModal();
    document.getElementById('btn-share').onclick = () => this.showShareModal();
    document.getElementById('global-search').oninput = e => { this.state.search = e.target.value; this.loadData(); };
    document.getElementById('sidebar-search').oninput = e => this._filterSidebar(e.target.value);
    document.getElementById('btn-prev-page').onclick = () => this.changePage(-1);
    document.getElementById('btn-next-page').onclick = () => this.changePage(1);
  }

  _bindGlobal() {
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { this.closeModal(); this.closeRecordPanel(); }
      if ((e.ctrlKey||e.metaKey) && e.key==='z') this.toast('Undo not yet available','info');
      if ((e.ctrlKey||e.metaKey) && e.key==='f') { e.preventDefault(); document.getElementById('global-search').focus(); }
    });
  }

  /* ── Sidebar ── */
  async _loadSidebar() {
    const tables = await this.db.getTables();
    const list = document.getElementById('table-list');
    list.innerHTML = tables.map(t => `
      <div class="table-item ${t.id===this.state.tableId?'active':''}" data-id="${t.id}">
        <span class="table-dot" style="background:${t.color}"></span>
        <span class="table-name">${esc(t.name)}</span>
        <span class="table-count">${t.rowCount||0}</span>
        <div class="table-actions">
          <button class="tbl-action-btn" data-action="rename" data-id="${t.id}">✏</button>
          <button class="tbl-action-btn" data-action="delete" data-id="${t.id}">🗑</button>
        </div>
      </div>
    `).join('');

    list.querySelectorAll('.table-item').forEach(el => {
      el.onclick = (e) => { if (!e.target.closest('.tbl-action-btn')) this.selectTable(el.dataset.id); };
    });
    list.querySelectorAll('.tbl-action-btn').forEach(btn => {
      btn.onclick = e => { e.stopPropagation(); this._tableAction(btn.dataset.action, btn.dataset.id); };
    });
  }

  _filterSidebar(q) {
    document.querySelectorAll('.table-item').forEach(el => {
      el.style.display = el.querySelector('.table-name').textContent.toLowerCase().includes(q.toLowerCase()) ? '' : 'none';
    });
  }

  async _tableAction(action, tableId) {
    if (action === 'rename') {
      const t = await this.db.getTable(tableId);
      const name = prompt('Rename table:', t.name);
      if (name && name.trim()) { await this.db.renameTable(tableId, name.trim()); await this._loadSidebar(); }
    } else if (action === 'delete') {
      if (!confirm('Delete this table and all its data?')) return;
      await this.db.deleteTable(tableId);
      if (this.state.tableId === tableId) {
        this.state.tableId = null;
        document.getElementById('view-container').innerHTML = '<div class="empty-state">Select a table from the sidebar</div>';
      }
      await this._loadSidebar();
    }
  }

  /* ── Table Selection ── */
  async selectTable(tableId) {
    this.state.tableId = tableId;
    this.state.page = 0;
    this.state.selected = new Set();
    this.state.filters = { operator:'AND', conditions:[] };
    this.state.sorts = [];
    this.state.search = '';
    document.getElementById('global-search').value = '';

    const schema = await this.db.getTable(tableId);
    document.getElementById('table-icon').textContent = schema.icon || '📋';
    document.getElementById('table-title').textContent = schema.name;

    const views = await this.db.getViews(tableId);
    this._renderViewTabs(views);
    if (views.length) await this.selectView(views[0]);
    await this._loadSidebar();
  }

  _renderViewTabs(views) {
    const tabs = document.getElementById('view-tabs');
    tabs.innerHTML = views.map(v => `
      <button class="view-tab ${v.id===this.state.viewId?'active':''}" data-vid="${v.id}" data-type="${v.type}">
        ${viewIcon(v.type)} ${esc(v.name)}
      </button>
    `).join('');
    tabs.querySelectorAll('.view-tab').forEach(btn => {
      btn.onclick = async () => {
        const views2 = await this.db.getViews(this.state.tableId);
        const view = views2.find(v => v.id === btn.dataset.vid);
        if (view) this.selectView(view);
      };
    });
  }

  async selectView(view) {
    this.state.viewId = view.id;
    this.state.view = view;
    document.querySelectorAll('.view-tab').forEach(t => t.classList.toggle('active', t.dataset.vid===view.id));
    await this.loadData();
  }

  /* ── Data Loading ── */
  async loadData() {
    if (!this.state.tableId) return;
    const { rows, total } = await this.db.query(this.state.tableId, {
      filter: this.state.filters.conditions.length ? this.state.filters : null,
      sort: this.state.sorts,
      search: this.state.search,
      limit: this.state.pageSize,
      offset: this.state.page * this.state.pageSize
    });

    const schema = await this.db.getTable(this.state.tableId);
    this.state.rows = this._applyFormulas(rows, schema);
    this.state.total = total;

    document.getElementById('table-row-count').textContent = `${total} records`;
    this._updateStatus();
    this._renderActiveFilters();

    const type = this.state.view?.type || 'grid';
    switch(type) {
      case 'grid':     await this.renderGrid(schema); break;
      case 'kanban':   await this.renderKanban(schema); break;
      case 'gallery':  await this.renderGallery(schema); break;
      case 'chart':    await this.renderChart(schema); break;
      case 'calendar': await this.renderCalendar(schema); break;
      case 'form':     await this.renderForm(schema); break;
      default:         await this.renderGrid(schema);
    }
  }

  _applyFormulas(rows, schema) {
    const formulaCols = schema.columns.filter(c => c.type === COL_TYPES.FORMULA);
    if (!formulaCols.length) return rows;
    return rows.map(row => {
      const r = { ...row };
      formulaCols.forEach(col => {
        r[col.id] = this.formula.evaluate(col.options?.formula, r, schema.columns);
      });
      return r;
    });
  }

  _updateStatus() {
    document.getElementById('status-total').textContent = `${this.state.total} records`;
    document.getElementById('status-selected').textContent = this.state.selected.size ? `${this.state.selected.size} selected` : '';
    const pages = Math.ceil(this.state.total / this.state.pageSize);
    document.getElementById('page-info').textContent = pages > 1 ? `Page ${this.state.page+1} / ${pages}` : '';
    document.getElementById('btn-prev-page').disabled = this.state.page === 0;
    document.getElementById('btn-next-page').disabled = (this.state.page+1) * this.state.pageSize >= this.state.total;
  }

  changePage(delta) {
    const pages = Math.ceil(this.state.total / this.state.pageSize);
    this.state.page = Math.max(0, Math.min(pages-1, this.state.page + delta));
    this.loadData();
  }

  /* ══════════════════════════════
     GRID VIEW
  ══════════════════════════════ */
  async renderGrid(schema) {
    const { rows } = this.state;
    const cols = schema.columns.filter(c => !this.state.hiddenCols.has(c.id));
    const vc = document.getElementById('view-container');

    let html = `<div class="grid-wrap"><table class="db-grid"><thead><tr>
      <th class="th-check"><input type="checkbox" id="check-all" /></th>
      ${cols.map(col => `
        <th class="th-col" data-colid="${col.id}" style="min-width:${col.width||120}px">
          <div class="th-inner">
            <span class="col-type-icon">${colTypeIcon(col.type)}</span>
            <span class="col-name">${esc(col.name)}</span>
            <div class="th-menu-wrap">
              <button class="th-menu-btn" data-colid="${col.id}">⋮</button>
            </div>
          </div>
        </th>`).join('')}
      <th class="th-add"><button id="btn-add-col">＋</button></th>
    </tr></thead><tbody>`;

    rows.forEach(row => {
      html += `<tr class="db-row ${this.state.selected.has(row._id)?'selected':''}" data-rowid="${row._id}">
        <td class="td-check"><input type="checkbox" class="row-check" data-id="${row._id}" ${this.state.selected.has(row._id)?'checked':''}/></td>
        ${cols.map(col => {
          const val = this._getCellValue(row, col, schema);
          const renderer = Renderers[col.type] || Renderers.text;
          return `<td class="db-cell" data-colid="${col.id}" data-rowid="${row._id}"
            data-type="${col.type}" title="${esc(String(val??''))}">
            ${renderer(val, col)}
          </td>`;
        }).join('')}
        <td></td>
      </tr>`;
    });

    html += `</tbody></table></div>`;

    // Summary row
    const stats = await this.db.getStats(this.state.tableId);
    html += `<div class="grid-summary">${cols.map(col => {
      const s = stats[col.id];
      if (!s) return `<div class="summary-cell" style="min-width:${col.width||120}px"></div>`;
      return `<div class="summary-cell" style="min-width:${col.width||120}px" title="Sum: ${fmtNum(s.sum)} | Avg: ${fmtNum(s.avg)} | Min: ${fmtNum(s.min)} | Max: ${fmtNum(s.max)}">
        Σ ${fmtNum(s.sum)}
      </div>`;
    }).join('')}</div>`;

    vc.innerHTML = html;
    this._bindGrid(schema);
  }

  _getCellValue(row, col, schema) {
    if (col.type === COL_TYPES.CREATED_AT) return row._created;
    if (col.type === COL_TYPES.UPDATED_AT) return row._updated;
    if (col.type === COL_TYPES.AUTONUMBER) return row._rownum;
    return row[col.id];
  }

  _bindGrid(schema) {
    // Check all
    const checkAll = document.getElementById('check-all');
    if (checkAll) checkAll.onclick = e => {
      this.state.rows.forEach(r => e.target.checked ? this.state.selected.add(r._id) : this.state.selected.delete(r._id));
      document.querySelectorAll('.row-check').forEach(c => c.checked = e.target.checked);
      this._updateStatus();
    };

    // Row checks
    document.querySelectorAll('.row-check').forEach(cb => {
      cb.onchange = e => {
        const id = Number(cb.dataset.id);
        e.target.checked ? this.state.selected.add(id) : this.state.selected.delete(id);
        cb.closest('tr').classList.toggle('selected', e.target.checked);
        this._updateStatus();
      };
    });

    // Cell click → inline edit or row expand
    document.querySelectorAll('.db-cell').forEach(td => {
      td.ondblclick = () => this.startEdit(td, schema);
      td.onclick = (e) => {
        if (e.detail === 1) {
          // Single click on row number → expand record
          if (td.dataset.colid === 'col_rn') this.openRecordPanel(Number(td.dataset.rowid), schema);
        }
      };
    });

    // Row right-click context menu
    document.querySelectorAll('.db-row').forEach(tr => {
      tr.oncontextmenu = e => { e.preventDefault(); this.showRowContextMenu(e, Number(tr.dataset.rowid), schema); };
    });

    // Add column
    document.getElementById('btn-add-col').onclick = () => this.showAddColumnModal(schema);

    // Column header menu
    document.querySelectorAll('.th-menu-btn').forEach(btn => {
      btn.onclick = e => { e.stopPropagation(); this.showColMenu(e, btn.dataset.colid, schema); };
    });
  }

  /* ── Inline Edit ── */
  startEdit(td, schema) {
    if (td.dataset.type === 'autonumber' || td.dataset.type === 'created_at' || td.dataset.type === 'updated_at') return;
    const rowId = Number(td.dataset.rowid);
    const colId = td.dataset.colid;
    const col = schema.columns.find(c => c.id === colId);
    const row = this.state.rows.find(r => r._id === rowId);
    const val = row?.[colId];

    const editorFn = Editors[col.type] || Editors.text;
    td.innerHTML = editorFn(val, col);
    const inp = td.querySelector('input,select,textarea');
    if (!inp) return;
    inp.focus();

    const save = async () => {
      let newVal;
      if (inp.type === 'checkbox') newVal = inp.checked;
      else if (inp.multiple) newVal = [...inp.selectedOptions].map(o => o.value).join(',');
      else newVal = inp.value;
      await this.db.updateRow(this.state.tableId, rowId, { [colId]: newVal });
      await this.loadData();
    };

    inp.onblur = save;
    inp.onkeydown = e => { if (e.key === 'Enter' && !inp.multiple) save(); if (e.key === 'Escape') this.loadData(); };
  }

  /* ── Row Context Menu ── */
  showRowContextMenu(e, rowId, schema) {
    this.closeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.cssText = `left:${e.clientX}px;top:${e.clientY}px`;
    menu.innerHTML = `
      <div class="ctx-item" data-action="expand">↗ Expand record</div>
      <div class="ctx-item" data-action="copy">⊡ Copy row</div>
      <div class="ctx-sep"></div>
      <div class="ctx-item ctx-danger" data-action="delete">🗑 Delete row</div>
    `;
    menu.querySelectorAll('.ctx-item').forEach(item => {
      item.onclick = () => {
        const action = item.dataset.action;
        this.closeContextMenu();
        if (action === 'expand') this.openRecordPanel(rowId, schema);
        if (action === 'delete') this.deleteRow(rowId);
        if (action === 'copy') this.copyRow(rowId);
      };
    });
    document.body.appendChild(menu);
    document.addEventListener('click', () => this.closeContextMenu(), { once:true });
  }

  closeContextMenu() {
    document.querySelectorAll('.context-menu').forEach(m => m.remove());
  }

  async addRow() {
    if (!this.state.tableId) return;
    await this.db.insertRow(this.state.tableId, {});
    this.state.page = Math.floor(this.state.total / this.state.pageSize);
    await this.loadData();
    this.toast('Record added');
  }

  async deleteRow(rowId) {
    if (!confirm('Delete this record?')) return;
    await this.db.deleteRow(this.state.tableId, rowId);
    await this.loadData();
    this.toast('Record deleted');
  }

  async copyRow(rowId) {
    const row = await this.db.getRow(this.state.tableId, rowId);
    if (!row) return;
    const copy = { ...row };
    delete copy._id; delete copy._rownum; delete copy._created; delete copy._updated;
    await this.db.insertRow(this.state.tableId, copy);
    await this.loadData();
    this.toast('Record duplicated');
  }

  /* ══════════════════════════════
     RECORD PANEL
  ══════════════════════════════ */
  async openRecordPanel(rowId, schema) {
    const row = this.state.rows.find(r => r._id === rowId);
    if (!row) return;
    const panel = document.getElementById('record-panel');
    panel.classList.remove('hidden');

    const editCols = schema.columns.filter(c => !c.system || c.type === COL_TYPES.AUTONUMBER);
    panel.innerHTML = `
      <div class="rp-header">
        <h2>Record #${row._rownum || rowId}</h2>
        <button class="btn-icon" id="rp-close">✕</button>
      </div>
      <div class="rp-body">
        ${editCols.map(col => `
          <div class="rp-field">
            <label class="rp-label">${colTypeIcon(col.type)} ${esc(col.name)}</label>
            <div class="rp-input">${this._rpEditor(col, row)}</div>
          </div>
        `).join('')}
      </div>
      <div class="rp-footer">
        <button class="btn-primary" id="rp-save">Save changes</button>
        <button class="btn-danger" id="rp-delete">Delete record</button>
      </div>
      <div class="rp-comments">
        <div class="rp-comments-title">💬 Comments</div>
        <div id="rp-comment-list"></div>
        <div class="rp-comment-input">
          <input id="rp-comment-text" placeholder="Add a comment…" />
          <button id="rp-comment-send" class="btn-sm">Send</button>
        </div>
      </div>
    `;

    document.getElementById('rp-close').onclick = () => this.closeRecordPanel();
    document.getElementById('rp-save').onclick = () => this.saveRecordPanel(rowId, schema, panel);
    document.getElementById('rp-delete').onclick = () => { this.closeRecordPanel(); this.deleteRow(rowId); };
    document.getElementById('rp-comment-send').onclick = () => this.sendComment(rowId);
    this.loadComments(rowId);
  }

  _rpEditor(col, row) {
    if (col.type === COL_TYPES.AUTONUMBER) return `<span>${row._rownum}</span>`;
    if (col.type === COL_TYPES.CREATED_AT) return `<span>${fmtDate(row._created, true)}</span>`;
    if (col.type === COL_TYPES.UPDATED_AT) return `<span>${fmtDate(row._updated, true)}</span>`;
    const val = row[col.id];
    if (col.type === 'boolean') return `<input type="checkbox" class="rp-check" data-colid="${col.id}" ${val?'checked':''}/>`;
    if (col.type === 'select') {
      const opts = (col.options?.choices||[]).map(c=>`<option ${c===val?'selected':''}>${esc(c)}</option>`).join('');
      return `<select class="rp-sel" data-colid="${col.id}"><option value=""></option>${opts}</select>`;
    }
    if (col.type === 'multiselect') {
      const selected = Array.isArray(val)?val:String(val||'').split(',').filter(Boolean);
      const opts = (col.options?.choices||[]).map(c=>`<option ${selected.includes(c)?'selected':''}>${esc(c)}</option>`).join('');
      return `<select class="rp-sel" multiple data-colid="${col.id}">${opts}</select>`;
    }
    if (col.type === 'text') return `<textarea class="rp-ta" data-colid="${col.id}">${esc(val)}</textarea>`;
    const t = { number:'number', currency:'number', percent:'number', rating:'number', date:'date', datetime:'datetime-local', email:'email', url:'url', phone:'tel' };
    return `<input type="${t[col.type]||'text'}" class="rp-inp" data-colid="${col.id}" value="${esc(val??'')}" />`;
  }

  async saveRecordPanel(rowId, schema, panel) {
    const data = {};
    panel.querySelectorAll('[data-colid]').forEach(el => {
      const colId = el.dataset.colid;
      if (el.type === 'checkbox') data[colId] = el.checked;
      else if (el.multiple) data[colId] = [...el.selectedOptions].map(o=>o.value).join(',');
      else data[colId] = el.value;
    });
    await this.db.updateRow(this.state.tableId, rowId, data);
    await this.loadData();
    this.closeRecordPanel();
    this.toast('Record saved');
  }

  closeRecordPanel() { document.getElementById('record-panel').classList.add('hidden'); }

  async loadComments(rowId) {
    const comments = await this.db.getComments(this.state.tableId, rowId);
    const list = document.getElementById('rp-comment-list');
    if (!list) return;
    list.innerHTML = comments.map(c => `<div class="comment"><span class="comment-ts">${fmtDate(c.ts,true)}</span><p>${esc(c.text)}</p></div>`).join('') || '<p class="no-comments">No comments yet</p>';
  }

  async sendComment(rowId) {
    const inp = document.getElementById('rp-comment-text');
    const text = inp.value.trim();
    if (!text) return;
    await this.db.addComment(this.state.tableId, rowId, text);
    inp.value = '';
    this.loadComments(rowId);
  }

  /* ══════════════════════════════
     KANBAN VIEW
  ══════════════════════════════ */
  async renderKanban(schema) {
    const { rows } = this.state;
    const viewCfg = this.state.view?.config || {};
    const groupColId = viewCfg.groupBy || schema.columns.find(c => c.type === 'select')?.id;
    const groupCol = schema.columns.find(c => c.id === groupColId);
    if (!groupCol) { document.getElementById('view-container').innerHTML = '<div class="empty-state">Add a Select column to use Kanban view</div>'; return; }

    const choices = groupCol.options?.choices || [...new Set(rows.map(r=>r[groupColId]).filter(Boolean))];
    const grouped = {};
    choices.forEach(c => grouped[c] = []);
    grouped['(empty)'] = [];
    rows.forEach(r => { const g = r[groupColId]||'(empty)'; if (!grouped[g]) grouped[g]=[]; grouped[g].push(r); });

    const titleCol = schema.columns.find(c => c.type === 'text' && !c.system);
    const vc = document.getElementById('view-container');
    vc.innerHTML = `<div class="kanban-board">
      ${[...choices,'(empty)'].map(grp => `
        <div class="kanban-col">
          <div class="kanban-col-header">
            <span class="kanban-tag" style="background:${tagColor(grp,groupCol)}">${esc(grp)}</span>
            <span class="kanban-count">${grouped[grp]?.length||0}</span>
            <button class="kanban-add" data-grp="${esc(grp)}" data-colid="${groupColId}">＋</button>
          </div>
          <div class="kanban-cards" data-grp="${esc(grp)}">
            ${(grouped[grp]||[]).map(row => `
              <div class="kanban-card" data-rowid="${row._id}">
                <div class="kanban-card-title">${esc(titleCol ? row[titleCol.id] : '#'+row._rownum)}</div>
                <div class="kanban-card-meta">
                  ${schema.columns.filter(c=>c.id!==groupColId&&c.id!==titleCol?.id&&!c.system).slice(0,2).map(c=>`
                    <span class="kanban-meta-item">${colTypeIcon(c.type)} ${esc(String(row[c.id]??'').slice(0,20))}</span>
                  `).join('')}
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      `).join('')}
    </div>`;

    vc.querySelectorAll('.kanban-card').forEach(card => {
      card.onclick = () => this.openRecordPanel(Number(card.dataset.rowid), schema);
    });
    vc.querySelectorAll('.kanban-add').forEach(btn => {
      btn.onclick = async () => {
        const row = await this.db.insertRow(this.state.tableId, { [btn.dataset.colid]: btn.dataset.grp==='(empty)'?'':btn.dataset.grp });
        await this.loadData();
        this.openRecordPanel(row._id, schema);
      };
    });
  }

  /* ══════════════════════════════
     GALLERY VIEW
  ══════════════════════════════ */
  async renderGallery(schema) {
    const { rows } = this.state;
    const titleCol = schema.columns.find(c => c.type === 'text' && !c.system);
    const visibleCols = schema.columns.filter(c => !c.system && c.id !== titleCol?.id).slice(0,3);
    const vc = document.getElementById('view-container');

    vc.innerHTML = `<div class="gallery-grid">
      ${rows.map(row => `
        <div class="gallery-card" data-rowid="${row._id}">
          <div class="gallery-card-img" style="background:${randCardColor(row._id)}">
            <span class="gallery-card-initials">${(titleCol?String(row[titleCol.id]||'?'):'#'+row._rownum).charAt(0).toUpperCase()}</span>
          </div>
          <div class="gallery-card-body">
            <div class="gallery-card-title">${esc(titleCol?row[titleCol.id]:'Record #'+row._rownum)}</div>
            ${visibleCols.map(col=>`
              <div class="gallery-card-field">
                <span class="gc-label">${esc(col.name)}</span>
                <span class="gc-val">${(Renderers[col.type]||Renderers.text)(row[col.id], col)}</span>
              </div>
            `).join('')}
          </div>
        </div>
      `).join('')}
      <div class="gallery-add-card" id="gallery-add">
        <span>＋</span><span>New record</span>
      </div>
    </div>`;

    vc.querySelectorAll('.gallery-card').forEach(card => {
      card.onclick = () => this.openRecordPanel(Number(card.dataset.rowid), schema);
    });
    document.getElementById('gallery-add').onclick = () => this.addRow();
  }

  /* ══════════════════════════════
     CHART VIEW
  ══════════════════════════════ */
  async renderChart(schema) {
    const { rows } = this.state;
    const vc = document.getElementById('view-container');
    const numCols = schema.columns.filter(c => ['number','currency','percent','rating'].includes(c.type));
    const groupCol = schema.columns.find(c => c.type === 'select' || c.type === 'text');
    const viewCfg = this.state.view?.config || {};
    const chartType = viewCfg.chartType || 'bar';

    if (!numCols.length) {
      vc.innerHTML = '<div class="empty-state">Add numeric columns to use Chart view</div>';
      return;
    }

    vc.innerHTML = `
      <div class="chart-controls">
        <select id="chart-type-sel">
          ${['bar','line','pie','doughnut','radar'].map(t=>`<option ${t===chartType?'selected':''}>${t}</option>`).join('')}
        </select>
        <select id="chart-group-sel">
          ${schema.columns.filter(c=>!c.system).map(c=>`<option value="${c.id}" ${c.id===groupCol?.id?'selected':''}>${esc(c.name)}</option>`).join('')}
        </select>
        <select id="chart-val-sel">
          ${numCols.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}
        </select>
      </div>
      <div class="chart-wrap"><canvas id="main-chart"></canvas></div>
      <div class="chart-summary">
        ${numCols.map(c=>{
          const vals = rows.map(r=>Number(r[c.id]||0));
          const sum = vals.reduce((a,b)=>a+b,0);
          const avg = vals.length?sum/vals.length:0;
          return `<div class="chart-stat"><div class="cs-label">${esc(c.name)}</div><div class="cs-sum">${fmtNum(sum)}</div><div class="cs-avg">Avg: ${fmtNum(avg)}</div></div>`;
        }).join('')}
      </div>
    `;

    this._drawChart(rows, schema, groupCol?.id, numCols[0]?.id, chartType);

    ['chart-type-sel','chart-group-sel','chart-val-sel'].forEach(id => {
      document.getElementById(id).onchange = () => {
        const ct = document.getElementById('chart-type-sel').value;
        const gid = document.getElementById('chart-group-sel').value;
        const vid = document.getElementById('chart-val-sel').value;
        this._drawChart(rows, schema, gid, vid, ct);
        if (this.state.viewId) this.db.updateView(this.state.viewId, { config:{ chartType:ct } });
      };
    });
  }

  _drawChart(rows, schema, groupColId, valColId, type) {
    const gCol = schema.columns.find(c=>c.id===groupColId);
    const vCol = schema.columns.find(c=>c.id===valColId);
    if (!gCol || !vCol) return;

    const agg = {};
    rows.forEach(r => {
      const key = String(r[groupColId] ?? '(empty)').slice(0,20);
      agg[key] = (agg[key]||0) + (Number(r[valColId])||0);
    });

    const labels = Object.keys(agg);
    const data = Object.values(agg);
    const colors = labels.map((_,i)=>this.COLORS[i%this.COLORS.length]);

    const canvas = document.getElementById('main-chart');
    if (!canvas) return;
    if (window._chartInstance) window._chartInstance.destroy();

    if (!window.Chart) { canvas.parentElement.innerHTML = '<div class="empty-state">Chart.js loading…</div>'; return; }

    window._chartInstance = new window.Chart(canvas, {
      type,
      data: { labels, datasets:[{ label: vCol.name, data, backgroundColor:colors, borderColor:colors.map(c=>c+'cc'), borderWidth:2, tension:0.4 }] },
      options: { responsive:true, maintainAspectRatio:false, plugins:{ legend:{ position:'bottom' }, tooltip:{ callbacks:{ label:ctx=>`${ctx.dataset.label}: ${fmtNum(ctx.parsed.y??ctx.parsed)}` } } } }
    });
  }

  /* ══════════════════════════════
     CALENDAR VIEW
  ══════════════════════════════ */
  async renderCalendar(schema) {
    const { rows } = this.state;
    const dateCol = schema.columns.find(c => c.type === 'date' || c.type === 'datetime');
    const vc = document.getElementById('view-container');
    if (!dateCol) { vc.innerHTML = '<div class="empty-state">Add a Date column to use Calendar view</div>'; return; }

    const now = new Date(); const year=now.getFullYear(); const month=now.getMonth();
    const firstDay = new Date(year,month,1).getDay();
    const daysInMonth = new Date(year,month+1,0).getDate();
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    const byDate = {};
    rows.forEach(r => {
      const d = r[dateCol.id]?.split('T')[0];
      if (d) { if (!byDate[d]) byDate[d]=[]; byDate[d].push(r); }
    });

    const titleCol = schema.columns.find(c=>c.type==='text'&&!c.system);

    let html = `<div class="calendar-wrap">
      <div class="cal-header"><h3>${months[month]} ${year}</h3></div>
      <div class="cal-grid">
        ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d=>`<div class="cal-dow">${d}</div>`).join('')}
        ${Array(firstDay).fill('<div class="cal-cell empty"></div>').join('')}
        ${Array.from({length:daysInMonth},(_,i)=>{
          const d = i+1;
          const key = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
          const dayRows = byDate[key]||[];
          const isToday = new Date().toISOString().startsWith(key);
          return `<div class="cal-cell ${isToday?'today':''}">
            <span class="cal-day-num">${d}</span>
            ${dayRows.slice(0,3).map(r=>`<div class="cal-event" data-rowid="${r._id}">${esc(titleCol?String(r[titleCol.id]||'').slice(0,15):'Record')}</div>`).join('')}
            ${dayRows.length>3?`<div class="cal-more">+${dayRows.length-3} more</div>`:''}
          </div>`;
        }).join('')}
      </div>
    </div>`;

    vc.innerHTML = html;
    vc.querySelectorAll('.cal-event').forEach(el => {
      el.onclick = () => this.openRecordPanel(Number(el.dataset.rowid), schema);
    });
  }

  /* ══════════════════════════════
     FORM VIEW
  ══════════════════════════════ */
  async renderForm(schema) {
    const vc = document.getElementById('view-container');
    const cols = schema.columns.filter(c => !c.system);
    vc.innerHTML = `
      <div class="form-wrap">
        <div class="form-card">
          <h2 class="form-title">New ${esc(schema.name)}</h2>
          <p class="form-subtitle">Fill in the fields below</p>
          <form id="db-form">
            ${cols.map(col => `
              <div class="form-field">
                <label class="form-label">${colTypeIcon(col.type)} ${esc(col.name)}</label>
                ${this._rpEditor(col, {})}
              </div>
            `).join('')}
            <div class="form-actions">
              <button type="submit" class="btn-primary btn-lg">Submit</button>
              <button type="reset" class="btn-secondary">Clear</button>
            </div>
          </form>
          <div id="form-success" class="hidden">
            <div class="form-success-msg">✅ Record submitted successfully!</div>
            <button class="btn-primary" id="form-submit-another">Submit another</button>
          </div>
        </div>
      </div>
    `;

    document.getElementById('db-form').onsubmit = async e => {
      e.preventDefault();
      const data = {};
      cols.forEach(col => {
        const el = document.querySelector(`[data-colid="${col.id}"]`);
        if (!el) return;
        if (el.type==='checkbox') data[col.id]=el.checked;
        else if (el.multiple) data[col.id]=[...el.selectedOptions].map(o=>o.value).join(',');
        else data[col.id]=el.value;
      });
      await this.db.insertRow(this.state.tableId, data);
      document.getElementById('db-form').classList.add('hidden');
      document.getElementById('form-success').classList.remove('hidden');
    };

    document.getElementById('form-submit-another')?.addEventListener('click', () => {
      document.getElementById('db-form').classList.remove('hidden');
      document.getElementById('form-success').classList.add('hidden');
      document.getElementById('db-form').reset();
    });
  }

  /* ══════════════════════════════
     FILTER PANEL
  ══════════════════════════════ */
  showFilterPanel() {
    const schema = [...this.db.tables.values()].find(t=>t.id===this.state.tableId);
    if (!schema) return;
    const cols = schema.columns.filter(c=>!c.system);
    const OPS = { text:['contains','not_contains','eq','neq','starts_with','ends_with','is_empty','is_not_empty'],
      number:['eq','neq','gt','gte','lt','lte','is_empty','is_not_empty'], boolean:['is_true','is_false'],
      select:['eq','neq','is_empty','is_not_empty'], date:['eq','gt','lt','is_empty','is_not_empty'] };

    this.showModal('Filters', `
      <div id="filter-conditions">
        ${this.state.filters.conditions.map((cond,i)=>this._filterConditionHtml(cond,i,cols,OPS)).join('')}
      </div>
      <button class="btn-secondary mt-2" id="add-filter-cond">＋ Add condition</button>
      <div class="modal-footer">
        <button class="btn-secondary" id="clear-filters">Clear all</button>
        <button class="btn-primary" id="apply-filters">Apply filters</button>
      </div>
    `);

    document.getElementById('add-filter-cond').onclick = () => {
      const cond = { field: cols[0]?.id, op:'contains', value:'' };
      this.state.filters.conditions.push(cond);
      document.getElementById('filter-conditions').insertAdjacentHTML('beforeend', this._filterConditionHtml(cond, this.state.filters.conditions.length-1, cols, OPS));
    };
    document.getElementById('clear-filters').onclick = () => { this.state.filters={operator:'AND',conditions:[]}; this.closeModal(); this.loadData(); };
    document.getElementById('apply-filters').onclick = () => {
      const conds = [];
      document.querySelectorAll('.filter-row').forEach(row => {
        conds.push({ field:row.querySelector('.fc-field').value, op:row.querySelector('.fc-op').value, value:row.querySelector('.fc-val')?.value||'' });
      });
      this.state.filters = { operator:'AND', conditions:conds };
      this.closeModal();
      this.loadData();
    };
    document.querySelectorAll('.fc-remove').forEach(btn => {
      btn.onclick = () => btn.closest('.filter-row').remove();
    });
  }

  _filterConditionHtml(cond, i, cols, OPS) {
    const getOps = type => (OPS[type] || OPS.text).map(o=>`<option ${o===cond.op?'selected':''}>${o}</option>`).join('');
    return `<div class="filter-row">
      <select class="fc-field">${cols.map(c=>`<option value="${c.id}" ${c.id===cond.field?'selected':''}>${esc(c.name)}</option>`).join('')}</select>
      <select class="fc-op">${getOps('text')}</select>
      <input class="fc-val" value="${esc(cond.value||'')}" placeholder="value" />
      <button class="fc-remove btn-icon-sm">✕</button>
    </div>`;
  }

  _renderActiveFilters() {
    const bar = document.getElementById('active-filters');
    const conds = this.state.filters.conditions;
    if (!conds.length) { bar.innerHTML=''; return; }
    const schema = [...this.db.tables.values()].find(t=>t.id===this.state.tableId);
    bar.innerHTML = `<div class="active-filters-bar">
      <span class="af-label">Filters:</span>
      ${conds.map(c=>{
        const col = schema?.columns.find(x=>x.id===c.field);
        return `<span class="af-chip">${esc(col?.name||c.field)} ${c.op} "${esc(c.value)}"</span>`;
      }).join('')}
      <button class="af-clear" id="af-clear-all">✕ Clear</button>
    </div>`;
    document.getElementById('af-clear-all').onclick = () => { this.state.filters={operator:'AND',conditions:[]}; this.loadData(); };
  }

  /* ══════════════════════════════
     SORT PANEL
  ══════════════════════════════ */
  showSortPanel() {
    const schema = [...this.db.tables.values()].find(t=>t.id===this.state.tableId);
    if (!schema) return;
    const cols = schema.columns.filter(c=>!c.system);
    this.showModal('Sort', `
      <div id="sort-conditions">
        ${this.state.sorts.map((s,i)=>`
          <div class="sort-row">
            <select class="sc-field">${cols.map(c=>`<option value="${c.id}" ${c.id===s.field?'selected':''}>${esc(c.name)}</option>`).join('')}</select>
            <select class="sc-dir"><option value="asc" ${s.dir==='asc'?'selected':''}>A → Z</option><option value="desc" ${s.dir==='desc'?'selected':''}>Z → A</option></select>
            <button class="fc-remove btn-icon-sm">✕</button>
          </div>
        `).join('')}
      </div>
      <button class="btn-secondary mt-2" id="add-sort">＋ Add sort</button>
      <div class="modal-footer">
        <button class="btn-secondary" id="clear-sorts">Clear all</button>
        <button class="btn-primary" id="apply-sorts">Apply</button>
      </div>
    `);
    document.getElementById('add-sort').onclick = () => {
      document.getElementById('sort-conditions').insertAdjacentHTML('beforeend', `
        <div class="sort-row">
          <select class="sc-field">${cols.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
          <select class="sc-dir"><option value="asc">A → Z</option><option value="desc">Z → A</option></select>
          <button class="fc-remove btn-icon-sm">✕</button>
        </div>
      `);
      document.querySelectorAll('.fc-remove').forEach(btn=>{ btn.onclick=()=>btn.closest('.sort-row,.filter-row').remove(); });
    };
    document.getElementById('clear-sorts').onclick = ()=>{ this.state.sorts=[]; this.closeModal(); this.loadData(); };
    document.getElementById('apply-sorts').onclick = ()=>{
      this.state.sorts=[...document.querySelectorAll('.sort-row')].map(r=>({ field:r.querySelector('.sc-field').value, dir:r.querySelector('.sc-dir').value }));
      this.closeModal(); this.loadData();
    };
    document.querySelectorAll('.fc-remove').forEach(btn=>{ btn.onclick=()=>btn.closest('.sort-row').remove(); });
  }

  /* ══════════════════════════════
     FIELDS PANEL
  ══════════════════════════════ */
  showFieldsPanel() {
    const schema = [...this.db.tables.values()].find(t=>t.id===this.state.tableId);
    if (!schema) return;
    this.showModal('Fields', `
      <p class="modal-hint">Toggle column visibility</p>
      <div class="fields-list">
        ${schema.columns.map(c=>`
          <div class="field-row">
            <input type="checkbox" class="fc-vis" data-colid="${c.id}" ${!this.state.hiddenCols.has(c.id)?'checked':''}/>
            <span>${colTypeIcon(c.type)} ${esc(c.name)}</span>
          </div>
        `).join('')}
      </div>
      <div class="modal-footer"><button class="btn-primary" id="apply-fields">Apply</button></div>
    `);
    document.getElementById('apply-fields').onclick = ()=>{
      this.state.hiddenCols = new Set();
      document.querySelectorAll('.fc-vis').forEach(cb=>{ if(!cb.checked) this.state.hiddenCols.add(cb.dataset.colid); });
      this.closeModal(); this.loadData();
    };
  }

  /* ══════════════════════════════
     COLUMN MENU
  ══════════════════════════════ */
  showColMenu(e, colId, schema) {
    this.closeContextMenu();
    const col = schema.columns.find(c=>c.id===colId);
    if (!col) return;
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.cssText = `left:${e.clientX}px;top:${e.clientY}px`;
    menu.innerHTML = `
      <div class="ctx-item" data-action="rename">✏ Rename</div>
      <div class="ctx-item" data-action="sort-asc">↑ Sort A→Z</div>
      <div class="ctx-item" data-action="sort-desc">↓ Sort Z→A</div>
      <div class="ctx-item" data-action="filter">⚗ Filter by this field</div>
      <div class="ctx-item" data-action="hide">👁 Hide column</div>
      ${!col.system?'<div class="ctx-sep"></div><div class="ctx-item ctx-danger" data-action="delete">🗑 Delete column</div>':''}
    `;
    menu.querySelectorAll('.ctx-item').forEach(item=>{
      item.onclick=()=>{
        const action=item.dataset.action;
        this.closeContextMenu();
        if(action==='rename'){
          const name=prompt('Column name:',col.name);
          if(name) this.db.updateColumn(this.state.tableId,colId,{name}).then(()=>this.loadData());
        } else if(action==='sort-asc'){ this.state.sorts=[{field:colId,dir:'asc'}]; this.loadData(); }
        else if(action==='sort-desc'){ this.state.sorts=[{field:colId,dir:'desc'}]; this.loadData(); }
        else if(action==='hide'){ this.state.hiddenCols.add(colId); this.loadData(); }
        else if(action==='delete'){
          if(confirm('Delete this column and all its data?')) this.db.deleteColumn(this.state.tableId,colId).then(()=>this.loadData());
        }
      };
    });
    document.body.appendChild(menu);
    document.addEventListener('click',()=>this.closeContextMenu(),{once:true});
  }

  /* ══════════════════════════════
     ADD COLUMN MODAL
  ══════════════════════════════ */
  showAddColumnModal(schema) {
    const types = Object.values(COL_TYPES);
    this.showModal('Add Column', `
      <div class="form-field">
        <label>Column Name</label>
        <input id="new-col-name" class="modal-input" placeholder="Column name" />
      </div>
      <div class="form-field">
        <label>Type</label>
        <select id="new-col-type" class="modal-input">
          ${types.map(t=>`<option value="${t}">${colTypeIcon(t)} ${t}</option>`).join('')}
        </select>
      </div>
      <div id="col-options"></div>
      <div class="modal-footer">
        <button class="btn-secondary" id="cancel-col">Cancel</button>
        <button class="btn-primary" id="confirm-add-col">Add Column</button>
      </div>
    `);

    document.getElementById('new-col-type').onchange = e => this._renderColOptions(e.target.value);
    document.getElementById('cancel-col').onclick = () => this.closeModal();
    document.getElementById('confirm-add-col').onclick = async () => {
      const name = document.getElementById('new-col-name').value.trim();
      const type = document.getElementById('new-col-type').value;
      if (!name) { this.toast('Enter a column name','warn'); return; }
      const options = this._collectColOptions(type);
      await this.db.addColumn(this.state.tableId, { name, type, options });
      this.closeModal();
      await this.loadData();
      this.toast(`Column "${name}" added`);
    };
  }

  _renderColOptions(type) {
    const container = document.getElementById('col-options');
    if (!container) return;
    if (type === 'select' || type === 'multiselect') {
      container.innerHTML = `<div class="form-field"><label>Choices (comma-separated)</label><input id="col-choices" class="modal-input" placeholder="Option1, Option2, Option3" /></div>`;
    } else if (type === 'currency') {
      container.innerHTML = `<div class="form-field"><label>Currency</label><select id="col-currency" class="modal-input"><option>USD</option><option>EUR</option><option>MXN</option><option>GBP</option></select></div>`;
    } else if (type === 'formula') {
      container.innerHTML = `<div class="form-field"><label>Formula</label><input id="col-formula" class="modal-input" placeholder="=Field_Name * 2" /></div><p class="modal-hint">Use =SUM(), =AVG(), =IF(), =CONCAT(), field names with underscores</p>`;
    } else {
      container.innerHTML = '';
    }
  }

  _collectColOptions(type) {
    if (type === 'select' || type === 'multiselect') {
      const raw = document.getElementById('col-choices')?.value || '';
      return { choices: raw.split(',').map(s=>s.trim()).filter(Boolean) };
    }
    if (type === 'currency') return { currency: document.getElementById('col-currency')?.value||'USD' };
    if (type === 'formula') return { formula: document.getElementById('col-formula')?.value||'' };
    return {};
  }

  /* ══════════════════════════════
     NEW TABLE MODAL
  ══════════════════════════════ */
  showNewTableModal() {
    this.showModal('New Table', `
      <div class="form-field">
        <label>Table Name</label>
        <input id="new-table-name" class="modal-input" placeholder="My Table" autofocus />
      </div>
      <div class="form-field">
        <label>Quick Template</label>
        <div class="template-grid">
          ${[
            {id:'blank',icon:'📋',name:'Blank'},
            {id:'crm',icon:'👥',name:'CRM'},
            {id:'tasks',icon:'✅',name:'Tasks'},
            {id:'inventory',icon:'📦',name:'Inventory'},
            {id:'budget',icon:'💰',name:'Budget'},
            {id:'hr',icon:'🏢',name:'HR'}
          ].map(t=>`<div class="template-card" data-tpl="${t.id}"><span>${t.icon}</span><span>${t.name}</span></div>`).join('')}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-secondary" id="cancel-table">Cancel</button>
        <button class="btn-primary" id="confirm-new-table">Create Table</button>
      </div>
    `);

    let selectedTpl = 'blank';
    document.querySelectorAll('.template-card').forEach(card => {
      card.onclick = () => {
        document.querySelectorAll('.template-card').forEach(c=>c.classList.remove('selected'));
        card.classList.add('selected');
        selectedTpl = card.dataset.tpl;
        if (!document.getElementById('new-table-name').value)
          document.getElementById('new-table-name').value = card.querySelector('span:last-child').textContent;
      };
    });
    document.getElementById('cancel-table').onclick = () => this.closeModal();
    document.getElementById('confirm-new-table').onclick = async () => {
      const name = document.getElementById('new-table-name').value.trim();
      if (!name) { this.toast('Enter a table name','warn'); return; }
      const cols = this._tplColumns(selectedTpl);
      const t = await this.db.createTable(name, cols);
      this.closeModal();
      await this._loadSidebar();
      await this.selectTable(t.id);
      this.toast(`Table "${name}" created`);
    };
  }

  _tplColumns(tpl) {
    const T = { text:'text', num:'number', date:'date', sel:'select', bool:'boolean', email:'email', url:'url', currency:'currency', percent:'percent', phone:'phone' };
    const tpls = {
      blank: [],
      crm: [
        {name:'Full Name',type:T.text},{name:'Company',type:T.text},{name:'Email',type:T.email},{name:'Phone',type:T.phone},
        {name:'Status',type:T.sel,options:{choices:['Lead','Prospect','Customer','Churned']}},
        {name:'Deal Value',type:T.currency,options:{currency:'USD'}},{name:'Last Contact',type:T.date},{name:'Notes',type:T.text}
      ],
      tasks: [
        {name:'Task',type:T.text},{name:'Assignee',type:T.text},
        {name:'Status',type:T.sel,options:{choices:['To Do','In Progress','In Review','Done']}},
        {name:'Priority',type:T.sel,options:{choices:['Low','Medium','High','Urgent']}},
        {name:'Due Date',type:T.date},{name:'Progress',type:T.percent},{name:'Done',type:T.bool}
      ],
      inventory: [
        {name:'SKU',type:T.text},{name:'Product',type:T.text},
        {name:'Category',type:T.sel,options:{choices:['Electronics','Mechanical','Raw Material','Consumable']}},
        {name:'Qty',type:T.num},{name:'Unit Cost',type:T.currency,options:{currency:'USD'}},
        {name:'Supplier',type:T.text},{name:'Location',type:T.text},{name:'Active',type:T.bool}
      ],
      budget: [
        {name:'Item',type:T.text},
        {name:'Category',type:T.sel,options:{choices:['Income','COGS','Operating','Marketing','R&D','Other']}},
        {name:'Planned',type:T.currency,options:{currency:'USD'}},{name:'Actual',type:T.currency,options:{currency:'USD'}},
        {name:'Variance',type:'formula',options:{formula:'=Actual - Planned'}},{name:'Month',type:T.sel,options:{choices:['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']}}
      ],
      hr: [
        {name:'Employee',type:T.text},{name:'Email',type:T.email},{name:'Department',type:T.sel,options:{choices:['Engineering','Sales','Marketing','HR','Finance','Operations']}},
        {name:'Role',type:T.text},{name:'Start Date',type:T.date},{name:'Salary',type:T.currency,options:{currency:'USD'}},
        {name:'Status',type:T.sel,options:{choices:['Active','On Leave','Terminated']}},{name:'Manager',type:T.text}
      ]
    };
    return tpls[tpl] || [];
  }

  /* ══════════════════════════════
     ADD VIEW MODAL
  ══════════════════════════════ */
  showAddViewModal() {
    this.showModal('Add View', `
      <div class="view-type-grid">
        ${[
          {type:'grid',icon:'▦',name:'Grid'},
          {type:'kanban',icon:'⬜',name:'Kanban'},
          {type:'gallery',icon:'⊞',name:'Gallery'},
          {type:'chart',icon:'📊',name:'Chart'},
          {type:'calendar',icon:'📅',name:'Calendar'},
          {type:'form',icon:'📝',name:'Form'},
        ].map(v=>`<div class="view-type-card" data-type="${v.type}"><span>${v.icon}</span><span>${v.name}</span></div>`).join('')}
      </div>
      <div class="form-field mt-2">
        <input id="new-view-name" class="modal-input" placeholder="View name" />
      </div>
      <div class="modal-footer">
        <button class="btn-secondary" id="cancel-view">Cancel</button>
        <button class="btn-primary" id="confirm-view">Create View</button>
      </div>
    `);

    let selType = 'grid';
    document.querySelectorAll('.view-type-card').forEach(card => {
      card.onclick = () => {
        document.querySelectorAll('.view-type-card').forEach(c=>c.classList.remove('selected'));
        card.classList.add('selected'); selType = card.dataset.type;
        if (!document.getElementById('new-view-name').value)
          document.getElementById('new-view-name').value = card.querySelector('span:last-child').textContent + ' View';
      };
    });
    document.getElementById('cancel-view').onclick = () => this.closeModal();
    document.getElementById('confirm-view').onclick = async () => {
      const name = document.getElementById('new-view-name').value.trim() || selType + ' View';
      const view = await this.db.createView(this.state.tableId, { name, type: selType });
      this.closeModal();
      const views = await this.db.getViews(this.state.tableId);
      this._renderViewTabs(views);
      await this.selectView(view);
    };
  }

  /* ══════════════════════════════
     IMPORT / EXPORT
  ══════════════════════════════ */
  showImportModal() {
    this.showModal('Import Data', `
      <div class="import-tabs">
        <button class="imp-tab active" data-fmt="csv">📄 CSV</button>
        <button class="imp-tab" data-fmt="json">📋 JSON</button>
        <button class="imp-tab" data-fmt="excel">📊 Excel</button>
        <button class="imp-tab" data-fmt="gsheets">🟢 Google Sheets</button>
        <button class="imp-tab" data-fmt="paste">📋 Paste</button>
      </div>
      <div id="import-body">
        <div class="form-field">
          <label>Upload file</label>
          <div class="file-drop" id="file-drop">
            <span>📁 Drop file here or click to browse</span>
            <input type="file" id="imp-file" accept=".csv,.json,.xlsx" style="opacity:0;position:absolute;inset:0;cursor:pointer" />
          </div>
        </div>
        <div id="imp-preview"></div>
      </div>
      <div class="modal-footer">
        <button class="btn-secondary" id="cancel-imp">Cancel</button>
        <button class="btn-primary" id="confirm-imp">Import</button>
      </div>
    `);

    let fmt='csv', fileContent=null;
    document.querySelectorAll('.imp-tab').forEach(tab=>{
      tab.onclick=()=>{
        document.querySelectorAll('.imp-tab').forEach(t=>t.classList.remove('active'));
        tab.classList.add('active'); fmt=tab.dataset.fmt;
        this._renderImportBody(fmt);
      };
    });

    document.getElementById('imp-file').onchange = async e => {
      const file = e.target.files[0];
      if (!file) return;
      fileContent = await file.text();
      const preview = fileContent.split('\n').slice(0,3).join('\n');
      document.getElementById('imp-preview').innerHTML = `<pre class="imp-preview">${esc(preview)}\n…</pre>`;
    };

    document.getElementById('cancel-imp').onclick=()=>this.closeModal();
    document.getElementById('confirm-imp').onclick=async()=>{
      if (!fileContent && fmt!=='gsheets' && fmt!=='paste') { this.toast('Select a file first','warn'); return; }
      try {
        let rows;
        if (fmt==='csv' || fmt==='paste') rows = await this.db.importCSV(this.state.tableId, fileContent||document.getElementById('paste-area')?.value||'');
        else if (fmt==='json') rows = await this.db.importJSON(this.state.tableId, fileContent);
        else { this.toast('Feature requires backend integration','info'); this.closeModal(); return; }
        this.closeModal(); await this.loadData();
        this.toast(`Imported ${rows.length} records`);
      } catch(err) { this.toast('Import failed: '+err.message,'error'); }
    };
  }

  _renderImportBody(fmt) {
    const body = document.getElementById('import-body');
    if (!body) return;
    if (fmt==='gsheets') {
      body.innerHTML = `
        <div class="integration-info">
          <p>Connect your Google account and enter a Sheets URL:</p>
          <button class="btn-oauth google-btn" id="google-auth">🔑 Sign in with Google</button>
          <div class="form-field mt-2"><label>Spreadsheet URL</label><input id="gsheets-url" class="modal-input" placeholder="https://docs.google.com/spreadsheets/d/…" /></div>
          <p class="modal-hint">Requires Google Sheets API access. Configure OAuth credentials in Integrations.</p>
        </div>`;
      document.getElementById('google-auth')?.addEventListener('click', ()=>this.toast('Configure Google OAuth in Integration Hub first','info'));
    } else if (fmt==='paste') {
      body.innerHTML = `<div class="form-field"><label>Paste CSV data</label><textarea id="paste-area" class="modal-input" rows="6" placeholder="name,email,phone\nJohn,john@example.com,+1234…"></textarea></div>`;
    } else {
      body.innerHTML = `
        <div class="form-field">
          <div class="file-drop" id="file-drop">
            <span>📁 Drop ${fmt.toUpperCase()} file here or click to browse</span>
            <input type="file" id="imp-file" accept="${fmt==='excel'?'.xlsx,.xls':'.'+fmt}" style="opacity:0;position:absolute;inset:0;cursor:pointer" />
          </div>
        </div>
        <div id="imp-preview"></div>`;
      document.getElementById('imp-file').onchange = async e => {
        const file = e.target.files[0]; if (!file) return;
        const fileContent2 = await file.text();
        document.getElementById('imp-preview').innerHTML = `<pre class="imp-preview">${esc(fileContent2.slice(0,200))}…</pre>`;
        document.getElementById('confirm-imp').dataset.content = fileContent2;
      };
    }
  }

  showExportModal() {
    this.showModal('Export Data', `
      <div class="export-options">
        <div class="export-opt" data-fmt="csv">
          <span class="eo-icon">📄</span>
          <div><div class="eo-title">CSV</div><div class="eo-desc">Comma-separated, opens in Excel/Sheets</div></div>
        </div>
        <div class="export-opt" data-fmt="json">
          <span class="eo-icon">📋</span>
          <div><div class="eo-title">JSON</div><div class="eo-desc">Structured data for developers</div></div>
        </div>
        <div class="export-opt" data-fmt="xlsx">
          <span class="eo-icon">📊</span>
          <div><div class="eo-title">Excel (.xlsx)</div><div class="eo-desc">Native Excel format</div></div>
        </div>
        <div class="export-opt" data-fmt="gsheets">
          <span class="eo-icon">🟢</span>
          <div><div class="eo-title">Google Sheets</div><div class="eo-desc">Push directly to a Google Sheet</div></div>
        </div>
        <div class="export-opt" data-fmt="api">
          <span class="eo-icon">📡</span>
          <div><div class="eo-title">REST API</div><div class="eo-desc">Access via API endpoint</div></div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-secondary" id="cancel-exp">Cancel</button>
      </div>
    `);

    document.getElementById('cancel-exp').onclick=()=>this.closeModal();
    document.querySelectorAll('.export-opt').forEach(opt=>{
      opt.onclick=async()=>{
        const fmt=opt.dataset.fmt;
        this.closeModal();
        if (fmt==='csv') {
          const csv = await this.db.exportCSV(this.state.tableId);
          this._download(csv,'text/csv',this._tableName()+'.csv');
        } else if (fmt==='json') {
          const json = await this.db.exportJSON(this.state.tableId);
          this._download(json,'application/json',this._tableName()+'.json');
        } else if (fmt==='xlsx') {
          this._exportXLSX();
        } else if (fmt==='gsheets') {
          this.toast('Configure Google OAuth in Integration Hub first','info');
        } else if (fmt==='api') {
          this.showApiExplorer();
        }
      };
    });
  }

  async _exportXLSX() {
    if (!window.XLSX) { this.toast('SheetJS not loaded','error'); return; }
    const schema = await this.db.getTable(this.state.tableId);
    const { rows } = await this.db.query(this.state.tableId);
    const data = [schema.columns.map(c=>c.name), ...rows.map(r=>schema.columns.map(c=>r[c.id]??''))];
    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, schema.name.slice(0,31));
    XLSX.writeFile(wb, schema.name+'.xlsx');
    this.toast('Excel file downloaded');
  }

  _download(content, mime, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content],{type:mime}));
    a.download = filename; a.click();
    URL.revokeObjectURL(a.href);
    this.toast('Download started');
  }

  _tableName() {
    return [...this.db.tables.values()].find(t=>t.id===this.state.tableId)?.name || 'export';
  }

  /* ══════════════════════════════
     INTEGRATION HUB
  ══════════════════════════════ */
  showIntegrationHub() {
    const integrations = [
      { id:'gsheets',  icon:'🟢', name:'Google Sheets',    desc:'Sync data bidirectionally with Google Sheets', category:'Spreadsheet', status:'available' },
      { id:'excel',    icon:'📊', name:'Microsoft Excel',   desc:'Import/export .xlsx files, connect to SharePoint/OneDrive', category:'Spreadsheet', status:'available' },
      { id:'zapier',   icon:'⚡', name:'Zapier',            desc:'Connect 5,000+ apps via Zapier workflows', category:'Automation', status:'available' },
      { id:'make',     icon:'🔄', name:'Make (Integromat)', desc:'Visual automation platform with 1,000+ apps', category:'Automation', status:'available' },
      { id:'n8n',      icon:'🔗', name:'n8n',               desc:'Open-source workflow automation', category:'Automation', status:'available' },
      { id:'salesforce',icon:'☁', name:'Salesforce',        desc:'Sync CRM data with Salesforce', category:'CRM', status:'available' },
      { id:'hubspot',  icon:'🧲', name:'HubSpot',           desc:'Sync contacts, deals and tickets', category:'CRM', status:'available' },
      { id:'slack',    icon:'💬', name:'Slack',             desc:'Send notifications and receive data from Slack', category:'Communication', status:'available' },
      { id:'airtable', icon:'📋', name:'Airtable',          desc:'Migrate or sync data from Airtable bases', category:'Database', status:'available' },
      { id:'notion',   icon:'📓', name:'Notion',            desc:'Sync pages and databases from Notion', category:'Database', status:'available' },
      { id:'supabase', icon:'⚡', name:'Supabase',          desc:'PostgreSQL cloud database backend', category:'Database', status:'available' },
      { id:'firebase', icon:'🔥', name:'Firebase',          desc:'Real-time database and Firestore sync', category:'Database', status:'available' },
      { id:'mysql',    icon:'🐬', name:'MySQL / MariaDB',   desc:'Connect to your MySQL database directly', category:'Database', status:'available' },
      { id:'postgres', icon:'🐘', name:'PostgreSQL',        desc:'Connect to PostgreSQL with full SQL support', category:'Database', status:'available' },
      { id:'mongodb',  icon:'🍃', name:'MongoDB',           desc:'Sync with MongoDB collections', category:'Database', status:'available' },
      { id:'rest',     icon:'📡', name:'REST API',          desc:'Generic REST API connector - any endpoint', category:'Developer', status:'available' },
      { id:'graphql',  icon:'◉',  name:'GraphQL',           desc:'Connect to any GraphQL API', category:'Developer', status:'available' },
      { id:'webhook',  icon:'🪝', name:'Webhooks',          desc:'Receive and send webhook events', category:'Developer', status:'available' },
      { id:'csv_url',  icon:'🔗', name:'CSV URL Sync',      desc:'Auto-fetch CSV from a URL on schedule', category:'Developer', status:'available' },
      { id:'stripe',   icon:'💳', name:'Stripe',            desc:'Import payments, customers and invoices', category:'Finance', status:'available' },
      { id:'quickbooks',icon:'💰',name:'QuickBooks',        desc:'Sync accounting data', category:'Finance', status:'available' },
      { id:'shopify',  icon:'🛍', name:'Shopify',           desc:'Products, orders and customers from Shopify', category:'eCommerce', status:'available' },
      { id:'woo',      icon:'🛒', name:'WooCommerce',       desc:'Sync WooCommerce store data', category:'eCommerce', status:'available' },
    ];

    const categories = [...new Set(integrations.map(i=>i.category))];

    this.showModal('Integration Hub', `
      <div class="hub-header">
        <p>Connect CloudDB to external tools, databases and services</p>
        <div class="hub-search-wrap">
          <input id="hub-search" class="modal-input" placeholder="Search integrations…" />
        </div>
      </div>
      <div class="hub-cats">
        <button class="hub-cat active" data-cat="all">All</button>
        ${categories.map(c=>`<button class="hub-cat" data-cat="${c}">${c}</button>`).join('')}
      </div>
      <div class="hub-grid" id="hub-grid">
        ${integrations.map(ig=>`
          <div class="hub-card" data-cat="${ig.category}" data-id="${ig.id}">
            <div class="hub-card-icon">${ig.icon}</div>
            <div class="hub-card-body">
              <div class="hub-card-name">${esc(ig.name)}</div>
              <div class="hub-card-desc">${esc(ig.desc)}</div>
              <span class="hub-badge hub-badge-${ig.category.toLowerCase()}">${ig.category}</span>
            </div>
            <button class="hub-connect-btn" data-id="${ig.id}" data-name="${esc(ig.name)}">Connect</button>
          </div>
        `).join('')}
      </div>
      <div class="modal-footer">
        <button class="btn-secondary" id="close-hub">Close</button>
        <button class="btn-primary" id="hub-webhook">＋ Add Webhook</button>
      </div>
    `, 'modal-xl');

    document.getElementById('close-hub').onclick=()=>this.closeModal();
    document.getElementById('hub-webhook').onclick=()=>{ this.closeModal(); this.showWebhookModal(); };

    document.getElementById('hub-search').oninput=e=>{
      const q=e.target.value.toLowerCase();
      document.querySelectorAll('.hub-card').forEach(c=>{
        c.style.display=c.textContent.toLowerCase().includes(q)?'':'none';
      });
    };

    document.querySelectorAll('.hub-cat').forEach(btn=>{
      btn.onclick=()=>{
        document.querySelectorAll('.hub-cat').forEach(b=>b.classList.remove('active'));
        btn.classList.add('active');
        const cat=btn.dataset.cat;
        document.querySelectorAll('.hub-card').forEach(c=>{
          c.style.display=(cat==='all'||c.dataset.cat===cat)?'':'none';
        });
      };
    });

    document.querySelectorAll('.hub-connect-btn').forEach(btn=>{
      btn.onclick=()=>this._showConnectDialog(btn.dataset.id, btn.dataset.name);
    });
  }

  _showConnectDialog(id, name) {
    const configs = {
      gsheets: `<div class="form-field"><label>Spreadsheet URL</label><input class="modal-input ig-cfg" name="url" placeholder="https://docs.google.com/spreadsheets/d/…" /></div>
        <div class="form-field"><label>OAuth Client ID</label><input class="modal-input ig-cfg" name="clientId" placeholder="Your Google OAuth Client ID" /></div>
        <button class="btn-oauth google-btn mt-2">🔑 Authorize with Google</button>`,
      rest: `<div class="form-field"><label>API Base URL</label><input class="modal-input ig-cfg" name="baseUrl" placeholder="https://api.example.com/v1" /></div>
        <div class="form-field"><label>Auth Type</label><select class="modal-input ig-cfg" name="authType"><option>None</option><option>API Key</option><option>Bearer Token</option><option>Basic Auth</option><option>OAuth2</option></select></div>
        <div class="form-field"><label>API Key / Token</label><input class="modal-input ig-cfg" name="apiKey" placeholder="Your API key" /></div>`,
      webhook: `<div class="form-field"><label>Webhook URL</label><input class="modal-input ig-cfg" name="url" placeholder="https://hooks.zapier.com/…" /></div>
        <div class="form-field"><label>Secret (optional)</label><input class="modal-input ig-cfg" name="secret" placeholder="Webhook secret key" /></div>
        <div class="form-field"><label>Events</label><div class="checkbox-group">
          ${['row.created','row.updated','row.deleted'].map(e=>`<label><input type="checkbox" class="ig-cfg" name="events" value="${e}" checked /> ${e}</label>`).join('')}
        </div></div>`,
      supabase: `<div class="form-field"><label>Project URL</label><input class="modal-input ig-cfg" name="url" placeholder="https://xyzabc.supabase.co" /></div>
        <div class="form-field"><label>Anon Key</label><input class="modal-input ig-cfg" name="anonKey" placeholder="eyJhbGc…" /></div>`,
      mysql: `<div class="form-field"><label>Host</label><input class="modal-input ig-cfg" name="host" placeholder="localhost or IP" /></div>
        <div class="form-field"><label>Database</label><input class="modal-input ig-cfg" name="database" /></div>
        <div class="form-field"><label>Username</label><input class="modal-input ig-cfg" name="user" /></div>
        <div class="form-field"><label>Password</label><input type="password" class="modal-input ig-cfg" name="password" /></div>`,
    };

    const cfgHtml = configs[id] || configs.rest;
    this.showModal(`Connect: ${name}`, `
      <p class="modal-hint">Configure connection settings for ${esc(name)}</p>
      <div id="ig-config-fields">${cfgHtml}</div>
      <div class="modal-footer">
        <button class="btn-secondary" id="cancel-ig">Cancel</button>
        <button class="btn-primary" id="save-ig">Save Connection</button>
        <button class="btn-sm test-btn" id="test-ig">Test Connection</button>
      </div>
    `);

    document.getElementById('cancel-ig').onclick=()=>{ this.closeModal(); this.showIntegrationHub(); };
    document.getElementById('test-ig').onclick=()=>{
      this.toast('Testing connection…','info');
      setTimeout(()=>this.toast('Connection test: This requires a backend proxy to test CORS-restricted APIs','warn'),1500);
    };
    document.getElementById('save-ig').onclick=async()=>{
      const cfg = { type: id, name };
      document.querySelectorAll('.ig-cfg').forEach(el=>{
        if (el.type==='checkbox') { if (!cfg[el.name]) cfg[el.name]=[]; if(el.checked) cfg[el.name].push(el.value); }
        else cfg[el.name]=el.value;
      });
      await this.db.saveIntegration(cfg);
      this.closeModal();
      this.toast(`${name} connected successfully`);
    };
  }

  showWebhookModal() {
    this.showModal('Configure Webhook', `
      <div class="form-field"><label>Webhook URL</label><input class="modal-input" id="wh-url" placeholder="https://hooks.zapier.com/hooks/catch/…" /></div>
      <div class="form-field"><label>Trigger Events</label>
        <div class="checkbox-group">
          ${['row.created','row.updated','row.deleted','row.imported'].map(e=>`<label><input type="checkbox" class="wh-event" value="${e}" checked /> ${e}</label>`).join('')}
        </div>
      </div>
      <div class="form-field"><label>Secret Key (optional)</label><input class="modal-input" id="wh-secret" placeholder="Used to sign requests (HMAC-SHA256)" /></div>
      <div class="modal-footer">
        <button class="btn-secondary" id="cancel-wh">Cancel</button>
        <button class="btn-primary" id="save-wh">Save Webhook</button>
      </div>
    `);
    document.getElementById('cancel-wh').onclick=()=>this.closeModal();
    document.getElementById('save-wh').onclick=async()=>{
      const url=document.getElementById('wh-url').value.trim();
      if(!url){ this.toast('Enter a webhook URL','warn'); return; }
      const events=[...document.querySelectorAll('.wh-event:checked')].map(c=>c.value);
      const secret=document.getElementById('wh-secret').value.trim();
      await this.db.saveWebhook({url,events,secret,tableId:this.state.tableId});
      this.closeModal();
      this.toast('Webhook saved');
    };
  }

  /* ══════════════════════════════
     AUTOMATIONS
  ══════════════════════════════ */
  showAutomations() {
    const schema = [...this.db.tables.values()].find(t=>t.id===this.state.tableId);
    const tName = schema?.name || 'current table';
    this.showModal('Automations', `
      <p class="modal-hint">Create rules that trigger automatically when data changes</p>
      <div class="auto-builder">
        <div class="auto-section">
          <div class="auto-section-title">⚡ TRIGGER</div>
          <select class="modal-input" id="auto-trigger">
            <option value="row.created">When a record is created</option>
            <option value="row.updated">When a record is updated</option>
            <option value="row.deleted">When a record is deleted</option>
            <option value="field.changed">When a specific field changes</option>
            <option value="schedule.daily">Every day at a set time</option>
            <option value="schedule.hourly">Every hour</option>
            <option value="inbound.webhook">When webhook received</option>
          </select>
          <div id="trigger-config"></div>
        </div>
        <div class="auto-arrow">↓</div>
        <div class="auto-section">
          <div class="auto-section-title">⚙️ CONDITIONS (optional)</div>
          <div class="auto-condition">
            <select class="modal-input" id="auto-cond-field">
              ${(schema?.columns||[]).filter(c=>!c.system).map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}
            </select>
            <select class="modal-input" id="auto-cond-op">
              <option>contains</option><option>eq</option><option>gt</option><option>is_empty</option>
            </select>
            <input class="modal-input" id="auto-cond-val" placeholder="value" />
          </div>
        </div>
        <div class="auto-arrow">↓</div>
        <div class="auto-section">
          <div class="auto-section-title">🎬 ACTION</div>
          <select class="modal-input" id="auto-action">
            <option value="webhook">Send webhook</option>
            <option value="create_row">Create record in table</option>
            <option value="update_field">Update a field</option>
            <option value="send_email">Send email notification</option>
            <option value="slack_msg">Send Slack message</option>
            <option value="api_call">Call REST API</option>
          </select>
          <div id="action-config" class="mt-2">
            <input class="modal-input" id="auto-action-url" placeholder="Webhook URL or config value" />
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-secondary" id="cancel-auto">Cancel</button>
        <button class="btn-primary" id="save-auto">Save Automation</button>
      </div>
    `);

    document.getElementById('cancel-auto').onclick=()=>this.closeModal();
    document.getElementById('save-auto').onclick=async()=>{
      const auto = {
        tableId: this.state.tableId,
        trigger: document.getElementById('auto-trigger').value,
        condition: { field: document.getElementById('auto-cond-field')?.value, op: document.getElementById('auto-cond-op')?.value, value: document.getElementById('auto-cond-val')?.value },
        action: document.getElementById('auto-action').value,
        actionConfig: document.getElementById('auto-action-url')?.value,
        name: 'Automation ' + new Date().toLocaleDateString(),
        active: true
      };
      await this.db.saveAutomation(auto);
      this.closeModal();
      this.toast('Automation saved');
    };
  }

  /* ══════════════════════════════
     API EXPLORER
  ══════════════════════════════ */
  showApiExplorer() {
    const tables = [...this.db.tables.values()];
    const baseUrl = window.location.origin + '/api/v1';
    this.showModal('API Explorer', `
      <div class="api-explorer">
        <div class="api-header">
          <div class="api-base-url">Base URL: <code>${esc(baseUrl)}</code></div>
          <p class="modal-hint">Generate an API key to authenticate requests. All standard REST operations are supported.</p>
        </div>
        <div class="api-key-section">
          <button class="btn-primary" id="gen-api-key">🔑 Generate API Key</button>
          <div id="api-key-result"></div>
        </div>
        <div class="api-endpoints">
          <h3>Endpoints</h3>
          ${tables.flatMap(t=>[
            { method:'GET',    color:'#10B981', path:`/tables/${t.id}/records`,     desc:`List all records from ${t.name}` },
            { method:'POST',   color:'#3B82F6', path:`/tables/${t.id}/records`,     desc:`Create a new record in ${t.name}` },
            { method:'GET',    color:'#10B981', path:`/tables/${t.id}/records/:id`, desc:`Get a single record` },
            { method:'PATCH',  color:'#F59E0B', path:`/tables/${t.id}/records/:id`, desc:`Update a record` },
            { method:'DELETE', color:'#EF4444', path:`/tables/${t.id}/records/:id`, desc:`Delete a record` },
          ]).slice(0,15).map(ep=>`
            <div class="api-ep">
              <span class="ep-method" style="background:${ep.color}">${ep.method}</span>
              <code class="ep-path">${esc(ep.path)}</code>
              <span class="ep-desc">${esc(ep.desc)}</span>
            </div>
          `).join('')}
        </div>
        <div class="api-example">
          <h3>Example Request</h3>
          <pre class="code-block">curl -X GET \\
  "${esc(baseUrl)}/tables/${tables[0]?.id||'tbl_xxx'}/records" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json"</pre>
          <h3>Example Response</h3>
          <pre class="code-block">{
  "data": [{ "_id": 1, "field_name": "value", ... }],
  "total": 42,
  "page": 0,
  "pageSize": 100
}</pre>
        </div>
        <div class="api-sdks">
          <h3>SDK Examples</h3>
          <div class="sdk-tabs">
            <button class="sdk-tab active" data-sdk="js">JavaScript</button>
            <button class="sdk-tab" data-sdk="python">Python</button>
            <button class="sdk-tab" data-sdk="curl">cURL</button>
          </div>
          <pre class="code-block" id="sdk-example">${sdkExamples('js', baseUrl, tables[0]?.id||'tbl_xxx')}</pre>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-secondary" id="close-api">Close</button>
      </div>
    `, 'modal-xl');

    document.getElementById('close-api').onclick=()=>this.closeModal();
    document.getElementById('gen-api-key').onclick=async()=>{
      const key=await this.db.createApiKey('Default Key');
      document.getElementById('api-key-result').innerHTML=`<div class="api-key-display"><code>${esc(key.secret)}</code><button class="btn-sm" onclick="navigator.clipboard.writeText('${esc(key.secret)}').then(()=>app.toast('Copied!'))">Copy</button></div><p class="modal-hint">⚠️ Copy now — you won't see this again</p>`;
    };
    document.querySelectorAll('.sdk-tab').forEach(tab=>{
      tab.onclick=()=>{
        document.querySelectorAll('.sdk-tab').forEach(t=>t.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('sdk-example').textContent=sdkExamples(tab.dataset.sdk, baseUrl, tables[0]?.id||'tbl_xxx');
      };
    });
  }

  /* ══════════════════════════════
     AUDIT LOG
  ══════════════════════════════ */
  async showAuditLog(tableId) {
    const logs = await this.db.getAuditLog(tableId||this.state.tableId||'');
    this.showModal('Audit Log', `
      <p class="modal-hint">Last 200 changes across all tables</p>
      <div class="audit-list">
        ${logs.length ? logs.map(l=>`
          <div class="audit-entry">
            <span class="audit-action audit-${l.action.toLowerCase()}">${l.action}</span>
            <span class="audit-table">${l.tableId?.slice(0,12)}…</span>
            <span class="audit-row">row #${l.rowId}</span>
            <span class="audit-ts">${fmtDate(l.ts, true)}</span>
          </div>
        `).join('') : '<p class="empty-state">No audit entries yet</p>'}
      </div>
      <div class="modal-footer"><button class="btn-secondary" id="close-audit">Close</button></div>
    `);
    document.getElementById('close-audit').onclick=()=>this.closeModal();
  }

  /* ══════════════════════════════
     SHARE MODAL
  ══════════════════════════════ */
  showShareModal() {
    const url = window.location.href;
    this.showModal('Share & Publish', `
      <div class="share-options">
        <div class="share-opt">
          <div class="so-title">🔗 Share Link</div>
          <div class="so-desc">Anyone with the link can view this table</div>
          <div class="share-link-row">
            <input class="modal-input" value="${esc(url)}" readonly id="share-url" />
            <button class="btn-sm" id="copy-share-url">Copy</button>
          </div>
        </div>
        <div class="share-opt">
          <div class="so-title">🌐 Publish as API</div>
          <div class="so-desc">Make this table accessible via REST API</div>
          <label class="toggle-row"><input type="checkbox" id="api-publish" /> Enable public API access</label>
        </div>
        <div class="share-opt">
          <div class="so-title">📝 Embed Form</div>
          <div class="so-desc">Embed a data entry form on any website</div>
          <button class="btn-secondary" id="get-embed-code">Get embed code</button>
        </div>
        <div class="share-opt">
          <div class="so-title">👥 Invite Collaborators</div>
          <div class="so-desc">Invite team members to view or edit</div>
          <div class="share-link-row">
            <input class="modal-input" placeholder="email@example.com" id="invite-email" />
            <select class="modal-input-sm"><option>Viewer</option><option>Editor</option><option>Admin</option></select>
            <button class="btn-sm" id="send-invite">Invite</button>
          </div>
        </div>
      </div>
      <div class="modal-footer"><button class="btn-secondary" id="close-share">Close</button></div>
    `);
    document.getElementById('close-share').onclick=()=>this.closeModal();
    document.getElementById('copy-share-url').onclick=()=>{ navigator.clipboard.writeText(url); this.toast('Link copied!'); };
    document.getElementById('get-embed-code').onclick=()=>{ this.toast('Embed code: <iframe src="'+url+'?embed=true" />','info'); };
    document.getElementById('send-invite').onclick=()=>{ const e=document.getElementById('invite-email').value; if(e) { this.toast(`Invite sent to ${e} (requires backend)`,'info'); } };
  }

  /* ══════════════════════════════
     MODAL SYSTEM
  ══════════════════════════════ */
  showModal(title, body, extraClass='') {
    const overlay = document.getElementById('modal-overlay');
    overlay.classList.remove('hidden');
    overlay.innerHTML = `
      <div class="modal ${extraClass}">
        <div class="modal-header">
          <h2 class="modal-title">${title}</h2>
          <button class="btn-icon" id="modal-close-btn">✕</button>
        </div>
        <div class="modal-body">${body}</div>
      </div>
    `;
    document.getElementById('modal-close-btn').onclick = () => this.closeModal();
    overlay.onclick = e => { if (e.target === overlay) this.closeModal(); };
  }

  closeModal() {
    document.getElementById('modal-overlay').classList.add('hidden');
    document.getElementById('modal-overlay').innerHTML = '';
  }

  /* ── Toast ── */
  toast(msg, type='success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => toast.classList.add('toast-show'), 10);
    setTimeout(() => { toast.classList.remove('toast-show'); setTimeout(()=>toast.remove(), 300); }, 3500);
  }
}

/* ── Helpers ── */
function esc(s) { return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmtDate(iso, withTime=false) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return withTime ? d.toLocaleString() : d.toLocaleDateString();
  } catch { return iso; }
}
function fmtCurrency(v, currency='USD') {
  try { return new Intl.NumberFormat('en-US',{style:'currency',currency:currency||'USD'}).format(v); }
  catch { return currency + ' ' + Number(v).toFixed(2); }
}
function fmtNum(n) { return Number(n).toLocaleString(undefined,{maximumFractionDigits:2}); }
function colTypeIcon(type) {
  const icons = { text:'T', number:'#', currency:'$', percent:'%', date:'📅', datetime:'🕐', boolean:'✓',
    select:'⊙', multiselect:'⊞', email:'@', url:'🔗', phone:'📞', rating:'★', formula:'ƒ',
    autonumber:'#', created_at:'🕐', updated_at:'🔄', lookup:'↗', link:'🔗', json:'{}', attachment:'📎' };
  return `<span class="type-icon">${icons[type]||'?'}</span>`;
}
function viewIcon(type) {
  return {grid:'▦',kanban:'⬜',gallery:'⊞',chart:'📊',calendar:'📅',form:'📝'}[type]||'▦';
}
const TAG_COLORS = ['#DBEAFE','#D1FAE5','#FEF3C7','#FCE7F3','#EDE9FE','#CFFAFE','#FEE2E2','#FEF9C3'];
function tagColor(v, col) {
  const choices = col?.options?.choices || [];
  const idx = choices.indexOf(v);
  return TAG_COLORS[idx >= 0 ? idx % TAG_COLORS.length : Math.abs(v.charCodeAt(0)) % TAG_COLORS.length];
}
function randCardColor(seed) {
  const colors = ['#EDE9FE','#D1FAE5','#DBEAFE','#FEF3C7','#FCE7F3','#CFFAFE','#FEE2E2'];
  return colors[seed % colors.length];
}
function sdkExamples(sdk, baseUrl, tableId) {
  if (sdk==='js') return `import { CloudDB } from 'clouddb-sdk';

const db = new CloudDB('${baseUrl}', 'YOUR_API_KEY');

// List records
const { data } = await db.table('${tableId}').list({ limit: 50 });

// Create record
await db.table('${tableId}').create({ name: 'New Record', status: 'Active' });

// Update record
await db.table('${tableId}').update(1, { status: 'Completed' });

// Query with filters
const results = await db.table('${tableId}')
  .filter('status', 'eq', 'Active')
  .sort('name', 'asc')
  .list();`;
  if (sdk==='python') return `from clouddb import CloudDB

db = CloudDB('${baseUrl}', api_key='YOUR_API_KEY')

# List records
records = db.table('${tableId}').list(limit=50)

# Create record
db.table('${tableId}').create({'name': 'New Record', 'status': 'Active'})

# Query with filters
results = db.table('${tableId}').filter(
    field='status', op='eq', value='Active'
).sort('name').list()`;
  return `# List records
curl -X GET "${baseUrl}/tables/${tableId}/records?limit=50" \\
  -H "Authorization: Bearer YOUR_API_KEY"

# Create record
curl -X POST "${baseUrl}/tables/${tableId}/records" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"New Record","status":"Active"}'

# Update record
curl -X PATCH "${baseUrl}/tables/${tableId}/records/1" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{"status":"Completed"}'`;
}

/* ── Bootstrap ── */
window.addEventListener('DOMContentLoaded', async () => {
  window.app = new CloudApp();
  await app.init();
});
