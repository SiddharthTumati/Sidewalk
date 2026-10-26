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
const PAGES = ["home", "report", "converter", "tracker", "petitions", "heatmap", "staff"];
const GUEST = { id: "guest", name: "Guest", email: "", guest: true };

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const isDesktop = () => window.matchMedia("(min-width: 900px)").matches;

let issues = [];
let activeFilter = "all";
let selectedIssueId = null;
let currentTrackerIssue = null;
let coordinatorConfigured = false;
let turnstileSiteKey = null;
let dataLoaded = false;
let loadFailed = false;
let confirmDuplicate = false;
let duplicateIssueId = null;
let flagIssueId = null;
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
// Friendly empty and error states, and shimmering placeholders while data loads.
function emptyState({ icon = "i-pin", title, text = "", action = "", actionLabel = "", error = false, tag = "div" }) {
  const button = action ? `<button class="btn ${error ? "btn-primary" : "btn-ghost"} btn-small" type="button" data-action="${action}">${escapeHtml(actionLabel)}</button>` : "";
  return `<${tag} class="empty-state rich${error ? " error" : ""}"><svg aria-hidden="true"><use href="#${icon}"/></svg><strong>${escapeHtml(title)}</strong>${text ? `<p>${escapeHtml(text)}</p>` : ""}${button}</${tag}>`;
}

function loadErrorState(tag = "div") {
  return emptyState({ icon: "i-close", title: "Couldn't load reports", text: "Check your connection, then try again.", action: "retry-load", actionLabel: "Try again", error: true, tag });
}

function skeletons(count, kind = "card", tag = "div") {
  const lines = kind === "card"
    ? `<span class="sk-line w45"></span><span class="sk-line tall w80"></span><span class="sk-line w95"></span><span class="sk-line w60"></span>`
    : `<span class="sk-line w80"></span><span class="sk-line w45"></span>`;
  return Array.from({ length: count }, () => `<${tag} class="skeleton ${kind === "card" ? "sk-card" : "sk-row"}" aria-hidden="true">${lines}</${tag}>`).join("");
}

// While the first load is running (or failed), lists show placeholders instead of "empty".
function notReady(container, { count = 3, kind = "card", tag = "div" } = {}) {
  if (dataLoaded) return false;
  container.innerHTML = loadFailed ? loadErrorState(tag) : skeletons(count, kind, tag);
  return true;
}

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

/* ---------- "I'm human" check (Cloudflare Turnstile) ---------- */
// Only loaded when the server has Turnstile keys and a form actually needs it.
let turnstileLoader = null;
const turnstileWidgets = {};

function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!turnstileLoader) {
    turnstileLoader = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.onload = () => resolve(window.turnstile);
      script.onerror = () => { turnstileLoader = null; reject(new Error("The human check couldn't load. Check your connection and try again.")); };
      document.head.append(script);
    });
  }
  return turnstileLoader;
}

// Shows (and renders once) the check in `slotId` when `needed`; hides it otherwise.
async function prepareTurnstile(slotId, needed) {
  const slot = document.getElementById(slotId);
  const show = Boolean(turnstileSiteKey && needed);
  slot.hidden = !show;
  if (!show || turnstileWidgets[slotId] !== undefined) return;
  try {
    const turnstile = await loadTurnstile();
    turnstileWidgets[slotId] = turnstile.render(slot, {
      sitekey: turnstileSiteKey,
      theme: document.documentElement.dataset.theme === "dark" || matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
      size: "flexible",
    });
  } catch (error) {
    showToast(error.message);
  }
}

function turnstileToken(slotId) {
  const slot = document.getElementById(slotId);
  if (!turnstileSiteKey || slot.hidden) return undefined;
  const id = turnstileWidgets[slotId];
  return id !== undefined && window.turnstile ? window.turnstile.getResponse(id) || "" : "";
}

function resetTurnstile(slotId) {
  const id = turnstileWidgets[slotId];
  if (id !== undefined && window.turnstile) window.turnstile.reset(id);
}

function laneHtml(issue) {
  const progress = Math.min(100, Math.round((issue.supporters / GOAL) * 100));
  return `<div class="lane ${pinStatus(issue)}" role="progressbar" aria-valuemin="0" aria-valuemax="${GOAL}" aria-valuenow="${issue.supporters}" aria-label="${issue.supporters} of ${GOAL} neighbors"><span style="width:${progress}%"></span><i></i></div>`;
}

function pendingNote(issue) {
  return issue.pendingSupporters > 0
    ? `<span class="pending-note" title="Endorsements from new accounts count after a day. It keeps the counts honest.">+${issue.pendingSupporters} pending</span>`
    : "";
}

function reviewBadge(issue) {
  return issue.underReview ? `<span class="badge review" title="Paused while a coordinator checks the endorsements">Under review</span>` : "";
}

function shareButton(issue) {
  return `<button class="icon-btn share-btn" type="button" data-share="${escapeHtml(issue.id)}" aria-label="Share: ${escapeHtml(issue.title)}"><svg aria-hidden="true"><use href="#i-share"/></svg></button>`;
}

function supportControl(issue, verb = "Back this") {
  if (issue.supporters >= GOAL) return `<span class="goal-label">Goal reached</span>`;
  if (issue.userSupported) return `<button class="support-button supported" type="button" data-supported-for="${escapeHtml(issue.id)}" disabled>Backed</button>`;
  return `<button class="support-button" type="button" data-support="${escapeHtml(issue.id)}" aria-label="${verb}: ${escapeHtml(issue.title)}">${verb}</button>`;
}

/* ---------- Area ---------- */
// Same box the server uses: Sidewalk covers North and South Carolina.
function inCarolinas(lat, lng) {
  return lat >= 31.9 && lat <= 36.7 && lng >= -84.4 && lng <= -75.3;
}

function loadSavedArea() {
  try {
    const saved = JSON.parse(localStorage.getItem("sidewalk-area"));
    if (saved && typeof saved.label === "string" && Number.isFinite(saved.lat) && Number.isFinite(saved.lng) && saved.label !== DEFAULT_AREA.label && inCarolinas(saved.lat, saved.lng)) return saved;
  } catch {}
  return { ...DEFAULT_AREA };
}

function updateAreaLabels() {
  ["#selected-area-label", "#map-area-label", "#sidebar-area"].forEach((sel) => { $(sel).textContent = currentArea.label; });
  if (!pendingLocation) $("#report-location-label").textContent = currentArea.label;
}

function fitArea(target, zoom) {
  if (!target) return;
  // A brand-new map has no position yet, so it can't animate ("fly"); jump straight there.
  const fresh = !target._loaded;
  if (currentArea.bounds) target.fitBounds(currentArea.bounds, { padding: [30, 30], maxZoom: isDesktop() ? 7 : 6, animate: !fresh });
  else if (fresh) target.setView([currentArea.lat, currentArea.lng], zoom);
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
  $("#result-count").textContent = dataLoaded ? `${filtered.length} ${filtered.length === 1 ? "report" : "reports"} showing.` : loadFailed ? "Reports couldn't load." : "Loading reports…";
  $("#filter-all-count").textContent = issues.length;
  if (notReady(list)) return;
  list.innerHTML = filtered.map((issue) => {
    const photos = issue.photos || [];
    const thumb = photos.length
      ? `<div class="card-photos">${photoButton(issue, 0, "card-photo")}${photos.length > 1 ? `<span class="more">+${photos.length - 1}</span>` : ""}</button></div>`
      : "";
    const priority = issue.safety && issue.status !== "resolved" ? `<span class="badge danger">Crash hot spot</span>` : issue.status === "resolved" ? `<span class="badge resolved">Fixed</span>` : (issue.supporters >= PRIORITY_THRESHOLD ? `<span class="badge priority">Priority</span>` : "") + reviewBadge(issue);
    return `<article class="issue-card ${issue.id === selectedIssueId ? "selected" : ""}" data-issue="${escapeHtml(issue.id)}" tabindex="0">
      <div class="card-meta"><span class="cat"><i class="cat-dot cat-${escapeHtml(issue.category)}"></i>${escapeHtml(issue.categoryLabel)}</span><span>${escapeHtml(issue.distance)}</span>${priority}</div>
      <h3>${escapeHtml(issue.title)}</h3>
      <p class="desc">${escapeHtml(issue.description)}</p>
      ${thumb}
      <div class="card-foot">
        <div class="support-meta"><span><strong data-count-for="${escapeHtml(issue.id)}">${issue.supporters}</strong> of ${GOAL} neighbors${pendingNote(issue)}</span>${laneHtml(issue)}</div>
        <div class="card-actions">${shareButton(issue)}${supportControl(issue)}</div>
      </div>
    </article>`;
  }).join("") || (activeFilter === "all"
    ? emptyState({ title: "No reports here yet", text: "Spotted something broken nearby? Be the first to pin it.", action: "start-report", actionLabel: "Report an issue" })
    : emptyState({ title: "Nothing of this type yet", text: "Try another category, or see every report.", action: "show-all", actionLabel: "Show all reports" }));
}

function renderHome() {
  $("#home-issue-count").textContent = issues.length;
  $("#home-support-count").textContent = issues.reduce((sum, issue) => sum + issue.supporters, 0);
  $("#home-priority-count").textContent = issues.filter((issue) => issue.supporters >= PRIORITY_THRESHOLD).length;
  if (notReady($("#home-feed"), { count: 3, kind: "row" })) return;
  const latest = [...issues].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 4);
  $("#home-feed").innerHTML = latest.map((issue) => `<button class="feed-item" type="button" data-open-issue="${escapeHtml(issue.id)}">
      <span class="feed-thumb">${issue.photos?.length ? `<img src="${escapeHtml(issue.photos[0])}" alt="" loading="lazy">` : `<svg aria-hidden="true"><use href="#i-pin"/></svg>`}</span>
      <span><strong>${escapeHtml(issue.title)}</strong><small><i class="cat-dot cat-${escapeHtml(issue.category)}"></i>${escapeHtml(issue.distance)} · ${issue.supporters} backing</small></span>
    </button>`).join("") || emptyState({ title: "No reports yet", text: "New reports from around the Carolinas will show up here.", action: "start-report", actionLabel: "Report the first one" });
}

