import React, { useState, useEffect, useRef } from "react";
import { ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { kvGet, kvSet } from "./supabaseClient";
import { buildSchedule, buildXlsxMulti } from "./Finanziamenti";

// ---------------------------------------------------------------
// TESORERIA — previsione del saldo del conto Beta.
// Unisce: saldo di partenza (modificabile) + fatture/impegni dal file Excel
// della contabilità (solo quelli con data di pagamento futura) + rate dei
// finanziamenti il cui nome contiene "Beta". Segnala quando il saldo
// scende sotto la soglia minima.
// ---------------------------------------------------------------

const TREASURY_KEY = "gruppo-endine:treasury-beta";
const LOANS_KEY = "gruppo-endine:loans"; // stessa chiave della pagina Finanziamenti

// ---------- date (sempre testo "AAAA-MM-GG", calcoli in UTC) ----------
const isoOf = (d) => d.toISOString().slice(0, 10);
const todayIso = () => {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
};
const msOf = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
const fmtDate = (iso) => {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
};
const DAY = 86400000;
const addMonthsIso = (iso, n) => {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return isoOf(t);
};

// data di addebito di una rata: giorno fisso del mese; a febbraio l'ultimo giorno lavorativo
function loanPayDate(idx, day) {
  const y = Math.floor(idx / 12);
  const m = idx % 12; // 0 = gennaio
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  if (m === 1) {
    let d = last;
    while ([0, 6].includes(new Date(Date.UTC(y, m, d)).getUTCDay())) d--;
    return isoOf(new Date(Date.UTC(y, m, d)));
  }
  return isoOf(new Date(Date.UTC(y, m, Math.min(Math.max(1, day), last))));
}

// ---------- lettura di un file .xlsx senza librerie esterne ----------
async function readZip(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  let e = u8.length - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error("zip");
  const n = dv.getUint16(e + 10, true);
  let p = dv.getUint32(e + 16, true);
  const files = {};
  for (let i = 0; i < n; i++) {
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
    files[name] = { method: dv.getUint16(p + 10, true), csize: dv.getUint32(p + 20, true), off: dv.getUint32(p + 42, true) };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return async (name) => {
    const f = files[name];
    if (!f) return null;
    const nl = dv.getUint16(f.off + 26, true);
    const el = dv.getUint16(f.off + 28, true);
    const start = f.off + 30 + nl + el;
    const data = u8.subarray(start, start + f.csize);
    if (f.method === 0) return new TextDecoder().decode(data);
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new TextDecoder().decode(await new Response(stream).arrayBuffer());
  };
}

const colIdx = (ref) => {
  const letters = ref.replace(/[0-9]/g, "");
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

async function readSheets(buf) {
  const get = await readZip(buf);
  const parse = (txt) => new DOMParser().parseFromString(txt, "application/xml");
  const wbTxt = await get("xl/workbook.xml");
  if (!wbTxt) throw new Error("xlsx");
  const relsTxt = await get("xl/_rels/workbook.xml.rels");
  const ssTxt = await get("xl/sharedStrings.xml");
  const shared = [];
  if (ssTxt) {
    [...parse(ssTxt).getElementsByTagName("si")].forEach((si) => {
      shared.push([...si.getElementsByTagName("t")].map((t) => t.textContent).join(""));
    });
  }
  const rels = {};
  [...parse(relsTxt).getElementsByTagName("Relationship")].forEach((r) => {
    let t = r.getAttribute("Target");
    t = t.startsWith("/") ? t.slice(1) : "xl/" + t;
    rels[r.getAttribute("Id")] = t;
  });
  const sheets = [];
  for (const s of [...parse(wbTxt).getElementsByTagName("sheet")]) {
    const path = rels[s.getAttribute("r:id")];
    const txt = path && (await get(path));
    if (!txt) continue;
    const grid = []; // grid[riga] = { colonna: valore }
    [...parse(txt).getElementsByTagName("c")].forEach((c) => {
      const ref = c.getAttribute("r");
      if (!ref) return;
      const t = c.getAttribute("t");
      const v = c.getElementsByTagName("v")[0];
      let val = null;
      if (t === "inlineStr") val = [...c.getElementsByTagName("t")].map((x) => x.textContent).join("");
      else if (v) {
        if (t === "s") val = shared[Number(v.textContent)] ?? null;
        else if (t === "str") val = v.textContent;
        else if (t === "b" || t === "e") val = null;
        else {
          const num = Number(v.textContent);
          val = Number.isNaN(num) ? null : num;
        }
      }
      if (val === null || val === "") return;
      const r = Number(ref.replace(/[A-Z]/gi, ""));
      (grid[r] = grid[r] || {})[colIdx(ref)] = val;
    });
    sheets.push({ name: s.getAttribute("name"), grid });
  }
  return sheets;
}

const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9àèéìòù]+/g, " ")
    .trim();
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const serialToIso = (v) => isoOf(new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * DAY));
const isSerial = (v) => typeof v === "number" && v > 40000 && v < 80000;
const nextDec15 = () => {
  const t = todayIso();
  const y = Number(t.slice(0, 4));
  return t > `${y}-12-15` ? `${y + 1}-12-15` : `${y}-12-15`;
};

