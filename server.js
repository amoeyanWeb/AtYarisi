/**
 * TJK Race Dashboard - Backend
 * ------------------------------------------------------------
 * Bu sunucu, her istek geldiginde (ya da cache suresi dolunca)
 * tjk.org sitesinden GUNCEL veriyi ceker, bellekte (in-memory) tutar
 * ve kendi API'miz uzerinden frontend'e sunar.
 *
 * ONEMLI NOT (Farsca aciklama asagida):
 * Bu kod, TJK sitesinin bugune kadar incelenen URL/HTML yapisina
 * gore yazildi. TJK sayfalari zaman zaman HTML yapisini
 * degistirebilir; bu yuzden parse fonksiyonlari (parseDeclarations,
 * parseHorseHistory) "genis/tolerangsli" (defensive) yazildi: tablo
 * basliklarindaki Turkce kelimelere gore kolon eslestirmesi yapar.
 * Ilk calistirmada console.log ile ham HTML/CSV cikti kontrol
 * edilmeli, gerekirse selector'lar ince ayar edilmeli.
 *
 * توضیح فارسی:
 * این سرور هر بار (یا وقتی کش منقضی بشه) از سایت tjk.org داده‌ی
 * زنده می‌گیره، تو حافظه نگه می‌داره و از طریق API خودمون به
 * فرانت‌اند می‌ده. چون من (Claude) امکان تست زنده روی tjk.org رو
 * از محیط sandbox خودم نداشتم، پارسرها با منطق «انعطاف‌پذیر»
 * نوشته شدن (بر اساس کلمات کلیدی ترکی تو هدر جدول‌ها) تا اگه
 * ساختار دقیق HTML یه‌کم فرق داشت، باز هم کار کنه. حتماً اولین
 * بار لوکال اجرا کن و کنسول رو چک کن.
 */

const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const Papa = require("papaparse");
const iconv = require("iconv-lite");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------
// In-memory cache (kalici degil, sunucu yeniden baslarsa sifirlanir)
// ---------------------------------------------------------------
const cache = {
  declarations: {}, // key: "YYYY-MM-DD" -> { fetchedAt, data }
  horseHistory: {}, // key: atId -> { fetchedAt, data }
};

const TTL_DECLARATIONS_MS = 10 * 60 * 1000; // 10 dakika
const TTL_HORSE_MS = 60 * 60 * 1000; // 1 saat

function isFresh(entry, ttl) {
  return entry && Date.now() - entry.fetchedAt < ttl;
}

