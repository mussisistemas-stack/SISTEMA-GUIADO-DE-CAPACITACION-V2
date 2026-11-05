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
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const vm = require("vm");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 5500;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const DOCS_FILE = path.join(DATA_DIR, "docs.json");
const ARCHIVOS_DIR = path.join(DATA_DIR, "archivos");
const MINIATURAS_DIR = path.join(DATA_DIR, "miniaturas");
const KB_IMAGENES_DIR = path.join(DATA_DIR, "kb-imagenes");

const MAX_JSON_BYTES = 25 * 1024 * 1024;
const MAX_ARCHIVO_BYTES = 30 * 1024 * 1024;
const MAX_IMAGEN_KB_BYTES = 2 * 1024 * 1024;
const SESION_HORAS = 12;
const COOKIE = "mussi_sid";

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

[ARCHIVOS_DIR, MINIATURAS_DIR, KB_IMAGENES_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));

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
    progreso: {}
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

let docs = leerJson(DOCS_FILE, []);

const guardarDb = () => escribirJson(DB_FILE, () => db);
const guardarDocs = () => escribirJson(DOCS_FILE, () => docs);

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

function usuarioDeReq(req) {
  const token = leerCookies(req)[COOKIE];
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

async function enviarArchivo(res, ruta, tipo, nombreDescarga, privado) {
  try {
    const stat = await fsp.stat(ruta);
    if (!stat.isFile()) throw new Error("no es archivo");
    const headers = {
      "Content-Type": tipo || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": privado ? "private, no-cache" : "no-cache"
    };
    if (nombreDescarga) headers["Content-Disposition"] = `inline; filename*=UTF-8''${encodeURIComponent(nombreDescarga)}`;
    res.writeHead(200, headers);
    fs.createReadStream(ruta).pipe(res);
  } catch (e) {
    enviarJson(res, 404, { error: "No encontrado" });
  }
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
  const ip = req.socket.remoteAddress;
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
  const token = leerCookies(req)[COOKIE];
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
   ENRUTADOR
   ========================================================== */

async function manejarApi(req, res, url) {
  const [, recurso, id, sub] = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  if (recurso === "login" && req.method === "POST") return apiLogin(req, res);
  if (recurso === "logout" && req.method === "POST") return apiLogout(req, res);

  const yo = usuarioDeReq(req);
  if (!yo) throw new ErrorHttp(401, "Tu sesión expiró. Inicia sesión de nuevo.");

  // Peticiones que modifican datos: deben venir de esta misma app
  if (req.method !== "GET") {
    const origen = req.headers.origin;
    let hostOrigen = null;
    try {
      hostOrigen = origen ? new URL(origen).host : req.headers.host;
    } catch (e) {}
    if (hostOrigen !== req.headers.host) throw new ErrorHttp(403, "Origen no permitido.");
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
    case "migrar":
      if (req.method === "POST") return apiMigrar(req, res, yo);
  }
  throw new ErrorHttp(404, "Ruta no encontrada");
}

async function servirEstatico(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";

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
  let url;
  try {
    url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) await manejarApi(req, res, url);
    else await servirEstatico(req, res, url);
  } catch (err) {
    if (!(err instanceof ErrorHttp)) console.error(err);
    if (!res.headersSent) {
      enviarJson(res, err.status || 500, { error: err instanceof ErrorHttp ? err.message : "Error del servidor" });
    }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n  Sistema de Capacitación corriendo en:`);
  console.log(`    Este equipo:     http://localhost:${PORT}`);
  Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .forEach((i) => console.log(`    Red local (LAN): http://${i.address}:${PORT}`));
  console.log(`\n  Datos guardados en: ${DATA_DIR}  (haz respaldo de esta carpeta)\n`);
});
