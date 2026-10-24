const GOAL = 50;
const PRIORITY_THRESHOLD = 10;
const DEFAULT_AREA = { label: "The Carolinas", lat: 35.05, lng: -80.75, bounds: [[31.9, -84.4], [36.6, -75.4]] };
const STATE_CODES = { Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA", Colorado: "CO", Connecticut: "CT", Delaware: "DE", Florida: "FL", Georgia: "GA", Hawaii: "HI", Idaho: "ID", Illinois: "IL", Indiana: "IN", Iowa: "IA", Kansas: "KS", Kentucky: "KY", Louisiana: "LA", Maine: "ME", Maryland: "MD", Massachusetts: "MA", Michigan: "MI", Minnesota: "MN", Mississippi: "MS", Missouri: "MO", Montana: "MT", Nebraska: "NE", Nevada: "NV", "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY", "North Carolina": "NC", "North Dakota": "ND", Ohio: "OH", Oklahoma: "OK", Oregon: "OR", Pennsylvania: "PA", "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD", Tennessee: "TN", Texas: "TX", Utah: "UT", Vermont: "VT", Virginia: "VA", Washington: "WA", "West Virginia": "WV", Wisconsin: "WI", Wyoming: "WY", "District of Columbia": "DC" };
const BASEMAPS = {
  terrain: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
    maxZoom: 19,
    attribution: 'Sources: <a href="https://www.esri.com/">Esri</a>, TomTom, Garmin, FAO, NOAA, USGS, OpenStreetMap contributors, and the GIS User Community',
  },
  street: {
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
};
const startingIssues = [
  { id: "crosswalk", title: "Crosswalk needs a fresh coat", category: "safety", categoryLabel: "Street safety", description: "The paint has almost disappeared at the school crossing on Maple and 4th.", supporters: 38, distance: "Charlotte, NC", lat: 35.2271, lng: -80.8431 },
  { id: "ramp", title: "Missing curb ramp at the corner", category: "access", categoryLabel: "Accessibility", description: "Wheelchairs and strollers have to enter the road to get around this corner.", supporters: 24, distance: "Raleigh, NC", lat: 35.7796, lng: -78.6382 },
  { id: "lights", title: "Two streetlights out on Pine", category: "lighting", categoryLabel: "Street lighting", description: "The block between 6th and 8th gets very dark after sunset.", supporters: 49, distance: "Columbia, SC", lat: 34.0007, lng: -81.0348 },
  { id: "park", title: "A bin for the pocket park", category: "parks", categoryLabel: "Parks & public space", description: "Neighbors keep the park tidy, but there is nowhere to put the litter.", supporters: 19, distance: "Greenville, SC", lat: 34.8526, lng: -82.394 },
];

let issues = startingIssues.map((issue) => ({ ...issue, userSupported: false }));
let activeFilter = "all";
let map;
let trackerMap;
let heatMap;
let heatLayer;
let markerLayers = new Map();
let secondaryMarkerLayers = { tracker: new Map(), heat: new Map() };
let currentTrackerIssue = null;
const pageNames = ["home", "report", "converter", "tracker", "petitions", "heatmap"];
let currentPage = pageNames.includes(window.location.hash.slice(1)) ? window.location.hash.slice(1) : "home";
let coordinatorConfigured = false;
let pendingLocation = null;
let selectingLocation = false;
let toastTimer;
let placeResults = [];
let currentArea = loadSavedArea();
let activeUser = { id: "guest", name: "Neighborhood Guest", email: "", guest: true };
let accountMode = "register";
let emailDeliveryConfigured = false;

const issueList = document.querySelector("#issue-list");
const toast = document.querySelector("#toast");

async function apiRequest(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "The request could not be completed.");
    error.status = response.status;
    throw error;
  }
  return data;
}

function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "G";
}

function supporterCount(issue) {
  return issue.supporters;
}

function hasSupported(issue) {
  return Boolean(issue.userSupported);
}

function renderAccountDialog() {
  const active = document.querySelector("#active-account");
  const signedIn = !activeUser.guest;
  active.innerHTML = `<span class="account-avatar">${initials(activeUser.name)}</span><span><strong>${escapeHtml(activeUser.name)}${signedIn ? "" : " (guest)"}</strong><small>${signedIn ? escapeHtml(activeUser.email) : "Browsing without an account"}</small></span>`;
  document.querySelector(".account-mode").hidden = signedIn;
  document.querySelector("#account-form").hidden = signedIn;
  document.querySelector("#account-settings").hidden = !signedIn;
  const updatesCheckbox = document.querySelector("#account-email-updates");
  updatesCheckbox.checked = emailDeliveryConfigured && Boolean(activeUser.emailUpdates);
  updatesCheckbox.disabled = !emailDeliveryConfigured;
  document.querySelector("#email-updates").disabled = !emailDeliveryConfigured;
  document.querySelector("#email-delivery-note").textContent = emailDeliveryConfigured
    ? "Verification and opted-in petition emails are sent to your inbox."
    : "SMTP is not configured. No emails will be sent; local development accounts can use the verification link shown after signup.";
  if (signedIn) {
    document.querySelector("#account-title").textContent = "Account settings";
    document.querySelector("#account-intro").textContent = "Manage your account and email updates.";
  }
  document.querySelector("#profile-button").textContent = initials(activeUser.name);
  document.querySelector("#profile-button").setAttribute("aria-label", signedIn ? `Signed in as ${activeUser.name}. Account settings` : "Sign in or create an account");
  document.querySelector("#guest-button").textContent = signedIn ? "Sign out" : "Continue browsing as a guest";
}

