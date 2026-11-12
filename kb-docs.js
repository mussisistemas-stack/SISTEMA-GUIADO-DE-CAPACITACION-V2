/* ==========================================================================
   kb-docs.js
   Base de conocimiento basada en DOCUMENTOS para el asistente virtual.

   - Ingesta (en el navegador, sin servidor):
       PDF   -> pdf.js (y OCR si la página está escaneada / no tiene texto)
       Word  -> mammoth.js (.docx)
       Imagen-> Tesseract.js (OCR en español)
       TXT   -> lectura directa
   - Almacenamiento: en el servidor (server.js, carpeta data/), compartido
     por todos los usuarios que entran a la app.
   - Búsqueda: BM25 sobre fragmentos de texto, con normalización para
     español (tildes, mayúsculas), stopwords, stemming ligero, sinónimos
     y tolerancia a errores de escritura.

   Las librerías se cargan solo cuando el administrador sube un archivo,
   para no hacer más lenta la carga de la página para los demás usuarios.
   ========================================================================== */

/* ==========================================================
   1. PROCESAMIENTO DE TEXTO (funciones puras)
   ========================================================== */

const KB_STOPWORDS = new Set(
  (
    "a al algo algun alguna alguno algunos ante antes aqui asi aun bien cada como con contra cual cuales cuando " +
    "cuanto de del desde donde dos el ella ellas ellos en entre era eran es esa esas ese eso esos esta estan estar " +
    "estas este esto estos fue fueron ha hay hace hacer hacerlo haga hago han hasta la las le les lo los mas me mi mis " +
    "mucho muy nada ni no nos o otra otro para pero poco por porque puede pueden puedo pues que quien se sea segun " +
    "ser si sin sobre solo son su sus tal tambien tan tanto te tengo tiene tienen todo todos tu tus un una unas uno " +
    "unos usted ustedes y ya yo debo debe necesito quiero saber favor ayuda ayudame explicame dime cual hola " +
    "realizar realiza realizo proceso procedimiento paso pasos manera forma"
  ).split(/\s+/)
);

// Sinónimos del dominio (en forma de raíz). Se pueden ampliar libremente.
const KB_SINONIMOS = {
  devol: ["reembols", "retorn"],
  reembols: ["devol"],
  cambi: ["intercambi"],
  caja: ["pos", "terminal"],
  pos: ["caja", "terminal"],
  abro: ["apertur", "abrir"],
  abrir: ["apertur"],
  abr: ["apertur"],
  termin: ["finaliz", "cierr"],
  acab: ["finaliz", "cierr"],
  cerr: ["cierr", "finaliz"],
  error: ["fall", "problem"],
  fall: ["error", "problem"],
  problem: ["error", "fall"],
  factur: ["comprobant"],
  client: ["comprador"],
  traspas: ["transferenci", "envi"],
  transferenci: ["traspas"]
};

function kbNormalizar(texto) {
  return String(texto || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ñ/g, "n");
}

// Stemmer ligero para español: quita plural y un sufijo derivativo.
function kbStem(palabra) {
  let w = palabra;
  if (w.length <= 3 || /^\d+$/.test(w)) return w;

  // Paso 1: plurales
  if (w.endsWith("ces") && w.length > 5) w = w.slice(0, -3) + "z";
  else if (w.endsWith("iones")) w = w.slice(0, -2);
  else if (w.endsWith("es") && w.length > 4 && !/[aeiou]/.test(w[w.length - 3])) w = w.slice(0, -2);
  else if (w.endsWith("s") && w.length > 4) w = w.slice(0, -1);

  // Paso 2: sufijos derivativos / verbales (el más largo primero)
  const sufijos = [
    "amiento", "imiento", "aciones", "acion", "ucion", "icion", "mente", "ancia", "encia",
    "able", "ible", "ista", "ando", "iendo", "ado", "ido", "ada", "ida", "oso", "osa", "ar", "er", "ir"
  ];
  for (const s of sufijos) {
    if (w.endsWith(s) && w.length - s.length >= 3) return w.slice(0, -s.length);
  }

  // Paso 3: vocal final
  if (/[aeo]$/.test(w) && w.length > 4) w = w.slice(0, -1);
  return w;
}

function kbTokenizar(texto) {
  return kbNormalizar(texto)
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 1 && !KB_STOPWORDS.has(t))
    .map(kbStem);
}

