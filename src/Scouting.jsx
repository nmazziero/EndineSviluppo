import React, { useState, useEffect } from "react";
import { kvGet, kvSet } from "./supabaseClient";
import { FinancingPage } from "./Finanziamenti";

// ---------------------------------------------------------------
// SCOUTING — scheda per progetto + pagina di confronto
// Tutti i campi sono opzionali. Nessun dato viene toccato negli altri
// progetti: la scheda salva solo dentro project.scouting.
// ---------------------------------------------------------------

const TIPOLOGIE = ["Appartamento", "Villa", "Palazzina", "Altro"];
// voci di costo principali: il livello (basso/medio/alto) si impara dai costi reali al mq
const KEY_CATS = ["Opere murarie", "Serramenti e falegnameria", "Opere idrauliche"];
const KEY_SHORT = { "Opere murarie": "Murarie", "Serramenti e falegnameria": "Serramenti", "Opere idrauliche": "Idraulica" };
const KEY_CRITERIA = {
  "Opere murarie": {
    basso: "ripristini e tinteggiature",
    medio: "spostamento tramezzi, intonaci, massetti",
    alto: "demolizioni importanti, opere strutturali, ampliamenti",
  },
  "Serramenti e falegnameria": {
    basso: "sostituzione parziale",
    medio: "tutti da sostituire, misure standard",
    alto: "molti infissi, grandi vetrate, taglio termico spinto",
  },
  "Opere idrauliche": {
    basso: "solo bagni",
    medio: "impianto da rifare in parte",
    alto: "impianto completo con riscaldamento a pavimento o nuova caldaia",
  },
};
const LEVELS = ["basso", "medio", "alto"];

function percentile(sorted, p) {
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// Fasce €/mq apprese dai progetti: basso ≈ 15° percentile, medio = mediana, alto ≈ 85° percentile
// (con almeno ±15% attorno alla mediana). Con un solo progetto le fasce sono ipotesi (-25% / +30%).
export function levelsFor(values) {
  const v = values.filter((x) => x > 0).sort((a, b) => a - b);
  if (!v.length) return null;
  if (v.length === 1) return { basso: v[0] * 0.75, medio: v[0], alto: v[0] * 1.3, n: 1, assumed: true };
  const med = percentile(v, 0.5);
  return {
    basso: Math.min(percentile(v, 0.15), med * 0.85),
    medio: med,
    alto: Math.max(percentile(v, 0.85), med * 1.15),
    n: v.length,
    assumed: false,
  };
}

// livello "rilevato" di un valore rispetto alle fasce (solo con almeno 3 progetti)
export function levelOf(value, lev) {
  if (!lev || lev.n < 3 || !(value > 0)) return null;
  if (value <= (lev.basso + lev.medio) / 2) return "basso";
  if (value >= (lev.medio + lev.alto) / 2) return "alto";
  return "medio";
}
const INTERVENTI = ["Ristrutturazione", "Ristrutturazione pesante", "Nuova costruzione"];
const STATI_PROGETTO = [
  { v: "da_avviare", label: "Da avviare" },
  { v: "in_corso", label: "In corso" },
  { v: "concluso", label: "Concluso" },
];
const STATI_PARTENZA = [
  { v: 1, label: "1 – Da rifare tutto (strutture e impianti)" },
  { v: 2, label: "2 – Strutture ok, impianti e finiture da rifare" },
  { v: 3, label: "3 – Strutture ok, impianti datati" },
  { v: 4, label: "4 – Buono, serve aggiornamento" },
  { v: 5, label: "5 – Abitabile, interventi leggeri" },
];
// dalla peggiore alla migliore
const CLASSI = ["G", "F", "E", "D", "C", "B", "A1", "A2", "A3", "A4"];

const statoLabel = (v) => (STATI_PROGETTO.find((s) => s.v === v) || {}).label || "—";

// ---------- calcoli per progetto ----------
export function scoutingMetrics(project, ui) {
  const m = ui.computeProject(project);
  const s = project.scouting || {};
  const units = project.units || [];
  const costs = project.costs || [];

  const acquisto = costs
    .filter((c) => c.category === "Acquisto")
    .reduce((t, c) => t + (Number(c.amount) || 0), 0);
  const lavori = m.totalCosts - acquisto;

  const soldUnits = units.filter((u) => u.sold);
  const soldSqm = soldUnits.reduce((t, u) => t + (Number(u.sqm) || 0), 0);
  const soldRev = soldUnits.reduce((t, u) => t + (Number(u.price) || 0), 0);
  const allSqm = m.totalSqm;

  // prezzo al mq: reale se ci sono unità vendute con mq, altrimenti previsto
  let pricePerSqm = 0;
  let priceIsReal = false;
  if (soldSqm > 0) {
    pricePerSqm = soldRev / soldSqm;
    priceIsReal = soldUnits.length === units.length;
  } else if (allSqm > 0) {
    pricePerSqm = m.unitsRevenue / allSqm;
  }

  const finalCosts = costs.filter((c) => c.final).reduce((t, c) => t + (Number(c.amount) || 0), 0);
  const costsRealPct = m.totalCosts > 0 ? (finalCosts / m.totalCosts) * 100 : 0;
  const extras = project.extraRevenues || [];
  const extraSold = extras.filter((r) => r.sold).reduce((tt, r) => tt + (Number(r.amount) || 0), 0);
  const revTotal = m.unitsRevenue + m.extraRevenue;
  const revRealPct = revTotal > 0 ? ((soldRev + extraSold) / revTotal) * 100 : 0;
  // percentuale di dati reali: media fra costi definitivi e ricavi venduti
  const realPct = (costsRealPct + revRealPct) / 2;

  const iIn = CLASSI.indexOf(s.classeInizio);
  const iOut = CLASSI.indexOf(s.classeFine);
  const salto = iIn >= 0 && iOut >= 0 ? iOut - iIn : null;

  const catPerSqm = {};
  const catFinal = {};
  KEY_CATS.forEach((cat) => {
    const rowsC = costs.filter((c) => c.category === cat);
    const amt = rowsC.reduce((t, c) => t + (Number(c.amount) || 0), 0);
    catPerSqm[cat] = allSqm > 0 ? amt / allSqm : 0;
    catFinal[cat] = rowsC.length > 0 && rowsC.every((c) => c.final);
  });
  const keySum = KEY_CATS.reduce((t, cat) => t + catPerSqm[cat] * allSqm, 0);
  const othersPerSqm = allSqm > 0 ? (lavori - keySum) / allSqm : 0;

  const omi = Number(s.omi) || 0;
  const omiRatio = omi > 0 && pricePerSqm > 0 ? pricePerSqm / omi : 0;

  const core = [
    !!s.tipologia,
    !!s.intervento,
    !!s.anno,
    !!s.statoPartenza,
    !!(s.comune || project.location),
    allSqm > 0,
  ];
  const completezza = core.filter(Boolean).length;

  return {
    m,
    s,
    acquisto,
    lavori,
    allSqm,
    costPerSqmTot: allSqm > 0 ? m.totalCosts / allSqm : 0,
    costPerSqmLavori: allSqm > 0 ? lavori / allSqm : 0,
    pricePerSqm,
    priceIsReal,
    costsRealPct,
    revRealPct,
    realPct,
    salto,
    catPerSqm,
    catFinal,
    othersPerSqm,
    omi,
    omiRatio,
    completezza,
    coreTotal: core.length,
  };
}

// ---------- piccoli componenti ----------
function Field({ ui, label, children }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      <span style={ui.styles.chipLabel}>{label}</span>
      {children}
    </label>
  );
}

