/* ==========================================================================
   server.js
   Servidor de la app (sin dependencias externas, solo Node.js).

   - Sirve la app (login.html, index.html, js, css, imágenes).
   - Guarda TODOS los datos de forma centralizada, compartidos por todos
     los equipos que entran a la app por este servidor:
       usuarios (contraseñas cifradas), sesiones, módulos, respuestas
       manuales del asistente, progreso de cada usuario y documentos.
   - El login se valida aquí; cada ruta de la API exige sesión y permisos.

   Estructura en disco (carpeta data/ — hacer respaldo periódico):
     data/db.json                 -> usuarios, sesiones, módulos, chatKb, progreso
     data/docs.json               -> documentos del asistente (texto extraído)
     data/archivos/<id>.<ext>     -> archivo original de cada documento
     data/miniaturas/<id>.jpg     -> miniatura de documentos tipo imagen
     data/kb-imagenes/<id>.<ext>  -> imágenes de las respuestas manuales

   Uso:  npm start   (o iniciar-servidor.bat)
   ========================================================================== */

const http = require("http");
const https = require("https");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const vm = require("vm");
const crypto = require("crypto");
const motorKb = require("./kb-docs.js");

const PORT = Number(process.env.PORT) || 3006;
const HOST = process.env.HOST || "0.0.0.0";
const EXTERNAL_IP = process.env.EXTERNAL_IP || "186.81.6.227";
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const DOCS_FILE = path.join(DATA_DIR, "docs.json");
const ARCHIVOS_DIR = path.join(DATA_DIR, "archivos");
const MINIATURAS_DIR = path.join(DATA_DIR, "miniaturas");
const KB_IMAGENES_DIR = path.join(DATA_DIR, "kb-imagenes");
const BIBLIOTECA_DIR = path.join(DATA_DIR, "biblioteca");

const MAX_JSON_BYTES = 25 * 1024 * 1024;
const MAX_ARCHIVO_BYTES = 30 * 1024 * 1024;
const MAX_BIBLIOTECA_BYTES = 100 * 1024 * 1024;
const MAX_IMAGEN_KB_BYTES = 2 * 1024 * 1024;
const SESION_HORAS = 12;
const COOKIE = "mussi_cap_sid";
const COOKIE_LEGACY = "mussi_sid";

function obtenerIpsLocales() {
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
  if (process.env.LOCAL_IP && !ips.includes(process.env.LOCAL_IP)) {
    ips.unshift(process.env.LOCAL_IP);
  }
  return ips;
}

function obtenerOrigenesPermitidos() {
  const origenes = new Set([
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
    `http://${EXTERNAL_IP}:${PORT}`
  ]);
  obtenerIpsLocales().forEach((ip) => origenes.add(`http://${ip}:${PORT}`));
  return origenes;
}

function esOrigenPermitido(origen, req) {
  if (!origen) return true;
  if (obtenerOrigenesPermitidos().has(origen)) return true;
  try {
    const hostOrigen = new URL(origen).host;
    const hostReq = req.headers["x-forwarded-host"] || req.headers.host;
    return hostOrigen === req.headers.host || hostOrigen === hostReq;
  } catch (e) {
    return false;
  }
}

function aplicarHeadersCors(req, res) {
  const origen = req.headers.origin;
  if (origen && esOrigenPermitido(origen, req)) {
    res.setHeader("Access-Control-Allow-Origin", origen);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Vary", "Origin");
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".ppt": "application/vnd.ms-powerpoint",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".csv": "text/csv; charset=utf-8",
  ".zip": "application/zip",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8"
};

// Archivos/carpetas del proyecto que NO se sirven como estáticos
const PRIVADOS = new Set([
  "data", "node_modules", ".git", "server.js", "package.json", "package-lock.json", "app-data.js", "iniciar-servidor.bat"
]);

/* ==========================================================
   PERSISTENCIA
   ========================================================== */

[ARCHIVOS_DIR, MINIATURAS_DIR, KB_IMAGENES_DIR, BIBLIOTECA_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));

function leerJson(ruta, porDefecto) {
  try {
    return JSON.parse(fs.readFileSync(ruta, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") {
      // Archivo dañado: se respalda en lugar de sobrescribirlo
      const respaldo = ruta + ".danado-" + Date.now();
      fs.copyFileSync(ruta, respaldo);
      console.error(`! ${path.basename(ruta)} no se pudo leer; copia guardada en ${respaldo}`);
    }
    return porDefecto;
  }
}

// Escrituras en serie con archivo temporal para no corromper los JSON
const colas = {};
function escribirJson(ruta, obtenerDatos) {
  colas[ruta] = (colas[ruta] || Promise.resolve()).then(async () => {
    const tmp = ruta + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(obtenerDatos()));
    await fsp.rename(tmp, ruta);
  });
  return colas[ruta];
}

function nuevoId(prefijo) {
  return prefijo + "-" + Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex");
}

/* ---------- Contraseñas ---------- */

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function verificarPassword(password, guardado) {
  const [alg, salt, hash] = String(guardado || "").split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const calculado = crypto.scryptSync(String(password), salt, 64);
  const esperado = Buffer.from(hash, "hex");
  return esperado.length === calculado.length && crypto.timingSafeEqual(esperado, calculado);
}

/* ---------- Datos semilla (desde app-data.js) ---------- */

function cargarSemilla() {
  try {
    const codigo = fs.readFileSync(path.join(ROOT, "app-data.js"), "utf8");
    return vm.runInNewContext(codigo + ";({ DEFAULT_MODULES, DEFAULT_CHAT_KB })", {});
  } catch (e) {
    console.warn("No se pudo leer app-data.js, se inicia sin módulos de ejemplo.", e.message);
    return { DEFAULT_MODULES: [], DEFAULT_CHAT_KB: [] };
  }
}

function crearDbInicial() {
  const semilla = cargarSemilla();
  return {
    usuarios: [
      {
        id: "u-admin",
        nombre: "Administrador",
        usuario: "admin",
        passwordHash: hashPassword("Mussi26#"),
        rol: "admin",
        permisos: { contenido: true, ia: true, progreso: true }
      }
    ],
    sesiones: {},
    modulos: semilla.DEFAULT_MODULES,
    chatKb: semilla.DEFAULT_CHAT_KB.map((k) => ({ id: nuevoId("kb"), imagen: "", moduloId: "", ...k })),
    biblioteca: [],
    progreso: {}
  };
}

const IA_INSTRUCCIONES_BASE_ANTERIOR =
  "Eres el Asistente Virtual de Capacitación y Soporte de Front Retail (MUSSI Zapatos). " +
  "Responde siempre en español claro, amable, directo y paso a paso (máximo 5-6 líneas o viñetas cortas). " +
  "Básate estrictamente en el CONTEXTO OFICIAL proporcionado abajo. " +
  "Si la pregunta es un saludo o agradecimiento, responde cordialmente ofreciendo ayuda con Front Retail. " +
  "Si la información solicitada NO aparece en el contexto oficial, no inventes procedimientos ni datos: indica amablemente que aún no tienes ese detalle registrado y sugiere revisar la Biblioteca de Recursos o contactar a Soporte Técnico (soporte.ti@frontretail.com · Ext. 1234).";

const IA_INSTRUCCIONES_BASE =
  "Eres el Asistente Virtual de Capacitación y Soporte de Front Retail (MUSSI Zapatos). " +
  "Responde siempre en español claro, amable, directo y bien estructurado (usa viñetas breves cuando facilite la lectura). " +
  "Tu función principal es ANALIZAR, RELACIONAR, SINTETIZAR y COMPARAR todas las RESPUESTAS OFICIALES, MANUALES y MÓDULOS del CONTEXTO OFICIAL para dar una explicación propia y útil (por ejemplo, si preguntan la diferencia entre un Cambio y una Devolución, compara ambos procedimientos paso a paso usando las reglas actuales). " +
  "Si la pregunta es un saludo o agradecimiento, responde cordialmente ofreciendo ayuda con Front Retail. " +
  "No inventes políticas, teléfonos ni pasos ajenos al contexto oficial: si un tema no aparece en absoluto en el contexto, indícalo amablemente y sugiere revisar la Biblioteca de Recursos o contactar a Soporte Técnico (soporte.ti@frontretail.com · Ext. 1234).";

function configIaPorDefecto() {
  return {
    habilitado: true,
    url: process.env.OLLAMA_URL || "http://127.0.0.1:11434",
    modelo: process.env.OLLAMA_MODEL || "llama3.2:3b",
    instrucciones: IA_INSTRUCCIONES_BASE
  };
}

