import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts";
import jsPDF from "jspdf";
import { kvGet, kvSet } from "./supabaseClient";

// ---------- helpers ----------
const uid = () => Math.random().toString(36).slice(2, 10);

const eur = (n) =>
  new Intl.NumberFormat("it-IT", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
    useGrouping: "always",
  }).format(Number.isFinite(n) ? n : 0);

const pct = (n) => `${Number.isFinite(n) ? n.toFixed(1) : "0.0"}%`;

const CATEGORIES = [
  "Acquisto",
  "Preliminare",
  "Notaio",
  "Imp. registro + altre cat",
  "Spese legali",
  "Giardiniere",
  "Opere murarie",
  "Tinteggiatura Esterna",
  "Geometra",
  "Pratiche comune",
  "Acqua",
  "Luce",
  "Fabbro",
  "Garage",
  "Tinteggiatura Interna",
  "Opere elettriche",
  "Opere idrauliche",
  "Piastrelle e posa",
  "Posto auto",
  "Corrimani Balconi",
  "Serramenti e falegnameria",
  "Fondo rischi",
  "Spesa struttura",
  "IMU",
  "Commissione Agenzia",
  "Oneri Comunali",
  "Altro",
];

const seedProjects = () => [
  {
    id: uid(),
    name: "Residenza Valzella",
    location: "Ardesio",
    taxRate: 28,
    capital: { total: 502245, equityShare: 100, rate: 5, months: 18 },
    durationMonths: 18,
    costs: [
      { id: uid(), category: "Acquisto", desc: "", amount: 145000 },
      { id: uid(), category: "Preliminare", desc: "", amount: 178 },
      { id: uid(), category: "Notaio", desc: "", amount: 2130 },
      { id: uid(), category: "Imp. registro + altre cat", desc: "", amount: 13200 },
      { id: uid(), category: "Spese legali", desc: "", amount: 307.28 },
      { id: uid(), category: "Giardiniere", desc: "", amount: 3000 },
      { id: uid(), category: "Opere murarie", desc: "+ tinteggiatura esterna (importo combinato)", amount: 62800 },
      { id: uid(), category: "Tinteggiatura Esterna", desc: "incluso in Opere murarie sopra", amount: 0 },
      { id: uid(), category: "Geometra", desc: "", amount: 15000 },
      { id: uid(), category: "Pratiche comune", desc: "", amount: 5000 },
      { id: uid(), category: "Acqua", desc: "", amount: 1000 },
      { id: uid(), category: "Luce", desc: "", amount: 3000 },
      { id: uid(), category: "Fabbro", desc: "", amount: 8930 },
      { id: uid(), category: "Garage", desc: "Basculante autorimessa", amount: 2000 },
      { id: uid(), category: "Tinteggiatura Interna", desc: "", amount: 28500 },
      { id: uid(), category: "Opere elettriche", desc: "", amount: 18000 },
      { id: uid(), category: "Opere idrauliche", desc: "", amount: 24000 },
      { id: uid(), category: "Piastrelle e posa", desc: "", amount: 27000 },
      { id: uid(), category: "Posto auto", desc: "esterno", amount: 5000 },
      { id: uid(), category: "Corrimani Balconi", desc: "", amount: 9500 },
      { id: uid(), category: "Serramenti e falegnameria", desc: "", amount: 74000 },
      { id: uid(), category: "Fondo rischi", desc: "", amount: 40000 },
      { id: uid(), category: "Spesa struttura", desc: "", amount: 13200 },
      { id: uid(), category: "Altro", desc: "Muro da intonacare", amount: 1500 },
    ],
    units: [
      { id: uid(), label: "A1 – Trilocale sx", floor: "T", sqm: 0, giardino: false, terrazzo: false, price: 139000 },
      { id: uid(), label: "B2 – Trilocale dx", floor: "T", sqm: 0, giardino: false, terrazzo: false, price: 135000 },
      { id: uid(), label: "C3 – Trilocale sx", floor: "1", sqm: 0, giardino: false, terrazzo: false, price: 135000 },
      { id: uid(), label: "D4 – Trilocale dx", floor: "1", sqm: 0, giardino: false, terrazzo: false, price: 130000 },
      { id: uid(), label: "E5 – Trilocale sx", floor: "2", sqm: 0, giardino: false, terrazzo: false, price: 115000 },
      { id: uid(), label: "F6 – Trilocale dx", floor: "2", sqm: 0, giardino: false, terrazzo: false, price: 115000 },
    ],
  },
];

// ---------- computation ----------
function computeProject(p) {
  const totalCosts = p.costs.reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const totalRevenue = p.units.reduce((s, u) => s + (Number(u.price) || 0), 0);
  const totalSqm = p.units.reduce((s, u) => s + (Number(u.sqm) || 0), 0);
  const totalCapital = Number(p.capital.total) || 0;
  const equityShare = Number.isFinite(Number(p.capital.equityShare)) ? Number(p.capital.equityShare) : 100;
  const equity = totalCapital * (equityShare / 100);
  const financed = totalCapital - equity;
  const rate = Number(p.capital.rate) || 0;
  const months = Number(p.capital.months) || 0;
  const financingCost = financed * (rate / 100) * (months / 12);
  const grossProfit = totalRevenue - totalCosts - financingCost;
  const taxRate = Number(p.taxRate) || 0;
  const taxes = grossProfit > 0 ? grossProfit * (taxRate / 100) : 0;
  const netProfit = grossProfit - taxes;
  const roiGross = totalCapital > 0 ? (grossProfit / totalCapital) * 100 : 0;
  const roiNet = equity > 0 ? (netProfit / equity) * 100 : 0;
  const durationMonths = Number(p.durationMonths) || 0;
  const roiGrossAnnualized = durationMonths > 0 ? roiGross * (12 / durationMonths) : 0;
  const roiNetAnnualized = durationMonths > 0 ? roiNet * (12 / durationMonths) : 0;
  const avgPricePerSqm = totalSqm > 0 ? totalRevenue / totalSqm : 0;

  const effectiveLabel = (c) => (c.category === "Altro" ? (c.desc?.trim() || "Altro") : c.category);
  const labelTotals = new Map();
  p.costs.forEach((c) => {
    const label = effectiveLabel(c);
    labelTotals.set(label, (labelTotals.get(label) || 0) + (Number(c.amount) || 0));
  });
  const byCategory = Array.from(labelTotals.entries())
    .map(([cat, amount]) => ({ cat, amount }))
    .filter((c) => c.amount > 0);

  return {
    totalCosts,
    totalRevenue,
    totalSqm,
    equity,
    financed,
    financingCost,
    totalCapital,
    equityShare,
    grossProfit,
    taxes,
    netProfit,
    roiGross,
    roiNet,
    durationMonths,
    roiGrossAnnualized,
    roiNetAnnualized,
    avgPricePerSqm,
    byCategory,
  };
}