// trasforma i fogli "Uscite" e "Incassi" nelle righe usate dalla previsione
function parseAccounting(sheets) {
  const HEAD = {
    progetto: ["progetto"],
    dataFattura: ["data fattura", "data incasso"],
    voce: ["voce"],
    fornitore: ["fornitore", "cliente"],
    descrizione: ["descrizione"],
    escl: ["importo iva escl"],
    iva: ["iva"],
    rit: ["rit acc"],
    conIva: ["importo con iva"],
    dataPag: ["data pagamento", "data incasso"],
    mezzo: ["mezzo di pagamento"],
    stima: ["reale stima"],
  };
  const all = [];
  const found = [];
  sheets.forEach((sh, si) => {
    let hr = -1;
    const col = {};
    sh.grid.forEach((row, r) => {
      if (!row || hr !== -1) return;
      const m = {};
      Object.entries(row).forEach(([ci, v]) => {
        const k = Object.keys(HEAD).find((key) => HEAD[key].includes(norm(v)));
        if (k && m[k] === undefined) m[k] = Number(ci);
      });
      // "Data Incasso" è la data di fattura/incasso; la data effettiva di cassa è la colonna "Data Pagamento"
      const pay = Object.entries(row).find(([, v]) => norm(v) === "data pagamento");
      if (pay) m.dataPag = Number(pay[0]);
      if (m.dataPag !== undefined && m.conIva !== undefined) {
        hr = r;
        Object.assign(col, m);
      }
    });
    if (hr === -1) return;
    // foglio incassi = nome con "incass" oppure intestazione "Data Incasso"/"Cliente"
    const headerTxt = Object.values(sh.grid[hr]).map(norm);
    const isIn = /incass/i.test(sh.name) || headerTxt.includes("data incasso") || headerTxt.includes("cliente");
    found.push(sh.name);

    let section = "";
    sh.grid.forEach((row, r) => {
      if (!row || r <= hr) return;
      const g = (k) => (col[k] === undefined ? undefined : row[col[k]]);
      const first = g("dataFattura");
      const prog0 = g("progetto");
      const heading = typeof first === "string" ? first : first === undefined && typeof prog0 === "string" && num(g("conIva")) === 0 && num(g("escl")) === 0 ? prog0 : null;
      if (heading !== null) {
        if (/previsione/i.test(heading)) section = "previsione";
        else if (/bolletta/i.test(heading)) section = "bolletta";
        return;
      }
      const fornitore = String(g("fornitore") ?? "").trim();
      const descrizione = String(g("descrizione") ?? "").trim();
      if (/^totale/i.test(fornitore) || /^totale/i.test(descrizione)) return;
      const conIva = g("conIva");
      const escl = g("escl");
      if (typeof conIva !== "number" && typeof escl !== "number") return;
      const base = typeof conIva === "number" ? conIva : num(escl) + num(g("iva")) - num(g("rit"));
      const rit = num(g("rit"));
      const stimaCell = String(g("stima") ?? "");
      const tipo = /stim/i.test(stimaCell) ? "Stima" : /real/i.test(stimaCell) ? "Reale" : section ? "Stima" : "Reale";
      const dp = g("dataPag");
      let pay = isSerial(dp) ? serialToIso(dp) : null;
      let excl = null;
      if (!isIn && /^banca$/i.test(fornitore) && /interess/i.test(descrizione)) excl = "Interessi del mutuo: già nel finanziamento";
      else if (!pay && section === "bolletta") pay = nextDec15();
      else if (!pay) excl = /storno/i.test(String(g("mezzo") ?? "")) ? "In attesa di storno: non da pagare" : "Senza data di pagamento";
      all.push({
        id: `s${si}-r${r}`,
        dir: isIn ? "in" : "out",
        progetto: String(prog0 ?? "").trim(),
        tipo,
        fornitore,
        descrizione,
        voce: String(g("voce") ?? ""),
        // uscite: importo con IVA + ritenuta d'acconto (la ritenuta la versiamo noi); incassi: importo con IVA, cioè ciò che arriva sul conto
        importo: Math.round((isIn ? base : base + rit) * 100) / 100,
        ritenuta: rit,
        pay,
        excl,
      });
    });
  });
  if (!found.length) throw new Error("header");
  return { sheets: found, rows: all };
}

// ---------- calcolo della previsione ----------
const NO_PROJECT = "__none";
const projLabel = (p) => (p ? p : "Senza progetto");

// opts: { includeStima (uscite stimate), incassi: "none" | "reali" | "tutti", project: null | nome | NO_PROJECT }
function buildForecast(data, loans, opts) {
  const t0 = data.saldoDate;
  const moves = [];
  let alreadyPaid = 0;
  const loanProject = data.loanProject || {};
  (data.rows || []).forEach((r) => {
    if (r.excl || !r.pay) return;
    if (r.pay <= t0) {
      alreadyPaid++;
      return;
    }
    const isIn = r.dir === "in";
    if (isIn) {
      if (opts.incassi === "none" || (opts.incassi === "reali" && r.tipo === "Stima")) return;
    } else if (r.tipo === "Stima" && !opts.includeStima) return;
    moves.push({
      date: r.pay,
      src: isIn ? "Incasso" : "Fattura",
      tipo: r.tipo,
      label: [r.fornitore, r.descrizione].filter(Boolean).join(" — ") || r.voce,
      amount: isIn ? r.importo : -r.importo,
      progetto: r.progetto || "",
    });
  });
  (loans || [])
    .filter((l) => /beta/i.test(l.nome || "") && Number(l.importo) > 0)
    .forEach((l) => {
      const s = buildSchedule(l, 0);
      const progetto = loanProject[l.id] || "";
      s.rows.forEach((row) => {
        const date = loanPayDate(row.idx, Number(data.loanDay) || 30);
        if (date <= t0) return;
        const out = row.interest + row.capital + row.fee;
        if (out > 0.005) moves.push({ date, src: "Finanziamento", tipo: "Finanz.", label: `${l.nome} — rata${row.fee > 0 ? " + costi" : ""}`, amount: -out, progetto });
        if (row.inflow > 0.005) moves.push({ date, src: "Finanziamento", tipo: "Finanz.", label: `${l.nome} — erogazione`, amount: row.inflow, progetto });
      });
    });
  moves.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.amount - a.amount));
  return { allMoves: moves, alreadyPaid };
}

