"use strict";

const ICONS = {
  network: '<circle cx="12" cy="12" r="3"/><circle cx="4" cy="5" r="2"/><circle cx="20" cy="5" r="2"/><circle cx="5" cy="20" r="2"/><circle cx="20" cy="19" r="2"/><path d="m6 7 4 3m4 0 4-3M10 14l-4 4m8-4 4 3"/>',
  users:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M16 3a4 4 0 0 1 0 8"/><circle cx="9" cy="7" r="4"/>',
  user:'<circle cx="12" cy="8" r="4"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',
  building:'<path d="M4 21V5l8-3 8 3v16H4Zm5 0v-5h6v5M8 7h1m6 0h1M8 11h1m6 0h1"/>',
  chevrons:'<path d="m8 9 4-4 4 4m-8 6 4 4 4-4"/>',
  layers:'<path d="m12 3 10 5-10 5L2 8l10-5Zm-10 9 10 5 10-5M2 16l10 5 10-5"/>',
  list:'<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  scan:'<path d="M8 3H4a1 1 0 0 0-1 1v4m13-5h4a1 1 0 0 1 1 1v4M3 16v4a1 1 0 0 0 1 1h4m13-5v4a1 1 0 0 1-1 1h-4M8 12h8m-4-4v8"/>',
  download:'<path d="M12 3v12m-5-5 5 5 5-5M5 16v4a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4"/>',
  arrows:'<path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4"/>',
  calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>',
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  refresh:'<path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 3M5 15a8 8 0 0 0 13 3"/>',
  expand:'<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h4"/>',
  downleft:'<path d="m18 6-12 12M6 7v11h11"/>',
  upright:'<path d="M6 18 18 6M7 6h11v11"/>',
  arrowright:'<path d="M4 12h16m-6-6 6 6-6 6"/>',
  spark:'<path d="m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6L12 3Z"/>'
};
const ROLES = {
  coordinator:{label:'Координатор',color:'#72985c',initial:'К'},
  consolidator:{label:'Сборщик',color:'#d29c72',initial:'С'},
  distributor:{label:'Распределитель',color:'#779fba',initial:'Р'},
  transit:{label:'Транзит',color:'#b4a05e',initial:'Т'},
  terminal:{label:'Конечный',color:'#a393bc',initial:'П'},
  peripheral:{label:'Периферия',color:'#afbcaa',initial:'•'}
};
const $ = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
const formatNumber = n => new Intl.NumberFormat('ru-RU').format(n);
const formatMoney = n => n >= 1e6 ? `${(n/1e6).toLocaleString('ru-RU',{maximumFractionDigits:2})} млн ₸` : `${n.toLocaleString('ru-RU',{maximumFractionDigits:0})} ₸`;
const shortId = id => '…' + String(id).slice(-9);
let clients = [], clusters = [], topClients = [], clientMap = new Map(), edges = [], selectedId, centerId;
let currentView = 'graph', activeRole = '', page = 0, zoom = 1, pan = {x:0,y:0}, toastTimer;
const PAGE_SIZE = 20;

function renderIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); });
}

// CSV fields may contain quoted commas and line breaks; identifiers stay strings.
function parseCSV(text) {
  const rows=[]; let row=[], field='', quoted=false;
  text=text.replace(/^\uFEFF/,'');
  for(let i=0;i<text.length;i++) {
    const c=text[i];
    if(c==='"') { if(quoted && text[i+1]==='"'){field+='"';i++;} else quoted=!quoted; }
    else if(c===','&&!quoted){row.push(field);field='';}
    else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field);if(row.some(Boolean))rows.push(row);row=[];field='';}
    else field+=c;
  }
  if(field||row.length){row.push(field);rows.push(row);}
  const headers=rows.shift()||[];
  return rows.map(values=>Object.fromEntries(headers.map((h,i)=>[h,values[i]??''])));
}

async function getCSV(name) {
  const response=await fetch(`../out/${name}.csv`);
  if(!response.ok)throw new Error(`Не удалось загрузить ${name}`);
  return parseCSV(await response.text());
}