let db = leerJson(DB_FILE, null);
if (!db) {
  db = crearDbInicial();
  fs.writeFileSync(DB_FILE, JSON.stringify(db));
  console.log("  Base de datos creada con el usuario admin por defecto.");
}
db.sesiones = db.sesiones || {};
db.progreso = db.progreso || {};
db.biblioteca = db.biblioteca || [];
db.iaConfig = Object.assign(configIaPorDefecto(), db.iaConfig || {});
if (!db.iaConfig.instrucciones || db.iaConfig.instrucciones === IA_INSTRUCCIONES_BASE_ANTERIOR) {
  db.iaConfig.instrucciones = IA_INSTRUCCIONES_BASE;
}

let docs = leerJson(DOCS_FILE, []);
let indiceDocsCache = null;

function obtenerIndiceDocs() {
  if (!indiceDocsCache) {
    indiceDocsCache = motorKb.kbConstruirIndice(docs);
  }
  return indiceDocsCache;
}

const guardarDb = () => escribirJson(DB_FILE, () => db);
const guardarDocs = () => {
  indiceDocsCache = null;
  return escribirJson(DOCS_FILE, () => docs);
};

/* ==========================================================
   SESIONES Y PERMISOS
   ========================================================== */

function leerCookies(req) {
  const out = {};
  String(req.headers.cookie || "")
    .split(";")
    .forEach((par) => {
      const i = par.indexOf("=");
      if (i > 0) out[par.slice(0, i).trim()] = decodeURIComponent(par.slice(i + 1).trim());
    });
  return out;
}

function tokenSesionDeReq(req) {
  const cookies = leerCookies(req);
  if (cookies[COOKIE] && db.sesiones[cookies[COOKIE]]) return cookies[COOKIE];
  if (cookies[COOKIE_LEGACY] && db.sesiones[cookies[COOKIE_LEGACY]]) return cookies[COOKIE_LEGACY];
  return cookies[COOKIE] || "";
}

function usuarioDeReq(req) {
  const token = tokenSesionDeReq(req);
  const sesion = token && db.sesiones[token];
  if (!sesion) return null;
  if (sesion.expira < Date.now()) {
    delete db.sesiones[token];
    return null;
  }
  return db.usuarios.find((u) => u.id === sesion.userId) || null;
}

function sesionPublica(u) {
  return { id: u.id, nombre: u.nombre, usuario: u.usuario, rol: u.rol, permisos: u.permisos };
}

function usuarioPublico(u) {
  return sesionPublica(u);
}

function puede(u, permiso) {
  return !!u && (u.rol === "admin" || !!(u.permisos && u.permisos[permiso]));
}

function limpiarSesionesVencidas() {
  const ahora = Date.now();
  let cambios = false;
  Object.keys(db.sesiones).forEach((t) => {
    if (db.sesiones[t].expira < ahora) {
      delete db.sesiones[t];
      cambios = true;
    }
  });
  if (cambios) guardarDb();
}
limpiarSesionesVencidas();
setInterval(limpiarSesionesVencidas, 60 * 60 * 1000).unref();

// Freno simple a intentos de login fallidos (por IP)
const intentosFallidos = new Map();
function loginBloqueado(ip) {
  const r = intentosFallidos.get(ip);
  return r && r.bloqueadoHasta > Date.now();
}
function registrarFallo(ip) {
  const r = intentosFallidos.get(ip) || { n: 0, bloqueadoHasta: 0 };
  r.n++;
  if (r.n >= 8) {
    r.n = 0;
    r.bloqueadoHasta = Date.now() + 5 * 60 * 1000;
  }
  intentosFallidos.set(ip, r);
}

/* ==========================================================
   HELPERS HTTP
   ========================================================== */

class ErrorHttp extends Error {
  constructor(status, mensaje) {
    super(mensaje);
    this.status = status;
  }
}

function enviarJson(res, status, data, headers) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(data));
}

function leerCuerpo(req, max) {
  return new Promise((resolve, reject) => {
    const partes = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > max) {
        reject(new ErrorHttp(413, "El archivo es demasiado grande."));
        req.destroy();
        return;
      }
      partes.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(partes)));
    req.on("error", reject);
  });
}

async function leerJsonCuerpo(req) {
  const raw = (await leerCuerpo(req, MAX_JSON_BYTES)).toString("utf8");
  try {
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    throw new ErrorHttp(400, "JSON inválido.");
  }
}

async function enviarArchivo(res, ruta, tipo, nombreDescarga, privado, req) {
  try {
    const stat = await fsp.stat(ruta);
    if (!stat.isFile()) throw new Error("no es archivo");
    const headers = {
      "Content-Type": tipo || "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Cache-Control": privado ? "private, no-cache" : "no-cache"
    };
    if (nombreDescarga) headers["Content-Disposition"] = `inline; filename*=UTF-8''${encodeURIComponent(nombreDescarga)}`;

    const range = req && req.headers && req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m) {
        const inicio = m[1] ? parseInt(m[1], 10) : 0;
        const fin = m[2] ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1;
        if (inicio <= fin && inicio < stat.size) {
          headers["Content-Range"] = `bytes ${inicio}-${fin}/${stat.size}`;
          headers["Content-Length"] = fin - inicio + 1;
          res.writeHead(206, headers);
          fs.createReadStream(ruta, { start: inicio, end: fin }).pipe(res);
          return;
        }
      }
    }

    headers["Content-Length"] = stat.size;
    res.writeHead(200, headers);
    fs.createReadStream(ruta).pipe(res);
  } catch (e) {
    enviarJson(res, 404, { error: "No encontrado" });
  }
}

function guardarStreamEnArchivo(req, destino, maxBytes) {
  return new Promise((resolve, reject) => {
    const tmp = destino + ".tmp";
    const out = fs.createWriteStream(tmp);
    let total = 0;
    let fallado = false;

    const abortar = (err) => {
      if (fallado) return;
      fallado = true;
      out.destroy();
      fsp.unlink(tmp).catch(() => {});
      reject(err);
    };

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        abortar(new ErrorHttp(413, "El archivo supera el tamaño máximo permitido (100 MB)."));
      }
    });
    req.on("error", abortar);
    out.on("error", abortar);
    out.on("finish", async () => {
      if (fallado) return;
      try {
        await fsp.rename(tmp, destino);
        resolve(total);
      } catch (e) {
        abortar(e);
      }
    });
    req.pipe(out);
  });
}

function texto(valor, max) {
  return String(valor == null ? "" : valor).trim().slice(0, max);
}

function extensionSegura(nombre) {
  const ext = path.extname(String(nombre || "")).toLowerCase();
  return /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : "";
}

function decodificarDataUrlImagen(dataUrl, maxBytes) {
  const m = /^data:image\/(jpeg|jpg|png|gif|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m) return null;
  const buffer = Buffer.from(m[2], "base64");
  if (buffer.length > maxBytes) throw new ErrorHttp(413, "La imagen es demasiado grande.");
  return { buffer, ext: m[1] === "jpeg" ? ".jpg" : "." + m[1] };
}

const esUrlCanva = (u) => /^https:\/\/(www\.)?canva\.com\//i.test(String(u || ""));
const esHttps = (u) => /^https:\/\//i.test(String(u || ""));

/* ==========================================================
   API: AUTENTICACIÓN
   ========================================================== */

async function apiLogin(req, res) {
  const ip =
    (process.env.TRUST_PROXY === "1" && req.headers["x-forwarded-for"]
      ? String(req.headers["x-forwarded-for"]).split(",")[0].trim()
      : null) || req.socket.remoteAddress;
  if (loginBloqueado(ip)) throw new ErrorHttp(429, "Demasiados intentos fallidos. Espera 5 minutos.");

  const { usuario, password } = await leerJsonCuerpo(req);
  const u = db.usuarios.find((x) => x.usuario.toLowerCase() === texto(usuario, 100).toLowerCase());
  if (!u || !verificarPassword(password, u.passwordHash)) {
    registrarFallo(ip);
    throw new ErrorHttp(401, "Usuario o contraseña incorrectos.");
  }
  intentosFallidos.delete(ip);

  const token = crypto.randomBytes(32).toString("hex");
  db.sesiones[token] = { userId: u.id, expira: Date.now() + SESION_HORAS * 3600 * 1000 };
  await guardarDb();

  enviarJson(res, 200, sesionPublica(u), {
    "Set-Cookie": `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESION_HORAS * 3600}`
  });
}

async function apiLogout(req, res) {
  const token = tokenSesionDeReq(req);
  if (token && db.sesiones[token]) {
    delete db.sesiones[token];
    await guardarDb();
  }
  enviarJson(res, 200, { ok: true }, { "Set-Cookie": `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` });
}

/* ==========================================================
   API: USUARIOS
   ========================================================== */

