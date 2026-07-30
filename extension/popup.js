function render(status) {
  document.getElementById("dot").className = "dot" + (status.connected ? " on" : "");
  document.getElementById("statusText").textContent = status.connected
    ? "Connected to agent hub"
    : "Not connected (no agent session running)";
  document.getElementById("wsUrl").textContent = status.url || "";

  const wrap = document.getElementById("groups");
  wrap.innerHTML = "";
  const groups = status.groups || [];
  if (!groups.length) {
    const p = document.createElement("div");
    p.className = "muted";
    p.textContent = "No agent tab groups.";
    wrap.appendChild(p);
    return;
  }
  const ul = document.createElement("ul");
  for (const g of groups) {
    const li = document.createElement("li");
    const left = document.createElement("div");
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = g.name;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${g.groupId} · ${g.status} · ${(g.tabs || []).length} tab(s)`;
    left.appendChild(name);
    left.appendChild(meta);
    const btn = document.createElement("button");
    btn.className = "danger";
    btn.textContent = "Close";
    btn.onclick = () => {
      btn.disabled = true;
      chrome.runtime.sendMessage({ type: "closeGroup", groupId: g.groupId }, () => refresh());
    };
    li.appendChild(left);
    li.appendChild(btn);
    ul.appendChild(li);
  }
  wrap.appendChild(ul);
}

function renderPair(status) {
  let bar = document.getElementById("pairBar");
  if (!status.pairPending) {
    if (bar) bar.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "pairBar";
    bar.style.cssText = "margin:8px 0;padding:8px;border:1px solid #d97706;border-radius:6px;display:flex;align-items:center;justify-content:space-between;gap:8px;";
    const label = document.createElement("span");
    label.textContent = "An agent wants to use this browser.";
    const btn = document.createElement("button");
    btn.textContent = "Connect";
    btn.onclick = () => chrome.runtime.sendMessage("pair", () => refresh());
    bar.appendChild(label);
    bar.appendChild(btn);
    document.body.insertBefore(bar, document.getElementById("groups"));
  }
}

function refresh() {
  chrome.runtime.sendMessage("status", (status) => {
    if (status) { render(status); renderPair(status); }
  });
}

document.getElementById("reconnect").onclick = () => {
  chrome.runtime.sendMessage("reconnect", () => setTimeout(refresh, 500));
};

refresh();
setInterval(refresh, 2000);