function normalizeClient(row) {
  return {...row,id:String(row.gid||row.id),gid:String(row.gid||row.id),
    in_kzt:Number(row.in_kzt)||0,out_kzt:Number(row.out_kzt)||0,
    in_deg:Number(row.in_deg)||0,out_deg:Number(row.out_deg)||0,
    in_tx:Number(row.in_tx)||0,out_tx:Number(row.out_tx)||0,
    depth:Number(row.depth)||0,cluster_id:Number(row.cluster_id)||0,
    priority_score:Number(row.priority_score)||0,
    truncated:row.truncated===true||row.truncated_by_depth==='True',
    is_seed:row.is_seed===true||row.is_seed==='True'};
}

document.addEventListener('DOMContentLoaded', async()=>{
  renderIcons(); bindEvents();
  const data=window.graphData;
  if(!data?.nodes?.length){$('graphCaption').textContent='Нет данных для отображения';showToast('Сначала сформируйте результаты анализа.');return;}
  clients=data.nodes.map(normalizeClient);
  edges=data.edges.map(e=>({...e,from:String(e.from),to:String(e.to)}));
  try {
    const results=await Promise.allSettled([getCSV('nodes_roles'),getCSV('clusters'),getCSV('top_nodes')]);
    if(results[0].status==='fulfilled')clients=results[0].value.map(normalizeClient);
    if(results[1].status==='fulfilled')clusters=results[1].value;
    if(results[2].status==='fulfilled')topClients=results[2].value;
    if(results.some(r=>r.status==='rejected'))showToast('Часть данных недоступна. Показан доступный граф.');
  } catch { showToast('Показан доступный граф из локальной выгрузки.'); }
  clients.sort((a,b)=>b.priority_score-a.priority_score||a.id.localeCompare(b.id));
  clientMap=new Map(clients.map(c=>[c.id,c]));
  clients.forEach((c,i)=>c.rank=i+1);
  selectedId=centerId=clients[0].id;
  renderSummary();renderLegend();renderQueue();renderClusters();
  $('previewTable').innerHTML=tableMarkup(clients.slice(0,5));
  selectClient(selectedId);renderGraph();
});

function bindEvents(){
  document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>setView(b.dataset.view)));
  $('searchForm').addEventListener('submit',e=>{e.preventDefault();findClient($('searchInput').value);});
  $('roleFilter').addEventListener('change',()=>{activeRole=$('roleFilter').value;renderGraph();renderLegendState();});
  $('legend').addEventListener('click',e=>{const b=e.target.closest('[data-role]');if(!b)return;activeRole=activeRole===b.dataset.role?'':b.dataset.role;$('roleFilter').value=activeRole;renderGraph();renderLegendState();});
  $('resetGraph').addEventListener('click',()=>{activeRole='';$('roleFilter').value='';centerId=clients[0].id;selectClient(centerId);resetTransform();renderGraph();renderLegendState();});
  $('showConnections').addEventListener('click',()=>{centerId=selectedId;activeRole='';$('roleFilter').value='';resetTransform();renderGraph();renderLegendState();});
  $('copyId').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(selectedId);showToast('GID скопирован');}catch{showToast('Выделите GID в карточке и скопируйте его.');}});
  $('zoomIn').addEventListener('click',()=>setZoom(zoom*1.25));
  $('zoomOut').addEventListener('click',()=>setZoom(zoom/1.25));
  $('fitGraph').addEventListener('click',resetTransform);
  $('tableSearch').addEventListener('input',()=>{page=0;renderQueue();});
  $('previousPage').addEventListener('click',()=>{page=Math.max(0,page-1);renderQueue();});
  $('nextPage').addEventListener('click',()=>{page++;renderQueue();});
  document.addEventListener('click',e=>{const b=e.target.closest('[data-client]');if(b){setView('graph');centerId=b.dataset.client;selectClient(centerId);activeRole='';$('roleFilter').value='';resetTransform();renderGraph();renderLegendState();$('graphView').scrollIntoView({behavior:'smooth',block:'start'});}});
  let drag=null;
  const canvas=$('graphCanvas');
  canvas.addEventListener('pointerdown',e=>{if(e.target.closest('.graph-node'))return;drag={x:e.clientX,y:e.clientY,px:pan.x,py:pan.y};canvas.setPointerCapture(e.pointerId);});
  canvas.addEventListener('pointermove',e=>{if(!drag)return;const scale=900/canvas.clientWidth;pan={x:drag.px+(e.clientX-drag.x)*scale,y:drag.py+(e.clientY-drag.y)*scale};applyTransform();});
  canvas.addEventListener('pointerup',()=>{drag=null;});
  canvas.addEventListener('pointercancel',()=>{drag=null;});
}