// ---------------------------------------------------------------
// Yardimci: tarih formatlari
// ---------------------------------------------------------------
function toTRDateSlash(d) {
  // DD/MM/YYYY  (URL query parametresi icin)
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function toISODate(d) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${yyyy}-${mm}-${dd}`;
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
      "Accept-Language": "tr-TR,tr;q=0.9",
      "X-Requested-With": "XMLHttpRequest",
      Referer: "https://www.tjk.org/TR/YarisSever/Info/Page/Deklareler",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = await res.buffer();
  // TJK bazi sayfalarda windows-1254 (Turkish) encoding kullanabiliyor.
  // Once UTF-8 dene, ise yaramazsa iconv ile windows-1254 cevir.
  let html = buf.toString("utf8");
  if (html.includes("�")) {
    html = iconv.decode(buf, "windows-1254");
  }
  return html;
}

// ---------------------------------------------------------------
// ADIM 1: Belirli bir tarih icin hangi sehirlerde yaris oldugunu bul
// Kaynak: https://www.tjk.org/TR/YarisSever/Info/Page/Deklareler
// ---------------------------------------------------------------
async function discoverCitiesForDate(dateObj) {
  const dateSlash = toTRDateSlash(dateObj);
  const url = `https://www.tjk.org/TR/YarisSever/Info/Page/Deklareler?QueryParameter_Tarih=${encodeURIComponent(
    dateSlash
  )}`;

  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const cities = [];
  // Sehir linkleri genelde "SehirId=" parametresi icerir.
  $("a[href*='SehirId=']").each((_, el) => {
    const href = $(el).attr("href") || "";
    const match = href.match(/SehirId=(-?\d+)/);
    const nameMatch = href.match(/SehirAdi=([^&]+)/);
    if (match) {
      const sehirId = match[1];
      const sehirAdi = nameMatch
        ? decodeURIComponent(nameMatch[1].replace(/\+/g, "%20"))
        : $(el).text().trim();
      if (sehirAdi && !cities.some((c) => c.sehirId === sehirId)) {
        cities.push({ sehirId, sehirAdi, href });
      }
    }
  });

  return { dateSlash, cities };
}

// ---------------------------------------------------------------
// ADIM 2: Bir sehir + tarih icin deklare edilen atlarin tam listesi
// Kaynak: https://www.tjk.org/TR/YarisSever/Info/Sehir/Deklareler
// ---------------------------------------------------------------
async function fetchCityDeclarations(dateObj, sehirId, sehirAdi) {
  const dateSlash = toTRDateSlash(dateObj);
  const url =
    `https://www.tjk.org/TR/YarisSever/Info/Sehir/Deklareler` +
    `?SehirId=${sehirId}&QueryParameter_Tarih=${encodeURIComponent(
      dateSlash
    )}&SehirAdi=${encodeURIComponent(sehirAdi)}&Era=today`;

  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const races = [];

  // TJK'nin gercek HTML yapisinda hucreler net class isimleri ile geliyor
  // (Inspector'dan dogrulandi):
  //   td.gunluk-Deklareler-Kilo        -> siklet/kilo
  //   td.gunluk-Deklareler-JokeAdi     -> jokey adi
  //   td.gunluk-Deklareler-SahipAdi    -> sahip
  //   td.gunluk-Deklareler-AntronorAdi -> antrenor
  //   td.gunluk-Deklareler-Hc          -> HP (handikap puani)
  //   td.gunluk-Deklareler-Son6Yaris   -> son 6 yaris
  // At ismi/yas/pedigri icin kesin class adi dogrulanamadi; once olasi
  // class isimleriyle, olmazsa pozisyona gore yakalaniyor.

  let raceContainers = $("div[sehir]").toArray();
  if (raceContainers.length === 0) {
    raceContainers = $("table").toArray(); // yedek plan
  }

  raceContainers.forEach((container, idx) => {
    const $container = $(container);
    const $table = $container.is("table") ? $container : $container.find("table").first();
    if ($table.length === 0) return;

    let raceTitle = "";
    $container
      .find("*")
      .addBack()
      .each((_, el) => {
        const t = $(el).clone().children().remove().end().text().trim();
        if (!raceTitle && t && /(Yaşlı|Y\.İ\.D|Kg|Çim|Kum)/i.test(t) && t.length < 200) {
          raceTitle = t;
        }
      });
    if (!raceTitle) raceTitle = `Koşu ${idx + 1}`;

    const rows = $table.find("tr").toArray();
    const horses = [];

    rows.forEach((row) => {
      const $row = $(row);
      const cells = $row.find("td");
      if (cells.length === 0) return; // baslik satiri - atla

      const byClass = (classNames) => {
        for (const cls of classNames) {
          const el = $row.find(`.${cls}`).first();
          if (el.length) return el.text().trim();
        }
        return "";
      };

      const kilo = byClass(["gunluk-Deklareler-Kilo"]);
      const jokey = byClass(["gunluk-Deklareler-JokeAdi"]);
      const sahip = byClass(["gunluk-Deklareler-SahipAdi"]);
      const antrenor = byClass(["gunluk-Deklareler-AntronorAdi"]);
      const hp = byClass(["gunluk-Deklareler-Hc"]);
      const son6 = byClass(["gunluk-Deklareler-Son6Yaris"]);

      let name = byClass([
        "gunluk-Deklareler-AtAdi",
        "gunluk-Deklareler-AtIsmi",
        "gunluk-Deklareler-At",
      ]);
      let yas = byClass(["gunluk-Deklareler-Yas"]);
      let pedigri = byClass(["gunluk-Deklareler-Baba", "gunluk-Deklareler-Orijin"]);

      // Pozisyonel yedek plan: kolon sirasi genelde
      // [No, At Ismi, Yas, Orijin(Baba-Anne), Kilo, Jokey, Sahip, Antrenor, HP, Son6]
      if (!name) {
        const texts = cells.toArray().map((c) => $(c).text().trim());
        const kiloIdx = texts.findIndex((t) => t === kilo && kilo !== "");
        if (kiloIdx > 2) {
          name = texts[1];
          if (!yas) yas = texts[2];
          if (!pedigri) pedigri = texts[3];
        } else if (texts.length > 1) {
          name = texts[1];
        }
      }

      if (!name) return; // gercek bir at satiri degil - atla

      let atId = null;
      $row.find("a[href*='AtId=']").each((_, a) => {
        const href = $(a).attr("href") || "";
        const m = href.match(/AtId=(-?\d+)/);
        if (m) atId = m[1];
      });

      horses.push({
        no: $(cells[0]).text().trim(),
        atId,
        name,
        yas: cleanYas(yas),
        jokey,
        kilo,
        hp,
        pedigri,
        antrenor,
        son6,
      });
    });

    if (horses.length > 0) {
      races.push({ raceTitle, horses });
    }
  });

  return races;
}