function kbLevenshtein(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let minFila = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < minFila) minFila = cur[j];
    }
    if (minFila > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// Divide un texto en fragmentos de ~700 caracteres respetando párrafos/oraciones.
function kbFragmentar(texto, maxLen) {
  maxLen = maxLen || 700;
  const limpio = String(texto || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!limpio) return [];

  const parrafos = limpio.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const piezas = [];
  parrafos.forEach((p) => {
    if (p.length <= maxLen) piezas.push(p);
    else {
      // Párrafo largo: cortar por oraciones
      const oraciones = p.match(/[^.!?\n]+[.!?]*\n?|\n/g) || [p];
      let actual = "";
      oraciones.forEach((o) => {
        if ((actual + o).length > maxLen && actual) {
          piezas.push(actual.trim());
          actual = "";
        }
        actual += o;
      });
      if (actual.trim()) piezas.push(actual.trim());
    }
  });

  // Unir piezas pequeñas consecutivas (ej: títulos + pasos de una lista)
  const fragmentos = [];
  let buffer = "";
  piezas.forEach((p) => {
    if ((buffer + "\n\n" + p).length > maxLen && buffer) {
      fragmentos.push(buffer);
      buffer = p;
    } else {
      buffer = buffer ? buffer + "\n\n" + p : p;
    }
  });
  if (buffer) fragmentos.push(buffer);
  return fragmentos;
}

/* ==========================================================
   2. ÍNDICE DE BÚSQUEDA (BM25)
   ========================================================== */

function kbConstruirIndice(docs) {
  const fragmentos = [];
  docs.forEach((doc) => {
    const extra = [doc.nombre, doc.descripcion].filter(Boolean).join(" ");
    (doc.chunks || []).forEach((chunk, i) => {
      // El nombre y la descripción del documento cuentan para cada fragmento
      const tokens = kbTokenizar(chunk.texto + " " + extra);
      const tf = new Map();
      tokens.forEach((t) => tf.set(t, (tf.get(t) || 0) + 1));
      fragmentos.push({ docId: doc.id, idx: i, pagina: chunk.pagina || null, texto: chunk.texto, tf, len: tokens.length });
    });
  });

  const df = new Map();
  fragmentos.forEach((f) => f.tf.forEach((_, t) => df.set(t, (df.get(t) || 0) + 1)));

  const N = fragmentos.length;
  const avgLen = N ? fragmentos.reduce((s, f) => s + f.len, 0) / N : 0;
  const idf = new Map();
  df.forEach((n, t) => idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5))));

  return { fragmentos, idf, avgLen, N, vocab: Array.from(df.keys()), docs: new Map(docs.map((d) => [d.id, d])) };
}

// Expande cada término de la pregunta: exacto, sinónimos y parecidos (errores de tipeo).
function kbExpandirTermino(term, indice) {
  const resultado = new Map(); // term -> peso
  if (indice.idf.has(term)) resultado.set(term, 1);

  (KB_SINONIMOS[term] || []).forEach((s) => {
    if (indice.idf.has(s) && !resultado.has(s)) resultado.set(s, 0.6);
  });

  if (!resultado.has(term) && term.length >= 4) {
    const maxDist = term.length >= 8 ? 2 : 1;
    const candidatos = [];
    for (const v of indice.vocab) {
      if (v.length < 3) continue;
      let peso = 0;
      if ((v.startsWith(term) || term.startsWith(v)) && Math.min(v.length, term.length) >= 4) peso = 0.7;
      else if (term.length >= 5 && kbLevenshtein(term, v, maxDist) <= maxDist) peso = 0.65;
      if (peso) candidatos.push([v, peso]);
    }
    candidatos
      .sort((a, b) => b[1] - a[1] || (indice.idf.get(b[0]) || 0) - (indice.idf.get(a[0]) || 0))
      .slice(0, 3)
      .forEach(([v, p]) => resultado.set(v, p));
  }
  return resultado;
}

