const ROLE_META = {
  coordinator:  { label: "Координатор", color: "#10b981" },
  consolidator: { label: "Сборщик", color: "#ef4444" },
  distributor:  { label: "Распределитель", color: "#3b82f6" },
  transit:      { label: "Транзит", color: "#f59e0b" },
  terminal:     { label: "Конечный", color: "#8b5cf6" },
  peripheral:   { label: "Периферия", color: "#64748b" }
};

let network;
let allNodes;
let allEdges;
let activeRole = null;

document.addEventListener("DOMContentLoaded", () => {
  if (!window.graphData || !Array.isArray(graphData.nodes)) {
    document.getElementById("network-container").innerHTML =
      '<div class="fatal">Данные не найдены.<br><code>python starter.py</code></div>';
    return;
  }

  document.getElementById("totalNodes").textContent = graphData.meta.total_nodes.toLocaleString("ru-RU");
  document.getElementById("shownNodes").textContent = graphData.meta.shown_nodes.toLocaleString("ru-RU");
  document.getElementById("shownEdges").textContent = graphData.meta.shown_edges.toLocaleString("ru-RU");

  allNodes = new vis.DataSet(graphData.nodes);
  allEdges = new vis.DataSet(graphData.edges);
  network = new vis.Network(document.getElementById("network-container"),
    { nodes: allNodes, edges: allEdges }, graphOptions());

  network.on("click", params => params.nodes.length ? openPanel(String(params.nodes[0])) : closePanel());
  network.once("stabilizationIterationsDone", () => network.fit({ animation: true }));
  buildLegend();
  buildTopList();

  document.getElementById("searchButton").addEventListener("click", searchNode);
  document.getElementById("searchInput").addEventListener("keydown", event => {
    if (event.key === "Enter") searchNode();
  });
  document.getElementById("closePanel").addEventListener("click", closePanel);
  document.getElementById("fitButton").addEventListener("click", () => network.fit({ animation: true }));
  document.getElementById("resetFilter").addEventListener("click", () => filterRole(null));
});

function graphOptions() {
  return {
    nodes: {
      shape: "dot", borderWidth: 1.5,
      font: { size: 10, color: "#cbd5e1", face: "Inter, Segoe UI, sans-serif" },
      shadow: { enabled: true, color: "rgba(0,0,0,.35)", size: 8 }
    },
    edges: {
      color: { color: "rgba(100,116,139,.26)", highlight: "#38bdf8", hover: "#38bdf8" },
      arrows: { to: { enabled: true, scaleFactor: .45 } },
      smooth: { type: "continuous", roundness: .25 }, selectionWidth: 2
    },
    physics: {
      solver: "forceAtlas2Based",
      forceAtlas2Based: { gravitationalConstant: -48, centralGravity: .012, springLength: 92, springConstant: .05 },
      maxVelocity: 38, timestep: .35,
      stabilization: { enabled: true, iterations: 220, updateInterval: 25 }
    },
    interaction: { hover: true, tooltipDelay: 120, hideEdgesOnDrag: true, navigationButtons: false }
  };
}

function buildLegend() {
  const counts = {};
  graphData.nodes.forEach(node => counts[node.role] = (counts[node.role] || 0) + 1);
  const legend = document.getElementById("legend");
  legend.innerHTML = Object.entries(ROLE_META).map(([role, meta]) => `
    <button class="legend-item" data-role="${role}">
      <i style="background:${meta.color}"></i><span>${meta.label}</span><b>${counts[role] || 0}</b>
    </button>`).join("");
  legend.querySelectorAll("button").forEach(button =>
    button.addEventListener("click", () => filterRole(button.dataset.role)));
}

function buildTopList() {
  const top = [...graphData.nodes].sort((a, b) => b.priority_score - a.priority_score).slice(0, 10);
  document.getElementById("topList").innerHTML = top.map((node, index) => `
    <button class="top-item" data-id="${node.id}">
      <em>${index + 1}</em><span><b>${node.gid.slice(-9)}</b><small>${ROLE_META[node.role].label}</small></span>
      <strong>${Math.round(node.priority_score * 100)}</strong>
    </button>`).join("");
  document.querySelectorAll(".top-item").forEach(button =>
    button.addEventListener("click", () => focusNode(button.dataset.id)));
}

function filterRole(role) {
  activeRole = activeRole === role ? null : role;
  document.querySelectorAll(".legend-item").forEach(item =>
    item.classList.toggle("active", activeRole === item.dataset.role));
  const updates = graphData.nodes.map(node => ({
    id: node.id,
    hidden: activeRole ? node.role !== activeRole : false
  }));
  allNodes.update(updates);
  setTimeout(() => network.fit({ animation: { duration: 350 } }), 50);
}

function searchNode() {
  const gid = document.getElementById("searchInput").value.trim();
  if (!gid) return;
  if (!allNodes.get(gid)) {
    alert("Этот GID не входит в отображаемый риск-контур из 500 узлов. Полная оценка находится в out/nodes_roles.csv.");
    return;
  }
  focusNode(gid);
}

function focusNode(id) {
  const node = allNodes.get(String(id));
  if (!node) return;
  if (node.hidden) filterRole(null);
  network.selectNodes([String(id)]);
  network.focus(String(id), { scale: 1.15, animation: { duration: 550, easingFunction: "easeInOutQuad" } });
  openPanel(String(id));
}

function openPanel(id) {
  const node = allNodes.get(id);
  if (!node) return;
  document.getElementById("side-panel").classList.remove("hidden");
  document.getElementById("node-gid").textContent = node.gid;
  const badge = document.getElementById("node-role");
  badge.textContent = ROLE_META[node.role].label;
  badge.style.background = ROLE_META[node.role].color;
  document.getElementById("node-flags").textContent = node.is_seed ? "SEED" : "";
  document.getElementById("node-score").textContent = (node.priority_score * 100).toFixed(1);
  document.getElementById("scoreBar").style.width = `${node.priority_score * 100}%`;
  document.getElementById("node-in").textContent = formatMoney(node.in_kzt);
  document.getElementById("node-out").textContent = formatMoney(node.out_kzt);
  document.getElementById("node-in-degree").textContent = `${node.in_deg} плательщиков`;
  document.getElementById("node-out-degree").textContent = `${node.out_deg} получателей`;
  document.getElementById("node-cluster").textContent = `#${node.cluster_id}`;
  document.getElementById("node-depth").textContent = node.depth;
  document.getElementById("node-evidence").textContent = node.evidence;
  document.getElementById("truncatedWarning").classList.toggle("visible", node.truncated);
}

function closePanel() {
  document.getElementById("side-panel").classList.add("hidden");
}

function formatMoney(value) {
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)} млн ₸`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)} тыс. ₸`;
  return `${Math.round(value).toLocaleString("ru-RU")} ₸`;
}
