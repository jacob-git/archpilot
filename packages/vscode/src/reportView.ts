import * as vscode from 'vscode';
import crypto from 'node:crypto';

export type Tone = 'default' | 'ok' | 'warn' | 'error' | 'info';

export interface InspectorAction {
  id: string;
  label: string;
  primary?: boolean;
  payload?: string;
}

export interface InspectorMetric {
  label: string;
  value: string;
  tone?: Tone;
}

export interface InspectorRow {
  title: string;
  badge?: { text: string; tone: Tone };
  meta?: string;
  detail?: string;
  percent?: number;
  actions?: InspectorAction[];
}

export interface InspectorSection {
  title: string;
  subtitle?: string;
  rows: InspectorRow[];
}

export interface InspectorViewModel {
  viewId: string;
  tabTitle: string;
  heading: string;
  subheading?: string;
  metrics: InspectorMetric[];
  headerActions?: InspectorAction[];
  sections: InspectorSection[];
  emptyMessage?: string;
}

export type InspectorActionHandler = (
  actionId: string,
  payload?: string
) => Promise<InspectorViewModel | void> | InspectorViewModel | void;

interface TabSummary {
  viewId: string;
  tabTitle: string;
}

interface StoredTab {
  model: InspectorViewModel;
  handler: InspectorActionHandler;
}

const MAX_RECENT_TABS = 10;
let sharedPanel: vscode.WebviewPanel | undefined;
let activeViewId: string | undefined;
const recentTabs = new Map<string, StoredTab>();

export function inspectorModelToMarkdown(model: InspectorViewModel): string {
  const lines: string[] = [`# ${model.heading}`];
  if (model.subheading) {
    lines.push(`_${model.subheading}_`);
  }
  if (model.metrics.length > 0) {
    lines.push('');
    lines.push('| ' + model.metrics.map((m) => m.label).join(' | ') + ' |');
    lines.push('| ' + model.metrics.map(() => '---').join(' | ') + ' |');
    lines.push('| ' + model.metrics.map((m) => m.value).join(' | ') + ' |');
  }
  const nonEmptySections = model.sections.filter((s) => s.rows.length > 0);
  if (nonEmptySections.length === 0) {
    lines.push('', model.emptyMessage || 'No items to display.');
    return lines.join('\n');
  }
  for (const sec of nonEmptySections) {
    lines.push('', `## ${sec.title}${sec.subtitle ? ` — ${sec.subtitle}` : ''}`);
    for (const r of sec.rows) {
      const badge = r.badge ? `**[${r.badge.text}]** ` : '';
      const meta = r.meta ? ` (${r.meta})` : '';
      lines.push(`- ${badge}\`${r.title}\`${meta}${r.detail ? ` — ${r.detail}` : ''}`);
    }
  }
  return lines.join('\n');
}

function getTabSummaries(): TabSummary[] {
  return [...recentTabs.values()].map((t) => ({
    viewId: t.model.viewId,
    tabTitle: t.model.tabTitle,
  }));
}

function postState(panel: vscode.WebviewPanel, model: InspectorViewModel): void {
  panel.title = model.tabTitle;
  void panel.webview.postMessage({
    type: 'update',
    model,
    tabs: getTabSummaries(),
    activeViewId: model.viewId,
  });
}

