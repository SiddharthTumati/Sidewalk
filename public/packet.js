// Council packet: one printable page with everything a council member or public works
// office needs about a report. "Print or save as PDF" uses the browser's own print dialog.
const STAGES = { submitted: "Submitted", ai_reviewed: "Reviewed for clarity", community_priority: "Neighborhood priority", sent_to_agency: "Sent to the city", in_progress: "In progress", resolved: "Fixed" };
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const longDate = (ms) => new Date(ms).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });

async function loadPacket() {
  const root = document.getElementById("packet");
  const id = decodeURIComponent(location.pathname.split("/").filter(Boolean).pop() || "");
  let data;
  try {
    const response = await fetch(`/api/issues/${encodeURIComponent(id)}`, { credentials: "same-origin" });
    if (!response.ok) throw new Error();
    data = await response.json();
  } catch {
    root.innerHTML = `<p class="packet-loading">This report isn't available. It may have been removed. <a href="/">Back to Sidewalk</a></p>`;
    return;
  }
  const { issue, petitionGoal: goal } = data;
  document.title = `${issue.title} · Council packet · Sidewalk`;
  const shareUrl = `${location.origin}/r/${encodeURIComponent(issue.id)}`;
  const reported = issue.events?.[0]?.createdAt || issue.createdAt;
  const request = `Hello Public Works team,

${issue.supporters > 1 ? `${issue.supporters} residents are` : "Residents are"} asking for help with this issue near ${issue.distance}: ${issue.title}.

${issue.description}

It was first reported on ${longDate(reported)}. Photos, a map, and the full timeline are included in this packet.

Could you let us know whether it can be assessed, and what the next steps and expected timeline are?

Thank you,
Your neighbors on Sidewalk`;
  const gallery = (urls, label) => urls?.length ? `<figure class="packet-photos"><figcaption>${label}</figcaption><div>${urls.map((u) => `<img src="${esc(u)}" alt="${label} photo">`).join("")}</div></figure>` : "";
  const fixed = issue.status === "resolved";

  root.innerHTML = `
    <section class="packet-head">
      <p class="packet-kicker">Community request · prepared ${longDate(Date.now())}</p>
      <h1>${esc(issue.title)}</h1>
      <p class="packet-meta">${esc(issue.categoryLabel)} · ${esc(issue.distance)} · Reported ${longDate(reported)} · Status: <strong>${esc(STAGES[issue.status] || "Submitted")}</strong></p>
    </section>
    <section class="packet-grid">
      <div class="packet-count"><strong>${issue.supporters}</strong><span>neighbors back this${issue.supporters >= goal ? " (council-ready)" : ` (goal: ${goal})`}</span></div>
      <div class="packet-qr"><img src="/api/issues/${esc(encodeURIComponent(issue.id))}/qr.svg" alt="QR code linking to this report"><span>Scan to see updates and add your support<br><small>${esc(shareUrl)}</small></span></div>
    </section>
    <section><h2>What's wrong</h2><p>${esc(issue.description)}</p></section>
    ${gallery(issue.photos, fixed ? "Before" : "Photos")}${gallery(issue.afterPhotos, "After")}
    <section><h2>Where</h2><div class="packet-map" id="packet-map" role="region" aria-label="Map of the report location"></div>
      <p class="packet-small">Coordinates: ${issue.lat.toFixed(5)}, ${issue.lng.toFixed(5)}</p>
      <div id="packet-responsible"></div></section>
    <section><h2>Timeline</h2><ol class="packet-timeline">${(issue.events || []).map((e) => `<li><strong>${esc(STAGES[e.status] || e.status)}</strong> · ${longDate(e.createdAt)}<br><span>${esc(e.note)}</span></li>`).join("")}</ol></section>
    <section><h2>Request to public works</h2><pre class="packet-request">${esc(request)}</pre></section>
    <footer class="packet-foot">Prepared with Sidewalk, a community project. This is not an official government record. Endorsements come from verified Sidewalk accounts. Live version: ${esc(shareUrl)}</footer>`;

  if (window.L) {
    const map = L.map("packet-map", { zoomControl: false, attributionControl: true, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, tap: false, touchZoom: false })
      .setView([issue.lat, issue.lng], 16);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
    L.circleMarker([issue.lat, issue.lng], { radius: 10, weight: 3, color: "#23272b", fillColor: "#d9532a", fillOpacity: 1 }).addTo(map);
  }

  const guess = await guessResponsibility(issue);
  if (guess) {
    document.getElementById("packet-responsible").innerHTML = `<p class="packet-small"><strong>${esc(guess.who)}</strong> (best guess). ${esc(guess.why)}${guess.links.length ? " " + guess.links.map((l) => `<a href="${esc(l.url)}">${esc(l.label)}</a>`).join(" · ") : ""}</p>`;
  }
}

document.getElementById("print-packet").addEventListener("click", () => window.print());
loadPacket();