// saldo (o flusso cumulato di un progetto) dopo ogni movimento
function runBalance(allMoves, startBal, soglia, t0, project) {
  const moves = allMoves
    .filter((m) => project === null || (project === NO_PROJECT ? !m.progetto : m.progetto === project))
    .map((m) => ({ ...m }));
  let bal = startBal;
  const series = [{ t: msOf(t0), bal, date: t0 }];
  let min = { bal, date: t0 };
  let firstBelow = bal < soglia ? { date: t0, bal } : null;
  let firstNeg = bal < 0 ? { date: t0, bal } : null;
  moves.forEach((m, i) => {
    bal += m.amount;
    m.after = bal;
    const next = moves[i + 1];
    if (!next || next.date !== m.date) {
      series.push({ t: msOf(m.date), bal, date: m.date });
      if (bal < min.bal) min = { bal, date: m.date };
      if (!firstBelow && bal < soglia) firstBelow = { date: m.date, bal };
      if (!firstNeg && bal < 0) firstNeg = { date: m.date, bal };
    }
  });
  const endDate = moves.length ? moves[moves.length - 1].date : t0;
  return { moves, series, min, firstBelow, firstNeg, endBal: bal, endDate };
}

const eur2 = (n) =>
  new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: "always" }).format(Number.isFinite(n) ? n : 0);

const defaults = () => ({ saldo: 353463, saldoDate: todayIso(), soglia: 20000, loanDay: 30, rows: [], sheets: [], fileName: "", uploadedAt: "", loanProject: {} });

