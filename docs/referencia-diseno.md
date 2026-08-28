# Referencia de diseño para Midas

Extraído de [ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) (MIT), quedándose
solo con lo aplicable a un terminal financiero en React. **No es un rediseño**: Midas ya tiene su
identidad (dark terminal, la constante `C`, estilos inline) y la regla de oro sigue siendo no
regenerar el monolito. Esto es material de consulta para pantallas nuevas y para revisar lo que ya existe.

Se descartaron: los 79 estilos visuales, los stacks que no usamos (Flutter, SwiftUI, Vue, Angular,
JavaFX, Avalonia…), la generación de logos, banners y slides.

## Accesibilidad y UX — 46 reglas críticas y altas

Aplicables a lo que ya existe, sin tocar el diseño. Ahora que Midas se abre a usuarios, esto importa más que antes.

| Sev | Categoría | Regla | Hacer | Evitar |
|---|---|---|---|---|
| 🔴 | Accessibility | **Text Reflow and Spacing** | Use fluid sizes content-driven height and unitless line height | Clip text in fixed-width or fixed-height boxes |
| 🔴 | Accessibility | **Compact Control Semantics** | Prefer a button and expose pressed or selected state that matches the visible label | Use a clickable div or reveal the only action on hover |
| 🔴 | Content | **Essential Text Truncation** | Wrap stack resize or provide a visible full-detail path | Clamp essential meaning only to make cards uniform |
| 🔴 | Security / Accessibili | **Accessible Authentication (Minimum** | Allow password managers and paste; offer passkeys OAuth or another non-cognitive method | Block paste or require manual OTP transcription with no alternative |
| 🟠 | Accessibility | **Color Contrast** | Minimum 4.5:1 ratio for normal text | Low contrast text |
| 🟠 | Accessibility | **Color Only** | Use icons/text in addition to color | Red/green only for error/success |
| 🟠 | Accessibility | **Alt Text** | Descriptive alt text for meaningful images | Empty or missing alt attributes |
| 🟠 | Accessibility | **ARIA Labels** | Add aria-label for icon-only buttons | Icon buttons without labels |
| 🟠 | Accessibility | **Keyboard Navigation** | Keep tab order aligned with visual order and test every action without a pointer | Keyboard traps or illogical tab order |
| 🟠 | Accessibility | **Form Labels** | Use label with for attribute or wrap input | Placeholder-only inputs |
| 🟠 | Accessibility | **Error Messages** | Use aria-live or role=alert for errors | Visual-only error indication |
| 🟠 | Accessibility | **Motion Sensitivity** | Honor prefers-reduced-motion and present the final readable state without parallax or scroll-ja | Force scroll effects |
| 🟠 | Accessibility | **Focus Not Obscured (Minimum)** | Offset sticky UI with scroll-padding and dismiss or move persistent overlays | Let headers footers banners or chat widgets fully cover focus |
| 🟠 | Accessibility | **Dragging Movements** | Add buttons menus or tap-to-move controls and retain keyboard operation | Make dragging the only way to reorder resize or select |
| 🟠 | Accessibility | **Target Size (Minimum)** | Use at least 24 by 24 CSS px or verify spacing equivalent inline user-agent or essential except | Assume native 44pt or 48dp guidance defines web conformance |
| 🟠 | Accessibility | **Contextual Live Badge Updates** | Use one appropriate atomic status message such as 3 items in cart | Announce a bare number or make every badge a competing live region |
| 🟠 | AI Interaction | **Disclaimer** | Clearly label AI generated content | Present AI as human |
| 🟠 | Animation | **Excessive Motion** | Animate 1-2 key elements per view maximum | Animate everything that moves |
| 🟠 | Animation | **Reduced Motion** | Check prefers-reduced-motion media query | Ignore accessibility motion settings |
| 🟠 | Animation | **Loading States** | Use skeleton screens or spinners | Leave UI frozen with no feedback |
| 🟠 | Animation | **Hover vs Tap** | Use click/tap for primary interactions | Rely only on hover for important actions |
| 🟠 | Animation | **Auto-Rotating Content Controls** | Provide previous next and play/pause; stop on focus or hover and when reduced motion is request | Auto-advance slides without a stop control |
| 🟠 | Animation | **Cancellable State Transitions** | Cancel or replace prior motion; set the final semantic state directly and handle cancellation c | Depend on animationend or transitionend for required state correctness |
| 🟠 | Content | **Compact Label Semantics** | Choose static or interactive markup from the label's meaning and ownership | Make every pill clickable or encode status with color alone |
| 🟠 | Content | **Compact Label Overflow** | Bound only unpredictable values; use nowrap with a shrinkable label; expose full text to keyboa | Let one compact label wrap to a second line or use a hover-only tooltip |
| 🟠 | Feedback | **Loading Indicators** | Follow platform and component guidance; preserve layout focus and accessible busy status | Apply one timing threshold to every operation or leave long waits unexplain |
| 🟠 | Forms | **Input Labels** | Always show label above or beside input | Placeholder as only label |
| 🟠 | Forms | **Error Placement** | Show a specific error below the input and reference it with aria-describedby | Show only a top-level error without identifying each invalid field |
| 🟠 | Forms | **Submit Feedback** | Show loading then success/error state | No feedback after submit |
| 🟠 | Forms / Accessibility | **Focusable Error Summary** | Place it at the top of the form; move focus to its heading or container after failed submit; li | Replace inline errors with a visual-only summary or move focus on every blu |
| 🟠 | Interaction | **Focus States** | Use a visible focus ring on every interactive control, including modal controls | Remove focus outline without replacement |
| 🟠 | Interaction | **Loading Buttons** | Disable button and show loading state | Allow multiple clicks during processing |
| 🟠 | Interaction | **Error Feedback** | Show clear error messages near problem | Silent failures with no feedback |
| 🟠 | Interaction | **Confirmation Dialogs** | Confirm before delete/irreversible actions | Delete without confirmation |
| 🟠 | Layout | **Z-Index Management** | Define z-index scale system (10 20 30 50) | Use arbitrary large z-index values |
| 🟠 | Layout | **Content Jumping** | Reserve appropriate space or keep async states in a stable content-driven container | Insert compact text or media without a layout strategy |
| 🟠 | Layout | **Long Token Wrapping** | Use overflow-wrap anywhere and let flex or grid text children shrink | Apply word-break break-all to all prose |
| 🟠 | Layout | **Chip Collection Reflow** | Wrap the collection or use an operable +n disclosure for hidden overflow values | Force all chips into one clipped row or hide overflow values |
| 🟠 | Navigation | **Smooth Scroll** | Use scroll-behavior: smooth on html element | Jump directly without transition |
| 🟠 | Performance | **Image Optimization** | Use appropriate size and format (WebP) | Unoptimized full-size images |
| 🟠 | Responsive | **Touch Friendly** | Increase touch targets on mobile | Same tiny buttons on mobile |
| 🟠 | Responsive | **Readable Font Size** | Minimum 16px body text on mobile | Tiny text on mobile |
| 🟠 | Responsive | **Viewport Meta** | Use width=device-width initial-scale=1 | Missing or incorrect viewport |
| 🟠 | Responsive | **Horizontal Scroll** | Ensure content fits viewport width | Content wider than viewport |
| 🟠 | Spatial UI | **Gaze Hover** | Scale/highlight element on look | Static element until pinch |
| 🟠 | Typography | **Contrast Readability** | Use darker text on light backgrounds | Gray text on gray background |

## Performance de React — 7 aplicables (de 12)

Midas es un monolito de ~43.000 líneas que compila a un bundle de 2 MB, y Vite avisa en cada build
que hay chunks de más de 500 kB. Ojo que **buena parte del CSV original asume Next.js**
(Server Components, API routes, `dynamic()`), y Midas es Vite + SPA: abajo van solo las que sí aplican,
y al final las que se descartan y por qué.

| Sev | Categoría | Problema | Hacer | Dónde pega en Midas |
|---|---|---|---|---|
| 🔴 | Async Waterfall | **Defer Await** | Move await operations into branches where they're needed | Menor: aplica a los workers más que al front |
| 🔴 | Async Waterfall | **Promise.all Parallel** | Use Promise.all() for independent operations | Ya se usa en `CajaTiempoModule` al bajar precios; revisar los hooks de cotizaciones |
| 🔴 | Async Waterfall | **Dependency Parallelization** | Use better-all to start each task at earliest possible moment | Los `useEffect` que encadenan fetches de precios |
| 🔴 | Bundle Size | **Barrel Imports** | Import directly from source path | No aplica: Midas es un archivo único, no hay barrels |
| 🔴 | Bundle Size | **Dynamic Imports** | Use dynamic() for heavy components | El bundle de 2 MB: `React.lazy` por módulo (Reportes, Analizadores, Calculadoras) sería la mejora más grande |
| 🟠 | Bundle Size | **Conditional Loading** | Dynamic import when feature enabled | Módulos que solo ve el admin, o pantallas detrás de un flag |
| 🟠 | Rendering | **Content Visibility** | Use content-visibility for long lists | Tablas largas: libro de movimientos, posiciones consolidadas, Decision Log |

**Descartadas por ser de Next.js** (5): API Route Optimization, Suspense Boundaries, LRU Cache Cross-Request, Minimize Serialization, Parallel Fetching.

## Qué gráfico usar — 25 tipos de dato

La columna que más sirve es **cuándo NO usarlo**: es la que evita el gráfico lindo que no dice nada.

### Trend Over Time → **Line Chart**
- **Alternativas:** Area Chart, Smooth Area
- **Cuándo:** Data has a time axis; user needs to observe rise/fall trends or rate of change over a continuous period
- **Cuándo NO:** Fewer than 4 data points (use stat card); more than 6 series (visual noise); no time dimension exists
- **Volumen:** <1000 pts: SVG; ≥1000 pts: Canvas + downsampling; >10000: aggregate to intervals
- **Color:** Primary: #0080FF. Multiple series: distinct colors + distinct line styles. Fill: 20% opacity
- **Accesibilidad:** Use solid, dashed, and dotted line styles plus direct series labels; never distinguish series by hue alone.
- **Librerías:** Chart.js, Recharts, ApexCharts

### Compare Categories → **Bar Chart (Horizontal or Vertical)**
- **Alternativas:** Column Chart, Grouped Bar
- **Cuándo:** Comparing discrete categories by magnitude; ranking or ordering is the core insight; categories ≤ 15
- **Cuándo NO:** Categories > 15 (use table or search); data has time dimension (use line); showing proportions (use waffle/stacked)
- **Volumen:** <20 categories: vertical bar; 20–50: horizontal bar; >50: paginated table
- **Color:** Each bar: distinct color. Grouped: same hue family. Always sort descending by value
- **Accesibilidad:** Use direct category/value labels and group outlines or patterns; never encode category solely by bar color. Do not rely on color alone.
- **Librerías:** Chart.js, Recharts, D3.js

### Part-to-Whole → **Pie Chart or Donut**
- **Alternativas:** Stacked Bar, Waffle Chart
- **Cuándo:** ≤5 categories; one dominant segment vs rest; emphasis on visual proportion over exact values
- **Cuándo NO:** Categories > 5; slice differences < 5% (visually indistinguishable); user needs precise values; accessibility-first context
- **Volumen:** Max 6 slices; beyond that switch to stacked bar 100%
- **Color:** 5–6 max colors. Contrasting palette. Largest slice at 12 o'clock. Always label slices with %
- **Accesibilidad:** Pie charts do not inherently fail WCAG; unlabeled color-only slices are inaccessible. Use direct labels and patterns, with a non-pie fallback. Do not rely on color alone.
- **Librerías:** Chart.js, Recharts, D3.js

### Correlation / Distribution → **Scatter Plot or Bubble Chart**
- **Alternativas:** Heat Map, Matrix
- **Cuándo:** Exploring relationship between two continuous variables; identifying clusters or outliers in a dataset
- **Cuándo NO:** Variables are categorical (use grouped bar); fewer than 20 points (patterns aren't meaningful); mobile-primary context
- **Volumen:** <500 pts: SVG; 500–5000: Canvas at 0.6–0.8 opacity; >5000: hexbin or aggregate first
- **Color:** Color axis: gradient (blue → red). Bubble size: relative to 3rd variable. Opacity: 0.6–0.8 to show density
- **Accesibilidad:** Combine marker shapes with direct group labels; color may reinforce but must not be the only distinction.
- **Librerías:** D3.js, Plotly, Recharts

### Heatmap / Intensity → **Heat Map or Choropleth**
- **Alternativas:** Grid Heat Map, Bubble Heat
- **Cuándo:** Showing intensity/density across a 2D grid; time-based patterns (e.g., activity by hour × day)
- **Cuándo NO:** Fewer than 20 cells (use bar); user needs to read exact values; colorblind users without pattern fallback
- **Volumen:** Up to 10,000 cells efficiently; beyond that aggregate; calendar heatmap: 365 cells max per SVG
- **Color:** Gradient: Cool (blue) to Hot (red). Divergent scale for ±data. Always include numeric color legend
- **Accesibilidad:** Print values or symbols in cells and use texture/labels in addition to the color scale. Do not rely on color alone.
- **Librerías:** D3.js, Plotly, ApexCharts

### Geographic Data → **Choropleth Map or Bubble Map**
- **Alternativas:** Geographic Heat Map
- **Cuándo:** Data has a regional/location dimension; spatial distribution is the core insight for the user
- **Cuándo NO:** Regions have very different sizes making visual comparison misleading (use bar); mobile-primary context
- **Volumen:** <1000 regions: SVG; ≥1000: Canvas/WebGL (Deck.gl); global maps: tile-based rendering
- **Color:** Single color gradient per region group. Categorized colors for discrete types. Legend with clear scale breaks
- **Accesibilidad:** Label regions directly and pair fills with boundaries or patterns; location meaning cannot depend on color alone.
- **Librerías:** D3.js, Mapbox, Leaflet

### Funnel / Flow → **Funnel Chart or Sankey**
- **Alternativas:** Waterfall (for flows)
- **Cuándo:** Sequential multi-stage process; showing conversion or drop-off rates between defined stages
- **Cuándo NO:** Stages aren't sequential; values don't decrease monotonically (use bar); fewer than 3 stages
- **Volumen:** 3–8 stages optimal; beyond 8 stages group minor steps into 'Other'
- **Color:** Stages: single color gradient (start → end). Show conversion % between each stage. Highlight biggest drop
- **Accesibilidad:** Keep stage names and values visible and distinguish stages with text and boundaries, not only a gradient. Do not rely on color alone.
- **Librerías:** D3.js, Recharts, Custom SVG

### Performance vs Target → **Gauge Chart or Bullet Chart**
- **Alternativas:** Dial, Thermometer
- **Cuándo:** Single KPI measured against a defined target or threshold; dashboard summary context
- **Cuándo NO:** No target or benchmark exists; comparing multiple KPIs at once (use bullet chart grid)
- **Volumen:** Single metric per gauge; for 3+ KPIs use bullet chart grid layout
- **Color:** Performance: Red → Yellow → Green gradient. Target: marker line. Threshold zones clearly differentiated
- **Accesibilidad:** Place the number and target text beside the gauge and label threshold zones; red/yellow/green alone is insufficient.
- **Librerías:** D3.js, ApexCharts, Custom SVG

### Time-Series Forecast → **Line with Confidence Band**
- **Alternativas:** Ribbon Chart
- **Cuándo:** Historical data + model predictions; communicating uncertainty range to non-technical stakeholders
- **Cuándo NO:** No historical baseline; prediction confidence is too low to be useful; audience is not data-literate
- **Volumen:** Keep historical window to 30–90 days for readability; forecast horizon ≤ 30% of visible x-axis range
- **Color:** Actual: solid line #0080FF. Forecast: dashed #FF9500. Confidence band: 15% opacity fill same hue
- **Accesibilidad:** Use solid actual and dashed forecast lines, direct labels, and a named confidence range; hue alone is insufficient.
- **Librerías:** Chart.js, ApexCharts, Plotly

### Anomaly Detection → **Line Chart with Highlights**
- **Alternativas:** Scatter with Alert
- **Cuándo:** Monitoring a time-series for outliers; alerting users to unexpected spikes or dips in operational data
- **Cuándo NO:** Anomalies are predefined categories (use bar with highlight); real-time context without a pause control
- **Volumen:** Stream at ≤60fps with Canvas; batch: up to 10,000 pts; mark anomalies as a separate data layer
- **Color:** Normal: #0080FF solid line. Anomaly marker: #FF0000 circle + filled. Alert band: #FFF3CD background zone
- **Accesibilidad:** Mark anomalies with a distinct shape and text annotation as well as color. Do not rely on color alone.
- **Librerías:** D3.js, Plotly, ApexCharts

### Hierarchical / Nested Data → **Treemap**
- **Alternativas:** Sunburst, Nested Donut, Icicle
- **Cuándo:** Showing size relationships within a hierarchy; overview of proportional structure (e.g., budget breakdown)
- **Cuándo NO:** Hierarchy depth > 3 levels (too complex to read); user needs to compare sibling values precisely
- **Volumen:** <200 nodes: SVG; 200–1000: Canvas; >1000: paginate or pre-filter before rendering
- **Color:** Parent nodes: distinct hues. Children: lighter shades of same hue. White separator borders: 2–3px
- **Accesibilidad:** Label hierarchy nodes and use borders/patterns as well as hue; make the tree table the primary accessible view. Do not rely on color alone.
- **Librerías:** D3.js, Recharts, ApexCharts

### Flow / Process Data → **Sankey Diagram**
- **Alternativas:** Alluvial, Chord Diagram
- **Cuándo:** Showing how quantities flow between nodes; multi-source multi-target distribution
- **Cuándo NO:** Flow directions form loops (use network graph); fewer than 3 source-target pairs; mobile-primary context
- **Volumen:** <50 flows: SVG; ≥50: Canvas; >200 flows: aggregate minor flows into 'Other' node
- **Color:** Gradient from source to target color. Flow opacity: 0.4–0.6. Node labels always visible
- **Accesibilidad:** Label source, target, and value; use line style or node symbols in addition to gradient color. Do not rely on color alone.
- **Librerías:** D3.js (d3-sankey), Plotly

### Cumulative Changes → **Waterfall Chart**
- **Alternativas:** Stacked Bar, Cascade
- **Cuándo:** Showing how individual positive/negative components add up to a final total (e.g., P&L, budget variance)
- **Cuándo NO:** Changes are not additive; more than 12 bars (readability breaks); audience expects a simple total
- **Volumen:** 4–12 bars optimal; beyond 12 aggregate minor items into a single 'Other' bar
- **Color:** Increases: #4CAF50. Decreases: #F44336. Start total: #2196F3. End total: #0D47A1. Running total line: dashed
- **Accesibilidad:** Pair increase/decrease bars with signed values and directional icons, not red/green alone. Do not rely on color alone.
- **Librerías:** ApexCharts, Highcharts, Plotly

### Multi-Variable Comparison → **Radar / Spider Chart**
- **Alternativas:** Parallel Coordinates, Grouped Bar
- **Cuándo:** Comparing multiple entities across the same fixed set of attributes (e.g., product feature comparison)
- **Cuándo NO:** Axes > 8 (unreadable); values need precise comparison (use grouped bar); audience unfamiliar with radar charts
- **Volumen:** 2–3 datasets maximum per chart; 5–8 axes; beyond 8 axes switch to parallel coordinates
- **Color:** Single dataset: #0080FF at 20% fill. Multiple: distinct hues with 30% fill. Border: full opacity
- **Accesibilidad:** Use line styles, point shapes, and direct series labels in addition to color. Do not rely on color alone.
- **Librerías:** Chart.js, Recharts, ApexCharts

### Stock / Trading OHLC → **Candlestick Chart**
- **Alternativas:** OHLC Bar, Heikin-Ashi
- **Cuándo:** Financial time-series with Open/High/Low/Close data; trading or investment product context only
- **Cuándo NO:** Non-financial audience; no OHLC data available (use line chart); accessibility-first context
- **Volumen:** Real-time: Canvas required. Historical: paginate by time range. Max 500 candles visible at once
- **Color:** Bullish: #26A69A. Bearish: #EF5350. Volume bars: 40% opacity below. Body fill vs hollow for OHLC style
- **Accesibilidad:** Use filled versus hollow candles and OHLC text values; bullish/bearish meaning cannot depend on color. Do not rely on color alone.
- **Librerías:** Lightweight Charts (TradingView), ApexCharts

### Relationship / Connection Data → **Network Graph**
- **Alternativas:** Hierarchical Tree, Adjacency Matrix
- **Cuándo:** Mapping connections between entities; network topology or social graph exploration context
- **Cuándo NO:** Node count > 500 without clustering pre-applied; user needs precise connection counts; mobile context
- **Volumen:** ≤100 nodes: SVG; 101–500: Canvas; >500: must apply clustering/LOD before rendering
- **Color:** Node types: categorical colors. Edges: #90A4AE at 60% opacity. Highlight path: #F59E0B
- **Accesibilidad:** Use labeled node types, shapes, and edge styles in addition to color; the adjacency view is the accessible source of truth. Do not rely on color alone.
- **Librerías:** D3.js (d3-force), Vis.js, Cytoscape.js

### Distribution / Statistical → **Box Plot**
- **Alternativas:** Violin Plot, Beeswarm
- **Cuándo:** Showing spread, median, and outliers of a dataset; comparing distributions across multiple groups
- **Cuándo NO:** Fewer than 20 data points per group (distribution is not meaningful); audience unfamiliar with statistical charts
- **Volumen:** Any sample size; aggregated representation so rendering is ⚡ Excellent at any volume
- **Color:** Box fill: #BBDEFB. Border: #1976D2. Median line: #D32F2F bold. Outlier dots: #F44336
- **Accesibilidad:** Label median, quartiles, whiskers, and outliers directly; do not use color alone for statistical roles.
- **Librerías:** Plotly, D3.js, Chart.js (plugin)

### Performance vs Target (Compact) → **Bullet Chart**
- **Alternativas:** Gauge, Progress Bar
- **Cuándo:** Dashboard with multiple KPIs side by side; space-constrained contexts where a gauge is too large
- **Cuándo NO:** Single KPI with emphasis (use gauge); data has no defined target range; fewer than 3 KPIs
- **Volumen:** Ideal for 3–10 bullet charts in a grid; scales to any count efficiently
- **Color:** Qualitative ranges: #FFCDD2 / #FFF9C4 / #C8E6C9 (bad/ok/good). Performance bar: #1976D2. Target: black 3px marker
- **Accesibilidad:** Label every qualitative range and target with text; color is supplementary.
- **Librerías:** D3.js, Plotly, Custom SVG

### Proportional / Percentage → **Waffle Chart**
- **Alternativas:** Pictogram, Stacked Bar 100%
- **Cuándo:** Showing what fraction of a whole is filled; percentage progress in a visually engaging and accessible format
- **Cuándo NO:** More than 5 categories (use stacked bar); exact values matter over visual proportion; very tight space
- **Volumen:** 10×10 grid standard (100 cells); for > 5 categories switch to stacked 100% bar
- **Color:** 3–5 categories max. 2–3px gap between cells. Each category a distinct accessible color pair
- **Accesibilidad:** Label each category and percentage and add patterns or symbols; filled-cell color alone is insufficient.
- **Librerías:** D3.js, React-Waffle, Custom CSS Grid

### Hierarchical Proportional → **Sunburst Chart**
- **Alternativas:** Treemap, Icicle, Circle Packing
- **Cuándo:** Exploring nested proportions where both hierarchy and relative size matter (e.g., org spend breakdown)
- **Cuándo NO:** More than 3 hierarchy levels (outer rings become unreadable); precision matters over overview; mobile
- **Volumen:** <100 nodes: SVG; 100–500: Canvas; >500: filter to top N before rendering
- **Color:** Center to outer: darker to lighter hue. Each level 15–20% lighter. Contrasting border between sectors
- **Accesibilidad:** Label hierarchy levels and segments and use boundaries/patterns as well as hue; the indented list is primary. Do not rely on color alone.
- **Librerías:** D3.js (d3-hierarchy), Recharts, ApexCharts

### Root Cause Analysis → **Decomposition Tree**
- **Alternativas:** Decision Tree, Flow Chart
- **Cuándo:** Decomposing a metric into contributing factors; AI-assisted analysis or BI drill-down scenarios
- **Cuándo NO:** No clear parent-child causal relationship; audience expects a summary rather than exploration
- **Volumen:** Up to 5 levels deep; limit visible nodes to 20 per level for readability; lazy-load deeper levels
- **Color:** Positive impact nodes: #2563EB. Negative impact nodes: #EF4444. Neutral connectors: #94A3B8
- **Accesibilidad:** Name each node and contribution and use shapes/connector styles in addition to color. Do not rely on color alone.
- **Librerías:** Power BI (native), React-Flow, Custom D3.js

### 3D Spatial Data → **3D Scatter / Surface Plot**
- **Alternativas:** Volumetric Rendering, Point Cloud
- **Cuándo:** Scientific/engineering context where Z-axis carries essential info not expressible in 2D
- **Cuándo NO:** 2D projection conveys the same insight; mobile context; accessibility-required environments; standard business dashboards
- **Volumen:** WebGL required. Deck.gl: up to 1M points. Three.js: LOD required beyond 50,000 pts
- **Color:** Depth cues: lighting and shading. Z-axis: color gradient (cool → warm). Transparent overlapping: opacity 0.4
- **Accesibilidad:** Use labels, shapes, and depth-independent cues; color and 3D position cannot be the only carriers of meaning.
- **Librerías:** Three.js, Deck.gl, Plotly 3D

### Real-Time Streaming → **Streaming Area Chart**
- **Alternativas:** Ticker Tape, Moving Gauge
- **Cuándo:** Live monitoring dashboards; IoT/ops data updating at ≥1 Hz; user needs current value at a glance
- **Cuándo NO:** Update frequency < 1/min (use periodic-refresh line chart); flashing content without reduced-motion support
- **Volumen:** Canvas/WebGL required. Buffer last 60–300s of data. Downsample older data on scroll
- **Color:** Current pulse: #00FF00 (dark theme) or #0080FF (light theme). History: fading opacity. Grid: dark background
- **Accesibilidad:** Show the current value and status text and use line styles or markers in addition to color. Do not rely on color alone.
- **Librerías:** Smoothed D3.js, CanvasJS

### Sentiment / Emotion → **Word Cloud with Sentiment**
- **Alternativas:** Sentiment Arc, Radar Chart
- **Cuándo:** NLP output visualization; exploratory analysis of text corpus sentiment; frequency-weighted keyword overview
- **Cuándo NO:** Precise values matter (word size is inherently imprecise); screen-reader context; corpus < 50 items
- **Volumen:** 50–5000 terms optimal. Beyond 5000: apply top-N filtering before render. Avoid on mobile
- **Color:** Positive: #22C55E. Negative: #EF4444. Neutral: #94A3B8. Word size maps to frequency
- **Accesibilidad:** Expose every term, count, and sentiment as text; size and color are supplementary only.
- **Librerías:** D3-cloud, Highcharts, Nivo

### Process Mining → **Process Map / Graph**
- **Alternativas:** Directed Acyclic Graph (DAG), Petri Net
- **Cuándo:** Analyzing event logs to visualize actual process flows; identifying bottlenecks and deviations in ops/product funnels
- **Cuándo NO:** No event log data available; audience expects a static flowchart (use diagram tool); node count > 100 without pre-filtering
- **Volumen:** <30 nodes: SVG; 30–100: Canvas; >100: apply variant filtering (top 80% of cases) before rendering
- **Color:** Happy path: #10B981 thick line. Deviations: #F59E0B thin line. Bottleneck nodes: #EF4444 fill
- **Accesibilidad:** Label nodes and paths and use shapes/line styles in addition to color; bottlenecks require text annotations. Do not rely on color alone.
- **Librerías:** React-Flow, Cytoscape.js, Recharts

## Paletas del rubro — 10 de 192

Para pantallas nuevas (el panel /admin, la landing). La paleta actual de Midas vive en la constante `C`.

| Producto | Primary | Accent | Background | Foreground | Destructive | Nota |
|---|---|---|---|---|---|---|
| SaaS (General) | `#2563EB` | `#EA580C` | `#F8FAFC` | `#1E293B` | `#DC2626` | Trust blue + orange CTA contrast [Accent adjusted from #F973 |
| Micro SaaS | `#6366F1` | `#059669` | `#F5F3FF` | `#1E1B4B` | `#DC2626` | Indigo primary + emerald CTA [Accent adjusted from #10B981] |
| Financial Dashboard | `#0F172A` | `#22C55E` | `#020617` | `#F8FAFC` | `#EF4444` | Dark bg + green positive indicators |
| Analytics Dashboard | `#1E40AF` | `#D97706` | `#F8FAFC` | `#1E3A8A` | `#DC2626` | Blue data + amber highlights [Accent adjusted from #F59E0B] |
| Fintech/Crypto | `#F59E0B` | `#8B5CF6` | `#0F172A` | `#F8FAFC` | `#EF4444` | Gold trust + purple tech |
| Smart Home/IoT Dashboard | `#1E293B` | `#22C55E` | `#0F172A` | `#F8FAFC` | `#EF4444` | Dark tech + status green |
| Banking/Traditional Finance | `#0F172A` | `#A16207` | `#F8FAFC` | `#020617` | `#DC2626` | Trust navy + premium gold [Accent adjusted from #CA8A04] |
| Personal Finance Tracker | `#1E40AF` | `#059669` | `#0F172A` | `#FFFFFF` | `#DC2626` | Trust blue + profit green on dark |
| Patent / IP Database | `#475569` | `#A16207` | `#F8FAFC` | `#1E293B` | `#DC2626` | Formal neutral + patent type chips + status badges |
| RPA / Automation Dashboard | `#0F172A` | `#16A34A` | `#020617` | `#F8FAFC` | `#DC2626` | Dark terminal + running green + failed red + queued amber |

## Tipografías monoespaciadas — 59

Un terminal muestra números en columnas: la monoespaciada no es decorativa, es lo que hace que los
dígitos aliñen. Midas ya usa `font-variant-numeric: tabular-nums` en las tablas, que resuelve lo mismo
sin cambiar de familia.

Anonymous Pro · Atkinson Hyperlegible Mono · Azeret Mono · B612 Mono · Cascadia Mono · Chivo Mono · Courier Prime · Cousine · Cutive Mono · Datatype · DM Mono · Fira Code · Fira Mono · Fragment Mono · Geist Mono · Google Sans Code · Hibur Mono · IBM Plex Mono · Inconsolata · Intel One Mono · Iosevka Charon · Iosevka Charon Mono · JetBrains Mono · Kode Mono · Lekton
