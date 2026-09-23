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
  coordinator:{label:'Координатор',color:'#c1ee79',initial:'К'},
  consolidator:{label:'Сборщик',color:'#f5ad77',initial:'С'},
  distributor:{label:'Распределитель',color:'#71b9ec',initial:'Р'},
  transit:{label:'Транзит',color:'#f0d27e',initial:'Т'},
  terminal:{label:'Конечный',color:'#bba3f1',initial:'П'},
  peripheral:{label:'Периферия',color:'#859ca9',initial:'•'}
};
const $ = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
const formatNumber = n => new Intl.NumberFormat('ru-RU').format(n);
const formatMoney = n => n >= 1e6 ? `${(n/1e6).toLocaleString('ru-RU',{maximumFractionDigits:2})} млн ₸` : `${n.toLocaleString('ru-RU',{maximumFractionDigits:0})} ₸`;
const shortId = id => '…' + String(id).slice(-9);
let clients = [], clusters = [], topClients = [], clientMap = new Map(), edges = [], selectedId, centerId;
let currentView = 'graph', activeRole = '', page = 0, zoom = 1, pan = {x:0,y:0}, toastTimer;
let datasetVersion='', datasetMeta={}, chatContext=null, chatBusy=false, chatController=null, loadSequence=0;
let polling=false, importPending=false, serverAvailable=false;
let detailController=null, detailData=null, detailPage=0;
let colorMode='role';
let analysisController=null, analysisData=null, analysisKey='', analysisTab='role', routePath=null;
const clusterColor=id=>`hsl(${(Number(id)*137.508+75)%360} 63% 70%)`;
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
  renderIcons(); bindEvents(); bindWorkspace();
  try { await loadDataset(); await pollStatus(); }
  catch(error){connectionError(error);}
  setInterval(()=>{if(!document.hidden)pollStatus();},4000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)pollStatus();});
});

async function api(path, options={}){
  const controller=options.controller||new AbortController();
  const timeout=setTimeout(()=>controller.abort(),options.timeout||15000);
  try{
    const response=await fetch(path,{method:options.body?'POST':'GET',headers:options.body?{'Content-Type':'application/json'}:{},body:options.body?JSON.stringify(options.body):undefined,signal:controller.signal});
    const data=await response.json().catch(()=>({error:'Ответ сервера не распознан. Запустите python server.py.'}));
    if(!response.ok)throw new Error(data.error||`Ошибка сервера ${response.status}`);
    return data;
  } finally {clearTimeout(timeout);}
}

function connectionError(error){
  serverAvailable=false;
  $('connectionNotice').hidden=false;$('connectionNotice').classList.add('error');
  $('connectionNotice').textContent='Нет связи с backend. Запустите .venv\\Scripts\\python.exe server.py. Повторное подключение автоматически. '+(error?.message||'');
  $('agentStatus').textContent='Нет связи';
  if(!clients.length)$('graphCaption').textContent='Ожидание аналитического сервера…';
}

async function loadDataset(){
  const seq=++loadSequence;
  const data=await api('/api/state');
  if(seq!==loadSequence)return;
  if(!Array.isArray(data.nodes)||!data.nodes.length)throw new Error('Сервер вернул пустой граф');
  if(chatController)chatController.abort();
  if(detailController)detailController.abort();detailData=null;
  if(analysisController)analysisController.abort();analysisKey='';analysisData=null;routePath=null;
  $('showSeedPath').textContent='Путь от seed →';
  $('nodeDetails').open=false;
  datasetVersion=data.version;datasetMeta=data.meta;serverAvailable=true;
  const audit=data.audit;
  $('auditSummary').textContent=audit?`Проверка устойчивости · минимум ${audit.stability.min_overlap} из ${audit.stability.top_size} клиентов TOP сохраняются в ${audit.stability.runs} сценариях изменения весов на ±20%. Расчёт: ${audit.elapsed_seconds.toFixed(1)} с. Это не оценка точности ролей.`:'';
  clients=data.nodes.map(normalizeClient);clusters=data.clusters;topClients=data.top;
  edges=data.edges.map(e=>({...e,from:String(e.from),to:String(e.to)}));
  clients.sort((a,b)=>b.priority_score-a.priority_score||(BigInt(a.id)<BigInt(b.id)?-1:BigInt(a.id)>BigInt(b.id)?1:0));
  clientMap=new Map(clients.map(c=>[c.id,c]));
  clients.forEach((c,i)=>c.rank=i+1);
  selectedId=centerId=clients[0].id;activeRole='';page=0;chatContext=selectedId;
  $('tableSearch').value='';$('searchInput').value='';resetTransform();
  renderSummary();renderLegend();renderQueue();renderClusters();
  $('previewTable').innerHTML=tableMarkup(clients.slice(0,5));
  selectClient(selectedId);renderGraph();
  const period=datasetMeta.date_from?`${datasetMeta.date_from} — ${datasetMeta.date_to}`:'Переводов нет';
  $('sidebarPeriod').textContent=period;$('headerPeriod').textContent=period;$('volumePeriod').textContent=period;
  $('datasetLabel').textContent=datasetMeta.label;
  $('datasetDetails').textContent=`${formatNumber(datasetMeta.edges)} пар · ${formatNumber(datasetMeta.transactions)} операций · глубина до ${datasetMeta.max_depth}`;
  $('agentBrief').textContent=`${formatNumber(datasetMeta.truncated)} клиентов на границе выборки. Разберите роли и ограничения с ассистентом.`;
  document.querySelectorAll('a[download]').forEach(a=>{const url=new URL(a.href);url.searchParams.set('version',datasetVersion);a.href=url.toString();});
  $('connectionNotice').hidden=true;$('connectionNotice').classList.remove('error');
  clearChat();
}