// ---------- scheda dentro ogni progetto ----------
export function ScoutingCard({ project, onChange, ui }) {
  const s = project.scouting || {};
  const set = (k, v) =>
    onChange((p) => ({ ...p, scouting: { ...(p.scouting || {}), [k]: v } }));
  const sm = scoutingMetrics(project, ui);
  const { styles, eur, pct } = ui;
  const c = ui.colors;

  const sel = (key, options, placeholder = "—") => (
    <select
      style={styles.select}
      value={s[key] ?? ""}
      onChange={(e) => {
        const raw = e.target.value;
        set(key, raw === "" ? "" : key === "statoPartenza" ? Number(raw) : raw);
      }}
    >
      <option value="">{placeholder}</option>
      {options.map((o) =>
        typeof o === "string" ? (
          <option key={o} value={o}>{o}</option>
        ) : (
          <option key={o.v} value={o.v}>{o.label}</option>
        )
      )}
    </select>
  );

  return (
    <section style={styles.section} className="section-card no-print">
      <div style={styles.sectionHeadRow}>
        <div style={styles.eyebrowSmall}>Scheda scouting</div>
        <div style={{ ...styles.chipLabel, textTransform: "none" }}>
          Compilata {sm.completezza}/{sm.coreTotal} · tutti i campi sono facoltativi
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 14 }}>
        <Field ui={ui} label="Stato del progetto">{sel("stato", STATI_PROGETTO, "Da definire")}</Field>
        <Field ui={ui} label="Tipologia">{sel("tipologia", TIPOLOGIE)}</Field>
        <Field ui={ui} label="Intervento">{sel("intervento", INTERVENTI)}</Field>
        <Field ui={ui} label="Anno di costruzione originario">
          <input
            style={styles.input}
            inputMode="numeric"
            maxLength={4}
            placeholder="es. 1975"
            value={s.anno ?? ""}
            onChange={(e) => set("anno", e.target.value.replace(/\D/g, ""))}
          />
        </Field>
        <Field ui={ui} label="Stato di partenza">{sel("statoPartenza", STATI_PARTENZA)}</Field>
        <Field ui={ui} label="Classe energetica di partenza">{sel("classeInizio", CLASSI)}</Field>
        <Field ui={ui} label="Classe prevista a fine lavori">{sel("classeFine", CLASSI)}</Field>
        <Field ui={ui} label="Comune / zona">
          <input
            style={styles.input}
            placeholder={project.location || "es. Casazza"}
            value={s.comune ?? ""}
            onChange={(e) => set("comune", e.target.value)}
          />
        </Field>
      </div>

      <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "2fr 1fr", gap: 14 }}>
        <Field ui={ui} label="Nota sulla zona (facoltativa)">
          <input
            style={styles.input}
            placeholder="es. vicino al lago, zona servita, molta richiesta…"
            value={s.zonaNota ?? ""}
            onChange={(e) => set("zonaNota", e.target.value)}
          />
        </Field>
        <Field ui={ui} label="Valore zona OMI €/mq (facoltativo)">
          <ui.NumberField
            style={styles.input}
            value={s.omi ?? 0}
            onChange={(v) => set("omi", v)}
          />
        </Field>
      </div>

      <div style={styles.chipsRow}>
        <div style={styles.chip}>
          <span style={styles.chipLabel}>Costo lavori / mq</span>
          <span style={styles.chipValue}>{sm.allSqm > 0 ? eur(sm.costPerSqmLavori) : "inserisci i mq"}</span>
        </div>
        <div style={styles.chip}>
          <span style={styles.chipLabel}>Costo totale / mq</span>
          <span style={styles.chipValue}>{sm.allSqm > 0 ? eur(sm.costPerSqmTot) : "—"}</span>
        </div>
        <div style={styles.chip}>
          <span style={styles.chipLabel}>Prezzo / mq ({sm.priceIsReal ? "reale" : "previsto"})</span>
          <span style={styles.chipValue}>{sm.pricePerSqm > 0 ? eur(sm.pricePerSqm) : "—"}</span>
        </div>
        <div style={styles.chip}>
          <span style={styles.chipLabel}>Salto classe energetica</span>
          <span style={styles.chipValue}>
            {sm.salto === null ? "—" : sm.salto > 0 ? `+${sm.salto} classi` : sm.salto === 0 ? "nessuno" : `${sm.salto}`}
          </span>
        </div>
        <div style={{ ...styles.chip, ...styles.chipTotal }}>
          <span style={styles.chipLabel}>Dati reali</span>
          <span style={styles.chipValue}>{pct(sm.realPct)}</span>
        </div>
      </div>
      <div style={{ fontSize: 12, color: c.inkFaint, marginTop: 10 }}>
        «Dati reali» = media fra la quota di costi spuntati “Finale” e la quota di ricavi spuntati “Venduto”.
        Più è alta, più questo progetto pesa nello storico.
      </div>
    </section>
  );
}

// ---------- interruttore Progetti / Scouting ----------
export function ViewSwitch({ view, setView, ui }) {
  const { styles } = ui;
  return (
    <>
      <div className="no-print" style={{ display: "flex", gap: 8, marginBottom: 18 }}>
        {/* regola usata per nascondere le linguette dei progetti nelle altre viste */}
        <style>{`.hidden-view { display: none !important; }`}</style>
        {[
          { v: "projects", label: "Progetti" },
          { v: "scouting", label: "Scouting" },
          { v: "finanziamenti", label: "Finanziamenti" },
        ].map((t) => (
          <button
            key={t.v}
            onClick={() => setView(t.v)}
            style={{ ...styles.tab, ...(view === t.v ? styles.tabActive : {}) }}
          >
            {t.label}
          </button>
        ))}
      </div>
      {view === "finanziamenti" && <FinancingPage ui={ui} />}
    </>
  );
}