// ---------- printable report ----------
function buildReportHtml(project, metrics) {
  const bgC = "#0A0E16";
  const surfaceC = "#131A26";
  const surfaceAltC = "#1B2433";
  const borderC = "#242D3F";
  const inkC = "#EDF1F7";
  const inkSoftC = "#8A93A8";
  const inkFaintC = "#5C6478";
  const tealC = "#2FD9C4";
  const amberC = "#F0B429";
  const greenC = "#3ECF8E";
  const redC = "#F2555F";

  const maxBar = Math.max(metrics.totalRevenue, 1);
  const barPct = (v) => Math.min(100, Math.max(0, (Math.abs(v) / maxBar) * 100));

  const ledgerRow = (label, value, pctW, color, strong) => `
    <div style="display:grid;grid-template-columns:170px 1fr 140px;align-items:center;gap:12px;margin-bottom:10px;">
      <div style="font-size:13px;color:${strong ? inkC : inkSoftC};font-weight:${strong ? 600 : 400};">${label}</div>
      <div style="height:8px;background:${surfaceAltC};border-radius:4px;overflow:hidden;">
        <div style="height:100%;width:${pctW}%;background:${color};border-radius:4px;"></div>
      </div>
      <div style="font-family:'JetBrains Mono',monospace;font-size:${strong ? 15 : 13}px;font-weight:${strong ? 700 : 400};text-align:right;color:${strong ? inkC : inkFaintC};">${value}</div>
    </div>`;

  const kpi = (label, value, sub, color) => `
    <div style="background:${surfaceAltC};border:1px solid ${borderC};border-radius:12px;padding:14px 16px;">
      <div style="font-family:'JetBrains Mono',monospace;font-size:10.5px;letter-spacing:1px;text-transform:uppercase;color:${inkSoftC};">${label}</div>
      <div style="font-family:'Sora',sans-serif;font-weight:700;font-size:24px;margin:6px 0 2px;color:${color || inkC};">${value}</div>
      <div style="font-size:11.5px;color:${inkFaintC};">${sub}</div>
    </div>`;

  const costsRows = project.costs
    .map((c) => {
      const label = c.category === "Altro" ? c.desc?.trim() || "Altro" : c.category;
      const desc = c.category === "Altro" ? "" : c.desc || "";
      return `<tr>
        <td style="padding:8px 10px;border-bottom:1px solid ${borderC};font-size:13px;color:${inkC};">${label}</td>
        <td style="padding:8px 10px;border-bottom:1px solid ${borderC};font-size:13px;color:${inkSoftC};">${desc}</td>
        <td style="padding:8px 10px;border-bottom:1px solid ${borderC};font-size:13px;color:${inkC};text-align:right;font-family:'JetBrains Mono',monospace;">${eur(Number(c.amount) || 0)}</td>
      </tr>`;
    })
    .join("");

  const unitsRows = project.units
    .map(
      (u) => `<tr>
        <td style="padding:8px 10px;border-bottom:1px solid ${borderC};font-size:13px;color:${inkC};">${u.label}</td>
        <td style="padding:8px 10px;border-bottom:1px solid ${borderC};font-size:13px;color:${inkSoftC};text-align:center;">${u.floor || "—"}</td>
        <td style="padding:8px 10px;border-bottom:1px solid ${borderC};font-size:13px;color:${inkSoftC};text-align:center;">${u.sqm || 0}</td>
        <td style="padding:8px 10px;border-bottom:1px solid ${borderC};font-size:13px;color:${inkSoftC};text-align:center;">${u.giardino ? "✓" : "—"}</td>
        <td style="padding:8px 10px;border-bottom:1px solid ${borderC};font-size:13px;color:${inkSoftC};text-align:center;">${u.terrazzo ? "✓" : "—"}</td>
        <td style="padding:8px 10px;border-bottom:1px solid ${borderC};font-size:13px;color:${inkC};text-align:right;font-family:'JetBrains Mono',monospace;">${eur(Number(u.price) || 0)}</td>
      </tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8" />
<title>Report — ${project.name}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@600;700;800&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin:0; background:${bgC}; color:${inkC}; font-family:'Inter',sans-serif; padding:28px; }
  .section { background:${surfaceC}; border:1px solid ${borderC}; border-radius:16px; padding:22px 22px 24px; margin-bottom:18px; break-inside: avoid; }
  .eyebrow { font-family:'JetBrains Mono',monospace; font-size:11px; letter-spacing:1.4px; text-transform:uppercase; color:${inkSoftC}; margin-bottom:14px; }
  table { width:100%; border-collapse: collapse; margin-top: 6px; }
  th { text-align:left; font-family:'JetBrains Mono',monospace; font-size:11px; letter-spacing:0.6px; text-transform:uppercase; color:${inkFaintC}; padding:0 10px 8px; }
  .kpiRow { display:grid; grid-template-columns: repeat(auto-fit, minmax(170px,1fr)); gap:14px; margin-top:20px; }
  @page { margin: 14mm; }
</style>
</head>
<body>
  <div style="font-family:'JetBrains Mono',monospace;font-size:11px;color:${inkSoftC};margin-bottom:18px;line-height:1.6;">
    Gruppo Endine Sviluppo · Conto economico di progetto<br/>
    ${project.name}${project.location ? " — " + project.location : ""} — generato il ${new Date().toLocaleString("it-IT")}
  </div>

  <div class="section">
    <div class="eyebrow">Risultato economico · durata intervento ${metrics.durationMonths} mesi</div>
    ${ledgerRow("Ricavi totali", eur(metrics.totalRevenue), barPct(metrics.totalRevenue), tealC)}
    ${ledgerRow("Costi di progetto", "− " + eur(metrics.totalCosts), barPct(metrics.totalCosts), inkFaintC)}
    ${ledgerRow("Costo del finanziamento", "− " + eur(metrics.financingCost), barPct(metrics.financingCost), amberC)}
    <div style="height:1px;background:${borderC};margin:10px 0;"></div>
    ${ledgerRow("Utile lordo", eur(metrics.grossProfit), barPct(metrics.grossProfit), metrics.grossProfit >= 0 ? greenC : redC, true)}
    ${ledgerRow("Imposte", "− " + eur(metrics.taxes), barPct(metrics.taxes), inkFaintC)}
    ${ledgerRow("Utile netto", eur(metrics.netProfit), barPct(metrics.netProfit), metrics.netProfit >= 0 ? greenC : redC, true)}

    <div class="kpiRow">
      ${kpi("Capitale investito", eur(metrics.totalCapital), "proprio + finanziato")}
      ${kpi("ROI lordo", pct(metrics.roiGross), `sull'intervento (${metrics.durationMonths} mesi)`, metrics.roiGross >= 0 ? greenC : redC)}
      ${kpi("ROI netto", pct(metrics.roiNet), `sull'intervento (${metrics.durationMonths} mesi)`, metrics.roiNet >= 0 ? greenC : redC)}
    </div>
    <div class="kpiRow">
      ${kpi("ROI lordo annualizzato", pct(metrics.roiGrossAnnualized), "ritarato su base 12 mesi", metrics.roiGrossAnnualized >= 0 ? greenC : redC)}
      ${kpi("ROI netto annualizzato", pct(metrics.roiNetAnnualized), "ritarato su base 12 mesi", metrics.roiNetAnnualized >= 0 ? greenC : redC)}
    </div>
  </div>

  <div class="section">
    <div class="eyebrow">Struttura del capitale</div>
    <div style="display:flex;justify-content:space-between;margin-bottom:8px;font-family:'JetBrains Mono',monospace;font-size:12.5px;font-weight:600;">
      <span style="color:${tealC};">Capitale proprio · ${eur(metrics.equity)} (${metrics.equityShare.toFixed(0)}%)</span>
      <span style="color:${amberC};">Capitale finanziato · ${eur(metrics.financed)} (${(100 - metrics.equityShare).toFixed(0)}%)</span>
    </div>
    <div style="display:flex;height:10px;border-radius:6px;overflow:hidden;border:1px solid ${borderC};margin-bottom:14px;">
      <div style="width:${metrics.equityShare}%;background:${tealC};"></div>
      <div style="width:${100 - metrics.equityShare}%;background:${amberC};"></div>
    </div>
    <div style="font-size:12.5px;color:${inkSoftC};line-height:1.9;">
      Tasso annuo finanziamento: <strong style="color:${inkC};">${project.capital.rate}%</strong> ·
      Durata finanziamento: <strong style="color:${inkC};">${project.capital.months} mesi</strong> ·
      Aliquota fiscale: <strong style="color:${inkC};">${project.taxRate}%</strong>
    </div>
  </div>

  <div class="section">
    <div class="eyebrow">Costi di progetto</div>
    <table>
      <thead><tr><th>Categoria</th><th>Descrizione</th><th style="text-align:right;">Importo</th></tr></thead>
      <tbody>${costsRows}</tbody>
    </table>
    <div style="display:flex;justify-content:space-between;margin-top:14px;padding-top:12px;border-top:1px solid ${borderC};font-family:'JetBrains Mono',monospace;font-size:13px;color:${inkSoftC};">
      <span>Totale costi</span><span style="font-size:16px;font-weight:700;color:${tealC};">${eur(metrics.totalCosts)}</span>
    </div>
  </div>

  <div class="section">
    <div class="eyebrow">Unità immobiliari</div>
    <table>
      <thead><tr><th>Unità</th><th style="text-align:center;">Piano</th><th style="text-align:center;">Mq</th><th style="text-align:center;">Giardino</th><th style="text-align:center;">Terrazzo</th><th style="text-align:right;">Prezzo previsto</th></tr></thead>
      <tbody>${unitsRows}</tbody>
    </table>
    <div style="display:flex;gap:24px;margin-top:14px;padding-top:12px;border-top:1px solid ${borderC};font-family:'JetBrains Mono',monospace;font-size:12.5px;color:${inkSoftC};">
      <span>Unità totali: <strong style="color:${inkC};">${project.units.length}</strong></span>
      <span>Mq totali: <strong style="color:${inkC};">${metrics.totalSqm}</strong></span>
           <span>Prezzo medio/mq: <strong style="color:${inkC};">${eur(metrics.avgPricePerSqm)}</strong></span>
    </div>
  </div>

  ${
    project.notes && project.notes.trim()
      ? `<div class="section">
    <div class="eyebrow">Note</div>
    <div style="font-size:13px;color:${inkC};line-height:1.7;white-space:pre-wrap;">${project.notes.trim()}</div>
  </div>`
      : ""
  }
</body>
</html>`;
}


function hexRgb(hex) {
  const h = hex.replace("#", "");
  return [parseInt(h.substring(0, 2), 16), parseInt(h.substring(2, 4), 16), parseInt(h.substring(4, 6), 16)];
}

function generatePdfReport(doc, project, metrics) {
  const marginX = 46;
  const marginTop = 54;
  const marginBottom = 56;
  let y = marginTop;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const contentWidth = pageWidth - marginX * 2;

  const tealC = hexRgb("#1B9E8F");
  const amberC = hexRgb("#C98A1B");
  const greenC = hexRgb("#1F9D5C");
  const redC = hexRgb("#C43A45");
  const grayC = [110, 116, 128];
  const lightGrayC = [225, 225, 225];
  const darkC = [26, 31, 42];

  const newPage = () => {
    doc.addPage();
    y = marginTop;
  };

  const ensureSpace = (h) => {
    if (y + h > pageHeight - marginBottom) newPage();
  };

  const startSection = (minRoom) => {
    if (pageHeight - marginBottom - y < minRoom) newPage();
  };

  const sectionTitle = (label) => {
    ensureSpace(26);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9.5);
    doc.setTextColor(...tealC);
    doc.text(label.toUpperCase(), marginX, y);
    y += 8;
    doc.setDrawColor(...lightGrayC);
    doc.line(marginX, y, pageWidth - marginX, y);
    y += 18;
  };

  const ledgerRow = (label, value, color, strong) => {
    ensureSpace(strong ? 22 : 18);
    doc.setFont("helvetica", strong ? "bold" : "normal");
    doc.setFontSize(strong ? 11.5 : 10);
    doc.setTextColor(...darkC);
    doc.text(label, marginX, y);
    doc.setTextColor(...color);
    doc.text(value, pageWidth - marginX, y, { align: "right" });
    y += strong ? 20 : 16;
  };

  const kpiGrid = (items) => {
    ensureSpace(50);
    const colW = contentWidth / items.length;
    items.forEach((it, i) => {
      const x = marginX + colW * i;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(...grayC);
      doc.text(it.label.toUpperCase(), x, y);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(16);
      doc.setTextColor(...(it.color || darkC));
      doc.text(it.value, x, y + 18);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(...grayC);
      doc.text(it.sub, x, y + 30);
    });
    y += 46;
  };

  const barChart = (items, chartHeight) => {
    const blockHeight = chartHeight + 42;
    startSection(blockHeight + 30);
    ensureSpace(blockHeight);
    const chartTop = y;
    const gap = 18;
    const barWidth = (contentWidth - gap * (items.length - 1)) / items.length;
    const maxVal = Math.max(...items.map((i) => Math.abs(i.value)), 1);

    doc.setDrawColor(...lightGrayC);
    doc.line(marginX, chartTop + chartHeight, pageWidth - marginX, chartTop + chartHeight);

    items.forEach((it, i) => {
      const barH = Math.max((Math.abs(it.value) / maxVal) * (chartHeight - 20), 2);
      const x = marginX + i * (barWidth + gap);
      const barY = chartTop + chartHeight - barH;
      doc.setFillColor(...it.color);
      doc.roundedRect(x, barY, barWidth, barH, 3, 3, "F");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(9);
      doc.setTextColor(...darkC);
      doc.text(eur(it.value), x + barWidth / 2, barY - 7, { align: "center" });
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      doc.setTextColor(...grayC);
      doc.text(it.label, x + barWidth / 2, chartTop + chartHeight + 16, { align: "center" });
    });
    y = chartTop + blockHeight;
  };

  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(...tealC);
  doc.text("GRUPPO ENDINE SVILUPPO", marginX, y);
  y += 20;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(21);
  doc.setTextColor(...darkC);
  doc.text("Conto economico di progetto", marginX, y);
  y += 17;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(...grayC);
  doc.text(
    `${project.name}${project.location ? " — " + project.location : ""} — generato il ${new Date().toLocaleString("it-IT")}`,
    marginX,
    y
  );
  y += 30;

  startSection(260);
  sectionTitle(`Risultato economico · durata ${metrics.durationMonths} mesi`);
  ledgerRow("Ricavi totali", eur(metrics.totalRevenue), tealC);
  ledgerRow("Costi di progetto", "- " + eur(metrics.totalCosts), grayC);
  ledgerRow("Costo del finanziamento", "- " + eur(metrics.financingCost), amberC);
  ensureSpace(16);
  y += 4;
  doc.setDrawColor(...lightGrayC);
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 14;
  ledgerRow("Utile lordo", eur(metrics.grossProfit), metrics.grossProfit >= 0 ? greenC : redC, true);
  ledgerRow("Imposte", "- " + eur(metrics.taxes), grayC);
  ledgerRow("Utile netto", eur(metrics.netProfit), metrics.netProfit >= 0 ? greenC : redC, true);
  y += 16;

  kpiGrid([
    { label: "Capitale investito", value: eur(metrics.totalCapital), sub: "proprio + finanziato" },
    {
      label: "ROI lordo",
      value: pct(metrics.roiGross),
      sub: `sull'intervento (${metrics.durationMonths} mesi)`,
      color: metrics.roiGross >= 0 ? greenC : redC,
    },
    {
      label: "ROI netto",
      value: pct(metrics.roiNet),
      sub: `sull'intervento (${metrics.durationMonths} mesi)`,
      color: metrics.roiNet >= 0 ? greenC : redC,
    },
  ]);
  kpiGrid([
    {
      label: "ROI lordo annualizzato",
      value: pct(metrics.roiGrossAnnualized),
      sub: "base 12 mesi",
      color: metrics.roiGrossAnnualized >= 0 ? greenC : redC,
    },
    {
      label: "ROI netto annualizzato",
      value: pct(metrics.roiNetAnnualized),
      sub: "base 12 mesi",
      color: metrics.roiNetAnnualized >= 0 ? greenC : redC,
    },
  ]);
  y += 8;

  barChart(
    [
      { label: "Ricavi", value: metrics.totalRevenue, color: tealC },
      { label: "Costi", value: metrics.totalCosts, color: grayC },
      { label: "Finanziamento", value: metrics.financingCost, color: amberC },
      { label: "Utile netto", value: metrics.netProfit, color: metrics.netProfit >= 0 ? greenC : redC },
    ],
    100
  );
  y += 12;

  startSection(90);
  sectionTitle("Struttura del capitale");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10.5);
  doc.setTextColor(...tealC);
  doc.text(`Capitale proprio: ${eur(metrics.equity)} (${metrics.equityShare.toFixed(0)}%)`, marginX, y);
  doc.setTextColor(...amberC);
  doc.text(
    `Capitale finanziato: ${eur(metrics.financed)} (${(100 - metrics.equityShare).toFixed(0)}%)`,
    pageWidth - marginX,
    y,
    { align: "right" }
  );
  y += 20;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.5);
  doc.setTextColor(...grayC);
  doc.text(
    `Tasso annuo: ${project.capital.rate}%   ·   Durata finanziamento: ${project.capital.months} mesi   ·   Aliquota fiscale: ${project.taxRate}%`,
    marginX,
    y
  );
  y += 32;

  startSection(140);
  sectionTitle("Costi di progetto");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8.5);
  doc.setTextColor(...grayC);
  doc.text("CATEGORIA", marginX, y);
  doc.text("DESCRIZIONE", marginX + 180, y);
  doc.text("IMPORTO", pageWidth - marginX, y, { align: "right" });
  y += 8;
  doc.setDrawColor(...lightGrayC);
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 14;

  project.costs.forEach((c) => {
    ensureSpace(16);
    const label = c.category === "Altro" ? c.desc?.trim() || "Altro" : c.category;
    const desc = c.category === "Altro" ? "" : c.desc || "";
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    doc.setTextColor(...darkC);
    doc.text(label, marginX, y);
    doc.setTextColor(...grayC);
    doc.text(desc, marginX + 180, y);
    doc.setTextColor(...darkC);
    doc.text(eur(Number(c.amount) || 0), pageWidth - marginX, y, { align: "right" });
    y += 16;
  });
  y += 6;
  ensureSpace(24);
  doc.setDrawColor(...lightGrayC);
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 16;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(...darkC);
  doc.text("Totale costi", marginX, y);
  doc.setTextColor(...tealC);
  doc.text(eur(metrics.totalCosts), pageWidth - marginX, y, { align: "right" });
  y += 32;

  startSection(140);
  sectionTitle("Unità immobiliari");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8.5);
  doc.setTextColor(...grayC);
  doc.text("UNITÀ", marginX, y);
  doc.text("PIANO", marginX + 150, y);
  doc.text("MQ", marginX + 200, y);
  doc.text("GIARDINO", marginX + 245, y);
  doc.text("TERRAZZO", marginX + 310, y);
  doc.text("PREZZO", pageWidth - marginX, y, { align: "right" });
  y += 8;
  doc.setDrawColor(...lightGrayC);
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 14;

  project.units.forEach((u) => {
    ensureSpace(16);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    doc.setTextColor(...darkC);
    doc.text(u.label, marginX, y);
    doc.setTextColor(...grayC);
    doc.text(String(u.floor || "—"), marginX + 150, y);
    doc.text(new Intl.NumberFormat("it-IT", { useGrouping: "always" }).format(Number(u.sqm) || 0), marginX + 200, y);
    doc.text(u.giardino ? "Sì" : "—", marginX + 245, y);
    doc.text(u.terrazzo ? "Sì" : "—", marginX + 310, y);
    doc.setTextColor(...darkC);
    doc.text(eur(Number(u.price) || 0), pageWidth - marginX, y, { align: "right" });
    y += 16;
  });
  y += 10;
  ensureSpace(16);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.5);
  doc.setTextColor(...grayC);
  doc.text(
    `Unità totali: ${project.units.length}   ·   Mq totali: ${new Intl.NumberFormat("it-IT", { useGrouping: "always" }).format(metrics.totalSqm)}   ·   Prezzo medio/mq: ${eur(metrics.avgPricePerSqm)}`,
    marginX,
    y
  );
  y += 32;

  if (project.notes && project.notes.trim()) {
    startSection(90);
    sectionTitle("Note");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(...darkC);
    const noteLines = doc.splitTextToSize(project.notes.trim(), contentWidth);
    noteLines.forEach((line) => {
      ensureSpace(15);
      doc.text(line, marginX, y);
      y += 15;
    });
  }
}