export function TreasuryPage({ ui }) {
  const { styles, eur } = ui;
  const c = ui.colors;
  const [data, setData] = useState(null);
  const [loans, setLoans] = useState([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveState, setSaveState] = useState("idle");
  const [includeStima, setIncludeStima] = useState(true);
  const [incassi, setIncassi] = useState("reali");
  const [project, setProject] = useState(null); // null = tutti
  const [horizon, setHorizon] = useState(12);
  const [showExcl, setShowExcl] = useState(false);
  const [upErr, setUpErr] = useState("");
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);
  const latest = useRef(null);
  const failedRef = useRef(false);
  const fileRef = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        const v = await kvGet(TREASURY_KEY);
        const d = { ...defaults(), ...(v && typeof v === "object" ? v : {}) };
        latest.current = d;
        setData(d);
      } catch (e) {
        failedRef.current = true;
        setLoadFailed(true);
        setData(defaults());
      }
      try {
        const l = await kvGet(LOANS_KEY);
        setLoans(Array.isArray(l) ? l : []);
      } catch (e) {
        setLoans([]);
      }
    })();
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        if (!failedRef.current && latest.current) kvSet(TREASURY_KEY, latest.current).catch(() => {});
      }
    };
  }, []);

  const persist = (patch) => {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    setData(next);
    if (failedRef.current) {
      setSaveState("blocked");
      return;
    }
    setSaveState("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      timer.current = null;
      try {
        await kvSet(TREASURY_KEY, next);
        setSaveState("saved");
        setTimeout(() => setSaveState("idle"), 1400);
      } catch (e) {
        setSaveState("error");
      }
    }, 700);
  };

  const onFile = async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    setUpErr("");
    setBusy(true);
    try {
      const sheets = await readSheets(await f.arrayBuffer());
      const res = parseAccounting(sheets);
      // il nuovo file sostituisce quello precedente
      persist({ rows: res.rows, sheets: res.sheets, fileName: f.name, uploadedAt: new Date().toISOString() });
      setProject(null);
    } catch (err) {
      setUpErr(
        err && err.message === "header"
          ? "Non trovo le colonne “Data Pagamento” e “Importo con IVA” in nessun foglio. Controlla che la riga di intestazione ci sia ancora."
          : "Non riesco a leggere il file: carica un Excel in formato .xlsx."
      );
    }
    setBusy(false);
  };

  if (!data) {
    return (
      <section style={styles.section} className="section-card no-print">
        <div style={styles.tableEmpty}>Caricamento tesoreria…</div>
      </section>
    );
  }

  const soglia = Number(data.soglia) || 0;
  const saldo = Number(data.saldo) || 0;
  const base = buildForecast({ ...data, soglia }, loans, { includeStima, incassi });
  const filtering = project !== null;
  const fc = runBalance(base.allMoves, filtering ? 0 : saldo, soglia, data.saldoDate, project);
  const betaLoans = loans.filter((l) => /beta/i.test(l.nome || "") && Number(l.importo) > 0);
  const excluded = (data.rows || []).filter((r) => r.excl);
  const projNames = [...new Set([...(data.rows || []).map((r) => r.progetto || ""), ...Object.values(data.loanProject || {})])].filter(Boolean).sort();
  const hasNoProject = (data.rows || []).some((r) => !r.progetto) || base.allMoves.some((m) => !m.progetto);
  const projOptions = [...projNames.map((p) => ({ v: p, label: p })), ...(hasNoProject ? [{ v: NO_PROJECT, label: "Senza progetto" }] : [])];
  const projName = project === null ? "" : project === NO_PROJECT ? "Senza progetto" : project;

  const outSum = (src, tipo) => fc.moves.filter((m) => m.src === src && (!tipo || m.tipo === tipo) && m.amount < 0).reduce((t, m) => t - m.amount, 0);
  const inSum = () => fc.moves.filter((m) => m.amount > 0).reduce((t, m) => t + m.amount, 0);
  const needTop = Math.max(0, soglia - fc.min.bal);

  // riepilogo per progetto (rispetta gli interruttori di scenario, non il filtro)
  const summary = projOptions.map((o) => {
    const ms = base.allMoves.filter((m) => (o.v === NO_PROJECT ? !m.progetto : m.progetto === o.v));
    const o1 = (src, tipo) => ms.filter((m) => m.src === src && (!tipo || m.tipo === tipo) && m.amount < 0).reduce((t, m) => t - m.amount, 0);
    const entrate = ms.filter((m) => m.amount > 0).reduce((t, m) => t + m.amount, 0);
    const net = ms.reduce((t, m) => t + m.amount, 0);
    return { ...o, reali: o1("Fattura", "Reale"), stime: o1("Fattura", "Stima"), rate: o1("Finanziamento"), entrate, net };
  });

  let level = "ok";
  if (fc.firstNeg) level = "red";
  else if (fc.firstBelow) level = "amber";
  const levelColor = level === "red" ? c.red : level === "amber" ? c.amber : c.green;
  const headline =
    level === "red"
      ? `Il conto Beta va in negativo il ${fmtDate(fc.firstNeg.date)}`
      : level === "amber"
      ? `Il conto Beta scende sotto la soglia il ${fmtDate(fc.firstBelow.date)}`
      : "Il conto Beta resta sopra la soglia minima";
  const detail =
    level === "ok"
      ? `Saldo minimo previsto ${eur(fc.min.bal)} il ${fmtDate(fc.min.date)}. Ultimo movimento considerato: ${fmtDate(fc.endDate)}.`
      : `${level === "red" && fc.firstBelow ? `Sotto la soglia di ${eur(soglia)} già dal ${fmtDate(fc.firstBelow.date)}. ` : ""}Saldo previsto il ${fmtDate((level === "red" ? fc.firstNeg : fc.firstBelow).date)}: ${eur((level === "red" ? fc.firstNeg : fc.firstBelow).bal)} (soglia ${eur(soglia)}). Saldo minimo ${eur(fc.min.bal)} il ${fmtDate(fc.min.date)}. Per restare sopra soglia servono almeno ${eur(needTop)}.`;
  const scenarioTxt = `Uscite: reali${includeStima ? " + stime" : ""} e finanziamenti. Incassi futuri: ${incassi === "none" ? "nessuno" : incassi === "reali" ? "solo reali" : "reali + stime"}.`;

  // grafico
  const endChart = horizon === 0 ? fc.endDate : addMonthsIso(data.saldoDate, horizon);
  const endMs = msOf(endChart > data.saldoDate ? endChart : data.saldoDate) + (horizon === 0 ? 7 * DAY : 0);
  const chartData = fc.series.filter((p) => p.t <= endMs);
  const lastBal = [...fc.series].filter((p) => p.t <= endMs).pop();
  if (lastBal && lastBal.t < endMs) chartData.push({ t: endMs, bal: lastBal.bal, date: isoOf(new Date(endMs)) });
  const shownMoves = fc.moves.filter((m) => msOf(m.date) <= endMs);

  // grafico ad area: ogni tratto prende il colore del suo stato (sopra soglia / sotto soglia / negativo)
  const thr = filtering ? 0 : soglia;
  const stateOf = (b) => (b < 0 ? "negV" : b < thr ? "warnV" : "okV");
  const stepData = [];
  const pushPt = (t, v, key) => stepData.push({ t, okV: null, warnV: null, negV: null, [key]: v });
  for (let i = 0; i < chartData.length - 1; i++) {
    const a = chartData[i];
    const b = chartData[i + 1];
    const st = stateOf(a.bal);
    if (i > 0) pushPt(a.t, chartData[i - 1].bal, st); // inizio del salto verticale, nel colore del nuovo stato
    pushPt(a.t, a.bal, st);
    pushPt(b.t, a.bal, st);
  }
  if (stepData.length === 0 && chartData.length) pushPt(chartData[0].t, chartData[0].bal, stateOf(chartData[0].bal));
  const balVals = chartData.map((p) => p.bal);
  const yLo = Math.min(0, ...balVals);
  const yHi = Math.max(thr, ...balVals, 1);
  // asse verticale con valori tondi
  const rough = Math.max(yHi - yLo, 1) / 5;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const yStep = [1, 2, 5, 10].map((m) => m * mag).find((x) => x >= rough) || mag * 10;
  const yDomain = [yLo < 0 ? Math.floor(yLo / yStep) * yStep : 0, Math.ceil(yHi / yStep) * yStep];
  const yTicks = [];
  for (let v = yDomain[0]; v <= yDomain[1] + 1e-6; v += yStep) yTicks.push(v);
  const balanceAt = (t) => {
    let v = fc.series[0].bal;
    fc.series.forEach((p) => { if (p.t <= t) v = p.bal; });
    return v;
  };
  const dFmt = (t) => {
    const d = new Date(t);
    return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCFullYear()).slice(2)}`;
  };

  // ---- scarico Excel: movimenti + riepilogo mensile + impostazioni (rispetta filtro e scenario) ----
  const downloadXlsx = () => {
    const r2 = (n) => Math.round(n * 100) / 100;
    const ser = (iso) => (msOf(iso) - Date.UTC(1899, 11, 30)) / DAY;
    const bold = (v) => ({ v, bold: true });
    const startVal = filtering ? 0 : saldo;
    const balHead = filtering ? "Cumulato progetto" : "Saldo dopo";
    const mov = [
      ["Data", "Progetto", "Origine", "Movimento", "Tipo", "Entrata", "Uscita", balHead].map(bold),
      [{ v: ser(data.saldoDate), date: true }, projName, "", filtering ? "Partenza (t0)" : "Saldo di partenza (t0)", "", "", "", r2(startVal)],
      ...fc.moves.map((m) => [
        { v: ser(m.date), date: true },
        projLabel(m.progetto),
        m.src,
        m.label,
        m.tipo,
        m.amount > 0 ? r2(m.amount) : "",
        m.amount < 0 ? r2(-m.amount) : "",
        r2(m.after),
      ]),
    ];
    const byMonth = {};
    fc.moves.forEach((m) => {
      const k = m.date.slice(0, 7);
      byMonth[k] = byMonth[k] || { e: 0, u: 0 };
      if (m.amount > 0) byMonth[k].e += m.amount;
      else byMonth[k].u -= m.amount;
    });
    let run = startVal;
    const monthly = [
      ["Mese", "Entrate", "Uscite", "Netto", filtering ? "Cumulato fine mese" : "Saldo fine mese"].map(bold),
      ...Object.keys(byMonth)
        .sort()
        .map((k) => {
          const { e, u } = byMonth[k];
          run += e - u;
          return [`${k.slice(5)}/${k.slice(0, 4)}`, r2(e), r2(u), r2(e - u), r2(run)];
        }),
    ];
    const info = [
      ["Impostazione", "Valore"].map(bold),
      ["Vista", filtering ? `Progetto: ${projName}` : "Conto Beta (tutti i progetti)"],
      ["Saldo di partenza (t0)", r2(saldo)],
      ["Giorno t0", { v: ser(data.saldoDate), date: true }],
      ["Soglia minima", r2(soglia)],
      ["Scenario", scenarioTxt],
      ["File contabilità", data.fileName || "—"],
      ["Generato il", new Date().toLocaleString("it-IT")],
    ];
    const blob = buildXlsxMulti([
      { name: "Movimenti", rows: mov, widths: [12, 22, 14, 52, 9, 14, 14, 18] },
      { name: "Riepilogo mensile", rows: monthly, widths: [12, 16, 16, 16, 20] },
      { name: "Impostazioni", rows: info, widths: [26, 60] },
    ]);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cash-flow-${filtering ? projName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : "conto-beta"}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const th = { padding: "10px 10px", textAlign: "right", fontWeight: 500, whiteSpace: "nowrap", position: "sticky", top: 0, background: c.surface };
  const td = { padding: "9px 10px", borderTop: `1px solid ${c.border}`, whiteSpace: "nowrap", fontSize: 13, color: c.ink, textAlign: "right", fontFamily: "'JetBrains Mono', monospace" };
  const tdText = { ...td, textAlign: "left", fontFamily: "'Inter', sans-serif", whiteSpace: "normal" };
  const saveLabel =
    saveState === "saving" ? "Salvataggio…" : saveState === "saved" ? "Salvato ✓" : saveState === "error" ? "Errore nel salvataggio" : saveState === "blocked" ? "Archivio non raggiungibile: ricarica la pagina" : "";
  const miniLabel = { fontSize: 12.5, color: c.inkSoft };
  const nOut = (data.rows || []).filter((r) => r.dir !== "in").length;
  const nIn = (data.rows || []).filter((r) => r.dir === "in").length;

  return (
    <>
      <section style={styles.section} className="section-card no-print">
        <div style={styles.sectionHeadRow}>
          <div style={styles.eyebrowSmall}>Tesoreria · Conto Beta</div>
          <span style={{ fontSize: 12.5, color: saveState === "error" || saveState === "blocked" ? c.red : c.inkSoft }}>{saveLabel}</span>
        </div>
        {loadFailed && (
          <div style={{ fontSize: 12.5, color: c.red, marginBottom: 12 }}>
            Archivio non raggiungibile in questo momento: per non sovrascrivere i dati esistenti non salvo nulla. Ricarica la pagina.
          </div>
        )}

        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-end" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={styles.chipLabel}>Saldo conto Beta (€)</span>
            <ui.NumberField style={{ ...styles.input, width: 150, textAlign: "right" }} value={data.saldo} onChange={(v) => persist({ saldo: v === "" ? 0 : v })} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={styles.chipLabel}>Saldo riferito al giorno (t0)</span>
            <input type="date" style={{ ...styles.input, width: 160 }} value={data.saldoDate} onChange={(e) => e.target.value && persist({ saldoDate: e.target.value })} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={styles.chipLabel}>Soglia minima (€)</span>
            <ui.NumberField style={{ ...styles.input, width: 130, textAlign: "right" }} value={data.soglia} onChange={(v) => persist({ soglia: v === "" ? 0 : v })} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={styles.chipLabel}>Giorno addebito rate</span>
            <input
              type="text"
              inputMode="numeric"
              style={{ ...styles.input, width: 90, textAlign: "right" }}
              value={data.loanDay}
              onChange={(e) => {
                const v = e.target.value.replace(/[^0-9]/g, "");
                persist({ loanDay: v === "" ? "" : Math.min(31, Number(v)) });
              }}
            />
          </label>
        </div>
        <div style={{ ...miniLabel, marginTop: 10, lineHeight: 1.5 }}>
          Conta solo ciò che è <b>dopo</b> il giorno t0: i pagamenti fino a quella data si considerano già nel saldo. Se il saldo reale non coincide, correggi saldo e data qui. A febbraio la rata si addebita l’ultimo giorno lavorativo.
        </div>

        {betaLoans.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div style={{ ...styles.chipLabel, marginBottom: 8 }}>Finanziamenti Beta · progetto di riferimento</div>
            {betaLoans.map((l) => (
              <div key={l.id} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
                <span style={{ fontSize: 13, color: c.ink, minWidth: 180 }}>{l.nome}</span>
                <select
                  style={{ ...styles.select, width: 280 }}
                  value={(data.loanProject || {})[l.id] || ""}
                  onChange={(e) => persist({ loanProject: { ...(data.loanProject || {}), [l.id]: e.target.value } })}
                >
                  <option value="">— non assegnato —</option>
                  {projNames.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
            ))}
            <div style={{ ...miniLabel, fontSize: 12, color: c.inkFaint }}>Serve per attribuire le rate al progetto quando filtri il cash flow. I nomi dei progetti arrivano dall’Excel.</div>
          </div>
        )}
      </section>

      <section style={styles.section} className="section-card no-print">
        <div style={styles.sectionHeadRow}>
          <div style={styles.eyebrowSmall}>Contabilità (Excel)</div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input ref={fileRef} type="file" accept=".xlsx" style={{ display: "none" }} onChange={onFile} />
            <button style={styles.saveNowBtn} onClick={() => fileRef.current && fileRef.current.click()} disabled={busy}>
              {busy ? "Lettura…" : data.fileName ? "⬆ Carica nuovo file (sostituisce)" : "⬆ Carica Excel contabilità"}
            </button>
          </div>
        </div>
        {upErr && <div style={{ fontSize: 12.5, color: c.red, marginBottom: 10 }}>{upErr}</div>}
        {data.fileName ? (
          <div style={{ fontSize: 13, color: c.ink, lineHeight: 1.6 }}>
            <b>{data.fileName}</b> · caricato il {data.uploadedAt ? new Date(data.uploadedAt).toLocaleString("it-IT") : "—"}
            <div style={miniLabel}>
              Fogli letti: {(data.sheets || []).join(", ") || "—"} · {nOut} uscite · {nIn} incassi · {base.alreadyPaid} già pagati (nel saldo) · {excluded.length} escluse
            </div>
          </div>
        ) : (
          <div style={styles.tableEmpty}>Nessun file caricato. Carica l’Excel della contabilità (fogli Uscite e Incassi): ogni nuovo caricamento sostituisce il precedente.</div>
        )}
        <div style={{ ...miniLabel, marginTop: 10, lineHeight: 1.5 }}>
          Regole: uscite = “Importo con IVA” + ritenuta d’acconto; incassi = “Importo con IVA”. La data che conta è “Data Pagamento” e solo se futura. Il progetto viene dalla colonna “Progetto”. “Reale/Stima” della riga decide il tipo. Le righe senza data sono escluse.
        </div>
        {excluded.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <button style={{ ...styles.saveNowBtn, background: "transparent", color: c.inkSoft, border: `1px solid ${c.border}` }} onClick={() => setShowExcl((v) => !v)}>
              {showExcl ? "▲ Nascondi righe escluse" : `▼ Mostra righe escluse (${excluded.length})`}
            </button>
            {showExcl && (
              <div style={{ marginTop: 12, overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 560 }}>
                  <thead>
                    <tr style={{ ...styles.tableHeaderRow, display: "table-row" }}>
                      <th style={{ ...th, textAlign: "left", position: "static" }}>Progetto</th>
                      <th style={{ ...th, textAlign: "left", position: "static" }}>Riga</th>
                      <th style={{ ...th, textAlign: "right", position: "static" }}>Importo</th>
                      <th style={{ ...th, textAlign: "left", position: "static" }}>Motivo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {excluded.map((r) => (
                      <tr key={r.id}>
                        <td style={{ ...tdText, color: c.inkSoft }}>{projLabel(r.progetto)}</td>
                        <td style={tdText}>{[r.fornitore, r.descrizione].filter(Boolean).join(" — ")}</td>
                        <td style={td}>{eur2(r.importo)}</td>
                        <td style={{ ...tdText, color: c.inkSoft }}>{r.excl}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </section>

      <section style={styles.section} className="section-card no-print">
        <div style={styles.sectionHeadRow}>
          <div style={styles.eyebrowSmall}>Previsione del saldo</div>
          <button style={styles.saveNowBtn} onClick={downloadXlsx}>
            ⬇ Scarica Excel
          </button>
        </div>

        <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
          <label style={{ ...miniLabel, display: "flex", alignItems: "center", gap: 6 }}>
            Progetto:
            <select style={styles.select} value={project === null ? "" : project} onChange={(e) => setProject(e.target.value === "" ? null : e.target.value)}>
              <option value="">Tutti (saldo del conto)</option>
              {projOptions.map((o) => (
                <option key={o.v} value={o.v}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label style={{ ...miniLabel, display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={includeStima} onChange={(e) => setIncludeStima(e.target.checked)} />
            Includi uscite stimate
          </label>
          <label style={{ ...miniLabel, display: "flex", alignItems: "center", gap: 6 }}>
            Incassi futuri:
            <select style={styles.select} value={incassi} onChange={(e) => setIncassi(e.target.value)}>
              <option value="none">Nessuno</option>
              <option value="reali">Solo reali</option>
              <option value="tutti">Reali + stime</option>
            </select>
          </label>
          <label style={{ ...miniLabel, display: "flex", alignItems: "center", gap: 6 }}>
            Grafico:
            <select style={styles.select} value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>
              <option value={3}>3 mesi</option>
              <option value={6}>6 mesi</option>
              <option value={12}>12 mesi</option>
              <option value={0}>Tutto</option>
            </select>
          </label>
        </div>

        {!filtering ? (
          <div style={{ borderLeft: `4px solid ${levelColor}`, background: c.surfaceAlt, borderRadius: 8, padding: "12px 16px", marginBottom: 18 }}>
            <div style={{ fontWeight: 700, color: levelColor, fontSize: 15 }}>
              {level === "ok" ? "●" : level === "amber" ? "▲" : "■"} {headline}
            </div>
            <div style={{ fontSize: 13, color: c.inkSoft, marginTop: 4, lineHeight: 1.5 }}>{detail}</div>
            <div style={{ fontSize: 12, color: c.inkFaint, marginTop: 6 }}>{scenarioTxt}</div>
          </div>
        ) : (
          <div style={{ borderLeft: `4px solid ${c.teal}`, background: c.surfaceAlt, borderRadius: 8, padding: "12px 16px", marginBottom: 18 }}>
            <div style={{ fontWeight: 700, color: c.ink, fontSize: 15 }}>Progetto: {projName}</div>
            <div style={{ fontSize: 13, color: c.inkSoft, marginTop: 4, lineHeight: 1.5 }}>
              Flusso di cassa del solo progetto, cumulato dal {fmtDate(data.saldoDate)} (parte da zero): non è il saldo del conto, quindi qui non c’è la soglia.
            </div>
            <div style={{ fontSize: 12, color: c.inkFaint, marginTop: 6 }}>{scenarioTxt}</div>
          </div>
        )}

        <div style={styles.chipsRow}>
          {!filtering && (
            <div style={styles.chip}>
              <span style={styles.chipLabel}>Saldo t0 · {fmtDate(data.saldoDate)}</span>
              <span style={styles.chipValue}>{eur(saldo)}</span>
            </div>
          )}
          <div style={styles.chip}>
            <span style={styles.chipLabel}>Fatture reali future</span>
            <span style={styles.chipValue}>{eur(outSum("Fattura", "Reale"))}</span>
          </div>
          <div style={styles.chip}>
            <span style={styles.chipLabel}>Uscite stimate</span>
            <span style={styles.chipValue}>{includeStima ? eur(outSum("Fattura", "Stima")) : "escluse"}</span>
          </div>
          <div style={styles.chip}>
            <span style={styles.chipLabel}>Rate finanziamenti{betaLoans.length ? "" : " (nessun “Beta”)"}</span>
            <span style={styles.chipValue}>{eur(outSum("Finanziamento"))}</span>
          </div>
          <div style={styles.chip}>
            <span style={styles.chipLabel}>Incassi futuri</span>
            <span style={styles.chipValue}>{eur(inSum())}</span>
          </div>
          <div style={{ ...styles.chip, ...styles.chipTotal }}>
            <span style={styles.chipLabel}>{filtering ? "Flusso netto del progetto" : "Saldo minimo previsto"}</span>
            <span style={styles.chipValue}>{filtering ? eur(fc.endBal) : `${eur(fc.min.bal)} · ${fmtDate(fc.min.date)}`}</span>
          </div>
        </div>

        <div style={{ height: 300, marginTop: 22 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={stepData} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
              <defs>
                {[["gOk", c.teal], ["gWarn", c.amber], ["gNeg", c.red]].map(([id, col]) => (
                  <linearGradient key={id} id={id} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={col} stopOpacity={0.55} />
                    <stop offset="100%" stopColor={col} stopOpacity={0.04} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid stroke={c.border} vertical={false} />
              <XAxis dataKey="t" type="number" scale="time" domain={[msOf(data.saldoDate), endMs]} tick={{ fill: c.inkSoft, fontSize: 11 }} stroke={c.border} tickFormatter={dFmt} tickCount={7} />
              <YAxis type="number" domain={yDomain} ticks={yTicks} allowDataOverflow tick={{ fill: c.inkSoft, fontSize: 11 }} stroke={c.border} tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
              <Tooltip
                cursor={{ stroke: c.inkFaint, strokeDasharray: "3 3" }}
                content={({ active, label }) => {
                  if (!active || label == null) return null;
                  const v = balanceAt(label);
                  return (
                    <div style={{ background: c.surfaceAlt, border: `1px solid ${c.border}`, borderRadius: 8, color: c.ink, fontSize: 12, padding: "8px 10px" }}>
                      <div style={{ color: c.inkSoft }}>{dFmt(label)}</div>
                      <div style={{ fontWeight: 700 }}>
                        {filtering ? "Cumulato" : "Saldo"}: {eur(v)}
                      </div>
                    </div>
                  );
                }}
              />
              {!filtering && <ReferenceLine y={soglia} stroke={c.amber} strokeDasharray="5 4" label={{ value: "soglia", fill: c.amber, fontSize: 11, position: "insideTopRight" }} />}
              <ReferenceLine y={0} stroke={c.red} strokeDasharray="2 3" />
              <Area type="linear" dataKey="okV" baseValue={yDomain[0]} stroke="none" fill="url(#gOk)" isAnimationActive={false} connectNulls={false} />
              <Area type="linear" dataKey="warnV" baseValue={yDomain[0]} stroke="none" fill="url(#gWarn)" isAnimationActive={false} connectNulls={false} />
              <Area type="linear" dataKey="negV" baseValue={yDomain[0]} stroke="none" fill="url(#gNeg)" isAnimationActive={false} connectNulls={false} />
              <Line type="linear" dataKey="okV" stroke={c.teal} strokeWidth={2.2} dot={false} isAnimationActive={false} connectNulls={false} />
              <Line type="linear" dataKey="warnV" stroke={c.amber} strokeWidth={2.2} dot={false} isAnimationActive={false} connectNulls={false} />
              <Line type="linear" dataKey="negV" stroke={c.red} strokeWidth={2.2} dot={false} isAnimationActive={false} connectNulls={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {!filtering && (
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 12, color: c.inkSoft, marginTop: 8, paddingLeft: 8 }}>
            {[["Sopra la soglia", c.teal], ["Sotto la soglia", c.amber], ["Negativo", c.red]].map(([t, col]) => (
              <span key={t} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: col, display: "inline-block" }} />
                {t}
              </span>
            ))}
          </div>
        )}

        {summary.length > 0 && (
          <div style={{ marginTop: 22, overflowX: "auto" }}>
            <div style={{ ...styles.chipLabel, marginBottom: 8 }}>Per progetto · movimenti futuri (clicca per filtrare)</div>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 640 }}>
              <thead>
                <tr style={{ ...styles.tableHeaderRow, display: "table-row" }}>
                  {["Progetto", "Uscite reali", "Uscite stimate", "Rate finanz.", "Entrate", "Netto"].map((h, i) => (
                    <th key={h} style={{ ...th, position: "static", textAlign: i === 0 ? "left" : "right" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {summary.map((r) => (
                  <tr key={r.v} onClick={() => setProject(project === r.v ? null : r.v)} style={{ cursor: "pointer", background: project === r.v ? c.surfaceAlt : undefined }}>
                    <td style={{ ...tdText, fontWeight: project === r.v ? 700 : 400 }}>{r.label}</td>
                    <td style={td}>{eur(r.reali)}</td>
                    <td style={td}>{eur(r.stime)}</td>
                    <td style={td}>{eur(r.rate)}</td>
                    <td style={{ ...td, color: r.entrate > 0 ? c.green : c.inkFaint }}>{eur(r.entrate)}</td>
                    <td style={{ ...td, fontWeight: 700, color: r.net < 0 ? c.red : c.green }}>{eur(r.net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ marginTop: 22, overflowX: "auto", maxHeight: 480, overflowY: "auto", border: `1px solid ${c.border}`, borderRadius: 10 }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 820 }}>
            <thead>
              <tr style={{ ...styles.tableHeaderRow, display: "table-row" }}>
                <th style={{ ...th, textAlign: "left" }}>Data</th>
                <th style={{ ...th, textAlign: "left" }}>Progetto</th>
                <th style={{ ...th, textAlign: "left" }}>Movimento</th>
                <th style={{ ...th, textAlign: "left" }}>Tipo</th>
                <th style={th}>Importo</th>
                <th style={th}>{filtering ? "Cumulato" : "Saldo dopo"}</th>
              </tr>
            </thead>
            <tbody>
              {shownMoves.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ ...tdText, color: c.inkSoft }}>
                    Nessun movimento futuro per questa selezione. Carica l’Excel o aggiungi un finanziamento con “Beta” nel nome.
                  </td>
                </tr>
              )}
              {shownMoves.map((m, i) => (
                <tr key={i}>
                  <td style={{ ...td, textAlign: "left" }}>{fmtDate(m.date)}</td>
                  <td style={{ ...tdText, color: c.inkSoft }}>{projLabel(m.progetto)}</td>
                  <td style={tdText}>{m.label}</td>
                  <td style={{ ...tdText, color: m.tipo === "Stima" ? c.amber : c.inkSoft }}>{m.tipo}</td>
                  <td style={{ ...td, color: m.amount > 0 ? c.green : c.ink }}>{(m.amount > 0 ? "+" : "−") + eur2(Math.abs(m.amount))}</td>
                  <td style={{ ...td, fontWeight: 700, color: m.after < 0 ? c.red : !filtering && m.after < soglia ? c.amber : c.ink }}>{eur2(m.after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: 12, color: c.inkFaint, marginTop: 12, lineHeight: 1.5 }}>
          Il saldo mostrato è dopo tutti i movimenti della stessa data. Le rate arrivano dalla pagina Finanziamenti (solo quelli con “Beta” nel nome). Il file Excel scaricato rispecchia filtro e scenario scelti qui sopra.
        </div>
      </section>
    </>
  );
}