function crearUsuarioEnDb({ nombre, usuario, password, rol, permisos, passwordHash }) {
  nombre = texto(nombre, 100);
  usuario = texto(usuario, 60);
  if (!nombre || !usuario || (!password && !passwordHash)) throw new ErrorHttp(400, "Completa nombre, usuario y contraseña.");
  if (!["admin", "asesor", "aprendiz"].includes(rol)) throw new ErrorHttp(400, "Rol inválido.");
  if (db.usuarios.some((u) => u.usuario.toLowerCase() === usuario.toLowerCase())) {
    throw new ErrorHttp(409, "Ya existe un usuario con ese nombre de usuario.");
  }
  permisos = permisos || {};
  const nuevo = {
    id: nuevoId("u"),
    nombre,
    usuario,
    passwordHash: passwordHash || hashPassword(password),
    rol,
    permisos:
      rol === "admin"
        ? { contenido: true, ia: true, progreso: true }
        : { contenido: !!permisos.contenido, ia: !!permisos.ia, progreso: !!permisos.progreso }
  };
  db.usuarios.push(nuevo);
  return nuevo;
}

async function apiUsuarios(req, res, yo, id) {
  if (!id && req.method === "GET") {
    // El admin ve todos; quien tiene permiso de progreso ve la lista (para el reporte de aprendices)
    if (!puede(yo, "progreso") && yo.rol !== "admin") throw new ErrorHttp(403, "Sin permiso.");
    const lista = yo.rol === "admin" ? db.usuarios : db.usuarios.filter((u) => u.rol === "aprendiz");
    return enviarJson(res, 200, lista.map(usuarioPublico));
  }

  if (yo.rol !== "admin") throw new ErrorHttp(403, "Solo el Administrador puede gestionar usuarios.");

  if (!id && req.method === "POST") {
    const nuevo = crearUsuarioEnDb(await leerJsonCuerpo(req));
    await guardarDb();
    return enviarJson(res, 201, usuarioPublico(nuevo));
  }

  if (id && req.method === "DELETE") {
    const objetivo = db.usuarios.find((u) => u.id === id);
    if (!objetivo) throw new ErrorHttp(404, "Usuario no encontrado.");
    if (objetivo.rol === "admin" && db.usuarios.filter((u) => u.rol === "admin").length <= 1) {
      throw new ErrorHttp(400, "Debe existir al menos un administrador. No se puede eliminar el último.");
    }
    if (objetivo.id === yo.id) throw new ErrorHttp(400, "No puedes eliminar tu propio usuario.");
    db.usuarios = db.usuarios.filter((u) => u.id !== id);
    delete db.progreso[objetivo.usuario];
    Object.keys(db.sesiones).forEach((t) => db.sesiones[t].userId === id && delete db.sesiones[t]);
    await guardarDb();
    return enviarJson(res, 200, { ok: true });
  }

  throw new ErrorHttp(405, "Método no permitido");
}

/* ==========================================================
   API: MÓDULOS
   ========================================================== */

function normalizarModulo(body) {
  if (!esUrlCanva(body.embedSrc)) throw new ErrorHttp(400, "El enlace del módulo debe ser de canva.com.");
  return {
    id: nuevoId("mod"),
    titulo: texto(body.titulo, 150) || "Nuevo módulo",
    descripcion: texto(body.descripcion, 600) || "Contenido agregado desde el panel de administración.",
    categoria: ["pos", "ops", "case", "serv", "fact", "nuevo"].includes(body.categoria) ? body.categoria : "nuevo",
    embedSrc: String(body.embedSrc),
    fuente: esHttps(body.fuente) ? String(body.fuente).slice(0, 1000) : ""
  };
}

async function apiModulos(req, res, yo, id) {
  if (!id && req.method === "GET") return enviarJson(res, 200, db.modulos);

  if (!puede(yo, "contenido")) throw new ErrorHttp(403, "Sin permiso para gestionar contenido.");

  if (!id && req.method === "POST") {
    const modulo = normalizarModulo(await leerJsonCuerpo(req));
    db.modulos.push(modulo);
    await guardarDb();
    return enviarJson(res, 201, modulo);
  }

  if (id && req.method === "DELETE") {
    if (!db.modulos.some((m) => m.id === id)) throw new ErrorHttp(404, "Módulo no encontrado.");
    db.modulos = db.modulos.filter((m) => m.id !== id);
    Object.values(db.progreso).forEach((p) => delete p[id]);
    db.chatKb.forEach((k) => k.moduloId === id && (k.moduloId = ""));
    docs.forEach((d) => d.moduloId === id && (d.moduloId = ""));
    await Promise.all([guardarDb(), guardarDocs()]);
    return enviarJson(res, 200, { ok: true });
  }

  throw new ErrorHttp(405, "Método no permitido");
}

/* ==========================================================
   API: RESPUESTAS MANUALES DEL ASISTENTE (chat KB)
   ========================================================== */

function kbPublico(k) {
  return {
    id: k.id,
    keywords: k.keywords,
    respuesta: k.respuesta,
    moduloId: k.moduloId || "",
    imagen: k.imagenArchivo ? `/api/chat-kb/${k.id}/imagen` : ""
  };
}

async function crearEntradaKb(body) {
  const keywords = (Array.isArray(body.keywords) ? body.keywords : [])
    .map((k) => texto(k, 80))
    .filter(Boolean)
    .slice(0, 30);
  const respuesta = texto(body.respuesta, 3000);
  if (!keywords.length || !respuesta) throw new ErrorHttp(400, "Agrega al menos una palabra clave y la respuesta.");

  const entrada = {
    id: nuevoId("kb"),
    keywords,
    respuesta,
    moduloId: db.modulos.some((m) => m.id === body.moduloId) ? body.moduloId : "",
    imagenArchivo: ""
  };

  const img = decodificarDataUrlImagen(body.imagen, MAX_IMAGEN_KB_BYTES);
  if (img) {
    entrada.imagenArchivo = entrada.id + img.ext;
    await fsp.writeFile(path.join(KB_IMAGENES_DIR, entrada.imagenArchivo), img.buffer);
  }
  return entrada;
}

async function apiChatKb(req, res, yo, id, sub) {
  if (!id && req.method === "GET") return enviarJson(res, 200, db.chatKb.map(kbPublico));

  if (id && sub === "imagen" && req.method === "GET") {
    const k = db.chatKb.find((x) => x.id === id);
    if (!k || !k.imagenArchivo) throw new ErrorHttp(404, "Sin imagen.");
    return enviarArchivo(res, path.join(KB_IMAGENES_DIR, k.imagenArchivo), MIME[path.extname(k.imagenArchivo)], null, true);
  }

  if (!puede(yo, "ia")) throw new ErrorHttp(403, "Sin permiso para entrenar al asistente.");

  if (!id && req.method === "POST") {
    const entrada = await crearEntradaKb(await leerJsonCuerpo(req));
    db.chatKb.push(entrada);
    await guardarDb();
    return enviarJson(res, 201, kbPublico(entrada));
  }

  if (id && !sub && req.method === "DELETE") {
    const k = db.chatKb.find((x) => x.id === id);
    if (!k) throw new ErrorHttp(404, "Respuesta no encontrada.");
    db.chatKb = db.chatKb.filter((x) => x.id !== id);
    if (k.imagenArchivo) await fsp.unlink(path.join(KB_IMAGENES_DIR, k.imagenArchivo)).catch(() => {});
    await guardarDb();
    return enviarJson(res, 200, { ok: true });
  }

  throw new ErrorHttp(405, "Método no permitido");
}

/* ==========================================================
   API: PROGRESO
   ========================================================== */

async function apiProgreso(req, res, yo, moduloId) {
  if (!moduloId && req.method === "GET") {
    // Con permiso de progreso: el de todos. Si no: solo el propio.
    if (puede(yo, "progreso") && yo.rol !== "aprendiz") return enviarJson(res, 200, db.progreso);
    return enviarJson(res, 200, { [yo.usuario]: db.progreso[yo.usuario] || {} });
  }

  if (moduloId && req.method === "PUT") {
    if (!db.modulos.some((m) => m.id === moduloId)) throw new ErrorHttp(404, "Módulo no encontrado.");
    const { completado } = await leerJsonCuerpo(req);
    db.progreso[yo.usuario] = db.progreso[yo.usuario] || {};
    if (completado) db.progreso[yo.usuario][moduloId] = true;
    else delete db.progreso[yo.usuario][moduloId];
    await guardarDb();
    return enviarJson(res, 200, db.progreso[yo.usuario]);
  }

  throw new ErrorHttp(405, "Método no permitido");
}

/* ==========================================================
   API: MIGRACIÓN (datos que estaban en el navegador de un admin)
   ========================================================== */

