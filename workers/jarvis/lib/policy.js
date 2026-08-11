/**
 * Politica de permisos de Jarvis.
 *
 * Regla de oro (misma que el sistema de trading): leer es libre, escribir pide
 * confirmacion, plata NUNCA es automatica. Este modulo es el unico lugar donde
 * se decide en que categoria cae una accion; si algo no se reconoce, cae en la
 * categoria mas restrictiva que aplique. Fail-closed, no fail-open.
 *
 * Tres resultados posibles:
 *   'auto'    -> se ejecuta sin molestar (lectura, o allowlist del usuario)
 *   'confirm' -> se propone y espera el boton
 *   'deny'    -> no se ejecuta nunca, ni preguntando
 */

// Herramientas de solo lectura: no cambian nada afuera.
const READ_TOOLS = new Set([
  "Read", "Glob", "Grep", "NotebookRead", "WebFetch", "WebSearch",
  "TodoWrite", "Task", "ListMcpResources", "ReadMcpResource",
]);

// Herramientas que escriben en el mundo. Siempre pasan por confirmacion
// salvo que el usuario las haya graduado a la allowlist.
const WRITE_TOOLS = new Set([
  "Write", "Edit", "MultiEdit", "NotebookEdit",
]);

/**
 * Comandos de shell considerados lectura. Se matchea el primer token del
 * comando (y el subcomando en el caso de git/npm/pm2), no una substring
 * cualquiera: buscar "ls" adentro del comando daria falsos positivos.
 */
const READONLY_BIN = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "rg", "find", "stat", "file",
  "du", "df", "free", "uptime", "date", "whoami", "pwd", "which", "echo",
  "node", "jq", "sort", "uniq", "cut", "awk", "sed", "diff", "tree", "env",
]);
const READONLY_SUBCMD = {
  git: new Set(["status", "log", "diff", "show", "branch", "remote", "config", "blame"]),
  npm: new Set(["ls", "list", "view", "outdated"]),
  pm2: new Set(["list", "status", "logs", "show", "describe", "info"]),
  docker: new Set(["ps", "images", "logs", "inspect"]),
};

/**
 * Patrones que NO se ejecutan aunque el usuario apriete aprobar. Son cosas
 * cuyo modo de fallar es catastrofico e irreversible, o que le sacarian a
 * Jarvis su propio freno de mano.
 */