function bindEvents(){
  document.querySelectorAll('[data-analysis-tab]').forEach(b=>b.addEventListener('click',()=>{analysisTab=b.dataset.analysisTab;renderAnalysis();}));
  $('showSeedPath').addEventListener('click',()=>{
    if(routePath){routePath=null;renderGraph();$('showSeedPath').textContent='Путь от seed →';return;}
    if(!analysisData?.seed_path.nodes.length){showToast('Для выбранного клиента путь не найден.');return;}
    routePath=analysisData.seed_path;analysisTab='path';activeRole='';$('roleFilter').value='';resetTransform();renderGraph();renderAnalysis();
    $('showSeedPath').textContent='Вернуть окружение';$('graphCanvas').scrollIntoView({behavior:'smooth',block:'center'});
  });
  $('colorMode').addEventListener('change',()=>{colorMode=$('colorMode').value;renderGraph();});
  document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>setView(b.dataset.view)));
  $('searchForm').addEventListener('submit',e=>{e.preventDefault();findClient($('searchInput').value);});
  $('roleFilter').addEventListener('change',()=>{clearRoute();activeRole=$('roleFilter').value;renderGraph();renderLegendState();});
  $('legend').addEventListener('click',e=>{const b=e.target.closest('[data-role]');if(!b)return;clearRoute();activeRole=activeRole===b.dataset.role?'':b.dataset.role;$('roleFilter').value=activeRole;renderGraph();renderLegendState();});
  $('resetGraph').addEventListener('click',()=>{if(!clients.length)return;clearRoute();activeRole='';$('roleFilter').value='';centerId=clients[0].id;selectClient(centerId);resetTransform();renderGraph();renderLegendState();});
  $('showConnections').addEventListener('click',()=>{routePath=null;$('showSeedPath').textContent='Путь от seed →';centerId=selectedId;activeRole='';$('roleFilter').value='';resetTransform();renderGraph();renderLegendState();});
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
  $('roleFilter').innerHTML='<option value="">Все роли</option>'+Object.entries(ROLES).map(([r,m])=>`<option value="${r}">${m.label}</option>`).join('');
}
function renderGraphLegend(visibleIds){
  if(colorMode==='cluster'){
    const ids=[...new Set(visibleIds.map(id=>clientMap.get(id).cluster_id))].sort((a,b)=>a-b);
    $('legend').innerHTML='<span class="legend-caption">Кластеры фрагмента</span>'+ids.map(id=>`<span class="cluster-legend"><i style="background:${clusterColor(id)}"></i>#${String(id).padStart(2,'0')}</span>`).join('');
  }else{
    $('legend').innerHTML=Object.entries(ROLES).map(([r,m])=>`<button data-role="${r}" aria-pressed="false"><i style="background:${m.color}"></i>${m.label}</button>`).join('');
    renderLegendState();
  }
}
function renderLegendState(){document.querySelectorAll('[data-role]').forEach(b=>{b.classList.toggle('active',b.dataset.role===activeRole);b.setAttribute('aria-pressed',String(b.dataset.role===activeRole));});}

function setView(view){
  currentView=view;
  document.querySelector('main').classList.toggle('assistant-open',view==='assistant');
  $('pageTitle').textContent={graph:'За переводами — связи.',queue:'Фокус на главном.',clusters:'Структура сети.',assistant:'Вопрос. Данные. Объяснение.'}[view];
  $('pageDescription').textContent={graph:'Исследуйте сеть. Находите ключевых участников.',queue:'Клиенты в порядке приоритета для углублённой проверки.',clusters:'Сообщества, направления потоков и ключевые участники.',assistant:'Разберите гипотезу и перейдите к её основаниям.'}[view];
  ['graph','queue','clusters','assistant'].forEach(v=>{$(v+'View').hidden=v!==view;});
  document.querySelectorAll('[data-view]').forEach(b=>{b.classList.toggle('active',b.dataset.view===view);if(b.getAttribute('role')==='tab')b.setAttribute('aria-selected',String(b.dataset.view===view));});
  $('breadcrumbTitle').textContent={graph:'Граф денег',queue:'Клиенты',clusters:'Кластеры',assistant:'AI-ассистент'}[view];
}

