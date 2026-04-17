import { io } from 'socket.io-client';

const API = import.meta.env.VITE_SOCKET_URL || 'http://localhost:4001';

// ─── State ───
let socket = null, canvasId = null, username = null;
const userId = `user_${Math.random().toString(36).substr(2, 9)}`;
let tool = 'pen', color = '#000000', size = 4, zoom = 1, panX = 0, panY = 0;
let drawing = false, panning = false, startPX = 0, startPY = 0;
let pts = [], strokes = [], elements = [];
let selectedId = null, dragInfo = null;
let activeUsers = [], cursorMap = new Map(), imageCache = new Map();
let animId = null, lastCursorEmit = 0;
let needsOverlayUpdate = true;

const STICKY_COLORS = ['#FEF3C7','#FECACA','#BFDBFE','#BBF7D0','#E9D5FF','#FED7AA'];

// ─── DOM ───
const $ = id => document.getElementById(id);
const landingView = $('landing-view'), appView = $('app-view');
const canvas = $('drawing-canvas'), ctx = canvas.getContext('2d');
const elOverlay = $('element-overlay'), workspace = $('workspace-area');
const colorPicker = $('color-picker'), sizeSlider = $('size-slider'), sizeVal = $('size-value');
const zoomText = $('zoom-level'), syncStatus = $('sync-status'), syncIcon = $('sync-icon');
const collabContainer = $('collaborators-container');
const aiPromptBar = $('ai-prompt-bar'), aiPromptInput = $('ai-prompt-input'), aiLoading = $('ai-loading');
const ctxMenu = $('ctx-menu');

// ─── Utils ───
function uid() { return `el_${Date.now()}_${Math.random().toString(36).substr(2,6)}`; }
function setSync(t,i) { syncStatus.textContent=t; syncIcon.setAttribute('icon',i); }
function clamp(v,mn,mx) { return Math.max(mn,Math.min(mx,v)); }

function toCanvas(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left - panX) / zoom, y: (e.clientY - r.top - panY) / zoom };
}
function toScreen(cx, cy) {
  return { x: cx * zoom + panX, y: cy * zoom + panY };
}

// ─── Canvas Resize ───
function resize() {
  const r = workspace.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = r.width * dpr; canvas.height = r.height * dpr;
  canvas.style.width = r.width + 'px'; canvas.style.height = r.height + 'px';
  ctx.scale(dpr, dpr);
  needsOverlayUpdate = true;
}
window.addEventListener('resize', resize);

// ─── Zoom ───
function setZoom(z, cx, cy) {
  const oldZ = zoom;
  zoom = clamp(z, 0.1, 5);
  if (cx !== undefined) { panX = cx - (cx - panX) * (zoom / oldZ); panY = cy - (cy - panY) * (zoom / oldZ); }
  zoomText.textContent = Math.round(zoom * 100) + '%';
  needsOverlayUpdate = true;
}
$('zoom-in-btn').addEventListener('click', () => setZoom(zoom + 0.15));
$('zoom-out-btn').addEventListener('click', () => setZoom(zoom - 0.15));
$('zoom-fit-btn').addEventListener('click', () => { zoom = 1; panX = 0; panY = 0; zoomText.textContent = '100%'; needsOverlayUpdate = true; });