function updateAccountMode(mode) {
  accountMode = mode;
  const registering = mode === "register";
  document.querySelector("#account-title").textContent = registering ? "Create your account" : "Sign in to Sidewalk";
  document.querySelector("#account-intro").textContent = registering
    ? (emailDeliveryConfigured
      ? "We’ll email a verification link before enabling petition support and reports."
      : "Create a local account and sign in immediately. Email delivery is unavailable until SMTP is configured.")
    : "Sign in with your verified email to continue supporting your community.";
  document.querySelector("#account-name-field").hidden = !registering;
  document.querySelector("#account-name").required = registering;
  document.querySelector("#account-password").autocomplete = registering ? "new-password" : "current-password";
  document.querySelector("#email-updates-field").hidden = !registering;
  document.querySelector("#verification-link").hidden = true;
  document.querySelector("#account-submit").innerHTML = `${registering ? "Create account" : "Sign in"} <span>→</span>`;
  document.querySelectorAll("[data-account-mode]").forEach((button) => {
    const selected = button.dataset.accountMode === mode;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  document.querySelector("#account-error").textContent = "";
}

function setActiveUser(user) {
  activeUser = user;
  renderAccountDialog();
  renderIssues();
}

async function loadServerState() {
  try {
    const [auth, result] = await Promise.all([apiRequest("/api/auth/me"), apiRequest("/api/issues")]);
    emailDeliveryConfigured = Boolean(auth.emailConfigured);
    coordinatorConfigured = Boolean(result.coordinatorConfigured);
    setActiveUser(auth.user ? { ...auth.user, emailConfigured: emailDeliveryConfigured } : { id: "guest", name: "Neighborhood Guest", email: "", guest: true });
    issues = result.issues;
    renderIssues();
  } catch (error) {
    showToast(`Could not load community data: ${error.message}`);
  }
}

function loadSavedArea() {
  try {
    const saved = JSON.parse(localStorage.getItem("sidewalk-area"));
    if (saved && typeof saved.label === "string" && Number.isFinite(saved.lat) && Number.isFinite(saved.lng)) {
      if (saved.label === DEFAULT_AREA.label) return { ...DEFAULT_AREA };
      return { label: saved.label, lat: saved.lat, lng: saved.lng, state: saved.state };
    }
  } catch {}
  return { ...DEFAULT_AREA };
}

function updateAreaLabels() {
  document.querySelector("#selected-area-label").textContent = currentArea.label;
  document.querySelector("#map-area-label").textContent = currentArea.label;
  document.querySelector("#report-location-label").textContent = currentArea.label;
}

function setCurrentArea(area) {
  currentArea = area;
  try {
    localStorage.setItem("sidewalk-area", JSON.stringify(area));
  } catch {}
  updateAreaLabels();
  if (map) {
    if (area.label === DEFAULT_AREA.label) map.fitBounds(DEFAULT_AREA.bounds, { padding: [35, 35], maxZoom: window.matchMedia("(max-width: 850px)").matches ? 6 : 7 });
    else map.flyTo([area.lat, area.lng], 13, { duration: 0.8 });
  }
  [trackerMap, heatMap].forEach((secondary) => {
    if (!secondary) return;
    if (area.label === DEFAULT_AREA.label) secondary.fitBounds(DEFAULT_AREA.bounds, { padding: [25, 25], maxZoom: 7 });
    else secondary.flyTo([area.lat, area.lng], 10, { duration: 0.6 });
  });
}

function categoryClass(category) {
  if (category === "access") return "access";
  if (category === "parks") return "parks";
  if (category === "lighting") return "lighting";
  return "";
}

function markerStatus(issue) {
  const count = supporterCount(issue);
  if (count >= GOAL) return "ready";
  if (count >= PRIORITY_THRESHOLD) return "priority";
  if (count >= 5) return "active";
  return "";
}

function renderIssues() {
  const filtered = issues.filter((issue) => activeFilter === "all" || issue.category === activeFilter);
  const sorted = filtered.sort((left, right) => Number(supporterCount(right) >= PRIORITY_THRESHOLD) - Number(supporterCount(left) >= PRIORITY_THRESHOLD) || supporterCount(right) - supporterCount(left));
  document.querySelector("#result-count").textContent = filtered.length;
  document.querySelector("#issue-total").textContent = 8 + issues.length;
  document.querySelector('[data-filter="all"] span').textContent = issues.length;
  document.querySelector("#home-issue-count").textContent = issues.length;
  issueList.innerHTML = sorted.map((issue) => {
    const count = supporterCount(issue);
    const supported = hasSupported(issue);
    const priority = count >= PRIORITY_THRESHOLD;
    const progress = Math.min(100, Math.round((count / GOAL) * 100));
    const ready = count >= GOAL;
    const button = ready
      ? `<span class="ready-label">GOAL REACHED</span>`
      : `<button class="support-button ${supported ? "supported" : ""}" type="button" data-support="${issue.id}" ${supported ? "disabled" : ""} aria-label="${supported ? "You supported" : "Support"} ${escapeHtml(issue.title)}">${supported ? "✓ Supported" : "+ Support"}</button>`;
    return `<article class="issue-card" data-issue="${issue.id}" tabindex="0" aria-label="${escapeHtml(issue.title)}, ${count} of ${GOAL} supporters">
      <div class="card-top"><span class="category-label"><i class="category-dot ${categoryClass(issue.category)}"></i>${escapeHtml(issue.categoryLabel)}</span>${priority ? `<span class="priority-chip">HIGH PRIORITY</span>` : ""}<span class="distance">${escapeHtml(issue.distance)}</span></div>
      <h3>${escapeHtml(issue.title)}</h3><p class="issue-description">${escapeHtml(issue.description)}</p>
      ${issue.photo ? `<img class="issue-photo-preview" src="${issue.photo}" alt="Photo of ${escapeHtml(issue.title)}">` : ""}
      <div class="card-bottom"><div class="support-stat"><strong>${count}</strong> / ${GOAL} neighbors <span class="mini-progress"><span style="width:${progress}%"></span></span></div>${button}</div>
    </article>`;
  }).join("") || `<p class="empty-state">No issues in this category yet.</p>`;
  renderMarkers();
  renderSecondaryMaps();
  renderPetitionPage();
  renderTrackerPage();
  renderHotspots();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function markerIcon(issue) {
  const count = supporterCount(issue);
  const label = count >= GOAL ? "✓" : count;
  return L.divIcon({ className: "", html: `<div class="sidewalk-marker ${markerStatus(issue)}"><span>${label}</span></div>`, iconSize: [31, 31], iconAnchor: [15, 29] });
}

function renderMarkers() {
  if (!map) return;
  markerLayers.forEach((marker) => marker.remove());
  markerLayers.clear();
  issues.forEach((issue) => {
    if (activeFilter !== "all" && issue.category !== activeFilter) return;
    const marker = L.marker([issue.lat, issue.lng], { icon: markerIcon(issue), title: issue.title }).addTo(map);
    marker.bindPopup(`<strong>${escapeHtml(issue.title)}</strong><br>${supporterCount(issue)} of ${GOAL} neighbors supporting`);
    marker.on("click", () => selectIssue(issue.id));
    markerLayers.set(issue.id, marker);
  });
}

const stageLabels = {
  submitted: "Submitted",
  ai_reviewed: "AI reviewed report text",
  community_priority: "Community priority",
  sent_to_agency: "Sent to local agency",
  in_progress: "Work in progress",
  resolved: "Resolved",
};
const stageOrder = Object.keys(stageLabels);

function prioritySortedIssues() {
  return [...issues].sort((left, right) =>
    Number(supporterCount(right) >= PRIORITY_THRESHOLD) - Number(supporterCount(left) >= PRIORITY_THRESHOLD)
    || supporterCount(right) - supporterCount(left));
}

function renderPetitionPage() {
  const list = document.querySelector("#petition-list");
  if (!list) return;
  const sorted = prioritySortedIssues();
  list.innerHTML = sorted.map((issue) => {
    const count = supporterCount(issue);
    const highPriority = count >= PRIORITY_THRESHOLD;
    const progress = Math.min(100, Math.round(count / GOAL * 100));
    const supportControl = count >= GOAL
      ? `<span class="ready-label">COUNCIL-READY</span>`
      : `<button class="support-button ${hasSupported(issue) ? "supported" : ""}" type="button" data-support="${escapeHtml(issue.id)}" ${hasSupported(issue) ? "disabled" : ""}>${hasSupported(issue) ? "✓ Endorsed" : "+ Endorse"}</button>`;
    return `<article class="petition-card ${highPriority ? "priority" : ""}" data-issue="${escapeHtml(issue.id)}">
      <div class="petition-card-line"><span class="category-label">${escapeHtml(issue.categoryLabel)} · ${escapeHtml(issue.distance)}</span>${highPriority ? `<span class="priority-chip">HIGH PRIORITY</span>` : ""}</div>
      <h3>${escapeHtml(issue.title)}</h3><p class="issue-description">${escapeHtml(issue.description)}</p>
      <div class="petition-card-line"><span class="support-stat"><strong>${count}</strong> / ${GOAL} endorsements</span>${supportControl}</div>
      <div class="petition-progress" aria-label="${progress}% to council-ready goal"><span style="width:${progress}%"></span></div>
    </article>`;
  }).join("") || `<p class="empty-state">No community reports yet.</p>`;
}

function renderTrackerDetail(issue) {
  const detail = document.querySelector("#tracker-detail");
  if (!issue) {
    detail.innerHTML = `<p class="empty-state">No issue selected.</p>`;
    return;
  }
  const currentIndex = Math.max(0, stageOrder.indexOf(issue.status || "submitted"));
  const nextStage = issue.status === "submitted"
    ? null
    : (issue.status === "ai_reviewed" && supporterCount(issue) < PRIORITY_THRESHOLD ? "sent_to_agency" : stageOrder[currentIndex + 1]);
  const events = issue.events || [];
  const timeline = stageOrder.map((stage, index) => {
    const event = events.find((entry) => entry.status === stage);
    const complete = Boolean(event);
    const note = event
      ? `${new Date(event.createdAt).toLocaleDateString()} · ${escapeHtml(event.note)}`
      : (index < currentIndex ? "No event recorded for this earlier stage." : (stage === "ai_reviewed" && issue.status === "submitted" ? "AI review pending" : "Awaiting update"));
    return `<div class="timeline-step ${complete ? "complete" : ""}"><span class="timeline-dot"></span><span><strong>${stageLabels[stage]}</strong><small>${note}</small></span></div>`;
  }).join("");
  const subscribed = Boolean(issue.isSubscribed);
  detail.innerHTML = `<div class="tracker-card-line"><span class="status-chip">${escapeHtml(stageLabels[issue.status] || stageLabels.submitted)}</span><span class="distance">${escapeHtml(issue.distance)}</span></div>
    <h3>${escapeHtml(issue.title)}</h3><p>${escapeHtml(issue.description)}</p>
    <div class="timeline" aria-label="Issue progress">${timeline}</div>
    <button class="secondary-button subscribe-button" type="button" data-subscribe-issue="${escapeHtml(issue.id)}">${subscribed ? "✓ Following issue" : "Follow status updates"}</button>
    <p class="form-hint">AI review checks report text for clarity; it does not verify conditions on site. Email alerts require a verified account and enabled email updates.</p>`;
  const adminPanel = document.querySelector(".admin-status-panel");
  const statusSelect = document.querySelector("#tracker-new-status");
  const updateButton = document.querySelector("#tracker-update-status");
  document.querySelector("#coordinator-status-note").textContent = coordinatorConfigured
    ? "Publish only a status that has been confirmed by an authorized coordinator."
    : "Status updates are disabled until an administrator sets ADMIN_TOKEN on the server.";
  statusSelect.innerHTML = nextStage
    ? `<option value="${nextStage}">${stageLabels[nextStage]}</option>`
    : `<option value="">Issue is at the final stage</option>`;
  statusSelect.disabled = !coordinatorConfigured || !nextStage;
  document.querySelector("#tracker-admin-token").disabled = !coordinatorConfigured || !nextStage;
  document.querySelector("#tracker-status-note").disabled = !coordinatorConfigured || !nextStage;
  updateButton.disabled = !coordinatorConfigured || !nextStage;
  adminPanel.open = !coordinatorConfigured;
}

function renderTrackerPage() {
  const list = document.querySelector("#tracker-issues");
  if (!list) return;
  const sorted = prioritySortedIssues();
  document.querySelector("#tracker-count").textContent = sorted.length;
  if (!currentTrackerIssue || !issues.some((issue) => issue.id === currentTrackerIssue)) currentTrackerIssue = sorted[0]?.id || null;
  list.innerHTML = sorted.map((issue) => `<button class="tracker-card ${issue.id === currentTrackerIssue ? "selected" : ""}" type="button" data-track-issue="${escapeHtml(issue.id)}"><span class="tracker-card-line"><strong>${escapeHtml(issue.title)}</strong><span class="status-chip">${escapeHtml(stageLabels[issue.status] || stageLabels.submitted)}</span></span><small>${escapeHtml(issue.distance)} · ${supporterCount(issue)} endorsements</small></button>`).join("") || `<p class="empty-state">No reports to track yet.</p>`;
  renderTrackerDetail(issues.find((issue) => issue.id === currentTrackerIssue));
}

function renderHotspots() {
  const list = document.querySelector("#hotspot-list");
  if (!list) return;
  const groups = new Map();
  issues.forEach((issue) => {
    const hotspot = groups.get(issue.distance) || { location: issue.distance, reports: 0, endorsements: 0 };
    hotspot.reports += 1;
    hotspot.endorsements += supporterCount(issue);
    groups.set(issue.distance, hotspot);
  });
  const sorted = [...groups.values()].sort((left, right) => right.endorsements - left.endorsements);
  document.querySelector("#hotspot-count").textContent = sorted.length;
  list.innerHTML = sorted.map((hotspot) => `<div class="hotspot-row"><span><strong>${escapeHtml(hotspot.location)}</strong><small>${hotspot.reports} reports · ${hotspot.endorsements} endorsements</small></span><span>${hotspot.reports > 1 ? "HOTSPOT" : "REPORT"}</span></div>`).join("") || `<p class="empty-state">Hotspots appear as reports are added.</p>`;
}

function createSecondaryMap(containerId) {
  const secondary = L.map(containerId, { zoomControl: true, scrollWheelZoom: true });
  if (currentArea.bounds) secondary.fitBounds(currentArea.bounds, { padding: [25, 25], maxZoom: 7 });
  else secondary.setView([currentArea.lat, currentArea.lng], 10);
  L.tileLayer(BASEMAPS.street.url, { maxZoom: 19, attribution: BASEMAPS.street.attribution }).addTo(secondary);
  return secondary;
}

function ensureTrackerMap() {
  if (!trackerMap && window.L) trackerMap = createSecondaryMap("tracker-map");
  if (trackerMap) requestAnimationFrame(() => trackerMap.invalidateSize());
}

function ensureHeatMap() {
  if (!heatMap && window.L) {
    heatMap = createSecondaryMap("heat-map");
    if (typeof L.heatLayer === "function") {
      heatLayer = L.heatLayer([], {
        radius: 38,
        blur: 30,
        maxZoom: 13,
        gradient: { 0.2: "#69b681", 0.55: "#f0c64d", 0.82: "#e77c4f", 1: "#be4138" },
      }).addTo(heatMap);
    }
  }
  if (heatMap) requestAnimationFrame(() => {
    heatMap.invalidateSize();
    renderSecondaryMaps();
  });
}

function renderSecondaryMaps() {
  if (trackerMap) {
    secondaryMarkerLayers.tracker.forEach((marker) => marker.remove());
    secondaryMarkerLayers.tracker.clear();
    issues.forEach((issue) => {
      const marker = L.circleMarker([issue.lat, issue.lng], {
        radius: 7,
        color: issue.status === "resolved" ? "#4f8a61" : (supporterCount(issue) >= PRIORITY_THRESHOLD ? "#d45f4c" : "#b4a04e"),
        fillColor: issue.status === "resolved" ? "#73ad7d" : (supporterCount(issue) >= PRIORITY_THRESHOLD ? "#e8785f" : "#d7bd60"),
        fillOpacity: 0.9,
        weight: 2,
      }).addTo(trackerMap);
      marker.bindPopup(`<strong>${escapeHtml(issue.title)}</strong><br>${escapeHtml(stageLabels[issue.status] || stageLabels.submitted)}`);
      marker.on("click", () => { currentTrackerIssue = issue.id; renderTrackerPage(); });
      secondaryMarkerLayers.tracker.set(issue.id, marker);
    });
  }
  if (heatMap && currentPage === "heatmap") {
    const size = heatMap.getSize();
    if (size.x < 1 || size.y < 1) return;
    const points = issues.map((issue) => [issue.lat, issue.lng, Math.min(1, 0.25 + supporterCount(issue) / GOAL * 0.75)]);
    if (heatLayer) heatLayer.setLatLngs(points);
    else {
      secondaryMarkerLayers.heat.forEach((marker) => marker.remove());
      secondaryMarkerLayers.heat.clear();
      issues.forEach((issue) => {
        const marker = L.circle([issue.lat, issue.lng], { radius: 500 + Math.min(2500, supporterCount(issue) * 30), color: "#d45f4c", fillColor: "#e8785f", fillOpacity: 0.17, weight: 1 }).addTo(heatMap);
        secondaryMarkerLayers.heat.set(issue.id, marker);
      });
    }
  }
}

function setBasemap(style) {
  if (!map) return;
  map.eachLayer((layer) => { if (layer instanceof L.TileLayer) map.removeLayer(layer); });
  const basemap = BASEMAPS[style];
  L.tileLayer(basemap.url, { maxZoom: basemap.maxZoom, attribution: basemap.attribution }).addTo(map);
  const button = document.querySelector("#layers-button");
  button.dataset.layer = style;
  document.querySelector("#map-style-label").textContent = style === "terrain" ? "TERRAIN MAP" : "STREET MAP";
  document.querySelectorAll("[data-basemap]").forEach((option) => {
    const selected = option.dataset.basemap === style;
    option.classList.toggle("active", selected);
    option.setAttribute("aria-pressed", String(selected));
  });
}

function selectIssue(id) {
  document.querySelectorAll(".issue-card").forEach((card) => card.classList.toggle("selected", card.dataset.issue === id));
  const card = document.querySelector(`[data-issue="${id}"]`);
  if (card) card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  const issue = issues.find((entry) => entry.id === id);
  if (issue && map) map.panTo([issue.lat, issue.lng], { animate: true });
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2700);
}

function navigateToPage(pageName, updateUrl = true) {
  const page = pageNames.includes(pageName) ? pageName : "home";
  currentPage = page;
  document.querySelectorAll("[data-page-section]").forEach((section) => {
    section.hidden = section.dataset.pageSection !== page;
  });
  document.querySelectorAll(".page-nav [data-page-target]").forEach((button) => {
    button.classList.toggle("active", button.dataset.pageTarget === page);
  });
  if (updateUrl && window.location.hash !== `#${page}`) history.replaceState(null, "", `#${page}`);
  if (page === "report") {
    if (!map) initMap();
    else requestAnimationFrame(() => map.invalidateSize());
  }
  if (page === "tracker") {
    ensureTrackerMap();
    renderSecondaryMaps();
    renderTrackerPage();
  }
  if (page === "heatmap") {
    ensureHeatMap();
    renderHotspots();
  }
  if (page === "petitions") renderPetitionPage();
}

function openPetition(issue) {
  document.querySelector("#email-subject").textContent = `Request for action: ${issue.title}`;
  document.querySelector("#email-body").textContent = `Hello Public Works team,\n\n${supporterCount(issue)} residents support this request near ${issue.distance}: ${issue.title.toLowerCase()}.\n\n${issue.description}\n\nPlease let local residents know whether this issue can be assessed and what the next steps might be.\n\nThank you,\nLocal residents`;
  const subject = encodeURIComponent(`Request for action: ${issue.title}`);
  const body = encodeURIComponent(document.querySelector("#email-body").textContent);
  document.querySelector("#send-email").href = `mailto:publicworks@city.example?subject=${subject}&body=${body}`;
  document.querySelector("#petition-modal").showModal();
}

async function handleSupport(id) {
  const issue = issues.find((entry) => entry.id === id);
  if (!issue || hasSupported(issue) || supporterCount(issue) >= GOAL) return;
  if (activeUser.guest) {
    updateAccountMode("register");
    document.querySelector("#account-modal").showModal();
    document.querySelector("#account-error").textContent = "Create and verify an account to support this petition.";
    return;
  }
  try {
    const result = await apiRequest(`/api/issues/${encodeURIComponent(id)}/support`, { method: "POST" });
    issue.supporters = result.count;
    issue.userSupported = true;
    if (result.priorityReached) issue.status = "community_priority";
    renderIssues();
    showToast(result.priorityReached
      ? `${result.count} neighbors have flagged this as a high-priority community issue.`
      : `You're in. ${result.count} neighbors are backing this issue.`);
    if (result.goalReached) openPetition(issue);
  } catch (error) {
    showToast(error.message);
  }
}

function initMap() {
  if (!window.L) {
    document.querySelector("#map-loading").textContent = "Map library failed to load. Refresh the page to try again.";
    return;
  }
  map = L.map("map", { zoomControl: false, scrollWheelZoom: true });
  if (currentArea.bounds) {
    map.fitBounds(currentArea.bounds, { padding: [30, 30], maxZoom: window.matchMedia("(max-width: 850px)").matches ? 6 : 7 });
  } else {
    map.setView([currentArea.lat, currentArea.lng], window.matchMedia("(max-width: 850px)").matches ? 12 : 13);
  }
  setBasemap("street");
  L.control.zoom({ position: "bottomright" }).addTo(map);
  map.on("click", (event) => {
    if (!selectingLocation) return;
    pendingLocation = { lat: event.latlng.lat, lng: event.latlng.lng };
    selectingLocation = false;
    map.getContainer().classList.remove("choosing-location");
    document.querySelector("#report-modal").showModal();
    document.querySelector("#pick-location").textContent = "Spot chosen ✓";
    showToast("Location pinned. Finish the report when you’re ready.");
  });
  map.whenReady(() => document.querySelector("#map-loading").classList.add("hidden"));
  renderMarkers();
}

function getPlaceLabel(result) {
  const address = result.address || {};
  const locality = address.neighbourhood || address.suburb || address.city_district || address.city || address.town || address.village || address.municipality || address.county;
  const state = STATE_CODES[address.state] || "";
  if (locality) return [locality, state].filter(Boolean).join(", ");
  return result.display_name.split(",").slice(0, 2).join(",").trim();
}

async function searchPlaces(query) {
  const status = document.querySelector("#search-status");
  const results = document.querySelector("#place-results");
  const submit = document.querySelector("#place-search-submit");
  status.textContent = "Searching communities...";
  results.replaceChildren();
  submit.disabled = true;
  const params = new URLSearchParams({
    q: query,
    format: "jsonv2",
    addressdetails: "1",
    limit: "6",
    countrycodes: "us",
  });
  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
    if (!response.ok) throw new Error("The place search is temporarily unavailable.");
    placeResults = (await response.json()).filter((result) => Number.isFinite(Number(result.lat)) && Number.isFinite(Number(result.lon)));
    if (!placeResults.length) {
      status.textContent = "No matching places found. Try a nearby city, neighborhood, or ZIP code.";
      return;
    }
    status.textContent = `${placeResults.length} places found. Choose one to set your report area.`;
    results.innerHTML = placeResults.map((result, index) => `<button class="place-result" type="button" role="option" data-place-index="${index}"><span class="place-result-icon">⌖</span><span><strong>${escapeHtml(getPlaceLabel(result))}</strong><small>${escapeHtml(result.display_name)}</small></span><span class="place-result-arrow">↗</span></button>`).join("");
  } catch (error) {
    status.textContent = error instanceof TypeError ? "Could not reach place search. Check your connection and try again." : error.message;
  } finally {
    submit.disabled = false;
  }
}

function choosePlace(result) {
  const state = STATE_CODES[result.address?.state] || "";
  setCurrentArea({ label: getPlaceLabel(result), lat: Number(result.lat), lng: Number(result.lon), state });
  pendingLocation = null;
  document.querySelector("#report-location-help").textContent = "Your report will be placed near this selected area. Add a precise pin if you like.";
  document.querySelector("#search-modal").close();
  showToast(`Map moved to ${currentArea.label}. New reports will use this area.`);
}

document.addEventListener("click", (event) => {
  const support = event.target.closest("[data-support]");
  if (support) {
    event.stopPropagation();
    handleSupport(support.dataset.support);
    return;
  }
  const card = event.target.closest("[data-issue]");
  if (card) selectIssue(card.dataset.issue);
  const close = event.target.closest("[data-close]");
  if (close) document.querySelector(`#${close.dataset.close}`).close();
});

document.addEventListener("keydown", (event) => {
  const card = event.target.closest("[data-issue]");
  if (card && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    selectIssue(card.dataset.issue);
  }
  if (event.key === "Escape") {
    selectingLocation = false;
    map?.getContainer().classList.remove("choosing-location");
    document.querySelector("#map-style-menu").hidden = true;
    document.querySelector("#layers-button").setAttribute("aria-expanded", "false");
  }
});

document.querySelectorAll(".filter-tab").forEach((button) => {
  button.addEventListener("click", () => {
    activeFilter = button.dataset.filter;
    document.querySelectorAll(".filter-tab").forEach((tab) => tab.classList.toggle("active", tab === button));
    renderIssues();
  });
});

document.querySelectorAll("[data-page-target]").forEach((control) => {
  control.addEventListener("click", (event) => {
    event.preventDefault();
    navigateToPage(control.dataset.pageTarget);
  });
});
window.addEventListener("hashchange", () => navigateToPage(window.location.hash.slice(1), false));

document.querySelector("#report-button").addEventListener("click", () => {
  document.querySelector("#report-modal").showModal();
});
document.querySelector("#area-button").addEventListener("click", () => {
  document.querySelector("#place-search-form").reset();
  document.querySelector("#place-results").replaceChildren();
  document.querySelector("#search-status").textContent = "Choose a result to move the map and set your report area.";
  document.querySelector("#search-modal").showModal();
  document.querySelector("#place-query").focus();
});
document.querySelector("#place-search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const query = new FormData(event.currentTarget).get("query").trim();
  if (query.length >= 2) searchPlaces(query);
});
document.querySelector("#place-results").addEventListener("click", (event) => {
  const option = event.target.closest("[data-place-index]");
  if (option) choosePlace(placeResults[Number(option.dataset.placeIndex)]);
});
document.querySelector("#profile-button").addEventListener("click", () => {
  renderAccountDialog();
  if (activeUser.guest) updateAccountMode("register");
  document.querySelector("#account-modal").showModal();
});
document.querySelectorAll("[data-account-mode]").forEach((button) => {
  button.addEventListener("click", () => updateAccountMode(button.dataset.accountMode));
});
document.querySelector("#account-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const button = document.querySelector("#account-submit");
  const message = document.querySelector("#account-error");
  button.disabled = true;
  message.textContent = "";
  message.classList.remove("success");
  try {
    if (accountMode === "register") {
      const result = await apiRequest("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: data.get("name").trim(),
          email: data.get("email").trim(),
          password: data.get("password"),
          emailUpdates: data.get("emailUpdates") === "on",
        }),
      });
      message.textContent = result.message;
      message.classList.add("success");
      const verificationLink = document.querySelector("#verification-link");
      verificationLink.hidden = !result.verificationUrl;
      if (result.verificationUrl) {
        verificationLink.href = result.verificationUrl;
        verificationLink.textContent = "Verify this local test account";
      }
      if (result.user) {
        emailDeliveryConfigured = Boolean(result.emailConfigured);
        setActiveUser({ ...result.user, emailConfigured: emailDeliveryConfigured });
        await loadServerState();
        form.reset();
        document.querySelector("#account-modal").close();
        showToast(result.message);
      } else {
        form.reset();
      }
    } else {
      const result = await apiRequest("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: data.get("email").trim(), password: data.get("password") }),
      });
      emailDeliveryConfigured = Boolean(result.emailConfigured);
      setActiveUser({ ...result.user, emailConfigured: emailDeliveryConfigured });
      await loadServerState();
      form.reset();
      document.querySelector("#account-modal").close();
      showToast(`Signed in as ${result.user.name}.`);
    }
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
document.querySelector("#guest-button").addEventListener("click", async () => {
  const wasSignedIn = !activeUser.guest;
  if (wasSignedIn) {
    try {
      await apiRequest("/api/auth/logout", { method: "POST" });
    } catch {}
  }
  setActiveUser({ id: "guest", name: "Neighborhood Guest", email: "", guest: true });
  document.querySelector("#account-modal").close();
  showToast(wasSignedIn ? "Signed out." : "Continuing as a neighborhood guest.");
});
document.querySelector("#save-email-preferences").addEventListener("click", async () => {
  const button = document.querySelector("#save-email-preferences");
  button.disabled = true;
  try {
    const result = await apiRequest("/api/auth/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emailUpdates: document.querySelector("#account-email-updates").checked }),
    });
    activeUser.emailUpdates = result.emailUpdates;
    showToast(result.emailUpdates ? "Petition email updates enabled." : "Petition email updates turned off.");
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
});
document.querySelector("#pick-location").addEventListener("click", () => {
  document.querySelector("#report-modal").close();
  selectingLocation = true;
  map?.getContainer().classList.add("choosing-location");
  showToast("Click anywhere on the map to place your pin.");
});

