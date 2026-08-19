#!/usr/bin/env node
/**
 * Compiles every Markdown file in the repo to a styled, standalone HTML file
 * sitting right next to its source (e.g. docs/SA-docs/SOLUTION-ARCHITECTURE.md
 * -> docs/SA-docs/SOLUTION-ARCHITECTURE.html).
 *
 * Usage:
 *   node util/toHtml.js              # convert every .md file in the repo
 *   node util/toHtml.js a.md b.md    # convert only the given file(s)
 */

const fs = require('fs');
const path = require('path');
const { marked } = require('marked');

const ROOT = path.resolve(__dirname, '..');
const IGNORED_DIRS = new Set(['node_modules', '.git', '.github']);

function findMarkdownFiles(dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) findMarkdownFiles(fullPath, results);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      results.push(fullPath);
    }
  }
  return results;
}

function resolveTargets(args) {
  if (args.length === 0) return findMarkdownFiles(ROOT);
  return args.map((p) => path.resolve(process.cwd(), p));
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Render fenced ```mermaid blocks as <pre class="mermaid"> so Mermaid.js
// (loaded client-side) can turn them into diagrams instead of showing raw text.
// The source must be HTML-escaped: Mermaid reads it back via textContent, and an
// unescaped diagram containing e.g. `<br/>` node labels gets parsed as a real
// <br> element by the browser, dropping the tag from textContent entirely and
// breaking the diagram's bracket syntax (the "compile error" the diagrams hit).
//
// marked@12's Renderer#code takes positional args (code, infostring, escaped),
// not a token object — passing a token here silently no-ops the mermoid check.
const renderer = new marked.Renderer();
const originalCode = renderer.code.bind(renderer);
renderer.code = (code, infostring, escaped) => {
  const lang = (infostring || '').match(/^\S*/)?.[0];
  if (lang === 'mermaid') {
    return `<pre class="mermaid">${escapeHtml(code)}</pre>\n`;
  }
  return originalCode(code, infostring, escaped);
};

marked.setOptions({ renderer, gfm: true, breaks: false });

function titleFromMarkdown(markdown, fallback) {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}

function buildHtml(title, bodyHtml) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${CSS}
</style>
</head>
<body>
<article class="doc">
${bodyHtml}
</article>
<div class="zoom-overlay">
  <div class="zoom-toolbar">
    <button type="button" data-action="zoom-out" title="Zoom out" aria-label="Zoom out">&minus;</button>
    <span class="zoom-level">100%</span>
    <button type="button" data-action="zoom-in" title="Zoom in" aria-label="Zoom in">+</button>
    <button type="button" data-action="reset" title="Reset zoom" aria-label="Reset zoom">&#8634;</button>
    <button type="button" data-action="close" title="Close" aria-label="Close">&times;</button>
  </div>
  <div class="zoom-stage">
    <div class="zoom-pan">
      <div class="zoom-scale"></div>
    </div>
  </div>
</div>
<script type="module">
  import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';

  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const blocks = Array.from(document.querySelectorAll('pre.mermaid'))
    .map((el) => ({ el, source: el.textContent }));

  async function render() {
    const theme = media.matches ? 'dark' : 'default';
    mermaid.initialize({ startOnLoad: false, theme });
    for (const block of blocks) {
      block.el.removeAttribute('data-processed');
      block.el.textContent = block.source;
    }
    if (blocks.length) await mermaid.run({ nodes: blocks.map((b) => b.el) });
    blocks.forEach((block) => {
      const svg = block.el.querySelector('svg');
      if (svg) zoom.attach(svg);
    });
  }

  // Click-to-zoom / drag-to-pan lightbox for markdown images and mermaid diagrams.
  function setupZoom() {
    const overlay = document.querySelector('.zoom-overlay');
    const stage = overlay.querySelector('.zoom-stage');
    const pan = overlay.querySelector('.zoom-pan');
    const scaleEl = overlay.querySelector('.zoom-scale');
    const levelLabel = overlay.querySelector('.zoom-level');

    const MIN = 1;
    const MAX = 6;
    let scale = 1;
    let tx = 0;
    let ty = 0;
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;

    function apply() {
      pan.style.transform = 'translate(' + tx + 'px, ' + ty + 'px)';
      scaleEl.style.transform = 'scale(' + scale + ')';
      levelLabel.textContent = Math.round(scale * 100) + '%';
    }

    function reset() {
      scale = 1;
      tx = 0;
      ty = 0;
      apply();
    }

    function zoomAt(nextScale, clientX, clientY) {
      nextScale = Math.min(MAX, Math.max(MIN, nextScale));
      if (nextScale === scale) return;
      const rect = stage.getBoundingClientRect();
      const cx = clientX ?? rect.left + rect.width / 2;
      const cy = clientY ?? rect.top + rect.height / 2;
      const dx = cx - (rect.left + rect.width / 2) - tx;
      const dy = cy - (rect.top + rect.height / 2) - ty;
      const factor = 1 - nextScale / scale;
      tx += dx * factor;
      ty += dy * factor;
      scale = nextScale;
      if (scale <= MIN) { tx = 0; ty = 0; }
      apply();
    }

    function open(source) {
      scaleEl.innerHTML = '';
      const clone = source.cloneNode(true);
      clone.removeAttribute('class');
      if (clone.tagName && clone.tagName.toLowerCase() === 'svg') {
        // Mermaid ships width="100%" with no height, sized against its
        // original flex parent. That percentage can't resolve inside the
        // lightbox's auto-sized wrapper (collapses to 0x0), so pin the clone
        // to its intrinsic viewBox size and let our own CSS max-width/height
        // scale it down responsively instead of Mermaid's inline max-width.
        const viewBox = clone.getAttribute('viewBox');
        const dims = viewBox ? viewBox.trim().split(/\\s+/).map(Number) : null;
        if (dims && dims.length === 4) {
          clone.setAttribute('width', dims[2]);
          clone.setAttribute('height', dims[3]);
        }
        clone.style.maxWidth = '';
      }
      scaleEl.appendChild(clone);
      reset();
      overlay.classList.add('open');
      document.body.style.overflow = 'hidden';
    }

    function close() {
      overlay.classList.remove('open');
      document.body.style.overflow = '';
    }

    overlay.querySelector('.zoom-toolbar').addEventListener('click', (e) => {
      const action = e.target.closest('button')?.dataset.action;
      if (action === 'zoom-in') zoomAt(scale * 1.25);
      else if (action === 'zoom-out') zoomAt(scale * 0.8);
      else if (action === 'reset') reset();
      else if (action === 'close') close();
    });

    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      zoomAt(scale * factor, e.clientX, e.clientY);
    }, { passive: false });

    stage.addEventListener('pointerdown', (e) => {
      dragging = true;
      moved = false;
      startX = e.clientX - tx;
      startY = e.clientY - ty;
      stage.setPointerCapture(e.pointerId);
      stage.classList.add('grabbing');
    });

    stage.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - (startX + tx);
      const dy = e.clientY - (startY + ty);
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      tx = e.clientX - startX;
      ty = e.clientY - startY;
      apply();
    });

    stage.addEventListener('pointerup', (e) => {
      dragging = false;
      stage.classList.remove('grabbing');
      if (moved) return;
      const rect = scaleEl.getBoundingClientRect();
      const inside = e.clientX >= rect.left && e.clientX <= rect.right
        && e.clientY >= rect.top && e.clientY <= rect.bottom;
      if (!inside) close();
    });

    stage.addEventListener('dblclick', (e) => {
      if (scale > MIN) reset();
      else zoomAt(3, e.clientX, e.clientY);
    });

    document.addEventListener('keydown', (e) => {
      if (!overlay.classList.contains('open')) return;
      if (e.key === 'Escape') close();
      else if (e.key === '+' || e.key === '=') zoomAt(scale * 1.25);
      else if (e.key === '-') zoomAt(scale * 0.8);
    });

    function attach(el) {
      el.classList.add('zoomable');
      el.addEventListener('click', () => open(el));
    }

    document.querySelectorAll('.doc img').forEach(attach);

    return { attach };
  }

  const zoom = setupZoom();

  render();
  media.addEventListener('change', render);
</script>
</body>
</html>
`;
}