function selectClient(id){
  const c=clientMap.get(id);if(!c)return;
  if(selectedId!==id){if(detailController)detailController.abort();detailData=null;$('nodeDetails').open=false;routePath=null;$('showSeedPath').textContent='Путь от seed →';}
  selectedId=id;
  chatContext=id;updateChatContext();
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
  $('boundaryNote').textContent='Граница глубины 4: исходящие неизвестны. Терминальность не подтверждена.';
  if(c.is_seed){$('boundaryNote').hidden=false;$('boundaryNote').textContent='Seed: входящие извне выборки отсутствуют. Отношение исходящих к входящим не доказывает аномалию.';}
  document.querySelectorAll('.graph-node').forEach(g=>{const circle=g.querySelector('.node-circle');circle.style.stroke=g.dataset.id===id?'#f5ffe4':'#152630';g.classList.toggle('selected',g.dataset.id===id);});
  loadAnalysis(id);
}

function findClient(query){
  const q=query.trim();if(!q)return;
  let found=clientMap.get(q);
  if(!found){const matches=clients.filter(c=>c.id.endsWith(q));if(matches.length===1)found=matches[0];else if(matches.length>1){showToast('Уточните GID: найдено несколько клиентов.');return;}}
  if(!found){showToast('Клиент с таким GID не найден.');return;}
  clearRoute();centerId=found.id;selectClient(found.id);activeRole='';$('roleFilter').value='';resetTransform();renderGraph();renderLegendState();
}

function renderGraph(){
  if(routePath){renderRouteGraph();return;}
  const center=clientMap.get(centerId);if(!center)return;
  const connected=edges.filter(e=>e.from===centerId||e.to===centerId);
  const weights=new Map();
  connected.forEach(e=>{const id=e.from===centerId?e.to:e.from;weights.set(id,(weights.get(id)||0)+Number(e.sum_kzt));});
  let direct=[...weights.keys()].filter(id=>id!==centerId&&clientMap.has(id));
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
  $('arrow').setAttribute('refX','7');
  $('graphEdges').innerHTML=visibleEdges.map(e=>{
    const a=positions.get(e.from),b=positions.get(e.to),main=e.from===centerId||e.to===centerId;
    const mx=(a.x+b.x)/2+(b.y-a.y)*.045,my=(a.y+b.y)/2-(b.x-a.x)*.045;
    const startLength=Math.hypot(mx-a.x,my-a.y)||1,endLength=Math.hypot(b.x-mx,b.y-my)||1;
    const sx=a.x+(mx-a.x)/startLength*(a.r+3),sy=a.y+(my-a.y)/startLength*(a.r+3);
    const ex=b.x-(b.x-mx)/endLength*(b.r+4),ey=b.y-(b.y-my)/endLength*(b.r+4);
    const path=e.from===e.to?`M${a.x-a.r},${a.y-5} C${a.x-70},${a.y-85} ${a.x+70},${a.y-85} ${a.x+a.r+4},${a.y-5}`:`M${sx},${sy} Q${mx},${my} ${ex},${ey}`;
    return `<path class="graph-edge ${main?'major':''}" d="${path}" marker-end="url(#arrow)"><title>${escapeHtml(e.from)} → ${escapeHtml(e.to)} · ${formatMoney(Number(e.sum_kzt))} · ${e.n_tx} операций</title></path>`;
  }).join('');
  $('graphNodes').innerHTML=[...positions].map(([id,p])=>{
    const c=clientMap.get(id),role=ROLES[c.role]||ROLES.peripheral,m={...role,color:colorMode==='cluster'?clusterColor(c.cluster_id):role.color},isCenter=id===centerId,major=primarySet.has(id),showLabel=isCenter||(major&&primary.indexOf(id)%2===0);
    return `<g class="graph-node" data-id="${id}" data-cluster="${c.cluster_id}" role="button" tabindex="0" aria-label="Клиент ${id}, ${m.label}, кластер ${c.cluster_id}" transform="translate(${p.x},${p.y})"><title>${id}\n${m.label} · Кластер #${c.cluster_id}\n${formatMoney(c.out_kzt)} отправлено</title>${isCenter?'<circle class="center-pulse" r="45"/>':''}<circle class="node-halo" r="${p.r+(isCenter?11:5)}" fill="${m.color}"/><circle class="node-circle" r="${p.r}" fill="${m.color}"/>${isCenter?`<text class="node-initials" text-anchor="middle" dominant-baseline="central" style="font-size:17px!important">${m.initial}</text>`:''}${showLabel?`<text class="${isCenter?'center-label':''}" text-anchor="middle" y="${p.r+17}">${isCenter?'GID ':''}${shortId(id)}</text>`:''}${isCenter?`<text text-anchor="middle" y="${p.r+33}" style="font-size:11px">${colorMode==='cluster'?'Кластер #'+String(c.cluster_id).padStart(2,'0'):m.label}</text>`:''}</g>`;
  }).join('');
  $('graphNodes').querySelectorAll('.graph-node').forEach(g=>{g.addEventListener('click',()=>selectClient(g.dataset.id));g.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();selectClient(g.dataset.id);}});});
  $('graphCaption').textContent=connected.length?`Фрагмент · ${positions.size} узлов · ${visibleEdges.length} связей. Прямых контрагентов показано ${primary.length} из ${direct.length}`:'У клиента нет переводов в наблюдаемом графе';
  $('network').setAttribute('role','group');
  $('network').setAttribute('aria-label',`Граф клиента ${centerId}: ${positions.size} узлов, ${visibleEdges.length} рёбер. Показана часть связей.`);
  renderGraphLegend([...positions.keys()]);
  selectClient(selectedId);
}
function clearRoute(){routePath=null;$('showSeedPath').textContent='Путь от seed →';}