document.querySelector("#report-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const photo = data.get("photo");
  const location = pendingLocation || { lat: currentArea.lat, lng: currentArea.lng };
  const submit = form.querySelector('[type="submit"]');
  const errorLabel = document.querySelector("#form-error");
  submit.disabled = true;
  errorLabel.textContent = "";
  try {
    let photoData = null;
    if (photo?.size) {
      if (photo.size > 1_500_000) throw new Error("Choose a photo smaller than 1.5 MB.");
      photoData = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Could not read that photo."));
        reader.readAsDataURL(photo);
      });
    }
    const result = await apiRequest("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: data.get("title").trim(),
        category: data.get("category"),
        description: data.get("description").trim(),
        distance: currentArea.label,
        lat: location.lat,
        lng: location.lng,
        photo: photoData,
      }),
    });
    const issue = result.issue;
    issues.unshift(issue);
    activeFilter = "all";
    document.querySelectorAll(".filter-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.filter === "all"));
    renderIssues();
    document.querySelector("#report-modal").close();
    form.reset();
    pendingLocation = null;
    showToast("Your issue is on the map. Thanks for speaking up.");
    map?.flyTo([issue.lat, issue.lng], 16, { duration: 0.7 });
  } catch (error) {
    errorLabel.textContent = error.message;
    if (error.status === 401) {
      document.querySelector("#report-modal").close();
      setActiveUser({ id: "guest", name: "Neighborhood Guest", email: "", guest: true });
      updateAccountMode("login");
      document.querySelector("#account-modal").showModal();
    }
  } finally {
    submit.disabled = false;
  }
});