// ---------------------------------------------------------------
// ADIM 3: Bir atin gecmis 6 kosusu
// Kaynak: https://www.tjk.org/TR/YarisSever/Query/ConnectedPage/AtKosuBilgileri
// ---------------------------------------------------------------
async function fetchHorseHistory(atId) {
  const cached = cache.horseHistory[atId];
  if (isFresh(cached, TTL_HORSE_MS)) return cached.data;

  const url = `https://www.tjk.org/TR/YarisSever/Query/ConnectedPage/AtKosuBilgileri?1=1&QueryParameter_AtId=${atId}`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const headers = [];
  $("table").first().find("tr").first().find("th,td").each((_, th) => {
    headers.push($(th).text().trim().toLowerCase());
  });

  const findCol = (keywords) =>
    headers.findIndex((h) => keywords.some((k) => h.includes(k)));

  const colTarih = findCol(["tarih"]);
  const colSehir = findCol(["şehir", "sehir", "hipodrom"]);
  const colMesafe = findCol(["mesafe", "msf"]);
  const colPist = findCol(["pist"]);
  const colJokey = findCol(["jokey"]);
  const colDerece = findCol(["derece", "sıra", "sira"]);
  const colGanyan = findCol(["ganyan", "gny"]);

  const runs = [];
  $("table")
    .first()
    .find("tr")
    .slice(1)
    .each((_, row) => {
      const $row = $(row);
      const cells = $row.find("td");
      if (cells.length === 0) return;
      const getCell = (idx) => (idx >= 0 && cells[idx] ? $(cells[idx]).text().trim() : "");

      const tarih = getCell(colTarih);
      if (!tarih) return;

      runs.push({
        tarih,
        sehir: getCell(colSehir),
        mesafe: getCell(colMesafe),
        pist: getCell(colPist),
        jokey: getCell(colJokey),
        derece: getCell(colDerece),
        ganyan: getCell(colGanyan),
      });
    });

  const last6 = runs.slice(0, 6);
  cache.horseHistory[atId] = { fetchedAt: Date.now(), data: last6 };
  return last6;
}

// ---------------------------------------------------------------
// ADIM 4: Basit tahmin modeli (win probability)
// ---------------------------------------------------------------
function cleanYas(raw) {
  if (!raw) return raw;
  // Gecerli format hep "Ny x" seklinde: sayi + 'y' + tek harf cinsiyet kodu
  // (d/e/k/a/i). Bazen komsu hucrelerden fazladan metin sizabiliyor;
  // sadece bu deseni yakalayip gerisini at.
  const m = String(raw).match(/(\d+)\s*y\s*([dekaiDEKAI])/);
  if (m) return `${m[1]}y ${m[2].toLowerCase()}`;
  return String(raw).trim().split(/\s+/).slice(0, 2).join(" ");
}