// ---------- pagina Scouting: confronto fra progetti ----------
export function ScoutingPage({ projects, onOpenProject, ui }) {
  const { styles, eur, pct } = ui;
  const c = ui.colors;
  const rows = projects.map((p) => ({ p, sm: scoutingMetrics(p, ui) }));

  const conclusi = rows.filter((r) => (r.sm.s.stato || "") === "concluso").length;
  const level =
    conclusi >= 8
      ? { t: "Buona", d: "abbastanza progetti per stime pesate sulla somiglianza." }
      : conclusi >= 3
      ? { t: "Media", d: "si possono mostrare medie e intervalli min–max." }
      : { t: "Bassa", d: "per ora vale come confronto diretto fra i progetti, non come previsione." };

  const th = { padding: "0 10px 8px", textAlign: "left", fontWeight: 500, whiteSpace: "nowrap" };
  const td = { padding: "10px", borderTop: `1px solid ${c.border}`, whiteSpace: "nowrap", fontSize: 13, color: c.ink };
  const num = { ...td, textAlign: "right", fontFamily: "'JetBrains Mono', monospace" };
  const dash = <span style={{ color: c.inkFaint }}>—</span>;

  return (
    <>
      <section style={styles.section} className="section-card">
        <div style={styles.sectionHeadRow}>
          <div style={styles.eyebrowSmall}>Storico dei progetti</div>
        </div>
        <div style={styles.chipsRow}>
          <div style={styles.chip}>
            <span style={styles.chipLabel}>Progetti</span>
            <span style={styles.chipValue}>{rows.length}</span>
          </div>
          <div style={styles.chip}>
            <span style={styles.chipLabel}>Conclusi</span>
            <span style={styles.chipValue}>{conclusi}</span>
          </div>
          <div style={{ ...styles.chip, ...styles.chipTotal }}>
            <span style={styles.chipLabel}>Affidabilità delle stime</span>
            <span style={styles.chipValue}>{level.t}</span>
          </div>
        </div>
        <div style={{ fontSize: 12.5, color: c.inkSoft, marginTop: 12 }}>
          Affidabilità {level.t.toLowerCase()}: {level.d} Un progetto entra nello storico quando in “Scheda scouting” è
          segnato come <b>Concluso</b>.
        </div>
      </section>

      <section style={styles.section} className="section-card">
        <div style={styles.sectionHeadRow}>
          <div style={styles.eyebrowSmall}>Confronto progetti</div>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 1000 }}>
            <thead>
              <tr style={{ ...styles.tableHeaderRow, display: "table-row", textTransform: "uppercase", fontSize: 11, color: c.inkFaint }}>
                <th style={th}>Progetto</th>
                <th style={th}>Stato</th>
                <th style={{ ...th, textAlign: "right" }}>Mq</th>
                <th style={{ ...th, textAlign: "right" }}>Lavori/mq</th>
                <th style={{ ...th, textAlign: "right" }}>Prezzo/mq</th>
                <th style={{ ...th, textAlign: "right" }}>ROI lordo</th>
                <th style={{ ...th, textAlign: "right" }}>ROI netto ann.</th>
                <th style={{ ...th, textAlign: "right" }}>Dati reali</th>
                <th style={th}>Zona</th>
                <th style={th}>Tipologia</th>
                <th style={th}>Intervento</th>
                <th style={th}>Anno</th>
                <th style={th}>Partenza</th>
                <th style={th}>Classe</th>
                <th style={{ ...th, textAlign: "right" }}>Scheda</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ p, sm }) => (
                <tr key={p.id}>
                  <td style={td}>
                    <button
                      onClick={() => onOpenProject(p.id)}
                      style={{ background: "none", border: "none", color: c.teal, cursor: "pointer", fontWeight: 600, fontSize: 13, padding: 0 }}
                    >
                      {p.name || "Senza nome"}
                    </button>
                  </td>
                  <td style={td}>{sm.s.stato ? statoLabel(sm.s.stato) : dash}</td>
                  <td style={num}>{sm.allSqm > 0 ? sm.allSqm : dash}</td>
                  <td style={num}>{sm.allSqm > 0 ? eur(sm.costPerSqmLavori) : dash}</td>
                  <td style={num}>
                    {sm.pricePerSqm > 0 ? (
                      <>
                        {eur(sm.pricePerSqm)}{" "}
                        <span style={{ color: c.inkFaint, fontSize: 11 }}>{sm.priceIsReal ? "reale" : "prev."}</span>
                      </>
                    ) : (
                      dash
                    )}
                  </td>
                  <td style={num}>{pct(sm.m.roiGross)}</td>
                  <td style={num}>{pct(sm.m.roiNetAnnualized)}</td>
                  <td style={{ ...num, color: sm.realPct >= 80 ? c.green : sm.realPct >= 30 ? c.amber : c.inkSoft }}>
                    {pct(sm.realPct)}
                  </td>
                  <td style={td}>{sm.s.comune || p.location || dash}</td>
                  <td style={td}>{sm.s.tipologia || dash}</td>
                  <td style={td}>{sm.s.intervento || dash}</td>
                  <td style={td}>{sm.s.anno || dash}</td>
                  <td style={td}>{sm.s.statoPartenza ? `${sm.s.statoPartenza}/5` : dash}</td>
                  <td style={td}>
                    {sm.s.classeInizio || sm.s.classeFine
                      ? `${sm.s.classeInizio || "?"} → ${sm.s.classeFine || "?"}`
                      : dash}
                  </td>
                  <td style={{ ...num, color: sm.completezza === sm.coreTotal ? c.green : c.inkSoft }}>
                    {sm.completezza}/{sm.coreTotal}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: 12, color: c.inkFaint, marginTop: 12 }}>
          Clicca sul nome di un progetto per aprirlo e completare la scheda. “Lavori/mq” esclude la categoria
          Acquisto. “prev.” = prezzo ancora previsto, “reale” = tutte le unità spuntate come vendute.
        </div>
      </section>

      <LearnedBands rows={rows} ui={ui} />

      <OpportunityPanel rows={rows} ui={ui} />
    </>
  );
}


// =====================================================================
// NUOVA OPPORTUNITÀ — stima a scenari basata sui progetti già fatti
// =====================================================================
const OPP_KEY = "gruppo-endine:opportunities";
const TAX_RATE = 28;
const ESITI = [
  { v: "valutata", label: "Valutata" },
  { v: "acquistata", label: "Acquistata" },
  { v: "scartata", label: "Scartata" },
  { v: "persa", label: "Persa" },
];
const newDraft = () => ({
  id: null, nome: "", comune: "", mq: 0, prezzo: 0, tipologia: "", intervento: "",
  durata: 12, target: 25, omi: 0, venditore: 0, pesaVenditore: false, pesoVenditore: 25, esito: "valutata",
  livelli: { "Opere murarie": "medio", "Serramenti e falegnameria": "medio", "Opere idrauliche": "medio" },
});

// fasce apprese per ogni voce principale + scelta fatta nella bozza
function keyInfoOf(refs, d) {
  const lv = d.livelli || {};
  return KEY_CATS.map((cat) => {
    const obs = refs.filter((r) => r.sm.catPerSqm[cat] > 0);
    return {
      cat,
      lev: levelsFor(obs.map((r) => r.sm.catPerSqm[cat])),
      n: obs.length,
      final: obs.filter((r) => r.sm.catFinal[cat]).length,
      choice: lv[cat] || "medio",
    };
  });
}