async function loadAnalysis(id){
  const key=datasetVersion+':'+id;if(key===analysisKey)return;
  analysisKey=key;analysisData=null;
  if(analysisController)analysisController.abort();
  const controller=new AbortController();analysisController=controller;
  $('analysisClient').textContent='GID '+id;$('analysisContent').textContent='Загрузка проверяемых оснований…';$('showSeedPath').disabled=true;
  try{
    const data=await api(`/api/node/${encodeURIComponent(id)}?version=${encodeURIComponent(datasetVersion)}`,{controller});
    if(analysisKey!==key||controller.signal.aborted)return;
    analysisData=data;$('showSeedPath').disabled=!data.seed_path.nodes.length;renderAnalysis();
  }catch(error){
    if(analysisKey!==key||controller.signal.aborted)return;
    analysisKey='';$('analysisContent').textContent='Разбор временно недоступен: '+error.message;
    const retry=document.createElement('button');retry.className='button';retry.textContent='Повторить';retry.addEventListener('click',()=>loadAnalysis(selectedId));$('analysisContent').append(retry);
  }
}

function renderAnalysis(){
  document.querySelectorAll('[data-analysis-tab]').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.analysisTab===analysisTab)));
  if(!analysisData)return;
  const {analysis:a,client:c,seed_path:path,daily}=analysisData;
  const pct=n=>(n*100).toFixed(1).replace('.',',');
  const role=r=>(ROLES[r]||ROLES.peripheral).label;
  const warning=c.is_seed?'Вход seed неполон: доли от входящего объёма не отражают весь оборот.':c.truncated?'Глубина 4: отсутствие исходящих не подтверждает, что деньги осели.':'';
  const next={consolidator:'Проверить связь плательщиков и получателей, назначение переводов и экономический смысл сбора.',
    distributor:'Проверить получателей, основания выплат и повторяемость распределения.',transit:'Запросить время операций и полный оборот: дневные суммы не доказывают транзит тех же денег.',
    coordinator:'Проверить связанные ветви и межкластерные связи. Структурная роль не устанавливает контроль над клиентами.',
    terminal:'Запросить последующие исходящие и полный период наблюдения до вывода о конечном получателе.',
    peripheral:'Сопоставить с контекстом клиента; низкий приоритет не исключает риска.'}[c.role];
  if(analysisTab==='role'){
    $('analysisContent').innerHTML=`<div class="explanation-grid"><div><span class="eyebrow">РАБОЧАЯ ГИПОТЕЗА</span><h3>${role(a.winner)} <span class="score-inline">${pct(a.winner_score)} / 100</span></h3><p>Альтернатива: ${role(a.runner_up)} · ${pct(a.runner_score)}. Разница ${pct(a.margin)} п.п. ${a.margin<.05?'Гипотезы близки — роль требует особой проверки.':''}</p><div class="contribution-list">${a.terms.map(t=>`<div><span>${escapeHtml(t.label)}</span><strong>+${pct(t.contribution)}</strong><i style="width:${Math.max(0,Math.min(100,t.contribution*100))}%"></i></div>`).join('')}</div><p class="analysis-note">Слагаемые скоринговой формулы; сумма ограничена 100. Это не вероятность. Признаки нормированы относительно текущей выборки.</p></div><div><span class="eyebrow">СРАВНЕНИЕ ВСЕХ РОЛЕЙ</span><div class="role-comparison">${a.roles.map(r=>`<div title="${escapeHtml(r.rule)}"><div><span>${role(r.role)}</span><strong>${pct(r.score)}</strong></div><i><b style="width:${r.score*100}%;background:${ROLES[r.role].color}"></b></i><small>${r.eligible?escapeHtml(r.rule):'Условие роли не выполнено: '+escapeHtml(r.rule)}</small></div>`).join('')}</div></div></div><div class="analysis-takeaway"><strong>Следующий шаг</strong><p>${next}</p><span>Место при изменении весов: ${a.stability.rank_min}–${a.stability.rank_max}; в TOP-${Math.min(20,clients.length)} в ${a.stability.top_hits} из ${a.stability.runs} сценариев. Это не доверительный интервал.</span>${warning?`<p>${warning}</p>`:''}</div>`;
  }else if(analysisTab==='time'){
    const t=a.temporal,max=Math.max(1,...daily.flatMap(d=>[d.incoming,d.outgoing]));
    $('analysisContent').innerHTML=`<div class="temporal-heading"><div><span class="eyebrow">НАБЛЮДАЕМЫЕ ОБЪЁМЫ · 1–2 ДНЯ</span><h3>${formatMoney(t.matched_kzt)}</h3><p>Сопоставлено с последующим выходом · ${pct(t.ratio)}% наблюдаемого входа. Совпадений: ${t.total_windows}.</p></div><div class="daily-legend"><span>● Вход</span><span>● Выход</span></div></div><div class="daily-chart" role="img" aria-label="Входящие и исходящие суммы по активным дням. Точные числа доступны в разделе всех переводов.">${daily.map(d=>`<div class="day-column" title="${d.date}: вход ${formatMoney(d.incoming)}, выход ${formatMoney(d.outgoing)}"><div class="day-bars"><i style="height:${d.incoming/max*100}%"></i><b style="height:${d.outgoing/max*100}%"></b></div><small>${d.date.slice(8)}.${d.date.slice(5,7)}</small></div>`).join('')||'<p>Переводов нет.</p>'}</div><p class="analysis-note">Показаны активные дни, а не непрерывная шкала времени. ${escapeHtml(t.method)} Временной сигнал 1–2 дня служит дополнительной проверкой и не меняет присвоенную роль.</p>${warning?`<p class="analysis-warning">${warning}</p>`:''}<div class="table-wrap"><table><thead><tr><th>Входящий день</th><th>Исходящий день</th><th>Задержка</th><th>Сопоставленная сумма</th></tr></thead><tbody>${t.windows.slice(0,5).map(w=>`<tr><td>${w.from_date}</td><td>${w.to_date}</td><td>${w.lag_days} дн.</td><td>${formatMoney(w.matched_kzt)}</td></tr>`).join('')||'<tr><td colspan="4">Совпадений в окне 1–2 дня нет. Это не исключает другие временные паттерны.</td></tr>'}</tbody></table></div><p class="analysis-note">До 5 крупнейших совпадений. Для проверки исходных сумм откройте «Все переводы и активные дни» ниже.</p>`;
  }else{
    $('analysisContent').innerHTML=`<h3>${path.edges.length?`${path.edges.length} перехода от seed до клиента`:path.nodes.length?'Выбранный клиент — seed':'Путь не найден'}</h3><p>${escapeHtml(path.note)}</p><div class="route-list">${path.nodes.map((id,i)=>`<div><span class="route-step">${i}</span><button class="client-link" data-client="${id}">${id}</button><span>${role(clientMap.get(id).role)}</span>${path.edges[i]?`<small>↓ ${formatMoney(path.edges[i].sum_kzt)} · ${path.edges[i].n_tx} операций за период</small>`:''}</div>`).join('')}</div><p class="analysis-note">Это путь по агрегированным рёбрам, а не доказанная последовательность транзакций. Все найденные прямые связи доступны в таблице ниже.</p>`;
  }
  if(analysisTab==='role'){
    $('analysisContent').insertAdjacentHTML('afterbegin',`<div class="analysis-facts"><span><strong>${c.in_tx} / ${c.out_tx}</strong>операций вход / выход</span><span><strong>${c.upstream_seed_count}</strong>сходящихся seed-ветвей</span><span><strong>${c.cross_cluster_count}</strong>соседних кластеров</span><span><strong>${pct(c.same_day_ratio)}%</strong>совпадение в один день</span></div>`);
    $('analysisContent').insertAdjacentHTML('beforeend',`<details class="priority-explanation"><summary>Как рассчитан приоритет проверки</summary><p>Сырой балл ${a.priority_raw.toFixed(4)} переводится в перцентиль внутри текущего датасета. Итог ${(c.priority_score*100).toFixed(1)} / 100 — относительное место, не вероятность нарушения.</p><div class="contribution-list">${a.priority_terms.map(t=>`<div><span>${escapeHtml(t.label)}</span><strong>${t.contribution.toFixed(4)}</strong></div>`).join('')}</div></details>`);
  }
}

