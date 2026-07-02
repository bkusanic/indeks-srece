import React, { useState, useMemo, useEffect } from "react";
import {
  View, Text, ScrollView, Pressable, TextInput, Dimensions, StyleSheet, Platform, Alert,
} from "react-native";
import Svg, { Line, Circle, Path, Rect, Text as SvgText } from "react-native-svg";
import AsyncStorage from "@react-native-async-storage/async-storage";

import WHR from "./data/whr.json";       // [year, rank, country, life, gdp, social, health, freedom, generosity, corruption]
import TFR from "./data/tfr.json";       // { country: fertilityRate }
import CLUSTERS from "./data/analysis.json"; // [{name, desc, avgLife, countries:[...]}]

// ---------- design tokens ----------
const T = {
  bg: "#F2F4F3", ink: "#1A2421", sub: "#5B6B64",
  card: "#FFFFFF", line: "#E2E7E4", accent: "#2F6F5E", warm: "#E0A458", red: "#C0504D",
};
const FACTORS = [
  { key: "gdp", label: "BDP", color: "#E0A458" },
  { key: "social", label: "Soc. podrška", color: "#2F6F5E" },
  { key: "health", label: "Zdravlje", color: "#7BA982" },
  { key: "freedom", label: "Sloboda", color: "#5B8BB0" },
  { key: "generosity", label: "Velikodušnost", color: "#9A8BB0" },
  { key: "corruption", label: "Korupcija", color: "#B08968" },
];
const FKEYS = FACTORS.map((f) => f.key);

// ---------- base data ----------
const BASE_ROWS = WHR.map((r) => ({
  year: r[0], rank: r[1], country: r[2], life: r[3],
  gdp: r[4], social: r[5], health: r[6], freedom: r[7], generosity: r[8], corruption: r[9],
}));
const BASE_YEARS = [...new Set(BASE_ROWS.map((r) => r.year))];

// ---------- math ----------
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a, m) => Math.sqrt(mean(a.map((v) => (v - m) ** 2)));
function pearson(x, y) {
  const mx = mean(x), my = mean(y);
  const cov = mean(x.map((v, i) => (v - mx) * (y[i] - my)));
  return cov / (sd(x, mx) * sd(y, my));
}
function solveLin(A, b) {
  const n = A.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) return null;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / M[i][i]);
}
function olsFit(X, y) { // raw-unit OLS with intercept -> {coef, predict}
  const n = y.length, p = X[0].length, k = p + 1;
  const D = X.map((r) => [1, ...r]);
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < n; i++) for (let a = 0; a < k; a++) {
    Xty[a] += D[i][a] * y[i];
    for (let b = 0; b < k; b++) XtX[a][b] += D[i][a] * D[i][b];
  }
  const coef = solveLin(XtX, Xty);
  if (!coef) return null;
  return { coef, predict: (row) => [1, ...row].reduce((s, v, j) => s + v * coef[j], 0) };
}
function olsStandardized(X, y) { // -> {betas, r2}
  const my = mean(y), sy = sd(y, my);
  const ys = y.map((v) => (v - my) / sy);
  const cols = X[0].map((_, j) => {
    const col = X.map((r) => r[j]);
    const m = mean(col), s = sd(col, m) || 1;
    return col.map((v) => (v - m) / s);
  });
  const Xs = ys.map((_, i) => cols.map((c) => c[i]));
  const fit = olsFit(Xs, ys);
  if (!fit) return null;
  let ssr = 0, sst = 0;
  ys.forEach((v, i) => { const pr = fit.predict(Xs[i]); ssr += (v - pr) ** 2; sst += v * v; });
  return { betas: fit.coef.slice(1), r2: 1 - ssr / sst };
}
function factorRows(rows, year) {
  return rows.filter((r) => r.year === year && r.life != null && FKEYS.every((k) => r[k] != null));
}
function influenceShare(rows, year) { // variance-share method
  const d = factorRows(rows, year);
  if (d.length < 8) return null;
  const total = d.map((r) => r.life);
  const tm = mean(total), vt = mean(total.map((t) => (t - tm) ** 2));
  return FACTORS.map((f) => {
    const x = d.map((r) => r[f.key]);
    const xm = mean(x);
    const cov = mean(d.map((r, i) => (x[i] - xm) * (total[i] - tm)));
    return { ...f, share: (cov / vt) * 100 };
  }).sort((a, b) => b.share - a.share);
}
function influenceRegression(rows, year) { // standardized-beta method
  const d = factorRows(rows, year);
  if (d.length < 12) return null;
  const y = d.map((r) => r.life);
  const X = d.map((r) => FKEYS.map((k) => r[k]));
  const out = olsStandardized(X, y);
  if (!out) return null;
  const tot = out.betas.reduce((s, b) => s + Math.abs(b), 0);
  return {
    r2: out.r2,
    items: FACTORS.map((f, i) => ({ ...f, beta: out.betas[i], share: (Math.abs(out.betas[i]) / tot) * 100 }))
      .sort((a, b) => b.share - a.share),
  };
}
function residualForCountry(rows, country) { // latest year with factors -> {year, resid}
  const years = [...new Set(rows.filter((r) => r.country === country && FKEYS.every((k) => r[k] != null)).map((r) => r.year))].sort((a, b) => b - a);
  for (const y of years) {
    const d = factorRows(rows, y);
    if (d.length < 12) continue;
    const fit = olsFit(d.map((r) => FKEYS.map((k) => r[k])), d.map((r) => r.life));
    if (!fit) continue;
    const me = d.find((r) => r.country === country);
    if (!me) continue;
    return { year: y, resid: me.life - fit.predict(FKEYS.map((k) => me[k])) };
  }
  return null;
}

