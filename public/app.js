const content = document.getElementById("content");
const sidebar = document.getElementById("citySidebar");
const status = document.getElementById("status");

let currentDay = "today";
let currentData = null; // son cekilen API cevabi
let expandedCityId = null; // menusu acik olan sehir
let activeCityId = null; // ekranda gosterilen kosunun sehri
let activeRaceIndex = null; // ekranda gosterilen kosunun index'i

async function loadData(day) {
  content.innerHTML = `<p class="loading">Veriler tjk.org üzerinden çekiliyor, biraz zaman alabilir...</p>`;
  sidebar.innerHTML = "";
  status.textContent = "";
  try {
    const res = await fetch(`/api/races?day=${day}`);
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || "Bilinmeyen hata");
    currentData = json;
    const firstCity = json.cities?.[0] ?? null;
    expandedCityId = firstCity?.sehirId ?? null;
    activeCityId = firstCity?.sehirId ?? null;
    activeRaceIndex = firstCity && firstCity.races?.length ? 0 : null;
    renderSidebar();
    renderActiveRace();
    status.textContent = `Son güncelleme: ${new Date().toLocaleTimeString("tr-TR")} — Tarih: ${json.date}`;
  } catch (err) {
    content.innerHTML = `<p class="error">Veri alınamadı: ${err.message}</p>`;
  }
}

function renderSidebar() {
  if (!currentData || !currentData.cities || currentData.cities.length === 0) {
    sidebar.innerHTML = "";
    return;
  }

  sidebar.innerHTML = currentData.cities
    .map((city) => {
      const raceCount = city.races?.length || 0;
      const isExpanded = city.sehirId === expandedCityId;
      const isActiveCity = city.sehirId === activeCityId;

      const raceLinks = (city.races || [])
        .map((race, idx) => {
          const isActiveRace = isActiveCity && idx === activeRaceIndex;
          return `
            <a href="#" class="race-link ${isActiveRace ? "active" : ""}" data-sehir-id="${city.sehirId}" data-race-index="${idx}">
              ${race.raceTitle}
            </a>
          `;
        })
        .join("");

      return `
        <div class="city-group">
          <button class="city-tab ${isExpanded ? "open" : ""} ${isActiveCity ? "active" : ""}" data-sehir-id="${city.sehirId}">
            <span>${city.sehirAdi}<span class="race-count">${raceCount} koşu</span></span>
            <span class="chevron">▾</span>
          </button>
          <div class="city-races-list ${isExpanded ? "open" : ""}">
            ${raceLinks}
          </div>
        </div>
      `;
    })
    .join("");

  sidebar.querySelectorAll(".city-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.sehirId;
      expandedCityId = expandedCityId === id ? null : id;
      renderSidebar();
    });
  });

  sidebar.querySelectorAll(".race-link").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      activeCityId = link.dataset.sehirId;
      activeRaceIndex = Number(link.dataset.raceIndex);
      expandedCityId = activeCityId; // menu acik kalsin
      renderSidebar();
      renderActiveRace();
    });
  });
}

function renderActiveRace() {
  if (!currentData || !currentData.cities || currentData.cities.length === 0) {
    content.innerHTML = `<p class="loading">Bu tarih için ilan edilmiş koşu bulunamadı.</p>`;
    return;
  }

  const city = currentData.cities.find((c) => c.sehirId === activeCityId);
  if (!city || activeRaceIndex === null || !city.races?.[activeRaceIndex]) {
    content.innerHTML = `<p class="loading">Görüntülemek için soldan bir şehir ve koşu seçin.</p>`;
    return;
  }

  const race = city.races[activeRaceIndex];

  content.innerHTML = `
    <section class="city-block">
      <h2>${city.sehirAdi}</h2>
      ${renderRace(race)}
    </section>
  `;
}

function renderRace(race) {
  const sorted = [...race.horses].sort((a, b) => b.winProbability - a.winProbability);
  const maxProb = Math.max(...sorted.map((h) => h.winProbability), 1);

  return `
    <div class="race-card">
      <h3>${race.raceTitle}</h3>
      <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>No</th><th>At</th><th>Jokey</th><th>Yaş</th><th>Kilo</th><th>HP</th>
            <th>Son 6 Koşu</th><th>Kazanma Şansı</th>
          </tr>
        </thead>
        <tbody>
          ${sorted
            .map(
              (h, i) => `
            <tr class="${i === 0 ? "top-pick" : ""}">
              <td>${h.no || "-"}</td>
              <td class="horse-cell">
                <span class="horse-name">${h.name}</span>
                <div class="horse-tooltip">
                  <strong>${h.name}</strong>
                  ${h.pedigri ? `<div>${h.pedigri}</div>` : ""}
                  ${h.antrenor ? `<div><span>Antrenör:</span> ${h.antrenor}</div>` : ""}
                </div>
              </td>
              <td>${h.jokey || "-"}</td>
              <td>${h.yas || "-"}</td>
              <td>${h.kilo || "-"}</td>
              <td>${h.hp || "-"}</td>
              <td>${renderLast6(h.son6)}</td>
              <td class="prob-cell">
                <span class="prob-bar" style="width:${(h.winProbability / maxProb) * 60}px"></span>
                %${h.winProbability}
              </td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
      </div>
    </div>
  `;
}

function renderLast6(son6) {
  const positions = String(son6 || "")
    .split("")
    .filter((ch) => /[1-9]/.test(ch));
  if (positions.length === 0) return `<span class="last6"><span>-</span></span>`;
  return `<div class="last6">${positions
    .map((p) => `<span class="${p === "1" ? "win" : ""}">${p}</span>`)
    .join("")}</div>`;
}

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentDay = btn.dataset.day;
    loadData(currentDay);
  });
});

document.getElementById("refreshBtn").addEventListener("click", async () => {
  await fetch("/api/cache/clear", { method: "POST" });
  loadData(currentDay);
});

// Dokunmatik (mobil) cihazlarda tooltip'i tıklayarak ac/kapat.
// Masaustunde mouse hover zaten CSS ile calisiyor; bu sadece tap icin ek destek.
content.addEventListener("click", (e) => {
  const nameEl = e.target.closest(".horse-name");
  const tooltipEl = e.target.closest(".horse-tooltip");
  const openCell = document.querySelector(".horse-cell.open");

  if (nameEl) {
    const cell = nameEl.closest(".horse-cell");
    const alreadyOpen = cell.classList.contains("open");
    document.querySelectorAll(".horse-cell.open").forEach((c) => c.classList.remove("open"));
    if (!alreadyOpen) cell.classList.add("open");
    e.stopPropagation();
    return;
  }

  if (tooltipEl) {
    e.stopPropagation();
    return;
  }

  if (openCell) openCell.classList.remove("open");
});

document.addEventListener("click", () => {
  document.querySelectorAll(".horse-cell.open").forEach((c) => c.classList.remove("open"));
});

loadData(currentDay);