// ---------- storage ----------
const STORAGE_KEY = "gruppo-endine:projects";

export default function Dashboard() {
  const [projects, setProjects] = useState(null);
  const [activeId, setActiveId] = useState(null);
  const [status, setStatus] = useState("loading");
  const [saveState, setSaveState] = useState("idle");
  const [reportStatus, setReportStatus] = useState("idle");
  const saveTimer = useRef(null);
  const latestData = useRef(null);
  const lastSavedSnapshot = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        const value = await kvGet(STORAGE_KEY);
        const loaded = value ? value : seedProjects();
        setProjects(loaded);
        setActiveId(loaded[0]?.id ?? null);
        latestData.current = loaded;
        lastSavedSnapshot.current = JSON.stringify(loaded);
        setStatus("ready");
      } catch (e) {
        const seeded = seedProjects();
        setProjects(seeded);
        setActiveId(seeded[0]?.id ?? null);
        latestData.current = seeded;
        setStatus("ready");
      }
    })();
  }, []);

  const saveNow = useCallback(async () => {
    if (!latestData.current) return;
    const snapshot = JSON.stringify(latestData.current);
    if (snapshot === lastSavedSnapshot.current) return;
    setSaveState("saving");
    try {
      await kvSet(STORAGE_KEY, latestData.current);
      lastSavedSnapshot.current = snapshot;
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 1400);
    } catch (e) {
      setSaveState("error");
    }
  }, []);

  const persist = useCallback(
    (data) => {
      latestData.current = data;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      setSaveState("saving");
      saveTimer.current = setTimeout(saveNow, 250);
    },
    [saveNow]
  );

  useEffect(() => {
    const flush = () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveNow();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("beforeunload", flush);
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [saveNow]);

  const updateProjects = useCallback(
    (updater) => {
      setProjects((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        persist(next);
        return next;
      });
    },
    [persist]
  );

  const active = useMemo(
    () => (projects || []).find((p) => p.id === activeId) || null,
    [projects, activeId]
  );

  const updateActive = (fn) => {
    updateProjects((prev) => prev.map((p) => (p.id === activeId ? fn(p) : p)));
  };

  if (status === "loading" || !projects) {
    return (
      <div style={styles.loadingWrap}>
        <Fonts />
        <div style={styles.loadingText}>Caricamento progetti…</div>
      </div>
    );
  }

  const metrics = active ? computeProject(active) : null;

  return (
    <div style={styles.page}>
      <Fonts />
      <div style={styles.container}>
        <header style={styles.header} className="no-print">
          <div>
            <div style={styles.eyebrow}>Gruppo Endine Sviluppo</div>
            <h1 style={styles.title}>Conto economico di progetto</h1>
          </div>
          <div style={styles.headerRight}>
            <div style={{ ...styles.saveIndicator, ...(saveState === "error" ? { color: red } : {}) }}>
              {saveState === "saving"
                ? "Salvataggio…"
                : saveState === "saved"
                ? "Salvato ✓"
                : saveState === "error"
                ? "Errore nel salvataggio"
                : ""}
            </div>
            <button style={styles.saveNowBtn} onClick={saveNow}>
              Salva ora
            </button>
            <button
              style={styles.pdfBtn}
              onClick={async () => {
                if (!active || !metrics) return;
                setReportStatus("generating");
                try {
                  const doc = new jsPDF({ unit: "pt", format: "a4" });
                  generatePdfReport(doc, active, metrics);
                  const pdfBlob = doc.output("blob");
                  const pdfUrl = URL.createObjectURL(pdfBlob);
                  const pdfLink = document.createElement("a");
                  pdfLink.href = pdfUrl;
                  pdfLink.download = `report-${(active.name || "progetto").replace(/\s+/g, "_")}.pdf`;
                  document.body.appendChild(pdfLink);
                  pdfLink.click();
                  document.body.removeChild(pdfLink);
                  setTimeout(() => URL.revokeObjectURL(pdfUrl), 2000);
                  setReportStatus("idle");
                } catch (e) {
                  setReportStatus("fallback");
                  const html = buildReportHtml(active, metrics);
                  const blob = new Blob([html], { type: "text/html" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `report-${(active.name || "progetto").replace(/\s+/g, "_")}.html`;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  setTimeout(() => URL.revokeObjectURL(url), 2000);
                  setTimeout(() => setReportStatus("idle"), 4000);
                }
              }}
            >
              {reportStatus === "generating" ? "Generazione…" : "↓ Scarica PDF"}
            </button>
            {reportStatus === "fallback" && (
              <div style={styles.reportFallbackNote}>PDF non disponibile — scaricato in HTML</div>
            )}
          </div>
        </header>

        <div className="print-only" style={styles.printHeader}>
          <div>Gruppo Endine Sviluppo · Conto economico di progetto</div>
          <div>{active ? active.name : ""} — generato il {new Date().toLocaleString("it-IT")}</div>
        </div>

        <ProjectTabs
          className="no-print"
          projects={projects}
          activeId={activeId}
          setActiveId={setActiveId}
          onAdd={() => {
            const np = {
              id: uid(),
              name: "Nuovo progetto",
              location: "",
              taxRate: 28,
              capital: { total: 0, equityShare: 100, rate: 5, months: 12 },
              durationMonths: 12,
              costs: [],
              units: [],
              notes: "",
              appunti: "",
            };
            updateProjects((prev) => [...prev, np]);
            setActiveId(np.id);
          }}
          onRemove={(id) => {
            updateProjects((prev) => {
              const next = prev.filter((p) => p.id !== id);
              if (id === activeId) setActiveId(next[0]?.id ?? null);
              return next;
            });
          }}
        />

        {active && metrics && (
          <>
            <ProjectHeader project={active} onChange={updateActive} />
            <Ledger metrics={metrics} project={active} onChange={updateActive} />
            <CapitalSection project={active} onChange={updateActive} metrics={metrics} />
            <CostsSection project={active} onChange={updateActive} metrics={metrics} />
            <UnitsSection project={active} onChange={updateActive} metrics={metrics} />
            <NotesSection project={active} onChange={updateActive} />
            <AppuntiSection project={active} onChange={updateActive} />
          </>
        )}

        {!active && (
          <div style={styles.emptyState}>Nessun progetto selezionato. Aggiungine uno dalla barra sopra.</div>
        )}
      </div>
    </div>
  );
}

function Fonts() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700;800&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
      * { box-sizing: border-box; }
      input, select { font-family: inherit; }
      input[type="number"]::-webkit-outer-spin-button,
      input[type="number"]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
      input[type="number"] { -moz-appearance: textfield; }
      ::selection { background: #2F6F6333; }
      .print-only { display: none; }
      @media print {
        * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; }
        .no-print { display: none !important; }
        .print-only { display: block !important; }
        .section-card { break-inside: avoid; page-break-inside: avoid; }
        @page { margin: 14mm; }
      }
    `}</style>
  );
}

function ProjectTabs({ projects, activeId, setActiveId, onAdd, onRemove, className }) {
  const [confirmingId, setConfirmingId] = useState(null);

  useEffect(() => {
    setConfirmingId(null);
  }, [activeId]);

  return (
    <div style={styles.tabsRow} className={className}>
      <div style={styles.tabsScroll}>
        {projects.map((p) => (
          <button
            key={p.id}
            onClick={() => setActiveId(p.id)}
            style={{
              ...styles.tab,
              ...(p.id === activeId ? styles.tabActive : {}),
            }}
          >
            {p.name || "Senza nome"}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button style={styles.addProjectBtn} onClick={onAdd}>
          + Nuovo progetto
        </button>
        {activeId && confirmingId !== activeId && (
          <button style={styles.removeProjectBtn} onClick={() => setConfirmingId(activeId)}>
            Elimina
          </button>
        )}
        {activeId && confirmingId === activeId && (
          <>
            <button
              style={styles.removeProjectBtnConfirm}
              onClick={() => {
                onRemove(activeId);
                setConfirmingId(null);
              }}
            >
              Conferma eliminazione
            </button>
            <button style={styles.addProjectBtn} onClick={() => setConfirmingId(null)}>
              Annulla
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function ProjectHeader({ project, onChange }) {
  return (
    <div style={styles.projectHeaderRow}>
      <input
        style={styles.projectNameInput}
        value={project.name}
        onChange={(e) => onChange((p) => ({ ...p, name: e.target.value }))}
        placeholder="Nome progetto"
      />
      <input
        style={styles.projectLocationInput}
        value={project.location}
        onChange={(e) => onChange((p) => ({ ...p, location: e.target.value }))}
        placeholder="Località"
      />
    </div>
  );
}

function Ledger({ metrics, project, onChange }) {
  const {
    totalRevenue,
    totalCosts,
    financingCost,
    grossProfit,
    taxes,
    netProfit,
    roiGross,
    roiNet,
    roiGrossAnnualized,
    roiNetAnnualized,
    totalCapital,
    durationMonths,
  } = metrics;

  const maxBar = Math.max(totalRevenue, 1);
  const bar = (val, color) => ({
    width: `${Math.min(100, Math.max(0, (Math.abs(val) / maxBar) * 100))}%`,
    background: color,
  });

  return (
    <section style={styles.section} className="section-card">
      <div style={styles.eyebrowSmall}>Risultato economico</div>

      <div style={styles.durationWrap}>
        <div style={styles.durationLabelRow}>
          <span style={styles.durationLabel}>Durata intervento</span>
          <span style={styles.durationValue}>{durationMonths} mesi</span>
        </div>
        <input
          type="range"
          min={1}
          max={60}
          step={1}
          value={durationMonths}
          onChange={(e) => onChange((p) => ({ ...p, durationMonths: Number(e.target.value) }))}
          style={styles.durationSlider}
        />
        <div style={styles.durationHint}>Usata per ritarare il ROI su base annua</div>
      </div>

      <div style={styles.ledgerGrid}>
        <LedgerRow label="Ricavi totali" value={eur(totalRevenue)} barStyle={bar(totalRevenue, teal)} />
        <LedgerRow label="Costi di progetto" value={`− ${eur(totalCosts)}`} barStyle={bar(totalCosts, inkFaint)} negative />
        <LedgerRow
          label="Costo del finanziamento"
          value={`− ${eur(financingCost)}`}
          barStyle={bar(financingCost, amber)}
          negative
        />
        <div style={styles.ledgerDivider} />
        <LedgerRow label="Utile lordo" value={eur(grossProfit)} barStyle={bar(grossProfit, grossProfit >= 0 ? green : red)} strong />
        <LedgerRow label="Imposte" value={`− ${eur(taxes)}`} barStyle={bar(taxes, inkFaint)} negative />
        <LedgerRow label="Utile netto" value={eur(netProfit)} barStyle={bar(netProfit, netProfit >= 0 ? green : red)} strong />
      </div>

      <div style={styles.kpiRow}>
        <KpiCard label="Capitale investito" value={eur(totalCapital)} sub="proprio + finanziato" />
        <KpiCard
          label="ROI lordo"
          value={pct(roiGross)}
          sub={`sull'intervento (${durationMonths} mesi)`}
          accent={roiGross >= 0 ? green : red}
        />
        <KpiCard
          label="ROI netto"
          value={pct(roiNet)}
          sub={`sull'intervento (${durationMonths} mesi)`}
          accent={roiNet >= 0 ? green : red}
        />
      </div>
      <div style={styles.kpiRow}>
        <KpiCard
          label="ROI lordo annualizzato"
          value={pct(roiGrossAnnualized)}
          sub="ritarato su base 12 mesi"
          accent={roiGrossAnnualized >= 0 ? green : red}
        />
        <KpiCard
          label="ROI netto annualizzato"
          value={pct(roiNetAnnualized)}
          sub="ritarato su base 12 mesi"
          accent={roiNetAnnualized >= 0 ? green : red}
        />
      </div>
    </section>
  );
}

