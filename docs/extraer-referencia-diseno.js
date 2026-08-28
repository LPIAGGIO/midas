/* Saca del repo ui-ux-pro-max SOLO lo aplicable a Midas y descarta el resto.
 * Midas es un monolito React con estilos inline y estetica dark terminal: no
 * vamos a rediseniarlo, asi que las paletas y los estilos van como referencia
 * para pantallas NUEVAS, y lo que de verdad sirve hoy son las reglas de
 * accesibilidad, las de performance de React y la guia de graficos. */
const fs = require("fs");
const path = require("path");
const BASE = path.join(__dirname, "uiux/.claude/skills/ui-ux-pro-max/data");

// Parser de CSV con comillas (los campos traen comas adentro).
function parseCsv(txt) {
  const filas = []; let campo = ""; let fila = []; let enComillas = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (enComillas) {
      if (c === '"') { if (txt[i + 1] === '"') { campo += '"'; i++; } else enComillas = false; }
      else campo += c;
    } else if (c === '"') enComillas = true;
    else if (c === ",") { fila.push(campo); campo = ""; }
    else if (c === "\n") { fila.push(campo); filas.push(fila); fila = []; campo = ""; }
    else if (c !== "\r") campo += c;
  }
  if (campo || fila.length) { fila.push(campo); filas.push(fila); }
  const cab = filas.shift();
  return filas.filter((f) => f.length >= cab.length - 2 && f.some((x) => x.trim()))
    .map((f) => Object.fromEntries(cab.map((h, i) => [h.trim(), (f[i] || "").trim()])));
}
const leer = (n) => parseCsv(fs.readFileSync(path.join(BASE, n), "utf8"));

const ux = leer("ux-guidelines.csv");
const perf = leer("react-performance.csv");
const charts = leer("charts.csv");
const colors = leer("colors.csv");
const fonts = leer("google-fonts.csv");

const out = [];
const W = (s) => out.push(s);

W("# Referencia de diseño para Midas");
W("");
W("Extraído de [ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) (MIT), quedándose");
W("solo con lo aplicable a un terminal financiero en React. **No es un rediseño**: Midas ya tiene su");
W("identidad (dark terminal, la constante `C`, estilos inline) y la regla de oro sigue siendo no");
W("regenerar el monolito. Esto es material de consulta para pantallas nuevas y para revisar lo que ya existe.");
W("");
W("Se descartaron: los 79 estilos visuales, los stacks que no usamos (Flutter, SwiftUI, Vue, Angular,");
W("JavaFX, Avalonia…), la generación de logos, banners y slides.");
W("");

// ── Accesibilidad y UX: solo lo critico/alto y aplicable a web ──────────
const sevOrden = { Critical: 0, High: 1, Medium: 2, Low: 3 };
const uxRel = ux
  .filter((r) => ["Critical", "High"].includes(r.Severity))
  .filter((r) => !/mobile|ios|android/i.test(r.Platform || ""))
  .sort((a, b) => (sevOrden[a.Severity] ?? 9) - (sevOrden[b.Severity] ?? 9) || a.Category.localeCompare(b.Category));

W(`## Accesibilidad y UX — ${uxRel.length} reglas críticas y altas`);
W("");
W("Aplicables a lo que ya existe, sin tocar el diseño. Ahora que Midas se abre a usuarios, esto importa más que antes.");
W("");
W("| Sev | Categoría | Regla | Hacer | Evitar |");
W("|---|---|---|---|---|");
for (const r of uxRel) {
  const lim = (s, n) => (s || "").replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, n);
  W(`| ${r.Severity === "Critical" ? "🔴" : "🟠"} | ${lim(r.Category, 22)} | **${lim(r.Issue, 34)}** | ${lim(r.Do, 95)} | ${lim(r["Don't"], 75)} |`);
}
W("");

