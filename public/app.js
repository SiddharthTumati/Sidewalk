"use strict";

const GOAL = 50;
const PRIORITY_THRESHOLD = 10;
const MAX_PHOTOS = 4;
const PHOTO_MAX_EDGE = 1600;
const DEFAULT_AREA = { label: "The Carolinas", lat: 35.05, lng: -80.75, bounds: [[31.9, -84.4], [36.6, -75.4]] };
const STATE_CODES = { Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA", Colorado: "CO", Connecticut: "CT", Delaware: "DE", Florida: "FL", Georgia: "GA", Hawaii: "HI", Idaho: "ID", Illinois: "IL", Indiana: "IN", Iowa: "IA", Kansas: "KS", Kentucky: "KY", Louisiana: "LA", Maine: "ME", Maryland: "MD", Massachusetts: "MA", Michigan: "MI", Minnesota: "MN", Mississippi: "MS", Missouri: "MO", Montana: "MT", Nebraska: "NE", Nevada: "NV", "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY", "North Carolina": "NC", "North Dakota": "ND", Ohio: "OH", Oklahoma: "OK", Oregon: "OR", Pennsylvania: "PA", "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD", Tennessee: "TN", Texas: "TX", Utah: "UT", Vermont: "VT", Virginia: "VA", Washington: "WA", "West Virginia": "WV", Wisconsin: "WI", Wyoming: "WY", "District of Columbia": "DC" };
const BASEMAPS = {
  street: { url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' },
  terrain: { url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}", maxZoom: 19, attribution: 'Sources: <a href="https://www.esri.com/">Esri</a>, TomTom, Garmin, FAO, NOAA, USGS, OpenStreetMap contributors' },
};
const CATEGORY_LABELS = { safety: "Street safety", access: "Accessibility", parks: "Parks & public space", lighting: "Street lighting", other: "Neighborhood issue" };
const STAGE_LABELS = {
  submitted: "Submitted",
  ai_reviewed: "Report reviewed",
  community_priority: "Neighborhood priority",
  sent_to_agency: "Sent to the city",
  in_progress: "Work underway",
  resolved: "Fixed",
};
const STAGE_ORDER = Object.keys(STAGE_LABELS);
const PAGES = ["home", "report", "converter", "tracker", "petitions", "heatmap"];
const GUEST = { id: "guest", name: "Guest", email: "", guest: true };

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const isDesktop = () => window.matchMedia("(min-width: 900px)").matches;

let issues = [];
let activeFilter = "all";
let selectedIssueId = null;
let currentTrackerIssue = null;
let coordinatorConfigured = false;
let emailConfigured = false;
let activeUser = { ...GUEST };
let currentArea = loadSavedArea();
let pendingLocation = null;
let selectingLocation = false;
let placeResults = [];
let photoQueue = [];
let accountMode = "login";
let resetToken = null;
let lightboxState = { photos: [], index: 0, caption: "" };
let currentPage = PAGES.includes(location.hash.slice(1)) ? location.hash.slice(1) : "home";
let toastTimer;
let map, trackerMap, heatMap, heatLayer, tempPin;
const markerLayers = new Map();
const trackerMarkers = new Map();

/* ---------- Helpers ---------- */
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

async function api(url, options = {}) {
  const init = { credentials: "same-origin", ...options };
  if (init.json !== undefined) {
    init.headers = { "Content-Type": "application/json", ...(init.headers || {}) };
    init.body = JSON.stringify(init.json);
    delete init.json;
  }
  let response;
  try {
    response = await fetch(url, init);
  } catch {
    throw Object.assign(new Error("Can't reach Sidewalk. Check your connection and try again."), { status: 0 });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = response.status === 413 ? "Those photos are too large together. Remove one and try again." : (data.error || "Something went wrong. Try again.");
    throw Object.assign(new Error(message), { status: response.status, data });
  }
  return data;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 3200);
}

function setLoading(button, loading) {
  button.disabled = loading;
  button.classList.toggle("loading", loading);
  button.setAttribute("aria-busy", String(loading));
}

function initials(name) {
  return String(name).trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
}

function timeAgo(timestamp) {
  if (!timestamp) return "";
  const seconds = Math.max(1, Math.round((Date.now() - timestamp) / 1000));
  const units = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [unit, size] of units) {
    if (seconds >= size) {
      const n = Math.floor(seconds / size);
      return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}

function pinStatus(issue) {
  if (issue.supporters >= GOAL) return "ready";
  if (issue.supporters >= PRIORITY_THRESHOLD) return "priority";
  if (issue.supporters >= 5) return "active";
  return "";
}

function byPriority(a, b) {
  return Number(b.supporters >= PRIORITY_THRESHOLD) - Number(a.supporters >= PRIORITY_THRESHOLD) || b.supporters - a.supporters || (b.createdAt || 0) - (a.createdAt || 0);
}

function openDialog(id) {
  const dialog = document.getElementById(id);
  if (!dialog.open) dialog.showModal();
  return dialog;
}

function closeDialog(id) {
  const dialog = document.getElementById(id);
  if (dialog.open) dialog.close();
}

function laneHtml(issue) {
  const progress = Math.min(100, Math.round((issue.supporters / GOAL) * 100));
  return `<div class="lane ${pinStatus(issue)}" role="progressbar" aria-valuemin="0" aria-valuemax="${GOAL}" aria-valuenow="${issue.supporters}" aria-label="${issue.supporters} of ${GOAL} neighbors"><span style="width:${progress}%"></span><i></i></div>`;
}

function supportControl(issue, verb = "Back this") {
  if (issue.supporters >= GOAL) return `<span class="goal-label">Goal reached</span>`;
  if (issue.userSupported) return `<button class="support-button supported" type="button" disabled>Backed</button>`;
  return `<button class="support-button" type="button" data-support="${escapeHtml(issue.id)}" aria-label="${verb}: ${escapeHtml(issue.title)}">${verb}</button>`;
}

/* ---------- Area ---------- */
function loadSavedArea() {
  try {
    const saved = JSON.parse(localStorage.getItem("sidewalk-area"));
    if (saved && typeof saved.label === "string" && Number.isFinite(saved.lat) && Number.isFinite(saved.lng) && saved.label !== DEFAULT_AREA.label) return saved;
  } catch {}
  return { ...DEFAULT_AREA };
}

function updateAreaLabels() {
  ["#selected-area-label", "#map-area-label", "#sidebar-area"].forEach((sel) => { $(sel).textContent = currentArea.label; });
  if (!pendingLocation) $("#report-location-label").textContent = currentArea.label;
}

function fitArea(target, zoom) {
  if (!target) return;
  if (currentArea.bounds) target.fitBounds(currentArea.bounds, { padding: [30, 30], maxZoom: isDesktop() ? 7 : 6 });
  else target.flyTo([currentArea.lat, currentArea.lng], zoom, { duration: 0.7 });
}

function setCurrentArea(area) {
  currentArea = area;
  try { localStorage.setItem("sidewalk-area", JSON.stringify(area)); } catch {}
  updateAreaLabels();
  fitArea(map, 13);
  fitArea(trackerMap, 10);
  fitArea(heatMap, 10);
}

/* ---------- Rendering ---------- */
function renderAll() {
  renderIssueList();
  renderMarkers();
  renderHome();
  renderPetitions();
  renderTracker();
  renderHotspots();
  renderSecondaryMaps();
}

function photoButton(issue, index, className = "") {
  const url = issue.photos[index];
  return `<button class="${className}" type="button" data-photo-issue="${escapeHtml(issue.id)}" data-photo-index="${index}" aria-label="View photo ${index + 1} of ${issue.photos.length} for ${escapeHtml(issue.title)}"><img src="${escapeHtml(url)}" alt="" loading="lazy" decoding="async">`;
}

function renderIssueList() {
  const list = $("#issue-list");
  const filtered = issues.filter((issue) => activeFilter === "all" || issue.category === activeFilter).sort(byPriority);
  $("#result-count").textContent = `${filtered.length} ${filtered.length === 1 ? "report" : "reports"}`;
  $("#filter-all-count").textContent = issues.length;
  list.innerHTML = filtered.map((issue) => {
    const photos = issue.photos || [];
    const thumb = photos.length
      ? `<div class="card-photos">${photoButton(issue, 0, "card-photo")}${photos.length > 1 ? `<span class="more">+${photos.length - 1}</span>` : ""}</button></div>`
      : "";
    const priority = issue.supporters >= PRIORITY_THRESHOLD ? `<span class="badge priority">Priority</span>` : "";
    return `<article class="issue-card ${issue.id === selectedIssueId ? "selected" : ""}" data-issue="${escapeHtml(issue.id)}" tabindex="0">
      <div class="card-meta"><span class="cat"><i class="cat-dot cat-${escapeHtml(issue.category)}"></i>${escapeHtml(issue.categoryLabel)}</span><span>${escapeHtml(issue.distance)}</span>${priority}</div>
      <h3>${escapeHtml(issue.title)}</h3>
      <p class="desc">${escapeHtml(issue.description)}</p>
      ${thumb}
      <div class="card-foot">
        <div class="support-meta"><span><strong>${issue.supporters}</strong> of ${GOAL} neighbors</span>${laneHtml(issue)}</div>
        ${supportControl(issue)}
      </div>
    </article>`;
  }).join("") || `<div class="empty-state">${activeFilter === "all" ? "No reports yet. Be the first to pin one." : "No reports of this type yet."}</div>`;
}

function renderHome() {
  $("#home-issue-count").textContent = issues.length;
  $("#home-support-count").textContent = issues.reduce((sum, issue) => sum + issue.supporters, 0);
  $("#home-priority-count").textContent = issues.filter((issue) => issue.supporters >= PRIORITY_THRESHOLD).length;
  const latest = [...issues].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 4);
  $("#home-feed").innerHTML = latest.map((issue) => `<button class="feed-item" type="button" data-open-issue="${escapeHtml(issue.id)}">
      <span class="feed-thumb">${issue.photos?.length ? `<img src="${escapeHtml(issue.photos[0])}" alt="" loading="lazy">` : `<svg aria-hidden="true"><use href="#i-pin"/></svg>`}</span>
      <span><strong>${escapeHtml(issue.title)}</strong><small><i class="cat-dot cat-${escapeHtml(issue.category)}"></i>${escapeHtml(issue.distance)} · ${issue.supporters} backing</small></span>
    </button>`).join("") || `<p class="empty-state">No reports yet.</p>`;
}

function renderPetitions() {
  const sorted = [...issues].sort(byPriority);
  $("#petition-list").innerHTML = sorted.map((issue) => {
    const priority = issue.supporters >= PRIORITY_THRESHOLD;
    const photos = (issue.photos || []).slice(0, 3).map((_, i) => photoButton(issue, i) + "</button>").join("");
    return `<article class="petition-card ${priority ? "priority" : ""}">
      <div class="row"><span class="meta"><i class="cat-dot cat-${escapeHtml(issue.category)}"></i>${escapeHtml(issue.categoryLabel)} in ${escapeHtml(issue.distance)}</span>${priority ? `<span class="badge priority">Priority</span>` : ""}</div>
      <h3>${escapeHtml(issue.title)}</h3>
      <p class="desc">${escapeHtml(issue.description)}</p>
      ${photos ? `<div class="petition-photos">${photos}</div>` : ""}
      ${laneHtml(issue)}
      <div class="row"><span class="petition-count"><strong>${issue.supporters}</strong> of ${GOAL} neighbors</span>${supportControl(issue, "Endorse")}</div>
    </article>`;
  }).join("") || `<p class="empty-state">No petitions yet. Report an issue to start one.</p>`;
}

function nextStageFor(issue) {
  const status = issue.status || "submitted";
  if (status === "submitted" || status === "resolved") return null;
  if (status === "ai_reviewed") return issue.supporters >= PRIORITY_THRESHOLD ? "community_priority" : "sent_to_agency";
  return STAGE_ORDER[STAGE_ORDER.indexOf(status) + 1] || null;
}

function renderTracker() {
  const sorted = [...issues].sort(byPriority);
  $("#tracker-count").textContent = sorted.length;
  if (!sorted.some((issue) => issue.id === currentTrackerIssue)) currentTrackerIssue = sorted[0]?.id || null;
  $("#tracker-issues").innerHTML = sorted.map((issue) => `<button class="tracker-card ${issue.id === currentTrackerIssue ? "selected" : ""}" type="button" data-track-issue="${escapeHtml(issue.id)}" aria-pressed="${issue.id === currentTrackerIssue}">
      <span class="row"><strong>${escapeHtml(issue.title)}</strong><span class="badge ${issue.status === "resolved" ? "resolved" : ""}">${escapeHtml(STAGE_LABELS[issue.status] || STAGE_LABELS.submitted)}</span></span>
      <small>${escapeHtml(issue.distance)} · ${issue.supporters} backing${issue.photos?.length ? ` · ${issue.photos.length} photo${issue.photos.length > 1 ? "s" : ""}` : ""}</small>
    </button>`).join("") || `<p class="empty-state">Nothing to track yet.</p>`;
  renderTrackerDetail(issues.find((issue) => issue.id === currentTrackerIssue));
}

function renderTrackerDetail(issue) {
  const detail = $("#tracker-detail");
  if (!issue) {
    detail.innerHTML = `<p class="empty-state">Choose a report to see its timeline.</p>`;
    return;
  }
  const currentIndex = Math.max(0, STAGE_ORDER.indexOf(issue.status || "submitted"));
  const events = issue.events || [];
  const steps = STAGE_ORDER.map((stage, index) => {
    const event = events.find((entry) => entry.status === stage);
    const note = event
      ? `${new Date(event.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}. ${escapeHtml(event.note)}`
      : (index < currentIndex ? "Skipped" : stage === "ai_reviewed" && issue.status === "submitted" ? "Waiting for an automated clarity check" : "Not yet");
    return `<li class="${event ? "complete" : ""} ${index === currentIndex ? "current" : ""}"><span class="tl-dot"></span><span><strong>${STAGE_LABELS[stage]}</strong><small>${note}</small></span></li>`;
  }).join("");
  const gallery = issue.photos?.length ? `<div class="gallery">${issue.photos.map((_, i) => photoButton(issue, i) + "</button>").join("")}</div>` : "";
  detail.innerHTML = `<div class="detail-top"><span><i class="cat-dot cat-${escapeHtml(issue.category)}"></i> ${escapeHtml(issue.categoryLabel)}, ${escapeHtml(issue.distance)}</span><span>${timeAgo(issue.createdAt)}</span></div>
    <h3>${escapeHtml(issue.title)}</h3>
    <p class="detail-desc">${escapeHtml(issue.description)}</p>
    ${gallery}
    <ol class="timeline" aria-label="Progress">${steps}</ol>
    <button class="btn ${issue.isSubscribed ? "btn-ghost" : "btn-primary"} btn-block" type="button" data-subscribe-issue="${escapeHtml(issue.id)}">${issue.isSubscribed ? "Following. Tap to stop" : "Follow updates"}</button>
    <p class="hint">The review step checks that a report is clear. It doesn't confirm conditions on site.</p>`;

  const nextStage = nextStageFor(issue);
  const enabled = coordinatorConfigured && Boolean(nextStage);
  $("#coordinator-status-note").textContent = !coordinatorConfigured
    ? "Status updates are off until the server has an ADMIN_TOKEN."
    : nextStage ? "Only publish a status you've confirmed." : issue.status === "submitted" ? "This report is waiting on its automatic review." : "This report is at its final stage.";
  $("#tracker-new-status").innerHTML = nextStage ? `<option value="${nextStage}">${STAGE_LABELS[nextStage]}</option>` : `<option value="">No next step</option>`;
  ["#tracker-new-status", "#tracker-admin-token", "#tracker-status-note", "#tracker-update-status"].forEach((sel) => { $(sel).disabled = !enabled; });
}

function renderHotspots() {
  const groups = new Map();
  issues.forEach((issue) => {
    const spot = groups.get(issue.distance) || { location: issue.distance, reports: 0, backing: 0, lat: issue.lat, lng: issue.lng };
    spot.reports += 1;
    spot.backing += issue.supporters;
    groups.set(issue.distance, spot);
  });
  const sorted = [...groups.values()].sort((a, b) => b.backing - a.backing);
  const max = Math.max(1, ...sorted.map((spot) => spot.backing));
  $("#hotspot-count").textContent = sorted.length;
  $("#hotspot-list").innerHTML = sorted.map((spot) => `<li class="hotspot-row" data-hotspot-lat="${spot.lat}" data-hotspot-lng="${spot.lng}">
      <strong>${escapeHtml(spot.location)}</strong><span class="count-pill">${spot.backing}</span>
      <small>${spot.reports} report${spot.reports === 1 ? "" : "s"}, ${spot.backing} neighbors backing</small>
      <span class="heat-bar" style="width:${Math.max(8, Math.round((spot.backing / max) * 100))}%"></span>
    </li>`).join("") || `<li class="empty-state">Hotspots appear as reports come in.</li>`;
}

/* ---------- Maps ---------- */
function pinIcon(issue) {
  const label = issue.supporters >= GOAL ? "✓" : issue.supporters;
  const classes = ["pin", pinStatus(issue), issue.id === selectedIssueId ? "selected" : "", issue.photos?.length ? "has-photo" : ""].join(" ");
  return L.divIcon({ className: "pin-icon", html: `<div class="${classes}"><span>${label}</span></div>`, iconSize: [34, 34], iconAnchor: [17, 34], popupAnchor: [0, -32] });
}

function popupHtml(issue) {
  const photo = issue.photos?.length ? `<img src="${escapeHtml(issue.photos[0])}" alt="" style="width:100%;max-height:120px;object-fit:cover;border-radius:6px;margin-bottom:8px">` : "";
  return `${photo}<strong>${escapeHtml(issue.title)}</strong>${issue.supporters} of ${GOAL} neighbors backing`;
}

function renderMarkers() {
  if (!map) return;
  markerLayers.forEach((marker) => marker.remove());
  markerLayers.clear();
  issues.forEach((issue) => {
    if (activeFilter !== "all" && issue.category !== activeFilter) return;
    const marker = L.marker([issue.lat, issue.lng], { icon: pinIcon(issue), title: issue.title, riseOnHover: true }).addTo(map);
    marker.bindPopup(popupHtml(issue), { maxWidth: 240 });
    marker.on("click", () => selectIssue(issue.id, { fromMap: true }));
    markerLayers.set(issue.id, marker);
  });
}

function initMap() {
  if (!window.L) {
    $("#map-loading").textContent = "The map couldn't load. Refresh to try again.";
    return;
  }
  map = L.map("map", { zoomControl: false });
  fitArea(map, 13);
  setBasemap("street");
  if (isDesktop()) L.control.zoom({ position: "bottomright" }).addTo(map);
  map.on("click", (event) => {
    if (!selectingLocation) return;
    setPendingLocation({ lat: event.latlng.lat, lng: event.latlng.lng }, "Pinned on the map");
    stopPicking();
    openReport();
  });
  map.whenReady(() => $("#map-loading").classList.add("hidden"));
  renderMarkers();
}

function setBasemap(style) {
  if (!map) return;
  map.eachLayer((layer) => { if (layer instanceof L.TileLayer) map.removeLayer(layer); });
  const base = BASEMAPS[style];
  L.tileLayer(base.url, { maxZoom: base.maxZoom, attribution: base.attribution }).addTo(map);
  $$("[data-basemap]").forEach((option) => {
    option.classList.toggle("active", option.dataset.basemap === style);
    option.setAttribute("aria-pressed", String(option.dataset.basemap === style));
  });
}

function createSecondaryMap(id) {
  const m = L.map(id, { zoomControl: isDesktop(), scrollWheelZoom: false });
  fitArea(m, 10);
  L.tileLayer(BASEMAPS.street.url, { maxZoom: 19, attribution: BASEMAPS.street.attribution }).addTo(m);
  return m;
}

function renderSecondaryMaps() {
  if (trackerMap) {
    trackerMarkers.forEach((marker) => marker.remove());
    trackerMarkers.clear();
    issues.forEach((issue) => {
      const resolved = issue.status === "resolved";
      const hot = issue.supporters >= PRIORITY_THRESHOLD;
      const selected = issue.id === currentTrackerIssue;
      const marker = L.circleMarker([issue.lat, issue.lng], {
        radius: selected ? 11 : 8, weight: selected ? 4 : 2, color: selected ? "#23272b" : "#fff",
        fillColor: resolved ? "#2f7a50" : hot ? "#d9532a" : "#f2c230", fillOpacity: 1,
      }).addTo(trackerMap);
      marker.bindTooltip(escapeHtml(issue.title));
      marker.on("click", () => { currentTrackerIssue = issue.id; renderTracker(); renderSecondaryMaps(); });
      trackerMarkers.set(issue.id, marker);
    });
  }
  if (heatMap && currentPage === "heatmap" && heatLayer) {
    const size = heatMap.getSize();
    if (size.x > 0 && size.y > 0) heatLayer.setLatLngs(issues.map((issue) => [issue.lat, issue.lng, Math.min(1, 0.3 + (issue.supporters / GOAL) * 0.7)]));
  }
}

function selectIssue(id, { fromMap = false } = {}) {
  selectedIssueId = id;
  const issue = issues.find((entry) => entry.id === id);
  $$(".issue-card").forEach((card) => card.classList.toggle("selected", card.dataset.issue === id));
  markerLayers.forEach((marker, markerId) => {
    const target = issues.find((entry) => entry.id === markerId);
    if (target) marker.setIcon(pinIcon(target));
  });
  if (!issue || !map) return;
  if (fromMap) {
    $(`.issue-card[data-issue="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  } else {
    map.flyTo([issue.lat, issue.lng], Math.max(map.getZoom(), 14), { duration: 0.6 });
    markerLayers.get(id)?.openPopup();
    if (!isDesktop()) window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

/* ---------- Navigation ---------- */
function navigateTo(page, updateUrl = true) {
  currentPage = PAGES.includes(page) ? page : "home";
  document.body.dataset.page = currentPage;
  $$("[data-page-section]").forEach((section) => { section.hidden = section.dataset.pageSection !== currentPage; });
  $$(".nav-link, .tab").forEach((button) => {
    const active = button.dataset.pageTarget === currentPage;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  });
  if (updateUrl && location.hash !== `#${currentPage}`) history.pushState(null, "", `#${currentPage}`);
  if (currentPage === "report") {
    if (!map) initMap(); else requestAnimationFrame(() => map.invalidateSize());
  }
  if (currentPage === "tracker" && window.L) {
    if (!trackerMap) trackerMap = createSecondaryMap("tracker-map");
    requestAnimationFrame(() => { trackerMap.invalidateSize(); renderSecondaryMaps(); });
  }
  if (currentPage === "heatmap" && window.L) {
    if (!heatMap) {
      heatMap = createSecondaryMap("heat-map");
      if (typeof L.heatLayer === "function") {
        heatLayer = L.heatLayer([], { radius: 40, blur: 30, maxZoom: 13, gradient: { 0.2: "#8fc7a0", 0.5: "#f2c230", 0.8: "#e8833f", 1: "#c23b22" } }).addTo(heatMap);
      }
    }
    requestAnimationFrame(() => { heatMap.invalidateSize(); renderSecondaryMaps(); });
  }
  if (updateUrl) window.scrollTo({ top: 0 });
}

/* ---------- Account ---------- */
function renderProfileButton() {
  const button = $("#profile-button");
  const signedIn = !activeUser.guest;
  $("#profile-initials").textContent = signedIn ? initials(activeUser.name) : "Sign in";
  button.classList.toggle("signed-in", signedIn);
  button.setAttribute("aria-label", signedIn ? `Account for ${activeUser.name}` : "Sign in or create an account");
}

function setAccountNotice(html, tone = "") {
  const notice = $("#account-notice");
  notice.hidden = !html;
  notice.className = `notice ${tone}`;
  notice.innerHTML = html || "";
}

function setAccountError(message, field) {
  $("#account-error").textContent = message || "";
  $$("#account-form input").forEach((input) => input.removeAttribute("aria-invalid"));
  if (field) {
    const input = $(`#account-${field}`);
    input?.setAttribute("aria-invalid", "true");
    input?.focus();
  }
}

// One dialog covers sign in, sign up, forgotten passwords, resets, and settings.
function setAccountMode(mode, { keepNotice = false } = {}) {
  accountMode = mode;
  const signedIn = !activeUser.guest;
  const show = (sel, visible) => { $(sel).hidden = !visible; };
  const isAuthForm = ["login", "register", "forgot", "reset"].includes(mode);
  if (!keepNotice) setAccountNotice("");
  setAccountError("");

  show("#account-tabs", mode === "login" || mode === "register");
  show("#account-form", isAuthForm);
  show("#account-settings", mode === "settings");
  show("#account-name-field", mode === "register");
  show("#account-email-field", mode !== "reset");
  show("#account-password-field", mode !== "forgot");
  show("#forgot-link", mode === "login");
  show("#password-hint", mode === "register" || mode === "reset");
  show("#email-updates-field", mode === "register" && emailConfigured);
  show("#back-to-login", mode === "forgot" || mode === "reset");
  show("#resend-verification", false);
  show("#guest-note", !signedIn && isAuthForm);

  $$("#account-tabs [data-account-mode]").forEach((tab) => tab.setAttribute("aria-selected", String(tab.dataset.accountMode === mode)));
  const password = $("#account-password");
  password.autocomplete = mode === "login" ? "current-password" : "new-password";
  $("#account-password-label").textContent = mode === "reset" ? "New password" : "Password";

  const copy = {
    login: ["Sign in", "Welcome back. Sign in to endorse issues and follow updates.", "Sign in"],
    register: ["Create an account", emailConfigured ? "We'll email you a link to confirm it's you." : "Takes ten seconds. You can endorse issues right away.", "Create account"],
    forgot: ["Reset your password", "Enter your account email and we'll send you a link to choose a new password.", "Send reset link"],
    reset: ["Choose a new password", "Pick something at least 8 characters long.", "Save new password"],
    settings: ["Your account", "", ""],
  }[mode];
  $("#account-title").textContent = copy[0];
  $("#account-intro").textContent = copy[1];
  $("#account-intro").hidden = !copy[1];
  $("#account-submit").textContent = copy[2];

  if (mode === "settings") {
    $("#settings-avatar").textContent = initials(activeUser.name);
    $("#settings-name").textContent = activeUser.name;
    $("#settings-email").textContent = activeUser.email;
    const box = $("#account-email-updates");
    box.checked = emailConfigured && Boolean(activeUser.emailUpdates);
    box.disabled = !emailConfigured;
    $("#email-delivery-note").textContent = emailConfigured ? "We only email about issues you've backed or followed." : "Email isn't set up on this server yet, so no emails will be sent.";
    $("#save-email-preferences").hidden = !emailConfigured;
  }
}

function openAccount(mode, notice) {
  if (!mode) mode = activeUser.guest ? "login" : "settings";
  setAccountMode(mode);
  if (notice) setAccountNotice(notice, "warn");
  openDialog("account-modal");
  if (isDesktop() || mode === "reset") {
    const first = { login: "#account-email", register: "#account-name", forgot: "#account-email", reset: "#account-password" }[mode];
    if (first) requestAnimationFrame(() => $(first).focus());
  }
}

function setActiveUser(user) {
  activeUser = user ? { ...user, guest: false } : { ...GUEST };
  renderProfileButton();
}

async function refreshState() {
  try {
    const [auth, result] = await Promise.all([api("/api/auth/me"), api("/api/issues")]);
    emailConfigured = Boolean(auth.emailConfigured);
    coordinatorConfigured = Boolean(result.coordinatorConfigured);
    setActiveUser(auth.user);
    issues = result.issues;
    renderAll();
  } catch (error) {
    showToast(error.message);
  }
}

async function submitAccountForm(event) {
  event.preventDefault();
  const button = $("#account-submit");
  const name = $("#account-name").value.trim();
  const email = $("#account-email").value.trim();
  const password = $("#account-password").value;
  setAccountError("");

  // Quick checks so people aren't sent to the server for obvious typos.
  if (accountMode === "register" && name.length < 2) return setAccountError("Enter your name.", "name");
  if (accountMode !== "reset" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setAccountError("Enter a valid email address.", "email");
  if (accountMode === "login" && !password) return setAccountError("Enter your password.", "password");
  if ((accountMode === "register" || accountMode === "reset") && password.length < 8) return setAccountError("Use at least 8 characters.", "password");

  setLoading(button, true);
  try {
    if (accountMode === "login") {
      const result = await api("/api/auth/login", { method: "POST", json: { email, password } });
      await afterSignIn(`Signed in as ${result.user.name}.`);
    } else if (accountMode === "register") {
      const result = await api("/api/auth/register", { method: "POST", json: { name, email, password, emailUpdates: $("#email-updates").checked } });
      if (result.pendingVerification) {
        setAccountMode("login");
        $("#account-email").value = email;
        setAccountNotice(`<strong>Check your inbox.</strong> We sent a link to ${escapeHtml(email)}. Open it on this device to finish signing up.`);
        $("#resend-verification").hidden = false;
      } else {
        await afterSignIn(result.message);
      }
    } else if (accountMode === "forgot") {
      const result = await api("/api/auth/forgot-password", { method: "POST", json: { email } });
      const dev = result.devResetUrl ? `<br>Email isn't set up on this server, so here's the link: <a href="${escapeHtml(result.devResetUrl)}">reset password</a>` : "";
      setAccountNotice(`${escapeHtml(result.message)}${dev}`);
    } else if (accountMode === "reset") {
      const result = await api("/api/auth/reset-password", { method: "POST", json: { token: resetToken, password } });
      resetToken = null;
      await afterSignIn(result.message);
    }
  } catch (error) {
    const data = error.data || {};
    if (data.needsVerification) {
      setAccountNotice("Your email isn't confirmed yet. Open the link we sent, or send a new one below.", "warn");
      $("#resend-verification").hidden = false;
    } else if (data.suggest === "login") {
      setAccountMode("login");
      $("#account-email").value = email;
      setAccountNotice("You already have an account with this email. Sign in below, or reset your password.", "warn");
      $("#account-password").focus();
    } else {
      setAccountError(error.message, data.field);
    }
  } finally {
    setLoading(button, false);
  }
}

async function afterSignIn(message) {
  $("#account-form").reset();
  closeDialog("account-modal");
  await refreshState();
  showToast(message);
  if (pendingAfterSignIn) {
    const action = pendingAfterSignIn;
    pendingAfterSignIn = null;
    action();
  }
}
let pendingAfterSignIn = null;

function requireAccount(reason, then) {
  if (!activeUser.guest) return true;
  pendingAfterSignIn = then || null;
  openAccount("login", reason);
  return false;
}

/* ---------- Supporting & following ---------- */
async function handleSupport(id, button) {
  const issue = issues.find((entry) => entry.id === id);
  if (!issue || issue.userSupported) return;
  if (!requireAccount("Sign in or create an account to back this issue. It keeps endorsements one per person.", () => handleSupport(id))) return;
  if (button) setLoading(button, true);
  try {
    const result = await api(`/api/issues/${encodeURIComponent(id)}/support`, { method: "POST" });
    issue.supporters = result.count;
    issue.userSupported = true;
    issue.isSubscribed = true;
    if (result.priorityReached) issue.status = "community_priority";
    renderAll();
    showToast(result.priorityReached ? `That's ${result.count}. This is now a neighborhood priority.` : `You're in. ${result.count} neighbors are backing this.`);
    if (result.goalReached) openPetition(issue);
  } catch (error) {
    if (button) setLoading(button, false);
    if (error.status === 401) { setActiveUser(null); return requireAccount("Your session ended. Sign in again to back this issue."); }
    showToast(error.message);
  }
}

function openPetition(issue) {
  const subject = `Request for action: ${issue.title}`;
  const body = `Hello Public Works team,\n\n${issue.supporters} residents are asking for help with this issue near ${issue.distance}: ${issue.title}.\n\n${issue.description}\n\nCould you let us know whether it can be assessed, and what the next steps are?\n\nThank you,\nYour neighbors`;
  $("#email-subject").textContent = subject;
  $("#email-body").textContent = body;
  $("#send-email").href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  openDialog("petition-modal");
}

/* ---------- Photos ---------- */
function loadImage(file) {
  if ("createImageBitmap" in window) {
    return createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => createImageBitmap(file));
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode")); };
    img.src = url;
  });
}

// Phone photos are often 4–12 MB; shrink them to a sensible size before upload.
async function compressPhoto(file) {
  const image = await loadImage(file);
  const width = image.width;
  const height = image.height;
  const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  image.close?.();
  let quality = 0.82;
  let dataUrl = canvas.toDataURL("image/jpeg", quality);
  while (dataUrl.length > 2_400_000 && quality > 0.45) {
    quality -= 0.12;
    dataUrl = canvas.toDataURL("image/jpeg", quality);
  }
  return dataUrl;
}

async function addPhotos(fileList) {
  const files = [...fileList].filter((file) => file.type.startsWith("image/") || /\.(heic|heif|jpe?g|png|webp)$/i.test(file.name));
  if (!files.length) return;
  const room = MAX_PHOTOS - photoQueue.length;
  if (room <= 0) return showToast(`You can attach up to ${MAX_PHOTOS} photos.`);
  if (files.length > room) showToast(`Only the first ${room} photo${room === 1 ? "" : "s"} were added. The limit is ${MAX_PHOTOS}.`);
  const entries = files.slice(0, room).map((file) => ({ id: crypto.randomUUID?.() || String(Math.random()), file, dataUrl: null, status: "processing" }));
  photoQueue.push(...entries);
  renderPhotoQueue();
  await Promise.all(entries.map(async (entry) => {
    try {
      entry.dataUrl = await compressPhoto(entry.file);
      entry.status = "ready";
    } catch {
      photoQueue = photoQueue.filter((item) => item !== entry);
      showToast(`Couldn't read ${entry.file.name || "that photo"}. Try a JPEG or PNG.`);
    }
    renderPhotoQueue();
  }));
}

function renderPhotoQueue() {
  $("#photo-previews").innerHTML = photoQueue.map((entry, index) => `<div class="photo-thumb ${entry.status === "processing" ? "processing" : ""}">
      ${entry.dataUrl ? `<img src="${entry.dataUrl}" alt="Photo ${index + 1}">` : ""}
      <button type="button" data-remove-photo="${entry.id}" aria-label="Remove photo ${index + 1}"><svg><use href="#i-close"/></svg></button>
    </div>`).join("");
  $("#photo-actions").hidden = photoQueue.length >= MAX_PHOTOS;
  $("#photo-hint").textContent = photoQueue.length
    ? `${photoQueue.length} of ${MAX_PHOTOS} photos added.`
    : "Photos help crews find and size up the problem. Large photos are shrunk before upload.";
}

function openLightbox(issueId, index) {
  const issue = issues.find((entry) => entry.id === issueId);
  if (!issue?.photos?.length) return;
  lightboxState = { photos: issue.photos, index, caption: issue.title };
  showLightboxPhoto();
  openDialog("lightbox");
}

function showLightboxPhoto() {
  const { photos, index, caption } = lightboxState;
  $("#lb-img").src = photos[index];
  $("#lb-img").alt = `Photo ${index + 1} of ${photos.length}: ${caption}`;
  $("#lb-caption").textContent = photos.length > 1 ? `${caption} (${index + 1} of ${photos.length})` : caption;
  $("#lb-prev").hidden = photos.length < 2;
  $("#lb-next").hidden = photos.length < 2;
}

function stepLightbox(delta) {
  const count = lightboxState.photos.length;
  lightboxState.index = (lightboxState.index + delta + count) % count;
  showLightboxPhoto();
}

/* ---------- Reporting ---------- */
function setPendingLocation(location, label) {
  pendingLocation = location;
  $("#report-location-label").textContent = label;
  $("#report-location-help").textContent = `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}`;
  $(".location-card").classList.add("set");
  if (map) {
    tempPin?.remove();
    tempPin = L.marker([location.lat, location.lng], { icon: L.divIcon({ className: "pin-icon", html: '<div class="temp-pin"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }), interactive: false }).addTo(map);
  }
}

function clearPendingLocation() {
  pendingLocation = null;
  tempPin?.remove();
  tempPin = null;
  $(".location-card").classList.remove("set");
  $("#report-location-label").textContent = currentArea.label;
  $("#report-location-help").textContent = "Placed in your selected area. Add an exact spot for a faster fix.";
}

function openReport(prefill) {
  if (prefill) {
    $("#issue-title").value = prefill.title || "";
    $("#issue-description").value = prefill.description || "";
    const radio = $(`#category-choices input[value="${prefill.category}"]`);
    if (radio) radio.checked = true;
  }
  $("#description-count").textContent = $("#issue-description").value.length;
  $("#report-intro").textContent = activeUser.guest
    ? "Anyone can report. Sign in if you want to endorse issues and get updates."
    : `Posting as ${activeUser.name}. You'll follow this report automatically.`;
  openDialog("report-modal");
}

function startPicking() {
  closeDialog("report-modal");
  if (currentPage !== "report") navigateTo("report");
  selectingLocation = true;
  requestAnimationFrame(() => {
    map?.invalidateSize();
    map?.getContainer().classList.add("choosing-location");
  });
  $("#pick-banner").hidden = false;
  if (!isDesktop()) window.scrollTo({ top: 0, behavior: "smooth" });
}

function stopPicking() {
  selectingLocation = false;
  map?.getContainer().classList.remove("choosing-location");
  $("#pick-banner").hidden = true;
}

function locateMe() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Your browser can't share location. Pick the spot on the map instead."));
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }),
      (error) => reject(new Error(error.code === 1 ? "Location access is off for this site. Turn it on in your browser settings, or pick the spot on the map." : "Couldn't find your location. Pick the spot on the map instead.")),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  });
}

async function submitReport(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $("#report-submit");
  const errorLabel = $("#form-error");
  const title = $("#issue-title").value.trim();
  const description = $("#issue-description").value.trim();
  errorLabel.textContent = "";
  $$("#report-form [aria-invalid]").forEach((el) => el.removeAttribute("aria-invalid"));

  if (title.length < 3) {
    $("#issue-title").setAttribute("aria-invalid", "true");
    $("#issue-title").focus();
    return (errorLabel.textContent = "Give the issue a short title (at least 3 characters).");
  }
  if (description.length < 5) {
    $("#issue-description").setAttribute("aria-invalid", "true");
    $("#issue-description").focus();
    return (errorLabel.textContent = "Describe what's happening (at least 5 characters).");
  }
  if (photoQueue.some((entry) => entry.status === "processing")) return (errorLabel.textContent = "Photos are still being prepared. Give it a second.");

  const location = pendingLocation || { lat: currentArea.lat, lng: currentArea.lng };
  setLoading(button, true);
  try {
    const result = await api("/api/issues", {
      method: "POST",
      json: {
        title,
        category: new FormData(form).get("category"),
        description,
        distance: currentArea.label,
        lat: location.lat,
        lng: location.lng,
        photos: photoQueue.map((entry) => entry.dataUrl),
      },
    });
    issues.unshift(result.issue);
    form.reset();
    photoQueue = [];
    renderPhotoQueue();
    clearPendingLocation();
    closeDialog("report-modal");
    activeFilter = "all";
    $$("[data-filter]").forEach((chip) => chip.classList.toggle("active", chip.dataset.filter === "all"));
    if (currentPage !== "report") navigateTo("report");
    selectedIssueId = result.issue.id;
    renderAll();
    requestAnimationFrame(() => {
      map?.invalidateSize();
      map?.flyTo([result.issue.lat, result.issue.lng], 16, { duration: 0.7 });
      if (isDesktop()) $(`.issue-card[data-issue="${CSS.escape(result.issue.id)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      else window.scrollTo({ top: 0, behavior: "smooth" });
    });
    showToast("Posted. Your report is on the map.");
  } catch (error) {
    errorLabel.textContent = error.message;
  } finally {
    setLoading(button, false);
  }
}

/* ---------- Place search ---------- */
function placeLabel(result) {
  const a = result.address || {};
  const locality = a.neighbourhood || a.suburb || a.city_district || a.city || a.town || a.village || a.municipality || a.county;
  const state = STATE_CODES[a.state] || "";
  return locality ? [locality, state].filter(Boolean).join(", ") : result.display_name.split(",").slice(0, 2).join(",").trim();
}

async function searchPlaces(query) {
  const status = $("#search-status");
  const button = $("#place-search-submit");
  status.textContent = "Searching…";
  $("#place-results").replaceChildren();
  setLoading(button, true);
  try {
    const params = new URLSearchParams({ q: query, format: "jsonv2", addressdetails: "1", limit: "6", countrycodes: "us" });
    const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
    if (!response.ok) throw new Error("Place search is busy right now. Try again in a moment.");
    placeResults = (await response.json()).filter((r) => Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lon)));
    status.textContent = placeResults.length ? "" : "No matches. Try a nearby city or a ZIP code.";
    $("#place-results").innerHTML = placeResults.map((r, i) => `<button class="place-result" type="button" role="option" data-place-index="${i}"><svg aria-hidden="true"><use href="#i-pin"/></svg><span><strong>${escapeHtml(placeLabel(r))}</strong><small>${escapeHtml(r.display_name)}</small></span></button>`).join("");
  } catch (error) {
    status.textContent = error instanceof TypeError ? "Couldn't reach place search. Check your connection." : error.message;
  } finally {
    setLoading(button, false);
  }
}

/* ---------- Event wiring ---------- */
document.addEventListener("click", (event) => {
  const target = event.target;
  const photo = target.closest("[data-photo-issue]");
  if (photo) { event.stopPropagation(); return openLightbox(photo.dataset.photoIssue, Number(photo.dataset.photoIndex)); }
  const support = target.closest("[data-support]");
  if (support) { event.stopPropagation(); return handleSupport(support.dataset.support, support); }
  const nav = target.closest("[data-page-target]");
  if (nav) { event.preventDefault(); return navigateTo(nav.dataset.pageTarget); }
  if (target.closest('[data-action="start-report"]')) return openReport();
  const close = target.closest("[data-close]");
  if (close) return closeDialog(close.dataset.close);
  const feed = target.closest("[data-open-issue]");
  if (feed) { navigateTo("report"); return requestAnimationFrame(() => selectIssue(feed.dataset.openIssue)); }
  const card = target.closest(".issue-card");
  if (card) return selectIssue(card.dataset.issue);
  const removePhoto = target.closest("[data-remove-photo]");
  if (removePhoto) { photoQueue = photoQueue.filter((entry) => entry.id !== removePhoto.dataset.removePhoto); return renderPhotoQueue(); }
  if (!target.closest(".map-style-selector")) { $("#map-style-menu").hidden = true; $("#layers-button").setAttribute("aria-expanded", "false"); }
});

document.addEventListener("keydown", (event) => {
  const card = event.target.closest?.(".issue-card");
  if (card && event.target === card && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); selectIssue(card.dataset.issue); }
  if (event.key === "Escape" && selectingLocation) { stopPicking(); openReport(); }
  if ($("#lightbox").open && (event.key === "ArrowLeft" || event.key === "ArrowRight")) stepLightbox(event.key === "ArrowLeft" ? -1 : 1);
});

// Tapping the dimmed backdrop closes a sheet.
$$("dialog").forEach((dialog) => {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
});

window.addEventListener("popstate", () => navigateTo(location.hash.slice(1), false));

$$("[data-filter]").forEach((chip) => chip.addEventListener("click", () => {
  activeFilter = chip.dataset.filter;
  $$("[data-filter]").forEach((other) => other.classList.toggle("active", other === chip));
  renderIssueList();
  renderMarkers();
}));

$("#report-button").addEventListener("click", () => openReport());
$("#report-form").addEventListener("submit", submitReport);
$("#issue-description").addEventListener("input", (event) => { $("#description-count").textContent = event.target.value.length; });
$("#issue-photos").addEventListener("change", (event) => { addPhotos(event.target.files); event.target.value = ""; });
$("#issue-camera").addEventListener("change", (event) => { addPhotos(event.target.files); event.target.value = ""; });
const picker = $("#photo-picker");
picker.addEventListener("dragover", (event) => { event.preventDefault(); picker.classList.add("dragging"); });
picker.addEventListener("dragleave", () => picker.classList.remove("dragging"));
picker.addEventListener("drop", (event) => { event.preventDefault(); picker.classList.remove("dragging"); addPhotos(event.dataTransfer.files); });
$("#report-modal").addEventListener("paste", (event) => {
  const files = [...(event.clipboardData?.files || [])];
  if (files.length) { event.preventDefault(); addPhotos(files); }
});
$("#pick-location").addEventListener("click", startPicking);
$("#cancel-pick").addEventListener("click", () => { stopPicking(); openReport(); });
$("#use-my-location").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  setLoading(button, true);
  try {
    setPendingLocation(await locateMe(), "Your current location");
  } catch (error) {
    $("#form-error").textContent = error.message;
  } finally {
    setLoading(button, false);
  }
});

$("#locate-button").addEventListener("click", async () => {
  try {
    const position = await locateMe();
    map?.flyTo([position.lat, position.lng], 16);
    showToast("Centered on you. Your location isn't shared.");
  } catch (error) {
    showToast(error.message);
  }
});
$("#layers-button").addEventListener("click", () => {
  const menu = $("#map-style-menu");
  menu.hidden = !menu.hidden;
  $("#layers-button").setAttribute("aria-expanded", String(!menu.hidden));
});
$("#map-style-menu").addEventListener("click", (event) => {
  const option = event.target.closest("[data-basemap]");
  if (!option) return;
  setBasemap(option.dataset.basemap);
  $("#map-style-menu").hidden = true;
});

function openSearch() {
  $("#place-search-form").reset();
  $("#place-results").replaceChildren();
  $("#search-status").textContent = "";
  $("#reset-area").hidden = Boolean(currentArea.bounds);
  openDialog("search-modal");
  if (isDesktop()) $("#place-query").focus();
}
$("#area-button").addEventListener("click", openSearch);
$("#map-area-chip").addEventListener("click", openSearch);
$("#place-search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const query = $("#place-query").value.trim();
  if (query.length >= 2) searchPlaces(query);
});
$("#place-results").addEventListener("click", (event) => {
  const option = event.target.closest("[data-place-index]");
  if (!option) return;
  const result = placeResults[Number(option.dataset.placeIndex)];
  setCurrentArea({ label: placeLabel(result), lat: Number(result.lat), lng: Number(result.lon), state: STATE_CODES[result.address?.state] || "" });
  clearPendingLocation();
  closeDialog("search-modal");
  showToast(`Showing ${currentArea.label}. New reports will be placed here.`);
});
$("#reset-area").addEventListener("click", () => {
  setCurrentArea({ ...DEFAULT_AREA });
  closeDialog("search-modal");
});

// Account
$("#profile-button").addEventListener("click", () => openAccount());
$$("#account-tabs [data-account-mode]").forEach((tab) => tab.addEventListener("click", () => {
  const email = $("#account-email").value;
  setAccountMode(tab.dataset.accountMode);
  $("#account-email").value = email;
}));
$("#account-form").addEventListener("submit", submitAccountForm);
$("#forgot-link").addEventListener("click", () => {
  const email = $("#account-email").value;
  setAccountMode("forgot");
  $("#account-email").value = email;
  $("#account-email").focus();
});
$("#back-to-login").addEventListener("click", () => setAccountMode("login"));
$("#toggle-password").addEventListener("click", (event) => {
  const input = $("#account-password");
  const showing = input.type === "text";
  input.type = showing ? "password" : "text";
  event.currentTarget.setAttribute("aria-pressed", String(!showing));
  event.currentTarget.setAttribute("aria-label", showing ? "Show password" : "Hide password");
});
$("#resend-verification").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const email = $("#account-email").value.trim();
  if (!email) return setAccountError("Enter your email first.", "email");
  setLoading(button, true);
  try {
    const result = await api("/api/auth/resend-verification", { method: "POST", json: { email } });
    setAccountNotice(escapeHtml(result.message));
  } catch (error) {
    setAccountError(error.message);
  } finally {
    setLoading(button, false);
  }
});
$("#sign-out-button").addEventListener("click", async () => {
  try { await api("/api/auth/logout", { method: "POST" }); } catch {}
  closeDialog("account-modal");
  await refreshState();
  showToast("Signed out.");
});
$("#save-email-preferences").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  setLoading(button, true);
  try {
    const result = await api("/api/auth/preferences", { method: "PATCH", json: { emailUpdates: $("#account-email-updates").checked } });
    activeUser.emailUpdates = result.emailUpdates;
    showToast(result.emailUpdates ? "Email updates on." : "Email updates off.");
  } catch (error) {
    showToast(error.message);
  } finally {
    setLoading(button, false);
  }
});

// Tracker
$("#tracker-issues").addEventListener("click", (event) => {
  const button = event.target.closest("[data-track-issue]");
  if (!button) return;
  currentTrackerIssue = button.dataset.trackIssue;
  renderTracker();
  renderSecondaryMaps();
  const issue = issues.find((item) => item.id === currentTrackerIssue);
  if (issue && trackerMap) trackerMap.flyTo([issue.lat, issue.lng], Math.max(trackerMap.getZoom(), 11), { duration: 0.5 });
  if (!isDesktop()) $("#tracker-detail").scrollIntoView({ behavior: "smooth", block: "start" });
});
$("#tracker-detail").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-subscribe-issue]");
  if (!button) return;
  const issue = issues.find((item) => item.id === button.dataset.subscribeIssue);
  if (!issue) return;
  if (!requireAccount("Sign in to follow this issue and get status updates.")) return;
  setLoading(button, true);
  try {
    const result = await api(`/api/issues/${encodeURIComponent(issue.id)}/subscribe`, { method: issue.isSubscribed ? "DELETE" : "POST" });
    issue.isSubscribed = result.subscribed;
    renderTracker();
    showToast(!result.subscribed ? "Stopped following." : result.emailAlertsEnabled ? "Following. We'll email you when the status changes." : "Following. Turn on email updates in your account to get alerts.");
  } catch (error) {
    showToast(error.message);
    setLoading(button, false);
  }
});
$("#tracker-update-status").addEventListener("click", async (event) => {
  const issue = issues.find((item) => item.id === currentTrackerIssue);
  const token = $("#tracker-admin-token").value.trim();
  if (!issue) return showToast("Choose a report first.");
  if (!token) return showToast("Enter the coordinator token.");
  const button = event.currentTarget;
  setLoading(button, true);
  try {
    const result = await api(`/api/issues/${encodeURIComponent(issue.id)}/status`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
      json: { status: $("#tracker-new-status").value, note: $("#tracker-status-note").value },
    });
    Object.assign(issue, result.issue);
    $("#tracker-status-note").value = "";
    renderAll();
    showToast(result.emailAlertsEnabled ? "Status published. Followers will get an email." : "Status published.");
  } catch (error) {
    showToast(error.message);
  } finally {
    setLoading(button, false);
    renderTracker();
  }
});
$("#hotspot-list").addEventListener("click", (event) => {
  const row = event.target.closest("[data-hotspot-lat]");
  if (row && heatMap) heatMap.flyTo([Number(row.dataset.hotspotLat), Number(row.dataset.hotspotLng)], 11, { duration: 0.6 });
});

// Lightbox
$("#lb-prev").addEventListener("click", () => stepLightbox(-1));
$("#lb-next").addEventListener("click", () => stepLightbox(1));
let touchStartX = null;
$("#lightbox").addEventListener("touchstart", (event) => { touchStartX = event.touches[0].clientX; }, { passive: true });
$("#lightbox").addEventListener("touchend", (event) => {
  if (touchStartX === null || lightboxState.photos.length < 2) return;
  const dx = event.changedTouches[0].clientX - touchStartX;
  if (Math.abs(dx) > 50) stepLightbox(dx > 0 ? -1 : 1);
  touchStartX = null;
});

// Sideassist
$("#converter-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#converter-submit");
  const message = $("#converter-message").value.trim();
  const place = $("#converter-location").value.trim();
  $("#converter-error").textContent = "";
  if (message.length < 10) return ($("#converter-error").textContent = "Add a bit more detail (at least 10 characters).");
  setLoading(button, true);
  try {
    const { draft } = await api("/api/convert", { method: "POST", json: { message, location: place } });
    const categories = { "Street safety": "safety", Accessibility: "access", "Parks & public space": "parks", "Street lighting": "lighting", Other: "other" };
    $("#converter-title").textContent = draft.title;
    $("#converter-urgency").textContent = draft.urgency;
    $("#converter-urgency").className = `badge ${draft.urgency.toLowerCase()}`;
    $("#converter-category").textContent = draft.category;
    $("#converter-result-location").textContent = place;
    $("#converter-summary").textContent = draft.summary;
    $("#converter-subject").value = draft.emailSubject;
    $("#converter-body").value = draft.emailBody;
    Object.assign($("#converter-use-report").dataset, { title: draft.title.slice(0, 70), category: categories[draft.category] || "other", description: draft.summary.slice(0, 400) });
    $("#converter-result").hidden = false;
    if (!isDesktop()) $("#converter-result").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    $("#converter-error").textContent = error.message;
  } finally {
    setLoading(button, false);
  }
});
$("#converter-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(`Subject: ${$("#converter-subject").value}\n\n${$("#converter-body").value}`);
    showToast("Email copied.");
  } catch {
    $("#converter-body").select();
    showToast("Select the text and copy it.");
  }
});
$("#converter-use-report").addEventListener("click", (event) => {
  navigateTo("report");
  openReport({ ...event.currentTarget.dataset });
});

/* ---------- Chat ---------- */
const chatPanel = $("#chat-panel");
const chatLauncher = $("#chat-launcher");
const chatMessages = $("#chat-messages");
const chatInput = $("#chat-input");
const chatSend = $("#chat-send");
const chatHistory = [];

function addChatMessage(text, role) {
  const message = document.createElement("div");
  message.className = `chat-message ${role}-message`;
  message.textContent = text;
  chatMessages.append(message);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return message;
}
function setChatOpen(open) {
  chatPanel.hidden = !open;
  chatLauncher.setAttribute("aria-expanded", String(open));
  if (open && isDesktop()) chatInput.focus();
}
chatLauncher.addEventListener("click", () => setChatOpen(chatPanel.hidden));
$("#chat-close").addEventListener("click", () => { setChatOpen(false); chatLauncher.focus(); });
chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && isDesktop()) { event.preventDefault(); $("#chat-form").requestSubmit(); }
});
chatInput.addEventListener("input", () => {
  chatInput.style.height = "auto";
  chatInput.style.height = `${Math.min(chatInput.scrollHeight, 120)}px`;
});
$("#chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = chatInput.value.trim();
  if (!message || chatSend.disabled) return;
  addChatMessage(message, "user");
  chatInput.value = "";
  chatInput.style.height = "auto";
  chatSend.disabled = true;
  const pending = addChatMessage("Thinking…", "assistant pending");
  try {
    const data = await api("/api/chat", { method: "POST", json: { message, history: chatHistory.slice(-12) } });
    pending.remove();
    addChatMessage(data.reply, "assistant");
    chatHistory.push({ role: "user", text: message }, { role: "model", text: data.reply });
  } catch (error) {
    pending.remove();
    addChatMessage(error.message, "assistant error");
  } finally {
    chatSend.disabled = false;
  }
});

/* ---------- Start ---------- */
function handleLinkParams() {
  const params = new URLSearchParams(location.search);
  const verified = params.get("verified");
  const reset = params.get("reset");
  if (!verified && !reset) return;
  history.replaceState(null, "", `${location.pathname}${location.hash}`);
  if (verified === "1") showToast("Email confirmed. You're signed in.");
  if (verified === "expired") openAccount("login", "That verification link has expired or was already used. Sign in, or send yourself a new link.");
  if (reset) {
    resetToken = reset;
    openAccount("reset");
  }
}

updateAreaLabels();
renderProfileButton();
renderPhotoQueue();
navigateTo(currentPage, false);
refreshState().then(handleLinkParams);
setInterval(async () => {
  if (currentPage !== "tracker" || document.hidden) return;
  try {
    const result = await api("/api/issues");
    issues = result.issues;
    coordinatorConfigured = Boolean(result.coordinatorConfigured);
    renderTracker();
    renderSecondaryMaps();
  } catch {}
}, 15_000);