function renderRouteGraph(){
  $('arrow').setAttribute('refX','7');
  const path=routePath, ids=path.nodes;
  const pos=new Map(ids.map((id,i)=>[id,{x:ids.length===1?450:90+i*720/(ids.length-1),y:285,r:22}]));
  $('graphEdges').innerHTML=path.edges.map(e=>{const a=pos.get(e.from),b=pos.get(e.to);return `<path class="graph-edge major route-edge" d="M${a.x+26},${a.y} L${b.x-26},${b.y}" marker-end="url(#arrow)"/><text class="route-amount" text-anchor="middle" x="${(a.x+b.x)/2}" y="254">${escapeHtml(formatMoney(e.sum_kzt))}</text><text class="route-count" text-anchor="middle" x="${(a.x+b.x)/2}" y="325">${e.n_tx} операций</text>`;}).join('');
  $('graphNodes').innerHTML=ids.map((id,i)=>{const p=pos.get(id),c=clientMap.get(id),color=colorMode==='cluster'?clusterColor(c.cluster_id):ROLES[c.role].color;return `<g class="graph-node" data-id="${id}" role="button" tabindex="0" aria-label="Клиент ${id}" transform="translate(${p.x},${p.y})"><circle class="node-halo" r="30" fill="${color}"/><circle class="node-circle" r="22" fill="${color}"/><text class="node-initials" text-anchor="middle" dominant-baseline="central">${i}</text><text text-anchor="middle" y="60">${shortId(id)}</text><text text-anchor="middle" y="80">${i===0?'Seed':ROLES[c.role].label}</text></g>`;}).join('');
  $('graphNodes').querySelectorAll('.graph-node').forEach(g=>{const open=()=>{routePath=null;centerId=g.dataset.id;selectClient(centerId);$('showSeedPath').textContent='Путь от seed →';renderGraph();};g.addEventListener('click',open);g.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open();}});});
  $('graphCaption').textContent=`Путь от seed · ${path.edges.length} перехода · суммы за весь период`;
  $('network').setAttribute('aria-label',`Один направленный путь от seed: ${path.edges.length} перехода`);renderGraphLegend(ids);
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