function buildHtml(nonce: string, initialModel: InspectorViewModel, initialTabs: TabSummary[]): string {
  const safeJson = JSON.stringify({
    model: initialModel,
    tabs: initialTabs,
    activeViewId: initialModel.viewId,
  }).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 0 24px 36px;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    font-family: var(--vscode-font-family);
    font-size: 13px;
    line-height: 1.5;
  }
  .tab-bar {
    display: flex;
    align-items: center;
    gap: 4px;
    overflow-x: auto;
    padding: 10px 0 8px;
    margin-bottom: 12px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .tab-bar.hidden { display: none; }
  .tab-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    border: 1px solid transparent;
    background: transparent;
    color: var(--vscode-descriptionForeground);
  }
  .tab-pill:hover {
    background: var(--vscode-sideBar-background);
    color: var(--vscode-editor-foreground);
  }
  .tab-pill.active {
    background: var(--vscode-sideBar-background);
    border-color: var(--vscode-panel-border);
    color: var(--vscode-editor-foreground);
    font-weight: 600;
  }
  .tab-close {
    font-size: 13px;
    line-height: 1;
    opacity: 0.65;
    padding: 0 2px;
    border-radius: 3px;
  }
  .tab-close:hover { opacity: 1; background: rgba(128,128,128,0.25); }
  .header {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 0 16px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .heading { margin: 0; font-size: 18px; font-weight: 700; }
  .subheading { margin: 4px 0 0; color: var(--vscode-descriptionForeground); font-size: 12.5px; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
  button {
    cursor: pointer;
    border-radius: 5px;
    padding: 6px 12px;
    font-size: 12px;
    font-weight: 600;
    border: 1px solid var(--vscode-panel-border);
    background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.16));
    color: var(--vscode-button-secondaryForeground, var(--vscode-editor-foreground));
  }
  button:hover { opacity: 0.9; }
  button.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: transparent;
  }
  button.row-btn {
    padding: 3px 9px;
    font-size: 11.5px;
    font-weight: 500;
  }
  .metrics {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 10px;
    margin: 16px 0 16px;
  }
  .metric-card {
    background: var(--vscode-sideBar-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px;
    padding: 10px 14px;
  }
  .metric-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); }
  .metric-value { font-size: 18px; font-weight: 700; margin-top: 2px; }
  .tone-ok { color: #34d399; }
  .tone-warn { color: #fbbf24; }
  .tone-error { color: #f87171; }
  .tone-info { color: #38bdf8; }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin: 4px 0 16px;
  }
  .search-input {
    flex: 1;
    min-width: 200px;
    max-width: 420px;
    padding: 6px 10px;
    border-radius: 5px;
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    background: var(--vscode-input-background, var(--vscode-sideBar-background));
    color: var(--vscode-input-foreground, var(--vscode-editor-foreground));
    font-family: var(--vscode-font-family);
    font-size: 12.5px;
    outline: none;
  }
  .search-input:focus {
    border-color: var(--vscode-focusBorder, #38bdf8);
  }
  .filter-pills {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .pill {
    padding: 4px 10px;
    border-radius: 999px;
    font-size: 11.5px;
    font-weight: 600;
    background: transparent;
    border: 1px solid var(--vscode-panel-border);
    color: var(--vscode-descriptionForeground);
  }
  .pill.active {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: transparent;
  }
  .section { margin-top: 18px; }
  .section-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 8px; }
  .section-title { margin: 0; font-size: 14px; font-weight: 700; }
  .section-sub { font-size: 12px; color: var(--vscode-descriptionForeground); }
  .row-list {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px;
    overflow: hidden;
  }
  .row {
    padding: 10px 14px;
    background: var(--vscode-sideBar-background);
    border-bottom: 1px solid var(--vscode-panel-border);
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }
  .row:last-child { border-bottom: none; }
  .row-main { flex: 1; min-width: 0; }
  .row-top { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .row-title { font-weight: 600; word-break: break-word; font-family: var(--vscode-editor-font-family); font-size: 12.5px; }
  .row-meta { font-size: 12px; color: var(--vscode-descriptionForeground); }
  .row-detail { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 3px; word-break: break-word; }
  .badge {
    font-size: 10.5px;
    font-weight: 700;
    padding: 1px 7px;
    border-radius: 999px;
    border: 1px solid currentColor;
    text-transform: uppercase;
  }
  .bar-bg {
    height: 5px;
    border-radius: 3px;
    background: var(--vscode-panel-border);
    margin-top: 6px;
    overflow: hidden;
    max-width: 380px;
  }
  .bar-fill { height: 100%; background: #38bdf8; border-radius: 3px; }
  .row-actions { display: flex; flex-wrap: wrap; gap: 6px; flex-shrink: 0; }
  .empty {
    padding: 24px;
    text-align: center;
    border: 1px dashed var(--vscode-panel-border);
    border-radius: 8px;
    color: var(--vscode-descriptionForeground);
  }
</style>
</head>
<body>
<div id="tabs" class="tab-bar hidden"></div>
<div id="chrome"></div>
<div id="toolbar-slot"></div>
<div id="sections"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const init = ${safeJson};
  let currentModel = init.model;
  let currentTabs = init.tabs || [];
  let currentActiveViewId = init.activeViewId;
  let searchQuery = '';
  let activeTone = 'all';

  function toneClass(tone) {
    if (!tone || tone === 'default') return '';
    return 'tone-' + tone;
  }

  function makeBtn(action, isRow) {
    const btn = document.createElement('button');
    btn.textContent = action.label;
    if (action.primary) btn.classList.add('primary');
    if (isRow) btn.classList.add('row-btn');
    btn.addEventListener('click', () => {
      vscode.postMessage({ type: 'action', id: action.id, payload: action.payload });
    });
    return btn;
  }

  function renderTabs() {
    const bar = document.getElementById('tabs');
    bar.replaceChildren();
    if (!currentTabs || currentTabs.length <= 1) {
      bar.classList.add('hidden');
      return;
    }
    bar.classList.remove('hidden');
    for (const tab of currentTabs) {
      const pill = document.createElement('div');
      pill.className = 'tab-pill' + (tab.viewId === currentActiveViewId ? ' active' : '');
      const lbl = document.createElement('span');
      lbl.textContent = tab.tabTitle;
      pill.appendChild(lbl);

      const close = document.createElement('span');
      close.className = 'tab-close';
      close.textContent = '×';
      close.title = 'Close tab';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'closeTab', viewId: tab.viewId });
      });
      pill.appendChild(close);

      pill.addEventListener('click', () => {
        if (tab.viewId !== currentActiveViewId) {
          vscode.postMessage({ type: 'switchTab', viewId: tab.viewId });
        }
      });
      bar.appendChild(pill);
    }
  }

  function renderChrome() {
    const chrome = document.getElementById('chrome');
    chrome.replaceChildren();

    const header = document.createElement('div');
    header.className = 'header';
    const titleWrap = document.createElement('div');
    const h1 = document.createElement('h1');
    h1.className = 'heading';
    h1.textContent = currentModel.heading;
    titleWrap.appendChild(h1);
    if (currentModel.subheading) {
      const sub = document.createElement('p');
      sub.className = 'subheading';
      sub.textContent = currentModel.subheading;
      titleWrap.appendChild(sub);
    }
    header.appendChild(titleWrap);

    const actWrap = document.createElement('div');
    actWrap.className = 'actions';
    for (const a of (currentModel.headerActions || [])) {
      actWrap.appendChild(makeBtn(a, false));
    }
    const copyMdBtn = document.createElement('button');
    copyMdBtn.textContent = 'Copy Markdown';
    copyMdBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'copyMarkdown' });
      copyMdBtn.textContent = 'Copied!';
      setTimeout(() => { copyMdBtn.textContent = 'Copy Markdown'; }, 1400);
    });
    actWrap.appendChild(copyMdBtn);
    header.appendChild(actWrap);
    chrome.appendChild(header);

    if (currentModel.metrics && currentModel.metrics.length > 0) {
      const grid = document.createElement('div');
      grid.className = 'metrics';
      for (const m of currentModel.metrics) {
        const card = document.createElement('div');
        card.className = 'metric-card';
        const lbl = document.createElement('div');
        lbl.className = 'metric-label';
        lbl.textContent = m.label;
        const val = document.createElement('div');
        val.className = 'metric-value ' + toneClass(m.tone);
        val.textContent = m.value;
        card.appendChild(lbl);
        card.appendChild(val);
        grid.appendChild(card);
      }
      chrome.appendChild(grid);
    }
  }

  function countTones() {
    const counts = { all: 0, error: 0, warn: 0, info: 0, ok: 0 };
    for (const sec of (currentModel.sections || [])) {
      for (const r of (sec.rows || [])) {
        counts.all += 1;
        const tone = r.badge && r.badge.tone ? r.badge.tone : 'default';
        if (tone in counts) counts[tone] += 1;
      }
    }
    return counts;
  }

  function renderToolbar() {
    const slot = document.getElementById('toolbar-slot');
    slot.replaceChildren();
    const counts = countTones();
    if (counts.all === 0) return;

    const bar = document.createElement('div');
    bar.className = 'toolbar';

    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'search-input';
    input.placeholder = 'Filter by file, package, badge, or detail...';
    input.value = searchQuery;
    input.addEventListener('input', (e) => {
      searchQuery = e.target.value;
      renderSections();
    });
    bar.appendChild(input);

    const pills = document.createElement('div');
    pills.className = 'filter-pills';
    const defs = [
      { id: 'all', label: 'All' },
      { id: 'error', label: 'Error' },
      { id: 'warn', label: 'Warning' },
      { id: 'info', label: 'Info' },
      { id: 'ok', label: 'OK' },
    ];
    const presentTones = defs.filter((d) => d.id === 'all' || counts[d.id] > 0);
    if (presentTones.length > 2) {
      for (const d of presentTones) {
        const p = document.createElement('button');
        p.className = 'pill' + (activeTone === d.id ? ' active' : '');
        p.textContent = d.label + ' (' + counts[d.id] + ')';
        p.addEventListener('click', () => {
          activeTone = d.id;
          renderToolbar();
          renderSections();
        });
        pills.appendChild(p);
      }
      bar.appendChild(pills);
    }

    slot.appendChild(bar);
  }

  function matchesRow(r) {
    if (activeTone !== 'all') {
      const tone = r.badge && r.badge.tone ? r.badge.tone : 'default';
      if (tone !== activeTone) return false;
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      const hay = [
        r.title || '',
        r.meta || '',
        r.detail || '',
        r.badge ? r.badge.text : '',
      ].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  function renderSections() {
    const container = document.getElementById('sections');
    container.replaceChildren();

    const totalRows = (currentModel.sections || []).reduce((sum, s) => sum + s.rows.length, 0);
    if (totalRows === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = currentModel.emptyMessage || 'No items to display.';
      container.appendChild(empty);
      return;
    }

    let shownCount = 0;
    for (const sec of currentModel.sections) {
      const filteredRows = (sec.rows || []).filter(matchesRow);
      if (filteredRows.length === 0) continue;
      shownCount += filteredRows.length;

      const wrap = document.createElement('div');
      wrap.className = 'section';

      const head = document.createElement('div');
      head.className = 'section-head';
      const h2 = document.createElement('h2');
      h2.className = 'section-title';
      h2.textContent =
        filteredRows.length === sec.rows.length
          ? sec.title
          : sec.title + ' — ' + filteredRows.length + ' shown';
      head.appendChild(h2);
      if (sec.subtitle) {
        const sub = document.createElement('span');
        sub.className = 'section-sub';
        sub.textContent = sec.subtitle;
        head.appendChild(sub);
      }
      wrap.appendChild(head);

      const list = document.createElement('div');
      list.className = 'row-list';
      for (const r of filteredRows) {
        const row = document.createElement('div');
        row.className = 'row';

        const main = document.createElement('div');
        main.className = 'row-main';
        const top = document.createElement('div');
        top.className = 'row-top';

        if (r.badge) {
          const b = document.createElement('span');
          b.className = 'badge ' + toneClass(r.badge.tone);
          b.textContent = r.badge.text;
          top.appendChild(b);
        }

        const t = document.createElement('span');
        t.className = 'row-title';
        t.textContent = r.title;
        top.appendChild(t);

        if (r.meta) {
          const meta = document.createElement('span');
          meta.className = 'row-meta';
          meta.textContent = r.meta;
          top.appendChild(meta);
        }
        main.appendChild(top);

        if (r.detail) {
          const d = document.createElement('div');
          d.className = 'row-detail';
          d.textContent = r.detail;
          main.appendChild(d);
        }

        if (typeof r.percent === 'number') {
          const bg = document.createElement('div');
          bg.className = 'bar-bg';
          const fill = document.createElement('div');
          fill.className = 'bar-fill';
          fill.style.width = Math.max(2, Math.min(100, r.percent)) + '%';
          if (r.percent >= 40) fill.style.background = '#f59e0b';
          bg.appendChild(fill);
          main.appendChild(bg);
        }

        row.appendChild(main);

        if (r.actions && r.actions.length > 0) {
          const act = document.createElement('div');
          act.className = 'row-actions';
          for (const a of r.actions) act.appendChild(makeBtn(a, true));
          row.appendChild(act);
        }

        list.appendChild(row);
      }
      wrap.appendChild(list);
      container.appendChild(wrap);
    }

    if (shownCount === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No rows match the current search or severity filter.';
      container.appendChild(empty);
    }
  }

  function renderAll(resetFilters) {
    if (resetFilters) {
      searchQuery = '';
      activeTone = 'all';
    }
    renderTabs();
    renderChrome();
    renderToolbar();
    renderSections();
  }

  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'update' && event.data.model) {
      const switchedView = event.data.activeViewId !== currentActiveViewId;
      currentModel = event.data.model;
      currentTabs = event.data.tabs || currentTabs;
      currentActiveViewId = event.data.activeViewId || currentModel.viewId;
      renderAll(switchedView);
    }
  });

  renderAll(true);