function LedgerRow({ label, value, barStyle, negative, strong }) {
  return (
    <div style={styles.ledgerRow}>
      <div style={{ ...styles.ledgerLabel, ...(strong ? styles.ledgerLabelStrong : {}) }}>{label}</div>
      <div style={styles.ledgerBarTrack}>
        <div style={{ ...styles.ledgerBarFill, ...barStyle }} />
      </div>
      <div
        style={{
          ...styles.ledgerValue,
          ...(strong ? styles.ledgerValueStrong : {}),
          ...(negative ? { color: inkFaint } : {}),
        }}
      >
        {value}
      </div>
    </div>
  );
}

function KpiCard({ label, value, sub, accent }) {
  return (
    <div style={styles.kpiCard}>
      <div style={styles.kpiLabel}>{label}</div>
      <div style={{ ...styles.kpiValue, ...(accent ? { color: accent } : {}) }}>{value}</div>
      <div style={styles.kpiSub}>{sub}</div>
    </div>
  );
}

function CapitalSection({ project, onChange, metrics }) {
  const c = project.capital;
  const setNum = (field) => (e) => {
    const v = e.target.value === "" ? "" : Number(e.target.value);
    onChange((p) => ({ ...p, capital: { ...p.capital, [field]: v } }));
  };
  const equityShare = Number.isFinite(Number(c.equityShare)) ? Number(c.equityShare) : 100;

  return (
    <section style={styles.section} className="section-card">
      <div style={styles.eyebrowSmall}>Struttura del capitale</div>

      <div style={styles.capitalGrid}>
        <Field label="Capitale totale (€)">
          <NumberField
            style={styles.input}
            value={c.total}
            onChange={(v) => onChange((p) => ({ ...p, capital: { ...p.capital, total: v } }))}
          />
        </Field>
        <Field label="Tasso annuo finanziamento (%)">
          <input style={styles.input} type="number" step="0.1" value={c.rate} onChange={setNum("rate")} />
        </Field>
        <Field label="Durata finanziamento (mesi)">
          <input style={styles.input} type="number" value={c.months} onChange={setNum("months")} />
        </Field>
        <Field label="Aliquota fiscale (%)">
          <input
            style={styles.input}
            type="number"
            step="0.1"
            value={project.taxRate}
            onChange={(e) => onChange((p) => ({ ...p, taxRate: e.target.value === "" ? "" : Number(e.target.value) }))}
          />
        </Field>
      </div>

      <div style={styles.splitWrap}>
        <div style={styles.splitLabelsRow}>
          <span style={{ ...styles.splitLabel, color: teal }}>
            Capitale proprio · {eur(metrics.equity)} ({equityShare.toFixed(0)}%)
          </span>
          <span style={{ ...styles.splitLabel, color: amber }}>
            Capitale finanziato · {eur(metrics.financed)} ({(100 - equityShare).toFixed(0)}%)
          </span>
        </div>
        <div style={styles.splitTrack}>
          <div style={{ ...styles.splitFillEquity, width: `${equityShare}%` }} />
          <div style={{ ...styles.splitFillDebt, width: `${100 - equityShare}%` }} />
        </div>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={equityShare}
          onChange={(e) =>
            onChange((p) => ({ ...p, capital: { ...p.capital, equityShare: Number(e.target.value) } }))
          }
          style={styles.splitSlider}
        />
        <div style={styles.splitHint}>Trascina per spostare capitale dal proprio al finanziato</div>
      </div>

      <CapitalChart metrics={metrics} />
    </section>
  );
}

