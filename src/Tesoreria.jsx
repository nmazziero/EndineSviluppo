import React, { useState, useEffect, useRef } from "react";
import { ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { kvGet, kvSet } from "./supabaseClient";
import { buildSchedule } from "./Finanziamenti";

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

// trasforma il foglio "Contabilità" nelle righe usate dalla previsione
function parseAccounting(sheets) {
  const HEAD = {
    dataFattura: "data fattura",
    voce: "voce",
    fornitore: "fornitore",
    descrizione: "descrizione",
    escl: "importo iva escl",
    iva: "iva",
    rit: "rit acc",
    conIva: "importo con iva",
    dataPag: "data pagamento",
    mezzo: "mezzo di pagamento",
    stima: "reale stima",
  };
  for (const sh of sheets) {
    let hr = -1;
    const col = {};
    sh.grid.forEach((row, r) => {
      if (!row || hr !== -1) return;
      const m = {};
      Object.entries(row).forEach(([ci, v]) => {
        const k = Object.keys(HEAD).find((key) => HEAD[key] === norm(v));
        if (k) m[k] = Number(ci);
      });
      if (m.dataPag !== undefined && m.conIva !== undefined) {
        hr = r;
        Object.assign(col, m);
      }
    });
    if (hr === -1) continue;

    const rows = [];
    let section = "";
    sh.grid.forEach((row, r) => {
      if (!row || r <= hr) return;
      const g = (k) => (col[k] === undefined ? undefined : row[col[k]]);
      const first = g("dataFattura");
      if (typeof first === "string") {
        if (/previsione/i.test(first)) section = "previsione";
        else if (/bolletta/i.test(first)) section = "bolletta";
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
      if (/^banca$/i.test(fornitore) && /interess/i.test(descrizione)) excl = "Interessi del mutuo: già nel finanziamento";
      else if (!pay && section === "bolletta") pay = nextDec15();
      else if (!pay) excl = /storno/i.test(String(g("mezzo") ?? "")) ? "In attesa di storno: non da pagare" : "Senza data di pagamento";
      rows.push({
        id: `r${r}`,
        tipo,
        fornitore,
        descrizione,
        voce: String(g("voce") ?? ""),
        // importo che esce dal conto: importo con IVA + ritenuta d'acconto
        importo: Math.round((base + rit) * 100) / 100,
        ritenuta: rit,
        pay,
        excl,
      });
    });
    return { sheet: sh.name, rows };
  }
  throw new Error("header");
}

// ---------- calcolo della previsione ----------
function buildForecast(data, loans, includeStima) {
  const t0 = data.saldoDate;
  const moves = [];
  let alreadyPaid = 0;
  (data.rows || []).forEach((r) => {
    if (r.excl || !r.pay) return;
    if (r.pay <= t0) {
      alreadyPaid++;
      return;
    }
    if (r.tipo === "Stima" && !includeStima) return;
    moves.push({
      date: r.pay,
      src: "Fattura",
      tipo: r.tipo,
      label: [r.fornitore, r.descrizione].filter(Boolean).join(" — ") || r.voce,
      amount: -r.importo,
    });
  });
  (loans || [])
    .filter((l) => /beta/i.test(l.nome || "") && Number(l.importo) > 0)
    .forEach((l) => {
      const s = buildSchedule(l, 0);
      s.rows.forEach((row) => {
        const date = loanPayDate(row.idx, Number(data.loanDay) || 30);
        if (date <= t0) return;
        const out = row.interest + row.capital + row.fee;
        if (out > 0.005) moves.push({ date, src: "Finanziamento", tipo: "Finanz.", label: `${l.nome} — rata${row.fee > 0 ? " + costi" : ""}`, amount: -out });
        if (row.inflow > 0.005) moves.push({ date, src: "Finanziamento", tipo: "Finanz.", label: `${l.nome} — erogazione`, amount: row.inflow });
      });
    });
  moves.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.amount - a.amount));

  let bal = Number(data.saldo) || 0;
  const series = [{ t: msOf(t0), bal, date: t0 }];
  let min = { bal, date: t0 };
  let firstBelow = bal < data.soglia ? { date: t0, bal } : null;
  let firstNeg = bal < 0 ? { date: t0, bal } : null;
  moves.forEach((m, i) => {
    bal += m.amount;
    m.after = bal;
    const next = moves[i + 1];
    if (!next || next.date !== m.date) {
      series.push({ t: msOf(m.date), bal, date: m.date });
      if (bal < min.bal) min = { bal, date: m.date };
      if (!firstBelow && bal < data.soglia) firstBelow = { date: m.date, bal };
      if (!firstNeg && bal < 0) firstNeg = { date: m.date, bal };
    }
  });
  const endDate = moves.length ? moves[moves.length - 1].date : t0;
  return { moves, series, min, firstBelow, firstNeg, endBal: bal, endDate, alreadyPaid };
}

const eur2 = (n) =>
  new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: "always" }).format(Number.isFinite(n) ? n : 0);