document.querySelector("#locate-button").addEventListener("click", () => {
  if (!navigator.geolocation) return showToast("Location services aren’t available in this browser.");
  navigator.geolocation.getCurrentPosition((position) => {
    map?.flyTo([position.coords.latitude, position.coords.longitude], 16);
    showToast("Map centered on your location. It isn’t shared.");
  }, () => showToast("Couldn’t access your location. You can still explore the map."), { timeout: 6000 });
});

document.querySelector("#layers-button").addEventListener("click", () => {
  const button = document.querySelector("#layers-button");
  const menu = document.querySelector("#map-style-menu");
  menu.hidden = !menu.hidden;
  button.setAttribute("aria-expanded", String(!menu.hidden));
});

document.querySelector("#map-style-menu").addEventListener("click", (event) => {
  const option = event.target.closest("[data-basemap]");
  if (!option) return;
  setBasemap(option.dataset.basemap);
  document.querySelector("#map-style-menu").hidden = true;
  document.querySelector("#layers-button").setAttribute("aria-expanded", "false");
  showToast(`${option.dataset.basemap === "terrain" ? "Terrain" : "Street"} map enabled.`);
});

document.addEventListener("click", (event) => {
  if (event.target.closest(".map-style-selector")) return;
  document.querySelector("#map-style-menu").hidden = true;
  document.querySelector("#layers-button").setAttribute("aria-expanded", "false");
});