function CapitalChart({ metrics }) {
  const data = [
    { name: "Ricavi", value: Math.round(metrics.totalRevenue), color: teal },
    { name: "Costi", value: Math.round(metrics.totalCosts), color: inkFaint },
    { name: "Finanziamento", value: Math.round(metrics.financingCost), color: amber },
    { name: "Utile netto", value: Math.round(metrics.netProfit), color: metrics.netProfit >= 0 ? green : red },
  ];

  return (
    <div style={styles.chartWrap}>
      <div style={styles.chartHeadRow}>
        <div style={styles.eyebrowSmall}>Ricavi, costi e finanziamento in tempo reale</div>
        <div style={styles.chartRoiBadge}>
          <span style={styles.chartRoiLabel}>ROI netto</span>
          <span style={{ ...styles.chartRoiValue, color: metrics.roiNet >= 0 ? green : red }}>
            {pct(metrics.roiNet)}
          </span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={border} vertical={false} />
          <XAxis
            dataKey="name"
            tick={{ fill: inkSoft, fontSize: 12, fontFamily: "Inter, sans-serif" }}
            axisLine={{ stroke: border }}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: inkFaint, fontSize: 11, fontFamily: "JetBrains Mono, monospace" }}
            axisLine={{ stroke: border }}
            tickLine={false}
            tickFormatter={(v) => `${Math.round(v / 1000)}k`}
          />
          <Tooltip
            contentStyle={{ background: surfaceAlt, border: `1px solid ${border}`, borderRadius: 8, color: ink }}
            labelStyle={{ color: inkSoft }}
            formatter={(v) => eur(v)}
          />
          <Bar dataKey="value" radius={[6, 6, 0, 0]}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.color} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={styles.fieldWrap}>
      <span style={styles.fieldLabel}>{label}</span>
      {children}
    </label>
  );
}