const HARD_DENY = [
  // El terminador tiene que aceptar comilla y fin de string: el comando se
  // inspecciona tanto crudo como serializado en JSON.
  { re: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+\/\s*(["']|$)/, why: "rm recursivo sobre la raiz" },
  { re: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+\/(bin|boot|etc|home|lib|root|sbin|usr|var)\b/, why: "rm recursivo sobre un directorio del sistema" },
  { re: /\b(mkfs|fdisk|parted)\b/, why: "operacion de disco destructiva" },
  { re: /\bdd\s+[^|]*of=\/dev\//, why: "escritura directa a un dispositivo" },
  { re: />\s*\/dev\/(sd|nvme|hd)/, why: "escritura directa a un dispositivo" },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/, why: "apagar o reiniciar el servidor" },
  { re: /\b(userdel|passwd|usermod)\b/, why: "modificar cuentas del sistema" },
  { re: /\bchmod\s+(-[a-zA-Z]+\s+)*777\s+\//, why: "permisos abiertos sobre la raiz" },
  { re: /\bcurl\b[^|;]*\|\s*(ba)?sh\b/, why: "ejecutar un script bajado de internet" },
  { re: /\bwget\b[^|;]*\|\s*(ba)?sh\b/, why: "ejecutar un script bajado de internet" },
  { re: /\bpm2\s+(delete|kill|unstartup)\b/, why: "dar de baja los workers del VPS" },
  { re: /\bdrop\s+(table|database|schema)\b/i, why: "borrar estructuras de la base" },
  { re: /\btruncate\s+table\b/i, why: "vaciar una tabla" },
  { re: /jarvis_(actions|allowlist|channel_links)/i, why: "tocar sus propios registros de auditoria o permisos" },
  { re: /\.env\b/, why: "leer o escribir archivos de secretos" },
  { re: /\bid_ed25519\b|\bid_rsa\b|\.ssh\//, why: "tocar claves SSH" },
];

/**
 * Herramientas que mueven plata. Nunca automaticas, nunca graduables a la
 * allowlist, siempre con confirmacion explicita. Se matchea por nombre de
 * herramienta MCP: los servidores de broker exponen place_order y companhia.
 */
const MONEY_RE = /(place_order|cancel_order|place_caucion|subscribe_fci|redeem_fci|create_stop_loss|delete_stop_loss|buy_|sell_|transfer|withdraw|deposit|payment|checkout)/i;

/** Herramientas que mandan mensajes en nombre del usuario. Siempre confirman. */
const OUTBOUND_RE = /(send_message|send_email|send_mail|post_|publish|reply_|tweet|sendMessage)/i;

/**
 * Extrae el binario y subcomando de una linea de shell, ignorando prefijos de
 * entorno (VAR=x cmd) y respetando que el comando puede venir encadenado.
 */
function shellSegments(command) {
  return String(command || "")
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map((seg) => seg.trim())
    .filter(Boolean);
}

function isReadOnlyShell(command) {
  const segs = shellSegments(command);
  if (!segs.length) return false;
  return segs.every((seg) => {
    const tokens = seg.split(/\s+/).filter((t) => !/^[A-Z_][A-Z0-9_]*=/.test(t));
    if (!tokens.length) return false;
    const bin = (tokens[0].split("/").pop() || "").toLowerCase();
    if (READONLY_SUBCMD[bin]) {
      const sub = (tokens[1] || "").toLowerCase();
      return READONLY_SUBCMD[bin].has(sub);
    }
    if (!READONLY_BIN.has(bin)) return false;
    // Aun con un binario de lectura, una redireccion escribe.
    if (/[^>]>[^>]|>>/.test(seg)) return false;
    return true;
  });
}

/**
 * Clasifica una llamada a herramienta.
 * @returns {{decision:'auto'|'confirm'|'deny', risk:'read'|'write'|'money', why?:string}}
 */
export function classify(toolName, toolInput) {
  const name = String(toolName || "");
  const input = toolInput || {};

  // 1. Deny duro primero: gana sobre todo lo demas, incluida la allowlist.
  //    Se inspecciona el nombre, el JSON completo y ademas cada valor string
  //    por separado: un patron anclado al fin del comando no matchea contra el
  //    JSON, donde despues del comando viene una comilla.
  const haystacks = [name, typeof input === "string" ? input : JSON.stringify(input)];
  if (input && typeof input === "object") {
    for (const v of Object.values(input)) if (typeof v === "string") haystacks.push(v);
  }
  for (const rule of HARD_DENY) {
    if (haystacks.some((h) => rule.re.test(h))) {
      return { decision: "deny", risk: "write", why: rule.why };
    }
  }

  // 2. Plata: confirmacion siempre, sin excepcion ni graduacion.
  if (MONEY_RE.test(name)) {
    return { decision: "confirm", risk: "money", why: "mueve plata" };
  }

  // 3. Mensajes salientes en nombre del usuario.
  if (OUTBOUND_RE.test(name)) {
    return { decision: "confirm", risk: "write", why: "manda algo en tu nombre" };
  }

  // 4. Lectura pura.
  if (READ_TOOLS.has(name)) {
    return { decision: "auto", risk: "read" };
  }

  // 5. Bash: depende del comando.
  if (name === "Bash" || name === "BashOutput" || name === "KillShell") {
    if (name !== "Bash") return { decision: "auto", risk: "read" };
    if (isReadOnlyShell(input.command)) return { decision: "auto", risk: "read" };
    return { decision: "confirm", risk: "write", why: "comando de shell que modifica algo" };
  }

  // 6. Escritura conocida.
  if (WRITE_TOOLS.has(name)) {
    return { decision: "confirm", risk: "write", why: "escribe archivos" };
  }

  // 7. Herramientas MCP de solo lectura conocidas (get_*, list_*, search_*).
  //    Se aplica solo al nombre corto para no auto-aprobar un get_ que en
  //    realidad muta (los que mutan estan cubiertos por MONEY_RE arriba).
  const short = name.split("__").pop() || name;
  if (/^(get|list|search|read|fetch|query|describe|validate|check)_/i.test(short)) {
    return { decision: "auto", risk: "read" };
  }

  // 8. Default fail-closed: lo que no conozco, se pregunta.
  return { decision: "confirm", risk: "write", why: "herramienta no clasificada" };
}

/**
 * Chequea si una accion ya fue graduada a automatica por el usuario.
 * La allowlist NUNCA aplica a riesgo 'money' ni a un deny duro.
 */
export function matchesAllowlist(entries, toolName, toolInput, risk) {
  if (risk === "money") return null;
  if (!Array.isArray(entries)) return null;
  for (const e of entries) {
    if (!e.enabled || e.tool_name !== toolName) continue;
    if (!e.input_matcher) return e;
    const ok = Object.entries(e.input_matcher).every(([k, v]) => {
      const actual = toolInput?.[k];
      if (typeof v === "string" && v.startsWith("re:")) {
        try { return new RegExp(v.slice(3)).test(String(actual ?? "")); }
        catch { return false; }
      }
      return actual === v;
    });
    if (ok) return e;
  }
  return null;
}

/** Resumen corto y legible de la accion, para el mensaje de confirmacion. */
export function describeAction(toolName, toolInput) {
  const i = toolInput || {};
  switch (toolName) {
    case "Bash": return `correr: ${truncate(i.command, 300)}`;
    case "Write": return `escribir el archivo ${i.file_path}`;
    case "Edit":
    case "MultiEdit": return `editar el archivo ${i.file_path}`;
    case "WebFetch": return `leer ${i.url}`;
    default: {
      const short = toolName.split("__").pop() || toolName;
      const args = truncate(JSON.stringify(i), 300);
      return `${short} ${args}`;
    }
  }
}

function truncate(s, n) {
  const str = String(s ?? "");
  return str.length > n ? str.slice(0, n) + "..." : str;
}

export const _internals = { isReadOnlyShell, shellSegments, HARD_DENY };