// progetti utilizzabili come riferimento + peso
function buildRefs(rows, d) {
  return rows
    .filter(({ sm }) => {
      const st = sm.s.stato || "";
      return (st === "concluso" || st === "in_corso") && sm.allSqm > 0 && sm.lavori > 0 && sm.pricePerSqm > 0;
    })
    .map(({ p, sm }) => {
      let w = sm.s.stato === "concluso" ? 1 : 0.4;
      if (d.tipologia && sm.s.tipologia) w *= d.tipologia === sm.s.tipologia ? 1 : 0.5;
      return { p, sm, w };
    });
}

function wstat(refs, f) {
  const W = refs.reduce((t, r) => t + r.w, 0);
  const vals = refs.map((r) => f(r.sm));
  const mean = refs.reduce((t, r, i) => t + r.w * vals[i], 0) / W;
  return { mean, min: Math.min(...vals), max: Math.max(...vals) };
}

function scenario(mq, acq, lavPerSqm, pricePerSqm, durata) {
  const lavori = lavPerSqm * mq;
  const costi = acq + lavori;
  const ricavi = pricePerSqm * mq;
  const utile = ricavi - costi;
  const roi = costi > 0 ? (utile / costi) * 100 : 0;
  const imposte = utile > 0 ? (utile * TAX_RATE) / 100 : 0;
  const roiNet = costi > 0 ? ((utile - imposte) / costi) * 100 : 0;
  const dur = durata > 0 ? durata : 12;
  return { lavori, costi, ricavi, utile, roi, roiNet, roiNetAnn: roiNet * (12 / dur) };
}

function estimateOpp(refs, d) {
  const mq = Number(d.mq) || 0;
  const acq = Number(d.prezzo) || 0;
  const durata = Number(d.durata) || 12;
  if (!refs.length || mq <= 0) return null;

  const pr = wstat(refs, (sm) => sm.pricePerSqm);
  const W = refs.reduce((t, r) => t + r.w, 0);
  const realW = refs.reduce((t, r) => t + r.w * r.sm.realPct, 0) / W;
  const mqAvg = refs.reduce((t, r) => t + r.w * r.sm.allSqm, 0) / W;

  // costi: voci principali dal livello scelto (fasce apprese), tutte le altre a €/mq medio
  const keyInfo = keyInfoOf(refs, d);
  const valueAt = (k, shift) => {
    if (k.choice === "nessuno" || !k.lev) return 0;
    const j = LEVELS.indexOf(k.choice) + shift;
    if (j < 0) return k.lev.basso * 0.85;
    if (j > 2) return k.lev.alto * 1.15;
    return k.lev[LEVELS[j]];
  };
  const keyPer = (shift) => keyInfo.reduce((t, k) => t + valueAt(k, shift), 0);
  const oth = wstat(refs, (sm) => sm.othersPerSqm);
  const othBand = {
    low: Math.min(oth.mean * 0.85, oth.min),
    mid: oth.mean,
    high: Math.max(oth.mean * 1.15, oth.max),
  };
  // prudente = ogni voce principale un livello più cara; ottimista = un livello più economica
  const cost = {
    low: keyPer(-1) + othBand.low,
    mid: keyPer(0) + othBand.mid,
    high: (keyPer(1) + othBand.high) * (realW < 50 ? 1.1 : 1),
  };
  const price = {
    low: Math.min(pr.mean * 0.85, pr.min),
    mid: pr.mean,
    high: Math.max(pr.mean * 1.15, pr.max),
  };

  const ven = Number(d.venditore) || 0;
  // stima pura dai progetti (prima dell'eventuale peso del venditore)
  const priceModel = { ...price };
  const useVen = !!d.pesaVenditore && ven > 0;
  const wVen = Math.min(50, Math.max(0, Number(d.pesoVenditore) || 0)) / 100;
  if (useVen) {
    price.mid = (1 - wVen) * priceModel.mid + wVen * (ven / mq);
    price.high = Math.max(price.high, price.mid);
    price.low = Math.min(price.low, price.mid);
  }
  const sc = (acqX) => ({
    prudente: scenario(mq, acqX, cost.high, price.low, durata),
    atteso: scenario(mq, acqX, cost.mid, price.mid, durata),
    ottimista: scenario(mq, acqX, cost.low, price.high, durata),
    // aspettativa del venditore: ricavo totale dato da te, costi attesi
    ...(ven > 0 ? { venditore: scenario(mq, acqX, cost.mid, ven / mq, durata) } : {}),
  });
  const base = sc(acq);
  const T = Number(d.target) || 0;
  const maxFor = (s) => s.ricavi / (1 + T / 100) - s.lavori;
  const venPerSqm = ven > 0 ? ven / mq : 0;
  const venVsAtteso = ven > 0 && priceModel.mid > 0 ? (venPerSqm / priceModel.mid - 1) * 100 : 0;
  const sensitivity = [-20, -10, 0, 10, 20].map((dp) => ({ dp, acq: acq * (1 + dp / 100), ...sc(acq * (1 + dp / 100)) }));

  // controllo con valore zona OMI
  let omiCheck = null;
  const omiOpp = Number(d.omi) || 0;
  if (omiOpp > 0) {
    const withRatio = refs.filter((r) => r.sm.omiRatio > 0);
    if (withRatio.length) {
      const Wr = withRatio.reduce((t, r) => t + r.w, 0);
      const ratio = withRatio.reduce((t, r) => t + r.w * r.sm.omiRatio, 0) / Wr;
      omiCheck = { priceFromOmi: omiOpp * ratio, ratio, n: withRatio.length };
    } else {
      omiCheck = { priceFromOmi: 0, ratio: 0, n: 0 };
    }
  }

  const concl = refs.filter((r) => r.sm.s.stato === "concluso").length;
  const warnings = [];
  if (realW < 50) warnings.push("I progetti di riferimento hanno ancora molti costi preventivi: ho allargato la fascia dei costi verso l’alto del 10%.");
  if (mq < mqAvg * 0.6 || mq > mqAvg * 1.6)
    warnings.push("I mq sono molto diversi da quelli dei progetti di riferimento: i costi fissi non scalano con i mq, quindi la stima è meno precisa.");
  if (d.tipologia && !refs.some((r) => r.sm.s.tipologia === d.tipologia))
    warnings.push("Non hai nessun progetto della stessa tipologia: stai estrapolando da casi diversi.");
  keyInfo.forEach((k) => {
    const nome = KEY_SHORT[k.cat];
    if (k.choice === "nessuno") return;
    if (!k.lev) warnings.push(`${nome}: nessun progetto ha ancora questa voce, quindi è esclusa dalla stima (i costi reali sono probabilmente più alti).`);
    else if (k.lev.assumed) warnings.push(`${nome}: un solo progetto alle spalle, quindi basso e alto sono ipotesi (-25% / +30% sul medio).`);
    else if (k.n < 3) warnings.push(`${nome}: ${k.n} progetti, fasce ancora molto approssimative.`);
  });
  if (ven > 0 && venPerSqm > priceModel.high)
    warnings.push(`L’aspettativa del venditore (${Math.round(venPerSqm)} €/mq) è sopra anche il tuo scenario ottimista (${Math.round(priceModel.high)} €/mq): è più ottimista di tutto ciò che hai realizzato finora.`);
  if (refs.length < 3)
    warnings.push(`La stima si basa su ${refs.length} ${refs.length === 1 ? "progetto" : "progetti"}: è un confronto, non una previsione.`);

  return {
    cost, price, priceModel, useVen, wVen, keyInfo, base, sensitivity, omiCheck, warnings, n: refs.length, concl, realW,
    maxAtteso: maxFor(base.atteso), maxPrudente: maxFor(base.prudente),
    maxVenditore: base.venditore ? maxFor(base.venditore) : null,
    venPerSqm, venVsAtteso,
    breakEven: base.prudente.ricavi - base.prudente.lavori,
  };
}