function kbBuscar(pregunta, indice, limite) {
  limite = limite || 3;
  if (!indice || !indice.N) return [];

  const terminos = Array.from(new Set(kbTokenizar(pregunta)));
  if (!terminos.length) return [];

  const k1 = 1.4;
  const b = 0.75;
  const maxIdf = Math.log(1 + (indice.N + 0.5) / 0.5);
  const expansiones = terminos.map((t) => ({ term: t, variantes: kbExpandirTermino(t, indice) }));

  // Peso de cada término de la pregunta (para medir cobertura). Los términos
  // desconocidos pesan menos para no castigar palabras de relleno.
  const pesoTermino = expansiones.map((e) => {
    if (!e.variantes.size) return maxIdf * 0.5;
    return Math.max(...Array.from(e.variantes.keys()).map((v) => indice.idf.get(v) || 0));
  });
  const pesoTotal = pesoTermino.reduce((s, x) => s + x, 0) || 1;

  const resultados = indice.fragmentos.map((f) => {
    let score = 0;
    let cubierto = 0;
    expansiones.forEach((e, i) => {
      let mejor = 0;
      let pesoMejor = 0;
      e.variantes.forEach((peso, v) => {
        const tf = f.tf.get(v);
        if (!tf) return;
        const idf = indice.idf.get(v);
        const s = idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * f.len) / (indice.avgLen || 1)))) * peso;
        if (s > mejor) {
          mejor = s;
          pesoMejor = peso;
        }
      });
      if (mejor > 0) {
        score += mejor;
        // Coincidencias aproximadas (sinónimo / error de tipeo) cuentan menos
        cubierto += pesoTermino[i] * Math.max(pesoMejor, 0.75);
      }
    });
    return { fragmento: f, score, cobertura: cubierto / pesoTotal, terminos };
  });

  return resultados
    .filter((r) => r.score > 0)
    .sort((a, b2) => b2.score * (0.5 + b2.cobertura) - a.score * (0.5 + a.cobertura))
    .slice(0, limite);
}

// Extrae la parte más relevante de un fragmento para mostrarla en el chat.
function kbExtracto(texto, terminos, maxLen) {
  maxLen = maxLen || 550;
  if (texto.length <= maxLen) return texto;

  const oraciones = texto.match(/[^.!?\n]+[.!?]*\n*/g) || [texto];
  const set = new Set(terminos);
  const puntajes = oraciones.map((o) => kbTokenizar(o).filter((t) => set.has(t)).length);

  let mejorInicio = 0;
  let mejorPuntaje = -1;
  for (let i = 0; i < oraciones.length; i++) {
    let len = 0;
    let p = 0;
    for (let j = i; j < oraciones.length && len + oraciones[j].length <= maxLen; j++) {
      len += oraciones[j].length;
      p += puntajes[j];
    }
    if (p > mejorPuntaje) {
      mejorPuntaje = p;
      mejorInicio = i;
    }
  }

  let salida = "";
  for (let j = mejorInicio; j < oraciones.length && salida.length + oraciones[j].length <= maxLen; j++) {
    salida += oraciones[j];
  }
  salida = salida.trim() || texto.slice(0, maxLen);
  return (mejorInicio > 0 ? "… " : "") + salida + (salida.length < texto.length ? " …" : "");
}

/* ==========================================================
   3. ALMACENAMIENTO COMPARTIDO (servidor: server.js -> /api/docs)
   Los documentos se guardan en el servidor, así todos los usuarios que
   entran a la app ven la misma base de conocimiento.
   IndexedDB solo se usa para migrar documentos que se subieron antes
   en modo local (versión anterior) hacia el servidor.
   ========================================================== */

const KB_API = "/api/docs";

async function kbFetchJson(url, opciones) {
  const urlFinal = typeof resolverUrlServidor === "function" ? resolverUrlServidor(url) : url;
  const init = Object.assign({ credentials: "include" }, opciones || {});
  let res;
  try {
    res = await fetch(urlFinal, init);
  } catch (e) {
    throw new Error("No hay conexión con el servidor. Verifica que esté encendido (iniciar-servidor.bat).");
  }
  let data = null;
  try {
    data = await res.json();
  } catch (e) {}
  if (!res.ok) {
    if (res.status === 404 && !data) {
      throw new Error("El servidor no tiene la API de documentos. Inicia la app con iniciar-servidor.bat (npm start).");
    }
    throw new Error((data && data.error) || "Error del servidor (" + res.status + ").");
  }
  return data;
}

const KB_DB_NAME = "mussi_kb";
const KB_DB_STORE = "docs";

function kbAbrirDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(KB_DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(KB_DB_STORE)) {
        req.result.createObjectStore(KB_DB_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function kbTx(modo, fn) {
  return kbAbrirDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(KB_DB_STORE, modo);
        const store = tx.objectStore(KB_DB_STORE);
        const req = fn(store);
        tx.oncomplete = () => {
          db.close();
          resolve(req ? req.result : undefined);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      })
  );
}