workspace.addEventListener('wheel', (e) => {
  if (e.target.closest('.bottom-toolbar') || e.target.closest('.minimap')) return;
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  setZoom(zoom + (e.deltaY < 0 ? 0.08 : -0.08), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });

// ─── Socket ───
function initSocket() {
  if (socket) return;
  socket = io(API, { reconnection: true, transports: ['websocket', 'polling'] });
  socket.on('connect', () => setSync('Connected', 'solar:cloud-check-linear'));
  socket.on('draw_stroke', s => {
    if (s.action === 'clear') strokes = [];
    else if (s.action === 'undo') strokes = strokes.filter(x => x.id !== s.id);
    else strokes.push(s);
  });
  socket.on('element_add', el => { elements.push(el); needsOverlayUpdate = true; });
  socket.on('element_update', el => {
    const i = elements.findIndex(e => e.id === el.id);
    if (i >= 0) elements[i] = el;
    needsOverlayUpdate = true;
  });
  socket.on('element_delete', ({ elementId }) => {
    elements = elements.filter(e => e.id !== elementId);
    if (selectedId === elementId) selectedId = null;
    needsOverlayUpdate = true;
  });
  socket.on('user_joined', u => { activeUsers.push(u); renderUsers(); });
  socket.on('user_left', d => { activeUsers = activeUsers.filter(u => u.userId !== d.userId); cursorMap.delete(d.userId); renderUsers(); });
  socket.on('active_users', u => { activeUsers = u; renderUsers(); });
  socket.on('cursor_move', d => { if (d.userId !== userId) cursorMap.set(d.userId, {x:d.x,y:d.y}); });
}

// ─── Join Canvas ───
async function joinCanvas(forceId) {
  if (!username) username = prompt('Enter your name:') || 'Anonymous';
  canvasId = forceId || `canvas-${Date.now()}`;
  const url = new URL(window.location); url.searchParams.set('canvas', canvasId);
  window.history.pushState({}, '', url);
  landingView.classList.add('hidden'); appView.classList.remove('hidden');
  resize(); initSocket();
  if (!animId) renderLoop();
  try {
    const res = await fetch(`${API}/api/canvas/${canvasId}`);
    const data = await res.json();
    if (data.success) {
      let processed = [];
      (data.canvas.strokes || []).forEach(s => {
        if (s.action === 'clear') processed = [];
        else if (s.action === 'undo') processed = processed.filter(x => x.id !== s.id);
        else processed.push(s);
      });
      strokes = processed;
      elements = data.canvas.elements || [];
      needsOverlayUpdate = true;
    }
  } catch(e) { console.error('Load error:', e); }
  const c = `hsl(${Math.random()*360},70%,60%)`;
  socket.emit('join_canvas', { canvasId, userId, username, color: c });
}

// ─── Users ───
function renderUsers() {
  collabContainer.innerHTML = '';
  activeUsers.slice(0, 4).forEach((u, i) => {
    const d = document.createElement('div');
    d.className = 'w-8 h-8 rounded-full border-2 border-white shadow-sm flex items-center justify-center text-xs font-bold text-white';
    d.style.backgroundColor = u.color; d.style.zIndex = 30 - i;
    if (i > 0) d.classList.add('-ml-3');
    d.title = u.username; d.textContent = u.username.substring(0,2).toUpperCase();
    collabContainer.appendChild(d);
  });
  if (activeUsers.length > 4) {
    const e = document.createElement('div');
    e.className = 'w-8 h-8 rounded-full border-2 border-white shadow-sm -ml-3 bg-gray-100 flex items-center justify-center text-[10px] font-semibold text-gray-600';
    e.textContent = `+${activeUsers.length-4}`;
    collabContainer.appendChild(e);
  }
}

// ─── Draw Stroke ───
function drawStroke(s) {
  if (s.type === 'ai_image') {
    const cached = imageCache.get(s.imageUrl);
    if (cached && cached.complete) ctx.drawImage(cached, s.bounds.x, s.bounds.y, s.bounds.width, s.bounds.height);
    else if (!cached) { const img = new Image(); img.crossOrigin='anonymous'; img.src=s.imageUrl; img.onload=()=>{}; imageCache.set(s.imageUrl, img); }
    return;
  }
  if (!s.points || !s.points.length) return;
  ctx.strokeStyle = s.color; ctx.lineWidth = s.size; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (s.tool === 'eraser') { ctx.globalCompositeOperation = 'destination-out'; ctx.strokeStyle = 'rgba(0,0,0,1)'; }
  if (s.points.length < 2) {
    ctx.beginPath(); ctx.arc(s.points[0].x, s.points[0].y, s.size/2, 0, Math.PI*2);
    ctx.fillStyle = ctx.strokeStyle; ctx.fill();
  } else {
    ctx.beginPath(); ctx.moveTo(s.points[0].x, s.points[0].y);
    for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
}

// ─── Draw Elements ───
function drawCanvasElements() {
  elements.filter(e => e.type === 'shape' || e.type === 'connector' || e.type === 'frame').sort((a,b) => (a.zIndex||0)-(b.zIndex||0)).forEach(el => {
    ctx.save();
    if (el.type === 'shape') {
      ctx.strokeStyle = el.stroke || '#1a1818'; ctx.fillStyle = el.fill || 'transparent'; ctx.lineWidth = el.strokeWidth || 2;
      if (el.shapeType === 'circle') {
        ctx.beginPath(); ctx.ellipse(el.x+el.width/2, el.y+el.height/2, Math.abs(el.width/2), Math.abs(el.height/2), 0, 0, Math.PI*2);
        if (el.fill && el.fill !== 'transparent') ctx.fill(); ctx.stroke();
      } else if (el.shapeType === 'diamond') {
        const cx=el.x+el.width/2, cy=el.y+el.height/2;
        ctx.beginPath(); ctx.moveTo(cx,el.y); ctx.lineTo(el.x+el.width,cy); ctx.lineTo(cx,el.y+el.height); ctx.lineTo(el.x,cy); ctx.closePath();
        if (el.fill && el.fill !== 'transparent') ctx.fill(); ctx.stroke();
      } else {
        if (el.fill && el.fill !== 'transparent') ctx.fillRect(el.x, el.y, el.width, el.height);
        ctx.strokeRect(el.x, el.y, el.width, el.height);
      }
    } else if (el.type === 'connector') {
      ctx.strokeStyle = el.stroke || '#6B7280'; ctx.lineWidth = el.strokeWidth || 2;
      ctx.beginPath(); ctx.moveTo(el.x, el.y); ctx.lineTo(el.x2, el.y2); ctx.stroke();
      const angle = Math.atan2(el.y2-el.y, el.x2-el.x), hs = 12;
      ctx.fillStyle = el.stroke || '#6B7280'; ctx.beginPath();
      ctx.moveTo(el.x2, el.y2);
      ctx.lineTo(el.x2 - hs*Math.cos(angle-0.4), el.y2 - hs*Math.sin(angle-0.4));
      ctx.lineTo(el.x2 - hs*Math.cos(angle+0.4), el.y2 - hs*Math.sin(angle+0.4));
      ctx.closePath(); ctx.fill();
    } else if (el.type === 'frame') {
      ctx.strokeStyle = '#94A3B8'; ctx.lineWidth = 2; ctx.setLineDash([6,4]);
      ctx.strokeRect(el.x, el.y, el.width, el.height); ctx.setLineDash([]);
      if (el.fill) { ctx.fillStyle = el.fill; ctx.fillRect(el.x, el.y, el.width, el.height); }
      ctx.font = 'bold 13px Inter'; ctx.fillStyle = '#64748B';
      ctx.fillText(el.title || 'Frame', el.x + 8, el.y - 8);
    }
    // Selection box
    if (el.id === selectedId) {
      const bx = el.type==='connector' ? Math.min(el.x,el.x2)-6 : el.x-6;
      const by = el.type==='connector' ? Math.min(el.y,el.y2)-6 : el.y-6;
      const bw = el.type==='connector' ? Math.abs(el.x2-el.x)+12 : (el.width||80)+12;
      const bh = el.type==='connector' ? Math.abs(el.y2-el.y)+12 : (el.height||40)+12;
      ctx.strokeStyle = '#4F46E5'; ctx.lineWidth = 1.5; ctx.setLineDash([5,3]);
      ctx.strokeRect(bx,by,bw,bh); ctx.setLineDash([]);
      ctx.fillStyle = 'white'; ctx.strokeStyle = '#4F46E5'; ctx.lineWidth = 2;
      [[bx,by],[bx+bw,by],[bx,by+bh],[bx+bw,by+bh]].forEach(([hx,hy]) => {
        ctx.beginPath(); ctx.arc(hx,hy,4,0,Math.PI*2); ctx.fill(); ctx.stroke();
      });
    }
    ctx.restore();
  });
}

// ─── Draw Active Stroke Preview ───
function drawActivePreview() {
  if (!drawing || !pts.length) return;
  ctx.save();
  if (tool === 'lasso') {
    ctx.strokeStyle = '#7C3AED'; ctx.setLineDash([6,4]); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (let i=1; i<pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.lineTo(pts[0].x, pts[0].y); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(124,58,237,0.06)'; ctx.beginPath(); ctx.moveTo(pts[0].x,pts[0].y);
    for (let i=1;i<pts.length;i++) ctx.lineTo(pts[i].x,pts[i].y); ctx.closePath(); ctx.fill();
  } else if (tool==='shape' && pts.length>=2) {
    ctx.strokeStyle = color; ctx.lineWidth = size;
    ctx.strokeRect(pts[0].x, pts[0].y, pts[1].x-pts[0].x, pts[1].y-pts[0].y);
  } else if (tool==='connector' && pts.length>=2) {
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash([4,4]);
    ctx.beginPath(); ctx.moveTo(pts[0].x,pts[0].y); ctx.lineTo(pts[pts.length-1].x,pts[pts.length-1].y); ctx.stroke(); ctx.setLineDash([]);
  } else if (tool==='frame' && pts.length>=2) {
    ctx.strokeStyle = '#94A3B8'; ctx.lineWidth = 2; ctx.setLineDash([6,4]);
    ctx.fillStyle = 'rgba(148,163,184,0.05)';
    const x=Math.min(pts[0].x,pts[1].x), y=Math.min(pts[0].y,pts[1].y), w=Math.abs(pts[1].x-pts[0].x), h=Math.abs(pts[1].y-pts[0].y);
    ctx.fillRect(x,y,w,h); ctx.strokeRect(x,y,w,h); ctx.setLineDash([]);
  } else if (tool !== 'shape' && tool !== 'connector' && tool !== 'frame') {
    if (tool==='eraser') { ctx.globalCompositeOperation='destination-out'; ctx.strokeStyle='rgba(0,0,0,1)'; }
    else ctx.strokeStyle = color;
    ctx.lineWidth = size; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (let i=1;i<pts.length;i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.restore();
}

// ─── Cursors ───
function drawCursors() {
  ctx.save(); ctx.setTransform(1,0,0,1,0,0);
  const dpr = window.devicePixelRatio||1; ctx.scale(dpr,dpr);
  cursorMap.forEach((pos, uid) => {
    if (uid === userId) return;
    const u = activeUsers.find(a => a.userId === uid); if (!u) return;
    const sx = pos.x * zoom + panX, sy = pos.y * zoom + panY;
    ctx.fillStyle = u.color; ctx.strokeStyle = 'white'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(sx,sy); ctx.lineTo(sx+10,sy+15); ctx.lineTo(sx+5,sy+15); ctx.lineTo(sx,sy+20); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.font = 'bold 10px Inter';
    const tw = ctx.measureText(u.username).width;
    ctx.fillStyle = u.color; ctx.fillRect(sx+12,sy+12,tw+8,16);
    ctx.fillStyle = 'white'; ctx.fillText(u.username,sx+16,sy+24);
  });
  ctx.restore();
}

// ─── Render ───
let _frameCount = 0;
function redraw() {
  ctx.save(); ctx.setTransform(1,0,0,1,0,0);
  const dpr = window.devicePixelRatio || 1; ctx.scale(dpr,dpr);
  ctx.clearRect(0,0,canvas.width/dpr,canvas.height/dpr);
  ctx.translate(panX,panY); ctx.scale(zoom,zoom);
  strokes.forEach(drawStroke);
  drawCanvasElements();
  drawActivePreview();
  ctx.restore();
  drawCursors();
  if (needsOverlayUpdate) { updateOverlay(); needsOverlayUpdate = false; }
  if (++_frameCount % 12 === 0) drawMinimap();
}

function renderLoop() { redraw(); animId = requestAnimationFrame(renderLoop); }

// ─── Overlay: Sticky Notes & Text ───
function updateOverlay() {
  elOverlay.innerHTML = '';
  elements.filter(e => e.type === 'sticky' || e.type === 'text').forEach(el => {
    const sp = toScreen(el.x, el.y);
    const w = (el.width||200) * zoom, h = (el.height||100) * zoom;
    const div = document.createElement('div');
    div.dataset.elId = el.id;
    div.style.cssText = `position:absolute;left:${sp.x}px;top:${sp.y}px;width:${w}px;height:${h}px;pointer-events:auto;cursor:${tool==='select'?'move':'default'};user-select:none;transition:box-shadow 0.15s;`;

    if (el.type === 'sticky') {
      div.style.background = el.color || '#FEF3C7';
      div.style.borderRadius = '6px';
      div.style.boxShadow = el.id===selectedId ? '0 0 0 2px #4F46E5, 2px 4px 12px rgba(0,0,0,0.1)' : '2px 3px 8px rgba(0,0,0,0.08)';
      div.style.padding = Math.max(8, 12*zoom) + 'px';
      div.style.fontSize = Math.max(10, 14*zoom) + 'px';
      div.style.lineHeight = '1.5';
      div.style.fontFamily = 'Inter, sans-serif';
      div.style.overflow = 'hidden';
      div.style.wordBreak = 'break-word';
      div.textContent = el.text || '';
    } else if (el.type === 'text') {
      div.style.fontSize = Math.max(10, (el.fontSize||18)*zoom) + 'px';
      div.style.fontWeight = el.fontWeight || '400';
      div.style.fontFamily = 'Inter, sans-serif';
      div.style.color = el.color || '#1a1818';
      div.style.overflow = 'hidden';
      div.style.lineHeight = '1.3';
      div.textContent = el.text || 'Text';
      if (el.id === selectedId) div.style.outline = '2px solid #4F46E5';
    }

    // ── Select + Drag ──
    div.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      // NOTE: do NOT call e.preventDefault() — that blocks native dblclick
      if (tool === 'select' || tool === 'sticky' || tool === 'text') {
        tool = 'select'; updateToolbar();
        selectedId = el.id;
        const cp = toCanvas(e);
        dragInfo = { id: el.id, ox: cp.x - el.x, oy: cp.y - el.y };
        // Update visual selection without full DOM rebuild
        elOverlay.querySelectorAll('[data-el-id]').forEach(d => {
          const isSelected = d.dataset.elId === el.id;
          const elData = elements.find(x => x.id === d.dataset.elId);
          if (elData && elData.type === 'sticky') {
            d.style.boxShadow = isSelected ? '0 0 0 2px #4F46E5, 2px 4px 12px rgba(0,0,0,0.1)' : '2px 3px 8px rgba(0,0,0,0.08)';
          } else if (elData && elData.type === 'text') {
            d.style.outline = isSelected ? '2px solid #4F46E5' : 'none';
          }
        });
      }
    });

    // ── Double-click to Edit ──
    div.addEventListener('dblclick', (e) => {
      e.stopPropagation(); e.preventDefault();
      startInlineEdit(el, div);
    });


    // ── Right-click Context Menu ──
    div.addEventListener('contextmenu', (e) => {
      e.stopPropagation(); e.preventDefault();
      selectedId = el.id;
      showContextMenu(e.clientX, e.clientY);
      needsOverlayUpdate = true;
    });

    elOverlay.appendChild(div);
  });
}

// ─── Inline Edit ───
function startInlineEdit(el, parentDiv) {
  // Remove existing editors
  document.querySelectorAll('.inline-editor').forEach(e => e.remove());

  const sp = toScreen(el.x, el.y);
  const w = (el.width||200) * zoom, h = (el.height||100) * zoom;

  const ta = document.createElement('textarea');
  ta.className = 'inline-editor';
  ta.value = el.text || '';
  ta.style.cssText = `position:absolute;left:${sp.x}px;top:${sp.y}px;width:${w}px;height:${h}px;
    background:${el.type==='sticky'?(el.color||'#FEF3C7'):'transparent'};
    border:2px solid #4F46E5;border-radius:6px;padding:${Math.max(8,12*zoom)}px;
    font-size:${Math.max(10,(el.type==='text'?(el.fontSize||18):14)*zoom)}px;
    font-family:Inter,sans-serif;resize:none;outline:none;z-index:100;pointer-events:auto;
    line-height:1.5;box-shadow:0 0 0 4px rgba(79,70,229,0.15);word-break:break-word;`;

  const finishEdit = () => {
    el.text = ta.value;
    if (socket) socket.emit('element_update', { canvasId, element: el });
    ta.remove();
    needsOverlayUpdate = true;
  };
  ta.addEventListener('blur', finishEdit);
  ta.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Escape') { ta.blur(); }
  });

  elOverlay.appendChild(ta);
  ta.focus();
  ta.select();
}

// ─── Context Menu ───
function showContextMenu(x, y) {
  ctxMenu.style.left = x + 'px';
  ctxMenu.style.top = y + 'px';
  ctxMenu.style.display = 'block';
}

function hideContextMenu() { ctxMenu.style.display = 'none'; }

ctxMenu.querySelectorAll('.ctx-item').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    hideContextMenu();
    if (!selectedId) return;
    const action = btn.dataset.action;
    const el = elements.find(e => e.id === selectedId);
    if (!el) return;

    if (action === 'delete') {
      deleteElement(selectedId);
    } else if (action === 'duplicate') {
      const ne = { ...el, id: uid(), x: el.x + 30, y: el.y + 30 };
      if (ne.x2) { ne.x2 += 30; ne.y2 += 30; }
      elements.push(ne);
      if (socket) socket.emit('element_add', { canvasId, element: ne });
      selectedId = ne.id;
    } else if (action === 'front') {
      el.zIndex = Math.max(...elements.map(e => e.zIndex || 0)) + 1;
      if (socket) socket.emit('element_update', { canvasId, element: el });
    } else if (action === 'back') {
      el.zIndex = Math.min(...elements.map(e => e.zIndex || 0)) - 1;
      if (socket) socket.emit('element_update', { canvasId, element: el });
    } else if (action === 'lock') {
      el.locked = !el.locked;
      if (socket) socket.emit('element_update', { canvasId, element: el });
    }
    needsOverlayUpdate = true;
  });
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.ctx-menu')) hideContextMenu();
});