function verdictOf(est, T) {
  const { prudente, atteso } = est.base;
  if (prudente.roi >= T) return { t: "Molto buono", d: "anche nello scenario prudente raggiungi il ROI desiderato.", tone: "green" };
  if (atteso.roi >= T && prudente.roi >= 0) return { t: "Buono", d: "lo scenario atteso raggiunge il ROI desiderato e nel prudente non perdi.", tone: "green" };
  if (atteso.roi >= T) return { t: "Rischioso", d: "lo scenario atteso raggiunge il ROI, ma nel prudente vai in perdita.", tone: "amber" };
  if (atteso.roi >= T * 0.6) return { t: "Al limite", d: "positivo ma sotto il ROI desiderato.", tone: "amber" };
  return { t: "Non conviene a questo prezzo", d: "il ROI atteso è molto sotto l’obiettivo.", tone: "red" };
}

function GradientBar({ est, T, ui }) {
  const c = ui.colors;
  const lo = -10;
  const hi = Math.max(T * 2, 20);
  const pos = (x) => Math.min(100, Math.max(0, ((x - lo) / (hi - lo)) * 100));
  const { prudente, atteso, ottimista, venditore } = est.base;
  const grad = `linear-gradient(90deg, ${c.red} 0%, ${c.red} ${pos(0)}%, ${c.amber} ${pos(T * 0.6)}%, ${c.green} ${pos(T)}%, ${c.green} 100%)`;
  return (
    <div style={{ margin: `34px 4px ${venditore ? 54 : 30}px`, position: "relative" }}>
      <div style={{ height: 16, borderRadius: 8, background: grad, position: "relative", overflow: "hidden" }}>
        <div
          style={{
            position: "absolute", top: 0, bottom: 0,
            left: `${pos(prudente.roi)}%`,
            width: `${Math.max(0.5, pos(ottimista.roi) - pos(prudente.roi))}%`,
            background: "rgba(255,255,255,0.28)",
            borderLeft: "2px solid rgba(255,255,255,0.85)",
            borderRight: "2px solid rgba(255,255,255,0.85)",
          }}
          title="Fascia fra scenario prudente e ottimista"
        />
      </div>
      {/* marcatore atteso */}
      <div style={{ position: "absolute", left: `${pos(atteso.roi)}%`, top: -8, transform: "translateX(-50%)" }}>
        <div style={{ width: 4, height: 32, background: c.ink, borderRadius: 2 }} />
      </div>
      <div
        style={{
          position: "absolute", top: -30, left: `${pos(atteso.roi)}%`,
          transform: `translateX(-${pos(atteso.roi)}%)`,
          whiteSpace: "nowrap", fontSize: 12, fontWeight: 700, color: c.ink,
        }}
      >
        atteso {atteso.roi.toFixed(1)}%
      </div>
      {/* aspettativa del venditore */}
      {venditore && (
        <>
          <div style={{ position: "absolute", left: `${pos(venditore.roi)}%`, top: 8, transform: "translateX(-50%)" }}>
            <div style={{ width: 4, height: 38, background: c.teal, borderRadius: 2 }} />
          </div>
          <div
            style={{
              position: "absolute", top: 48, left: `${pos(venditore.roi)}%`,
              transform: `translateX(-${pos(venditore.roi)}%)`,
              whiteSpace: "nowrap", fontSize: 12, fontWeight: 700, color: c.teal,
            }}
          >
            venditore {venditore.roi.toFixed(1)}%
          </div>
        </>
      )}
      {/* obiettivo */}
      <div style={{ position: "absolute", left: `${pos(T)}%`, top: 22, transform: "translateX(-50%)", fontSize: 11, color: c.inkSoft, whiteSpace: "nowrap" }}>
        ▲ obiettivo {T}%
      </div>
      <div style={{ position: "absolute", left: `${pos(0)}%`, top: 22, transform: "translateX(-50%)", fontSize: 11, color: c.inkFaint }}>
        ▲ 0%
      </div>
    </div>
  );
}