const KBDocs = {
  indice: null,
  listo: false,

  async listar() {
    return (await kbFetchJson(KB_API, { cache: "no-store" })) || [];
  },

  /** Guarda el documento en el servidor y luego sube el archivo original. */
  async guardar(doc, archivo) {
    let creado = await kbFetchJson(KB_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc)
    });
    if (archivo) {
      creado = await kbFetchJson(`${KB_API}/${encodeURIComponent(creado.id)}/archivo`, {
        method: "PUT",
        headers: { "Content-Type": archivo.type || "application/octet-stream" },
        body: archivo
      });
    }
    await this.recargar();
    return creado;
  },

  async eliminar(id) {
    await kbFetchJson(`${KB_API}/${encodeURIComponent(id)}`, { method: "DELETE" });
    await this.recargar();
  },

  /**
   * Sube al servidor los documentos que quedaron guardados solo en este
   * navegador (versión anterior) y luego los borra del almacenamiento local.
   * Devuelve cuántos se migraron.
   */
  async migrarLocales() {
    if (typeof indexedDB === "undefined") return 0;
    let locales = [];
    try {
      locales = (await kbTx("readonly", (s) => s.getAll())) || [];
    } catch (e) {
      return 0;
    }
    let migrados = 0;
    for (const doc of locales) {
      try {
        await kbFetchJson(KB_API, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(doc)
        });
        await kbTx("readwrite", (s) => s.delete(doc.id));
        migrados++;
      } catch (e) {
        console.warn("No se pudo migrar " + doc.nombre, e);
      }
    }
    if (migrados) await this.recargar();
    return migrados;
  },

  async recargar() {
    try {
      const docs = await this.listar();
      this.indice = kbConstruirIndice(docs);
    } catch (e) {
      console.warn("No se pudo cargar la base de documentos:", e);
      this.indice = kbConstruirIndice([]);
    }
    this.listo = true;
    return this.indice;
  },

  /**
   * Busca una respuesta en los documentos.
   * Devuelve null si no hay una coincidencia suficientemente buena.
   */
  responder(pregunta) {
    if (!this.indice) return null;
    const resultados = kbBuscar(pregunta, this.indice, 4);
    if (!resultados.length) return null;

    const top = resultados[0];
    // Umbral de confianza: debe cubrir buena parte de lo que se preguntó
    if (top.cobertura < 0.5) return null;

    const doc = this.indice.docs.get(top.fragmento.docId);
    const otros = [];
    resultados.slice(1).forEach((r) => {
      if (r.fragmento.docId !== top.fragmento.docId && r.cobertura >= 0.5 && r.score >= top.score * 0.6) {
        const d = this.indice.docs.get(r.fragmento.docId);
        if (d && !otros.includes(d.nombre)) otros.push(d.nombre);
      }
    });

    return {
      respuesta: kbExtracto(top.fragmento.texto, top.terminos),
      fuente: doc ? doc.nombre + (top.fragmento.pagina ? " · pág. " + top.fragmento.pagina : "") : "",
      otrasFuentes: otros,
      imagen: doc && doc.miniatura ? doc.miniatura : "",
      moduloId: doc && doc.moduloId ? doc.moduloId : "",
      confianza: top.cobertura
    };
  }
};

/* ==========================================================
   4. EXTRACCIÓN DE TEXTO DE ARCHIVOS
   ========================================================== */

const KB_LIBS = {
  pdf: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  pdfWorker: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
  mammoth: "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js",
  tesseract: "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js"
};

const kbScriptsCargados = {};
function kbCargarScript(url) {
  if (!kbScriptsCargados[url]) {
    kbScriptsCargados[url] = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = url;
      s.onload = resolve;
      s.onerror = () => {
        delete kbScriptsCargados[url];
        reject(new Error("No se pudo cargar una librería (¿hay conexión a internet?)."));
      };
      document.head.appendChild(s);
    });
  }
  return kbScriptsCargados[url];
}

let kbOcrWorker = null;
async function kbOcr(imagen, onProgreso) {
  await kbCargarScript(KB_LIBS.tesseract);
  if (!kbOcrWorker) {
    kbOcrWorker = await Tesseract.createWorker("spa", 1, {
      logger: (m) => {
        if (kbOcrWorker && kbOcrWorker._onProgreso && m.status === "recognizing text") {
          kbOcrWorker._onProgreso(m.progress);
        }
      }
    });
  }
  kbOcrWorker._onProgreso = onProgreso;
  const { data } = await kbOcrWorker.recognize(imagen);
  kbOcrWorker._onProgreso = null;
  return data.text || "";
}

function kbTipoArchivo(file) {
  const nombre = file.name.toLowerCase();
  if (nombre.endsWith(".pdf") || file.type === "application/pdf") return "pdf";
  if (nombre.endsWith(".docx")) return "docx";
  if (nombre.endsWith(".doc")) return "doc";
  if (nombre.endsWith(".txt") || nombre.endsWith(".md")) return "txt";
  if (file.type.startsWith("image/")) return "imagen";
  return "desconocido";
}

