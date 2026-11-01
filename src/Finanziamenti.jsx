import React, { useState, useEffect, useRef } from "react";
import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { kvGet, kvSet } from "./supabaseClient";

// ---------------------------------------------------------------
// FINANZIAMENTI — elenco dei prestiti, piano di ammortamento e
// riepilogo del flusso di cassa. Salvato a parte (non tocca i progetti).
// ---------------------------------------------------------------

const LOANS_KEY = "gruppo-endine:loans";

const TIPI_AMM = [
  { v: "francese", label: "Rata costante (francese)" },
  { v: "italiano", label: "Quota capitale costante (italiano)" },
  { v: "bullet", label: "Capitale a scadenza (bullet)" },
];

const C_INT = "#d95926"; // interessi
const C_CAP = "#3987e5"; // capitale
const C_FEE = "#c98500"; // costi di ingresso
const C_DEBT = "#199e70"; // debito residuo

const nowYm = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const toIdx = (s) => {
  const [y, m] = (s || nowYm()).split("-").map(Number);
  return y * 12 + (m - 1);
};
const kfmt = (v) => (Math.abs(v) >= 10000 ? `${Math.round(v / 1000)}k` : `${(v / 1000).toFixed(1).replace(".", ",")}k`);
const idxLabel = (i) => `${String((i % 12) + 1).padStart(2, "0")}/${Math.floor(i / 12)}`;
const idxYear = (i) => Math.floor(i / 12);

const newLoan = () => ({
  id: Math.random().toString(36).slice(2, 10),
  nome: "",
  ente: "",
  importo: 0,
  tipoTasso: "fisso",
  tasso: 0,
  costoIngresso: 0,
  costoTipo: "eur",
  inizio: nowYm(),
  preMesi: 0,
  ammMesi: 60,
  ammTipo: "francese",
});