function NumberField({ value, onChange, style, placeholder }) {
  const [focused, setFocused] = useState(false);
  const [raw, setRaw] = useState(value === "" || value == null ? "" : String(value));

  useEffect(() => {
    if (!focused) setRaw(value === "" || value == null ? "" : String(value));
  }, [value, focused]);

  const display = focused
    ? raw
    : value === "" || value == null || Number.isNaN(Number(value))
    ? ""
    : new Intl.NumberFormat("it-IT", { maximumFractionDigits: 2, useGrouping: "always" }).format(Number(value));

  return (
    <input
      type="text"
      inputMode="decimal"
      style={style}
      placeholder={placeholder}
      value={display}
      onFocus={() => {
        setFocused(true);
        setRaw(value === "" || value == null ? "" : String(value));
      }}
      onBlur={() => setFocused(false)}
      onChange={(e) => {
        const v = e.target.value;
        setRaw(v);
        const cleaned = v.replace(/\./g, "").replace(",", ".").replace(/[^0-9.\-]/g, "");
        if (cleaned === "" || cleaned === "-") {
          onChange("");
          return;
        }
        const num = Number(cleaned);
        if (!Number.isNaN(num)) onChange(num);
      }}
    />
  );
}

function sliderRange(amount) {
  const v = Number(amount) || 0;
  const max = Math.max(Math.ceil((v * 2) / 500) * 500, 2000);
  const step = max <= 5000 ? 10 : max <= 50000 ? 100 : 500;
  return { max, step };
}