async function apiMigrar(req, res, yo) {
  if (yo.rol !== "admin") throw new ErrorHttp(403, "Solo el Administrador.");
  const body = await leerJsonCuerpo(req);
  const r = { usuarios: 0, modulos: 0, respuestas: 0, progreso: 0 };
  const mapaModulos = {}; // id local -> id en servidor

  (Array.isArray(body.modulos) ? body.modulos : []).forEach((m) => {
    if (!m || !m.titulo) return;
    const existente = db.modulos.find((x) => x.id === m.id || (x.embedSrc && x.embedSrc === m.embedSrc) || x.titulo === m.titulo);
    if (existente) {
      mapaModulos[m.id] = existente.id;
      return;
    }
    if (!esUrlCanva(m.embedSrc)) return; // módulos sin contenido Canva no se migran
    const nuevo = normalizarModulo(m);
    db.modulos.push(nuevo);
    mapaModulos[m.id] = nuevo.id;
    r.modulos++;
  });

  (Array.isArray(body.usuarios) ? body.usuarios : []).forEach((u) => {
    if (!u || !u.usuario || !u.password) return;
    if (db.usuarios.some((x) => x.usuario.toLowerCase() === String(u.usuario).toLowerCase())) return;
    try {
      crearUsuarioEnDb(u);
      r.usuarios++;
    } catch (e) {}
  });

  for (const k of Array.isArray(body.chatKb) ? body.chatKb : []) {
    if (!k || !Array.isArray(k.keywords)) continue;
    const firma = (x) => x.keywords.join("|").toLowerCase() + "::" + String(x.respuesta).trim();
    if (db.chatKb.some((x) => firma(x) === firma(k))) continue;
    try {
      const entrada = await crearEntradaKb({ ...k, moduloId: mapaModulos[k.moduloId] || k.moduloId });
      db.chatKb.push(entrada);
      r.respuestas++;
    } catch (e) {}
  }

  Object.entries(body.progreso && typeof body.progreso === "object" ? body.progreso : {}).forEach(([usuario, mods]) => {
    if (!db.usuarios.some((u) => u.usuario === usuario) || !mods) return;
    db.progreso[usuario] = db.progreso[usuario] || {};
    Object.entries(mods).forEach(([modId, ok]) => {
      const idServidor = mapaModulos[modId] || modId;
      if (ok && db.modulos.some((m) => m.id === idServidor) && !db.progreso[usuario][idServidor]) {
        db.progreso[usuario][idServidor] = true;
        r.progreso++;
      }
    });
  });

  await guardarDb();
  enviarJson(res, 200, r);
}

/* ==========================================================
   API: DOCUMENTOS DEL ASISTENTE
   ========================================================== */

const ID_DOC = /^doc-[a-z0-9-]{4,60}$/i;

function rutaArchivoDoc(doc) {
  return path.join(ARCHIVOS_DIR, doc.id + (doc.archivoExt || ""));
}

function docPublico(doc) {
  return {
    id: doc.id,
    nombre: doc.nombre,
    tipo: doc.tipo,
    tamano: doc.tamano,
    fecha: doc.fecha,
    descripcion: doc.descripcion,
    moduloId: doc.moduloId,
    subidoPor: doc.subidoPor || "",
    miniatura: doc.tieneMiniatura ? `/api/docs/${doc.id}/miniatura` : "",
    archivo: doc.tieneArchivo ? `/api/docs/${doc.id}/archivo` : "",
    chunks: doc.chunks
  };
}

async function apiDocs(req, res, yo, id, sub) {
  if (!id && req.method === "GET") return enviarJson(res, 200, docs.map(docPublico));

  const doc = id ? (ID_DOC.test(id) ? docs.find((d) => d.id === id) : null) : undefined;
  if (id && !doc) throw new ErrorHttp(404, "Documento no encontrado.");

  if (doc && sub === "archivo" && req.method === "GET") {
    return enviarArchivo(res, rutaArchivoDoc(doc), MIME[doc.archivoExt], doc.nombre, true);
  }
  if (doc && sub === "miniatura" && req.method === "GET") {
    return enviarArchivo(res, path.join(MINIATURAS_DIR, doc.id + ".jpg"), "image/jpeg", null, true);
  }

  if (!puede(yo, "ia")) throw new ErrorHttp(403, "Sin permiso para entrenar al asistente.");

  if (!id && req.method === "POST") {
    const body = await leerJsonCuerpo(req);
    if (!body.nombre || !Array.isArray(body.chunks) || !body.chunks.length) throw new ErrorHttp(400, "Documento inválido.");

    const nuevo = {
      id: nuevoId("doc"),
      nombre: texto(body.nombre, 200),
      tipo: texto(body.tipo, 20),
      tamano: Number(body.tamano) || 0,
      fecha: new Date().toISOString(),
      descripcion: texto(body.descripcion, 500),
      moduloId: db.modulos.some((m) => m.id === body.moduloId) ? body.moduloId : "",
      subidoPor: yo.nombre,
      archivoExt: extensionSegura(body.nombre),
      tieneArchivo: false,
      tieneMiniatura: false,
      chunks: body.chunks
        .filter((c) => c && typeof c.texto === "string")
        .map((c) => ({ texto: c.texto, pagina: Number(c.pagina) || null }))
    };

    const mini = decodificarDataUrlImagen(body.miniatura, MAX_ARCHIVO_BYTES);
    if (mini) {
      await fsp.writeFile(path.join(MINIATURAS_DIR, nuevo.id + ".jpg"), mini.buffer);
      nuevo.tieneMiniatura = true;
    }

    docs.push(nuevo);
    await guardarDocs();
    return enviarJson(res, 201, docPublico(nuevo));
  }

  if (doc && sub === "archivo" && req.method === "PUT") {
    await fsp.writeFile(rutaArchivoDoc(doc), await leerCuerpo(req, MAX_ARCHIVO_BYTES));
    doc.tieneArchivo = true;
    await guardarDocs();
    return enviarJson(res, 200, docPublico(doc));
  }

  if (doc && !sub && req.method === "DELETE") {
    docs = docs.filter((d) => d.id !== doc.id);
    await guardarDocs();
    await fsp.unlink(rutaArchivoDoc(doc)).catch(() => {});
    await fsp.unlink(path.join(MINIATURAS_DIR, doc.id + ".jpg")).catch(() => {});
    return enviarJson(res, 200, { ok: true });
  }

  throw new ErrorHttp(405, "Método no permitido");
}

/* ==========================================================
   API: BIBLIOTECA DE RECURSOS
   - Todos los usuarios con sesión pueden VISUALIZAR (GET)
   - SOLO el Administrador (rol === "admin") puede AÑADIR / ELIMINAR
   ========================================================== */

const ID_BIB = /^bib-[a-z0-9-]{4,60}$/i;
const CATEGORIAS_BIB = ["manual", "guia", "video", "formato", "otro"];

function rutaArchivoBib(item) {
  return path.join(BIBLIOTECA_DIR, item.id + (item.ext || ""));
}

function recursoBibPublico(item) {
  return {
    id: item.id,
    titulo: item.titulo,
    descripcion: item.descripcion || "",
    categoria: item.categoria || "manual",
    nombreArchivo: item.nombreArchivo || "",
    ext: item.ext || "",
    tamano: item.tamano || 0,
    fecha: item.fecha,
    subidoPor: item.subidoPor || "",
    urlExterna: item.urlExterna || "",
    archivo: item.tieneArchivo ? `/api/biblioteca/${item.id}/archivo` : ""
  };
}