document.querySelector("#filter-button").addEventListener("click", () => {
  const nextFilter = activeFilter === "all" ? "safety" : "all";
  document.querySelector(`[data-filter="${nextFilter}"]`).click();
});

document.querySelector("#converter-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const button = document.querySelector("#converter-submit");
  const error = document.querySelector("#converter-error");
  button.disabled = true;
  error.textContent = "";
  document.querySelector("#converter-result").hidden = true;
  try {
    const result = await apiRequest("/api/convert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: data.get("message").trim(), location: data.get("location").trim() }),
    });
    const draft = result.draft;
    const categories = { "Street safety": "safety", Accessibility: "access", "Parks & public space": "parks", "Street lighting": "lighting", Other: "other" };
    document.querySelector("#converter-title").textContent = draft.title;
    document.querySelector("#converter-urgency").textContent = draft.urgency;
    document.querySelector("#converter-urgency").className = `urgency-badge ${draft.urgency.toLowerCase()}`;
    document.querySelector("#converter-category").textContent = draft.category;
    document.querySelector("#converter-result-location").textContent = data.get("location").trim() || "Location not provided";
    document.querySelector("#converter-summary").textContent = draft.summary;
    document.querySelector("#converter-subject").value = draft.emailSubject;
    document.querySelector("#converter-body").value = draft.emailBody;
    const useReport = document.querySelector("#converter-use-report");
    useReport.dataset.title = draft.title;
    useReport.dataset.category = categories[draft.category] || "other";
    useReport.dataset.description = draft.summary;
    document.querySelector("#converter-result").hidden = false;
  } catch (requestError) {
    error.textContent = requestError.message;
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#converter-copy").addEventListener("click", async () => {
  const subject = document.querySelector("#converter-subject").value;
  const body = document.querySelector("#converter-body").value;
  try {
    await navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`);
    showToast("Draft copied.");
  } catch {
    document.querySelector("#converter-body").select();
    showToast("Select and copy the draft text.");
  }
});

document.querySelector("#converter-use-report").addEventListener("click", (event) => {
  const button = event.currentTarget;
  navigateToPage("report");
  document.querySelector("#issue-title").value = button.dataset.title || "";
  document.querySelector("#issue-category").value = button.dataset.category || "other";
  document.querySelector("#issue-description").value = button.dataset.description || "";
  document.querySelector("#report-modal").showModal();
});

document.querySelector("#tracker-issues").addEventListener("click", (event) => {
  const button = event.target.closest("[data-track-issue]");
  if (!button) return;
  currentTrackerIssue = button.dataset.trackIssue;
  renderTrackerPage();
  const issue = issues.find((item) => item.id === currentTrackerIssue);
  if (issue && trackerMap) trackerMap.panTo([issue.lat, issue.lng]);
});

document.querySelector("#tracker-detail").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-subscribe-issue]");
  if (!button) return;
  if (activeUser.guest) {
    updateAccountMode("register");
    document.querySelector("#account-error").textContent = "Sign in to follow issue status updates.";
    document.querySelector("#account-modal").showModal();
    return;
  }
  const issue = issues.find((item) => item.id === button.dataset.subscribeIssue);
  if (!issue) return;
  try {
    const result = await apiRequest(`/api/issues/${encodeURIComponent(issue.id)}/subscribe`, { method: issue.isSubscribed ? "DELETE" : "POST" });
    issue.isSubscribed = result.subscribed;
    renderTrackerPage();
    showToast(result.emailAlertsEnabled === false ? "Following this issue. Email alerts require enabled email updates." : (result.subscribed ? "Following issue updates." : "Unfollowed issue updates."));
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelector("#tracker-update-status").addEventListener("click", async () => {
  const issue = issues.find((item) => item.id === currentTrackerIssue);
  if (!issue) return showToast("Choose an issue before updating its status.");
  const token = document.querySelector("#tracker-admin-token").value.trim();
  if (!token) return showToast("Enter the coordinator token to publish a status update.");
  const button = document.querySelector("#tracker-update-status");
  button.disabled = true;
  try {
    const result = await apiRequest(`/api/issues/${encodeURIComponent(issue.id)}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status: document.querySelector("#tracker-new-status").value, note: document.querySelector("#tracker-status-note").value }),
    });
    Object.assign(issue, result.issue);
    document.querySelector("#tracker-status-note").value = "";
    renderIssues();
    showToast(result.emailAlertsEnabled ? "Status updated and email alerts queued." : "Status updated. Email alerts are not configured.");
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = !coordinatorConfigured;
  }
});