function renderPetitions() {
  if (notReady($("#petition-list"))) return;
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
      <div class="row"><span class="petition-count"><strong data-count-for="${escapeHtml(issue.id)}">${issue.supporters}</strong> of ${GOAL} neighbors${pendingNote(issue)}</span>${supportControl(issue, "Endorse")}</div>
    </article>`;
  }).join("") || emptyState({ icon: "i-hand", title: "No petitions yet", text: "Every report becomes a petition neighbors can back. Start one by reporting an issue.", action: "start-report", actionLabel: "Report an issue" });
}

function nextStageFor(issue) {
  const status = issue.status || "submitted";
  if (status === "resolved") return null;
  if (status === "submitted" || status === "ai_reviewed") return issue.supporters >= PRIORITY_THRESHOLD ? "community_priority" : "sent_to_agency";
  return STAGE_ORDER[STAGE_ORDER.indexOf(status) + 1] || null;
}

function renderTracker() {
  if (notReady($("#tracker-issues"), { count: 4, kind: "row" })) {
    $("#tracker-detail").innerHTML = loadFailed ? "" : skeletons(1);
    return;
  }
  const sorted = [...issues].sort(byPriority);
  $("#tracker-count").textContent = sorted.length;
  if (!sorted.some((issue) => issue.id === currentTrackerIssue)) currentTrackerIssue = sorted[0]?.id || null;
  $("#tracker-issues").innerHTML = sorted.map((issue) => `<button class="tracker-card ${issue.id === currentTrackerIssue ? "selected" : ""}" type="button" data-track-issue="${escapeHtml(issue.id)}" aria-pressed="${issue.id === currentTrackerIssue}">
      <span class="row"><strong>${escapeHtml(issue.title)}</strong><span class="badge ${issue.status === "resolved" ? "resolved" : ""}">${escapeHtml(STAGE_LABELS[issue.status] || STAGE_LABELS.submitted)}</span></span>
      <small>${escapeHtml(issue.distance)} · ${issue.supporters} backing${issue.photos?.length ? ` · ${issue.photos.length} photo${issue.photos.length > 1 ? "s" : ""}` : ""}</small>
    </button>`).join("") || emptyState({ icon: "i-track", title: "Nothing to track yet", text: "Once someone reports an issue, you can follow it here from pinned to fixed." });
  renderTrackerDetail(issues.find((issue) => issue.id === currentTrackerIssue));
}

function renderTrackerDetail(issue) {
  const detail = $("#tracker-detail");
  if (!issue) {
    detail.innerHTML = emptyState({ icon: "i-track", title: "Pick a report", text: "Choose a report to see its timeline." });
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
  const fixed = issue.status === "resolved";
  const afterButtons = (issue.afterPhotos || []).map((url, i) => `<button type="button" data-photo-issue="${escapeHtml(issue.id)}" data-photo-index="${i}" data-photo-set="after" aria-label="View after photo ${i + 1} for ${escapeHtml(issue.title)}"><img src="${escapeHtml(url)}" alt="" loading="lazy" decoding="async"></button>`).join("");
  const beforeButtons = (issue.photos || []).map((_, i) => photoButton(issue, i) + "</button>").join("");
  const gallery = issue.afterPhotos?.length
    ? `<div class="before-after"><figure><figcaption>Before</figcaption><div class="gallery">${beforeButtons || `<p class="hint">No before photo</p>`}</div></figure><figure><figcaption>After</figcaption><div class="gallery">${afterButtons}</div></figure></div>`
    : beforeButtons ? `<div class="gallery">${beforeButtons}</div>` : "";
  const fixedBanner = fixed ? `<div class="fixed-banner"><span class="cony-slot cony-lg happy mood-party" aria-hidden="true">${conySvg()}</span><div><strong>Fixed!</strong><span>${issue.supporters > 1 ? `Thanks to the ${issue.supporters} neighbors who spoke up.` : "Thanks to everyone who spoke up."}</span></div></div>` : "";
  const staleNote = issue.stale ? `<div class="notice warn stale-note"><p><strong>No update in ${issue.daysSinceUpdate} days.</strong> A polite follow-up often gets things moving.</p><button class="btn btn-ghost btn-small" type="button" data-followup="${escapeHtml(issue.id)}"><span class="cony-slot mood-sad" aria-hidden="true">${conySvg()}</span>Draft a follow-up with Cony</button></div>` : "";
  detail.innerHTML = `${fixedBanner}<div class="detail-top"><span><i class="cat-dot cat-${escapeHtml(issue.category)}"></i> ${escapeHtml(issue.categoryLabel)}, ${escapeHtml(issue.distance)}</span><span>${timeAgo(issue.createdAt)}</span></div>
    <h3>${escapeHtml(issue.title)}</h3>
    <p class="detail-desc">${escapeHtml(issue.description)}</p>
    ${gallery}
    <ol class="timeline" aria-label="Progress">${steps}</ol>
    ${staleNote}
    ${issue.safety ? `<div class="notice danger-note"><strong>Safety hot spot.</strong> ${issue.safety.fatalCrashes} fatal crash${issue.safety.fatalCrashes === 1 ? "" : "es"} (${issue.safety.fatalities} ${issue.safety.fatalities === 1 ? "death" : "deaths"}) happened within ${issue.safety.radiusMeters} m of this spot from ${issue.safety.fromYear} to ${issue.safety.toYear}, according to federal crash records (NHTSA FARS).</div>` : ""}
    ${!issue.stale && issue.status === "in_progress" ? `<p class="mood-line"><span class="cony-slot cony-sm mood-working" aria-hidden="true">${conySvg()}</span>Crews are on it. Cony will cheer when it's fixed.</p>` : ""}
    <div class="responsible" id="responsible-${escapeHtml(issue.id)}"></div>
    ${issue.underReview ? `<p class="notice warn">Under review: a coordinator is checking this report's endorsements before it can move forward.</p>` : ""}
    <div class="button-row tight detail-actions">
      <button class="btn ${issue.isSubscribed ? "btn-ghost" : "btn-primary"}" type="button" data-subscribe-issue="${escapeHtml(issue.id)}">${issue.isSubscribed ? "Following. Tap to stop" : "Follow updates"}</button>
      <button class="btn btn-ghost" type="button" data-share="${escapeHtml(issue.id)}"><svg aria-hidden="true"><use href="#i-share"/></svg>Share</button>
    </div>
    <a class="text-link small packet-link" href="/packet/${encodeURIComponent(issue.id)}" target="_blank" rel="noopener">Council packet (print or save as PDF)</a>
    <p class="hint">The review step checks that a report is clear. It doesn't confirm conditions on site.</p>
    <div class="flag-row">${issue.userFlagged ? `<p class="hint">You flagged this report. Thanks for helping keep Sidewalk useful.</p>` : `<button class="text-link small" type="button" data-flag-issue="${escapeHtml(issue.id)}">Flag this report</button>`}</div>`;

  fillResponsibility(issue);
  if (fixed) celebrateOnce(issue);

  const nextStage = nextStageFor(issue);
  const enabled = coordinatorConfigured && Boolean(nextStage);
  $("#coordinator-status-note").textContent = !coordinatorConfigured
    ? "Status updates are off until the server has an ADMIN_TOKEN."
    : nextStage ? "Only publish a status you've confirmed." : "This report is at its final stage.";
  $("#tracker-new-status").innerHTML = nextStage ? `<option value="${nextStage}">${STAGE_LABELS[nextStage]}</option>` : `<option value="">No next step</option>`;
  ["#tracker-new-status", "#tracker-status-note", "#tracker-update-status"].forEach((sel) => { $(sel).disabled = !enabled; });
  const staffCan = (cap) => Boolean(activeUser.can?.includes(cap));
  const signedInStaff = staffCan("update_status") || staffCan("moderate");
  $("#staff-signed-in").hidden = !signedInStaff;
  $("#staff-signed-in").textContent = signedInStaff ? `Signed in as ${activeUser.roleLabel}. No token needed.` : "";
  $("#token-field").hidden = signedInStaff;
  $("#tracker-admin-token").disabled = !coordinatorConfigured;
  if (signedInStaff) {
    $("#coordinator-status-note").textContent = nextStage ? "Only publish a status you've confirmed." : "This report is at its final stage.";
    ["#tracker-new-status", "#tracker-status-note", "#tracker-update-status"].forEach((sel) => { $(sel).disabled = !nextStage || !staffCan("update_status"); });
  }
  $$("#mod-selected [data-mod-action], #load-mod-queue, #load-activity").forEach((button) => { button.disabled = !(coordinatorConfigured || staffCan("moderate")); });
  updateRoleToolsVisibility();

}

function renderHotspots() {
  const groups = new Map();
  issues.forEach((issue) => {
    const spot = groups.get(issue.distance) || { location: issue.distance, reports: 0, backing: 0, lat: issue.lat, lng: issue.lng };
    spot.reports += 1;
    spot.backing += issue.supporters;
    groups.set(issue.distance, spot);
  });
  if (notReady($("#hotspot-list"), { count: 3, kind: "row", tag: "li" })) return;
  const sorted = [...groups.values()].sort((a, b) => b.backing - a.backing);
  const max = Math.max(1, ...sorted.map((spot) => spot.backing));
  $("#hotspot-count").textContent = sorted.length;
  $("#hotspot-list").innerHTML = sorted.map((spot) => `<li class="hotspot-row" data-hotspot-lat="${spot.lat}" data-hotspot-lng="${spot.lng}">
      <strong>${escapeHtml(spot.location)}</strong><span class="count-pill">${spot.backing}</span>
      <small>${spot.reports} report${spot.reports === 1 ? "" : "s"}, ${spot.backing} neighbors backing</small>
      <span class="heat-bar" style="width:${Math.max(8, Math.round((spot.backing / max) * 100))}%"></span>
    </li>`).join("") || emptyState({ icon: "i-heat", title: "No hotspots yet", text: "Hotspots appear as reports come in.", tag: "li" });
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
  try {
    buildMap();
  } catch (error) {
    console.error("Map failed to start:", error);
    map = null;
    $("#map-loading").textContent = "The map couldn't load. Refresh to try again.";
    $("#map-loading").classList.remove("hidden");
  }
}

function buildMap() {
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
  L.tileLayer(BASEMAPS.street.url, { maxZoom: 19, attribution: BASEMAPS.street.attribution }).addTo(m);
  try {
    fitArea(m, 10);
  } catch (error) {
    console.error("Map view failed, showing the Carolinas instead:", error);
    m.fitBounds(DEFAULT_AREA.bounds);
  }
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
  $$("[data-page-section]").forEach((section) => {
    const show = section.dataset.pageSection === currentPage;
    if (show && section.hidden) {
      section.classList.remove("page-enter");
      void section.offsetWidth; // restart the animation
      section.classList.add("page-enter");
    }
    section.hidden = !show;
  });
  $$(".nav-link, .tab").forEach((button) => {
    const active = button.dataset.pageTarget === currentPage;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  });
  if (updateUrl && location.hash !== `#${currentPage}`) history.pushState(null, "", `#${currentPage}`);
  if (currentPage === "report") {
    if (!map) initMap(); else requestAnimationFrame(() => map.invalidateSize());
  }
  if (currentPage === "staff") loadStaffQueue();
  if (currentPage === "heatmap") loadImpact();
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
  button.setAttribute("aria-label", signedIn ? `${initials(activeUser.name)}, account for ${activeUser.name}` : "Sign in or create an account");
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
  show("#register-agree", mode === "register");
  show("#delete-form", false);
  prepareTurnstile("account-turnstile", mode === "register" || mode === "forgot");

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
    $("#settings-role").hidden = !activeUser.role || activeUser.role === "resident";
    $("#settings-role").textContent = activeUser.roleLabel || "";
    renderPushSetting();
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
  $$(".staff-only").forEach((el) => { el.hidden = !activeUser.can?.includes("update_status"); });
  if (currentPage === "staff" && !activeUser.can?.includes("update_status")) navigateTo("home");
  renderProfileButton();
}