const W = Dimensions.get("window").width;
const STORE_KEY = "customRows_v1";

// ===================================================================
export default function App() {
  const [tab, setTab] = useState("faktori");
  const [year, setYear] = useState(2025);
  const [country, setCountry] = useState("Croatia");
  const [q, setQ] = useState("");
  const [custom, setCustom] = useState([]); // user-added rows

  useEffect(() => {
    AsyncStorage.getItem(STORE_KEY).then((s) => { if (s) try { setCustom(JSON.parse(s)); } catch (e) {} });
  }, []);
  const saveCustom = (rows) => { setCustom(rows); AsyncStorage.setItem(STORE_KEY, JSON.stringify(rows)); };

  const allRows = useMemo(() => [...BASE_ROWS, ...custom], [custom]);
  const years = useMemo(() => [...new Set(allRows.map((r) => r.year))].sort((a, b) => a - b), [allRows]);
  const countries = useMemo(() => [...new Set(allRows.map((r) => r.country))].sort(), [allRows]);

  return (
    <View style={s.app}>
      <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 90 }} keyboardShouldPersistTaps="handled">
        <Text style={s.eyebrow}>INDEKS SREĆE · {years[0]}–{years[years.length - 1]}</Text>
        <Text style={s.h1}>Što čini naciju sretnom</Text>

        {tab === "faktori" && <YearPicker years={years} year={year} setYear={setYear} />}
        {tab === "ljestvica" && <YearPicker years={years} year={year} setYear={setYear} />}

        {tab === "faktori" && <Faktori rows={allRows} year={year} />}
        {tab === "ljestvica" && (
          <Ljestvica rows={allRows} year={year} q={q} setQ={setQ}
            onPick={(c) => { setCountry(c); setTab("zemlja"); }} />
        )}
        {tab === "zemlja" && <Profil rows={allRows} countries={countries} country={country} setCountry={setCountry} />}
        {tab === "natalitet" && <Natalitet rows={allRows} countries={countries} country={country} setCountry={setCountry} />}
        {tab === "podaci" && <Podaci custom={custom} saveCustom={saveCustom} baseYears={BASE_YEARS} />}

        <Text style={s.foot}>
          Izvori: World Happiness Report i UN WPP 2024 (natalitet). "Čisti utjecaj" = standardizirana
          višestruka regresija (neovisni doprinos uz kontrolu ostalih faktora); "udio varijance" = koliko
          faktor ide ukorak s ukupnom srećom. Faktori su međusobno povezani pa se metode razlikuju.
        </Text>
      </ScrollView>

      <View style={s.tabbar}>
        {[["faktori", "Faktori"], ["ljestvica", "Ljestvica"], ["zemlja", "Profil"], ["natalitet", "Natalitet"], ["podaci", "Podaci"]].map(([k, l]) => (
          <Pressable key={k} style={s.tab} onPress={() => setTab(k)}>
            <Text style={[s.tabText, tab === k && s.tabTextOn]}>{l}</Text>
            {tab === k && <View style={s.tabDot} />}
          </Pressable>
        ))}
      </View>
    </View>
  );
}