function CostsSection({ project, onChange, metrics }) {
  const updateRow = (id, field, value) => {
    onChange((p) => ({
      ...p,
      costs: p.costs.map((c) => (c.id === id ? { ...c, [field]: value } : c)),
    }));
  };
  const removeRow = (id) => {
    onChange((p) => ({ ...p, costs: p.costs.filter((c) => c.id !== id) }));
  };
  const addRow = () => {
    onChange((p) => ({
      ...p,
      costs: [...p.costs, { id: uid(), category: CATEGORIES[0], desc: "", amount: 0 }],
    }));
  };

  return (
    <section style={styles.section} className="section-card">
      <div style={styles.sectionHeadRow}>
        <div style={styles.eyebrowSmall}>Costi di progetto</div>
        <button style={styles.addRowBtn} className="no-print" onClick={addRow}>+ Voce di costo</button>
      </div>

      <div style={styles.tableWrap}>
        <div style={{ ...styles.tableHeaderRow, gridTemplateColumns: "1.1fr 1.4fr 1.9fr 32px" }}>
          <div>Categoria</div>
          <div>Descrizione</div>
          <div>Importo</div>
          <div />
        </div>
        {project.costs.map((c) => {
          const { max, step } = sliderRange(c.amount);
          return (
            <div key={c.id} style={{ ...styles.tableRow, gridTemplateColumns: "1.1fr 1.4fr 1.9fr 32px" }}>
              <select
                style={styles.select}
                value={c.category}
                onChange={(e) => updateRow(c.id, "category", e.target.value)}
              >
                {CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
              <input
                style={styles.input}
                value={c.desc}
                placeholder={c.category === "Altro" ? "Nome della voce personalizzata" : "Descrizione voce"}
                onChange={(e) => updateRow(c.id, "desc", e.target.value)}
              />
              <div style={styles.sliderCell}>
                <input
                  type="range"
                  min={0}
                  max={max}
                  step={step}
                  value={Number(c.amount) || 0}
                  onChange={(e) => updateRow(c.id, "amount", Number(e.target.value))}
                  style={styles.slider}
                />
                <NumberField
                  style={styles.sliderNumber}
                  value={c.amount}
                  onChange={(v) => updateRow(c.id, "amount", v)}
                />
              </div>
              <button style={styles.rowDeleteBtn} className="no-print" onClick={() => removeRow(c.id)} aria-label="Elimina riga">×</button>
            </div>
          );
        })}
        {project.costs.length === 0 && (
          <div style={styles.tableEmpty}>Nessuna voce di costo. Aggiungine una sopra.</div>
        )}
      </div>

      <div style={styles.totalLine}>
        <span>Totale costi</span>
        <span style={styles.totalLineValue}>{eur(metrics.totalCosts)}</span>
      </div>
    </section>
  );
}

function UnitsSection({ project, onChange, metrics }) {
  const updateRow = (id, field, value) => {
    onChange((p) => ({
      ...p,
      units: p.units.map((u) => (u.id === id ? { ...u, [field]: value } : u)),
    }));
  };
  const removeRow = (id) => {
    onChange((p) => ({ ...p, units: p.units.filter((u) => u.id !== id) }));
  };
  const addRow = () => {
    onChange((p) => ({
      ...p,
      units: [
        ...p.units,
        { id: uid(), label: `Unità ${p.units.length + 1}`, floor: "", sqm: 0, giardino: false, terrazzo: false, price: 0 },
      ],
    }));
  };

  return (
    <section style={styles.section} className="section-card">
      <div style={styles.sectionHeadRow}>
        <div style={styles.eyebrowSmall}>Unità immobiliari</div>
        <button style={styles.addRowBtn} className="no-print" onClick={addRow}>+ Unità</button>
      </div>

      <div style={styles.tableWrap}>
        <div style={{ ...styles.tableHeaderRow, gridTemplateColumns: "1.1fr 0.6fr 0.7fr 0.6fr 0.6fr 1fr 40px" }}>
          <div>Unità</div>
          <div>Piano</div>
          <div>Mq</div>
          <div>Giardino</div>
          <div>Terrazzo</div>
          <div style={{ textAlign: "right" }}>Prezzo previsto</div>
          <div />
        </div>
        {project.units.map((u) => (
          <div key={u.id} style={{ ...styles.tableRow, gridTemplateColumns: "1.1fr 0.6fr 0.7fr 0.6fr 0.6fr 1fr 40px" }}>
            <input style={styles.input} value={u.label} onChange={(e) => updateRow(u.id, "label", e.target.value)} />
            <input style={styles.input} value={u.floor} onChange={(e) => updateRow(u.id, "floor", e.target.value)} />
            <NumberField style={styles.input} value={u.sqm} onChange={(v) => updateRow(u.id, "sqm", v)} />
            <label style={styles.checkboxWrap}>
              <input
                type="checkbox"
                checked={!!u.giardino}
                onChange={(e) => updateRow(u.id, "giardino", e.target.checked)}
              />
            </label>
            <label style={styles.checkboxWrap}>
              <input
                type="checkbox"
                checked={!!u.terrazzo}
                onChange={(e) => updateRow(u.id, "terrazzo", e.target.checked)}
              />
            </label>
            <NumberField
              style={{ ...styles.input, textAlign: "right" }}
              value={u.price}
              onChange={(v) => updateRow(u.id, "price", v)}
            />
            <button style={styles.rowDeleteBtn} className="no-print" onClick={() => removeRow(u.id)} aria-label="Elimina riga">×</button>
          </div>
        ))}
        {project.units.length === 0 && (
          <div style={styles.tableEmpty}>Nessuna unità. Aggiungine una sopra.</div>
        )}
      </div>

      <div style={styles.chipsRow}>
        <div style={styles.chip}>
          <span style={styles.chipLabel}>Unità totali</span>
          <span style={styles.chipValue}>{project.units.length}</span>
        </div>
        <div style={styles.chip}>
          <span style={styles.chipLabel}>Mq totali</span>
          <span style={styles.chipValue}>{metrics.totalSqm}</span>
        </div>
        <div style={{ ...styles.chip, ...styles.chipTotal }}>
          <span style={styles.chipLabel}>Prezzo medio / mq</span>
          <span style={styles.chipValue}>{eur(metrics.avgPricePerSqm)}</span>
        </div>
      </div>
    </section>
  );
}

function NotesSection({ project, onChange }) {
  return (
    <section style={styles.section} className="section-card">
      <div style={styles.eyebrowSmall}>Note</div>
      <textarea
        style={styles.notesTextarea}
        value={project.notes || ""}
        placeholder="Annotazioni libere su questo progetto: accordi presi, promemoria, contatti, scadenze…"
        onChange={(e) => onChange((p) => ({ ...p, notes: e.target.value }))}
        rows={6}
      />
    </section>
  );
}

function AppuntiSection({ project, onChange }) {
  return (
    <section style={styles.section} className="section-card">
      <div style={styles.eyebrowSmall}>Appunti</div>
      <textarea
        style={styles.notesTextarea}
        value={project.appunti || ""}
        placeholder="Appunti personali, non inclusi nel PDF scaricato…"
        onChange={(e) => onChange((p) => ({ ...p, appunti: e.target.value }))}
        rows={6}
      />
    </section>
  );
}

// ---------- styles ----------
const bg = "#0A0E16";
const surface = "#131A26";
const surfaceAlt = "#1B2433";
const border = "#242D3F";
const ink = "#EDF1F7";
const inkSoft = "#8A93A8";
const inkFaint = "#5C6478";
const teal = "#2FD9C4";
const tealDim = "#1B4B47";
const green = "#3ECF8E";
const red = "#F2555F";
const amber = "#F0B429";

const styles = {
  page: {
    minHeight: "100vh",
    background: bg,
    backgroundImage: "radial-gradient(circle at 15% 0%, #101826 0%, #0A0E16 55%)",
    color: ink,
    fontFamily: "'Inter', sans-serif",
    padding: "32px 20px 64px",
  },
  loadingWrap: {
    minHeight: "100vh",
    background: bg,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  loadingText: { fontFamily: "'JetBrains Mono', monospace", color: inkSoft, fontSize: 13, letterSpacing: 0.5 },
  container: { maxWidth: 980, margin: "0 auto" },
  header: {
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "space-between",
    marginBottom: 28,
    borderBottom: `1px solid ${border}`,
    paddingBottom: 20,
  },
  eyebrow: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    letterSpacing: 1.6,
    textTransform: "uppercase",
    color: teal,
    marginBottom: 6,
  },
  title: {
    fontFamily: "'Sora', sans-serif",
    fontWeight: 700,
    fontSize: "clamp(24px, 4vw, 34px)",
    margin: 0,
    letterSpacing: -0.4,
    color: ink,
  },
  saveIndicator: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    color: teal,
    minWidth: 70,
    textAlign: "right",
  },
  headerRight: { display: "flex", alignItems: "center", gap: 14, position: "relative" },
  reportFallbackNote: {
    position: "absolute",
    top: "100%",
    right: 0,
    marginTop: 6,
    fontSize: 11,
    color: amber,
    whiteSpace: "nowrap",
  },
  saveNowBtn: {
    fontFamily: "'Inter', sans-serif",
    fontSize: 12.5,
    fontWeight: 600,
    padding: "8px 14px",
    borderRadius: 999,
    border: `1px solid ${border}`,
    background: surfaceAlt,
    color: ink,
    cursor: "pointer",
  },
  pdfBtn: {
    fontFamily: "'Inter', sans-serif",
    fontSize: 13,
    fontWeight: 600,
    padding: "9px 16px",
    borderRadius: 999,
    border: `1px solid ${teal}`,
    background: teal,
    color: "#06110F",
    cursor: "pointer",
  },
  printHeader: {
    display: "none",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    color: "#333",
    marginBottom: 16,
    lineHeight: 1.6,
  },
  tabsRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 24,
    flexWrap: "wrap",
  },
  tabsScroll: { display: "flex", gap: 8, flexWrap: "wrap" },
  tab: {
    fontFamily: "'Inter', sans-serif",
    fontSize: 13,
    fontWeight: 600,
    padding: "8px 14px",
    borderRadius: 999,
    border: `1px solid ${border}`,
    background: surface,
    color: inkSoft,
    cursor: "pointer",
  },
  tabActive: { background: teal, color: "#06110F", border: `1px solid ${teal}` },
  addProjectBtn: {
    fontFamily: "'Inter', sans-serif",
    fontSize: 13,
    fontWeight: 600,
    padding: "8px 14px",
    borderRadius: 999,
    border: `1px solid ${tealDim}`,
    background: "transparent",
    color: teal,
    cursor: "pointer",
  },
  removeProjectBtn: {
    fontFamily: "'Inter', sans-serif",
    fontSize: 13,
    padding: "8px 14px",
    borderRadius: 999,
    border: `1px solid ${border}`,
    background: "transparent",
    color: red,
    cursor: "pointer",
  },
  removeProjectBtnConfirm: {
    fontFamily: "'Inter', sans-serif",
    fontSize: 13,
    fontWeight: 600,
    padding: "8px 14px",
    borderRadius: 999,
    border: `1px solid ${red}`,
    background: red,
    color: "#1A0808",
    cursor: "pointer",
  },
  projectHeaderRow: { display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 20 },
  projectNameInput: {
    fontFamily: "'Sora', sans-serif",
    fontWeight: 700,
    fontSize: 21,
    border: "none",
    background: "transparent",
    color: ink,
    padding: "4px 0",
    minWidth: 200,
    borderBottom: `1px solid transparent`,
  },
  projectLocationInput: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 13,
    color: inkSoft,
    border: "none",
    background: "transparent",
    padding: "4px 0",
    minWidth: 160,
  },
  section: {
    background: surface,
    border: `1px solid ${border}`,
    borderRadius: 16,
    padding: "24px 24px 26px",
    marginBottom: 20,
    boxShadow: "0 1px 0 rgba(255,255,255,0.02) inset, 0 12px 24px -16px rgba(0,0,0,0.5)",
  },
  sectionHeadRow: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 },
  eyebrowSmall: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    letterSpacing: 1.4,
    textTransform: "uppercase",
    color: inkSoft,
    marginBottom: 16,
  },
  ledgerGrid: { display: "flex", flexDirection: "column", gap: 10 },
  ledgerRow: { display: "grid", gridTemplateColumns: "170px 1fr 140px", alignItems: "center", gap: 12 },
  ledgerLabel: { fontSize: 13, color: inkSoft },
  ledgerLabelStrong: { color: ink, fontWeight: 600 },
  ledgerBarTrack: { height: 8, background: surfaceAlt, borderRadius: 4, overflow: "hidden" },
  ledgerBarFill: { height: "100%", borderRadius: 4, transition: "width 0.3s ease" },
  ledgerValue: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 13,
    textAlign: "right",
    color: ink,
  },
  ledgerValueStrong: { fontWeight: 700, fontSize: 15 },
  ledgerDivider: { height: 1, background: border, margin: "4px 0" },
  kpiRow: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14, marginTop: 22 },
  kpiCard: { background: surfaceAlt, border: `1px solid ${border}`, borderRadius: 12, padding: "14px 16px" },
  kpiLabel: { fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, letterSpacing: 1, textTransform: "uppercase", color: inkSoft },
  kpiValue: { fontFamily: "'Sora', sans-serif", fontWeight: 700, fontSize: 24, margin: "6px 0 2px", color: ink },
  kpiSub: { fontSize: 11.5, color: inkFaint },
  capitalGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 16 },
  fieldWrap: { display: "flex", flexDirection: "column", gap: 6 },
  fieldLabel: { fontSize: 12, color: inkSoft },
  input: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 13,
    padding: "9px 10px",
    borderRadius: 8,
    border: `1px solid ${border}`,
    background: surfaceAlt,
    color: ink,
    width: "100%",
  },
  select: {
    fontFamily: "'Inter', sans-serif",
    fontSize: 13,
    padding: "9px 10px",
    borderRadius: 8,
    border: `1px solid ${border}`,
    background: surfaceAlt,
    color: ink,
    width: "100%",
  },
  addRowBtn: {
    fontFamily: "'Inter', sans-serif",
    fontSize: 12.5,
    fontWeight: 600,
    padding: "7px 12px",
    borderRadius: 8,
    border: `1px solid ${tealDim}`,
    background: "transparent",
    color: teal,
    cursor: "pointer",
  },
  tableWrap: { display: "flex", flexDirection: "column", gap: 6 },
  tableHeaderRow: {
    display: "grid",
    gap: 10,
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color: inkFaint,
    padding: "0 4px 6px",
    fontFamily: "'JetBrains Mono', monospace",
  },
  tableRow: { display: "grid", gap: 10, alignItems: "center", padding: "4px" },
  tableEmpty: { fontSize: 13, color: inkSoft, padding: "12px 4px", fontStyle: "italic" },
  rowDeleteBtn: {
    border: "none",
    background: "transparent",
    color: red,
    fontSize: 18,
    cursor: "pointer",
    lineHeight: 1,
  },
  checkboxWrap: { display: "flex", justifyContent: "center" },
  sliderCell: { display: "flex", alignItems: "center", gap: 10 },
  slider: { flex: 1, accentColor: teal, height: 4, cursor: "pointer" },
  sliderNumber: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12.5,
    padding: "6px 8px",
    borderRadius: 6,
    border: `1px solid ${border}`,
    background: surfaceAlt,
    color: ink,
    width: 84,
    textAlign: "right",
    flexShrink: 0,
  },
  totalLine: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 18,
    paddingTop: 14,
    borderTop: `1px solid ${border}`,
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 13,
    color: inkSoft,
  },
  totalLineValue: { fontSize: 16, fontWeight: 700, color: teal },
  chipsRow: { display: "flex", flexWrap: "wrap", gap: 10, marginTop: 16 },
  chip: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    padding: "8px 14px",
    borderRadius: 8,
    background: surfaceAlt,
    border: `1px solid ${border}`,
  },
  chipTotal: { borderColor: teal },
  chipLabel: { fontSize: 10.5, color: inkSoft, textTransform: "uppercase", letterSpacing: 0.6 },
  chipValue: { fontFamily: "'JetBrains Mono', monospace", fontSize: 13.5, fontWeight: 600, color: ink },
  emptyState: { padding: 40, textAlign: "center", color: inkSoft },

  splitWrap: { marginTop: 20 },
  splitLabelsRow: { display: "flex", justifyContent: "space-between", marginBottom: 8, flexWrap: "wrap", gap: 6 },
  splitLabel: { fontFamily: "'JetBrains Mono', monospace", fontSize: 12.5, fontWeight: 600 },
  splitTrack: {
    display: "flex",
    height: 10,
    borderRadius: 6,
    overflow: "hidden",
    border: `1px solid ${border}`,
  },
  splitFillEquity: { background: teal, transition: "width 0.15s ease" },
  splitFillDebt: { background: amber, transition: "width 0.15s ease" },
  splitSlider: { width: "100%", accentColor: teal, marginTop: 10, cursor: "pointer" },
  splitHint: { fontSize: 11.5, color: inkFaint, marginTop: 6 },

  chartWrap: { marginTop: 26, paddingTop: 20, borderTop: `1px solid ${border}` },
  chartHeadRow: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 10 },
  chartRoiBadge: { display: "flex", flexDirection: "column", alignItems: "flex-end" },
  chartRoiLabel: { fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, letterSpacing: 0.8, textTransform: "uppercase", color: inkSoft },
  chartRoiValue: { fontFamily: "'Sora', sans-serif", fontWeight: 700, fontSize: 22 },

  durationWrap: {
    marginBottom: 20,
    paddingBottom: 18,
    borderBottom: `1px solid ${border}`,
  },
  durationLabelRow: { display: "flex", justifyContent: "space-between", marginBottom: 8 },
  durationLabel: { fontSize: 13, color: inkSoft },
  durationValue: { fontFamily: "'JetBrains Mono', monospace", fontSize: 13, fontWeight: 600, color: ink },
  durationSlider: { width: "100%", accentColor: teal, cursor: "pointer" },
  durationHint: { fontSize: 11.5, color: inkFaint, marginTop: 6 },
  notesTextarea: {
    width: "100%",
    fontFamily: "'Inter', sans-serif",
    fontSize: 13.5,
    lineHeight: 1.6,
    padding: "12px 14px",
    borderRadius: 10,
    border: `1px solid ${border}`,
    background: surfaceAlt,
    color: ink,
    resize: "vertical",
    minHeight: 100,
  },
};