function parseSon6String(son6) {
  // "32434" gibi bir rakam dizisini ["3","2","4","3","4"] pozisyonlarina cevirir.
  if (!son6) return [];
  return String(son6)
    .split("")
    .filter((ch) => /[1-9]/.test(ch))
    .map((ch) => parseInt(ch, 10));
}

function computeWinProbabilities(horses) {
  const scored = horses.map((h) => {
    const hpNum = parseFloat(String(h.hp).replace(",", ".")) || 0;

    const positions = parseSon6String(h.son6);
    const avgPos =
      positions.length > 0
        ? positions.reduce((a, b) => a + b, 0) / positions.length
        : 10; // veri yoksa notr/kotu varsay

    const formScore = 1 / avgPos;

    // NOT: Bu katsayilar (0.7 / 0.3) baslangic varsayimidir, gercek
    // sonuclarla karsilastirip (backtesting) ayarlanmali.
    const rawScore = 0.7 * hpNum + 0.3 * formScore * 100;

    return { ...h, avgPos, rawScore };
  });

  const total = scored.reduce((sum, h) => sum + Math.max(h.rawScore, 0.01), 0);
  return scored.map((h) => ({
    ...h,
    winProbability: total > 0 ? +((Math.max(h.rawScore, 0.01) / total) * 100).toFixed(1) : 0,
  }));
}

// ---------------------------------------------------------------
// Ana toplama fonksiyonu: bir tarih icin tum sehir/kosu/at/tahmin
// ---------------------------------------------------------------
async function getFullDayData(dateObj) {
  const iso = toISODate(dateObj);
  const cached = cache.declarations[iso];
  if (isFresh(cached, TTL_DECLARATIONS_MS)) return cached.data;

  const { dateSlash, cities } = await discoverCitiesForDate(dateObj);

  const citiesData = [];
  for (const city of cities) {
    let races = [];
    try {
      races = await fetchCityDeclarations(dateObj, city.sehirId, city.sehirAdi);
    } catch (err) {
      console.error(`Sehir cekilirken hata (${city.sehirAdi}):`, err.message);
      continue;
    }

    // Oran hesabini dogrudan "Son 6 Y." rakam dizisinden yap (hizli, guvenilir,
    // ekstra bir HTTP istegi gerektirmez).
    for (const race of races) {
      race.horses = computeWinProbabilities(race.horses);
    }

    // NOT: Onceden burada her at icin ayrica detayli tarihce (AtKosuBilgileri)
    // cekiliyordu. Bu hem yavastı (her at icin ayrı, sirali HTTP istegi) hem
    // de o endpoint sık sık 404 donuyordu. "Son 6 Y." verisi skorlama icin
    // yeterli oldugundan bu adim kaldirildi. Istenirse /api/horse/:atId
    // endpoint'i uzerinden tek tek, talep uzerine (on-demand) hala cekilebilir.

    citiesData.push({ sehirId: city.sehirId, sehirAdi: city.sehirAdi, races });
  }

  const result = { date: dateSlash, cities: citiesData };
  cache.declarations[iso] = { fetchedAt: Date.now(), data: result };
  return result;
}

// ---------------------------------------------------------------
// API Endpoints
// ---------------------------------------------------------------
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/races", async (req, res) => {
  try {
    const offset = req.query.day === "tomorrow" ? 1 : 0;
    const d = new Date();
    d.setDate(d.getDate() + offset);
    const data = await getFullDayData(d);
    res.json({ ok: true, ...data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/horse/:atId", async (req, res) => {
  try {
    const history = await fetchHorseHistory(req.params.atId);
    res.json({ ok: true, atId: req.params.atId, last6: history });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Cache'i manuel temizlemek icin (test/debug)
app.post("/api/cache/clear", (req, res) => {
  cache.declarations = {};
  cache.horseHistory = {};
  res.json({ ok: true, message: "Cache temizlendi" });
});

app.listen(PORT, () => {
  console.log(`TJK Race Dashboard http://localhost:${PORT} adresinde calisiyor`);
});