async function apiBiblioteca(req, res, yo, id, sub) {
  if (!id && req.method === "GET") {
    return enviarJson(res, 200, db.biblioteca.filter((x) => x.tieneArchivo || x.urlExterna).map(recursoBibPublico));
  }

  const item = id ? (ID_BIB.test(id) ? db.biblioteca.find((x) => x.id === id) : null) : undefined;
  if (id && !item) throw new ErrorHttp(404, "Recurso no encontrado.");

  if (item && sub === "archivo" && req.method === "GET") {
    if (!item.tieneArchivo) throw new ErrorHttp(404, "Archivo no disponible.");
    return enviarArchivo(res, rutaArchivoBib(item), MIME[item.ext] || "application/octet-stream", item.nombreArchivo, true, req);
  }

  // Estricto: únicamente el Administrador puede subir o eliminar en la Biblioteca
  if (yo.rol !== "admin") {
    throw new ErrorHttp(403, "Solo el Administrador puede añadir o gestionar documentos de la Biblioteca.");
  }

  if (!id && req.method === "POST") {
    const body = await leerJsonCuerpo(req);
    const nombreArchivo = texto(body.nombreArchivo, 220);
    const ext = extensionSegura(nombreArchivo);
    const urlExterna = esHttps(body.urlExterna) ? String(body.urlExterna).trim().slice(0, 1000) : "";

    if (!nombreArchivo && !urlExterna) {
      throw new ErrorHttp(400, "Selecciona un archivo o ingresa un enlace HTTPS válido.");
    }
    if (nombreArchivo && !ext) {
      throw new ErrorHttp(400, "El archivo debe tener una extensión válida (ej. .pdf, .docx, .mp4, .png).");
    }

    const baseNombre = nombreArchivo ? path.basename(nombreArchivo, ext) : "Recurso";
    const nuevo = {
      id: nuevoId("bib"),
      titulo: texto(body.titulo, 160) || baseNombre,
      descripcion: texto(body.descripcion, 500),
      categoria: CATEGORIAS_BIB.includes(body.categoria) ? body.categoria : "manual",
      nombreArchivo,
      ext,
      tamano: Number(body.tamano) || 0,
      fecha: new Date().toISOString(),
      subidoPor: yo.nombre,
      urlExterna,
      tieneArchivo: false
    };

    db.biblioteca.unshift(nuevo);
    await guardarDb();
    return enviarJson(res, 201, recursoBibPublico(nuevo));
  }

  if (item && sub === "archivo" && req.method === "PUT") {
    const bytes = await guardarStreamEnArchivo(req, rutaArchivoBib(item), MAX_BIBLIOTECA_BYTES);
    item.tieneArchivo = true;
    item.tamano = bytes;
    await guardarDb();
    return enviarJson(res, 200, recursoBibPublico(item));
  }

  if (item && !sub && req.method === "DELETE") {
    db.biblioteca = db.biblioteca.filter((x) => x.id !== item.id);
    await guardarDb();
    if (item.tieneArchivo) await fsp.unlink(rutaArchivoBib(item)).catch(() => {});
    return enviarJson(res, 200, { ok: true });
  }

  throw new ErrorHttp(405, "Método no permitido");
}

/* ==========================================================
   API: INTELIGENCIA ARTIFICIAL LOCAL CON OLLAMA (RAG GRATUITO)
   ========================================================== */

function urlOllamaSegura(valor) {
  const candidata = String(valor || "http://127.0.0.1:11434").trim().replace(/\/+$/, "");
  try {
    const u = new URL(candidata);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Protocolo inválido");
    const host = u.hostname.toLowerCase();
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
      throw new ErrorHttp(400, "Por seguridad, la URL de Ollama debe ser local (http://127.0.0.1:11434 o http://localhost:11434).");
    }
    return `${u.protocol}//${u.host}`;
  } catch (e) {
    if (e instanceof ErrorHttp) throw e;
    throw new ErrorHttp(400, "URL de Ollama inválida. Ejemplo: http://127.0.0.1:11434");
  }
}

function peticionJsonLocal(urlDestino, metodo, cuerpoObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlDestino);
    const cliente = u.protocol === "https:" ? https : http;
    const payload = cuerpoObj ? Buffer.from(JSON.stringify(cuerpoObj), "utf8") : null;

    const req = cliente.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: metodo || "GET",
        timeout: timeoutMs || 5000,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": payload.length }
          : {}
      },
      (res) => {
        const partes = [];
        res.on("data", (c) => partes.push(c));
        res.on("end", () => {
          const textoResp = Buffer.concat(partes).toString("utf8");
          let json = null;
          try {
            json = textoResp ? JSON.parse(textoResp) : {};
          } catch (e) {}
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json || {});
          } else {
            reject(new Error((json && json.error) || `HTTP ${res.statusCode}`));
          }
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error("Tiempo de espera agotado con Ollama"));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function consultarEstadoOllama() {
  const baseUrl = db.iaConfig.url || "http://127.0.0.1:11434";
  try {
    const data = await peticionJsonLocal(`${baseUrl}/api/tags`, "GET", null, 3000);
    const modelos = Array.isArray(data.models)
      ? data.models.map((m) => m.name).filter(Boolean)
      : [];
    return { conectado: true, modelos, errorConexion: "" };
  } catch (e) {
    return { conectado: false, modelos: [], errorConexion: e.message || "Sin respuesta" };
  }
}

function elegirModeloOllama(preferido, instalados) {
  if (!instalados.length) return preferido || "llama3.2:3b";
  if (instalados.includes(preferido)) return preferido;
  const raiz = String(preferido || "").split(":")[0].toLowerCase();
  const mismoFamilia = instalados.find((m) => m.split(":")[0].toLowerCase() === raiz);
  if (mismoFamilia) return mismoFamilia;
  const ligeros = instalados.find((m) => /:(1b|1\.5b|2b|3b|mini)\b/i.test(m) && !/embed/i.test(m));
  if (ligeros) return ligeros;
  const modeloChat = instalados.find((m) => !/embed/i.test(m));
  return modeloChat || instalados[0];
}

function esModeloPesadoCpu(modelo) {
  return /:(7b|8b|9b|12b|13b|14b|27b|32b|70b)\b/i.test(String(modelo || ""));
}

function limpiarRespuestaIa(textoCrudo) {
  if (!textoCrudo) return "";
  // Si el usuario tiene un modelo de razonamiento (ej. deepseek-r1 / qwen3), ocultar bloque <think>
  let limpio = String(textoCrudo).replace(/<think>[\s\S]*?<\/think>/gi, "");
  if (limpio.includes("<think>")) {
    limpio = limpio.split("<think>")[0];
  }
  return limpio.trim();
}

function diagnosticarErrorOllama(err, modelo) {
  const msg = String((err && err.message) || err || "Error desconocido");
  if (/ECONNREFUSED/i.test(msg)) {
    return `Ollama no está encendido en ${db.iaConfig.url}. Abre la aplicación Ollama en el servidor.`;
  }
  if (/memory|alloc|cuda|system memory/i.test(msg)) {
    return `El servidor no tiene suficiente memoria RAM libre para cargar el modelo "${modelo}" (${msg}). Ejecuta en CMD: ollama pull llama3.2:3b (solo requiere ~2 GB de RAM).`;
  }
  if (/not found|pull/i.test(msg)) {
    return `El modelo "${modelo}" no está descargado en Ollama. Ejecuta en CMD: ollama pull ${modelo}`;
  }
  if (/Tiempo de espera|timeout/i.test(msg)) {
    const extra = esModeloPesadoCpu(modelo)
      ? ` El modelo "${modelo}" es pesado para CPU sin tarjeta gráfica; te recomendamos ejecutar "ollama pull llama3.2:3b" para respuestas en pocos segundos.`
      : " El procesador del servidor estuvo ocupado cargando el modelo desde el disco.";
    return `Ollama tardó demasiado en responder con el modelo "${modelo}".${extra}`;
  }
  return `Error en Ollama (${modelo}): ${msg}`;
}

/**
 * Envía una conversación a Ollama en modo STREAMING (stream: true) con keep_alive: "24h".
 * Al recibir tokens continuamente se evita el corte por inactividad mientras genera en CPU,
 * y permite dar hasta 180s en el primer arranque en frío desde disco a RAM.
 */
function streamChatOllama(urlBase, cuerpoChat, opcionesStream) {
  const opts = opcionesStream || {};
  const timeoutCargaInicialMs = opts.timeoutInicialMs || 180000;
  const timeoutEntreTokensMs = opts.timeoutTokenMs || 60000;
  const onToken = typeof opts.onToken === "function" ? opts.onToken : null;

  return new Promise((resolve, reject) => {
    const u = new URL(`${urlBase}/api/chat`);
    const cliente = u.protocol === "https:" ? https : http;
    const payload = Buffer.from(
      JSON.stringify(
        Object.assign(
          {
            stream: true,
            keep_alive: "24h"
          },
          cuerpoChat
        )
      ),
      "utf8"
    );

    let finalizado = false;
    let recibioPrimerChunk = false;
    let acumulado = "";
    let bufferLinea = "";
    let timer = null;

    const armarTimer = (ms, etapa) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (finalizado) return;
        finalizado = true;
        req.destroy(
          new Error(
            etapa === "carga"
              ? `Tiempo de espera agotado cargando el modelo en RAM (${Math.round(ms / 1000)}s)`
              : `Tiempo de espera agotado entre palabras de Ollama (${Math.round(ms / 1000)}s)`
          )
        );
      }, ms);
    };

    const req = cliente.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": payload.length
        }
      },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const partesErr = [];
          res.on("data", (c) => partesErr.push(c));
          res.on("end", () => {
            if (timer) clearTimeout(timer);
            if (finalizado) return;
            finalizado = true;
            const txtErr = Buffer.concat(partesErr).toString("utf8");
            let jsonErr = null;
            try {
              jsonErr = JSON.parse(txtErr);
            } catch (e) {}
            reject(new Error((jsonErr && jsonErr.error) || `HTTP ${res.statusCode}`));
          });
          return;
        }

        res.on("data", (chunk) => {
          if (finalizado) return;
          recibioPrimerChunk = true;
          armarTimer(timeoutEntreTokensMs, "generacion");

          bufferLinea += chunk.toString("utf8");
          let idxSalto;
          while ((idxSalto = bufferLinea.indexOf("\n")) >= 0) {
            const linea = bufferLinea.slice(0, idxSalto).trim();
            bufferLinea = bufferLinea.slice(idxSalto + 1);
            if (!linea) continue;
            try {
              const evt = JSON.parse(linea);
              if (evt.error) {
                if (timer) clearTimeout(timer);
                finalizado = true;
                req.destroy();
                return reject(new Error(evt.error));
              }
              const pieza = (evt.message && evt.message.content) || "";
              if (pieza) {
                acumulado += pieza;
                if (onToken) onToken(pieza, acumulado);
              }
            } catch (e) {}
          }
        });

        res.on("end", () => {
          if (timer) clearTimeout(timer);
          if (finalizado) return;
          finalizado = true;
          if (bufferLinea.trim()) {
            try {
              const evt = JSON.parse(bufferLinea.trim());
              const pieza = (evt.message && evt.message.content) || "";
              if (pieza) {
                acumulado += pieza;
                if (onToken) onToken(pieza, acumulado);
              }
            } catch (e) {}
          }
          resolve(acumulado);
        });
      }
    );

    armarTimer(timeoutCargaInicialMs, "carga");

    req.on("error", (err) => {
      if (timer) clearTimeout(timer);
      if (finalizado) return;
      finalizado = true;
      reject(err);
    });

    if ( opts.abortSignal ) {
      opts.abortSignal.onAbort = () => {
        if (!finalizado) {
          finalizado = true;
          if (timer) clearTimeout(timer);
          req.destroy();
        }
      };
    }

    req.write(payload);
    req.end();
  });
}