function bindWorkspace(){
  $('nodeDetails').addEventListener('toggle',()=>{if($('nodeDetails').open)loadNodeDetails();});
  $('detailPrevious').addEventListener('click',()=>{detailPage=Math.max(0,detailPage-1);renderNodeDetails();});
  $('detailNext').addEventListener('click',()=>{detailPage++;renderNodeDetails();});
  document.querySelectorAll('[data-upload]').forEach(b=>b.addEventListener('click',()=>{$('uploadDialog').showModal();}));
  $('closeUpload').addEventListener('click',()=>$('uploadDialog').close());
  $('uploadForm').addEventListener('submit',uploadDataset);
  $('resetDemo').addEventListener('click',async()=>{
    $('resetDemo').disabled=true;
    try{await api('/api/demo',{body:{}});await loadDataset();$('uploadStatus').textContent='Исходный датасет восстановлен.';$('uploadStatus').classList.remove('error');}
    catch(e){$('uploadStatus').textContent=e.message;$('uploadStatus').classList.add('error');}
    finally{$('resetDemo').disabled=false;}
  });
  const ask=document.createElement('button');ask.className='button ask-client';ask.textContent='Разобрать с ассистентом';
  ask.addEventListener('click',()=>{chatContext=selectedId;updateChatContext();setView('assistant');sendQuestion('Почему выбранный клиент в приоритете?');});
  document.querySelector('.inspector').append(ask);
  $('chatForm').addEventListener('submit',e=>{e.preventDefault();sendQuestion($('chatInput').value);});
  $('chatInput').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();sendQuestion($('chatInput').value);}});
  document.querySelectorAll('[data-prompt]').forEach(b=>b.addEventListener('click',()=>sendQuestion(b.dataset.prompt)));
  $('clearChat').addEventListener('click',clearChat);
  $('clearContext').addEventListener('click',()=>{chatContext=null;updateChatContext();});
}