// Reduce una imagen para guardarla como miniatura (se muestra en el chat).
function kbMiniatura(file, maxLado) {
  maxLado = maxLado || 900;
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const escala = Math.min(1, maxLado / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * escala);
      canvas.height = Math.round(img.height * escala);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.82));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve("");
    };
    img.src = url;
  });
}

async function kbExtraerPdf(file, onProgreso) {
  await kbCargarScript(KB_LIBS.pdf);
  pdfjsLib.GlobalWorkerOptions.workerSrc = KB_LIBS.pdfWorker;

  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const paginas = [];

  for (let n = 1; n <= pdf.numPages; n++) {
    onProgreso(`Leyendo página ${n} de ${pdf.numPages}…`, (n - 1) / pdf.numPages);
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();

    // Reconstruye líneas usando la posición vertical de cada fragmento
    let texto = "";
    let ultimaY = null;
    content.items.forEach((it) => {
      const y = it.transform ? it.transform[5] : null;
      if (ultimaY !== null && y !== null && Math.abs(y - ultimaY) > 4) texto += "\n";
      else if (texto && !texto.endsWith(" ")) texto += " ";
      texto += it.str;
      if (it.hasEOL) texto += "\n";
      ultimaY = y;
    });

    // Página escaneada (sin texto seleccionable) -> OCR
    if (texto.replace(/\s/g, "").length < 25) {
      onProgreso(`Página ${n} escaneada: aplicando OCR…`, (n - 1) / pdf.numPages);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      texto = await kbOcr(canvas, (p) =>
        onProgreso(`OCR página ${n} de ${pdf.numPages}: ${Math.round(p * 100)}%`, (n - 1 + p) / pdf.numPages)
      );
    }

    paginas.push({ pagina: n, texto });
  }
  return paginas;
}

async function kbExtraerDocx(file) {
  await kbCargarScript(KB_LIBS.mammoth);
  const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return [{ pagina: null, texto: value }];
}

/**
 * Procesa un archivo y lo guarda en la base de conocimiento.
 * @param {File} file
 * @param {{descripcion?: string, moduloId?: string}} opciones
 * @param {(mensaje: string, fraccion: number) => void} onProgreso
 */
async function kbProcesarArchivo(file, opciones, onProgreso) {
  opciones = opciones || {};
  onProgreso = onProgreso || function () {};
  const tipo = kbTipoArchivo(file);

  if (tipo === "doc") {
    throw new Error("Formato .doc antiguo no soportado. Ábrelo en Word y guárdalo como .docx.");
  }
  if (tipo === "desconocido") {
    throw new Error("Tipo de archivo no soportado. Usa PDF, Word (.docx), imagen (PNG/JPG) o .txt.");
  }

  let paginas = [];
  let miniatura = "";

  if (tipo === "pdf") paginas = await kbExtraerPdf(file, onProgreso);
  else if (tipo === "docx") {
    onProgreso("Leyendo documento Word…", 0.3);
    paginas = await kbExtraerDocx(file);
  } else if (tipo === "txt") {
    paginas = [{ pagina: null, texto: await file.text() }];
  } else if (tipo === "imagen") {
    onProgreso("Preparando reconocimiento de texto (OCR)…", 0.05);
    miniatura = await kbMiniatura(file);
    const texto = await kbOcr(file, (p) => onProgreso(`Leyendo texto de la imagen: ${Math.round(p * 100)}%`, p));
    paginas = [{ pagina: null, texto }];
  }

  const chunks = [];
  paginas.forEach((p) => kbFragmentar(p.texto).forEach((t) => chunks.push({ texto: t, pagina: p.pagina })));

  if (!chunks.length && !opciones.descripcion) {
    throw new Error(
      tipo === "imagen"
        ? "No se encontró texto en la imagen. Agrega una descripción para que el asistente pueda usarla."
        : "No se pudo extraer texto de este archivo."
    );
  }

  // Imagen sin texto pero con descripción: la descripción es su contenido
  if (!chunks.length) chunks.push({ texto: opciones.descripcion, pagina: null });

  const sesion = typeof getSesion === "function" ? getSesion() : null;
  const doc = {
    nombre: file.name,
    tipo,
    tamano: file.size,
    descripcion: opciones.descripcion || "",
    moduloId: opciones.moduloId || "",
    subidoPor: sesion ? sesion.nombre : "",
    miniatura,
    chunks
  };

  onProgreso("Subiendo al servidor…", 1);
  return KBDocs.guardar(doc, file);
}

// Permite probar el motor de búsqueda desde Node (no afecta al navegador).
if (typeof module !== "undefined" && module.exports) {
  module.exports = { kbTokenizar, kbStem, kbFragmentar, kbConstruirIndice, kbBuscar, kbExtracto, kbNormalizar };
}