function construirContextoRag(pregunta) {
  const preguntaNorm = motorKb.kbNormalizar(pregunta);
  const tokensPregunta = new Set(motorKb.kbTokenizar(pregunta));

  let imagenSugerida = "";
  let moduloSugerido = "";
  let fuentePrincipal = "";
  const otrasFuentes = [];
  const bloquesContexto = [];

  // 1) TODAS las respuestas actuales de la tabla del Asistente (ordenadas por relevancia)
  //    Incluir todas permite que Ollama compare, relacione y deduzca diferencias
  //    entre procedimientos (ej: Cambio vs Devolución vs Garantía).
  const manualesOrdenadas = db.chatKb
    .map((item) => {
      let pts = 0;
      (item.keywords || []).forEach((kw) => {
        const kwNorm = motorKb.kbNormalizar(kw);
        if (kwNorm && preguntaNorm.includes(kwNorm)) pts += 10;
        motorKb.kbTokenizar(kw).forEach((t) => {
          if (tokensPregunta.has(t)) pts += 2;
        });
      });
      motorKb.kbTokenizar(item.respuesta || "").forEach((t) => {
        if (tokensPregunta.has(t)) pts += 1;
      });
      return { item, pts };
    })
    .sort((a, b) => b.pts - a.pts);

  if (manualesOrdenadas.length) {
    const coincidenciasDirectas = manualesOrdenadas.filter((x) => x.pts >= 8);
    if (coincidenciasDirectas.length) {
      fuentePrincipal = "Respuestas oficiales Front Retail";
      const conImg = coincidenciasDirectas.find((x) => x.item.imagenArchivo);
      const conMod = coincidenciasDirectas.find((x) => x.item.moduloId);
      if (conImg) imagenSugerida = `/api/chat-kb/${conImg.item.id}/imagen`;
      if (conMod) moduloSugerido = conMod.item.moduloId;
    }

    const seleccionManuales = manualesOrdenadas.slice(0, 50);
    bloquesContexto.push(
      "BASE DE RESPUESTAS Y PROCEDIMIENTOS OFICIALES ACTUALES (usa y compara estas reglas para responder):\n" +
        seleccionManuales
          .map(({ item, pts }) => {
            const marca = pts >= 8 ? "★ [RELEVANTE PARA LA PREGUNTA] " : "";
            return `- ${marca}Tema / Palabras clave (${(item.keywords || []).join(", ")}): ${item.respuesta}`;
          })
          .join("\n")
    );
  }

  // 2) Documentos subidos al entrenamiento IA (búsqueda BM25)
  const indice = obtenerIndiceDocs();
  const resultadosDocs = motorKb.kbBuscar(pregunta, indice, 3);
  if (resultadosDocs.length) {
    const topDoc = resultadosDocs[0];
    const docObj = indice.docs.get(topDoc.fragmento.docId);
    if (docObj && topDoc.cobertura >= 0.35) {
      const etiquetaDoc = docObj.nombre + (topDoc.fragmento.pagina ? " · pág. " + topDoc.fragmento.pagina : "");
      if (!fuentePrincipal) fuentePrincipal = etiquetaDoc;
      else if (!otrasFuentes.includes(docObj.nombre)) otrasFuentes.push(docObj.nombre);

      if (!imagenSugerida && docObj.tieneMiniatura) imagenSugerida = `/api/docs/${docObj.id}/miniatura`;
      if (!moduloSugerido && docObj.moduloId) moduloSugerido = docObj.moduloId;
    }

    resultadosDocs.slice(1).forEach((r) => {
      if (r.cobertura >= 0.4) {
        const d = indice.docs.get(r.fragmento.docId);
        if (d && d.nombre !== fuentePrincipal && !otrasFuentes.includes(d.nombre)) {
          otrasFuentes.push(d.nombre);
        }
      }
    });

    const extractos = resultadosDocs
      .slice(0, 3)
      .map((r) => {
        const d = indice.docs.get(r.fragmento.docId);
        const tituloDoc = d ? d.nombre + (r.fragmento.pagina ? ` (pág. ${r.fragmento.pagina})` : "") : "Documento";
        return `[${tituloDoc}]:\n${r.fragmento.texto.slice(0, 650)}`;
      })
      .join("\n\n");

    bloquesContexto.push("FRAGMENTOS DE MANUALES Y DOCUMENTOS DE ENTRENAMIENTO:\n" + extractos);
  }

  // 3) Catálogo de Módulos de Capacitación y Biblioteca
  if (db.modulos.length) {
    if (!moduloSugerido && tokensPregunta.size) {
      let mejorMod = null;
      let mejorPts = 0;
      db.modulos.forEach((m) => {
        const toks = motorKb.kbTokenizar(m.titulo + " " + (m.descripcion || ""));
        const coincidencias = toks.filter((t) => tokensPregunta.has(t)).length;
        if (coincidencias > mejorPts && coincidencias >= 2) {
          mejorPts = coincidencias;
          mejorMod = m;
        }
      });
      if (mejorMod) moduloSugerido = mejorMod.id;
    }

    bloquesContexto.push(
      "MÓDULOS DE CAPACITACIÓN DISPONIBLES EN LA PLATAFORMA:\n" +
        db.modulos.map((m, idx) => `- Módulo ${idx + 1}: "${m.titulo}" — ${m.descripcion || ""}`).join("\n")
    );
  }

  if (db.biblioteca && db.biblioteca.length) {
    bloquesContexto.push(
      "DOCUMENTOS EN LA BIBLIOTECA DE RECURSOS:\n" +
        db.biblioteca
          .slice(0, 12)
          .map((b) => `- "${b.titulo}" (${b.categoria}): ${b.descripcion || "Disponible en Biblioteca de Recursos"}`)
          .join("\n")
    );
  }

  bloquesContexto.push(
    "CONTACTO DE SOPORTE TÉCNICO:\n- Correo: soporte.ti@frontretail.com · Extensión: 1234"
  );

  return {
    contextoTexto: bloquesContexto.join("\n\n"),
    fuente: fuentePrincipal,
    otrasFuentes,
    imagen: imagenSugerida,
    moduloId: moduloSugerido
  };
}

