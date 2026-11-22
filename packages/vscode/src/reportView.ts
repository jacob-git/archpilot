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

const activePanels = new Map<
  string,
  { panel: vscode.WebviewPanel; handler: InspectorActionHandler }
>();

function buildHtml(nonce: string, initialModel: InspectorViewModel): string {
  const safeJson = JSON.stringify(initialModel).replace(/</g, '\\u003c');
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
    padding: 20px 24px 36px;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    font-family: var(--vscode-font-family);
    font-size: 13px;
    line-height: 1.5;
  }
  .header {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding-bottom: 16px;
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
    margin: 16px 0 20px;
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
  .section { margin-top: 20px; }
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
<div id="app"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let currentModel = ${safeJson};

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

  function render(model) {
    const app = document.getElementById('app');
    app.replaceChildren();

    const header = document.createElement('div');
    header.className = 'header';
    const titleWrap = document.createElement('div');
    const h1 = document.createElement('h1');
    h1.className = 'heading';
    h1.textContent = model.heading;
    titleWrap.appendChild(h1);
    if (model.subheading) {
      const sub = document.createElement('p');
      sub.className = 'subheading';
      sub.textContent = model.subheading;
      titleWrap.appendChild(sub);
    }
    header.appendChild(titleWrap);

    if (model.headerActions && model.headerActions.length > 0) {
      const actWrap = document.createElement('div');
      actWrap.className = 'actions';
      for (const a of model.headerActions) actWrap.appendChild(makeBtn(a, false));
      header.appendChild(actWrap);
    }
    app.appendChild(header);

    if (model.metrics && model.metrics.length > 0) {
      const grid = document.createElement('div');
      grid.className = 'metrics';
      for (const m of model.metrics) {
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
      app.appendChild(grid);
    }

    const totalRows = (model.sections || []).reduce((sum, s) => sum + s.rows.length, 0);
    if (totalRows === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = model.emptyMessage || 'No items to display.';
      app.appendChild(empty);
      return;
    }

    for (const sec of model.sections) {
      if (!sec.rows || sec.rows.length === 0) continue;
      const wrap = document.createElement('div');
      wrap.className = 'section';

      const head = document.createElement('div');
      head.className = 'section-head';
      const h2 = document.createElement('h2');
      h2.className = 'section-title';
      h2.textContent = sec.title;
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
      for (const r of sec.rows) {
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
      app.appendChild(wrap);
    }
  }

  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'update' && event.data.model) {
      currentModel = event.data.model;
      render(currentModel);
    }
  });

  render(currentModel);
</script>
</body>
</html>`;
}

export function openInspectorPanel(
  model: InspectorViewModel,
  onAction: InspectorActionHandler
): vscode.WebviewPanel {
  const existing = activePanels.get(model.viewId);
  if (existing) {
    existing.handler = onAction;
    existing.panel.title = model.tabTitle;
    existing.panel.reveal(vscode.ViewColumn.Beside, false);
    void existing.panel.webview.postMessage({ type: 'update', model });
    return existing.panel;
  }

  const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;
  const panel = vscode.window.createWebviewPanel(
    `archpilot.inspector.${model.viewId}`,
    model.tabTitle,
    column,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  const entry = { panel, handler: onAction };
  activePanels.set(model.viewId, entry);

  const nonce = crypto.randomBytes(16).toString('hex');
  panel.webview.html = buildHtml(nonce, model);

  panel.webview.onDidReceiveMessage(async (msg: { type?: string; id?: string; payload?: string }) => {
    if (msg.type !== 'action' || !msg.id) return;
    const nextModel = await entry.handler(msg.id, msg.payload);
    if (nextModel) {
      panel.title = nextModel.tabTitle;
      void panel.webview.postMessage({ type: 'update', model: nextModel });
    }
  });

  panel.onDidDispose(() => {
    activePanels.delete(model.viewId);
  });

  return panel;
}