async function refreshState() {
  try {
    // Offline, the account check can't run, but the last saved report list still can be shown.
    const [auth, result] = await Promise.all([
      api("/api/auth/me").catch((error) => { if (error.status === 0 && !navigator.onLine) return { user: activeUser.guest ? null : activeUser, offline: true }; throw error; }),
      api("/api/issues"),
    ]);
    emailConfigured = Boolean(auth.emailConfigured);
    turnstileSiteKey = auth.turnstileSiteKey || null;
    coordinatorConfigured = Boolean(result.coordinatorConfigured);
    setActiveUser(auth.user);
    issues = result.issues;
    const firstLoad = !dataLoaded;
    dataLoaded = true;
    loadFailed = false;
    if (firstLoad) playFirstPaint();
    renderAll();
  } catch (error) {
    if (!dataLoaded) { loadFailed = true; renderAll(); }
    if (navigator.onLine) showToast(error.message);
  } finally {
    finishBoot();
  }
}

// Fade the loading screen out once the first load is done (a short minimum avoids a flash).
const bootStarted = performance.now();
// On a slow connection, don't hold the loading screen for long; placeholders take over.
setTimeout(() => finishBoot(), 1100);
function finishBoot() {
  const boot = $("#boot");
  if (!boot || boot.classList.contains("done")) return;
  setTimeout(() => boot.classList.add("done"), Math.max(0, 450 - (performance.now() - bootStarted)));
  setTimeout(() => boot.remove(), 1200);
}

// Cards rise in and progress bars fill on the first load only, not on every update.
function playFirstPaint() {
  document.body.classList.add("first-paint");
  setTimeout(() => document.body.classList.remove("first-paint"), 1600);
}