async function apiIaConfig(req, res, yo, subaccion) {
  if (subaccion === "entrenar" && req.method === "POST") {
    if (!puede(yo, "ia")) throw new ErrorHttp(403, "Sin permiso para entrenar el asistente IA.");
    const body = await leerJsonCuerpo(req);

    // Guardar configuración actual si vino en la petición
    if (body && (body.modelo || body.url || body.instrucciones !== undefined)) {
      db.iaConfig = {
        habilitado: body.habilitado !== false,
        url: urlOllamaSegura(body.url || db.iaConfig.url),
        modelo: texto(body.modelo, 80) || db.iaConfig.modelo || "llama3.2:3b",
        instrucciones: texto(body.instrucciones, 2000) || IA_INSTRUCCIONES_BASE
      };
      await guardarDb();
    }

    // Reconstruir índice de documentos + recargar conocimiento actual
    indiceDocsCache = motorKb.kbConstruirIndice(docs);
    const resumenKb = {
      respuestasManuales: db.chatKb.length,
      documentosIa: docs.length,
      modulos: db.modulos.length,
      biblioteca: (db.biblioteca || []).length
    };

    const estado = await consultarEstadoOllama();
    if (!estado.conectado) {
      return enviarJson(res, 200, {
        ok: false,
        conectado: false,
        modelos: [],
        resumenKb,
        diagnostico: `No se pudo conectar con Ollama en ${db.iaConfig.url} (${estado.errorConexion}). Verifica que Ollama esté abierto en este servidor.`
      });
    }
    if (!estado.modelos.length) {
      return enviarJson(res, 200, {
        ok: false,
        conectado: true,
        modelos: [],
        resumenKb,
        diagnostico: "Ollama está encendido, pero aún no tiene ningún modelo instalado. Abre CMD en el servidor y ejecuta: ollama pull llama3.2:3b"
      });
    }

    const modelo = elegirModeloOllama(db.iaConfig.modelo, estado.modelos);
    const preguntaPrueba =
      texto(body && body.preguntaPrueba, 300) ||
      "¿En qué se diferencia un cambio de una devolución según nuestros procedimientos actuales?";
    const rag = construirContextoRag(preguntaPrueba);
    const systemPrompt =
      `${db.iaConfig.instrucciones || IA_INSTRUCCIONES_BASE}\n\n` +
      `=== CONTEXTO OFICIAL DE FRONT RETAIL / MUSSI ===\n${rag.contextoTexto}\n=== FIN DEL CONTEXTO ===`;

    const inicioMs = Date.now();
    console.log(
      `  [IA Ollama] Sincronizando ${resumenKb.respuestasManuales} respuestas y ${resumenKb.documentosIa} documentos con el modelo "${modelo}"...`
    );

    try {
      const bruto = await streamChatOllama(
        db.iaConfig.url,
        {
          model: modelo,
          options: {
            temperature: 0.2,
            num_ctx: 2048,
            num_predict: 320
          },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: preguntaPrueba }
          ]
        },
        { timeoutInicialMs: 180000, timeoutTokenMs: 60000 }
      );

      const muestraRespuesta = limpiarRespuestaIa(bruto);
      const tiempoMs = Date.now() - inicioMs;
      console.log(
        `  [IA Ollama] Modelo "${modelo}" entrenado/sincronizado y cargado en RAM en ${(tiempoMs / 1000).toFixed(1)}s.`
      );

      return enviarJson(res, 200, {
        ok: true,
        conectado: true,
        modelos: estado.modelos,
        modeloActivo: modelo,
        tiempoMs,
        resumenKb,
        preguntaPrueba,
        muestraRespuesta,
        advertenciaModelo: esModeloPesadoCpu(modelo)
          ? `El modelo "${modelo}" funciona, pero es grande para CPU (${(tiempoMs / 1000).toFixed(1)}s). Si deseas respuestas más rápidas (2-5s), ejecuta en CMD: ollama pull llama3.2:3b`
          : ""
      });
    } catch (err) {
      const diag = diagnosticarErrorOllama(err, modelo);
      console.warn(`  [IA Ollama] Falló la sincronización con "${modelo}": ${diag}`);
      return enviarJson(res, 200, {
        ok: false,
        conectado: true,
        modelos: estado.modelos,
        modeloActivo: modelo,
        resumenKb,
        diagnostico: diag
      });
    }
  }

  if (req.method === "GET") {
    const estado = await consultarEstadoOllama();
    const modeloActivo = elegirModeloOllama(db.iaConfig.modelo, estado.modelos);
    return enviarJson(res, 200, {
      habilitado: !!db.iaConfig.habilitado,
      url: db.iaConfig.url,
      modelo: db.iaConfig.modelo,
      instrucciones: puede(yo, "ia") ? db.iaConfig.instrucciones : undefined,
      conectado: estado.conectado,
      modelos: estado.modelos,
      modeloActivo,
      resumenKb: {
        respuestasManuales: db.chatKb.length,
        documentosIa: docs.length,
        modulos: db.modulos.length,
        biblioteca: (db.biblioteca || []).length
      }
    });
  }

  if (req.method === "PUT") {
    if (!puede(yo, "ia")) throw new ErrorHttp(403, "Sin permiso para configurar el asistente IA.");
    const body = await leerJsonCuerpo(req);
    db.iaConfig = {
      habilitado: body.habilitado !== false,
      url: urlOllamaSegura(body.url || db.iaConfig.url),
      modelo: texto(body.modelo, 80) || "llama3.2:3b",
      instrucciones: texto(body.instrucciones, 2000) || IA_INSTRUCCIONES_BASE
    };
    await guardarDb();
    const estado = await consultarEstadoOllama();
    return enviarJson(res, 200, {
      ...db.iaConfig,
      conectado: estado.conectado,
      modelos: estado.modelos,
      modeloActivo: elegirModeloOllama(db.iaConfig.modelo, estado.modelos)
    });
  }

  throw new ErrorHttp(405, "Método no permitido");
}

async function apiChatAsistente(req, res) {
  if (req.method !== "POST") throw new ErrorHttp(405, "Método no permitido");
  const body = await leerJsonCuerpo(req);
  const pregunta = texto(body.pregunta, 800);
  const usarStream = !!body.stream;
  if (!pregunta) throw new ErrorHttp(400, "Escribe una pregunta.");

  if (!db.iaConfig.habilitado) {
    return enviarJson(res, 200, { fallback: true, motivo: "deshabilitado" });
  }

  const estado = await consultarEstadoOllama();
  if (!estado.conectado || !estado.modelos.length) {
    const detalle = !estado.conectado
      ? `Ollama no responde en ${db.iaConfig.url} (${estado.errorConexion})`
      : "Ollama está activo pero no tiene modelos instalados (ejecuta: ollama pull llama3.2:3b)";
    console.warn(`  [IA Ollama] Usando motor local: ${detalle}`);
    return enviarJson(res, 200, {
      fallback: true,
      motivo: !estado.conectado ? "sin_conexion" : "sin_modelos",
      detalle
    });
  }

  const modelo = elegirModeloOllama(db.iaConfig.modelo, estado.modelos);
  const rag = construirContextoRag(pregunta);

  const systemPrompt =
    `${db.iaConfig.instrucciones || IA_INSTRUCCIONES_BASE}\n\n` +
    `=== CONTEXTO OFICIAL DE FRONT RETAIL / MUSSI ===\n${rag.contextoTexto}\n=== FIN DEL CONTEXTO ===`;

  const historialLimpio = (Array.isArray(body.historial) ? body.historial : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-4)
    .map((m) => ({ role: m.role, content: texto(m.content, 500) }));

  const cuerpoOllama = {
    model: modelo,
    options: {
      temperature: 0.25,
      num_ctx: 2048,
      num_predict: 420
    },
    messages: [
      { role: "system", content: systemPrompt },
      ...historialLimpio,
      { role: "user", content: pregunta }
    ]
  };

  const inicioMs = Date.now();

  if (usarStream) {
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no"
    });

    const escribirEvento = (obj) => {
      if (!res.writableEnded) {
        res.write(JSON.stringify(obj) + "\n");
      }
    };

    escribirEvento({
      tipo: "meta",
      modo: "ollama",
      modelo,
      fuente: rag.fuente,
      otrasFuentes: rag.otrasFuentes,
      imagen: rag.imagen,
      moduloId: rag.moduloId
    });

    const señalAborto = {};
    res.on("close", () => {
      if (señalAborto.onAbort) señalAborto.onAbort();
    });

    try {
      const bruto = await streamChatOllama(db.iaConfig.url, cuerpoOllama, {
        timeoutInicialMs: 180000,
        timeoutTokenMs: 60000,
        abortSignal: señalAborto,
        onToken: (pieza) => {
          escribirEvento({ tipo: "token", texto: pieza });
        }
      });

      const limpia = limpiarRespuestaIa(bruto);
      const segs = ((Date.now() - inicioMs) / 1000).toFixed(1);
      if (!limpia) {
        console.warn(`  [IA Ollama] Respuesta vacía del modelo "${modelo}" tras ${segs}s. Usando motor local.`);
        escribirEvento({ tipo: "fallback", motivo: "vacio", detalle: "Respuesta vacía de Ollama" });
      } else {
        console.log(`  [IA Ollama] Respuesta enviada en ${segs}s (modelo: ${modelo})`);
        escribirEvento({ tipo: "fin", respuesta: limpia, modelo });
      }
    } catch (e) {
      const diag = diagnosticarErrorOllama(e, modelo);
      console.warn(`  [IA Ollama] No pudo responder (${((Date.now() - inicioMs) / 1000).toFixed(1)}s) -> ${diag}`);
      escribirEvento({ tipo: "fallback", motivo: "error_ollama", detalle: diag });
    }
    if (!res.writableEnded) res.end();
    return;
  }

  try {
    const bruto = await streamChatOllama(db.iaConfig.url, cuerpoOllama, {
      timeoutInicialMs: 180000,
      timeoutTokenMs: 60000
    });
    const textoRespuesta = texto(limpiarRespuestaIa(bruto), 3500);
    if (!textoRespuesta) return enviarJson(res, 200, { fallback: true, motivo: "vacio" });

    console.log(
      `  [IA Ollama] Respuesta enviada en ${((Date.now() - inicioMs) / 1000).toFixed(1)}s (modelo: ${modelo})`
    );

    return enviarJson(res, 200, {
      fallback: false,
      modo: "ollama",
      modelo,
      respuesta: textoRespuesta,
      fuente: rag.fuente,
      otrasFuentes: rag.otrasFuentes,
      imagen: rag.imagen,
      moduloId: rag.moduloId
    });
  } catch (e) {
    const diag = diagnosticarErrorOllama(e, modelo);
    console.warn(`  [IA Ollama] No pudo responder -> ${diag}`);
    return enviarJson(res, 200, { fallback: true, motivo: "error_ollama", detalle: diag });
  }
}

