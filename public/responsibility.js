// A best guess at who maintains the spot where a report was pinned: the state transportation
// department or the local government. It reads the nearest road from OpenStreetMap (the same
// place search Sidewalk already uses) and links only to official state pages. It's a guess, so
// the wording always says "likely" and points to a way to confirm.
const RESPONSIBILITY_LINKS = {
  NC: [
    { label: "Report to NCDOT", url: "https://www.ncdot.gov/contact/Pages/form.aspx?UnitName=pothole&sourceUrl=%2Fcontact%2F" },
    { label: "Check NCDOT's state-maintained roads map", url: "https://www.nconemap.gov/datasets/NCDOT::ncdot-state-maintained-roads/explore?layer=0" },
  ],
  SC: [
    { label: "SCDOT pothole and road problems (855-GO-SCDOT)", url: "https://scdot.org/pothole" },
  ],
};
const responsibilityCache = new Map();

function guessResponsibility(issue) {
  if (!responsibilityCache.has(issue.id)) responsibilityCache.set(issue.id, lookUpResponsibility(issue).catch(() => null));
  return responsibilityCache.get(issue.id);
}

async function lookUpResponsibility(issue) {
  const params = new URLSearchParams({ lat: issue.lat, lon: issue.lng, format: "jsonv2", zoom: "17", addressdetails: "1", namedetails: "1", extratags: "1" });
  const response = await fetch(`https://nominatim.openstreetmap.org/reverse?${params}`);
  if (!response.ok) return null;
  const place = await response.json();
  const a = place.address || {};
  const state = a.state === "North Carolina" ? "NC" : a.state === "South Carolina" ? "SC" : null;
  if (!state) return null;
  const dot = state === "NC" ? "NCDOT" : "SCDOT";
  const town = a.city || a.town || a.village || "";
  const county = a.county || "";
  const road = a.road || "";
  const ref = place.namedetails?.ref || place.extratags?.ref || "";
  const links = RESPONSIBILITY_LINKS[state];

  if (issue.category === "lighting") {
    return { who: town ? `Likely ${town} or the power company` : "Likely the power company or the county", why: "Streetlights are often owned by the local power company, and some by the city. Your city's public works or 311 page will say who to call.", links: [] };
  }
  if (issue.category === "parks") {
    return { who: town ? `Likely ${town} Parks` : `Likely ${county || "the county"} Parks`, why: "Parks and public spaces are usually run by the city or county parks department.", links: [] };
  }
  if (/^(I|US|NC|SC)[\s-]?\d+/i.test(ref)) {
    return { who: `Likely ${dot}`, why: `${road || "This road"} is a numbered state or federal route (${ref}), which the state usually maintains.`, links };
  }
  if (town) {
    return { who: `Likely ${town}`, why: `This looks like a local street${road ? ` (${road})` : ""} inside ${town}. Some streets inside towns are still maintained by the state, so confirm if you're not sure.`, links: state === "NC" ? links.slice(1) : [] };
  }
  return state === "NC"
    ? { who: "Likely NCDOT", why: `In North Carolina, the state maintains most roads outside city and town limits${road ? `, likely including ${road}` : ""}.`, links }
    : { who: `Likely SCDOT or ${county || "the county"}`, why: `Outside town limits in South Carolina, roads${road ? ` like ${road}` : ""} are maintained by SCDOT or the county.`, links };
}