// ── Performance de React: un monolito de 43k lineas y 2 MB de bundle ────
const perfRel = perf.filter((r) => ["Critical", "High"].includes(r.Severity));
// Buena parte de estas reglas asumen Next.js (Server Components, API routes,
// dynamic()). Midas es Vite + React SPA, asi que hay que separar el grano.
const noAplica = /^(Server)$/i;
const noAplicaIssue = /API Route|Serialization|LRU Cache|Suspense/i;
const aplica = (r) => !noAplica.test(r.Category) && !noAplicaIssue.test(r.Issue);
W(`## Performance de React — ${perfRel.filter(aplica).length} aplicables (de ${perfRel.length})`);
W("");
W("Midas es un monolito de ~43.000 líneas que compila a un bundle de 2 MB, y Vite avisa en cada build");
W("que hay chunks de más de 500 kB. Ojo que **buena parte del CSV original asume Next.js**");
W("(Server Components, API routes, `dynamic()`), y Midas es Vite + SPA: abajo van solo las que sí aplican,");
W("y al final las que se descartan y por qué.");
W("");
W("| Sev | Categoría | Problema | Hacer | Dónde pega en Midas |");
W("|---|---|---|---|---|");
const dondePega = {
  "Dynamic Imports": "El bundle de 2 MB: `React.lazy` por módulo (Reportes, Analizadores, Calculadoras) sería la mejora más grande",
  "Content Visibility": "Tablas largas: libro de movimientos, posiciones consolidadas, Decision Log",
  "Promise.all Parallel": "Ya se usa en `CajaTiempoModule` al bajar precios; revisar los hooks de cotizaciones",
  "Dependency Parallelization": "Los `useEffect` que encadenan fetches de precios",
  "Defer Await": "Menor: aplica a los workers más que al front",
  "Conditional Loading": "Módulos que solo ve el admin, o pantallas detrás de un flag",
  "Barrel Imports": "No aplica: Midas es un archivo único, no hay barrels",
};
for (const r of perfRel.filter(aplica).sort((a, b) => (sevOrden[a.Severity] ?? 9) - (sevOrden[b.Severity] ?? 9))) {
  const lim = (s, n) => (s || "").replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, n);
  W(`| ${r.Severity === "Critical" ? "🔴" : "🟠"} | ${lim(r.Category, 20)} | **${lim(r.Issue, 28)}** | ${lim(r.Do, 78)} | ${dondePega[r.Issue] || "—"} |`);
}
W("");
W(`**Descartadas por ser de Next.js** (${perfRel.filter((r) => !aplica(r)).length}): ` +
  perfRel.filter((r) => !aplica(r)).map((r) => r.Issue).join(", ") + ".");
W("");

// ── Graficos: lo que mas usa un terminal ───────────────────────────────
W(`## Qué gráfico usar — ${charts.length} tipos de dato`);
W("");
W("La columna que más sirve es **cuándo NO usarlo**: es la que evita el gráfico lindo que no dice nada.");
W("");
for (const r of charts) {
  W(`### ${r["Data Type"]} → **${r["Best Chart Type"]}**`);
  W(`- **Alternativas:** ${r["Secondary Options"] || "—"}`);
  W(`- **Cuándo:** ${r["When to Use"]}`);
  W(`- **Cuándo NO:** ${r["When NOT to Use"]}`);
  if (r["Data Volume Threshold"]) W(`- **Volumen:** ${r["Data Volume Threshold"]}`);
  if (r["Color Guidance"]) W(`- **Color:** ${r["Color Guidance"]}`);
  if (r["Accessibility Notes"]) W(`- **Accesibilidad:** ${r["Accessibility Notes"]}`);
  if (r["Library Recommendation"]) W(`- **Librerías:** ${r["Library Recommendation"]}`);
  W("");
}

// ── Paletas: solo las de nuestro rubro ─────────────────────────────────
const rubro = /fintech|financ|trading|invest|bank|crypto|dashboard|analytics|data|saas|admin/i;
const colRel = colors.filter((r) => rubro.test(r["Product Type"] || ""));
W(`## Paletas del rubro — ${colRel.length} de ${colors.length}`);
W("");
W("Para pantallas nuevas (el panel /admin, la landing). La paleta actual de Midas vive en la constante `C`.");
W("");
W("| Producto | Primary | Accent | Background | Foreground | Destructive | Nota |");
W("|---|---|---|---|---|---|---|");
for (const r of colRel) {
  W(`| ${r["Product Type"]} | \`${r.Primary}\` | \`${r.Accent}\` | \`${r.Background}\` | \`${r.Foreground}\` | \`${r.Destructive}\` | ${(r.Notes || "").slice(0, 60)} |`);
}
W("");

// ── Tipografias: solo las mono y las de datos ──────────────────────────
const cabF = Object.keys(fonts[0] || {});
const colNom = cabF.find((c) => /name|font|family/i.test(c)) || cabF[0];
const colCat = cabF.find((c) => /categ|type|class/i.test(c));
const mono = fonts.filter((f) => /mono/i.test((f[colNom] || "") + " " + (colCat ? f[colCat] : "")));
W(`## Tipografías monoespaciadas — ${mono.length}`);
W("");
W("Un terminal muestra números en columnas: la monoespaciada no es decorativa, es lo que hace que los");
W("dígitos aliñen. Midas ya usa `font-variant-numeric: tabular-nums` en las tablas, que resuelve lo mismo");
W("sin cambiar de familia.");
W("");
W(mono.slice(0, 25).map((f) => f[colNom]).filter(Boolean).join(" · "));
W("");

fs.writeFileSync(path.join(__dirname, "midas-design-reference.md"), out.join("\n"));
console.log("escrito: midas-design-reference.md");
console.log(`  ${uxRel.length} reglas de UX/accesibilidad (de ${ux.length})`);
console.log(`  ${perfRel.length} reglas de performance React (de ${perf.length})`);
console.log(`  ${charts.length} guias de graficos`);
console.log(`  ${colRel.length} paletas del rubro (de ${colors.length})`);
console.log(`  ${mono.length} tipografias mono (de ${fonts.length})`);