function renderSummary(){
  $('totalNodes').textContent=formatNumber(clients.length);
  $('navCount').textContent=formatNumber(clients.length);
  $('seedCount').textContent=clients.filter(c=>c.is_seed).length;
  const volume=clients.reduce((s,c)=>s+c.in_kzt,0);
  $('totalVolume').innerHTML=volume>=1e6 ? `${(volume/1e6).toLocaleString('ru-RU',{maximumFractionDigits:2})}<span>млн ₸</span>` : escapeHtml(formatMoney(volume));
  $('totalClusters').textContent=clusters.length||new Set(clients.map(c=>c.cluster_id)).size;
  $('reviewCount').innerHTML=`${topClients.length||Math.min(30,clients.length)}<span>клиентов</span>`;
}

function renderLegend(){
  $('legend').innerHTML=Object.entries(ROLES).map(([r,m])=>`<button data-role="${r}" aria-pressed="false"><i style="background:${m.color}"></i>${m.label}</button>`).join('');
  $('roleFilter').innerHTML='<option value="">Все роли</option>'+Object.entries(ROLES).map(([r,m])=>`<option value="${r}">${m.label}</option>`).join('');
}
function renderLegendState(){document.querySelectorAll('[data-role]').forEach(b=>{b.classList.toggle('active',b.dataset.role===activeRole);b.setAttribute('aria-pressed',String(b.dataset.role===activeRole));});}

function setView(view){
  currentView=view;
  ['graph','queue','clusters'].forEach(v=>{$(v+'View').hidden=v!==view;});
  document.querySelectorAll('[data-view]').forEach(b=>{b.classList.toggle('active',b.dataset.view===view);if(b.getAttribute('role')==='tab')b.setAttribute('aria-selected',String(b.dataset.view===view));});
  $('breadcrumbTitle').textContent={graph:'Граф денег',queue:'Клиенты',clusters:'Кластеры'}[view];
}

function selectClient(id){
  const c=clientMap.get(id);if(!c)return;selectedId=id;
  const meta=ROLES[c.role]||ROLES.peripheral;
  $('clientShort').textContent='Клиент '+shortId(id);
  $('clientId').textContent=id;
  $('clientRole').textContent=meta.label;
  $('clientRole').style.setProperty('--role-color',meta.color);
  $('priority').innerHTML=`${(c.priority_score*100).toFixed(1).replace('.',',')}<span> / 100</span>`;
  $('priorityBar').style.width=`${c.priority_score*100}%`;
  $('inAmount').textContent=formatMoney(c.in_kzt);$('outAmount').textContent=formatMoney(c.out_kzt);
  $('inDegree').textContent=`от ${c.in_deg} клиентов`;$('outDegree').textContent=`${c.out_deg} получателей`;
  $('clientCluster').textContent='#'+String(c.cluster_id).padStart(2,'0');
  $('clientDepth').textContent=c.is_seed?'Seed · 0':c.depth+' колено';
  $('evidence').textContent=c.evidence||'Описание недоступно';
  $('boundaryNote').hidden=!c.truncated;
  document.querySelectorAll('.graph-node').forEach(g=>{const circle=g.querySelector('.node-circle');circle.style.stroke=g.dataset.id===id?'#425f35':'#fff';});
}