// ---------- shared ----------
function YearPicker({ years, year, setYear }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginVertical: 14 }}>
      {years.map((y) => (
        <Pressable key={y} onPress={() => setYear(y)} style={[s.chip, y === year && s.chipOn]}>
          <Text style={[s.chipText, y === year && s.chipTextOn]}>{y}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}
function Card({ title, sub, children }) {
  return (
    <View style={s.card}>
      {title ? <Text style={s.cardTitle}>{title}</Text> : null}
      {sub ? <Text style={s.cardSub}>{sub}</Text> : null}
      {children}
    </View>
  );
}
function Stat({ label, value, color }) {
  return (
    <View>
      <Text style={{ fontSize: 19, fontWeight: "700", color: color || T.ink }}>{value}</Text>
      <Text style={{ fontSize: 11, color: T.sub }}>{label}</Text>
    </View>
  );
}
function CountrySelect({ countries, country, setCountry }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState("");
  const list = countries.filter((c) => c.toLowerCase().includes(f.toLowerCase()));
  return (
    <View style={{ marginBottom: 14 }}>
      <Pressable style={s.select} onPress={() => setOpen(!open)}>
        <Text style={s.selectText}>{country}</Text>
        <Text style={{ color: T.sub }}>{open ? "▲" : "▼"}</Text>
      </Pressable>
      {open && (
        <View style={s.dropdown}>
          <TextInput value={f} onChangeText={setF} placeholder="Traži…" style={s.search} />
          <ScrollView style={{ maxHeight: 220 }} nestedScrollEnabled>
            {list.map((c) => (
              <Pressable key={c} onPress={() => { setCountry(c); setOpen(false); setF(""); }} style={s.ddRow}>
                <Text style={{ color: c === country ? T.accent : T.ink, fontWeight: c === country ? "600" : "400" }}>{c}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}
    </View>
  );
}
function BarList({ items, valueKey, fmt }) {
  const max = Math.max(...items.map((d) => d[valueKey]), 1);
  return (
    <View style={{ marginTop: 10 }}>
      {items.map((d) => (
        <View key={d.key} style={{ flexDirection: "row", alignItems: "center", marginVertical: 6 }}>
          <Text style={{ width: 96, fontSize: 12, textAlign: "right", marginRight: 8, color: T.ink }}>{d.label}</Text>
          <View style={{ flex: 1, height: 24, backgroundColor: "#EEF1F0", borderRadius: 6, overflow: "hidden" }}>
            <View style={{ width: `${(d[valueKey] / max) * 100}%`, height: "100%", backgroundColor: d.color, borderRadius: 6 }} />
          </View>
          <Text style={{ width: 56, textAlign: "right", fontSize: 12, fontWeight: "600", color: T.ink }}>{fmt(d)}</Text>
        </View>
      ))}
    </View>
  );
}

// ---------- FAKTORI ----------
function Faktori({ rows, year }) {
  const [mode, setMode] = useState("reg"); // 'reg' | 'share'
  const share = useMemo(() => influenceShare(rows, year), [rows, year]);
  const reg = useMemo(() => influenceRegression(rows, year), [rows, year]);
  const hasFactors = !!share;
  const [openCluster, setOpenCluster] = useState(null);
  return (
    <View>
      <Card title={`Utjecaj parametara — ${year}`}
        sub={hasFactors ? "Dvije metode: čisti utjecaj (regresija — neovisni doprinos svakog faktora) i udio varijance (koliko faktor ide ukorak sa srećom)." : "Za ovu godinu izvor nema faktorsku raščlambu (postoji od 2019.). Odaberi noviju godinu."}>
        {hasFactors && (
          <View>
            <View style={{ flexDirection: "row", marginTop: 10 }}>
              {[["reg", "Čisti utjecaj"], ["share", "Udio varijance"]].map(([k, l]) => (
                <Pressable key={k} onPress={() => setMode(k)}
                  style={[s.toggle, mode === k && s.toggleOn]}>
                  <Text style={[s.toggleText, mode === k && s.toggleTextOn]}>{l}</Text>
                </Pressable>
              ))}
            </View>
            {mode === "reg" && reg && (
              <View>
                <BarList items={reg.items} valueKey="share" fmt={(d) => `${d.share.toFixed(1)}%`} />
                <Text style={s.note}>
                  Model objašnjava R² = {(reg.r2 * 100).toFixed(0)}% razlika među zemljama.
                  Negativan smjer ima samo{" "}
                  {reg.items.filter((d) => d.beta < 0).map((d) => d.label).join(", ") || "— nijedan faktor"}.
                </Text>
              </View>
            )}
            {mode === "share" && <BarList items={share} valueKey="share" fmt={(d) => `${d.share.toFixed(1)}%`} />}
          </View>
        )}
      </Card>

      <Card title="Profili sreće (klasteri)"
        sub="Zemlje grupirane po strukturi sreće — iz čega se njihova ocjena sastoji, ne koliko je visoka. Izračunato na 2025.">
        {CLUSTERS.map((c, i) => (
          <Pressable key={c.name} onPress={() => setOpenCluster(openCluster === i ? null : i)}
            style={{ paddingVertical: 10, borderTopWidth: i ? 1 : 0, borderTopColor: T.line }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={{ fontSize: 14.5, fontWeight: "700", color: T.ink }}>{c.name}</Text>
              <Text style={{ fontSize: 12, color: T.sub }}>{c.countries.length} zemalja · sreća ~{c.avgLife}</Text>
            </View>
            <Text style={{ fontSize: 12, color: T.sub, marginTop: 2, lineHeight: 17 }}>{c.desc}</Text>
            {openCluster === i && (
              <Text style={{ fontSize: 12, color: T.ink, marginTop: 6, lineHeight: 18 }}>
                {c.countries.join(" · ")}
              </Text>
            )}
          </Pressable>
        ))}
      </Card>
    </View>
  );
}

// ---------- LJESTVICA ----------
function Ljestvica({ rows, year, q, setQ, onPick }) {
  const rank = useMemo(
    () => rows.filter((r) => r.year === year)
      .filter((r) => r.country.toLowerCase().includes(q.toLowerCase()))
      .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999)),
    [rows, year, q]
  );
  return (
    <Card title={`Ljestvica sreće — ${year}`} sub={`${rank.length} zemalja. Dodirni zemlju za profil.`}>
      <TextInput value={q} onChangeText={setQ} placeholder="Traži zemlju…" style={[s.search, { marginVertical: 8 }]} />
      {rank.map((r) => {
        const sum = FKEYS.reduce((a, k) => a + (r[k] || 0), 0) || 1;
        return (
          <Pressable key={r.country} onPress={() => onPick(r.country)} style={s.rankRow}>
            <Text style={{ width: 28, color: T.sub, fontSize: 12 }}>{r.rank}</Text>
            <Text style={{ width: 120, fontSize: 13, fontWeight: "500" }}>{r.country}</Text>
            <Text style={{ width: 44, fontSize: 13, fontWeight: "600" }}>{r.life.toFixed(2)}</Text>
            <View style={{ flex: 1, height: 12, flexDirection: "row", borderRadius: 3, overflow: "hidden", backgroundColor: "#EEF1F0" }}>
              {FACTORS.map((f) => (
                <View key={f.key} style={{ width: `${((r[f.key] || 0) / sum) * 100}%`, backgroundColor: f.color }} />
              ))}
            </View>
          </Pressable>
        );
      })}
    </Card>
  );
}

// ---------- PROFIL ----------
function Profil({ rows, countries, country, setCountry }) {
  const crows = useMemo(
    () => rows.filter((r) => r.country === country).sort((a, b) => a.year - b.year),
    [rows, country]
  );
  const latest = crows[crows.length - 1];
  const best = useMemo(() => {
    const wr = crows.filter((r) => r.rank != null);
    return wr.length ? wr.reduce((a, b) => (b.rank < a.rank ? b : a)) : null;
  }, [crows]);
  const resid = useMemo(() => residualForCountry(rows, country), [rows, country]);
  const cluster = useMemo(() => CLUSTERS.find((c) => c.countries.includes(country)), [country]);
  return (
    <View>
      <CountrySelect countries={countries} country={country} setCountry={setCountry} />
      {latest && (
        <View style={{ flexDirection: "row", gap: 20, marginBottom: 10, flexWrap: "wrap" }}>
          <Stat label="Ocjena" value={latest.life.toFixed(2)} />
          <Stat label="Rang sad" value={`#${latest.rank}`} />
          {best && <Stat label="Najbolji rang" value={`#${best.rank} (${best.year})`} />}
        </View>
      )}
      {(resid || cluster) && (
        <View style={{ marginBottom: 14 }}>
          {resid && (
            <View style={[s.badge, { borderColor: Math.abs(resid.resid) < 0.15 ? T.line : resid.resid > 0 ? T.accent : T.red }]}>
              <Text style={{ fontSize: 12.5, color: T.ink }}>
                {Math.abs(resid.resid) < 0.15
                  ? `U skladu s očekivanjem modela (${resid.year})`
                  : resid.resid > 0
                    ? `Nadmašuje očekivanje modela za +${resid.resid.toFixed(2)} (${resid.year})`
                    : `Ispod očekivanja modela za ${resid.resid.toFixed(2)} (${resid.year})`}
              </Text>
            </View>
          )}
          {cluster && (
            <View style={[s.badge, { borderColor: T.line, marginTop: 6 }]}>
              <Text style={{ fontSize: 12.5, color: T.ink }}>Profil sreće: <Text style={{ fontWeight: "700" }}>{cluster.name}</Text></Text>
            </View>
          )}
        </View>
      )}

      <Card title="Ranking kroz vrijeme" sub="Mjesto na svjetskoj ljestvici. Više na grafu = bolji plasman.">
        <RankSvg rows={crows} />
      </Card>
      <Card title="Ocjena života kroz vrijeme" sub="Cantril ljestvica (0–10).">
        <LineSvg rows={crows} />
      </Card>
      <Card title="Doprinos parametara kroz godine" sub="Od čega se sastoji ocjena te zemlje svake godine (raščlamba postoji od 2019.).">
        <StackedBars rows={crows} />
        <FactorLegend />
      </Card>
    </View>
  );
}

// ---------- NATALITET ----------
function Natalitet({ rows, countries, country, setCountry }) {
  const data = useMemo(() => {
    const out = [];
    countries.forEach((c) => {
      if (TFR[c] == null) return;
      const rs = rows.filter((r) => r.country === c).sort((a, b) => b.year - a.year);
      if (rs.length) out.push({ country: c, life: rs[0].life, tfr: TFR[c] });
    });
    return out;
  }, [rows, countries]);
  const r = useMemo(() => (data.length > 3 ? pearson(data.map((d) => d.life), data.map((d) => d.tfr)) : 0), [data]);
  const sel = data.find((d) => d.country === country);
  return (
    <View>
      <CountrySelect countries={countries} country={country} setCountry={setCountry} />
      {sel && (
        <View style={{ flexDirection: "row", gap: 20, marginBottom: 14 }}>
          <Stat label="Sreća" value={sel.life.toFixed(2)} />
          <Stat label="Djece/ženi" value={sel.tfr.toFixed(2)} />
          <Stat label="Veza (r)" value={r.toFixed(2)} />
        </View>
      )}
      <Card title="Sreća vs. natalitet" sub={`Svaka točka je zemlja. Crta na 2,1 je razina obnove. Korelacija r = ${r.toFixed(2)}.`}>
        <ScatterSvg data={data} highlight={country} />
        <Text style={s.note}>
          Jaka negativna veza — no to je demografska tranzicija: razvoj diže sreću i spušta natalitet,
          pa sreća nije uzrok. Izrael je iznimka.
        </Text>
      </Card>
    </View>
  );
}

// ---------- PODACI (unos novih godina) ----------
function Podaci({ custom, saveCustom, baseYears }) {
  const [yr, setYr] = useState("");
  const [txt, setTxt] = useState("");
  const [msg, setMsg] = useState(null);
  const customYears = [...new Set(custom.map((r) => r.year))].sort((a, b) => a - b);

  const parseAndSave = () => {
    setMsg(null);
    const year = parseInt(yr, 10);
    if (!year || year < 2000 || year > 2100) return setMsg({ err: "Upiši ispravnu godinu (npr. 2026)." });
    if (baseYears.includes(year)) return setMsg({ err: `Godina ${year} već postoji u ugrađenim podacima.` });
    const lines = txt.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return setMsg({ err: "Zalijepi retke s podacima." });
    const rows = []; const errs = [];
    lines.forEach((line, i) => {
      const parts = line.split(/[;\t]/).map((p) => p.trim());
      if (parts.length !== 8) { errs.push(`Redak ${i + 1}: očekujem 8 polja, našao ${parts.length}.`); return; }
      const name = parts[0];
      const nums = parts.slice(1).map((p) => parseFloat(p.replace(",", ".")));
      if (!name || nums.some((n) => !isFinite(n))) { errs.push(`Redak ${i + 1}: neispravan broj.`); return; }
      const [life, gdp, social, health, freedom, generosity, corruption] = nums;
      if (life < 0 || life > 10) { errs.push(`Redak ${i + 1}: ocjena mora biti 0–10.`); return; }
      rows.push({ year, country: name, life, gdp, social, health, freedom, generosity, corruption });
    });
    if (errs.length) return setMsg({ err: errs.slice(0, 4).join("\n") + (errs.length > 4 ? `\n… i još ${errs.length - 4}.` : "") });
    if (rows.length < 2) return setMsg({ err: "Trebam barem 2 zemlje za godinu." });
    // auto-rank by life desc
    rows.sort((a, b) => b.life - a.life).forEach((r, i) => (r.rank = i + 1));
    const rest = custom.filter((r) => r.year !== year);
    saveCustom([...rest, ...rows]);
    setTxt(""); setYr("");
    setMsg({ ok: `Spremljeno: ${rows.length} zemalja za ${year}. Rang je izračunat automatski. Godina je sad dostupna u svim karticama.` });
  };
  const removeYear = (y) => saveCustom(custom.filter((r) => r.year !== y));

  return (
    <View>
      <Card title="Dodaj novu godinu"
        sub={"Kad WHR objavi novo izvješće, zalijepi retke u obliku:\nZemlja;ocjena;BDP;podrška;zdravlje;sloboda;velikodušnost;korupcija\n(odvajaj točka-zarezom ili tabom; decimalni zarez je u redu). Rang se računa sam."}>
        <TextInput value={yr} onChangeText={setYr} placeholder="Godina (npr. 2026)" keyboardType="numeric"
          style={[s.search, { marginTop: 10 }]} />
        <TextInput value={txt} onChangeText={setTxt} multiline placeholder={"Croatia;6,01;1,71;1,56;0,58;0,68;0,08;0,08\nFinland;7,74;1,80;1,66;0,71;0,90;0,11;0,49"}
          style={[s.search, { marginTop: 8, minHeight: 120, textAlignVertical: "top" }]} />
        <Pressable onPress={parseAndSave} style={s.btn}>
          <Text style={{ color: "#fff", fontWeight: "700" }}>Provjeri i spremi</Text>
        </Pressable>
        {msg?.err ? <Text style={[s.note, { color: T.red }]}>{msg.err}</Text> : null}
        {msg?.ok ? <Text style={[s.note, { color: T.accent }]}>{msg.ok}</Text> : null}
      </Card>

      <Card title="Tvoje dodane godine" sub={customYears.length ? "Spremljeno na uređaju (ostaje i nakon zatvaranja aplikacije)." : "Još nema dodanih godina."}>
        {customYears.map((y) => (
          <View key={y} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: T.line }}>
            <Text style={{ fontSize: 14, fontWeight: "600" }}>{y} <Text style={{ color: T.sub, fontWeight: "400" }}>({custom.filter((r) => r.year === y).length} zemalja)</Text></Text>
            <Pressable onPress={() => removeYear(y)}><Text style={{ color: T.red, fontSize: 13, fontWeight: "600" }}>Obriši</Text></Pressable>
          </View>
        ))}
        <Text style={s.note}>
          Napomena: analiza "Čisti utjecaj" i "Udio varijance" automatski rade i za dodane godine.
          Klasteri i natalitet ostaju vezani uz ugrađene izvore dok ih ne osvježimo.
        </Text>
      </Card>
    </View>
  );
}

// ---------- SVG charts ----------
function LineSvg({ rows }) {
  const w = W - 36 - 36, h = 200, pad = 26;
  if (rows.length < 2) return null;
  const xs = rows.map((r) => r.year);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = 0, y1 = 8;
  const px = (x) => pad + ((x - x0) / (x1 - x0)) * (w - pad * 2);
  const py = (y) => h - pad - ((y - y0) / (y1 - y0)) * (h - pad * 2);
  const d = rows.map((r, i) => `${i ? "L" : "M"}${px(r.year)},${py(r.life)}`).join(" ");
  return (
    <Svg width={w} height={h} style={{ marginTop: 8 }}>
      {[0, 2, 4, 6, 8].map((g) => (
        <Line key={g} x1={pad} y1={py(g)} x2={w - pad} y2={py(g)} stroke={T.line} strokeWidth={1} />
      ))}
      <Path d={d} stroke={T.accent} strokeWidth={2.5} fill="none" />
      {rows.map((r) => <Circle key={r.year} cx={px(r.year)} cy={py(r.life)} r={2.6} fill={T.accent} />)}
      <SvgText x={pad} y={h - 6} fontSize={10} fill={T.sub}>{x0}</SvgText>
      <SvgText x={w - pad} y={h - 6} fontSize={10} fill={T.sub} textAnchor="end">{x1}</SvgText>
    </Svg>
  );
}
function RankSvg({ rows }) {
  const w = W - 36 - 36, h = 200, pad = 28;
  const pts = rows.filter((r) => r.rank != null);
  if (pts.length < 2) return <Text style={{ color: T.sub, fontSize: 12, marginTop: 8 }}>Premalo podataka.</Text>;
  const xs = pts.map((r) => r.year), rk = pts.map((r) => r.rank);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let rMin = Math.min(...rk), rMax = Math.max(...rk);
  if (rMin === rMax) { rMin -= 1; rMax += 1; }
  const px = (x) => pad + ((x - x0) / (x1 - x0)) * (w - pad * 2);
  const py = (r) => pad + ((r - rMin) / (rMax - rMin)) * (h - pad * 2);
  const d = pts.map((r, i) => `${i ? "L" : "M"}${px(r.year)},${py(r.rank)}`).join(" ");
  return (
    <Svg width={w} height={h} style={{ marginTop: 8 }}>
      {[rMin, Math.round((rMin + rMax) / 2), rMax].map((g, i) => (
        <React.Fragment key={i}>
          <Line x1={pad} y1={py(g)} x2={w - pad} y2={py(g)} stroke={T.line} strokeWidth={1} />
          <SvgText x={2} y={py(g) + 3} fontSize={9} fill={T.sub}>{`#${g}`}</SvgText>
        </React.Fragment>
      ))}
      <Path d={d} stroke={T.accent} strokeWidth={2.5} fill="none" />
      {pts.map((r) => <Circle key={r.year} cx={px(r.year)} cy={py(r.rank)} r={2.8} fill={T.accent} />)}
      <SvgText x={pad} y={h - 6} fontSize={10} fill={T.sub}>{x0}</SvgText>
      <SvgText x={w - pad} y={h - 6} fontSize={10} fill={T.sub} textAnchor="end">{x1}</SvgText>
    </Svg>
  );
}
function StackedBars({ rows }) {
  const w = W - 36 - 36, h = 240, pad = 26;
  const data = rows.filter((r) => FKEYS.every((k) => r[k] != null));
  if (!data.length) return <Text style={{ color: T.sub, fontSize: 12, marginTop: 8 }}>Nema faktorske raščlambe za ovu zemlju.</Text>;
  const totals = data.map((r) => FKEYS.reduce((a, k) => a + (r[k] || 0), 0));
  const maxT = Math.max(...totals) * 1.05;
  const innerW = w - pad * 2;
  const step = innerW / data.length;
  const barW = Math.min(step * 0.7, 22);
  const py = (v) => h - pad - (v / maxT) * (h - pad * 2);
  return (
    <Svg width={w} height={h} style={{ marginTop: 8 }}>
      {[0, maxT / 2, maxT].map((g, i) => (
        <Line key={i} x1={pad} y1={py(g)} x2={w - pad} y2={py(g)} stroke={T.line} strokeWidth={1} />
      ))}
      {data.map((r, i) => {
        const cx = pad + step * i + step / 2;
        let acc = 0;
        return (
          <React.Fragment key={r.year}>
            {FACTORS.map((f) => {
              const v = r[f.key] || 0;
              const yTop = py(acc + v);
              const hgt = py(acc) - py(acc + v);
              acc += v;
              return <Rect key={f.key} x={cx - barW / 2} y={yTop} width={barW} height={Math.max(hgt, 0)} fill={f.color} />;
            })}
            {(i === 0 || i === data.length - 1 || i === Math.floor(data.length / 2)) && (
              <SvgText x={cx} y={h - 8} fontSize={9} fill={T.sub} textAnchor="middle">{r.year}</SvgText>
            )}
          </React.Fragment>
        );
      })}
    </Svg>
  );
}
function ScatterSvg({ data, highlight }) {
  const w = W - 36 - 36, h = 300, pad = 30;
  const x0 = 2, x1 = 8, y0 = 0, y1 = 6.5;
  const px = (x) => pad + ((x - x0) / (x1 - x0)) * (w - pad * 2);
  const py = (y) => h - pad - ((y - y0) / (y1 - y0)) * (h - pad * 2);
  const sel = data.find((d) => d.country === highlight);
  return (
    <Svg width={w} height={h} style={{ marginTop: 8 }}>
      {[0, 2, 4, 6].map((g) => (
        <Line key={g} x1={pad} y1={py(g)} x2={w - pad} y2={py(g)} stroke={T.line} strokeWidth={1} />
      ))}
      <Line x1={pad} y1={py(2.1)} x2={w - pad} y2={py(2.1)} stroke={T.warm} strokeWidth={1.4} strokeDasharray="4 4" />
      <SvgText x={w - pad} y={py(2.1) - 4} fontSize={9} fill="#B0772A" textAnchor="end">razina obnove 2,1</SvgText>
      {data.map((d) => (
        <Circle key={d.country} cx={px(d.life)} cy={py(d.tfr)} r={3} fill={T.accent} fillOpacity={0.5} />
      ))}
      {sel && <Circle cx={px(sel.life)} cy={py(sel.tfr)} r={7} fill="#d62728" />}
      <SvgText x={pad} y={h - 8} fontSize={10} fill={T.sub}>sreća →</SvgText>
      <SvgText x={pad - 4} y={pad} fontSize={10} fill={T.sub}>djece/ženi</SvgText>
    </Svg>
  );
}
function FactorLegend() {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 10 }}>
      {FACTORS.map((f) => (
        <View key={f.key} style={{ flexDirection: "row", alignItems: "center", marginRight: 12, marginBottom: 6 }}>
          <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: f.color, marginRight: 5 }} />
          <Text style={{ fontSize: 11, color: T.sub }}>{f.label}</Text>
        </View>
      ))}
    </View>
  );
}