// ─── Delete Element ───
function deleteElement(id) {
  elements = elements.filter(e => e.id !== id);
  if (socket) socket.emit('element_delete', { canvasId, elementId: id });
  if (selectedId === id) selectedId = null;
  needsOverlayUpdate = true;
}

// ─── Hit Test (canvas-drawn elements) ───
function hitTestCanvas(cx, cy) {
  const canvasEls = elements.filter(e => e.type === 'shape' || e.type === 'connector' || e.type === 'frame');
  for (let i = canvasEls.length - 1; i >= 0; i--) {
    const el = canvasEls[i];
    if (el.type === 'connector') {
      if (pointToLineDist(cx,cy,el.x,el.y,el.x2,el.y2) < 12) return el;
    } else {
      if (cx >= el.x && cx <= el.x + (el.width||80) && cy >= el.y && cy <= el.y + (el.height||40)) return el;
    }
  }
  return null;
}

function pointToLineDist(px,py,x1,y1,x2,y2) {
  const A=px-x1,B=py-y1,C=x2-x1,D=y2-y1;
  const dot=A*C+B*D, len2=C*C+D*D;
  let t = len2 !== 0 ? clamp(dot/len2,0,1) : 0;
  return Math.sqrt((px-(x1+t*C))**2 + (py-(y1+t*D))**2);
}