function OpportunityPanel({ rows, ui }) {
  const { styles, eur, pct } = ui;
  const c = ui.colors;
  const [d, setD] = useState(newDraft());
  const [opps, setOpps] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const v = await kvGet(OPP_KEY);
        setOpps(Array.isArray(v) ? v : []);
      } catch (e) {
        setLoadFailed(true);
        setOpps([]);
      }
    })();
  }, []);

  const persist = async (next) => {
    if (loadFailed) {
      setSaveMsg("Archivio non raggiungibile: non salvo per non sovrascrivere i dati esistenti. Ricarica la pagina.");
      return;
    }
    setOpps(next);
    try {
      await kvSet(OPP_KEY, next);
      setSaveMsg("Salvato ✓");
    } catch (e) {
      setSaveMsg("Errore nel salvataggio");
    }
    setTimeout(() => setSaveMsg(""), 2500);
  };

  const set = (k, v) => setD((x) => ({ ...x, [k]: v }));
  const refs = buildRefs(rows, d);
  const est = estimateOpp(refs, d);
  const keyInfoUI = keyInfoOf(refs, d);
  const T = Number(d.target) || 0;
  const verdict = est ? verdictOf(est, T) : null;
  const toneColor = verdict ? c[verdict.tone] : c.inkSoft;

  const saveOpp = () => {
    const entry = {
      ...d,
      id: d.id || Math.random().toString(36).slice(2, 10),
      ts: new Date().toISOString(),
      roiAtteso: est ? est.base.atteso.roi : null,
      roiPrudente: est ? est.base.prudente.roi : null,
      verdetto: verdict ? verdict.t : "",
    };
    const list = opps || [];
    const exists = list.some((o) => o.id === entry.id);
    persist(exists ? list.map((o) => (o.id === entry.id ? entry : o)) : [...list, entry]);
    setD({ ...entry });
  };

  const th = { padding: "0 10px 8px", textAlign: "left", fontWeight: 500, whiteSpace: "nowrap" };
  const td = { padding: "9px 10px", borderTop: `1px solid ${c.border}`, whiteSpace: "nowrap", fontSize: 13, color: c.ink };
  const num = { ...td, textAlign: "right", fontFamily: "'JetBrains Mono', monospace" };
  const roiColor = (v) => (v >= T ? c.green : v >= 0 ? c.amber : c.red);

  const scen = (title, s, note) => (
    <div style={{ background: c.surfaceAlt, border: `1px solid ${c.border}`, borderRadius: 12, padding: "14px 16px" }}>
      <div style={{ ...styles.chipLabel, marginBottom: 2 }}>{title}</div>
      <div style={{ fontSize: 11.5, color: c.inkFaint, marginBottom: 10 }}>{note}</div>
      {[
        ["Costi totali", eur(s.costi)],
        ["Ricavi", eur(s.ricavi)],
        ["Utile lordo", eur(s.utile)],
      ].map(([k, v]) => (
        <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "3px 0", color: c.inkSoft }}>
          <span>{k}</span>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", color: c.ink }}>{v}</span>
        </div>
      ))}
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, paddingTop: 8, borderTop: `1px solid ${c.border}` }}>
        <span style={{ fontSize: 12, color: c.inkSoft }}>ROI lordo</span>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, color: roiColor(s.roi) }}>{pct(s.roi)}</span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
        <span style={{ fontSize: 12, color: c.inkSoft }}>ROI netto annualizzato</span>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", color: c.ink }}>{pct(s.roiNetAnn)}</span>
      </div>
    </div>
  );

  const selectOpt = (key, options, ph) => (
    <select style={styles.select} value={d[key]} onChange={(e) => set(key, e.target.value)}>
      <option value="">{ph}</option>
      {options.map((o) => (
        <option key={o} value={o}>{o}</option>
      ))}
    </select>
  );

  return (
    <>
      <section style={styles.section} className="section-card no-print">
        <div style={styles.sectionHeadRow}>
          <div style={styles.eyebrowSmall}>Nuova opportunità</div>
          <div style={{ ...styles.chipLabel, textTransform: "none" }}>
            stima dai tuoi progetti · senza oneri finanziari
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 14 }}>
          <Field ui={ui} label="Nome / indirizzo">
            <input style={styles.input} placeholder="es. Via Roma 12" value={d.nome} onChange={(e) => set("nome", e.target.value)} />
          </Field>
          <Field ui={ui} label="Comune">
            <input style={styles.input} value={d.comune} onChange={(e) => set("comune", e.target.value)} />
          </Field>
          <Field ui={ui} label="Mq totali">
            <ui.NumberField style={styles.input} value={d.mq} onChange={(v) => set("mq", v)} />
          </Field>
          <Field ui={ui} label="Prezzo di acquisto (€)">
            <ui.NumberField style={styles.input} value={d.prezzo} onChange={(v) => set("prezzo", v)} />
          </Field>
          <Field ui={ui} label="Tipologia">{selectOpt("tipologia", TIPOLOGIE, "—")}</Field>
          <Field ui={ui} label="Durata prevista (mesi)">
            <input style={styles.input} inputMode="numeric" value={d.durata} onChange={(e) => set("durata", e.target.value.replace(/\D/g, ""))} />
          </Field>
          <Field ui={ui} label="ROI lordo desiderato (%)">
            <input style={styles.input} inputMode="numeric" value={d.target} onChange={(e) => set("target", e.target.value.replace(/\D/g, ""))} />
          </Field>
          <Field ui={ui} label="Valore zona OMI €/mq (facoltativo)">
            <ui.NumberField style={styles.input} value={d.omi} onChange={(v) => set("omi", v)} />
          </Field>
          <Field ui={ui} label="Vendita totale attesa dal venditore (€, facoltativo)">
            <ui.NumberField style={styles.input} value={d.venditore} onChange={(v) => set("venditore", v)} />
          </Field>
        </div>

        <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <button
            type="button"
            role="switch"
            aria-checked={!!d.pesaVenditore}
            style={styles.pieSwitchBtn}
            onClick={() => set("pesaVenditore", !d.pesaVenditore)}
          >
            <span>Considera l’aspettativa del venditore nella stima attesa</span>
            <span style={{ ...styles.pieSwitchTrack, background: d.pesaVenditore ? c.teal : c.border }}>
              <span style={{ ...styles.pieSwitchKnob, left: d.pesaVenditore ? 18 : 2 }} />
            </span>
          </button>
          {d.pesaVenditore && (
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: c.inkSoft }}>
              Peso
              <input
                style={{ ...styles.input, width: 64, textAlign: "right" }}
                inputMode="numeric"
                value={d.pesoVenditore}
                onChange={(e) => set("pesoVenditore", e.target.value.replace(/\D/g, "").slice(0, 2))}
              />
              % (max 50)
            </label>
          )}
          {d.pesaVenditore && !(Number(d.venditore) > 0) && (
            <span style={{ fontSize: 12, color: c.amber }}>Inserisci la vendita attesa dal venditore per attivarlo.</span>
          )}
        </div>

        <div style={{ marginTop: 20 }}>
          <div style={{ ...styles.chipLabel, marginBottom: 4 }}>Intensità dei lavori principali</div>
          <div style={{ fontSize: 12, color: c.inkFaint, marginBottom: 10 }}>
            Il costo di ogni livello non è deciso da te: viene dai €/mq reali dei tuoi progetti.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: 14 }}>
            {keyInfoUI.map((k) => (
              <div key={k.cat} style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
                <span style={styles.chipLabel}>{k.cat}</span>
                <select
                  style={styles.select}
                  value={k.choice}
                  onChange={(e) => setD((x) => ({ ...x, livelli: { ...(x.livelli || {}), [k.cat]: e.target.value } }))}
                >
                  <option value="nessuno">Nessun intervento</option>
                  <option value="basso">Basso</option>
                  <option value="medio">Medio</option>
                  <option value="alto">Alto</option>
                </select>
                <span style={{ fontSize: 11.5, color: c.inkSoft, lineHeight: 1.4 }}>
                  {k.choice !== "nessuno" && KEY_CRITERIA[k.cat][k.choice] ? `${k.choice[0].toUpperCase() + k.choice.slice(1)}: ${KEY_CRITERIA[k.cat][k.choice]}. ` : ""}
                </span>
                <span style={{ fontSize: 11.5, color: c.inkFaint, fontFamily: "'JetBrains Mono', monospace" }}>
                  {k.lev
                    ? `${eur(k.lev.basso)} · ${eur(k.lev.medio)} · ${eur(k.lev.alto)} /mq (${k.n} ${k.n === 1 ? "progetto" : "progetti"}${k.lev.assumed ? ", ipotesi" : ""})`
                    : "nessun dato ancora"}
                </span>
              </div>
            ))}
          </div>
        </div>

        {!est && (
          <div style={{ ...styles.tableEmpty, marginTop: 18 }}>
            {refs.length === 0
              ? "Per attivare la stima serve almeno un progetto “In corso” o “Concluso” con mq, costi e prezzi di vendita inseriti (vedi la Scheda scouting di ogni progetto)."
              : "Inserisci i mq dell’immobile per vedere la stima."}
          </div>
        )}

        {est && verdict && (
          <>
            <div style={{ marginTop: 22, display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
              <span style={{ fontFamily: "'Sora', sans-serif", fontWeight: 700, fontSize: 22, color: toneColor }}>{verdict.t}</span>
              <span style={{ fontSize: 13, color: c.inkSoft }}>{verdict.d}</span>
            </div>

            <GradientBar est={est} T={T} ui={ui} />

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 12 }}>
              {scen("Prudente", est.base.prudente, "costi alti, prezzi bassi")}
              {scen("Atteso", est.base.atteso, est.useVen ? `progetti simili + ${Math.round(est.wVen * 100)}% venditore` : "medie dei progetti simili")}
              {scen("Ottimista", est.base.ottimista, "costi bassi, prezzi alti")}
              {est.base.venditore &&
                scen(
                  "Venditore",
                  est.base.venditore,
                  `costi attesi · ${eur(est.venPerSqm)}/mq (${est.venVsAtteso >= 0 ? "+" : ""}${est.venVsAtteso.toFixed(0)}% vs atteso)`
                )}
            </div>

            <div style={styles.chipsRow}>
              <div style={styles.chip}>
                <span style={styles.chipLabel}>Lavori / mq (prud. – atteso – ott.)</span>
                <span style={styles.chipValue}>
                  {eur(est.cost.high)} · {eur(est.cost.mid)} · {eur(est.cost.low)}
                </span>
              </div>
              <div style={styles.chip}>
                <span style={styles.chipLabel}>Prezzo vendita / mq (prud. – atteso – ott.)</span>
                <span style={styles.chipValue}>
                  {eur(est.price.low)} · {eur(est.price.mid)} · {eur(est.price.high)}
                </span>
              </div>
            </div>

            <div style={{ ...styles.chipsRow, marginTop: 10 }}>
              <div style={{ ...styles.chip, ...styles.chipTotal }}>
                <span style={styles.chipLabel}>Prezzo max di acquisto per ROI {T}% (atteso)</span>
                <span style={styles.chipValue}>{eur(Math.max(0, est.maxAtteso))}</span>
              </div>
              <div style={styles.chip}>
                <span style={styles.chipLabel}>…con scenario prudente</span>
                <span style={styles.chipValue}>{eur(Math.max(0, est.maxPrudente))}</span>
              </div>
              {est.maxVenditore !== null && (
                <div style={styles.chip}>
                  <span style={styles.chipLabel}>…se vendi come dice il venditore</span>
                  <span style={styles.chipValue}>{eur(Math.max(0, est.maxVenditore))}</span>
                </div>
              )}
              <div style={styles.chip}>
                <span style={styles.chipLabel}>Pareggio (prudente, ROI 0%)</span>
                <span style={styles.chipValue}>{eur(Math.max(0, est.breakEven))}</span>
              </div>
            </div>

            {est.omiCheck && (
              <div style={{ fontSize: 12.5, color: c.inkSoft, marginTop: 14 }}>
                {est.omiCheck.n > 0 ? (
                  <>
                    Controllo con valore zona: i tuoi progetti hanno venduto in media al{" "}
                    <b>{(est.omiCheck.ratio * 100).toFixed(0)}%</b> del valore OMI, che qui darebbe circa{" "}
                    <b>{eur(est.omiCheck.priceFromOmi)}/mq</b> contro {eur(est.priceModel.mid)}/mq della stima dai tuoi progetti
                    ({est.priceModel.mid > 0 ? (((est.omiCheck.priceFromOmi - est.priceModel.mid) / est.priceModel.mid) * 100).toFixed(0) : 0}% di differenza).
                  </>
                ) : (
                  <>Per attivare il controllo con il valore zona, compila “Valore zona OMI” anche nelle schede dei progetti passati.</>
                )}
              </div>
            )}

            <div style={{ marginTop: 22 }}>
              <div style={{ ...styles.eyebrowSmall, marginBottom: 10 }}>Se cambia il prezzo di acquisto</div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 560 }}>
                  <thead>
                    <tr style={{ ...styles.tableHeaderRow, display: "table-row" }}>
                      <th style={th}>Acquisto</th>
                      <th style={{ ...th, textAlign: "right" }}>ROI prudente</th>
                      <th style={{ ...th, textAlign: "right" }}>ROI atteso</th>
                      <th style={{ ...th, textAlign: "right" }}>ROI ottimista</th>
                      {est.base.venditore && <th style={{ ...th, textAlign: "right" }}>ROI venditore</th>}
                      <th style={{ ...th, textAlign: "right" }}>Utile atteso</th>
                    </tr>
                  </thead>
                  <tbody>
                    {est.sensitivity.map((r) => (
                      <tr key={r.dp} style={r.dp === 0 ? { background: c.surfaceAlt } : undefined}>
                        <td style={td}>
                          {eur(r.acq)} <span style={{ color: c.inkFaint, fontSize: 11 }}>{r.dp === 0 ? "base" : `${r.dp > 0 ? "+" : ""}${r.dp}%`}</span>
                        </td>
                        <td style={{ ...num, color: roiColor(r.prudente.roi) }}>{pct(r.prudente.roi)}</td>
                        <td style={{ ...num, color: roiColor(r.atteso.roi) }}>{pct(r.atteso.roi)}</td>
                        <td style={{ ...num, color: roiColor(r.ottimista.roi) }}>{pct(r.ottimista.roi)}</td>
                        {r.venditore && <td style={{ ...num, color: roiColor(r.venditore.roi) }}>{pct(r.venditore.roi)}</td>}
                        <td style={num}>{eur(r.atteso.utile)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div style={{ marginTop: 18, padding: "12px 14px", borderRadius: 10, border: `1px solid ${c.border}`, fontSize: 12.5, color: c.inkSoft, lineHeight: 1.5 }}>
              <b style={{ color: c.ink }}>
                Affidabilità {est.n >= 8 && est.concl >= 8 ? "buona" : est.n >= 3 ? "media" : "bassa"} · basata su {est.n}{" "}
                {est.n === 1 ? "progetto" : "progetti"} ({est.concl} conclusi)
              </b>
              {est.warnings.map((w, i) => (
                <div key={i} style={{ marginTop: 4 }}>• {w}</div>
              ))}
              <div style={{ marginTop: 4 }}>
                • Le fasce sono le medie dei progetti simili con almeno ±15%. Non sono previsioni statistiche: cambiano man mano che aggiungi progetti.
              </div>
            </div>
          </>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 20, flexWrap: "wrap" }}>
          <button style={styles.addRowBtn} onClick={saveOpp}>
            {d.id ? "Aggiorna opportunità salvata" : "Salva questa opportunità"}
          </button>
          {d.id && (
            <button style={styles.addProjectBtn} onClick={() => setD(newDraft())}>Nuova valutazione</button>
          )}
          <span style={{ fontSize: 12.5, color: c.inkSoft }}>{saveMsg}</span>
        </div>
      </section>

      <section style={styles.section} className="section-card no-print">
        <div style={styles.sectionHeadRow}>
          <div style={styles.eyebrowSmall}>Archivio opportunità valutate</div>
        </div>
        {loadFailed && (
          <div style={{ fontSize: 12.5, color: c.red, marginBottom: 10 }}>
            Archivio non raggiungibile in questo momento: ricarica la pagina.
          </div>
        )}
        {(!opps || opps.length === 0) && (
          <div style={styles.tableEmpty}>
            Nessuna opportunità salvata. Salva anche quelle che scarti: tra qualche mese saranno il tuo storico dei prezzi di zona.
          </div>
        )}
        {opps && opps.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 800 }}>
              <thead>
                <tr style={{ ...styles.tableHeaderRow, display: "table-row" }}>
                  <th style={th}>Opportunità</th>
                  <th style={th}>Comune</th>
                  <th style={{ ...th, textAlign: "right" }}>Mq</th>
                  <th style={{ ...th, textAlign: "right" }}>Acquisto</th>
                  <th style={{ ...th, textAlign: "right" }}>€/mq</th>
                  <th style={{ ...th, textAlign: "right" }}>ROI atteso*</th>
                  <th style={th}>Giudizio*</th>
                  <th style={th}>Esito</th>
                  <th style={th} />
                </tr>
              </thead>
              <tbody>
                {opps.map((o) => (
                  <tr key={o.id}>
                    <td style={td}>{o.nome || "Senza nome"}</td>
                    <td style={td}>{o.comune || "—"}</td>
                    <td style={num}>{o.mq || "—"}</td>
                    <td style={num}>{o.prezzo ? eur(o.prezzo) : "—"}</td>
                    <td style={num}>{o.mq > 0 && o.prezzo > 0 ? eur(o.prezzo / o.mq) : "—"}</td>
                    <td style={num}>{o.roiAtteso == null ? "—" : pct(o.roiAtteso)}</td>
                    <td style={td}>{o.verdetto || "—"}</td>
                    <td style={td}>
                      <select
                        style={{ ...styles.select, padding: "6px 8px" }}
                        value={o.esito || "valutata"}
                        onChange={(e) => persist(opps.map((x) => (x.id === o.id ? { ...x, esito: e.target.value } : x)))}
                      >
                        {ESITI.map((e) => (
                          <option key={e.v} value={e.v}>{e.label}</option>
                        ))}
                      </select>
                    </td>
                    <td style={{ ...td, textAlign: "right" }}>
                      <button
                        style={{ background: "none", border: "none", color: c.teal, cursor: "pointer", fontSize: 13, marginRight: 10 }}
                        onClick={() => {
                          setD({ ...newDraft(), ...o });
                          window.scrollTo({ top: 0, behavior: "smooth" });
                        }}
                      >
                        Riapri
                      </button>
                      <button
                        style={{ background: "none", border: "none", color: c.red, cursor: "pointer", fontSize: 16 }}
                        aria-label="Elimina"
                        onClick={() => {
                          if (window.confirm("Eliminare questa opportunità dall’archivio?")) persist(opps.filter((x) => x.id !== o.id));
                        }}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ fontSize: 12, color: c.inkFaint, marginTop: 12 }}>
          * ROI e giudizio sono quelli calcolati al momento del salvataggio, con lo storico di allora. “Riapri” li ricalcola con i dati attuali.
        </div>
      </section>
    </>
  );
}