document.querySelectorAll("[data-page-target]").forEach((control) => {
  control.addEventListener("click", (event) => {
    event.preventDefault();
    navigateToPage(control.dataset.pageTarget);
  });
});
window.addEventListener("hashchange", () => navigateToPage(window.location.hash.slice(1), false));

updateAreaLabels();
renderAccountDialog();
renderIssues();
loadServerState();
navigateToPage(currentPage, false);
navigateToPage(currentPage, false);
setInterval(async () => {
  if (currentPage !== "tracker" || document.hidden) return;
  try {
    const result = await apiRequest("/api/issues");
    issues = result.issues;
    coordinatorConfigured = Boolean(result.coordinatorConfigured);
    renderIssues();
  } catch {}
}, 15_000);
const chatPanel = document.querySelector("#chat-panel");
const chatLauncher = document.querySelector("#chat-launcher");
const chatMessages = document.querySelector("#chat-messages");
const chatInput = document.querySelector("#chat-input");
const chatForm = document.querySelector("#chat-form");
const chatSend = document.querySelector("#chat-send");
const chatHistory = [];

function addChatMessage(text, role) {
  const message = document.createElement("div");
  message.className = `chat-message ${role}-message`;
  message.textContent = text;
  chatMessages.append(message);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return message;
}

chatLauncher.addEventListener("click", () => {
  const open = chatPanel.hidden;
  chatPanel.hidden = !open;
  chatLauncher.setAttribute("aria-expanded", String(open));
  if (open) chatInput.focus();
});