function updateOnlineStatus() {
  const offline = !navigator.onLine;
  $("#offline-bar").hidden = !offline;
  document.body.classList.toggle("is-offline", offline);
}
window.addEventListener("offline", updateOnlineStatus);
window.addEventListener("online", async () => {
  updateOnlineStatus();
  await refreshState();
  const sent = await flushOutbox();
  if (!sent) showToast("You're back online.");
});

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

  const humanToken = turnstileToken("account-turnstile");
  if (humanToken === "") return setAccountError("Complete the “I’m human” check first.");

  setLoading(button, true);
  try {
    if (accountMode === "login") {
      const result = await api("/api/auth/login", { method: "POST", json: { email, password } });
      await afterSignIn(`Signed in as ${result.user.name}.`);
    } else if (accountMode === "register") {
      const result = await api("/api/auth/register", { method: "POST", json: { name, email, password, emailUpdates: $("#email-updates").checked, turnstileToken: humanToken } });
      if (result.pendingVerification) {
        setAccountMode("login");
        $("#account-email").value = email;
        setAccountNotice(`<strong>Check your inbox.</strong> We sent a link to ${escapeHtml(email)}. Open it on this device to finish signing up.`);
        $("#resend-verification").hidden = false;
      } else {
        await afterSignIn(result.message);
      }
    } else if (accountMode === "forgot") {
      const result = await api("/api/auth/forgot-password", { method: "POST", json: { email, turnstileToken: humanToken } });
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
    resetTurnstile("account-turnstile");
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
    issue.pendingSupporters = result.pendingSupporters;
    issue.underReview = issue.underReview || result.underReview;
    issue.userSupported = true;
    issue.isSubscribed = true;
    if (result.priorityReached) issue.status = "community_priority";
    renderAll();
    $$(`[data-count-for="${CSS.escape(id)}"]`).forEach((el) => el.classList.add("bump"));
    $$(`[data-supported-for="${CSS.escape(id)}"]`).forEach((el) => el.classList.add("just-backed"));
    if (result.pending) showToast("Thanks! New accounts' endorsements count after one day. It keeps fake accounts out.");
    else if (result.underReview) showToast("Thanks! This report is under review, so its count is paused for now.");
    else showToast(result.priorityReached ? `That's ${result.count}. This is now a neighborhood priority.` : `You're in. ${result.count} neighbors are backing this.`);
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
  updateConyPhotoButton();
  $("#photo-hint").textContent = photoQueue.length
    ? `${photoQueue.length} of ${MAX_PHOTOS} photos added.`
    : "Photos help crews find and size up the problem. Large photos are shrunk before upload.";
}

function openLightbox(issueId, index, set = "before") {
  const issue = issues.find((entry) => entry.id === issueId) || staffItems.find((entry) => entry.id === issueId);
  const photos = set === "after" ? issue?.afterPhotos : issue?.photos;
  if (!photos?.length) return;
  lightboxState = { photos, index, caption: set === "after" ? `${issue.title} (after)` : issue.title };
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
  hideDuplicate();
  resetConyAssist();
  prepareTurnstile("report-turnstile", activeUser.guest);
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
  const draft = {
    title,
    category: new FormData(form).get("category"),
    description,
    distance: currentArea.label,
    lat: location.lat,
    lng: location.lng,
    photos: photoQueue.map((entry) => entry.dataUrl),
    confirmNotDuplicate: confirmDuplicate,
  };
  // No signal? Save it on this device and send it later instead of losing it.
  if (!navigator.onLine) return saveOfflineReport(draft, form);

  const humanToken = turnstileToken("report-turnstile");
  if (humanToken === "") return (errorLabel.textContent = "Complete the “I’m human” check first, or sign in.");

  setLoading(button, true);
  try {
    const result = await api("/api/issues", { method: "POST", json: { ...draft, turnstileToken: humanToken } });
    if (outboxResumeId) { await outboxDelete(outboxResumeId); outboxResumeId = null; updateOutboxBar(); }
    hideDuplicate();
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
    if (error.status === 0) { setLoading(button, false); return saveOfflineReport(draft, form); }
    if (error.status === 409 && error.data?.duplicate) showDuplicate(error.data.duplicate);
    else errorLabel.textContent = error.message;
  } finally {
    confirmDuplicate = false;
    setLoading(button, false);
    resetTurnstile("report-turnstile");
  }
}

function showDuplicate(existing) {
  duplicateIssueId = existing.id;
  if (!issues.some((issue) => issue.id === existing.id)) issues.push(existing);
  $("#duplicate-text").textContent = `“${existing.title}” was posted ${timeAgo(existing.createdAt)} and has ${existing.supporters} of ${GOAL} neighbors behind it. Backing it adds your voice where it counts.`;
  $("#duplicate-panel").hidden = false;
  $("#duplicate-panel").scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function hideDuplicate() {
  duplicateIssueId = null;
  $("#duplicate-panel").hidden = true;
}

$("#duplicate-post").addEventListener("click", () => {
  confirmDuplicate = true;
  hideDuplicate();
  $("#report-form").requestSubmit();
});
$("#duplicate-back").addEventListener("click", () => {
  const id = duplicateIssueId;
  hideDuplicate();
  closeDialog("report-modal");
  if (currentPage !== "report") navigateTo("report");
  requestAnimationFrame(() => {
    selectIssue(id);
    handleSupport(id);
  });
});

/* ---------- Flagging ---------- */
function openFlag(id) {
  if (!requireAccount("Sign in to flag a report. It keeps flags one per person.", () => openFlag(id))) return;
  flagIssueId = id;
  $("#flag-form").reset();
  $("#flag-error").textContent = "";
  openDialog("flag-modal");
}

$("#flag-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const reason = new FormData(event.currentTarget).get("reason");
  if (!reason) return ($("#flag-error").textContent = "Choose what's wrong with this report.");
  const button = $("#flag-submit");
  setLoading(button, true);
  try {
    const result = await api(`/api/issues/${encodeURIComponent(flagIssueId)}/flag`, { method: "POST", json: { reason } });
    closeDialog("flag-modal");
    if (result.hidden) {
      issues = issues.filter((issue) => issue.id !== flagIssueId);
      if (currentTrackerIssue === flagIssueId) currentTrackerIssue = null;
      showToast("Thanks. Several neighbors flagged this, so it's hidden until a coordinator reviews it.");
    } else {
      const issue = issues.find((entry) => entry.id === flagIssueId);
      if (issue) issue.userFlagged = true;
      showToast("Thanks. A coordinator will take a look.");
    }
    renderAll();
  } catch (error) {
    $("#flag-error").textContent = error.message;
  } finally {
    setLoading(button, false);
  }
});

/* ---------- Coordinator moderation ---------- */
// Staff requests use the signed-in account when it has the role, otherwise the typed token.
function staffHeaders(capability) {
  const token = $("#tracker-admin-token").value.trim();
  if (token) return { Authorization: `Bearer ${token}` };
  if (activeUser.can?.includes(capability)) return {};
  showToast("Sign in with a staff account, or enter the coordinator token.");
  return null;
}

function modItemHtml(item) {
  const reporter = item.reporter.guest
    ? `Guest report${item.reporter.networkBlocked ? " · network blocked" : ""}`
    : `By ${escapeHtml(item.reporter.name)} (${escapeHtml(item.reporter.email)})${item.reporter.suspended ? " · suspended" : ""}`;
  const tags = [
    item.hidden ? `<span class="badge priority">Hidden</span>` : "",
    item.underReview ? `<span class="badge review">Under review</span>` : "",
    ...item.flags.map((f) => `<span class="badge">${escapeHtml(f.reason)} × ${f.total}</span>`),
  ].join("");
  const why = [item.hiddenReason, item.reviewReason].filter(Boolean).map(escapeHtml).join(". ");
  const suspended = item.reporter.suspended || item.reporter.networkBlocked;
  return `<li class="mod-item" data-mod-id="${escapeHtml(item.id)}">
    <strong>${escapeHtml(item.title)}</strong>
    <p class="mod-meta">${escapeHtml(item.categoryLabel)} in ${escapeHtml(item.distance)} · ${reporter}</p>
    ${why ? `<p class="mod-meta">${why}</p>` : ""}
    <div class="mod-tags">${tags}</div>
    <div class="button-row tight">
      ${item.hidden || item.underReview || item.flagTotal ? `<button class="btn btn-ghost btn-small" type="button" data-mod-action="restore">${item.hidden ? "Restore" : "Mark reviewed"}</button>` : ""}
      ${item.hidden ? "" : `<button class="btn btn-ghost btn-small" type="button" data-mod-action="hide">Hide</button>`}
      <button class="btn btn-ghost btn-small" type="button" data-mod-action="${suspended ? "unsuspend-reporter" : "suspend-reporter"}" ${suspended ? "" : 'data-confirm="Tap again to suspend"'}>${suspended ? "Lift suspension" : "Suspend reporter"}</button>
      <button class="btn btn-ghost btn-small danger" type="button" data-mod-action="delete" data-confirm="Tap again to delete">Delete</button>
    </div>
  </li>`;
}

async function loadModerationQueue() {
  const headers = staffHeaders("moderate");
  if (!headers) return;
  const button = $("#load-mod-queue");
  setLoading(button, true);
  try {
    const result = await api("/api/admin/moderation", { headers });
    $("#mod-queue").innerHTML = result.items.length
      ? result.items.map(modItemHtml).join("")
      : `<li class="mod-item"><p class="mod-meta">Nothing flagged, hidden, or under review. All clear.</p></li>`;
  } catch (error) {
    showToast(error.message);
  } finally {
    setLoading(button, false);
  }
}

// Destructive actions need a second tap within a few seconds instead of a pop-up.
function needsSecondTap(button) {
  if (!button.dataset.confirm) return false;
  if (button.classList.contains("confirming")) return false;
  const original = button.textContent;
  button.classList.add("confirming");
  button.textContent = button.dataset.confirm;
  setTimeout(() => { button.classList.remove("confirming"); button.textContent = original; }, 4000);
  return true;
}

async function runModAction(button, issueId) {
  const action = button.dataset.modAction;
  if (!issueId) return showToast("Choose a report first.");
  const headers = staffHeaders("moderate");
  if (!headers || needsSecondTap(button)) return;
  button.classList.remove("confirming");
  setLoading(button, true);
  try {
    const method = action === "delete" ? "DELETE" : "POST";
    const path = action === "delete" ? `/api/admin/issues/${encodeURIComponent(issueId)}` : `/api/admin/issues/${encodeURIComponent(issueId)}/${action}`;
    const result = await api(path, { method, headers, json: method === "POST" ? {} : undefined });
    const row = $(`.mod-item[data-mod-id="${CSS.escape(issueId)}"]`);
    if (row) {
      if (result.deleted) row.remove();
      else row.outerHTML = modItemHtml(result.item);
    }
    showToast({ hide: "Report hidden.", restore: "Report restored and marked reviewed.", delete: "Report deleted.", "suspend-reporter": "Reporter suspended.", "unsuspend-reporter": "Suspension lifted." }[action] || "Done.");
    if (action === "delete" || action === "hide" || action === "suspend-reporter") {
      if (currentTrackerIssue === issueId) currentTrackerIssue = null;
    }
    await refreshState();
  } catch (error) {
    showToast(error.message);
  } finally {
    setLoading(button, false);
  }
}

$("#load-mod-queue").addEventListener("click", loadModerationQueue);
$("#mod-selected").addEventListener("click", (event) => {
  const button = event.target.closest("[data-mod-action]");
  if (button) runModAction(button, currentTrackerIssue);
});
$("#mod-queue").addEventListener("click", (event) => {
  const button = event.target.closest("[data-mod-action]");
  if (button) runModAction(button, button.closest("[data-mod-id]").dataset.modId);
});

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
    const params = new URLSearchParams({ q: query, format: "jsonv2", addressdetails: "1", limit: "8", countrycodes: "us", viewbox: "-84.4,36.7,-75.3,31.9", bounded: "1" });
    const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
    if (!response.ok) throw new Error("Place search is busy right now. Try again in a moment.");
    placeResults = (await response.json())
      .filter((r) => Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lon)))
      .filter((r) => ["North Carolina", "South Carolina"].includes(r.address?.state))
      .slice(0, 6);
    status.textContent = placeResults.length ? "" : "No matches in North or South Carolina. Try a city, town, or ZIP code there.";
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
  if (photo) { event.stopPropagation(); return openLightbox(photo.dataset.photoIssue, Number(photo.dataset.photoIndex), photo.dataset.photoSet || "before"); }
  const support = target.closest("[data-support]");
  if (support) { event.stopPropagation(); return handleSupport(support.dataset.support, support); }
  const nav = target.closest("[data-page-target]");
  if (nav) { event.preventDefault(); return navigateTo(nav.dataset.pageTarget); }
  if (target.closest('[data-action="start-report"]')) return openReport();
  if (target.closest('[data-action="retry-load"]')) { loadFailed = false; renderAll(); return refreshState(); }
  if (target.closest('[data-action="show-all"]')) {
    activeFilter = "all";
    $$("[data-filter]").forEach((chip) => chip.classList.toggle("active", chip.dataset.filter === "all"));
    return renderAll();
  }
  const close = target.closest("[data-close]");
  if (close) return closeDialog(close.dataset.close);
  const followup = target.closest("[data-followup]");
  if (followup) return openFollowup(followup.dataset.followup);
  const share = target.closest("[data-share]");
  if (share) { event.stopPropagation(); return shareIssue(share.dataset.share); }
  const flag = target.closest("[data-flag-issue]");
  if (flag) return openFlag(flag.dataset.flagIssue);
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
  if (!issue) return showToast("Choose a report first.");
  const headers = staffHeaders("update_status");
  if (!headers) return;
  const button = event.currentTarget;
  setLoading(button, true);
  try {
    const result = await api(`/api/issues/${encodeURIComponent(issue.id)}/status`, {
      method: "PATCH",
      headers,
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

// Cony's request writer
$("#converter-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#converter-submit");
  const message = $("#converter-message").value.trim();
  const place = $("#converter-location").value.trim();
  $("#converter-error").textContent = "";
  if (message.length < 10) return ($("#converter-error").textContent = "Add a bit more detail (at least 10 characters).");
  setLoading(button, true);
  setCony("#cony-writer", "thinking");
  try {
    const { draft } = await api("/api/convert", { method: "POST", json: { message, location: place } });
    setCony("#cony-writer", "happy");
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
    setCony("#cony-writer", "");
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
  if (role.startsWith("assistant")) {
    // Cony's replies sit next to a small Cony.
    const row = document.createElement("div");
    row.className = "chat-row";
    row.innerHTML = `<span class="cony-slot cony-sm" aria-hidden="true">${conySvg()}</span>`;
    row.append(message);
    chatMessages.append(row);
  } else {
    chatMessages.append(message);
  }
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
  const bubble = addChatMessage("", "assistant pending");
  bubble.innerHTML = `<span class="typing" aria-hidden="true"><i></i><i></i><i></i></span><span class="sr-only">Cony is typing</span>`;
  setCony("#cony-head", "thinking");
  try {
    const reply = await streamChatReply(message, bubble);
    chatHistory.push({ role: "user", text: message }, { role: "model", text: reply });
    setCony("#cony-head", "happy");
  } catch (error) {
    bubble.className = "chat-message assistant-message error-message";
    bubble.textContent = error.message;
    setCony("#cony-head", "");
  } finally {
    chatMessages.removeAttribute("aria-busy");
    chatSend.disabled = false;
  }
});

// Shows the reply as it's written. The server sends small pieces as soon as the AI produces
// them; we reveal them smoothly, catching up quickly so it finishes when the AI finishes.
async function streamChatReply(message, bubble) {
  let response;
  try {
    response = await fetch("/api/chat", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history: chatHistory.slice(-12) }),
    });
  } catch {
    throw new Error("Can't reach Sidewalk. Check your connection and try again.");
  }
  if (!response.ok || !(response.headers.get("content-type") || "").includes("ndjson")) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Something went wrong. Try again.");
  }

  let received = "";
  let shown = 0;
  let streamDone = false;
  let streamError = null;
  let started = false;
  const nearBottom = () => chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 60;

  const revealed = new Promise((resolve) => {
    const tick = () => {
      if (shown < received.length) {
        if (!started) {
          started = true;
          setCony("#cony-head", "talking");
          bubble.className = "chat-message assistant-message streaming";
          chatMessages.setAttribute("aria-busy", "true");
        }
        const stick = nearBottom();
        shown += Math.max(1, Math.ceil((received.length - shown) / 6));
        bubble.textContent = received.slice(0, shown);
        if (stick) chatMessages.scrollTop = chatMessages.scrollHeight;
      }
      if (streamDone && shown >= received.length) return resolve();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.delta) received += event.delta;
        if (event.error) streamError = event.error;
      }
    }
  } catch {
    streamError = streamError || "The reply was cut off. Please try again.";
  }
  streamDone = true;
  await revealed;
  bubble.classList.remove("streaming");
  if (streamError && !received) throw new Error(streamError);
  if (streamError) {
    const note = document.createElement("span");
    note.className = "chat-cutoff";
    note.textContent = ` (${streamError})`;
    bubble.append(note);
  }
  return received;
}