async function loadNodeDetails(){
  if(!selectedId)return;
  const id=selectedId,version=datasetVersion;
  if(detailData?.client.gid===id){renderNodeDetails();return;}
  if(detailController)detailController.abort();
  const controller=new AbortController();detailController=controller;
  $('detailSummary').textContent='Загрузка всех контрагентов и дневных потоков…';
  $('detailTable').replaceChildren();$('dailyTable').replaceChildren();
  try{
    const data=await api(`/api/node/${encodeURIComponent(id)}?version=${encodeURIComponent(version)}`,{controller});
    if(id!==selectedId||version!==datasetVersion)return;
    detailData=data;detailPage=0;renderNodeDetails();
  }catch(e){if(id===selectedId&&version===datasetVersion)$('detailSummary').textContent=e.name==='AbortError'?'Загрузка отменена. Закройте и откройте раздел, чтобы повторить.':e.message;}
}
function renderNodeDetails(){
  if(!detailData)return;
  const rows=detailData.neighbors, pages=Math.max(1,Math.ceil(rows.length/25));detailPage=Math.min(detailPage,pages-1);
  $('detailSummary').textContent=`GID ${detailData.client.gid} · ${rows.length} направленных пар · сортировка по сумме. Здесь доступны все наблюдаемые прямые связи, не только фрагмент карты.`;
  $('detailTable').innerHTML=`<table><thead><tr><th>Отправитель</th><th>Получатель</th><th>Сумма</th><th>Операций</th></tr></thead><tbody>${rows.slice(detailPage*25,(detailPage+1)*25).map(e=>`<tr><td><button class="client-link" data-client="${escapeHtml(e.from)}">${escapeHtml(e.from)}</button></td><td><button class="client-link" data-client="${escapeHtml(e.to)}">${escapeHtml(e.to)}</button></td><td>${Number(e.sum_kzt).toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2})} ₸</td><td>${e.n_tx}</td></tr>`).join('')||'<tr><td colspan="4">Нет наблюдаемых переводов.</td></tr>'}</tbody></table>`;
  $('detailPageLabel').textContent=`${detailPage+1} / ${pages}`;$('detailPrevious').disabled=detailPage===0;$('detailNext').disabled=detailPage===pages-1;
  $('dailyTable').innerHTML=`<table><thead><tr><th>Дата</th><th>Вход</th><th>Выход</th><th>Операций</th></tr></thead><tbody>${detailData.daily.map(day=>`<tr><td>${escapeHtml(day.date)}</td><td>${formatMoney(day.incoming)}</td><td>${formatMoney(day.outgoing)}</td><td>${day.n_tx}</td></tr>`).join('')||'<tr><td colspan="4">Активных дней нет.</td></tr>'}</tbody></table>`;
}

function updateChatContext(){$('chatContext').textContent=chatContext?`GID ${chatContext}`:'Весь датасет';}
function clearChat(){
  if(chatController)chatController.abort();
  chatBusy=false;$('sendChat').disabled=false;$('chatInput').value='';
  $('chatMessages').replaceChildren();
  if(!datasetVersion)return;
  const entry=document.createElement('div');entry.className='chat-empty';
  entry.innerHTML=`<span class="chat-author">Автоматическая сводка · локальные расчёты</span><h3>Сеть готова к исследованию</h3><p>${formatNumber(datasetMeta.nodes)} клиентов · ${formatNumber(datasetMeta.transactions)} операций · ${formatMoney(datasetMeta.volume_kzt)}. ${formatNumber(datasetMeta.truncated)} клиентов на границе глубины 4: их исходящие неизвестны.</p><p>Первым в рейтинге стоит <button class="client-link" data-client="${escapeHtml(clients[0].id)}">GID ${escapeHtml(clients[0].id)} ↗</button>. ${escapeHtml(clients[0].evidence)}</p><p>Это основание начать проверку, не вывод о нарушении. Выберите сценарий или задайте свой вопрос.</p>`;
  const prompts=document.createElement('div');prompts.className='quick-prompts';
  ['Кого проверить первым?','Разбор выбранного клиента','Ограничения анализа'].forEach(question=>{const b=document.createElement('button');b.className='button';b.textContent=question;b.addEventListener('click',()=>sendQuestion(question));prompts.append(b);});
  entry.append(prompts);
  $('chatMessages').append(entry);updateChatContext();
}

function addChatEntry(author,text){
  $('chatMessages').querySelector('.chat-empty')?.remove();
  const entry=document.createElement('article');entry.className=`chat-entry ${author==='Вы'?'user':'assistant'}`;
  const heading=document.createElement('div');heading.className='chat-author';heading.textContent=author;
  const body=document.createElement('div');body.className='chat-body';body.textContent=text;
  entry.append(heading,body);$('chatMessages').append(entry);scrollChat();return entry;
}
function scrollChat(){$('chatMessages').scrollTop=$('chatMessages').scrollHeight;}

