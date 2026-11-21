import * as vscode from 'vscode';
import * as path from 'node:path';
import { writeFile } from 'node:fs/promises';
import {
  buildArchitectureDiagram,
  generateArchitectureMd,
  generateMermaidDiagram,
  type ArchitectureDiagramData,
} from '@archpilot/core';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderWebviewHtml(diagram: ArchitectureDiagramData, scoreLabel: string): string {
  const data = diagram.graph;
  const payload = JSON.stringify({
    ...data,
    externalSystems: diagram.externalSystems,
  }).replace(/</g, '\\u003c');
  const totalTokens = data.nodes.reduce((acc, n) => acc + n.estimatedTokens, 0);
  const violationEdges = data.edges.filter((e) => e.isViolation).length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>ArchPilot Graph — ${escapeHtml(data.repoName)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #0b1120;
    color: #e2e8f0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    background: #0f172a;
    border-bottom: 1px solid #1e293b;
    gap: 12px;
    flex-wrap: wrap;
  }
  .title-group { display: flex; align-items: center; gap: 10px; }
  .title { font-size: 14px; font-weight: 600; color: #f8fafc; }
  .pill {
    font-size: 11px;
    padding: 3px 8px;
    border-radius: 999px;
    background: #1e293b;
    color: #94a3b8;
    border: 1px solid #334155;
  }
  .pill.good { color: #34d399; border-color: rgba(52, 211, 153, 0.35); background: rgba(16, 185, 129, 0.1); }
  .pill.warn { color: #fbbf24; border-color: rgba(251, 191, 36, 0.35); background: rgba(245, 158, 11, 0.1); }
  .pill.bad { color: #f87171; border-color: rgba(248, 113, 113, 0.4); background: rgba(239, 68, 68, 0.12); }
  .actions { display: flex; gap: 8px; }
  button {
    background: #1e293b;
    color: #e2e8f0;
    border: 1px solid #334155;
    border-radius: 6px;
    padding: 5px 10px;
    font-size: 12px;
    cursor: pointer;
  }
  button:hover { background: #334155; }
  main { flex: 1; display: flex; position: relative; overflow: hidden; }
  #canvasWrap {
    flex: 1;
    position: relative;
    background-image:
      linear-gradient(rgba(51, 65, 85, 0.18) 1px, transparent 1px),
      linear-gradient(90deg, rgba(51, 65, 85, 0.18) 1px, transparent 1px);
    background-size: 32px 32px;
    cursor: grab;
  }
  #canvasWrap:active { cursor: grabbing; }
  svg { width: 100%; height: 100%; display: block; }
  .legend {
    position: absolute;
    left: 14px;
    bottom: 14px;
    display: flex;
    gap: 12px;
    background: rgba(15, 23, 42, 0.9);
    border: 1px solid #1e293b;
    border-radius: 8px;
    padding: 6px 12px;
    font-size: 11px;
    color: #94a3b8;
  }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; }
  aside {
    width: 280px;
    background: #0f172a;
    border-left: 1px solid #1e293b;
    padding: 14px;
    overflow-y: auto;
    font-size: 12px;
  }
  aside h3 { font-size: 13px; color: #f8fafc; margin-bottom: 8px; word-break: break-all; }
  .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 10px 0 14px; }
  .meta-card {
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 6px;
    padding: 8px;
  }
  .meta-label { font-size: 10px; color: #94a3b8; text-transform: uppercase; }
  .meta-val { font-size: 14px; font-weight: 600; color: #f8fafc; margin-top: 2px; }
  .section-title { font-size: 11px; color: #94a3b8; text-transform: uppercase; margin: 12px 0 6px; }
  .file-link {
    display: block;
    padding: 4px 6px;
    border-radius: 4px;
    color: #38bdf8;
    text-decoration: none;
    cursor: pointer;
    word-break: break-all;
    margin-bottom: 2px;
  }
  .file-link:hover { background: #1e293b; }
  .empty { color: #64748b; line-height: 1.5; }
  .node-box { cursor: pointer; }
</style>
</head>
<body>
  <header>
    <div class="title-group">
      <span class="title">ArchPilot Graph · ${escapeHtml(data.repoName)}</span>
      <span class="pill good">${escapeHtml(scoreLabel)}</span>
      <span class="pill">${data.nodes.length} modules · ${data.edges.length} links${diagram.externalSystems.length > 0 ? ` · ${diagram.externalSystems.length} external` : ''}</span>
      <span class="pill">~${totalTokens.toLocaleString('en-US')} code tokens</span>
      ${data.cycles.length > 0 ? `<span class="pill bad">${data.cycles.length} circular</span>` : ''}
      ${violationEdges > 0 ? `<span class="pill bad">${violationEdges} boundary violations</span>` : ''}
    </div>
    <div class="actions">
      <button id="copyMermaidBtn">Copy Mermaid</button>
      <button id="exportMdBtn">Export ARCHITECTURE.md</button>
      <button id="exportSvgBtn">Export SVG</button>
      <button id="resetBtn">Reset View</button>
      <button id="refreshBtn">Refresh</button>
    </div>
  </header>
  <main>
    <div id="canvasWrap">
      <svg id="graphSvg">
        <defs>
          <marker id="arrow-clean" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#38bdf8" />
          </marker>
          <marker id="arrow-bad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#f87171" />
          </marker>
        </defs>
        <g id="viewport">
          <g id="edgesLayer"></g>
          <g id="nodesLayer"></g>
        </g>
      </svg>
      <div class="legend">
        <span><span class="dot" style="background:#38bdf8"></span>Clean Module</span>
        <span><span class="dot" style="background:#a78bfa"></span>External System / DB / API</span>
        <span><span class="dot" style="background:#fbbf24"></span>Token-Heavy (&gt;25K tok)</span>
        <span><span class="dot" style="background:#f87171"></span>Cycle / Boundary Violation</span>
      </div>
    </div>
    <aside id="inspector">
      <div class="empty">
        <strong>Module Inspector</strong><br/><br/>
        Click any module node to inspect its files, token weight, and dependencies.<br/><br/>
        Drag nodes to rearrange, scroll to zoom, drag background to pan.
      </div>
    </aside>
  </main>

<script>
  const vscode = acquireVsCodeApi();
  const data = ${payload};
  const svg = document.getElementById('graphSvg');
  const viewport = document.getElementById('viewport');
  const edgesLayer = document.getElementById('edgesLayer');
  const nodesLayer = document.getElementById('nodesLayer');
  const inspector = document.getElementById('inspector');

  const NODE_W = 190;
  const NODE_H = 62;

  // Initial layered / radial layout grouped by inDegree (core modules lower, entrypoints higher)
  const positions = new Map();
  const sorted = [...data.nodes].sort((a, b) => (b.outDegree - b.inDegree) - (a.outDegree - a.inDegree));
  const cols = Math.max(2, Math.ceil(Math.sqrt(sorted.length || 1)));
  sorted.forEach((n, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    positions.set(n.id, {
      x: 80 + col * 240 + (row % 2 === 1 ? 60 : 0),
      y: 70 + row * 125,
    });
  });

  // Place external systems neatly along the right column
  const extX = 140 + cols * 240;
  (data.externalSystems || []).forEach((ext, idx) => {
    positions.set(ext.id, { x: extX, y: 70 + idx * 105 });
  });

  let scale = 1;
  let tx = 0;
  let ty = 0;
  let selectedId = null;

  function applyTransform() {
    viewport.setAttribute('transform', 'translate(' + tx + ',' + ty + ') scale(' + scale + ')');
  }

  function render() {
    edgesLayer.replaceChildren();
    nodesLayer.replaceChildren();

    for (const e of data.edges) {
      const p1 = positions.get(e.from);
      const p2 = positions.get(e.to);
      if (!p1 || !p2) continue;
      const x1 = p1.x + NODE_W / 2;
      const y1 = p1.y + NODE_H / 2;
      const x2 = p2.x + NODE_W / 2;
      const y2 = p2.y + NODE_H / 2;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const dist = Math.hypot(dx, dy) || 1;
      const pad = 38;
      const sx = x1 + (dx / dist) * pad;
      const sy = y1 + (dy / dist) * pad;
      const ex = x2 - (dx / dist) * pad;
      const ey = y2 - (dy / dist) * pad;
      const cx = (sx + ex) / 2 - (dy / dist) * 24;
      const cy = (sy + ey) / 2 + (dx / dist) * 24;

      const isBad = e.isViolation || e.isCycle;
      const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      pathEl.setAttribute('d', 'M ' + sx + ' ' + sy + ' Q ' + cx + ' ' + cy + ' ' + ex + ' ' + ey);
      pathEl.setAttribute('fill', 'none');
      pathEl.setAttribute('stroke', isBad ? '#f87171' : '#38bdf8');
      pathEl.setAttribute('stroke-opacity', isBad ? '0.9' : '0.45');
      pathEl.setAttribute('stroke-width', String(Math.min(4, 1.4 + Math.log2(e.weight + 1))));
      if (isBad) pathEl.setAttribute('stroke-dasharray', '6 4');
      pathEl.setAttribute('marker-end', isBad ? 'url(#arrow-bad)' : 'url(#arrow-clean)');
      edgesLayer.appendChild(pathEl);
    }

    // Draw external system edges & nodes
    for (const ext of data.externalSystems || []) {
      const p2 = positions.get(ext.id);
      if (!p2) continue;
      for (const modId of ext.usedByModules) {
        const p1 = positions.get(modId);
        if (!p1) continue;
        const x1 = p1.x + NODE_W;
        const y1 = p1.y + NODE_H / 2;
        const x2 = p2.x;
        const y2 = p2.y + 26;
        const cx = (x1 + x2) / 2;
        const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        pathEl.setAttribute('d', 'M ' + x1 + ' ' + y1 + ' Q ' + cx + ' ' + y1 + ' ' + x2 + ' ' + y2);
        pathEl.setAttribute('fill', 'none');
        pathEl.setAttribute('stroke', '#a78bfa');
        pathEl.setAttribute('stroke-opacity', '0.65');
        pathEl.setAttribute('stroke-width', '1.6');
        pathEl.setAttribute('stroke-dasharray', '4 3');
        edgesLayer.appendChild(pathEl);
      }

      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('transform', 'translate(' + p2.x + ',' + p2.y + ')');
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('width', '175');
      rect.setAttribute('height', '52');
      rect.setAttribute('rx', '26');
      rect.setAttribute('fill', '#1e1b4b');
      rect.setAttribute('stroke', '#a78bfa');
      rect.setAttribute('stroke-width', '1.5');
      g.appendChild(rect);

      const title = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      title.setAttribute('x', '16');
      title.setAttribute('y', '22');
      title.setAttribute('fill', '#f5f3ff');
      title.setAttribute('font-size', '12');
      title.setAttribute('font-weight', '600');
      title.textContent = ext.label;
      g.appendChild(title);

      const sub = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      sub.setAttribute('x', '16');
      sub.setAttribute('y', '39');
      sub.setAttribute('fill', '#c4b5fd');
      sub.setAttribute('font-size', '10');
      sub.textContent = ext.kind + ' · ' + ext.usedByModules.length + ' module(s)';
      g.appendChild(sub);
      nodesLayer.appendChild(g);
    }

    for (const n of data.nodes) {
      const pos = positions.get(n.id);
      if (!pos) continue;
      const isBad = n.hasViolation || n.inCycle;
      const isHeavy = !isBad && n.estimatedTokens > 25000;
      const stroke = isBad ? '#f87171' : isHeavy ? '#fbbf24' : selectedId === n.id ? '#34d399' : '#38bdf8';

      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'node-box');
      g.setAttribute('transform', 'translate(' + pos.x + ',' + pos.y + ')');

      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('width', String(NODE_W));
      rect.setAttribute('height', String(NODE_H));
      rect.setAttribute('rx', '10');
      rect.setAttribute('fill', '#111c33');
      rect.setAttribute('stroke', stroke);
      rect.setAttribute('stroke-width', selectedId === n.id ? '2.4' : '1.4');
      g.appendChild(rect);

      const title = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      title.setAttribute('x', '12');
      title.setAttribute('y', '24');
      title.setAttribute('fill', '#f8fafc');
      title.setAttribute('font-size', '12');
      title.setAttribute('font-weight', '600');
      title.textContent = n.label.length > 23 ? n.label.slice(0, 22) + '…' : n.label;
      g.appendChild(title);

      const sub = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      sub.setAttribute('x', '12');
      sub.setAttribute('y', '44');
      sub.setAttribute('fill', '#94a3b8');
      sub.setAttribute('font-size', '11');
      sub.textContent = n.fileCount + ' files · ~' + Math.round(n.estimatedTokens / 1000 * 10) / 10 + 'K tok';
      g.appendChild(sub);

      let dragging = false;
      let moved = false;
      let startX = 0;
      let startY = 0;
      let origX = 0;
      let origY = 0;

      g.addEventListener('mousedown', (ev) => {
        ev.stopPropagation();
        dragging = true;
        moved = false;
        startX = ev.clientX;
        startY = ev.clientY;
        origX = pos.x;
        origY = pos.y;
      });

      window.addEventListener('mousemove', (ev) => {
        if (!dragging) return;
        const dx = (ev.clientX - startX) / scale;
        const dy = (ev.clientY - startY) / scale;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
        pos.x = origX + dx;
        pos.y = origY + dy;
        render();
      });

      window.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        if (!moved) {
          selectedId = n.id;
          showInspector(n);
          render();
        }
      });

      nodesLayer.appendChild(g);
    }
  }

  function showInspector(n) {
    const outgoing = data.edges.filter((e) => e.from === n.id);
    const incoming = data.edges.filter((e) => e.to === n.id);
    inspector.replaceChildren();

    const heading = document.createElement('h3');
    heading.textContent = n.label;
    inspector.appendChild(heading);

    const badgeRow = document.createElement('div');
    badgeRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;';
    const addBadge = (text, cls) => {
      const span = document.createElement('span');
      span.className = 'pill ' + cls;
      span.textContent = text;
      badgeRow.appendChild(span);
    };
    if (n.hasViolation) addBadge('Boundary Violation', 'bad');
    if (n.inCycle) addBadge('Circular Dependency', 'bad');
    if (n.estimatedTokens > 25000) addBadge('Token-Heavy Module', 'warn');
    if (badgeRow.childElementCount > 0) inspector.appendChild(badgeRow);

    const grid = document.createElement('div');
    grid.className = 'meta-grid';
    const addMetric = (label, val) => {
      const card = document.createElement('div');
      card.className = 'meta-card';
      const l = document.createElement('div');
      l.className = 'meta-label';
      l.textContent = label;
      const v = document.createElement('div');
      v.className = 'meta-val';
      v.textContent = val;
      card.append(l, v);
      grid.appendChild(card);
    };
    addMetric('Files', String(n.fileCount));
    addMetric('Est. Tokens', '~' + n.estimatedTokens.toLocaleString());
    addMetric('Depends On', String(outgoing.length));
    addMetric('Used By', String(incoming.length));
    inspector.appendChild(grid);

    const addSection = (titleText) => {
      const sec = document.createElement('div');
      sec.className = 'section-title';
      sec.textContent = titleText;
      inspector.appendChild(sec);
    };

    addSection('Sample Files (click to open)');
    for (const f of n.sampleFiles) {
      const a = document.createElement('a');
      a.className = 'file-link';
      a.textContent = f;
      a.addEventListener('click', () => {
        vscode.postMessage({ type: 'openFile', file: f });
      });
      inspector.appendChild(a);
    }

    if (outgoing.length > 0) {
      addSection('Outgoing Dependencies');
      for (const e of outgoing) {
        const row = document.createElement('div');
        row.style.marginBottom = '4px';
        row.style.color = e.isViolation || e.isCycle ? '#f87171' : '#cbd5e1';
        row.textContent = '→ ' + e.to + ' (' + e.weight + ')';
        inspector.appendChild(row);
      }
    }

    if (incoming.length > 0) {
      addSection('Incoming Dependents');
      for (const e of incoming) {
        const row = document.createElement('div');
        row.style.marginBottom = '4px';
        row.style.color = '#cbd5e1';
        row.textContent = '← ' + e.from + ' (' + e.weight + ')';
        inspector.appendChild(row);
      }
    }
  }

  // Pan & zoom canvas
  let panning = false;
  let panStartX = 0;
  let panStartY = 0;
  svg.addEventListener('mousedown', (ev) => {
    panning = true;
    panStartX = ev.clientX - tx;
    panStartY = ev.clientY - ty;
  });
  window.addEventListener('mousemove', (ev) => {
    if (!panning) return;
    tx = ev.clientX - panStartX;
    ty = ev.clientY - panStartY;
    applyTransform();
  });
  window.addEventListener('mouseup', () => { panning = false; });
  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const factor = ev.deltaY < 0 ? 1.1 : 0.9;
    scale = Math.max(0.35, Math.min(2.5, scale * factor));
    applyTransform();
  }, { passive: false });

  document.getElementById('copyMermaidBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'copyMermaid' });
  });
  document.getElementById('exportMdBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'exportMd' });
  });
  document.getElementById('exportSvgBtn').addEventListener('click', () => {
    const serializer = new XMLSerializer();
    const svgText = serializer.serializeToString(svg);
    vscode.postMessage({ type: 'exportSvg', svg: svgText });
  });
  document.getElementById('resetBtn').addEventListener('click', () => {
    scale = 1; tx = 0; ty = 0;
    applyTransform();
  });
  document.getElementById('refreshBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'refresh' });
  });

  applyTransform();
  render();
</script>
</body>
</html>`;
}

export async function openArchitectureGraph(
  rootDir: string,
  scoreLabel: string
): Promise<void> {
  const repoName = path.basename(rootDir);
  const panel = vscode.window.createWebviewPanel(
    'archpilot.graph',
    `ArchPilot Graph: ${repoName}`,
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  let latestDiagram: ArchitectureDiagramData | undefined;

  const load = async (): Promise<void> => {
    latestDiagram = await buildArchitectureDiagram(rootDir);
    panel.webview.html = renderWebviewHtml(latestDiagram, scoreLabel);
  };

  panel.webview.onDidReceiveMessage(
    async (msg: { type?: string; file?: string; svg?: string }) => {
      if (msg.type === 'refresh') {
        await load();
      } else if (msg.type === 'openFile' && msg.file) {
        const target = vscode.Uri.file(path.join(rootDir, msg.file));
        const doc = await vscode.workspace.openTextDocument(target);
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
      } else if (msg.type === 'copyMermaid' && latestDiagram) {
        const mermaid = generateMermaidDiagram(latestDiagram);
        await vscode.env.clipboard.writeText(mermaid);
        void vscode.window.showInformationMessage(
          'Copied Mermaid architecture diagram to clipboard — paste into GitHub, GitLab, Notion, or Confluence.'
        );
      } else if (msg.type === 'exportMd') {
        const md = await generateArchitectureMd(rootDir);
        const target = path.join(rootDir, 'ARCHITECTURE.md');
        await writeFile(target, md, 'utf8');
        const doc = await vscode.workspace.openTextDocument(target);
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        void vscode.window.showInformationMessage('Exported live Mermaid diagram to ARCHITECTURE.md.');
      } else if (msg.type === 'exportSvg' && msg.svg) {
        const defaultUri = vscode.Uri.file(path.join(rootDir, `${repoName}-architecture.svg`));
        const saveUri = await vscode.window.showSaveDialog({
          defaultUri,
          filters: { 'SVG Image': ['svg'] },
          title: 'Export Architecture Diagram as SVG',
        });
        if (saveUri) {
          await writeFile(saveUri.fsPath, msg.svg, 'utf8');
          void vscode.window.showInformationMessage(
            `Exported SVG diagram to ${path.basename(saveUri.fsPath)}.`
          );
        }
      }
    }
  );

  await load();
}