/* ---------- Cony, the traffic-cone helper ---------- */
// Drawn inline so each Cony can blink, look around, talk, and hop on its own.
function conySvg() {
  return `<svg class="cony" viewBox="0 0 64 64" focusable="false">
    <ellipse class="cony-shadow" cx="32" cy="60.5" rx="21" ry="2.4"/>
    <g class="cony-body">
      <rect x="9" y="51" width="46" height="8" rx="3" fill="#2b3035"/>
      <path d="M27 6.5Q32 2.5 37 6.5L50.5 52.5H13.5Z" fill="#f26b2a" stroke="#23272b" stroke-width="2.6" stroke-linejoin="round"/>
      <path d="M23.4 19H40.6L42.9 27.5H21.1Z" fill="#fff"/>
      <g class="cony-eyes">
        <ellipse cx="26" cy="37.5" rx="3.8" ry="4.4" fill="#fff"/><ellipse cx="38" cy="37.5" rx="3.8" ry="4.4" fill="#fff"/>
        <g class="cony-pupils"><circle cx="26.6" cy="38.2" r="2.1" fill="#23272b"/><circle cx="38.6" cy="38.2" r="2.1" fill="#23272b"/></g>
      </g>
      <circle cx="20.6" cy="44.2" r="2.1" fill="#ff9f7f"/><circle cx="43.4" cy="44.2" r="2.1" fill="#ff9f7f"/>
      <path class="cony-smile" d="M28.4 44.6Q32 48.4 35.6 44.6" fill="none" stroke="#23272b" stroke-width="2.1" stroke-linecap="round"/>
      <ellipse class="cony-talk" cx="32" cy="46" rx="2.6" ry="2.2" fill="#23272b"/>
      <path class="cony-frown" d="M28.4 47.4Q32 43.8 35.6 47.4" fill="none" stroke="#23272b" stroke-width="2.1" stroke-linecap="round"/>
      <g class="cony-hat"><path d="M23 10.5Q23 1.5 32 1.5T41 10.5Z" fill="#f2c230" stroke="#23272b" stroke-width="2" stroke-linejoin="round"/><path d="M32 1.8V10" stroke="#23272b" stroke-width="1.6"/><rect x="18.5" y="9.6" width="27" height="3.6" rx="1.8" fill="#f2c230" stroke="#23272b" stroke-width="2"/></g>
    </g>
    <g class="cony-party" stroke-width="2.4" stroke-linecap="round"><path d="M6 14l3 2.5" stroke="#2f6fb3"/><path d="M58 14l-3 2.5" stroke="#2f7a50"/><path d="M10 5l1.5 3.5" stroke="#d9532a"/><path d="M54 5l-1.5 3.5" stroke="#f2c230"/><circle cx="4" cy="25" r="1.6" fill="#f2c230" stroke="none"/><circle cx="60" cy="25" r="1.6" fill="#d9532a" stroke="none"/></g>
  </svg>`;
}

// state: "thinking" (bobs, looks around), "talking" (mouth moves), "happy" (one hop), or "" (idle).
function setCony(selector, state) {
  const el = typeof selector === "string" ? $(selector) : selector;
  if (!el) return;
  el.classList.remove("thinking", "talking", "happy");
  if (state) {
    void el.offsetWidth;
    el.classList.add(state);
  }
  if (state === "happy") setTimeout(() => el.classList.remove("happy"), 900);
}

$$(".cony-slot").forEach((slot) => { if (!slot.firstElementChild) slot.innerHTML = conySvg(); });

/* ---------- Start ---------- */
function handleLinkParams() {
  const params = new URLSearchParams(location.search);
  const verified = params.get("verified");
  const reset = params.get("reset");
  const shared = params.get("issue");
  if (!verified && !reset && !shared) return;
  history.replaceState(null, "", `${location.pathname}${location.hash}`);
  if (shared) {
    // Opened from a shared link (/r/<id>): show that report.
    if (issues.some((issue) => issue.id === shared)) {
      navigateTo("report");
      requestAnimationFrame(() => selectIssue(shared));
    } else {
      showToast("That report isn't available anymore.");
    }
  }
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
updateOnlineStatus();
renderAll();
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

/* ---------- Your data: delete account ---------- */
$("#start-delete").addEventListener("click", () => {
  $("#delete-form").hidden = false;
  $("#delete-error").textContent = "";
  $("#delete-password").value = "";
  $("#keep-reports").checked = false;
  $("#delete-password").focus();
});
$("#cancel-delete").addEventListener("click", () => { $("#delete-form").hidden = true; });
$("#delete-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = $("#delete-password").value;
  if (!password) return ($("#delete-error").textContent = "Enter your password to confirm.");
  const button = $("#confirm-delete");
  setLoading(button, true);
  try {
    await api("/api/auth/delete-account", { method: "POST", json: { password, keepReports: $("#keep-reports").checked } });
    $("#delete-form").hidden = true;
    closeDialog("account-modal");
    setActiveUser(null);
    await refreshState();
    showToast("Your account has been deleted. Thanks for helping your neighborhood.");
  } catch (error) {
    $("#delete-error").textContent = error.message;
  } finally {
    setLoading(button, false);
  }
});

/* ---------- Sharing ---------- */
async function shareIssue(id) {
  const issue = issues.find((entry) => entry.id === id);
  if (!issue) return;
  const url = `${location.origin}/r/${encodeURIComponent(id)}`;
  const text = `${issue.title}: ${issue.supporters} of ${GOAL} neighbors are backing this on Sidewalk. Add your voice:`;
  if (navigator.share) {
    try { await navigator.share({ title: issue.title, text, url }); return; } catch (error) { if (error.name === "AbortError") return; }
  }
  try {
    await navigator.clipboard.writeText(`${text} ${url}`);
    showToast("Link copied. Paste it in a text or post.");
  } catch {
    window.prompt("Copy this link:", url);
  }
}

/* ---------- Home-screen app and phone notifications ---------- */
let swRegistration = null;
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").then((reg) => { swRegistration = reg; }).catch(() => {});
}

const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function currentPushSubscription() {
  if (!pushSupported()) return null;
  const reg = swRegistration || await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function renderPushSetting() {
  const button = $("#push-toggle");
  const note = $("#push-note");
  if (!pushSupported()) {
    button.hidden = true;
    note.textContent = isIos && !isStandalone
      ? "On iPhone, add Sidewalk to your Home Screen first (Share, then Add to Home Screen), then turn this on from the app."
      : "This browser can't show notifications.";
    return;
  }
  button.hidden = false;
  if (Notification.permission === "denied") {
    button.hidden = true;
    note.textContent = "Notifications are blocked for Sidewalk in your browser settings.";
    return;
  }
  const sub = await currentPushSubscription().catch(() => null);
  button.textContent = sub ? "Turn off" : "Turn on";
  button.dataset.on = sub ? "1" : "";
  note.textContent = sub ? "On for this device." : "Get a notification when an issue you back or follow moves forward.";
}

$("#push-toggle").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  setLoading(button, true);
  try {
    const reg = swRegistration || await navigator.serviceWorker.ready;
    if (button.dataset.on) {
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api("/api/push/subscribe", { method: "DELETE", json: { endpoint: sub.endpoint } });
        await sub.unsubscribe();
      }
      showToast("Phone notifications are off for this device.");
    } else {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Notifications weren't allowed. You can change this in your browser settings.");
      const { publicKey } = await api("/api/push/key");
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
      await api("/api/push/subscribe", { method: "POST", json: { subscription: sub.toJSON() } });
      showToast("Phone notifications are on.");
    }
  } catch (error) {
    showToast(error.message || "Couldn't change notifications. Try again.");
  } finally {
    setLoading(button, false);
    renderPushSetting();
  }
});

/* ---------- Staff roles and activity ---------- */
$("#save-role").addEventListener("click", async (event) => {
  const headers = staffHeaders("assign_roles");
  if (!headers) return;
  const email = $("#role-email").value.trim();
  if (!email) return showToast("Enter their email.");
  const button = event.currentTarget;
  setLoading(button, true);
  try {
    const { user } = await api("/api/admin/roles", { method: "POST", headers, json: { email, role: $("#role-select").value } });
    showToast(`${user.name} is now: ${user.roleLabel}.`);
    $("#role-email").value = "";
    if (!$("#staff-list").hidden) loadStaff();
  } catch (error) {
    showToast(error.message);
  } finally {
    setLoading(button, false);
  }
});