async function sendQuestion(question){
  question=question.trim();if(!question||chatBusy)return;
  if(!datasetVersion||!serverAvailable){showToast('Дождитесь подключения к серверу.');return;}
  if(question.length>2000){showToast('Вопрос должен быть не длиннее 2000 символов.');return;}
  const version=datasetVersion,context=chatContext;
  const controller=new AbortController();chatController=controller;chatBusy=true;$('sendChat').disabled=true;$('chatInput').value='';
  addChatEntry('Вы',question+(context?`\nКонтекст: GID ${context}`:''));
  const entry=addChatEntry('Ассистент','Проверяю наблюдаемые связи и расчёты…');entry.classList.add('loading-reply');
  try{
    const result=await api('/api/chat',{body:{message:question,selected_gid:context,version},controller,timeout:35000});
    if(datasetVersion!==version||!entry.isConnected)return;
    entry.classList.remove('loading-reply');entry.querySelector('.chat-author').textContent=result.mode==='openai'?'OpenAI · проверенные расчёты':'Локальный разбор · без LLM';
    entry.querySelector('.chat-body').textContent=result.answer;
    if(result.warning){const warning=document.createElement('div');warning.className='chat-warning';warning.textContent=result.warning;entry.append(warning);}
    if(result.tool){const tool=document.createElement('div');tool.className='chat-tool';tool.textContent=`Запрос к графу: ${result.tool} · версия ${version.slice(0,8)} · суммы из данных`;entry.append(tool);}
    if(result.facts?.length){
      const cards=document.createElement('div');cards.className='fact-cards';
      cards.innerHTML=result.facts.map(c=>`<div class="fact-card"><div class="fact-card-head"><button class="client-link" data-client="${escapeHtml(c.gid)}">GID ${escapeHtml(c.gid)} ↗</button><span>${escapeHtml((ROLES[c.role]||ROLES.peripheral).label)} · ${(c.priority_score*100).toFixed(1)}/100</span></div><div class="fact-metrics"><span>Вход ${formatMoney(c.in_kzt)} · ${c.in_tx} операций</span><span>Выход ${formatMoney(c.out_kzt)} · ${c.out_tx} операций</span></div><p>${escapeHtml(c.evidence)}</p></div>`).join('');
      entry.append(cards);
    }else if(result.references?.length){
      const refs=document.createElement('div');refs.className='chat-refs';refs.innerHTML=result.references.map(id=>`<button class="button" data-client="${escapeHtml(id)}">Открыть ${escapeHtml(id)} ↗</button>`).join('');entry.append(refs);
    }
  }catch(error){if(entry.isConnected){entry.classList.remove('loading-reply');entry.querySelector('.chat-body').textContent=error.name==='AbortError'?'Запрос отменён или превышено время ожидания. Попробуйте ещё раз.':`Не удалось получить ответ: ${error.message}`;}}
  finally{if(chatController===controller){chatBusy=false;chatController=null;$('sendChat').disabled=false;}scrollChat();}
}

async function fileBase64(file){
  const bytes=new Uint8Array(await file.arrayBuffer());let binary='';
  for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
  return btoa(binary);
}
async function uploadDataset(event){
  event.preventDefault();if(importPending)return;
  const choices=[['nodes.parquet','fileNodes'],['edges.parquet','fileEdges'],['transactions.parquet','fileTransactions']];
  const files=choices.map(([name,id])=>[name,$(id).files[0]]);
  if(files.some(([,file])=>!file)){showToast('Выберите все три файла');return;}
  if(files.reduce((sum,[,file])=>sum+file.size,0)>25*1024*1024){$('uploadStatus').textContent='Файлы превышают общий лимит 25 МБ';$('uploadStatus').classList.add('error');return;}
  importPending=true;setImportControls(true);$('uploadStatus').classList.remove('error');$('uploadStatus').textContent='Передаём файлы на локальный сервер…';
  try{
    const encoded=Object.fromEntries(await Promise.all(files.map(async([name,file])=>[name,await fileBase64(file)])));
    await api('/api/import',{body:{files:encoded},timeout:30000});
    await pollStatus();
  }catch(error){importPending=false;setImportControls(false);$('uploadStatus').textContent='Не удалось начать импорт: '+error.message;$('uploadStatus').classList.add('error');}
}
function setImportControls(busy){
  $('startImport').disabled=busy;$('resetDemo').disabled=busy;
  ['fileNodes','fileEdges','fileTransactions'].forEach(id=>$(id).disabled=busy);
  $('uploadProgress').hidden=!busy;
}

async function pollStatus(){
  if(polling)return;polling=true;
  try{
    const status=await api('/api/status');serverAvailable=true;
    if(status.version!==datasetVersion)await loadDataset();
    $('connectionNotice').hidden=true;
    $('agentStatus').textContent=status.agent.configured?'OpenAI · настроен':'Локальный режим';
    $('agentModeDescription').textContent=status.agent.configured?`OpenAI (${status.agent.model}) выбирает запрос к графу. Ответы строятся из проверенных расчётов; при ошибке API включается локальный режим.`:'Сейчас доступен локальный разбор по сценариям — это не языковая модель. Для OpenAI задайте OPENAI_API_KEY на сервере и перезапустите его.';
    const job=status.job;importPending=job.state==='running';setImportControls(importPending);
    if(job.state!=='idle'){
      $('uploadStatus').textContent=job.stage+(job.state==='failed'?'\nТекущий датасет не изменён. Исправьте файлы и повторите загрузку.':'');
      $('uploadStatus').classList.toggle('error',job.state==='failed');$('uploadProgress').value=job.progress;
    }
    if(importPending){$('connectionNotice').hidden=false;$('connectionNotice').classList.remove('error');$('connectionNotice').textContent='Обрабатываем новый датасет. Текущая сеть остаётся доступна. '+job.stage;}
    else if(status.notice){$('connectionNotice').hidden=false;$('connectionNotice').classList.add('error');$('connectionNotice').textContent=status.notice;}
  }catch(error){connectionError(error);}
  finally{polling=false;}
}