const CSS = `
:root {
  color-scheme: light dark;

  --bg: #f3f4fb;
  --bg-glow: #e4e7fb;
  --surface: #ffffff;
  --border: #e0e3f1;
  --text: #1c1f2e;
  --text-dim: #5b6178;
  --accent: #6c47ff;
  --accent-2: #00a896;
  --accent-3: #e0417f;
  --code-bg: #f2f2fa;
  --code-text: #2a2d42;
  --shadow: rgba(30, 34, 70, 0.10);
  --heading: #14162b;
  --heading-alt: #6c47ff;
  --strong: #10121c;
  --th-bg: linear-gradient(90deg, rgba(108, 71, 255, 0.16), rgba(0, 168, 150, 0.14));
  --th-text: #14162b;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1220;
    --bg-glow: #1b1f3b;
    --surface: #1c2138;
    --border: #2c3356;
    --text: #e7e9f5;
    --text-dim: #a6acc9;
    --accent: #7c5cff;
    --accent-2: #00d9c0;
    --accent-3: #ff5da2;
    --code-bg: #12152a;
    --code-text: #d6d9f5;
    --shadow: rgba(0, 0, 0, 0.45);
    --heading: #ffffff;
    --heading-alt: #cdb8ff;
    --strong: #ffffff;
    --th-bg: linear-gradient(90deg, rgba(124, 92, 255, 0.35), rgba(0, 217, 192, 0.2));
    --th-text: #ffffff;
  }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  padding: 3rem 1.5rem 6rem;
  background: radial-gradient(circle at top left, var(--bg-glow), var(--bg) 55%);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
  line-height: 1.7;
  transition: background 0.2s ease, color 0.2s ease;
}

.doc {
  max-width: 880px;
  margin: 0 auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 3rem 3.5rem;
  box-shadow: 0 20px 60px var(--shadow);
  transition: background 0.2s ease, border-color 0.2s ease;
}

h1, h2, h3, h4, h5, h6 {
  font-weight: 700;
  line-height: 1.3;
  margin-top: 2.2em;
  margin-bottom: 0.6em;
  color: var(--heading);
}

h1 {
  font-size: 2.3rem;
  background: linear-gradient(90deg, var(--accent), var(--accent-3));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  padding-bottom: 0.4em;
  border-bottom: 2px solid var(--border);
  margin-top: 0;
}

h2 {
  font-size: 1.6rem;
  color: var(--accent-2);
  border-left: 4px solid var(--accent-2);
  padding-left: 0.6em;
}

h3 { font-size: 1.25rem; color: var(--heading-alt); }
h4 { font-size: 1.05rem; color: var(--text-dim); }

p { margin: 0.9em 0; }

a { color: var(--accent-2); text-decoration: none; border-bottom: 1px solid rgba(0, 217, 192, 0.4); }
a:hover { color: var(--accent-3); border-bottom-color: var(--accent-3); }

strong { color: var(--strong); }

hr {
  border: none;
  height: 1px;
  margin: 2.5em 0;
  background: linear-gradient(90deg, transparent, var(--border), transparent);
}

ul, ol { padding-left: 1.4em; }
li { margin: 0.35em 0; }
li::marker { color: var(--accent); }

blockquote {
  margin: 1.4em 0;
  padding: 0.8em 1.2em;
  border-left: 4px solid var(--accent-3);
  background: rgba(255, 93, 162, 0.08);
  border-radius: 0 8px 8px 0;
  color: var(--text-dim);
}

code {
  font-family: "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.88em;
  background: var(--code-bg);
  color: var(--accent-2);
  padding: 0.15em 0.4em;
  border-radius: 5px;
}

pre {
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 1.1em 1.3em;
  overflow-x: auto;
}

pre code {
  background: none;
  color: var(--code-text);
  padding: 0;
  font-size: 0.87em;
}

pre.mermaid {
  background: var(--code-bg);
  display: flex;
  justify-content: center;
}

table {
  width: 100%;
  border-collapse: collapse;
  margin: 1.4em 0;
  overflow: hidden;
  border-radius: 10px;
  border: 1px solid var(--border);
}

th, td {
  padding: 0.6em 0.9em;
  border-bottom: 1px solid var(--border);
  text-align: left;
}

th {
  background: var(--th-bg);
  color: var(--th-text);
  font-weight: 600;
}

tr:last-child td { border-bottom: none; }
tr:hover td { background: rgba(124, 92, 255, 0.08); }

img { max-width: 100%; border-radius: 8px; }

img.zoomable, pre.mermaid svg.zoomable {
  cursor: zoom-in;
  transition: opacity 0.15s ease;
}
img.zoomable:hover, pre.mermaid svg.zoomable:hover { opacity: 0.9; }

::selection { background: var(--accent); color: #fff; }

.zoom-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: none;
  background: rgba(8, 9, 18, 0.9);
}

.zoom-overlay.open { display: block; }

.zoom-stage {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  cursor: grab;
  touch-action: none;
}

.zoom-stage.grabbing { cursor: grabbing; }

.zoom-pan { will-change: transform; }

.zoom-scale img,
.zoom-scale svg {
  display: block;
  max-width: 90vw;
  max-height: 80vh;
  width: auto;
  height: auto;
  pointer-events: none;
  user-select: none;
  border-radius: 0;
}

.zoom-toolbar {
  position: fixed;
  top: 1.2rem;
  right: 1.2rem;
  z-index: 1001;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0.4rem 0.5rem;
  box-shadow: 0 10px 30px var(--shadow);
}

.zoom-toolbar button {
  width: 2rem;
  height: 2rem;
  border: none;
  border-radius: 50%;
  background: var(--code-bg);
  color: var(--text);
  font-size: 1.1rem;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

.zoom-toolbar button:hover { background: var(--accent); color: #fff; }

.zoom-level {
  min-width: 3.4em;
  text-align: center;
  font-size: 0.85rem;
  color: var(--text-dim);
}
`;

function convertFile(mdPath) {
  const markdown = fs.readFileSync(mdPath, 'utf8');
  const bodyHtml = marked.parse(markdown);
  const title = titleFromMarkdown(markdown, path.basename(mdPath, '.md'));
  const html = buildHtml(title, bodyHtml);
  const htmlPath = mdPath.replace(/\.md$/i, '.html');
  fs.writeFileSync(htmlPath, html, 'utf8');
  return htmlPath;
}

function main() {
  const targets = resolveTargets(process.argv.slice(2));
  if (targets.length === 0) {
    console.log('No Markdown files found.');
    return;
  }
  for (const mdPath of targets) {
    const htmlPath = convertFile(mdPath);
    console.log(`${path.relative(ROOT, mdPath)} -> ${path.relative(ROOT, htmlPath)}`);
  }
}

main();