async function loadStaff() {
  const headers = staffHeaders("assign_roles");
  if (!headers) return;
  try {
    const { staff, roles } = await api("/api/admin/roles", { headers });
    const label = Object.fromEntries(roles.map((r) => [r.role, r.label]));
    $("#staff-list").innerHTML = staff.length
      ? staff.map((u) => `<li class="mod-item"><strong>${escapeHtml(u.name)}</strong><p class="mod-meta">${escapeHtml(u.email)} · ${escapeHtml(label[u.role] || u.role)}</p></li>`).join("")
      : `<li class="mod-item"><p class="mod-meta">No staff yet. Everyone is a resident.</p></li>`;
  } catch (error) {
    showToast(error.message);
  }
}
$("#load-staff").addEventListener("click", loadStaff);

$("#load-activity").addEventListener("click", async (event) => {
  const headers = staffHeaders("moderate");
  if (!headers) return;
  const button = event.currentTarget;
  setLoading(button, true);
  const words = { status: "moved", hide: "hid", restore: "restored", delete: "deleted", suspend: "suspended the reporter of", "block-network": "blocked the network of", unsuspend: "lifted the suspension on", role: "changed a role" };
  try {
    const { activity } = await api("/api/admin/activity", { headers });
    $("#activity-list").innerHTML = activity.length
      ? activity.map((a) => {
        const report = issues.find((issue) => issue.id === a.target);
        const what = a.action === "role" ? `changed a role (${escapeHtml(a.detail)})` : `${escapeHtml(words[a.action] || a.action)} ${report ? `“${escapeHtml(report.title)}”` : "a report"}${a.action === "status" ? ` (${escapeHtml(a.detail)})` : ""}`;
        return `<li><strong>${escapeHtml(a.who)}</strong> ${what}<small>${timeAgo(a.at)}</small></li>`;
      }).join("")
      : `<li>No staff activity yet.</li>`;
  } catch (error) {
    showToast(error.message);
  } finally {
    setLoading(button, false);
  }
});

// Role tools show for admins, or once someone types the coordinator token (to set up the first admin).
function updateRoleToolsVisibility() {
  $("#role-tools").hidden = !(activeUser.can?.includes("assign_roles") || $("#tracker-admin-token").value.trim());
}
$("#tracker-admin-token").addEventListener("input", updateRoleToolsVisibility);

/* ---------- Who's likely responsible ---------- */
async function fillResponsibility(issue) {
  const guess = await guessResponsibility(issue);
  const box = document.getElementById(`responsible-${issue.id}`);
  if (!box || !guess) return;
  box.innerHTML = `<p><strong>${escapeHtml(guess.who)}</strong> <span class="hint-inline">(best guess)</span></p><p class="hint">${escapeHtml(guess.why)}</p>${guess.links.length ? `<p class="responsible-links">${guess.links.map((l) => `<a href="${escapeHtml(l.url)}" target="_blank" rel="noopener">${escapeHtml(l.label)}</a>`).join("")}</p>` : ""}`;
}

/* ---------- Fixed! celebration (once per report, per device) ---------- */
function celebrateOnce(issue) {
  const key = `sidewalk-celebrated-${issue.id}`;
  try { if (localStorage.getItem(key)) return; localStorage.setItem(key, "1"); } catch { return; }
  if (!issue.userSupported && !issue.isSubscribed) return;
  confetti();
}

function confetti() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const layer = document.createElement("div");
  layer.className = "confetti";
  layer.setAttribute("aria-hidden", "true");
  const colors = ["#f2c230", "#d9532a", "#2f7a50", "#2f6fb3", "#ffffff"];
  for (let i = 0; i < 70; i += 1) {
    const piece = document.createElement("i");
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = colors[i % colors.length];
    piece.style.animationDelay = `${Math.random() * 0.4}s`;
    piece.style.setProperty("--drift", `${(Math.random() - 0.5) * 160}px`);
    piece.style.setProperty("--spin", `${360 + Math.random() * 540}deg`);
    layer.append(piece);
  }
  document.body.append(layer);
  setTimeout(() => layer.remove(), 2600);
}

/* ---------- Cony follow-ups ---------- */
async function openFollowup(id) {
  if (!requireAccount("Sign in so Cony can help you write a follow-up.", () => openFollowup(id))) return;
  const issue = issues.find((entry) => entry.id === id);
  $("#followup-subject").value = "";
  $("#followup-body").value = "";
  $("#followup-intro").textContent = "Cony is writing a short, polite follow-up…";
  setCony("#cony-followup", "thinking");
  openDialog("followup-modal");
  try {
    const { draft } = await api(`/api/issues/${encodeURIComponent(id)}/follow-up-draft`, { method: "POST" });
    $("#followup-subject").value = draft.subject;
    $("#followup-body").value = draft.body;
    $("#followup-intro").textContent = `Here's a draft about "${issue?.title || "this report"}". Edit anything you like.`;
    setCony("#cony-followup", "happy");
    updateFollowupMail();
  } catch (error) {
    $("#followup-intro").textContent = error.message;
    setCony("#cony-followup", "");
  }
}
function updateFollowupMail() {
  $("#followup-mail").href = `mailto:?subject=${encodeURIComponent($("#followup-subject").value)}&body=${encodeURIComponent($("#followup-body").value)}`;
}
["#followup-subject", "#followup-body"].forEach((sel) => $(sel).addEventListener("input", updateFollowupMail));
$("#followup-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(`Subject: ${$("#followup-subject").value}\n\n${$("#followup-body").value}`);
    showToast("Follow-up copied.");
  } catch {
    $("#followup-body").select();
    showToast("Select the text and copy it.");
  }
});

/* ---------- Staff dashboard ---------- */
let staffItems = [];
let staffMe = null;
let staffFilter = "open";
const ACTION_STAGES = ["submitted", "ai_reviewed", "community_priority"];

async function loadStaffQueue() {
  const list = $("#staff-list-main");
  if (!activeUser.can?.includes("update_status")) return;
  if (!staffItems.length) list.innerHTML = skeletons(3, "row", "li");
  try {
    const result = await api("/api/staff/queue");
    staffItems = result.items;
    staffMe = result.me;
    renderStaff();
  } catch (error) {
    list.innerHTML = emptyState({ icon: "i-close", title: "Couldn't load the queue", text: error.message, error: true, tag: "li" });
  }
}

function staffMatches(item, filter) {
  const open = item.status !== "resolved";
  if (filter === "open") return open;
  if (filter === "action") return ACTION_STAGES.includes(item.status);
  if (filter === "mine") return open && item.assignedTo && item.assignedTo === staffMe;
  if (filter === "overdue") return item.stale;
  if (filter === "fixed") return !open;
  return true;
}

function renderStaff() {
  ["open", "action", "mine", "overdue", "fixed"].forEach((f) => { $(`#sf-${f}`).textContent = staffItems.filter((item) => staffMatches(item, f)).length; });
  $$("[data-staff-filter]").forEach((chip) => chip.classList.toggle("active", chip.dataset.staffFilter === staffFilter));
  const rows = staffItems.filter((item) => staffMatches(item, staffFilter));
  const empty = { open: "No open reports. Nice work.", action: "Nothing waiting for a first step.", mine: "You haven't taken any reports yet.", overdue: "Nothing has gone quiet for 3 weeks.", fixed: "No fixed reports yet." }[staffFilter];
  $("#staff-list-main").innerHTML = rows.map((item) => {
    const next = nextStageFor(item);
    const mine = item.assignedTo && item.assignedTo === staffMe;
    const who = item.assigneeName ? (mine ? "You" : escapeHtml(item.assigneeName)) : "Unassigned";
    const fixAction = next === "resolved"
      ? `<button class="btn btn-primary btn-small" type="button" data-staff-fix="${escapeHtml(item.id)}">Mark fixed</button>`
      : next ? `<button class="btn btn-ghost btn-small" type="button" data-staff-next="${escapeHtml(item.id)}" data-next="${next}">Move to ${escapeHtml(STAGE_LABELS[next])}</button>` : "";
    const assign = item.status === "resolved" ? "" : staffMe
      ? `<button class="btn btn-ghost btn-small" type="button" data-staff-assign="${escapeHtml(item.id)}" data-take="${mine ? "" : "1"}">${mine ? "Unassign me" : "Assign to me"}</button>`
      : "";
    return `<li class="staff-row${item.stale ? " stale" : ""}">
      <div class="staff-main">
        <div class="staff-badges"><span class="badge ${item.status === "resolved" ? "resolved" : ""}">${escapeHtml(STAGE_LABELS[item.status] || STAGE_LABELS.submitted)}</span>${item.stale ? `<span class="badge priority">Quiet ${item.daysSinceUpdate} days</span>` : ""}${item.underReview ? `<span class="badge review">Under review</span>` : ""}</div>
        <strong>${escapeHtml(item.title)}</strong>
        <small>${escapeHtml(item.categoryLabel)} · ${escapeHtml(item.distance)} · ${item.supporters} backing · updated ${timeAgo(item.statusUpdatedAt)} · ${who}</small>
      </div>
      <div class="staff-actions">${assign}${fixAction}<button class="text-link small" type="button" data-staff-open="${escapeHtml(item.id)}">Open</button></div>
    </li>`;
  }).join("") || emptyState({ icon: "i-track", title: empty, tag: "li" });
}

$("#staff-filters").addEventListener("click", (event) => {
  const chip = event.target.closest("[data-staff-filter]");
  if (!chip) return;
  staffFilter = chip.dataset.staffFilter;
  renderStaff();
});

