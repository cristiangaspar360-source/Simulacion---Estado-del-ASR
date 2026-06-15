/* CloudDB Engine v1.0 — IndexedDB-powered cloud database engine */
'use strict';

const COL_TYPES = {
  TEXT:'text', NUMBER:'number', DATE:'date', DATETIME:'datetime',
  BOOLEAN:'boolean', SELECT:'select', MULTISELECT:'multiselect',
  EMAIL:'email', URL:'url', PHONE:'phone', CURRENCY:'currency',
  PERCENT:'percent', RATING:'rating', FORMULA:'formula',
  LOOKUP:'lookup', LINK:'link', ATTACHMENT:'attachment',
  JSON_TYPE:'json', AUTONUMBER:'autonumber',
  CREATED_AT:'created_at', UPDATED_AT:'updated_at'
};

class DatabaseEngine {
  constructor() {
    this.db = null;
    this.dbName = 'CloudDB_v1';
    this.version = 1;
    this.tables = new Map();
    this.listeners = new Map();
    this._autoNums = {};
  }

  async init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, this.version);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => { this.db = req.result; this._loadTables().then(resolve).catch(reject); };
      req.onupgradeneeded = e => this._setupStores(e.target.result);
    });
  }

  _setupStores(db) {
    const createStore = (name, opts, indexes=[]) => {
      if (!db.objectStoreNames.contains(name)) {
        const s = db.createObjectStore(name, opts);
        indexes.forEach(([k, unique]) => s.createIndex(k, k, { unique: !!unique }));
        return s;
      }
    };
    createStore('_meta', { keyPath:'id' }, [['name', true]]);
    createStore('_views', { keyPath:'id' }, [['tableId', false]]);
    createStore('_automations', { keyPath:'id' }, [['tableId', false]]);
    createStore('_apikeys', { keyPath:'id' });
    createStore('_audit', { keyPath:'id', autoIncrement:true }, [['tableId', false], ['ts', false]]);
    createStore('_webhooks', { keyPath:'id' });
    createStore('_integrations', { keyPath:'id' });
    createStore('_comments', { keyPath:'id', autoIncrement:true }, [['rowKey', false]]);
  }

  async _loadTables() {
    const schemas = await this._getAll('_meta');
    this.tables = new Map(schemas.map(s => [s.id, s]));
    for (const s of schemas) {
      const rows = await this._getAll(s.id).catch(() => []);
      const nums = rows.map(r => r._rownum || 0);
      this._autoNums[s.id] = nums.length ? Math.max(...nums) : 0;
    }
  }

  /* ── Table CRUD ── */

  async createTable(name, columns = []) {
    if ([...this.tables.values()].find(t => t.name === name))
      throw new Error(`Table "${name}" already exists`);

    const id = 'tbl_' + uid();
    const schema = {
      id, name,
      columns: [
        { id:'col_rn', name:'#', type:COL_TYPES.AUTONUMBER, width:56, frozen:true, system:true },
        ...columns.map(c => ({ id:'col_'+uid(), width:160, ...c })),
        { id:'col_ca', name:'Created At', type:COL_TYPES.CREATED_AT, width:160, system:true },
        { id:'col_ua', name:'Updated At', type:COL_TYPES.UPDATED_AT, width:160, system:true }
      ],
      color: randColor(),
      icon: '📋',
      rowCount: 0,
      createdAt: now(), updatedAt: now()
    };

    await this._ensureTableStore(id);
    await this._put('_meta', schema);
    this.tables.set(id, schema);
    this._autoNums[id] = 0;

    // Default Grid view
    await this.createView(id, { name:'Grid View', type:'grid', config:{} });

    this._emit('tableCreated', schema);
    return schema;
  }

  async _ensureTableStore(tableId) {
    if (this.db.objectStoreNames.contains(tableId)) return;
    return new Promise((resolve, reject) => {
      const ver = this.db.version + 1;
      this.db.close();
      const req = indexedDB.open(this.dbName, ver);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(tableId)) {
          const s = db.createObjectStore(tableId, { keyPath:'_id', autoIncrement:true });
          s.createIndex('_rownum', '_rownum');
          s.createIndex('_created', '_created');
        }
      };
      req.onsuccess = () => { this.db = req.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  }

  async getTables() { return [...this.tables.values()]; }
  async getTable(id) { return this.tables.get(id); }

  async renameTable(id, name) {
    return this.updateTableMeta(id, { name });
  }

  async updateTableMeta(id, patch) {
    const s = this._req(id);
    const updated = { ...s, ...patch, updatedAt: now() };
    await this._put('_meta', updated);
    this.tables.set(id, updated);
    this._emit('tableUpdated', updated);
    return updated;
  }

  async deleteTable(id) {
    this.tables.delete(id);
    await this._delete('_meta', id);
    // remove views, rows kept in IDB store (just orphaned - no version bump needed)
    this._emit('tableDeleted', { id });
  }

  /* ── Column CRUD ── */

  async addColumn(tableId, col) {
    const s = this._req(tableId);
    const newCol = { id:'col_'+uid(), width:160, ...col };
    s.columns.push(newCol);
    s.updatedAt = now();
    await this._put('_meta', s);
    this._emit('columnAdded', { tableId, column: newCol });
    return newCol;
  }

  async updateColumn(tableId, colId, patch) {
    const s = this._req(tableId);
    const idx = s.columns.findIndex(c => c.id === colId);
    if (idx < 0) throw new Error('Column not found');
    s.columns[idx] = { ...s.columns[idx], ...patch };
    s.updatedAt = now();
    await this._put('_meta', s);
    this._emit('columnUpdated', { tableId, column: s.columns[idx] });
    return s.columns[idx];
  }

  async deleteColumn(tableId, colId) {
    const s = this._req(tableId);
    s.columns = s.columns.filter(c => c.id !== colId);
    s.updatedAt = now();
    await this._put('_meta', s);
    this._emit('columnDeleted', { tableId, colId });
  }

  /* ── Row CRUD ── */

  async insertRow(tableId, data = {}) {
    const s = this._req(tableId);
    this._autoNums[tableId] = (this._autoNums[tableId] || 0) + 1;
    const ts = now();
    const row = { ...data, _rownum: this._autoNums[tableId], _created: ts, _updated: ts };
    const id = await this._add(tableId, row);
    const inserted = { ...row, _id: id };
    s.rowCount = (s.rowCount || 0) + 1;
    s.updatedAt = ts;
    await this._put('_meta', s);
    await this._audit(tableId, 'INSERT', id, null, inserted);
    this._emit('rowInserted', { tableId, row: inserted });
    return inserted;
  }

  async updateRow(tableId, rowId, data) {
    const existing = await this._get(tableId, rowId);
    if (!existing) throw new Error('Row not found');
    const updated = { ...existing, ...data, _id: rowId,
      _created: existing._created, _updated: now() };
    await this._put(tableId, updated);
    await this._audit(tableId, 'UPDATE', rowId, existing, updated);
    this._emit('rowUpdated', { tableId, row: updated });
    return updated;
  }

  async deleteRow(tableId, rowId) {
    const existing = await this._get(tableId, rowId);
    await this._delete(tableId, rowId);
    const s = this._req(tableId);
    s.rowCount = Math.max(0, (s.rowCount||0) - 1);
    await this._put('_meta', s);
    await this._audit(tableId, 'DELETE', rowId, existing, null);
    this._emit('rowDeleted', { tableId, rowId });
  }

  async getRow(tableId, rowId) { return this._get(tableId, rowId); }

  async bulkInsert(tableId, rows) {
    const results = [];
    for (const r of rows) results.push(await this.insertRow(tableId, r));
    return results;
  }

  async bulkDelete(tableId, ids) {
    for (const id of ids) await this.deleteRow(tableId, id);
  }

  /* ── Query ── */

  async query(tableId, { filter, sort, search, limit, offset } = {}) {
    let rows = await this._getAll(tableId);

    if (search?.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(r => Object.values(r).some(v => v != null && String(v).toLowerCase().includes(q)));
    }

    if (filter?.conditions?.length) rows = rows.filter(r => this._matchFilter(r, filter));

    if (sort?.length) rows = this._sortRows(rows, sort);

    const total = rows.length;
    if (offset) rows = rows.slice(offset);
    if (limit)  rows = rows.slice(0, limit);
    return { rows, total };
  }

  _matchFilter(row, { operator='AND', conditions }) {
    const results = conditions.map(c => c.conditions ? this._matchFilter(row, c) : this._cond(row, c));
    return operator === 'AND' ? results.every(Boolean) : results.some(Boolean);
  }

  _cond(row, { field, op, value }) {
    const v = row[field]; const sv = String(v ?? '').toLowerCase(); const qv = String(value ?? '').toLowerCase();
    switch (op) {
      case 'eq':           return sv === qv;
      case 'neq':          return sv !== qv;
      case 'contains':     return sv.includes(qv);
      case 'not_contains': return !sv.includes(qv);
      case 'starts_with':  return sv.startsWith(qv);
      case 'ends_with':    return sv.endsWith(qv);
      case 'gt':           return Number(v) > Number(value);
      case 'gte':          return Number(v) >= Number(value);
      case 'lt':           return Number(v) < Number(value);
      case 'lte':          return Number(v) <= Number(value);
      case 'is_empty':     return v == null || v === '';
      case 'is_not_empty': return v != null && v !== '';
      case 'is_true':      return Boolean(v);
      case 'is_false':     return !Boolean(v);
      default: return true;
    }
  }

  _sortRows(rows, sort) {
    return [...rows].sort((a, b) => {
      for (const { field, dir='asc' } of sort) {
        const av = a[field], bv = b[field];
        let cmp = 0;
        if (av == null) cmp = 1;
        else if (bv == null) cmp = -1;
        else if (typeof av === 'number') cmp = av - bv;
        else cmp = String(av).localeCompare(String(bv));
        if (cmp !== 0) return dir === 'desc' ? -cmp : cmp;
      }
      return 0;
    });
  }

  /* ── Stats ── */

  async getStats(tableId) {
    const s = this._req(tableId);
    const rows = await this._getAll(tableId);
    const stats = { total: rows.length, columns: s.columns.length, table: s.name };
    for (const col of s.columns) {
      if (['number','currency','percent','rating'].includes(col.type)) {
        const vals = rows.map(r => Number(r[col.id])).filter(v => !isNaN(v) && v !== 0 || v === 0);
        if (vals.length) {
          const sum = vals.reduce((a,b) => a+b, 0);
          stats[col.id] = { sum, avg: sum/vals.length, min: Math.min(...vals), max: Math.max(...vals), count: vals.length };
        }
      }
    }
    return stats;
  }

  /* ── Views ── */

  async createView(tableId, { name, type='grid', config={} }) {
    const view = { id:'view_'+uid(), tableId, name, type, config, createdAt: now() };
    await this._put('_views', view);
    return view;
  }

  async getViews(tableId) {
    const all = await this._getAll('_views');
    return all.filter(v => v.tableId === tableId);
  }

  async updateView(viewId, patch) {
    const all = await this._getAll('_views');
    const v = all.find(x => x.id === viewId);
    if (!v) throw new Error('View not found');
    const updated = { ...v, ...patch };
    await this._put('_views', updated);
    return updated;
  }

  async deleteView(viewId) { await this._delete('_views', viewId); }

  /* ── Audit log ── */

  async _audit(tableId, action, rowId, before, after) {
    await this._add('_audit', { tableId, action, rowId, before, after, ts: now() });
  }

  async getAuditLog(tableId, limit=200) {
    const all = await this._getAll('_audit');
    return all.filter(a => a.tableId === tableId)
              .sort((a,b) => b.ts.localeCompare(a.ts))
              .slice(0, limit);
  }

  /* ── Comments ── */

  async addComment(tableId, rowId, text) {
    return this._add('_comments', { tableId, rowId, rowKey: tableId+'_'+rowId, text, ts: now() });
  }

  async getComments(tableId, rowId) {
    const all = await this._getAll('_comments');
    return all.filter(c => c.tableId === tableId && c.rowId === rowId).sort((a,b) => a.ts.localeCompare(b.ts));
  }

  /* ── Webhooks / Integrations ── */

  async saveWebhook(cfg) {
    const wh = { id: cfg.id || 'wh_'+uid(), ...cfg, createdAt: now() };
    await this._put('_webhooks', wh);
    return wh;
  }
  async getWebhooks() { return this._getAll('_webhooks'); }
  async deleteWebhook(id) { await this._delete('_webhooks', id); }

  async saveIntegration(cfg) {
    const ig = { id: cfg.id || 'ig_'+uid(), ...cfg, createdAt: now() };
    await this._put('_integrations', ig);
    return ig;
  }
  async getIntegrations() { return this._getAll('_integrations'); }
  async deleteIntegration(id) { await this._delete('_integrations', id); }

  /* ── API Keys ── */

  async createApiKey(label) {
    const key = { id:'key_'+uid(), label, secret: 'sk_'+uid(32), createdAt: now(), active: true };
    await this._put('_apikeys', key);
    return key;
  }
  async getApiKeys() { return this._getAll('_apikeys'); }
  async revokeApiKey(id) {
    const all = await this._getAll('_apikeys');
    const k = all.find(x => x.id === id);
    if (k) { k.active = false; await this._put('_apikeys', k); }
  }

  /* ── Automations ── */

  async saveAutomation(cfg) {
    const auto = { id: cfg.id || 'auto_'+uid(), ...cfg, createdAt: now() };
    await this._put('_automations', auto);
    return auto;
  }
  async getAutomations(tableId) {
    const all = await this._getAll('_automations');
    return tableId ? all.filter(a => a.tableId === tableId) : all;
  }
  async deleteAutomation(id) { await this._delete('_automations', id); }

  /* ── Export ── */

  async exportCSV(tableId) {
    const s = this._req(tableId);
    const { rows } = await this.query(tableId);
    const cols = s.columns.filter(c => !c.system || c.type === COL_TYPES.AUTONUMBER);
    const header = cols.map(c => csvEsc(c.name)).join(',');
    const body = rows.map(r => cols.map(c => csvEsc(r[c.id] ?? '')).join(',')).join('\n');
    return header + '\n' + body;
  }

  async exportJSON(tableId) {
    const s = this._req(tableId);
    const { rows } = await this.query(tableId);
    return JSON.stringify({
      meta: { table: s.name, exportedAt: now(), rows: rows.length },
      schema: s.columns.map(c => ({ name:c.name, type:c.type })),
      data: rows.map(r => {
        const obj = {};
        s.columns.forEach(c => { obj[c.name] = r[c.id] ?? null; });
        return obj;
      })
    }, null, 2);
  }

  /* ── Import ── */

  async importCSV(tableId, csvText) {
    const lines = csvText.trim().split(/\r?\n/);
    if (lines.length < 2) return [];
    const s = this._req(tableId);
    const headers = parseCSVLine(lines[0]);
    const colMap = {};
    headers.forEach(h => {
      const col = s.columns.find(c => c.name.toLowerCase() === h.toLowerCase());
      if (col) colMap[h] = col.id;
    });
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const vals = parseCSVLine(lines[i]);
      const row = {};
      headers.forEach((h, idx) => { if (colMap[h]) row[colMap[h]] = vals[idx] ?? ''; });
      rows.push(row);
    }
    return this.bulkInsert(tableId, rows);
  }

  async importJSON(tableId, jsonText) {
    const data = JSON.parse(jsonText);
    const rows = Array.isArray(data) ? data : data.data || [];
    const s = this._req(tableId);
    const mapped = rows.map(r => {
      const row = {};
      s.columns.forEach(c => { if (r[c.name] !== undefined) row[c.id] = r[c.name]; });
      return row;
    });
    return this.bulkInsert(tableId, mapped);
  }

  /* ── Seed demo data ── */

  async seedDemo() {
    const existing = await this.getTables();
    if (existing.length) return; // already seeded

    // Table 1: Projects
    const projects = await this.createTable('Projects', [
      { name:'Project Name', type:'text' },
      { name:'Status', type:'select', options:{ choices:['Planning','Active','On Hold','Completed','Cancelled'] } },
      { name:'Priority', type:'select', options:{ choices:['Low','Medium','High','Critical'] } },
      { name:'Budget', type:'currency', options:{ currency:'USD' } },
      { name:'Progress', type:'percent' },
      { name:'Start Date', type:'date' },
      { name:'Due Date', type:'date' },
      { name:'Owner', type:'text' },
      { name:'Tags', type:'multiselect', options:{ choices:['Frontend','Backend','Mobile','Data','DevOps','Design'] } },
      { name:'Notes', type:'text' }
    ]);

    const pData = [
      { 'Project Name':'Platform Redesign','Status':'Active','Priority':'High','Budget':45000,'Progress':67,'Start Date':'2026-01-15','Due Date':'2026-07-30','Owner':'Ana García','Tags':'Frontend,Backend','Notes':'Full UI/UX platform overhaul' },
      { 'Project Name':'Cloud DB Integration','Status':'Active','Priority':'Critical','Budget':120000,'Progress':35,'Start Date':'2026-03-01','Due Date':'2026-12-31','Owner':'Carlos López','Tags':'Backend,Data','Notes':'Main database migration project' },
      { 'Project Name':'Mobile App v2.0','Status':'Planning','Priority':'Medium','Budget':85000,'Progress':10,'Start Date':'2026-06-01','Due Date':'2026-11-30','Owner':'María Torres','Tags':'Mobile','Notes':'New mobile experience' },
      { 'Project Name':'API Gateway','Status':'Active','Priority':'High','Budget':55000,'Progress':48,'Start Date':'2026-02-14','Due Date':'2026-08-15','Owner':'Luis Martínez','Tags':'Backend,DevOps','Notes':'Unified API layer' },
      { 'Project Name':'UX Redesign','Status':'Completed','Priority':'Medium','Budget':30000,'Progress':100,'Start Date':'2025-10-01','Due Date':'2026-02-28','Owner':'Sofia Ruiz','Tags':'Frontend,Design','Notes':'Completed ahead of schedule' },
      { 'Project Name':'Data Warehouse','Status':'On Hold','Priority':'Low','Budget':200000,'Progress':20,'Start Date':'2026-04-01','Due Date':'2027-03-31','Owner':'Roberto Silva','Tags':'Data','Notes':'Pending budget approval' },
      { 'Project Name':'Security Audit','Status':'Active','Priority':'Critical','Budget':25000,'Progress':80,'Start Date':'2026-05-01','Due Date':'2026-06-30','Owner':'Elena Vega','Tags':'DevOps','Notes':'Annual compliance audit' },
      { 'Project Name':'Inventory Module','Status':'Planning','Priority':'High','Budget':70000,'Progress':5,'Start Date':'2026-07-01','Due Date':'2026-12-01','Owner':'Diego Morales','Tags':'Backend,Frontend','Notes':'Full inventory management rewrite' }
    ];

    for (const d of pData) {
      const row = {};
      projects.columns.forEach(c => { if (d[c.name] !== undefined) row[c.id] = d[c.name]; });
      await this.insertRow(projects.id, row);
    }

    // Table 2: Inventory
    const inventory = await this.createTable('Inventory', [
      { name:'SKU', type:'text' },
      { name:'Product Name', type:'text' },
      { name:'Category', type:'select', options:{ choices:['Electronics','Mechanical','Raw Material','Consumable','Tool'] } },
      { name:'Quantity', type:'number' },
      { name:'Unit Cost', type:'currency', options:{ currency:'USD' } },
      { name:'Total Value', type:'formula', options:{ formula:'=Quantity * Unit Cost' } },
      { name:'Location', type:'text' },
      { name:'Supplier', type:'text' },
      { name:'Reorder Level', type:'number' },
      { name:'Last Restocked', type:'date' },
      { name:'Active', type:'boolean' }
    ]);

    const iData = [
      { SKU:'E-001', 'Product Name':'Servo Motor 24V', Category:'Electronics', Quantity:145, 'Unit Cost':89.99, Location:'Rack A-01', Supplier:'MotorTech SA', 'Reorder Level':20, 'Last Restocked':'2026-05-10', Active:true },
      { SKU:'E-002', 'Product Name':'PLC Controller S7', Category:'Electronics', Quantity:23, 'Unit Cost':1250, Location:'Rack A-02', Supplier:'Siemens MX', 'Reorder Level':5, 'Last Restocked':'2026-04-20', Active:true },
      { SKU:'M-001', 'Product Name':'Steel Bracket 200mm', Category:'Mechanical', Quantity:890, 'Unit Cost':4.50, Location:'Rack B-01', Supplier:'MetalCorp', 'Reorder Level':100, 'Last Restocked':'2026-06-01', Active:true },
      { SKU:'M-002', 'Product Name':'Pneumatic Cylinder', Category:'Mechanical', Quantity:67, 'Unit Cost':145, Location:'Rack B-03', Supplier:'AirTech', 'Reorder Level':15, 'Last Restocked':'2026-05-25', Active:true },
      { SKU:'R-001', 'Product Name':'Aluminum Sheet 1m', Category:'Raw Material', Quantity:234, 'Unit Cost':32, Location:'Rack C-01', Supplier:'AluminCo', 'Reorder Level':50, 'Last Restocked':'2026-05-30', Active:true },
      { SKU:'C-001', 'Product Name':'Lubricant Oil 5L', Category:'Consumable', Quantity:12, 'Unit Cost':22.50, Location:'Shelf D-01', Supplier:'LubriMax', 'Reorder Level':10, 'Last Restocked':'2026-03-15', Active:true },
      { SKU:'T-001', 'Product Name':'Torque Wrench Set', Category:'Tool', Quantity:8, 'Unit Cost':189, Location:'Cabinet E-01', Supplier:'ToolPro', 'Reorder Level':2, 'Last Restocked':'2026-01-10', Active:true },
      { SKU:'E-003', 'Product Name':'Frequency Inverter', Category:'Electronics', Quantity:34, 'Unit Cost':680, Location:'Rack A-05', Supplier:'ABB Direct', 'Reorder Level':8, 'Last Restocked':'2026-04-05', Active:true }
    ];

    for (const d of iData) {
      const row = {};
      inventory.columns.forEach(c => { if (d[c.name] !== undefined) row[c.id] = d[c.name]; });
      await this.insertRow(inventory.id, row);
    }

    // Table 3: Support Tickets
    const tickets = await this.createTable('Support Tickets', [
      { name:'Title', type:'text' },
      { name:'Type', type:'select', options:{ choices:['Bug','Feature Request','Question','Incident','Improvement'] } },
      { name:'Priority', type:'select', options:{ choices:['Low','Medium','High','Critical'] } },
      { name:'Status', type:'select', options:{ choices:['Open','In Progress','Resolved','Closed','Pending'] } },
      { name:'Assigned To', type:'text' },
      { name:'Reporter', type:'email' },
      { name:'Due Date', type:'date' },
      { name:'Resolution Time (h)', type:'number' },
      { name:'Notes', type:'text' }
    ]);

    const tData = [
      { Title:'Login page throws 500 on mobile Safari', Type:'Bug', Priority:'Critical', Status:'In Progress', 'Assigned To':'Luis M.', Reporter:'client@example.com', 'Due Date':'2026-06-20', 'Resolution Time (h)':0 },
      { Title:'Add dark mode toggle', Type:'Feature Request', Priority:'Medium', Status:'Open', 'Assigned To':'Sofia R.', Reporter:'user1@example.com', 'Due Date':'2026-07-01', 'Resolution Time (h)':0 },
      { Title:'CSV export missing last column', Type:'Bug', Priority:'High', Status:'Resolved', 'Assigned To':'Carlos L.', Reporter:'ops@example.com', 'Due Date':'2026-06-15', 'Resolution Time (h)':3 },
      { Title:'API rate limit too low for enterprise', Type:'Improvement', Priority:'High', Status:'Open', 'Assigned To':'Ana G.', Reporter:'enterprise@example.com', 'Due Date':'2026-06-30', 'Resolution Time (h)':0 },
      { Title:'How to configure OAuth2?', Type:'Question', Priority:'Low', Status:'Resolved', 'Assigned To':'María T.', Reporter:'dev@example.com', 'Due Date':'2026-06-16', 'Resolution Time (h)':1 },
      { Title:'Dashboard crashes on large datasets', Type:'Bug', Priority:'Critical', Status:'In Progress', 'Assigned To':'Roberto S.', Reporter:'admin@example.com', 'Due Date':'2026-06-18', 'Resolution Time (h)':0 },
      { Title:'Bulk delete confirmation dialog', Type:'Feature Request', Priority:'Medium', Status:'Open', 'Assigned To':'Elena V.', Reporter:'pm@example.com', 'Due Date':'2026-07-15', 'Resolution Time (h)':0 },
      { Title:'Webhook retry logic on failure', Type:'Improvement', Priority:'High', Status:'Pending', 'Assigned To':'Diego M.', Reporter:'devops@example.com', 'Due Date':'2026-06-28', 'Resolution Time (h)':0 }
    ];

    for (const d of tData) {
      const row = {};
      tickets.columns.forEach(c => { if (d[c.name] !== undefined) row[c.id] = d[c.name]; });
      await this.insertRow(tickets.id, row);
    }

    // Extra views
    await this.createView(projects.id, { name:'Kanban by Status', type:'kanban', config:{ groupBy: projects.columns.find(c=>c.name==='Status')?.id } });
    await this.createView(projects.id, { name:'Gallery', type:'gallery', config:{} });
    await this.createView(projects.id, { name:'Analytics', type:'chart', config:{ chartType:'bar' } });
    await this.createView(inventory.id, { name:'Kanban by Category', type:'kanban', config:{ groupBy: inventory.columns.find(c=>c.name==='Category')?.id } });
    await this.createView(tickets.id, { name:'Kanban by Status', type:'kanban', config:{ groupBy: tickets.columns.find(c=>c.name==='Status')?.id } });
    await this.createView(tickets.id, { name:'Calendar', type:'calendar', config:{} });
  }

  /* ── IDB helpers ── */

  _req(tableId) {
    const s = this.tables.get(tableId);
    if (!s) throw new Error('Table not found: ' + tableId);
    return s;
  }

  _tx(store, mode='readonly') { return this.db.transaction(store, mode).objectStore(store); }

  _getAll(store) {
    return new Promise((res, rej) => {
      const r = this._tx(store).getAll();
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }

  _get(store, key) {
    return new Promise((res, rej) => {
      const r = this._tx(store).get(key);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }

  _put(store, val) {
    return new Promise((res, rej) => {
      const r = this._tx(store, 'readwrite').put(val);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }

  _add(store, val) {
    return new Promise((res, rej) => {
      const r = this._tx(store, 'readwrite').add(val);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }

  _delete(store, key) {
    return new Promise((res, rej) => {
      const r = this._tx(store, 'readwrite').delete(key);
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    });
  }

  /* ── Events ── */
  on(ev, cb) { (this.listeners.get(ev) || this.listeners.set(ev,[]).get(ev)).push(cb); }
  off(ev, cb) { if (this.listeners.has(ev)) this.listeners.set(ev, this.listeners.get(ev).filter(f => f!==cb)); }
  _emit(ev, data) { (this.listeners.get(ev)||[]).forEach(cb => cb(data)); }
}

/* ── Utilities ── */

function uid(len=16) {
  const arr = new Uint8Array(len); crypto.getRandomValues(arr);
  return [...arr].map(b => b.toString(36).padStart(2,'0')).join('').slice(0,len);
}
function now() { return new Date().toISOString(); }
function randColor() {
  return ['#3B82F6','#10B981','#F59E0B','#EF4444','#8B5CF6','#EC4899','#06B6D4','#84CC16','#F97316','#6366F1'][Math.floor(Math.random()*10)];
}
function csvEsc(v) {
  const s = String(v ?? '');
  return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s.replace(/"/g,'""')}"` : s;
}
function parseCSVLine(line) {
  const res=[]; let cur='', inQ=false;
  for (let i=0; i<line.length; i++) {
    if (line[i]==='"') { if (inQ && line[i+1]==='"') { cur+='"'; i++; } else inQ=!inQ; }
    else if (line[i]===',' && !inQ) { res.push(cur.trim()); cur=''; }
    else cur+=line[i];
  }
  res.push(cur.trim());
  return res;
}

window.DatabaseEngine = DatabaseEngine;
window.COL_TYPES = COL_TYPES;