/* ==========================================================
   ENRUTADOR
   ========================================================== */

async function manejarApi(req, res, url) {
  const [, recurso, id, sub] = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  if (recurso === "health" && req.method === "GET") {
    return enviarJson(res, 200, {
      ok: true,
      status: "ok",
      port: PORT,
      localIps: obtenerIpsLocales(),
      externalUrl: `http://${EXTERNAL_IP}:${PORT}/`
    });
  }

  if (recurso === "login" && req.method === "POST") return apiLogin(req, res);
  if (recurso === "logout" && req.method === "POST") return apiLogout(req, res);

  const yo = usuarioDeReq(req);
  if (!yo) throw new ErrorHttp(401, "Tu sesión expiró. Inicia sesión de nuevo.");

  // Peticiones que modifican datos: deben venir de orígenes permitidos (local, LAN o IP externa)
  if (req.method !== "GET") {
    if (!esOrigenPermitido(req.headers.origin, req)) {
      throw new ErrorHttp(403, "Origen no permitido.");
    }
  }

  switch (recurso) {
    case "sesion":
      return enviarJson(res, 200, sesionPublica(yo));
    case "usuarios":
      return apiUsuarios(req, res, yo, id);
    case "modulos":
      return apiModulos(req, res, yo, id);
    case "chat-kb":
      return apiChatKb(req, res, yo, id, sub);
    case "progreso":
      return apiProgreso(req, res, yo, id);
    case "docs":
      return apiDocs(req, res, yo, id, sub);
    case "biblioteca":
      return apiBiblioteca(req, res, yo, id, sub);
    case "ia":
      return apiIaConfig(req, res, yo, id);
    case "chat":
      return apiChatAsistente(req, res);
    case "migrar":
      if (req.method === "POST") return apiMigrar(req, res, yo);
  }
  throw new ErrorHttp(404, "Ruta no encontrada");
}

async function servirEstatico(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  // Direcciones sin ".html" (ej. /login, /index): el servidor anterior las usaba
  // y el navegador las recuerda, así que se aceptan igual.
  if (!path.extname(rel) && fs.existsSync(path.join(ROOT, rel + ".html"))) rel += ".html";

  // La app principal solo con sesión iniciada
  if (rel === "/index.html" && !usuarioDeReq(req)) {
    res.writeHead(302, { Location: "/login.html" });
    return res.end();
  }

  const ruta = path.normalize(path.join(ROOT, rel));
  const primerSegmento = path.relative(ROOT, ruta).split(path.sep)[0];
  if (!ruta.startsWith(ROOT + path.sep) || PRIVADOS.has(primerSegmento) || primerSegmento.startsWith(".")) {
    return enviarJson(res, 404, { error: "No encontrado" });
  }
  return enviarArchivo(res, ruta, MIME[path.extname(ruta).toLowerCase()]);
}

const server = http.createServer(async (req, res) => {
  aplicarHeadersCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) await manejarApi(req, res, url);
    else await servirEstatico(req, res, url);
  } catch (err) {
    if (!(err instanceof ErrorHttp)) console.error(err);
    if (!res.headersSent) {
      enviarJson(res, err.status || 500, { error: err instanceof ErrorHttp ? err.message : "Error del servidor" });
    }
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n  ✘ El puerto ${PORT} ya está ocupado por otro programa, así que el servidor NO arrancó.`);
    console.error(`    Causas típicas:`);
    console.error(`      - Otra ventana de iniciar-servidor.bat sigue abierta: ciérrala.`);
    console.error(`      - Otro proceso está usando el puerto ${PORT}.`);
    console.error(`    Luego vuelve a abrir iniciar-servidor.bat.\n`);
    process.exit(1);
  }
  throw err;
});

function abrirNavegadorInicial(ipsLocales) {
  if (process.env.OPEN_BROWSER !== "1" || process.platform !== "win32") return;
  const { exec } = require("child_process");
  const urlExterna = `http://${EXTERNAL_IP}:${PORT}/`;
  const urlLocal = `http://${ipsLocales[0] || "localhost"}:${PORT}/`;
  let abierto = false;
  const abrir = (destino) => {
    if (abierto) return;
    abierto = true;
    exec(`cmd /c start "" "${destino}"`);
  };

  try {
    const req = http.get(`http://${EXTERNAL_IP}:${PORT}/api/health`, { timeout: 1500 }, (res) => {
      res.resume();
      abrir(res.statusCode === 200 ? urlExterna : urlLocal);
    });
    req.on("timeout", () => {
      req.destroy();
      abrir(urlLocal);
    });
    req.on("error", () => abrir(urlLocal));
  } catch (e) {
    abrir(urlLocal);
  }
}

async function precalentarOllamaAlIniciar() {
  if (!db.iaConfig || !db.iaConfig.habilitado) {
    console.log("  [IA Ollama] Deshabilitado en configuración (usando búsqueda local).");
    return;
  }
  const estado = await consultarEstadoOllama();
  if (!estado.conectado) {
    console.log(`  [IA Ollama] No detectado en ${db.iaConfig.url} (usando búsqueda local hasta que se inicie Ollama).`);
    return;
  }
  if (!estado.modelos.length) {
    console.log(
      `  [IA Ollama] Conectado en ${db.iaConfig.url}, pero sin modelos descargados. Ejecuta en CMD: ollama pull llama3.2:3b`
    );
    return;
  }

  const modelo = elegirModeloOllama(db.iaConfig.modelo, estado.modelos);
  console.log(
    `  [IA Ollama] Conectado (modelos: ${estado.modelos.join(", ")}) -> Precargando "${modelo}" en memoria RAM...`
  );
  if (esModeloPesadoCpu(modelo)) {
    console.log(
      `  [IA Ollama] Aviso: "${modelo}" es pesado en servidores sin GPU. Para respuestas 3x más rápidas instala: ollama pull llama3.2:3b`
    );
  }

  const inicio = Date.now();
  try {
    await streamChatOllama(
      db.iaConfig.url,
      {
        model: modelo,
        options: { num_ctx: 512, num_predict: 1 },
        messages: [{ role: "user", content: "ok" }]
      },
      { timeoutInicialMs: 180000, timeoutTokenMs: 30000 }
    );
    console.log(
      `  [IA Ollama] Modelo "${modelo}" cargado en RAM en ${((Date.now() - inicio) / 1000).toFixed(1)}s · Listo con ${db.chatKb.length} respuestas y ${docs.length} documentos.`
    );
  } catch (err) {
    console.warn(`  [IA Ollama] Aviso al precargar "${modelo}": ${diagnosticarErrorOllama(err, modelo)}`);
  }
}

server.listen(PORT, HOST, () => {
  const ipsLocales = obtenerIpsLocales();
  console.log(`\n  Sistema de Capacitación MUSSI iniciado:`);
  console.log(`    URL Local:            http://localhost:${PORT}/`);
  ipsLocales.forEach((ip) => console.log(`    URL Red Local (LAN):  http://${ip}:${PORT}/`));
  console.log(`    URL Red Externa:      http://${EXTERNAL_IP}:${PORT}/`);
  console.log(`\n  Accesible desde red local e internet (puerto ${PORT})`);
  console.log(`  Datos guardados en: ${DATA_DIR}  (haz respaldo de esta carpeta)\n`);
  abrirNavegadorInicial(ipsLocales);
  precalentarOllamaAlIniciar();
});