$("#staff-list-main").addEventListener("click", async (event) => {
  const open = event.target.closest("[data-staff-open]");
  if (open) {
    currentTrackerIssue = open.dataset.staffOpen;
    navigateTo("tracker");
    return renderTracker();
  }
  const fix = event.target.closest("[data-staff-fix]");
  if (fix) return openFix(fix.dataset.staffFix);
  const assign = event.target.closest("[data-staff-assign]");
  const nextBtn = event.target.closest("[data-staff-next]");
  const button = assign || nextBtn;
  if (!button) return;
  setLoading(button, true);
  try {
    if (assign) {
      await api(`/api/staff/issues/${encodeURIComponent(assign.dataset.staffAssign)}/assign`, { method: "POST", json: { assign: Boolean(assign.dataset.take) } });
      showToast(assign.dataset.take ? "It's yours. It's in your Mine list." : "Unassigned.");
    } else {
      await api(`/api/issues/${encodeURIComponent(nextBtn.dataset.staffNext)}/status`, { method: "PATCH", json: { status: nextBtn.dataset.next, note: "" } });
      showToast(`Moved to ${STAGE_LABELS[nextBtn.dataset.next]}. Followers will be notified.`);
    }
    await Promise.all([loadStaffQueue(), refreshState()]);
  } catch (error) {
    showToast(error.message);
    setLoading(button, false);
  }
});

/* ---------- Mark fixed (with after photos) ---------- */
let fixIssueId = null;
let fixPhotos = [];

function openFix(id) {
  fixIssueId = id;
  fixPhotos = [];
  $("#fix-form").reset();
  $("#fix-error").textContent = "";
  renderFixPreviews();
  const item = staffItems.find((entry) => entry.id === id) || issues.find((entry) => entry.id === id);
  $("#fix-intro").textContent = `"${item?.title || "This report"}": add a photo of the repair so neighbors can see the before and after. Everyone who backed it gets a "Fixed!" notification.`;
  openDialog("fix-modal");
}

function renderFixPreviews() {
  $("#fix-previews").innerHTML = fixPhotos.map((p, i) => `<div class="photo-thumb"><img src="${escapeHtml(p)}" alt="After photo ${i + 1}"><button class="icon-btn" type="button" data-fix-remove="${i}" aria-label="Remove photo ${i + 1}"><svg><use href="#i-close"/></svg></button></div>`).join("");
}

$("#fix-photos").addEventListener("change", async (event) => {
  const files = [...event.target.files].slice(0, 4 - fixPhotos.length);
  event.target.value = "";
  for (const file of files) {
    try { fixPhotos.push(await compressPhoto(file)); } catch { $("#fix-error").textContent = "One photo couldn't be read. Try a different one."; }
  }
  renderFixPreviews();
});
$("#fix-previews").addEventListener("click", (event) => {
  const remove = event.target.closest("[data-fix-remove]");
  if (!remove) return;
  fixPhotos.splice(Number(remove.dataset.fixRemove), 1);
  renderFixPreviews();
});

$("#fix-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#fix-submit");
  setLoading(button, true);
  try {
    if (fixPhotos.length) await api(`/api/issues/${encodeURIComponent(fixIssueId)}/after-photos`, { method: "POST", json: { photos: fixPhotos } });
    await api(`/api/issues/${encodeURIComponent(fixIssueId)}/status`, { method: "PATCH", json: { status: "resolved", note: $("#fix-note").value } });
    closeDialog("fix-modal");
    confetti();
    showToast("Marked fixed. Everyone who backed it will hear the good news.");
    await Promise.all([loadStaffQueue(), refreshState()]);
  } catch (error) {
    $("#fix-error").textContent = error.message;
  } finally {
    setLoading(button, false);
  }
});

/* ---------- Cony fills in the report: photo, voice, or rough text in any language ---------- */
var conyUndo = null;
var voice = null;

function conyStatus(text, state = "") {
  $("#cony-assist-status").textContent = text;
  setCony("#cony-assist-face", state);
}

function conyBusy(busy) {
  ["#cony-from-photo", "#cony-tidy"].forEach((sel) => { $(sel).disabled = busy || (sel === "#cony-from-photo" && !firstReadyPhoto()); });
  if (!voice) $("#cony-voice").disabled = busy;
}

function firstReadyPhoto() {
  return photoQueue.find((entry) => entry.status === "ready" && entry.dataUrl);
}

function updateConyPhotoButton() {
  $("#cony-from-photo").disabled = !firstReadyPhoto() || $("#cony-assist").classList.contains("busy");
}

function applyConyReport(report, note) {
  conyUndo = { title: $("#issue-title").value, description: $("#issue-description").value, category: $("#category-choices input:checked")?.value };
  $("#issue-title").value = report.title;
  $("#issue-description").value = report.description;
  $("#description-count").textContent = report.description.length;
  const radio = $(`#category-choices input[value="${report.category}"]`);
  if (radio) radio.checked = true;
  $("#cony-undo").hidden = false;
  conyStatus(note, "happy");
}

$("#cony-undo").addEventListener("click", () => {
  if (!conyUndo) return;
  $("#issue-title").value = conyUndo.title;
  $("#issue-description").value = conyUndo.description;
  $("#description-count").textContent = conyUndo.description.length;
  const radio = $(`#category-choices input[value="${conyUndo.category}"]`);
  if (radio) radio.checked = true;
  conyUndo = null;
  $("#cony-undo").hidden = true;
  conyStatus("Put back what you had.");
});

async function conyTask(label, work) {
  $("#cony-assist").classList.add("busy");
  conyBusy(true);
  conyStatus(label, "thinking");
  try {
    await work();
  } catch (error) {
    conyStatus(error.message || "Cony couldn't do that just now. You can fill in the form yourself.");
  } finally {
    $("#cony-assist").classList.remove("busy");
    conyBusy(false);
  }
}

// A smaller copy is plenty for Cony to read, and keeps the request quick.
async function shrinkForCony(dataUrl) {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const scale = Math.min(1, 1024 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = Math.round(image.naturalHeight * scale);
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.78);
}

$("#cony-from-photo").addEventListener("click", () => conyTask("Cony is looking at your photo…", async () => {
  const photo = await shrinkForCony(firstReadyPhoto().dataUrl);
  const result = await api("/api/cony/photo", { method: "POST", json: { photo } });
  if (!result.isStreetIssue) return conyStatus("Cony couldn't spot a street or park problem in that photo. Try a closer shot of the problem, or describe it instead.");
  applyConyReport(result, result.privacyConcern
    ? "Filled in from your photo. Heads up: Cony sees a face or license plate. Please retake or crop it before posting."
    : "Filled in from your photo. Check it over and fix anything Cony got wrong.");
}));

$("#cony-tidy").addEventListener("click", () => {
  const text = [$("#issue-title").value, $("#issue-description").value].filter((v) => v.trim()).join(". ");
  if (text.trim().length < 5) {
    conyStatus("Type a few words about the problem first, in any language. Then tap Tidy up.");
    return $("#issue-description").focus();
  }
  conyTask("Cony is tidying it up…", async () => tidyInto(text));
});

async function tidyInto(text, heard = "") {
  const result = await api("/api/cony/tidy", { method: "POST", json: { text } });
  const translated = result.language && !/^english$/i.test(result.language);
  const prefix = heard ? `Heard: "${heard.length > 90 ? `${heard.slice(0, 90)}…` : heard}". ` : "";
  applyConyReport(result, `${prefix}${translated ? `Translated from ${result.language}. ` : ""}Check it over and fix anything Cony got wrong.`);
}

// Voice: tap to start, tap again to stop (stops by itself after 60 seconds).
function pickAudioType() {
  if (!window.MediaRecorder) return null;
  return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((type) => MediaRecorder.isTypeSupported?.(type)) || "";
}