function findClient(query){
  const q=query.trim();if(!q)return;
  let found=clientMap.get(q);
  if(!found){const matches=clients.filter(c=>c.id.endsWith(q));if(matches.length===1)found=matches[0];else if(matches.length>1){showToast('Уточните GID: найдено несколько клиентов.');return;}}
  if(!found){showToast('Клиент с таким GID не найден.');return;}
  centerId=found.id;selectClient(found.id);activeRole='';$('roleFilter').value='';resetTransform();renderGraph();renderLegendState();
}

function renderGraph(){
  const center=clientMap.get(centerId);if(!center)return;
  const connected=edges.filter(e=>e.from===centerId||e.to===centerId);
  const weights=new Map();
  connected.forEach(e=>{const id=e.from===centerId?e.to:e.from;weights.set(id,(weights.get(id)||0)+Number(e.sum_kzt));});
  let direct=[...weights.keys()].filter(id=>clientMap.has(id));
  if(activeRole)direct=direct.filter(id=>clientMap.get(id).role===activeRole);
  direct.sort((a,b)=>(weights.get(b)-weights.get(a))||a.localeCompare(b));
  const primary=direct.slice(0,24);
  const primarySet=new Set(primary);
  const extras=activeRole?[]:[...new Set(edges.filter(e=>primarySet.has(e.from)||primarySet.has(e.to)).flatMap(e=>[e.from,e.to]))]
    .filter(id=>id!==centerId&&!primarySet.has(id)&&clientMap.has(id))
    .sort((a,b)=>clientMap.get(b).priority_score-clientMap.get(a).priority_score).slice(0,20);
  const positions=new Map([[centerId,{x:450,y:285,r:27}]]);
  // Stable concentric positions make the selected neighbourhood legible immediately.
  primary.forEach((id,i)=>{const angle=-Math.PI/2+(i/Math.max(primary.length,1))*Math.PI*2;const wobble=(i%3-1)*16;positions.set(id,{x:450+Math.cos(angle)*(222+wobble),y:285+Math.sin(angle)*(172+wobble*.5),r:10+clientMap.get(id).priority_score*5});});
  extras.forEach((id,i)=>{const angle=-Math.PI/2+((i+.35)/Math.max(extras.length,1))*Math.PI*2;positions.set(id,{x:450+Math.cos(angle)*355,y:285+Math.sin(angle)*247,r:6+clientMap.get(id).priority_score*3});});
  const visibleEdges=edges.filter(e=>positions.has(e.from)&&positions.has(e.to));
  $('graphEdges').innerHTML=visibleEdges.map(e=>{const a=positions.get(e.from),b=positions.get(e.to);const main=e.from===centerId||e.to===centerId;const mx=(a.x+b.x)/2+(b.y-a.y)*.045,my=(a.y+b.y)/2-(b.x-a.x)*.045;return `<path class="graph-edge ${main?'major':''}" d="M${a.x},${a.y} Q${mx},${my} ${b.x},${b.y}" marker-end="url(#arrow)"><title>${escapeHtml(e.from)} → ${escapeHtml(e.to)} · ${formatMoney(Number(e.sum_kzt))} · ${e.n_tx} операций</title></path>`;}).join('');
  $('graphNodes').innerHTML=[...positions].map(([id,p])=>{
    const c=clientMap.get(id),m=ROLES[c.role]||ROLES.peripheral,isCenter=id===centerId,major=primarySet.has(id),showLabel=isCenter||(major&&primary.indexOf(id)%2===0);
    return `<g class="graph-node" data-id="${id}" role="button" tabindex="0" aria-label="Клиент ${id}, ${m.label}" transform="translate(${p.x},${p.y})"><title>${id}\n${m.label}\n${formatMoney(c.out_kzt)} отправлено</title>${isCenter?'<circle class="center-pulse" r="45"/>':''}<circle class="node-halo" r="${p.r+(isCenter?11:5)}" fill="${m.color}"/><circle class="node-circle" r="${p.r}" fill="${m.color}"/>${isCenter?`<text class="node-initials" text-anchor="middle" dominant-baseline="central" style="font-size:17px!important">${m.initial}</text>`:''}${showLabel?`<text class="${isCenter?'center-label':''}" text-anchor="middle" y="${p.r+17}">${isCenter?'GID ':''}${shortId(id)}</text>`:''}${isCenter?`<text text-anchor="middle" y="${p.r+33}" style="font-size:9px">${m.label}</text>`:''}</g>`;
  }).join('');
  $('graphNodes').querySelectorAll('.graph-node').forEach(g=>{g.addEventListener('click',()=>selectClient(g.dataset.id));g.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();selectClient(g.dataset.id);}});});
  $('graphCaption').textContent=connected.length?`Фрагмент сети · узлов: ${positions.size} · связей: ${visibleEdges.length}`:'Связи клиента отсутствуют в визуальной выгрузке';
  $('network').setAttribute('role','group');
  $('network').setAttribute('aria-label',`Граф клиента ${centerId}: ${positions.size} узлов, ${visibleEdges.length} рёбер. Показана часть связей.`);
  selectClient(selectedId);
}
function setZoom(value){zoom=Math.max(.5,Math.min(2.8,value));applyTransform();}
function applyTransform(){$('graphTransform').style.transform=`translate(${pan.x}px,${pan.y}px) scale(${zoom})`;}
function resetTransform(){zoom=1;pan={x:0,y:0};applyTransform();}