// =====================================================================
// FASCE DI COSTO APPRESE — cosa significano "basso / medio / alto" in €/mq
// =====================================================================
function LearnedBands({ rows, ui }) {
  const { styles, eur } = ui;
  const c = ui.colors;
  const refs = buildRefs(rows, {});
  const th = { padding: "0 10px 8px", textAlign: "left", fontWeight: 500, whiteSpace: "nowrap" };
  const td = { padding: "10px", borderTop: `1px solid ${c.border}`, fontSize: 13, color: c.ink, verticalAlign: "top" };
  const num = { ...td, textAlign: "right", fontFamily: "'JetBrains Mono', monospace", whiteSpace: "nowrap" };

  return (
    <section style={styles.section} className="section-card no-print">
      <div style={styles.sectionHeadRow}>
        <div style={styles.eyebrowSmall}>Fasce di costo apprese (€/mq)</div>
      </div>
      <div style={{ fontSize: 12.5, color: c.inkSoft, marginBottom: 14, lineHeight: 1.5 }}>
        Basso, medio e alto non sono giudizi: sono calcolati dai costi reali al mq dei tuoi progetti e si aggiornano
        da soli. Con meno di 3 progetti sono ipotesi; da 3 in su il livello di ogni progetto viene assegnato in automatico.
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 760 }}>
          <thead>
            <tr style={{ ...styles.tableHeaderRow, display: "table-row" }}>
              <th style={th}>Voce</th>
              <th style={{ ...th, textAlign: "right" }}>Basso</th>
              <th style={{ ...th, textAlign: "right" }}>Medio</th>
              <th style={{ ...th, textAlign: "right" }}>Alto</th>
              <th style={{ ...th, textAlign: "right" }}>Progetti</th>
              <th style={th}>Dettaglio per progetto</th>
            </tr>
          </thead>
          <tbody>
            {KEY_CATS.map((cat) => {
              const obs = refs.filter((r) => r.sm.catPerSqm[cat] > 0);
              const lev = levelsFor(obs.map((r) => r.sm.catPerSqm[cat]));
              return (
                <tr key={cat}>
                  <td style={td}>{cat}</td>
                  <td style={num}>{lev ? eur(lev.basso) : "—"}</td>
                  <td style={num}>{lev ? eur(lev.medio) : "—"}</td>
                  <td style={num}>{lev ? eur(lev.alto) : "—"}</td>
                  <td style={num}>{obs.length}{lev && lev.assumed ? " (ipotesi)" : ""}</td>
                  <td style={td}>
                    {obs.length === 0 && <span style={{ color: c.inkFaint }}>nessun dato</span>}
                    {obs.map((r) => {
                      const v = r.sm.catPerSqm[cat];
                      const lvl = levelOf(v, lev);
                      return (
                        <div key={r.p.id} style={{ fontSize: 12.5, color: c.inkSoft, lineHeight: 1.6 }}>
                          {r.p.name || "Senza nome"}: <b style={{ color: c.ink }}>{eur(v)}/mq</b>
                          {lvl ? ` → ${lvl}` : ""}
                          <span style={{ color: c.inkFaint }}> · {r.sm.catFinal[cat] ? "definitivo" : "preventivo"}</span>
                        </div>
                      );
                    })}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 12, color: c.inkFaint, marginTop: 12 }}>
        Fasce: basso ≈ 15° percentile, medio = mediana, alto ≈ 85° percentile, con almeno ±15% attorno al medio.
        Entrano nel calcolo i progetti “In corso” o “Concluso” con mq e prezzi inseriti.
      </div>
    </section>
  );
}