$("#cony-voice").addEventListener("click", async () => {
  if (voice) return voice.recorder.stop();
  const type = pickAudioType();
  if (type === null || !navigator.mediaDevices?.getUserMedia) return conyStatus("This browser can't record audio. Type it instead, in any language.");
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return conyStatus("Cony needs microphone permission to listen. You can allow it in your browser settings, or type instead.");
  }
  const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks = [];
  const started = Date.now();
  voice = { recorder, stream };
  recorder.addEventListener("dataavailable", (event) => { if (event.data.size) chunks.push(event.data); });
  recorder.addEventListener("stop", () => {
    clearInterval(voice.timer);
    clearTimeout(voice.limit);
    stream.getTracks().forEach((track) => track.stop());
    voice = null;
    $("#cony-voice").setAttribute("aria-pressed", "false");
    $("#cony-voice").classList.remove("recording");
    $("#cony-voice-label").textContent = "Say it";
    const blob = new Blob(chunks, { type: recorder.mimeType || type || "audio/webm" });
    if (Date.now() - started < 800 || blob.size < 1000) return conyStatus("That was too short. Tap Say it, talk, then tap Stop.");
    conyTask("Cony is listening back…", async () => {
      const response = await fetch("/api/cony/transcribe", { method: "POST", headers: { "Content-Type": blob.type.split(";")[0] }, body: blob, credentials: "same-origin" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Cony couldn't hear that. Try again.");
      conyStatus("Got it. Writing it up…", "thinking");
      await tidyInto(data.text, data.text);
    });
  });
  recorder.start();
  $("#cony-voice").setAttribute("aria-pressed", "true");
  $("#cony-voice").classList.add("recording");
  const tick = () => {
    const secs = Math.floor((Date.now() - started) / 1000);
    $("#cony-voice-label").textContent = `Stop (0:${String(secs).padStart(2, "0")})`;
  };
  tick();
  voice.timer = setInterval(tick, 500);
  voice.limit = setTimeout(() => recorder.state === "recording" && recorder.stop(), 60_000);
  conyStatus("Listening… say what's wrong and where. Any language is fine. Tap Stop when you're done.", "talking");
});

function resetConyAssist() {
  if (voice) voice.recorder.stop();
  conyUndo = null;
  $("#cony-undo").hidden = true;
  conyStatus("Add a photo, say what's wrong, or type it in any language. Cony writes it up in English for you to check.");
  updateConyPhotoButton();
}

/* ---------- Impact: scoreboard, safety check, fair share ---------- */
let impactLoadedAt = 0;
let crashLayer = null;

const pct = (value) => (value == null ? "–" : `${Math.round(value * 100)}%`);
const daysText = (value) => (value == null ? "–" : value < 1 ? "under a day" : `${value} day${value === 1 ? "" : "s"}`);

async function loadImpact() {
  if (Date.now() - impactLoadedAt < 60_000) return;
  if (!impactLoadedAt) $("#impact-stats").innerHTML = skeletons(3, "row", "div");
  try {
    const data = await api("/api/impact");
    impactLoadedAt = Date.now();
    renderImpact(data);
  } catch (error) {
    $("#impact-stats").innerHTML = emptyState({ icon: "i-close", title: "Couldn't load the scoreboard", text: error.message, error: true });
  }
}

function renderImpact(data) {
  const o = data.overall;
  $("#impact-stats").innerHTML = [
    ["Reports", o.reports],
    ["Fixed", `${o.fixed} <small>(${pct(o.fixRate)})</small>`],
    ["Typical time to fix", daysText(o.medianDaysToFix)],
    ["Still open", o.open],
  ].map(([label, value]) => `<div class="impact-stat"><strong>${value}</strong><span>${label}</span></div>`).join("");

  $("#impact-areas tbody").innerHTML = data.byArea.map((a) => `<tr><th scope="row">${escapeHtml(a.area)}</th><td>${a.reports}</td><td>${a.fixed} <span class="muted">(${pct(a.fixRate)})</span></td><td>${daysText(a.medianDaysToFix)}</td></tr>`).join("")
    || `<tr><td colspan="4">No reports yet.</td></tr>`;

  $("#impact-oldest").innerHTML = data.oldestOpen.map((r) => `<li><button class="text-link" type="button" data-impact-open="${escapeHtml(r.id)}">${escapeHtml(r.title)}</button><small>${escapeHtml(r.area)} · open ${r.daysOpen} day${r.daysOpen === 1 ? "" : "s"} · ${escapeHtml(STAGE_LABELS[r.status] || STAGE_LABELS.submitted)}</small></li>`).join("")
    || `<li class="muted">Nothing open. Every report has been fixed.</li>`;

  const sf = data.safety;
  $("#impact-safety").innerHTML = !sf.lookedUp
    ? `<p class="hint">Checking reports against federal crash records. This takes a few minutes after a report is posted.</p>`
    : `<div class="safety-summary"><strong>${sf.reportsNearFatalCrashes}</strong><span>of ${sf.lookedUp} checked report${sf.lookedUp === 1 ? " is" : "s are"} within ${sf.radiusMeters} m of a fatal crash (${sf.fromYear} to ${sf.toYear}).</span></div>
      ${sf.hotspots.length ? `<ol class="impact-oldest">${sf.hotspots.map((h) => `<li><button class="text-link" type="button" data-impact-open="${escapeHtml(h.id)}">${escapeHtml(h.title)}</button><small>${escapeHtml(h.area)} · ${h.crashes} fatal crash${h.crashes === 1 ? "" : "es"} nearby, ${h.fatalities} ${h.fatalities === 1 ? "death" : "deaths"}</small></li>`).join("")}</ol>` : ""}
      <p class="hint">These reports deserve a closer look: a hazard near a place where people have died in crashes. Fatal crashes only; the records don't include injury crashes.</p>`;

  const eq = data.equity;
  const maxDays = Math.max(1, ...eq.bands.map((b) => b.medianDaysToFix || 0));
  $("#impact-equity").innerHTML = eq.covered
    ? eq.bands.map((b) => `<div class="equity-row">
        <div class="equity-label"><strong>${escapeHtml(b.label)}</strong><small>${escapeHtml(b.note)}</small></div>
        <div class="equity-figures">
          <span>${b.reports} report${b.reports === 1 ? "" : "s"} · ${pct(b.fixRate)} fixed</span>
          <div class="equity-bar" role="img" aria-label="${escapeHtml(b.label)}: typical time to fix ${daysText(b.medianDaysToFix)}"><i style="width:${b.medianDaysToFix == null ? 0 : Math.max(4, (b.medianDaysToFix / maxDays) * 100)}%"></i></div>
          <small>Typical time to fix: ${daysText(b.medianDaysToFix)}</small>
        </div>
      </div>`).join("") + `<p class="hint">${eq.covered} of ${eq.total} reports matched to a census tract so far. With only a few fixed reports, differences can be chance; look for patterns that last.</p>`
    : eq.incomeDataOn
      ? `<p class="hint">Matching reports to census tracts. Check back in a few minutes.</p>`
      : `<p class="hint">Income data is off on this server. An admin can turn it on by adding a free Census API key.</p>`;

  $("#impact-sources").innerHTML = `Sources: Sidewalk reports; U.S. Census Bureau geocoder and American Community Survey ${escapeHtml(eq.acsYear)} 5-year estimates (median household income); NHTSA Fatality Analysis Reporting System. Areas are census tracts, not neighborhoods, and income is an estimate.`;
}

document.addEventListener("click", (event) => {
  const open = event.target.closest?.("[data-impact-open]");
  if (!open) return;
  currentTrackerIssue = open.dataset.impactOpen;
  navigateTo("tracker");
  renderTracker();
});

$("#crash-toggle").addEventListener("change", async (event) => {
  const on = event.target.checked;
  $("#crash-key").hidden = !on;
  if (!heatMap) return;
  if (!on) { if (crashLayer) heatMap.removeLayer(crashLayer); return; }
  if (!crashLayer) {
    try {
      const data = await api("/api/impact/crashes");
      crashLayer = L.layerGroup(data.crashes.map(([lat, lng, year, fatals]) => L.circleMarker([lat, lng], { radius: 4 + Math.min(fatals, 4), weight: 1.5, color: "#23272b", fillColor: "#b3261e", fillOpacity: 0.85 })
        .bindTooltip(`Fatal crash${year ? `, ${year}` : ""}: ${fatals} ${fatals === 1 ? "death" : "deaths"}`)));
      if (!data.crashes.length) showToast("No crash records loaded yet. They load in the background after reports are checked.");
    } catch (error) {
      event.target.checked = false;
      $("#crash-key").hidden = true;
      return showToast(error.message);
    }
  }
  if (event.target.checked) crashLayer.addTo(heatMap);
});

/* ---------- Offline reports: saved on this device, sent when the connection returns ---------- */
let outboxResumeId = null;
let flushing = false;

function outboxDb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error("no-idb"));
    const open = indexedDB.open("sidewalk-outbox", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("reports", { keyPath: "id" });
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}
async function outboxRun(mode, fn) {
  const db = await outboxDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("reports", mode);
    const request = fn(tx.objectStore("reports"));
    tx.oncomplete = () => { db.close(); resolve(request?.result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
const outboxAll = () => outboxRun("readonly", (store) => store.getAll()).catch(() => []);
const outboxPut = (item) => outboxRun("readwrite", (store) => store.put(item));
const outboxDelete = (id) => outboxRun("readwrite", (store) => store.delete(id)).catch(() => {});

async function saveOfflineReport(draft, form) {
  try {
    await outboxPut({ ...draft, id: crypto.randomUUID?.() || String(Date.now()), savedAt: Date.now() });
  } catch {
    $("#form-error").textContent = "You're offline, and this browser can't save reports for later. Try again when you have signal.";
    return;
  }
  form.reset();
  photoQueue = [];
  renderPhotoQueue();
  clearPendingLocation();
  closeDialog("report-modal");
  showToast("No signal, so it's saved on this device. It'll post as soon as you're back online.");
  updateOutboxBar();
}

async function updateOutboxBar() {
  const items = await outboxAll();
  $("#outbox-bar").hidden = !items.length;
  $("#outbox-text").textContent = `${items.length} report${items.length === 1 ? "" : "s"} waiting to send`;
  $("#outbox-send").hidden = !navigator.onLine;
}

// Send saved reports. Signed-in reports go straight through; guest reports reopen in the form,
// filled in, because they need the "I'm human" check, which only works online.
async function flushOutbox() {
  if (flushing || !navigator.onLine) return 0;
  flushing = true;
  let sent = 0;
  try {
    for (const item of (await outboxAll()).sort((a, b) => a.savedAt - b.savedAt)) {
      const { id, savedAt, ...draft } = item;
      try {
        const result = await api("/api/issues", { method: "POST", json: draft });
        await outboxDelete(id);
        if (!issues.some((i) => i.id === result.issue.id)) issues.unshift(result.issue);
        sent += 1;
      } catch (error) {
        if (error.status === 0) break;
        if (error.status === 409 && error.data?.duplicate) {
          await outboxDelete(id);
          showToast(`"${draft.title}" was already reported nearby while you were offline, so it wasn't posted twice.`);
          continue;
        }
        if (error.status === 429) break;
        // Needs the human check, or something to fix: reopen it in the form.
        resumeOfflineReport(item, error.status === 400 || error.status === 403 ? error.message : "");
        break;
      }
    }
  } finally {
    flushing = false;
  }
  if (sent) {
    renderAll();
    showToast(sent === 1 ? "Back online. Your saved report was posted." : `Back online. ${sent} saved reports were posted.`);
  }
  updateOutboxBar();
  return sent;
}

function resumeOfflineReport(item, problem) {
  if ($("#report-modal").open) return;
  outboxResumeId = item.id;
  openReport({ title: item.title, description: item.description, category: item.category });
  photoQueue = (item.photos || []).map((dataUrl) => ({ id: crypto.randomUUID?.() || String(Math.random()), dataUrl, status: "ready" }));
  renderPhotoQueue();
  if (Number.isFinite(item.lat)) setPendingLocation({ lat: item.lat, lng: item.lng }, "Spot saved while offline");
  $("#form-error").textContent = problem && !/human/i.test(problem) ? problem : "";
  $("#report-intro").textContent = "You saved this while you were offline. Check it over, then post it.";
}

$("#outbox-send").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  setLoading(button, true);
  const sent = await flushOutbox();
  setLoading(button, false);
  if (!sent && !$("#report-modal").open) showToast("Couldn't send yet. We'll keep trying when your connection is steady.");
});
window.addEventListener("offline", updateOutboxBar);
updateOutboxBar();
setTimeout(() => flushOutbox(), 2500);