function tableMarkup(rows){
  return `<table><thead><tr><th>№</th><th>Клиент / GID</th><th>Роль в сети</th><th>Входящий поток</th><th>Исходящий поток</th><th>Приоритет</th><th></th></tr></thead><tbody>${rows.length?rows.map(c=>`<tr><td>${String(c.rank).padStart(2,'0')}</td><td><button class="client-link" data-client="${c.id}">${c.id}</button></td><td><span class="role-badge table-role" style="--role-color:${(ROLES[c.role]||ROLES.peripheral).color}">${(ROLES[c.role]||ROLES.peripheral).label}</span></td><td>${formatMoney(c.in_kzt)}</td><td>${formatMoney(c.out_kzt)}</td><td><span class="table-priority"><i><b style="width:${c.priority_score*100}%"></b></i>${(c.priority_score*100).toFixed(1)}</span></td><td><button class="icon-button row-arrow" data-client="${c.id}" aria-label="Открыть клиента ${c.id}">${icon('arrowright')}</button></td></tr>`).join(''):'<tr><td class="table-empty" colspan="7">Клиенты не найдены. Попробуйте другой GID.</td></tr>'}</tbody></table>`;
}
function renderQueue(){
  const query=$('tableSearch').value.trim();const filtered=clients.filter(c=>c.id.includes(query));
  const pages=Math.max(1,Math.ceil(filtered.length/PAGE_SIZE));page=Math.min(page,pages-1);
  $('clientTable').innerHTML=tableMarkup(filtered.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE));
  $('queueSummary').textContent=`${formatNumber(filtered.length)} клиентов · по убыванию приоритета`;
  $('pageLabel').textContent=`${page+1} / ${pages}`;
  $('previousPage').disabled=page===0;$('nextPage').disabled=page===pages-1;
}
function renderClusters(){
  $('clusterGrid').innerHTML=clusters.map(c=>`<article class="cluster-card"><div class="cluster-card-head">Кластер #${String(c.cluster_id).padStart(2,'0')}<span>${icon('layers')}</span></div><p>${escapeHtml(c.hypothesis)}</p><div class="cluster-stats"><span>Клиентов <strong>${formatNumber(Number(c.n_nodes))}</strong></span><span>Seed <strong>${c.n_seed}</strong></span></div><div class="cluster-stats"><span>Внутренний оборот</span><strong>${formatMoney(Number(c.sum_kzt_internal))}</strong></div><button class="text-button" data-client="${escapeHtml(c.top_gids.split(';')[0])}">Открыть лидера ${icon('arrowright')}</button></article>`).join('')||'<div class="table-empty">Данные кластеров недоступны.</div>';
}
function showToast(message){clearTimeout(toastTimer);$('toast').textContent=message;$('toast').classList.add('visible');toastTimer=setTimeout(()=>$('toast').classList.remove('visible'),3500);}