</script>
</body>
</html>`;
}

export function openInspectorPanel(
  model: InspectorViewModel,
  onAction: InspectorActionHandler
): vscode.WebviewPanel {
  recentTabs.set(model.viewId, { model, handler: onAction });
  while (recentTabs.size > MAX_RECENT_TABS) {
    const oldestKey = recentTabs.keys().next().value;
    if (oldestKey && oldestKey !== model.viewId) {
      recentTabs.delete(oldestKey);
    } else {
      break;
    }
  }
  activeViewId = model.viewId;

  if (sharedPanel) {
    sharedPanel.reveal(vscode.ViewColumn.Beside, false);
    postState(sharedPanel, model);
    return sharedPanel;
  }

  const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;
  const panel = vscode.window.createWebviewPanel(
    'archpilot.inspector',
    model.tabTitle,
    column,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  sharedPanel = panel;

  const nonce = crypto.randomBytes(16).toString('hex');
  panel.webview.html = buildHtml(nonce, model, getTabSummaries());

  panel.webview.onDidReceiveMessage(
    async (msg: { type?: string; id?: string; payload?: string; viewId?: string }) => {
      if (msg.type === 'switchTab' && msg.viewId) {
        const target = recentTabs.get(msg.viewId);
        if (target) {
          activeViewId = msg.viewId;
          postState(panel, target.model);
        }
        return;
      }

      if (msg.type === 'closeTab' && msg.viewId) {
        recentTabs.delete(msg.viewId);
        if (recentTabs.size === 0) {
          panel.dispose();
          return;
        }
        if (activeViewId === msg.viewId) {
          const next = [...recentTabs.values()][recentTabs.size - 1];
          activeViewId = next.model.viewId;
          postState(panel, next.model);
        } else if (activeViewId) {
          const cur = recentTabs.get(activeViewId);
          if (cur) postState(panel, cur.model);
        }
        return;
      }

      if (msg.type === 'copyMarkdown' && activeViewId) {
        const cur = recentTabs.get(activeViewId);
        if (cur) {
          await vscode.env.clipboard.writeText(inspectorModelToMarkdown(cur.model));
          void vscode.window.showInformationMessage(`Copied "${cur.model.heading}" as Markdown.`);
        }
        return;
      }

      if (msg.type === 'action' && msg.id && activeViewId) {
        const cur = recentTabs.get(activeViewId);
        if (!cur) return;
        const nextModel = await cur.handler(msg.id, msg.payload);
        if (nextModel) {
          cur.model = nextModel;
          recentTabs.set(nextModel.viewId, cur);
          activeViewId = nextModel.viewId;
          postState(panel, nextModel);
        }
      }
    }
  );

  panel.onDidDispose(() => {
    sharedPanel = undefined;
    activeViewId = undefined;
    recentTabs.clear();
  });

  return panel;
}