const defaults = () => ({ saldo: 353463, saldoDate: todayIso(), soglia: 20000, loanDay: 30, rows: [], fileName: "", uploadedAt: "" });

export function TreasuryPage({ ui }) {
  const { styles, eur } = ui;
  const c = ui.colors;
  const [data, setData] = useState(null);
  const [loans, setLoans] = useState([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveState, setSaveState] = useState("idle");
  const [includeStima, setIncludeStima] = useState(true);
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
      persist({ rows: res.rows, fileName: f.name, uploadedAt: new Date().toISOString() });
    } catch (err) {
      setUpErr(
        err && err.message === "header"
          ? "Non trovo le colonne “Data Pagamento” e “Importo con IVA” nel file. Controlla che la riga di intestazione ci sia ancora."
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
  const fc = buildForecast({ ...data, soglia }, loans, includeStima);
  const betaLoans = loans.filter((l) => /beta/i.test(l.nome || "") && Number(l.importo) > 0);
  const excluded = (data.rows || []).filter((r) => r.excl);

  const sum = (src, tipo) => fc.moves.filter((m) => m.src === src && (!tipo || m.tipo === tipo) && m.amount < 0).reduce((t, m) => t - m.amount, 0);
  const needTop = Math.max(0, soglia - fc.min.bal);

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

  // grafico
  const endChart = horizon === 0 ? fc.endDate : addMonthsIso(data.saldoDate, horizon);
  const endMs = msOf(endChart > data.saldoDate ? endChart : data.saldoDate) + (horizon === 0 ? 7 * DAY : 0);
  const chartData = fc.series.filter((p) => p.t <= endMs);
  const lastBal = [...fc.series].filter((p) => p.t <= endMs).pop();
  if (lastBal && lastBal.t < endMs) chartData.push({ t: endMs, bal: lastBal.bal, date: isoOf(new Date(endMs)) });
  const shownMoves = fc.moves.filter((m) => msOf(m.date) <= endMs);
  const dFmt = (t) => {
    const d = new Date(t);
    return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCFullYear()).slice(2)}`;
  };

  const th = { padding: "10px 10px", textAlign: "right", fontWeight: 500, whiteSpace: "nowrap", position: "sticky", top: 0, background: c.surface };
  const td = { padding: "9px 10px", borderTop: `1px solid ${c.border}`, whiteSpace: "nowrap", fontSize: 13, color: c.ink, textAlign: "right", fontFamily: "'JetBrains Mono', monospace" };
  const saveLabel =
    saveState === "saving" ? "Salvataggio…" : saveState === "saved" ? "Salvato ✓" : saveState === "error" ? "Errore nel salvataggio" : saveState === "blocked" ? "Archivio non raggiungibile: ricarica la pagina" : "";
  const miniLabel = { fontSize: 12.5, color: c.inkSoft };

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
              {data.rows.length} righe lette · {fc.alreadyPaid} già pagate (nel saldo) · {fc.moves.filter((m) => m.src === "Fattura").length} future considerate · {excluded.length} escluse
            </div>
          </div>
        ) : (
          <div style={styles.tableEmpty}>Nessun file caricato. Carica l’Excel della contabilità: ogni nuovo caricamento sostituisce il precedente.</div>
        )}
        <div style={{ ...miniLabel, marginTop: 10, lineHeight: 1.5 }}>
          Regole: importo = “Importo con IVA” + ritenuta d’acconto; contano solo le righe con data di pagamento futura. Sotto “Previsione di spese future” e “Pagamento in bolletta” (data 15 dicembre) le righe sono stime. Le righe senza data sono escluse. Il campo “Reale/Stima” della riga, se compilato, ha la precedenza.
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
                      <th style={{ ...th, textAlign: "left", position: "static" }}>Riga</th>
                      <th style={{ ...th, textAlign: "right", position: "static" }}>Importo</th>
                      <th style={{ ...th, textAlign: "left", position: "static" }}>Motivo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {excluded.map((r) => (
                      <tr key={r.id}>
                        <td style={{ ...td, textAlign: "left", fontFamily: "'Inter', sans-serif" }}>{[r.fornitore, r.descrizione].filter(Boolean).join(" — ")}</td>
                        <td style={td}>{eur2(r.importo)}</td>
                        <td style={{ ...td, textAlign: "left", fontFamily: "'Inter', sans-serif", color: c.inkSoft, whiteSpace: "normal" }}>{r.excl}</td>
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
          <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
            <label style={{ ...miniLabel, display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={includeStima} onChange={(e) => setIncludeStima(e.target.checked)} />
              Includi le stime
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
        </div>

        <div style={{ borderLeft: `4px solid ${levelColor}`, background: c.surfaceAlt, borderRadius: 8, padding: "12px 16px", marginBottom: 18 }}>
          <div style={{ fontWeight: 700, color: levelColor, fontSize: 15 }}>
            {level === "ok" ? "●" : level === "amber" ? "▲" : "■"} {headline}
          </div>
          <div style={{ fontSize: 13, color: c.inkSoft, marginTop: 4, lineHeight: 1.5 }}>{detail}</div>
          <div style={{ fontSize: 12, color: c.inkFaint, marginTop: 6 }}>
            {includeStima ? "Scenario: reali + stime, senza nuovi incassi." : "Scenario: solo uscite reali e finanziamenti, senza nuovi incassi."}
          </div>
        </div>

        <div style={styles.chipsRow}>
          <div style={styles.chip}>
            <span style={styles.chipLabel}>Saldo t0 · {fmtDate(data.saldoDate)}</span>
            <span style={styles.chipValue}>{eur(Number(data.saldo) || 0)}</span>
          </div>
          <div style={styles.chip}>
            <span style={styles.chipLabel}>Fatture reali future</span>
            <span style={styles.chipValue}>{eur(sum("Fattura", "Reale"))}</span>
          </div>
          <div style={styles.chip}>
            <span style={styles.chipLabel}>Stime future</span>
            <span style={styles.chipValue}>{includeStima ? eur(sum("Fattura", "Stima")) : "escluse"}</span>
          </div>
          <div style={styles.chip}>
            <span style={styles.chipLabel}>Rate finanziamenti{betaLoans.length ? "" : " (nessun “Beta”)"}</span>
            <span style={styles.chipValue}>{eur(sum("Finanziamento"))}</span>
          </div>
          <div style={{ ...styles.chip, ...styles.chipTotal }}>
            <span style={styles.chipLabel}>Saldo minimo previsto</span>
            <span style={styles.chipValue}>{`${eur(fc.min.bal)} · ${fmtDate(fc.min.date)}`}</span>
          </div>
        </div>

        <div style={{ height: 300, marginTop: 22 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
              <CartesianGrid stroke={c.border} vertical={false} />
              <XAxis dataKey="t" type="number" scale="time" domain={[msOf(data.saldoDate), endMs]} tick={{ fill: c.inkSoft, fontSize: 11 }} stroke={c.border} tickFormatter={dFmt} tickCount={7} />
              <YAxis tick={{ fill: c.inkSoft, fontSize: 11 }} stroke={c.border} tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
              <Tooltip
                contentStyle={{ background: c.surfaceAlt, border: `1px solid ${c.border}`, borderRadius: 8, color: c.ink, fontSize: 12 }}
                labelStyle={{ color: c.inkSoft }}
                labelFormatter={(t) => dFmt(t)}
                formatter={(v) => [eur(v), "Saldo"]}
              />
              <ReferenceLine y={soglia} stroke={c.amber} strokeDasharray="5 4" label={{ value: "soglia", fill: c.amber, fontSize: 11, position: "insideTopRight" }} />
              <ReferenceLine y={0} stroke={c.red} strokeDasharray="2 3" />
              <Line type="stepAfter" dataKey="bal" name="Saldo" stroke={c.teal} strokeWidth={2.2} dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        <div style={{ marginTop: 22, overflowX: "auto", maxHeight: 480, overflowY: "auto", border: `1px solid ${c.border}`, borderRadius: 10 }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 760 }}>
            <thead>
              <tr style={{ ...styles.tableHeaderRow, display: "table-row" }}>
                <th style={{ ...th, textAlign: "left" }}>Data</th>
                <th style={{ ...th, textAlign: "left" }}>Movimento</th>
                <th style={{ ...th, textAlign: "left" }}>Tipo</th>
                <th style={th}>Importo</th>
                <th style={th}>Saldo dopo</th>
              </tr>
            </thead>
            <tbody>
              {shownMoves.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ ...td, textAlign: "left", fontFamily: "'Inter', sans-serif", color: c.inkSoft }}>
                    Nessun movimento futuro. Carica l’Excel o aggiungi un finanziamento con “Beta” nel nome.
                  </td>
                </tr>
              )}
              {shownMoves.map((m, i) => (
                <tr key={i}>
                  <td style={{ ...td, textAlign: "left" }}>{fmtDate(m.date)}</td>
                  <td style={{ ...td, textAlign: "left", fontFamily: "'Inter', sans-serif", whiteSpace: "normal" }}>{m.label}</td>
                  <td style={{ ...td, textAlign: "left", fontFamily: "'Inter', sans-serif", color: m.tipo === "Stima" ? c.amber : c.inkSoft }}>{m.tipo}</td>
                  <td style={{ ...td, color: m.amount > 0 ? c.green : c.ink }}>{(m.amount > 0 ? "+" : "−") + eur2(Math.abs(m.amount))}</td>
                  <td style={{ ...td, fontWeight: 700, color: m.after < 0 ? c.red : m.after < soglia ? c.amber : c.ink }}>{eur2(m.after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: 12, color: c.inkFaint, marginTop: 12, lineHeight: 1.5 }}>
          Il saldo mostrato è dopo tutti i movimenti della stessa data. Non sono previsti incassi: le vendite o altre entrate non ancora nel file non vengono contate. Le rate arrivano dalla pagina Finanziamenti (solo quelli con “Beta” nel nome).
        </div>
      </section>
    </>
  );
}