// ---------- styles ----------
const s = StyleSheet.create({
  app: { flex: 1, backgroundColor: T.bg, paddingTop: Platform.OS === "android" ? 28 : 50 },
  eyebrow: { fontSize: 11, letterSpacing: 1.5, color: T.accent, fontWeight: "700" },
  h1: { fontSize: 30, fontWeight: "700", color: T.ink, marginTop: 4 },
  card: { backgroundColor: T.card, borderColor: T.line, borderWidth: 1, borderRadius: 14, padding: 16, marginTop: 14 },
  cardTitle: { fontSize: 18, fontWeight: "700", color: T.ink },
  cardSub: { fontSize: 12.5, color: T.sub, marginTop: 4, lineHeight: 18 },
  chip: { borderWidth: 1, borderColor: T.line, backgroundColor: T.card, borderRadius: 999, paddingVertical: 6, paddingHorizontal: 13, marginRight: 7 },
  chipOn: { backgroundColor: T.ink, borderColor: T.ink },
  chipText: { fontSize: 13, color: T.sub, fontWeight: "600" },
  chipTextOn: { color: "#fff" },
  rankRow: { flexDirection: "row", alignItems: "center", paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: T.line },
  search: { borderWidth: 1, borderColor: T.line, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, fontSize: 13, color: T.ink, backgroundColor: T.card },
  select: { borderWidth: 1, borderColor: T.line, borderRadius: 8, padding: 12, flexDirection: "row", justifyContent: "space-between", backgroundColor: T.card },
  selectText: { fontSize: 15, fontWeight: "600", color: T.ink },
  dropdown: { borderWidth: 1, borderColor: T.line, borderRadius: 8, marginTop: 6, backgroundColor: T.card, padding: 8 },
  ddRow: { paddingVertical: 9, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: T.line },
  toggle: { borderWidth: 1, borderColor: T.line, borderRadius: 8, paddingVertical: 7, paddingHorizontal: 14, marginRight: 8, backgroundColor: T.card },
  toggleOn: { backgroundColor: T.accent, borderColor: T.accent },
  toggleText: { fontSize: 12.5, fontWeight: "600", color: T.sub },
  toggleTextOn: { color: "#fff" },
  badge: { borderWidth: 1.4, borderRadius: 9, paddingVertical: 7, paddingHorizontal: 11, backgroundColor: T.card, alignSelf: "flex-start" },
  btn: { backgroundColor: T.accent, borderRadius: 9, paddingVertical: 11, alignItems: "center", marginTop: 10 },
  note: { fontSize: 12, color: T.sub, marginTop: 10, lineHeight: 17 },
  foot: { fontSize: 11, color: T.sub, marginTop: 24, lineHeight: 17 },
  tabbar: { position: "absolute", bottom: 0, left: 0, right: 0, height: 64, backgroundColor: T.card, borderTopWidth: 1, borderTopColor: T.line, flexDirection: "row", alignItems: "center" },
  tab: { flex: 1, alignItems: "center", justifyContent: "center" },
  tabText: { fontSize: 12.5, color: T.sub, fontWeight: "600" },
  tabTextOn: { color: T.ink },
  tabDot: { width: 5, height: 5, borderRadius: 5, backgroundColor: T.accent, marginTop: 4 },
});