// ─── Global pointer tracking for drag ───
document.addEventListener('pointermove', (e) => {
  if (!canvasId) return;

  // Panning
  if (panning) {
    panX = e.clientX - startPX; panY = e.clientY - startPY;
    needsOverlayUpdate = true;
    return;
  }

  // Dragging element (from overlay or canvas)
  if (dragInfo) {
    const cp = toCanvas(e);
    const el = elements.find(x => x.id === dragInfo.id);
    if (el && !el.locked) {
      el.x = cp.x - dragInfo.ox; el.y = cp.y - dragInfo.oy;
      if (socket) socket.emit('element_update', { canvasId, element: el });
      needsOverlayUpdate = true;
    }
    return;
  }
});

document.addEventListener('pointerup', () => {
  if (panning) { panning = false; canvas.style.cursor = tool === 'hand' ? 'grab' : getCursor(); return; }
  if (dragInfo) { dragInfo = null; return; }
});

// ─── Canvas Pointer Events ───
canvas.addEventListener('pointerdown', (e) => {
  if (!canvasId) return;
  hideContextMenu();
  const cp = toCanvas(e);

  // Hand tool
  if (tool === 'hand') {
    panning = true; startPX = e.clientX - panX; startPY = e.clientY - panY;
    canvas.style.cursor = 'grabbing'; return;
  }

  // Middle mouse = pan
  if (e.button === 1) {
    panning = true; startPX = e.clientX - panX; startPY = e.clientY - panY;
    canvas.style.cursor = 'grabbing'; e.preventDefault(); return;
  }

  // Select tool
  if (tool === 'select') {
    const hit = hitTestCanvas(cp.x, cp.y);
    if (hit) {
      selectedId = hit.id;
      dragInfo = { id: hit.id, ox: cp.x - hit.x, oy: cp.y - hit.y };
    } else {
      selectedId = null;
    }
    needsOverlayUpdate = true;
    return;
  }

  // Sticky: place immediately
  if (tool === 'sticky') {
    const el = { id: uid(), type: 'sticky', x: cp.x - 100, y: cp.y - 80, width: 200, height: 160,
      color: STICKY_COLORS[Math.floor(Math.random()*STICKY_COLORS.length)], text: '', zIndex: elements.length };
    elements.push(el);
    if (socket) socket.emit('element_add', { canvasId, element: el });
    selectedId = el.id; tool = 'select'; updateToolbar();
    needsOverlayUpdate = true; return;
  }

  // Text: place immediately
  if (tool === 'text') {
    const el = { id: uid(), type: 'text', x: cp.x, y: cp.y, width: 200, height: 40,
      text: 'Text', fontSize: 20, fontWeight: '400', color: color, zIndex: elements.length };
    elements.push(el);
    if (socket) socket.emit('element_add', { canvasId, element: el });
    selectedId = el.id; tool = 'select'; updateToolbar();
    needsOverlayUpdate = true; return;
  }

  // Drawing tools
  drawing = true;
  pts = [cp];
});

