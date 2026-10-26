// Open data page: live counts and a ready-to-paste Google Sheets formula with this site's address.
(async () => {
  const formula = document.getElementById("sheets-formula");
  formula.textContent = `=IMPORTDATA("${location.origin}/api/open/reports.csv")`;
  const box = document.getElementById("data-stats");
  try {
    const response = await fetch("/api/open/summary");
    if (!response.ok) throw new Error();
    const data = await response.json();
    const newest = data.newest ? new Date(data.newest).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }) : "none yet";
    box.innerHTML = "";
    [["Reports", data.reports], ["Fixed", data.fixed], ["Newest report", newest]].forEach(([label, value]) => {
      const div = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = value;
      const span = document.createElement("span");
      span.textContent = label;
      div.append(strong, span);
      box.append(div);
    });
  } catch {
    box.innerHTML = "<p>Couldn't load the numbers right now. The downloads still work.</p>";
  }
})();