// ---------- esportazione in Excel (.xlsx) senza librerie esterne ----------
const CRC_TABLE = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
// zip "senza compressione": basta per un file xlsx
function zipStore(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const u16 = (v) => [v & 255, (v >>> 8) & 255];
  const u32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
  files.forEach((f) => {
    const name = enc.encode(f.name);
    const data = enc.encode(f.content);
    const crc = crc32(data);
    const local = [0x50, 0x4b, 3, 4, ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)];
    parts.push(new Uint8Array(local), name, data);
    central.push(new Uint8Array([0x50, 0x4b, 1, 2, ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), name);
    offset += local.length + name.length + data.length;
  });
  const centralSize = central.reduce((t, p) => t + p.length, 0);
  const end = new Uint8Array([0x50, 0x4b, 5, 6, ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(centralSize), ...u32(offset), ...u16(0)]);
  return new Blob([...parts, ...central, end], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
const xmlEsc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const colName = (i) => String.fromCharCode(65 + i);
// rows: array di array; cella = testo, numero oppure { v, bold }
function buildXlsx(rows, widths, sheetName) {
  const sheetRows = rows
    .map((r, ri) => {
      const cells = r
        .map((cell, ci) => {
          const obj = cell !== null && typeof cell === "object" ? cell : { v: cell };
          const ref = colName(ci) + (ri + 1);
          const isNum = typeof obj.v === "number";
          const style = obj.bold ? (isNum ? 3 : 1) : isNum ? 2 : 0;
          if (obj.v === "" || obj.v === null || obj.v === undefined) return `<c r="${ref}" s="${style}"/>`;
          if (isNum) return `<c r="${ref}" s="${style}"><v>${obj.v}</v></c>`;
          return `<c r="${ref}" s="${style}" t="inlineStr"><is><t>${xmlEsc(obj.v)}</t></is></c>`;
        })
        .join("");
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join("");
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");
  const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  return zipStore([
    { name: "[Content_Types].xml", content: X + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
    { name: "_rels/.rels", content: X + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: "xl/workbook.xml", content: X + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEsc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", content: X + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: "xl/styles.xml", content: X + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00;[Red]\-#,##0.00"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>' },
    { name: "xl/worksheets/sheet1.xml", content: X + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${sheetRows}</sheetData></worksheet>` },
  ]);
}

// ---------- piano di ammortamento di un finanziamento ----------
export function buildSchedule(loan, stress = 0) {
  const P = Number(loan.importo) || 0;
  const rate = (Number(loan.tasso) || 0) + (loan.tipoTasso === "variabile" ? stress : 0);
  const r = rate / 100 / 12;
  const pre = Math.max(0, Math.round(Number(loan.preMesi) || 0));
  const n = Math.max(0, Math.round(Number(loan.ammMesi) || 0));
  const start = toIdx(loan.inizio);
  const fee = loan.costoTipo === "pct" ? (P * (Number(loan.costoIngresso) || 0)) / 100 : Number(loan.costoIngresso) || 0;

  // mese 0 = erogazione (entra il capitale, si pagano i costi di ingresso)
  const rows = [{ idx: start, interest: 0, capital: 0, fee, inflow: P, balance: P }];
  let regime = 0;
  let preRata = 0;
  if (P > 0 && pre + n > 0) {
    const pay = loan.ammTipo === "francese" && n > 0 ? (r === 0 ? P / n : (P * r) / (1 - Math.pow(1 + r, -n))) : 0;
    let bal = P;
    preRata = P * r;
    for (let t = 1; t <= pre + n; t++) {
      const interest = bal * r;
      let capital = 0;
      if (t > pre && n > 0) {
        const k = t - pre;
        if (loan.ammTipo === "francese") capital = pay - interest;
        else if (loan.ammTipo === "italiano") capital = P / n;
        else capital = k === n ? bal : 0;
        if (k === 1) regime = interest + capital;
      }
      if (t === pre + n) capital = bal; // chiude il residuo (arrotondamenti / solo interessi)
      capital = Math.min(Math.max(capital, 0), bal);
      bal -= capital;
      rows.push({ idx: start + t, interest, capital, fee: 0, inflow: 0, balance: Math.max(0, bal) });
    }
  }
  const totalInterest = rows.reduce((t, x) => t + x.interest, 0);
  return {
    rows,
    start,
    end: rows[rows.length - 1].idx,
    fee,
    totalInterest,
    totalCost: totalInterest + fee,
    regime,
    preRata,
  };
}

// ---------- somma di tutti i finanziamenti per mese ----------
function aggregate(loans, stress) {
  const sch = loans.filter((l) => Number(l.importo) > 0).map((l) => buildSchedule(l, stress));
  if (!sch.length) return { sch, months: [] };
  const min = Math.min(...sch.map((s) => s.start));
  const max = Math.max(...sch.map((s) => s.end));
  const months = [];
  for (let i = min; i <= max; i++) {
    let interest = 0, capital = 0, fee = 0, inflow = 0, balance = 0;
    sch.forEach((s) => {
      const row = s.rows.find((x) => x.idx === i);
      if (row) {
        interest += row.interest;
        capital += row.capital;
        fee += row.fee;
        inflow += row.inflow;
        balance += row.balance;
      } else if (i < s.start) {
        // non ancora erogato
      }
    });
    months.push({ idx: i, label: idxLabel(i), interest, capital, fee, inflow, balance, outflow: interest + capital + fee });
  }
  return { sch, months };
}

// campo per i tassi: accetta sia 4,25 sia 4.25 (il campo numerico dell'app tratta il punto come migliaia)
function RateField({ value, onChange, style }) {
  const show = (v) => (v === "" || v == null ? "" : String(v).replace(".", ","));
  const [raw, setRaw] = useState(show(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setRaw(show(value));
  }, [value, focused]);
  return (
    <input
      type="text"
      inputMode="decimal"
      style={style}
      value={raw}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChange={(e) => {
        const v = e.target.value.replace(/[^0-9.,]/g, "");
        setRaw(v);
        if (v === "") {
          onChange("");
          return;
        }
        const num = Number(v.replace(",", "."));
        if (!Number.isNaN(num)) onChange(num);
      }}
    />
  );
}

function Field({ ui, label, children }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      <span style={ui.styles.chipLabel}>{label}</span>
      {children}
    </label>
  );
}

// ---------- pagina ----------
export function FinancingPage({ ui }) {
  const { styles, eur, pct } = ui;
  const c = ui.colors;
  const [loans, setLoans] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveState, setSaveState] = useState("idle");
  const [stress, setStress] = useState(0);
  const [showMonthly, setShowMonthly] = useState(false);
  const timer = useRef(null);
  const latest = useRef(null);
  const failedRef = useRef(false);

  useEffect(() => {
    (async () => {
      try {
        const v = await kvGet(LOANS_KEY);
        const arr = Array.isArray(v) ? v : [];
        latest.current = arr;
        setLoans(arr);
      } catch (e) {
        failedRef.current = true;
        setLoadFailed(true);
        setLoans([]);
      }
    })();
    // al cambio pagina salva subito se c'è una modifica in attesa
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        if (!failedRef.current && latest.current) kvSet(LOANS_KEY, latest.current).catch(() => {});
      }
    };
  }, []);

  const persist = (next) => {
    latest.current = next;
    setLoans(next);
    if (failedRef.current) {
      setSaveState("blocked");
      return;
    }
    setSaveState("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      timer.current = null;
      try {
        await kvSet(LOANS_KEY, next);
        setSaveState("saved");
        setTimeout(() => setSaveState("idle"), 1400);
      } catch (e) {
        setSaveState("error");
      }
    }, 400);
  };

  const update = (id, patch) => persist(loans.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const remove = (id) => {
    if (window.confirm("Eliminare questo finanziamento?")) persist(loans.filter((l) => l.id !== id));
  };

  if (!loans) {
    return (
      <section style={styles.section}>
        <div style={styles.tableEmpty}>Caricamento finanziamenti…</div>
      </section>
    );
  }

  const { sch, months } = aggregate(loans, Number(stress) || 0);
  const curIdx = toIdx(nowYm());
  const curRow = months.find((m) => m.idx === curIdx) || null;
  const lastBefore = [...months].filter((m) => m.idx <= curIdx).pop();
  const debtNow = curRow ? curRow.balance : lastBefore ? lastBefore.balance : months.length && curIdx < months[0].idx ? 0 : 0;
  const totInterest = months.reduce((t, m) => t + m.interest, 0);
  const totFees = months.reduce((t, m) => t + m.fee, 0);
  const totDraw = months.reduce((t, m) => t + m.inflow, 0);
  const peak = months.reduce((best, m) => (m.interest + m.capital > (best ? best.interest + best.capital : -1) ? m : best), null);

  // riepilogo per anno
  const years = [];
  months.forEach((m) => {
    const y = idxYear(m.idx);
    let row = years.find((x) => x.y === y);
    if (!row) {
      row = { y, inflow: 0, interest: 0, capital: 0, fee: 0, balance: 0 };
      years.push(row);
    }
    row.inflow += m.inflow;
    row.interest += m.interest;
    row.capital += m.capital;
    row.fee += m.fee;
    row.balance = m.balance; // ultimo mese dell'anno
  });

  const downloadXlsx = () => {
    const sum = (k) => months.reduce((t, m) => t + m[k], 0);
    const r2 = (n) => Math.round(n * 100) / 100;
    const head = ["Mese", "Erogato (entrata)", "Interessi", "Capitale", "Costi entrata", "Uscite totali", "Cash flow netto", "Debito residuo"].map((v) => ({ v, bold: true }));
    const body = months.map((m) => {
      const out = m.interest + m.capital + m.fee;
      return [m.label, r2(m.inflow), r2(m.interest), r2(m.capital), r2(m.fee), r2(out), r2(m.inflow - out), r2(m.balance)];
    });
    const totOut = sum("interest") + sum("capital") + sum("fee");
    const total = ["Totale", r2(sum("inflow")), r2(sum("interest")), r2(sum("capital")), r2(sum("fee")), r2(totOut), r2(sum("inflow") - totOut), ""].map((v) => ({ v, bold: true }));
    const blob = buildXlsx([head, ...body, total], [12, 18, 14, 14, 14, 14, 16, 16], "Cash flow mensile");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "cash-flow-finanziamenti.xlsx";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const th = { padding: "0 10px 8px", textAlign: "right", fontWeight: 500, whiteSpace: "nowrap" };
  const td = { padding: "9px 10px", borderTop: `1px solid ${c.border}`, whiteSpace: "nowrap", fontSize: 13, color: c.ink, textAlign: "right", fontFamily: "'JetBrains Mono', monospace" };

  const saveLabel =
    saveState === "saving" ? "Salvataggio…" : saveState === "saved" ? "Salvato ✓" : saveState === "error" ? "Errore nel salvataggio" : saveState === "blocked" ? "Archivio non raggiungibile: ricarica la pagina" : "";

  return (
    <>
      <section style={styles.section} className="section-card no-print">
        <div style={styles.sectionHeadRow}>
          <div style={styles.eyebrowSmall}>Finanziamenti</div>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <span style={{ fontSize: 12.5, color: saveState === "error" || saveState === "blocked" ? c.red : c.inkSoft }}>{saveLabel}</span>
            <button style={styles.addRowBtn} onClick={() => persist([...loans, newLoan()])}>
              + Finanziamento
            </button>
          </div>
        </div>
        {loadFailed && (
          <div style={{ fontSize: 12.5, color: c.red, marginBottom: 12 }}>
            Archivio non raggiungibile in questo momento: per non sovrascrivere i dati esistenti non salvo nulla. Ricarica la pagina.
          </div>
        )}
        {loans.length === 0 && (
          <div style={styles.tableEmpty}>Nessun finanziamento. Aggiungine uno con “+ Finanziamento”.</div>
        )}

        {loans.map((l, idx) => {
          const s = Number(l.importo) > 0 ? buildSchedule(l, Number(stress) || 0) : null;
          const ann = Math.round(Number(l.ammMesi) || 0);
          return (
            <div
              key={l.id}
              style={{
                background: c.surfaceAlt,
                border: `1px solid ${c.border}`,
                borderRadius: 12,
                padding: "16px 18px 18px",
                marginBottom: 14,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <span style={{ ...styles.chipLabel, fontSize: 11 }}>Finanziamento {idx + 1}</span>
                <button
                  style={{ background: "none", border: "none", color: c.red, cursor: "pointer", fontSize: 13 }}
                  onClick={() => remove(l.id)}
                >
                  Elimina
                </button>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 14 }}>
                <Field ui={ui} label="Nome">
                  <input style={styles.input} placeholder="es. Mutuo Valzella" value={l.nome} onChange={(e) => update(l.id, { nome: e.target.value })} />
                </Field>
                <Field ui={ui} label="Banca / ente">
                  <input style={styles.input} value={l.ente} onChange={(e) => update(l.id, { ente: e.target.value })} />
                </Field>
                <Field ui={ui} label="Importo (€)">
                  <ui.NumberField style={styles.input} value={l.importo} onChange={(v) => update(l.id, { importo: v })} />
                </Field>
                <Field ui={ui} label="Erogazione (mese)">
                  <input
                    type="month"
                    style={{ ...styles.input, colorScheme: "dark" }}
                    value={l.inizio}
                    onChange={(e) => update(l.id, { inizio: e.target.value })}
                  />
                </Field>
                <Field ui={ui} label="Tipo di tasso">
                  <select style={styles.select} value={l.tipoTasso} onChange={(e) => update(l.id, { tipoTasso: e.target.value })}>
                    <option value="fisso">Fisso</option>
                    <option value="variabile">Variabile</option>
                  </select>
                </Field>
                <Field ui={ui} label={l.tipoTasso === "variabile" ? "Tasso annuo attuale (%)" : "Tasso annuo (%)"}>
                  <RateField style={styles.input} value={l.tasso} onChange={(v) => update(l.id, { tasso: v })} />
                </Field>
                <Field ui={ui} label="Costo di entrata">
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 64px", gap: 6 }}>
                    <ui.NumberField style={styles.input} value={l.costoIngresso} onChange={(v) => update(l.id, { costoIngresso: v })} />
                    <select style={styles.select} value={l.costoTipo} onChange={(e) => update(l.id, { costoTipo: e.target.value })}>
                      <option value="eur">€</option>
                      <option value="pct">%</option>
                    </select>
                  </div>
                </Field>
                <Field ui={ui} label="Solo interessi per (mesi)">
                  <ui.NumberField style={styles.input} value={l.preMesi} onChange={(v) => update(l.id, { preMesi: v })} />
                </Field>
                <Field ui={ui} label={`Rimborso capitale in (mesi)${ann >= 12 ? ` · ${(ann / 12).toFixed(ann % 12 === 0 ? 0 : 1)} anni` : ""}`}>
                  <ui.NumberField style={styles.input} value={l.ammMesi} onChange={(v) => update(l.id, { ammMesi: v })} />
                </Field>
                <Field ui={ui} label="Tipo di ammortamento">
                  <select style={styles.select} value={l.ammTipo} onChange={(e) => update(l.id, { ammTipo: e.target.value })}>
                    {TIPI_AMM.map((t) => (
                      <option key={t.v} value={t.v}>{t.label}</option>
                    ))}
                  </select>
                </Field>
              </div>

              {s && (
                <div style={styles.chipsRow}>
                  {Number(l.preMesi) > 0 && (
                    <div style={styles.chip}>
                      <span style={styles.chipLabel}>Rata solo interessi</span>
                      <span style={styles.chipValue}>{eur(s.preRata)}/mese</span>
                    </div>
                  )}
                  <div style={styles.chip}>
                    <span style={styles.chipLabel}>{l.ammTipo === "bullet" ? "Rata (solo interessi)" : "Rata a regime (1ª)"}</span>
                    <span style={styles.chipValue}>{l.ammTipo === "bullet" ? eur(s.preRata) : eur(s.regime)}/mese</span>
                  </div>
                  <div style={styles.chip}>
                    <span style={styles.chipLabel}>Interessi totali</span>
                    <span style={styles.chipValue}>{eur(s.totalInterest)}</span>
                  </div>
                  <div style={styles.chip}>
                    <span style={styles.chipLabel}>Costo di entrata</span>
                    <span style={styles.chipValue}>{eur(s.fee)}</span>
                  </div>
                  <div style={{ ...styles.chip, ...styles.chipTotal }}>
                    <span style={styles.chipLabel}>Costo totale</span>
                    <span style={styles.chipValue}>
                      {eur(s.totalCost)} · {pct((s.totalCost / Number(l.importo)) * 100)}
                    </span>
                  </div>
                  <div style={styles.chip}>
                    <span style={styles.chipLabel}>Ultima rata</span>
                    <span style={styles.chipValue}>{idxLabel(s.end)}</span>
                  </div>
                </div>
              )}
              {l.tipoTasso === "variabile" && (
                <div style={{ fontSize: 12, color: c.inkFaint, marginTop: 10 }}>
                  Il piano usa il tasso attuale come se restasse costante. Per vedere cosa succede se i tassi salgono usa lo “stress” nel riepilogo qui sotto.
                </div>
              )}
            </div>
          );
        })}
      </section>

      {months.length > 0 && (
        <section style={styles.section} className="section-card no-print">
          <div style={styles.sectionHeadRow}>
            <div style={styles.eyebrowSmall}>Riepilogo e cash flow</div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: c.inkSoft }}>
              Stress tassi variabili: +
              <RateField style={{ ...styles.input, width: 70, textAlign: "right" }} value={stress} onChange={(v) => setStress(v === "" ? 0 : v)} />
              punti %
            </label>
          </div>

          <div style={styles.chipsRow}>
            <div style={styles.chip}>
              <span style={styles.chipLabel}>Debito residuo oggi</span>
              <span style={styles.chipValue}>{eur(debtNow)}</span>
            </div>
            <div style={styles.chip}>
              <span style={styles.chipLabel}>Uscita mensile oggi</span>
              <span style={styles.chipValue}>{curRow ? eur(curRow.interest + curRow.capital) : "—"}</span>
            </div>
            <div style={styles.chip}>
              <span style={styles.chipLabel}>Picco mensile</span>
              <span style={styles.chipValue}>{peak ? `${eur(peak.interest + peak.capital)} · ${peak.label}` : "—"}</span>
            </div>
            <div style={styles.chip}>
              <span style={styles.chipLabel}>Totale erogato</span>
              <span style={styles.chipValue}>{eur(totDraw)}</span>
            </div>
            <div style={styles.chip}>
              <span style={styles.chipLabel}>Interessi totali</span>
              <span style={styles.chipValue}>{eur(totInterest)}</span>
            </div>
            <div style={{ ...styles.chip, ...styles.chipTotal }}>
              <span style={styles.chipLabel}>Costo totale (interessi + entrata)</span>
              <span style={styles.chipValue}>{eur(totInterest + totFees)}</span>
            </div>
          </div>

          <div style={{ height: 300, marginTop: 22 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={months} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
                <CartesianGrid stroke={c.border} vertical={false} />
                <XAxis dataKey="label" tick={{ fill: c.inkSoft, fontSize: 11 }} interval={Math.max(0, Math.ceil(months.length / 10) - 1)} stroke={c.border} />
                <YAxis yAxisId="l" tick={{ fill: c.inkSoft, fontSize: 11 }} stroke={c.border} tickFormatter={kfmt} />
                <YAxis yAxisId="r" orientation="right" tick={{ fill: c.inkSoft, fontSize: 11 }} stroke={c.border} tickFormatter={kfmt} />
                <Tooltip
                  contentStyle={{ background: c.surfaceAlt, border: `1px solid ${c.border}`, borderRadius: 8, color: c.ink, fontSize: 12 }}
                  labelStyle={{ color: c.inkSoft }}
                  formatter={(v, name) => [eur(v), name]}
                />
                <Legend wrapperStyle={{ fontSize: 12, color: c.inkSoft }} />
                <Bar yAxisId="l" dataKey="interest" name="Interessi" stackId="u" fill={C_INT} />
                <Bar yAxisId="l" dataKey="capital" name="Capitale" stackId="u" fill={C_CAP} />
                <Bar yAxisId="l" dataKey="fee" name="Costi di entrata" stackId="u" fill={C_FEE} />
                <Line yAxisId="r" type="monotone" dataKey="balance" name="Debito residuo (asse dx)" stroke={C_DEBT} strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <div style={{ marginTop: 16, display: "flex", justifyContent: "center", gap: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              style={styles.saveNowBtn}
              onClick={() => setShowMonthly((v) => !v)}
              aria-expanded={showMonthly}
            >
              {showMonthly ? "▲ Nascondi cash flow mensile" : "▼ Mostra cash flow mensile"}
            </button>
            <button type="button" style={styles.saveNowBtn} onClick={downloadXlsx}>
              ⬇ Scarica Excel
            </button>
          </div>

          {showMonthly && (
            <div style={{ marginTop: 16, overflowX: "auto", maxHeight: 460, overflowY: "auto", border: `1px solid ${c.border}`, borderRadius: 10 }}>
              <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 760 }}>
                <thead>
                  <tr style={{ ...styles.tableHeaderRow, display: "table-row" }}>
                    {["Mese", "Erogato (entrata)", "Interessi", "Capitale", "Costi entrata", "Uscite totali", "Cash flow netto", "Debito residuo"].map((h, i) => (
                      <th key={h} style={{ ...th, padding: "10px 10px", position: "sticky", top: 0, background: c.surface, textAlign: i === 0 ? "left" : "right" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {months.map((m) => {
                    const out = m.interest + m.capital + m.fee;
                    const net = m.inflow - out;
                    const isNow = m.idx === curIdx;
                    return (
                      <tr key={m.idx} style={isNow ? { background: c.surfaceAlt } : undefined}>
                        <td style={{ ...td, textAlign: "left" }}>{m.label}{isNow ? " · oggi" : ""}</td>
                        <td style={{ ...td, color: m.inflow > 0 ? c.green : c.inkFaint }}>{m.inflow > 0 ? eur(m.inflow) : "—"}</td>
                        <td style={td}>{m.interest > 0 ? eur(m.interest) : "—"}</td>
                        <td style={td}>{m.capital > 0 ? eur(m.capital) : "—"}</td>
                        <td style={td}>{m.fee > 0 ? eur(m.fee) : "—"}</td>
                        <td style={{ ...td, fontWeight: 700 }}>{out > 0 ? eur(out) : "—"}</td>
                        <td style={{ ...td, fontWeight: 700, color: net > 0 ? c.green : net < 0 ? c.red : c.inkFaint }}>{net === 0 ? "—" : (net > 0 ? "+" : "−") + eur(Math.abs(net))}</td>
                        <td style={td}>{eur(m.balance)}</td>
                      </tr>
                    );
                  })}
                  <tr>
                    <td style={{ ...td, textAlign: "left", fontWeight: 700 }}>Totale</td>
                    <td style={{ ...td, fontWeight: 700 }}>{eur(totDraw)}</td>
                    <td style={{ ...td, fontWeight: 700 }}>{eur(totInterest)}</td>
                    <td style={{ ...td, fontWeight: 700 }}>{eur(months.reduce((t, m) => t + m.capital, 0))}</td>
                    <td style={{ ...td, fontWeight: 700 }}>{eur(totFees)}</td>
                    <td style={{ ...td, fontWeight: 700 }}>{eur(totInterest + totFees + months.reduce((t, m) => t + m.capital, 0))}</td>
                    <td style={{ ...td, fontWeight: 700 }}>{(() => { const n = totDraw - (totInterest + totFees + months.reduce((t, m) => t + m.capital, 0)); return n === 0 ? "—" : (n > 0 ? "+" : "−") + eur(Math.abs(n)); })()}</td>
                    <td style={td}>—</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          <div style={{ marginTop: 22, overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 640 }}>
              <thead>
                <tr style={{ ...styles.tableHeaderRow, display: "table-row" }}>
                  <th style={{ ...th, textAlign: "left" }}>Anno</th>
                  <th style={th}>Erogato (entrata)</th>
                  <th style={th}>Interessi</th>
                  <th style={th}>Capitale</th>
                  <th style={th}>Costi entrata</th>
                  <th style={th}>Uscite totali</th>
                  <th style={th}>Debito a fine anno</th>
                </tr>
              </thead>
              <tbody>
                {years.map((y) => (
                  <tr key={y.y}>
                    <td style={{ ...td, textAlign: "left" }}>{y.y}</td>
                    <td style={{ ...td, color: y.inflow > 0 ? c.green : c.inkFaint }}>{y.inflow > 0 ? eur(y.inflow) : "—"}</td>
                    <td style={td}>{eur(y.interest)}</td>
                    <td style={td}>{eur(y.capital)}</td>
                    <td style={td}>{y.fee > 0 ? eur(y.fee) : "—"}</td>
                    <td style={{ ...td, fontWeight: 700 }}>{eur(y.interest + y.capital + y.fee)}</td>
                    <td style={td}>{eur(y.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ fontSize: 12, color: c.inkFaint, marginTop: 12, lineHeight: 1.5 }}>
            Le uscite sono le rate (interessi + capitale) più i costi di entrata, pagati nel mese di erogazione. Le rate sono mensili, posticipate.
            Con tasso variabile il piano usa il tasso attuale più lo stress indicato. Il calcolo non include assicurazioni, imposta sostitutiva
            e altre spese accessorie: confronta sempre con il piano di ammortamento della banca.
          </div>
        </section>
      )}
    </>
  );
}
