import React from "react";

// ---------------------------------------------------------------
// SCOUTING — scheda per progetto + pagina di confronto
// Tutti i campi sono opzionali. Nessun dato viene toccato negli altri
// progetti: la scheda salva solo dentro project.scouting.
// ---------------------------------------------------------------

const TIPOLOGIE = ["Appartamento", "Villa", "Palazzina", "Altro"];
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
  const revRealPct = m.unitsRevenue > 0 ? (soldRev / m.unitsRevenue) * 100 : 0;
  // percentuale di dati reali: media fra costi definitivi e ricavi venduti
  const realPct = (costsRealPct + revRealPct) / 2;

  const iIn = CLASSI.indexOf(s.classeInizio);
  const iOut = CLASSI.indexOf(s.classeFine);
  const salto = iIn >= 0 && iOut >= 0 ? iOut - iIn : null;

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

      <div style={{ marginTop: 14 }}>
        <Field ui={ui} label="Nota sulla zona (facoltativa)">
          <input
            style={styles.input}
            placeholder="es. vicino al lago, zona servita, molta richiesta…"
            value={s.zonaNota ?? ""}
            onChange={(e) => set("zonaNota", e.target.value)}
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
    <div className="no-print" style={{ display: "flex", gap: 8, marginBottom: 18 }}>
      {/* regola usata per nascondere le linguette dei progetti nella vista Scouting */}
      <style>{`.hidden-view { display: none !important; }`}</style>
      {[
        { v: "projects", label: "Progetti" },
        { v: "scouting", label: "Scouting" },
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
    </>
  );
}