canvas.addEventListener('pointermove', (e) => {
  if (!canvasId) return;
  const cp = toCanvas(e);

  // Cursor emit
  if (socket && (!lastCursorEmit || Date.now()-lastCursorEmit > 16)) {
    socket.emit('cursor_move', { canvasId, x: cp.x, y: cp.y }); lastCursorEmit = Date.now();
  }
  if (!drawing) return;
  if (tool === 'shape' || tool === 'frame') pts[1] = cp;
  else if (tool === 'connector') { if (pts.length < 2) pts.push(cp); else pts[1] = cp; }
  else pts.push(cp);
});

canvas.addEventListener('pointerup', async (e) => {
  if (!drawing || !canvasId) return;
  drawing = false;

  // ─── LASSO AI ───
  if (tool === 'lasso') {
    if (localStorage.getItem('ai_lasso_used')) {
      alert('Free Beta Limit Reached: The AI Lasso has already been used on this device.');
      pts = [];
      return;
    }
    if (pts.length < 3) { pts = []; return; }
    let mnX=Infinity, mxX=-Infinity, mnY=Infinity, mxY=-Infinity;
    pts.forEach(p => { mnX=Math.min(mnX,p.x); mxX=Math.max(mxX,p.x); mnY=Math.min(mnY,p.y); mxY=Math.max(mxY,p.y); });
    const bounds = { x: Math.floor(mnX), y: Math.floor(mnY), width: Math.ceil(mxX-mnX), height: Math.ceil(mxY-mnY) };
    // Keep a ghost of the lasso region while user types
    const lassoPts = [...pts];
    pts = [];

    // Show prompt bar at lasso bounding box center-bottom
    const sp = toScreen(bounds.x + bounds.width/2 - 160, bounds.y + bounds.height + 20);
    aiPromptBar.style.left = clamp(sp.x, 10, window.innerWidth - 350) + 'px';
    aiPromptBar.style.top  = clamp(sp.y, 10, window.innerHeight - 70) + 'px';
    aiPromptBar.style.display = 'flex';
    aiPromptInput.value = '';
    aiPromptInput.placeholder = 'Describe what to generate here…';
    setTimeout(() => aiPromptInput.focus(), 50);

    // Draw ghost lasso while waiting
    const drawLassoGhost = () => {
      if (lassoPts.length < 2) return;
      ctx.save();
      ctx.translate(panX, panY); ctx.scale(zoom, zoom);
      ctx.strokeStyle = '#7C3AED'; ctx.setLineDash([6, 4]); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(lassoPts[0].x, lassoPts[0].y);
      lassoPts.forEach(p => ctx.lineTo(p.x, p.y));
      ctx.closePath(); ctx.stroke();
      ctx.fillStyle = 'rgba(124,58,237,0.08)';
      ctx.beginPath(); ctx.moveTo(lassoPts[0].x, lassoPts[0].y);
      lassoPts.forEach(p => ctx.lineTo(p.x, p.y));
      ctx.closePath(); ctx.fill();
      ctx.setLineDash([]);
      ctx.restore();
    };
    // Temporarily inject ghost render into loop
    const origRedraw = redraw;
    const patchedRedraw = () => { origRedraw(); drawLassoGhost(); };
    // (We'll let the animation loop call redraw; ghost pts are cleared after)

    const promptText = await new Promise(resolve => {
      function onSubmit() { resolve(aiPromptInput.value.trim()); cleanup(); }
      function onKey(ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); onSubmit(); }
        else if (ev.key === 'Escape') { resolve(null); cleanup(); }
      }
      function cleanup() {
        $('ai-prompt-submit').removeEventListener('click', onSubmit);
        aiPromptInput.removeEventListener('keydown', onKey);
        aiPromptBar.style.display = 'none';
      }
      $('ai-prompt-submit').addEventListener('click', onSubmit);
      aiPromptInput.addEventListener('keydown', onKey);
    });

    if (!promptText) return; // cancelled or empty

    // Show loading overlay
    aiLoading.style.display = 'flex';
    setSync('Generating AI image… ✨', 'solar:magic-stick-3-linear');

    try {
      const res = await fetch(`${API}/api/generate-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: promptText }),
      });
      const data = await res.json();
      if (data.success && data.imageUrl) {
        localStorage.setItem('ai_lasso_used', 'true');
        const s = { type: 'ai_image', imageUrl: data.imageUrl, bounds, timestamp: Date.now() };
        strokes.push(s);
        if (socket) socket.emit('draw_stroke', { canvasId, stroke: s });
        setSync(`AI Generated ✨`, 'solar:magic-stick-3-linear');
      } else {
        const errMsg = data.error || 'Unknown error';
        console.error('[Lasso AI] Error:', errMsg);
        alert(`❌ AI Error:\n${errMsg}`);
        setSync('AI failed', 'solar:close-circle-linear');
      }
    } catch (err) {
      console.error('[Lasso AI] Network error:', err);
      alert('❌ Could not reach AI server.\nMake sure the backend is running on port 4001.');
      setSync('Connection error', 'solar:close-circle-linear');
    } finally {
      aiLoading.style.display = 'none';
    }
    return;
  }

  // ─── Shape ───
  if (tool === 'shape' && pts.length >= 2) {
    const x=Math.min(pts[0].x,pts[1].x), y=Math.min(pts[0].y,pts[1].y);
    const w=Math.abs(pts[1].x-pts[0].x), h=Math.abs(pts[1].y-pts[0].y);
    if (w > 3 && h > 3) {
      const el = { id:uid(), type:'shape', shapeType:'rect', x, y, width:w, height:h,
        fill:'transparent', stroke:color, strokeWidth:size, zIndex:elements.length };
      elements.push(el); if (socket) socket.emit('element_add', { canvasId, element: el });
    }
    pts = []; return;
  }

  // ─── Connector ───
  if (tool === 'connector' && pts.length >= 2) {
    const el = { id:uid(), type:'connector', x:pts[0].x, y:pts[0].y, x2:pts[1].x, y2:pts[1].y,
      stroke:color, strokeWidth:2, zIndex:elements.length };
    elements.push(el); if (socket) socket.emit('element_add', { canvasId, element: el });
    pts = []; return;
  }

  // ─── Frame ───
  if (tool === 'frame' && pts.length >= 2) {
    const x=Math.min(pts[0].x,pts[1].x), y=Math.min(pts[0].y,pts[1].y);
    const w=Math.abs(pts[1].x-pts[0].x), h=Math.abs(pts[1].y-pts[0].y);
    if (w > 15 && h > 15) {
      const el = { id:uid(), type:'frame', x, y, width:w, height:h,
        title:'Frame', fill:'rgba(148,163,184,0.04)', zIndex:0 };
      elements.push(el); if (socket) socket.emit('element_add', { canvasId, element: el });
    }
    pts = []; return;
  }

  // ─── Freehand Stroke ───
  if (pts.length > 0) {
    const stroke = { id: `str_${Date.now()}`, userId, username, points: pts, color, size, tool, timestamp: Date.now() };
    socket.emit('draw_stroke', { canvasId, stroke });
    strokes.push(stroke);
  }
  pts = [];
  setSync('Saved', 'solar:cloud-check-linear');
});

canvas.addEventListener('pointerleave', () => {
  if (drawing && (tool === 'pen' || tool === 'eraser')) {
    // Auto-finish stroke
    if (pts.length > 0 && canvasId && socket) {
      const stroke = { id: `str_${Date.now()}`, userId, username, points: pts, color, size, tool, timestamp: Date.now() };
      socket.emit('draw_stroke', { canvasId, stroke }); strokes.push(stroke);
    }
    drawing = false; pts = [];
  }
});

// ─── Right-click on canvas elements ───
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const cp = toCanvas(e);
  const hit = hitTestCanvas(cp.x, cp.y);
  if (hit) {
    selectedId = hit.id;
    showContextMenu(e.clientX, e.clientY);
    needsOverlayUpdate = true;
  }
});

// ─── Toolbar ───
function getCursor() {
  const cursors = { hand:'grab', select:'default', pen:'crosshair', eraser:'crosshair',
    lasso:'crosshair', shape:'crosshair', connector:'crosshair',
    frame:'crosshair', sticky:'copy', text:'text' };
  return cursors[tool] || 'default';
}

function updateToolbar() {
  document.querySelectorAll('.tb[data-tool]').forEach(b => {
    b.classList.toggle('active', b.dataset.tool === tool);
  });
  canvas.style.cursor = getCursor();
}

document.querySelectorAll('.tb[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => { tool = btn.dataset.tool; updateToolbar(); });
});

colorPicker.addEventListener('input', e => { color = e.target.value; });
sizeSlider.addEventListener('input', e => { size = +e.target.value; sizeVal.textContent = size; });

// ─── Top Bar Actions ───
$('clear-btn').addEventListener('click', () => {
  if (!canvasId || !socket) return;
  socket.emit('draw_stroke', { canvasId, stroke: { action: 'clear', timestamp: Date.now() } });
  strokes = [];
  elements.forEach(el => { if (socket) socket.emit('element_delete', { canvasId, elementId: el.id }); });
  elements = []; selectedId = null;
  needsOverlayUpdate = true;
  setSync('Cleared', 'solar:trash-bin-trash-linear');
});

$('undo-btn').addEventListener('click', () => {
  if (!canvasId || !socket) return;
  // Undo last stroke
  const myStrokes = strokes.filter(s => s.userId === userId);
  if (myStrokes.length) {
    const last = myStrokes[myStrokes.length - 1];
    socket.emit('draw_stroke', { canvasId, stroke: { action: 'undo', id: last.id, timestamp: Date.now() } });
    strokes = strokes.filter(s => s.id !== last.id);
    return;
  }
  // Or undo last element
  const myEls = elements.filter(e => true); // all elements for now
  if (myEls.length) {
    const last = myEls[myEls.length - 1];
    deleteElement(last.id);
  }
});

$('share-btn').addEventListener('click', () => {
  navigator.clipboard.writeText(window.location.href).then(() => {
    const btn = $('share-btn');
    const orig = btn.innerHTML;
    btn.innerHTML = '<iconify-icon icon="solar:check-circle-linear" class="text-sm"></iconify-icon> Copied!';
    setTimeout(() => { btn.innerHTML = orig; }, 2000);
  });
});

$('download-btn').addEventListener('click', () => {
  const link = document.createElement('a');
  link.download = `unidraw-${canvasId||'canvas'}-${Date.now()}.png`;
  link.href = canvas.toDataURL('image/png'); link.click();
  setSync('Downloaded ✅', 'solar:download-minimalistic-linear');
});

// ─── Keyboard Shortcuts ───
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const k = e.key.toLowerCase();

  const toolMap = { p:'pen', e:'eraser', h:'hand', v:'select', r:'shape', t:'text', s:'sticky', c:'connector', f:'frame', l:'lasso' };
  if (toolMap[k] && !e.ctrlKey && !e.metaKey) { tool = toolMap[k]; updateToolbar(); return; }

  if (k === 'delete' || k === 'backspace') {
    if (selectedId) { deleteElement(selectedId); e.preventDefault(); }
  }
  if ((e.ctrlKey||e.metaKey) && k === 'z') { $('undo-btn').click(); e.preventDefault(); }
  if ((e.ctrlKey||e.metaKey) && k === 'd') {
    e.preventDefault();
    const el = elements.find(x => x.id === selectedId);
    if (el) {
      const ne = { ...el, id: uid(), x: el.x+30, y: el.y+30 };
      if (ne.x2) { ne.x2 += 30; ne.y2 += 30; }
      elements.push(ne); if (socket) socket.emit('element_add', { canvasId, element: ne });
      selectedId = ne.id; needsOverlayUpdate = true;
    }
  }
  if (k === 'escape') { selectedId = null; needsOverlayUpdate = true; hideContextMenu(); aiPromptBar.style.display = 'none'; }
});

// ─── Minimap ───
function drawMinimap() {
  const mc = $('minimap-canvas'); if (!mc) return;
  const mctx = mc.getContext('2d');
  mctx.clearRect(0, 0, 150, 90);
  mctx.fillStyle = '#f8fafc'; mctx.fillRect(0,0,150,90);

  let xs = [0], ys = [0];
  strokes.forEach(s => { if (s.points) s.points.forEach(p => { xs.push(p.x); ys.push(p.y); }); if (s.bounds) { xs.push(s.bounds.x+s.bounds.width); ys.push(s.bounds.y+s.bounds.height); } });
  elements.forEach(e => { xs.push(e.x, e.x+(e.width||80)); ys.push(e.y, e.y+(e.height||40)); });

  const mnX = Math.min(...xs)-200, mxX = Math.max(...xs)+200, mnY = Math.min(...ys)-200, mxY = Math.max(...ys)+200;
  const sc = Math.min(150/(mxX-mnX), 90/(mxY-mnY));

  mctx.fillStyle = '#94a3b8';
  strokes.forEach(s => { if (s.points && s.points[0]) mctx.fillRect((s.points[0].x-mnX)*sc, (s.points[0].y-mnY)*sc, 2, 2); });
  mctx.fillStyle = '#ddd6fe';
  elements.forEach(e => mctx.fillRect((e.x-mnX)*sc, (e.y-mnY)*sc, Math.max(2,(e.width||40)*sc), Math.max(2,(e.height||20)*sc)));

  const r = workspace.getBoundingClientRect();
  const vp = $('minimap-vp');
  vp.style.left = ((-panX/zoom - mnX)*sc) + 'px'; vp.style.top = ((-panY/zoom - mnY)*sc) + 'px';
  vp.style.width = ((r.width/zoom)*sc) + 'px'; vp.style.height = ((r.height/zoom)*sc) + 'px';
}




// ─── Landing → App Navigation ───
document.querySelectorAll('.open-app-btn').forEach(btn => btn.addEventListener('click', () => joinCanvas()));

$('close-app-btn').addEventListener('click', () => {
  if (socket) { socket.emit('leave_canvas', { canvasId }); socket.disconnect(); socket = null; }
  if (animId) { cancelAnimationFrame(animId); animId = null; }
  const url = new URL(window.location); url.searchParams.delete('canvas'); window.history.pushState({}, '', url);
  appView.classList.add('hidden'); landingView.classList.remove('hidden');
  strokes=[]; elements=[]; activeUsers=[]; cursorMap.clear(); selectedId=null;
  zoom=1; panX=0; panY=0; elOverlay.innerHTML='';
});

// Auto-join from URL
const urlCid = new URLSearchParams(window.location.search).get('canvas');
if (urlCid) joinCanvas(urlCid);

// ─── Image Drag & Drop ───
workspace.addEventListener('dragover', e => { e.preventDefault(); workspace.style.outline = '3px dashed #7C3AED'; });
workspace.addEventListener('dragleave', () => { workspace.style.outline = ''; });
workspace.addEventListener('drop', e => {
  e.preventDefault(); workspace.style.outline = '';
  const file = e.dataTransfer.files[0];
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const cp = toCanvas(e);
    const s = { type:'ai_image', imageUrl:ev.target.result, bounds:{x:cp.x-150,y:cp.y-150,width:300,height:300}, timestamp:Date.now() };
    strokes.push(s); if(socket) socket.emit('draw_stroke', { canvasId, stroke: s });
  };
  reader.readAsDataURL(file);
});

// ─── Clipboard Paste ───
document.addEventListener('paste', (e) => {
  if (!canvasId) return;
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      const reader = new FileReader();
      reader.onload = (ev) => {
        const s = { type:'ai_image', imageUrl:ev.target.result, bounds:{x:100,y:100,width:300,height:300}, timestamp:Date.now() };
        strokes.push(s); if(socket) socket.emit('draw_stroke', { canvasId, stroke: s });
      };
      reader.readAsDataURL(file);
    }
  }
});

console.log('🎨 UNIDRAW loaded — Miro-level whiteboard with Gemini AI');