document.querySelector("#chat-close").addEventListener("click", () => {
  chatPanel.hidden = true;
  chatLauncher.setAttribute("aria-expanded", "false");
  chatLauncher.focus();
});

chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = chatInput.value.trim();
  if (!message || chatSend.disabled) return;

  addChatMessage(message, "user");
  chatInput.value = "";
  chatInput.style.height = "auto";
  chatSend.disabled = true;
  chatInput.disabled = true;
  const pending = addChatMessage("Thinking...", "assistant pending-message");

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history: chatHistory.slice(-12) }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "The assistant couldn’t answer right now.");
    if (typeof data.reply !== "string" || !data.reply.trim()) throw new Error("The assistant returned an empty response. Please try again.");

    pending.remove();
    addChatMessage(data.reply, "assistant");
    chatHistory.push({ role: "user", text: message }, { role: "model", text: data.reply });
  } catch (error) {
    pending.remove();
    addChatMessage(error.message || "Could not connect to Sidewalk Assistant. Check that the app server is running and try again.", "assistant error-message");
  } finally {
    chatSend.disabled = false;
    chatInput.disabled = false;
    chatInput.focus();
  }
});

chatInput.addEventListener("input", () => {
  chatInput.style.height = "auto";
  chatInput.style.height = `${Math.min(chatInput.scrollHeight, 120)}px`;
});
