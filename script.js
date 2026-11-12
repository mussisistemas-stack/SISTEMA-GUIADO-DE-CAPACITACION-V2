/* ==========================================================================
   script.js
   Núcleo de la app: sesión, navbar/sidebar por rol, render de módulos,
   progreso y chat del asistente virtual (con base de conocimiento editable
   desde el panel de Administración).
   ========================================================================== */

/* Todos los datos viven en el servidor (server.js). Aquí se guarda una copia
   en memoria que se carga al entrar y se actualiza tras cada cambio. */
let sesionActual = null;
let MODULOS_CACHE = [];
let CHAT_KB_CACHE = [];
let PROGRESO_CACHE = {};
let BIBLIOTECA_CACHE = [];

document.addEventListener("DOMContentLoaded", async () => {
  sesionActual = await cargarSesion();
  if (!sesionActual) {
    window.location.href = "login.html";
    return;
  }

  try {
    await Promise.all([
      cargarModulosServidor(),
      cargarChatKbServidor(),
      cargarProgresoServidor(),
      cargarBibliotecaServidor(),
      tienePermiso(sesionActual, "progreso") ? cargarUsuariosServidor() : null
    ]);
  } catch (e) {
    alert("No se pudieron cargar los datos del servidor: " + e.message);
  }
  if (typeof KBDocs !== "undefined") KBDocs.recargar(); // índice de documentos del asistente

  inicializarNavbarYSidebar();
  inicializarSidebarMovil();
  inicializarLogout();
  renderModulos();
  inicializarBiblioteca();
  renderBiblioteca();
  renderProgreso();
  actualizarStatsBienvenida();
  inicializarChat();

  // Avisa a admin.js que la sesión y los datos ya están listos
  document.dispatchEvent(new Event("app:lista"));
});

/* ==========================================================
   HELPERS GENERALES
   ========================================================== */

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

function esUrlCanvaValida(url) {
  return typeof url === "string" && /^https:\/\/(www\.)?canva\.com\//i.test(url);
}

/* ==========================================================
   NAVBAR + SIDEBAR SEGÚN ROL (VISTAS INDEPENDIENTES)
   ========================================================== */

const SECCIONES_VALIDAS = ["modulos", "biblioteca", "soporte", "progreso", "administracion"];

function obtenerSeccionDesdeHash() {
  const limpio = String(window.location.hash || "").replace(/^#/, "").trim();
  return SECCIONES_VALIDAS.includes(limpio) ? limpio : "modulos";
}

function mostrarSeccion(seccion, opciones) {
  opciones = opciones || {};
  let destino = SECCIONES_VALIDAS.includes(seccion) ? seccion : "modulos";
  if (destino === "administracion" && !esAdmin(sesionActual)) {
    destino = "modulos";
  }

  document.querySelectorAll("[data-view]").forEach((bloque) => {
    const activo = bloque.dataset.view === destino;
    bloque.hidden = !activo;
    bloque.style.display = activo ? "" : "none";
  });

  document.querySelectorAll(".sidebar__link").forEach((link) => {
    link.classList.toggle("is-active", link.dataset.section === destino);
  });

  if (!opciones.sinHash && window.location.hash !== "#" + destino) {
    history.replaceState(null, "", "#" + destino);
  }

  if (!opciones.sinScrollTop) {
    window.scrollTo({ top: 0, behavior: "auto" });
  }
}

function inicializarNavbarYSidebar() {
  document.getElementById("navUserName").textContent = sesionActual.nombre;
  document.getElementById("navUserRole").textContent =
    (NOMBRES_ROL[sesionActual.rol] || sesionActual.rol) +
    (sesionActual.rol === "aprendiz" ? " · Onboarding" : "");
  document.getElementById("navUserAvatar").textContent = iniciales(sesionActual.nombre);

  const welcomeNombre = document.getElementById("welcomeNombre");
  if (welcomeNombre) welcomeNombre.textContent = sesionActual.nombre.split(" ")[0];

  // Enlace "Administración" solo visible para el rol admin
  const adminLink = document.getElementById("adminNavLink");
  if (esAdmin(sesionActual)) {
    adminLink.style.display = "";
  } else {
    adminLink.style.display = "none";
  }

  // Etiqueta de "Mi Progreso" cambia si el usuario ve progreso de equipo
  const progresoNavLabel = document.getElementById("progresoNavLabel");
  if (sesionActual.rol !== "aprendiz" && tienePermiso(sesionActual, "progreso")) {
    progresoNavLabel.textContent = "Progreso de Aprendices";
  } else {
    progresoNavLabel.textContent = "Mi Progreso";
  }

  // Cambia únicamente a la sección seleccionada sin mezclar con las demás
  document.querySelectorAll(".sidebar__link").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      mostrarSeccion(link.dataset.section);
    });
  });

  window.addEventListener("hashchange", () => {
    mostrarSeccion(obtenerSeccionDesdeHash(), { sinHash: true });
  });

  mostrarSeccion(obtenerSeccionDesdeHash(), { sinHash: !window.location.hash });
}

function iniciales(nombre) {
  const partes = nombre.trim().split(/\s+/);
  const letras = partes.slice(0, 2).map((p) => p[0].toUpperCase());
  return letras.join("") || "--";
}

/* ==========================================================
   SIDEBAR MÓVIL (burger + overlay)
   ========================================================== */

function inicializarSidebarMovil() {
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("overlay");
  const burgerBtn = document.getElementById("burgerBtn");

  function openSidebar() {
    sidebar.classList.add("is-open");
    overlay.classList.add("is-open");
  }

  function closeSidebar() {
    sidebar.classList.remove("is-open");
    overlay.classList.remove("is-open");
  }

  burgerBtn.addEventListener("click", openSidebar);
  overlay.addEventListener("click", closeSidebar);

  document.querySelectorAll(".sidebar__link").forEach((link) => {
    link.addEventListener("click", closeSidebar);
  });
}

/* ==========================================================
   LOGOUT
   ========================================================== */

function inicializarLogout() {
  document.getElementById("logoutBtn").addEventListener("click", () => {
    if (confirm("¿Deseas cerrar la sesión?")) {
      logout();
    }
  });
}

/* ==========================================================
   MÓDULOS (servidor: /api/modulos)
   ========================================================== */

async function cargarModulosServidor() {
  MODULOS_CACHE = (await api("/api/modulos")) || [];
  return MODULOS_CACHE;
}

function cargarModulos() {
  return MODULOS_CACHE;
}

async function crearModulo(datos) {
  const nuevo = await api("/api/modulos", { method: "POST", body: datos });
  await cargarModulosServidor();
  return nuevo;
}

async function eliminarModulo(id) {
  await api("/api/modulos/" + encodeURIComponent(id), { method: "DELETE" });
  await Promise.all([cargarModulosServidor(), cargarProgresoServidor(), cargarChatKbServidor()]);
}

/* ==========================================================
   PROGRESO (servidor: /api/progreso)
   ========================================================== */

async function cargarProgresoServidor() {
  PROGRESO_CACHE = (await api("/api/progreso")) || {};
  return PROGRESO_CACHE;
}

function cargarProgresoGlobal() {
  return PROGRESO_CACHE;
}

function progresoDeUsuario(usuario) {
  return PROGRESO_CACHE[usuario] || {};
}

async function marcarModulo(moduloId, completado) {
  try {
    PROGRESO_CACHE[sesionActual.usuario] = await api("/api/progreso/" + encodeURIComponent(moduloId), {
      method: "PUT",
      body: { completado }
    });
  } catch (e) {
    alert("No se pudo guardar tu progreso: " + e.message);
    return;
  }
  renderModulos();
  renderProgreso();
  actualizarStatsBienvenida();
}

function porcentajeCompletado(usuario, modulos) {
  const progreso = progresoDeUsuario(usuario);
  if (!modulos.length) return 0;
  const completados = modulos.filter((m) => progreso[m.id]).length;
  return Math.round((completados / modulos.length) * 100);
}

/* ==========================================================
   RENDER: GRID DE MÓDULOS
   ========================================================== */

function renderModulos() {
  const modulos = cargarModulos();
  const progreso = progresoDeUsuario(sesionActual.usuario);
  const grid = document.getElementById("modulesGrid");
  grid.innerHTML = "";

  modulos.forEach((m, idx) => {
    const completado = !!progreso[m.id];
    const pct = completado ? 100 : 0;
    const categoria = m.categoria || "nuevo";

    const article = document.createElement("article");
    article.className = "card";
    article.id = "modulo-" + m.id;

    const media = m.embedSrc
      ? `<iframe src="${escapeHtml(m.embedSrc)}" loading="lazy" allow="fullscreen" allowfullscreen style="width:100%; height:100%; border:none;"></iframe>`
      : `<div class="card__media-placeholder">
           <svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z M4 9h16 M9 4v16"/></svg>
           <span>Contenido interactivo (Canva)</span>
         </div>`;

    const fuente = m.fuente
      ? `<a class="card__source" href="${escapeHtml(m.fuente)}" target="_blank" rel="noopener">Ver en Canva ↗</a>`
      : "";

    article.innerHTML = `
      <div class="card__header">
        <span class="card__badge card__badge--${categoria}">Módulo ${idx + 1}</span>
        <span class="card__status ${pct === 0 ? "card__status--pending" : ""}">${completado ? "Completado" : "Pendiente"}</span>
      </div>
      <h4 class="card__title">${escapeHtml(m.titulo)}</h4>
      <p class="card__desc">${escapeHtml(m.descripcion)}</p>
      <div class="card__media"><!-- Pegar iframe de Canva aquí -->${media}</div>
      ${fuente}
      <div class="card__progress">
        <div class="progress-bar"><div class="progress-bar__fill" style="width:${pct}%;"></div></div>
        <span class="progress-bar__label">${pct}% completado</span>
      </div>
      <button class="card__btn ${completado ? "card__btn--outline" : ""}" data-modulo-id="${m.id}">
        ${completado ? "Marcar como pendiente" : "Marcar como completado"}
      </button>
    `;

    grid.appendChild(article);
  });

  grid.querySelectorAll("[data-modulo-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.moduloId;
      const yaCompletado = !!progresoDeUsuario(sesionActual.usuario)[id];
      marcarModulo(id, !yaCompletado);
    });
  });
}

function irAModulo(moduloId) {
  mostrarSeccion("modulos", { sinScrollTop: true });
  const el = document.getElementById("modulo-" + moduloId);
  if (!el) return;

  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("card--highlight");
  setTimeout(() => el.classList.remove("card--highlight"), 2200);
}

function actualizarStatsBienvenida() {
  const modulos = cargarModulos();
  document.getElementById("statModulos").textContent = modulos.length;
  document.getElementById("statProgreso").textContent =
    porcentajeCompletado(sesionActual.usuario, modulos) + "%";
}

/* ==========================================================
   RENDER: MI PROGRESO / PROGRESO DE APRENDICES
   ========================================================== */

function renderProgreso() {
  const modulos = cargarModulos();
  const contenedor = document.getElementById("progresoContenido");
  const titulo = document.getElementById("progresoTitulo");
  const subtitulo = document.getElementById("progresoSubtitulo");

  const verEquipo = sesionActual.rol !== "aprendiz" && tienePermiso(sesionActual, "progreso");

  if (!verEquipo) {
    titulo.textContent = "Mi Progreso";
    subtitulo.textContent = "Resumen general de tu avance en la capacitación.";

    const progreso = progresoDeUsuario(sesionActual.usuario);
    contenedor.innerHTML = `
      <div class="progress-overview">
        ${modulos
        .map((m) => {
          const pct = progreso[m.id] ? 100 : 0;
          return `
              <div class="progress-overview__row">
                <span>${escapeHtml(m.titulo)}</span>
                <div class="progress-bar"><div class="progress-bar__fill" style="width:${pct}%;"></div></div>
                <span class="progress-overview__pct">${pct}%</span>
              </div>
            `;
        })
        .join("")}
      </div>
    `;
    return;
  }

  // Vista de equipo (asesor / admin)
  titulo.textContent = "Progreso de Aprendices";
  subtitulo.textContent = "Avance de cada usuario con rol Aprendiz en los módulos activos.";

  const aprendices = getUsuarios().filter((u) => u.rol === "aprendiz");

  if (!aprendices.length) {
    contenedor.innerHTML = `<p class="admin-panel__hint">Aún no hay usuarios con rol Aprendiz registrados.</p>`;
    return;
  }

  contenedor.innerHTML = `
    <table class="admin-table">
      <thead><tr><th>Aprendiz</th><th>Usuario</th><th>Progreso</th></tr></thead>
      <tbody>
        ${aprendices
      .map((u) => {
        const pct = porcentajeCompletado(u.usuario, modulos);
        return `
              <tr>
                <td>${escapeHtml(u.nombre)}</td>
                <td>${escapeHtml(u.usuario)}</td>
                <td>
                  <div class="progress-overview__row" style="grid-template-columns: 1fr 44px;">
                    <div class="progress-bar"><div class="progress-bar__fill" style="width:${pct}%;"></div></div>
                    <span class="progress-overview__pct">${pct}%</span>
                  </div>
                </td>
              </tr>
            `;
      })
      .join("")}
      </tbody>
    </table>
  `;
}

/* ==========================================================
   CHAT FLOTANTE (con base de conocimiento editable)
   ========================================================== */

async function cargarChatKbServidor() {
  CHAT_KB_CACHE = (await api("/api/chat-kb")) || [];
  return CHAT_KB_CACHE;
}

function cargarChatKb() {
  return CHAT_KB_CACHE;
}

async function crearEntradaChatKb(datos) {
  const nueva = await api("/api/chat-kb", { method: "POST", body: datos });
  await cargarChatKbServidor();
  return nueva;
}

async function eliminarEntradaChatKb(id) {
  await api("/api/chat-kb/" + encodeURIComponent(id), { method: "DELETE" });
  await cargarChatKbServidor();
}

const RESPUESTA_DEFAULT_BOT =
  "No tengo una respuesta automática para eso todavía. Te sugiero revisar la Biblioteca de Recursos o contactar a Soporte Técnico (soporte.ti@frontretail.com).";

function normalizar(texto) {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function generarRespuesta(pregunta) {
  const preguntaNormalizada = normalizar(pregunta);
  const kb = cargarChatKb();
  const coincidencias = [];

  for (const item of kb) {
    const kwMatch = (item.keywords || []).find((kw) => {
      const k = normalizar(kw).trim();
      return k && preguntaNormalizada.includes(k);
    });
    if (kwMatch) {
      coincidencias.push({ item, etiqueta: item.keywords[0] || kwMatch });
    }
  }

  // Si la pregunta menciona varios temas a la vez (ej: "diferencia entre cambio y devolucion"),
  // combinar las respuestas coincidentes incluso en el modo local de respaldo.
  if (coincidencias.length >= 2) {
    const bloques = coincidencias.slice(0, 3).map((c) => `• ${c.etiqueta.toUpperCase()}: ${c.item.respuesta}`);
    const conImg = coincidencias.find((c) => c.item.imagen);
    const conMod = coincidencias.find((c) => c.item.moduloId);
    return {
      respuesta: "Según los procedimientos actuales registrados:\n\n" + bloques.join("\n\n"),
      imagen: conImg ? conImg.item.imagen : "",
      moduloId: conMod ? conMod.item.moduloId : "",
      fuente: "Respuestas oficiales Front Retail"
    };
  }

  if (coincidencias.length === 1) {
    const unico = coincidencias[0].item;
    return {
      respuesta: unico.respuesta,
      imagen: unico.imagen || "",
      moduloId: unico.moduloId || ""
    };
  }

  // Si no hay respuesta manual, buscar en los documentos de entrenamiento
  if (typeof KBDocs !== "undefined") {
    const desdeDocs = KBDocs.responder(pregunta);
    if (desdeDocs) return desdeDocs;
  }

  return { respuesta: RESPUESTA_DEFAULT_BOT, imagen: "", moduloId: "" };
}

function limpiarTextoPensamientoIa(textoCrudo) {
  if (!textoCrudo) return "";
  let limpio = String(textoCrudo).replace(/<think>[\s\S]*?<\/think>/gi, "");
  if (limpio.includes("<think>")) {
    limpio = limpio.split("<think>")[0];
  }
  return limpio.trimStart();
}

function inicializarChat() {
  const chatFab = document.getElementById("chatFab");
  const chatWindow = document.getElementById("chatWindow");
  const chatCloseBtn = document.getElementById("chatCloseBtn");
  const chatForm = document.getElementById("chatForm");
  const chatInput = document.getElementById("chatInput");
  const chatMessages = document.getElementById("chatMessages");
  const chatStatusText = document.getElementById("chatStatusText");
  const quickBtns = chatWindow.querySelectorAll(".quick-btn");
  const historialChat = [];
  let esperandoRespuesta = false;

  // Verificar si Ollama está activo en el servidor para mostrarlo en el encabezado
  api("/api/ia", { sinRedireccion: true })
    .then((info) => {
      if (chatStatusText && info && info.habilitado && info.conectado && info.modelos && info.modelos.length) {
        chatStatusText.textContent = `En línea · IA (${info.modeloActivo || info.modelo})`;
      }
    })
    .catch(() => {});

  function toggleChat() {
    chatWindow.classList.toggle("is-open");
    if (chatWindow.classList.contains("is-open")) {
      chatInput.focus();
      scrollChatToBottom();
    }
  }

  chatFab.addEventListener("click", toggleChat);
  chatCloseBtn.addEventListener("click", toggleChat);

  function scrollChatToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function mostrarIndicadorEscribiendo() {
    const burbuja = document.createElement("div");
    burbuja.className = "chat-msg chat-msg--bot chat-msg--typing";
    burbuja.innerHTML = `<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>`;
    chatMessages.appendChild(burbuja);
    scrollChatToBottom();
    return burbuja;
  }

  function adjuntarExtrasMensaje(msg, extra) {
    extra = extra || {};
    if (extra.fuente || extra.modo === "ollama" || extra.avisoAdmin) {
      const fuente = document.createElement("span");
      fuente.className = "chat-msg__source";
      const partes = [];
      if (extra.modo === "ollama") {
        partes.push(extra.modelo ? `✨ IA (${extra.modelo})` : "✨ IA");
      }
      if (extra.fuente) partes.push("📄 Fuente: " + extra.fuente);
      if (extra.otrasFuentes && extra.otrasFuentes.length) {
        partes.push("También en: " + extra.otrasFuentes.join(", "));
      }
      if (extra.avisoAdmin) partes.push("⚠️ " + extra.avisoAdmin);
      fuente.textContent = partes.join(" · ");
      msg.appendChild(fuente);
    }

    if (extra.imagen) {
      const img = document.createElement("img");
      img.src = extra.imagen;
      img.className = "chat-msg__img";
      img.alt = "Imagen de referencia";
      msg.appendChild(img);
    }

    if (extra.moduloId) {
      const modulos = cargarModulos();
      const modulo = modulos.find((m) => m.id === extra.moduloId);
      if (modulo) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "chat-msg__goto";
        btn.textContent = "Ir al módulo: " + modulo.titulo + " →";
        btn.addEventListener("click", () => {
          chatWindow.classList.remove("is-open");
          irAModulo(modulo.id);
        });
        msg.appendChild(btn);
      }
    }
    scrollChatToBottom();
  }

  function addMessage(texto, sender, extra) {
    const msg = document.createElement("div");
    msg.classList.add("chat-msg", sender === "user" ? "chat-msg--user" : "chat-msg--bot");

    const p = document.createElement("p");
    p.textContent = texto;
    msg.appendChild(p);

    chatMessages.appendChild(msg);
    if (sender !== "user") {
      adjuntarExtrasMensaje(msg, extra);
    }
    scrollChatToBottom();
    return { msg, p };
  }

  async function consultarOllamaEnVivo(textoLimpio, indicador) {
    const res = await fetch(resolverUrlServidor("/api/chat"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        pregunta: textoLimpio,
        historial: historialChat.slice(-4),
        stream: true
      })
    });

    if (!res.ok) return { fallback: true };

    const tipoContenido = (res.headers.get("content-type") || "").toLowerCase();
    if (!tipoContenido.includes("application/x-ndjson") || !res.body || !res.body.getReader) {
      const data = await res.json();
      return data || { fallback: true };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let pendiente = "";
    let meta = { modo: "ollama" };
    let textoBruto = "";
    let burbujaViva = null;
    let resultadoFallback = null;

    const procesarLinea = (linea) => {
      if (!linea) return;
      let evt = null;
      try {
        evt = JSON.parse(linea);
      } catch (e) {
        return;
      }
      if (evt.tipo === "meta") {
        meta = evt;
        if (chatStatusText && evt.modelo) {
          chatStatusText.textContent = `En línea · IA (${evt.modelo})`;
        }
      } else if (evt.tipo === "token" && evt.texto) {
        textoBruto += evt.texto;
        const visible = limpiarTextoPensamientoIa(textoBruto);
        if (visible) {
          if (!burbujaViva) {
            if (indicador.parentNode) indicador.remove();
            burbujaViva = addMessage(visible, "bot");
          } else {
            burbujaViva.p.textContent = visible;
            scrollChatToBottom();
          }
        }
      } else if (evt.tipo === "fin") {
        const textoFinal = (evt.respuesta || limpiarTextoPensamientoIa(textoBruto)).trim();
        if (textoFinal) {
          if (!burbujaViva) {
            if (indicador.parentNode) indicador.remove();
            burbujaViva = addMessage(textoFinal, "bot");
          } else {
            burbujaViva.p.textContent = textoFinal;
          }
          adjuntarExtrasMensaje(burbujaViva.msg, meta);
          meta.respuesta = textoFinal;
        } else {
          resultadoFallback = { fallback: true, detalle: "Respuesta vacía" };
        }
      } else if (evt.tipo === "fallback") {
        if (burbujaViva && burbujaViva.msg.parentNode) {
          burbujaViva.msg.remove();
          burbujaViva = null;
        }
        resultadoFallback = { fallback: true, motivo: evt.motivo, detalle: evt.detalle || "" };
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      pendiente += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = pendiente.indexOf("\n")) >= 0) {
        const l = pendiente.slice(0, idx).trim();
        pendiente = pendiente.slice(idx + 1);
        procesarLinea(l);
      }
    }
    if (pendiente.trim()) procesarLinea(pendiente.trim());

    if (resultadoFallback) return resultadoFallback;
    if (burbujaViva && meta.respuesta) {
      return { yaRenderizado: true, respuesta: meta.respuesta };
    }
    return { fallback: true };
  }

  async function enviarPregunta(texto) {
    const textoLimpio = texto.trim();
    if (!textoLimpio || esperandoRespuesta) return;

    esperandoRespuesta = true;
    addMessage(textoLimpio, "user");
    chatInput.value = "";
    const indicador = mostrarIndicadorEscribiendo();

    let textoParaHistorial = "";
    let detalleFalloIa = "";

    try {
      const resultadoIa = await consultarOllamaEnVivo(textoLimpio, indicador);
      if (resultadoIa && resultadoIa.yaRenderizado) {
        textoParaHistorial = resultadoIa.respuesta;
      } else if (resultadoIa && !resultadoIa.fallback && resultadoIa.respuesta) {
        if (indicador.parentNode) indicador.remove();
        addMessage(resultadoIa.respuesta, "bot", resultadoIa);
        textoParaHistorial = resultadoIa.respuesta;
      } else if (resultadoIa && resultadoIa.detalle) {
        detalleFalloIa = resultadoIa.detalle;
      }
    } catch (e) {}

    if (!textoParaHistorial) {
      if (indicador.parentNode) indicador.remove();
      const local = generarRespuesta(textoLimpio);
      if (detalleFalloIa && typeof tienePermiso === "function" && tienePermiso("ia")) {
        local.avisoAdmin = `Modo local (${detalleFalloIa})`;
      }
      addMessage(local.respuesta, "bot", local);
      textoParaHistorial = local.respuesta;
    }

    historialChat.push({ role: "user", content: textoLimpio });
    historialChat.push({ role: "assistant", content: textoParaHistorial });
    if (historialChat.length > 8) historialChat.splice(0, historialChat.length - 8);

    esperandoRespuesta = false;
  }

  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    enviarPregunta(chatInput.value);
  });

  quickBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!chatWindow.classList.contains("is-open")) toggleChat();
      enviarPregunta(btn.dataset.question);
    });
  });
}

/* ==========================================================
   BIBLIOTECA DE RECURSOS (Admin: añadir/eliminar · Asesor: solo visualizar)
   ========================================================== */

const BIB_MAX_BYTES = 100 * 1024 * 1024;
const BIB_ETIQUETAS_CAT = {
  manual: "Manual",
  guia: "Guía rápida",
  video: "Video",
  formato: "Formato / Política",
  otro: "Recurso"
};
const BIB_BADGE_CAT = {
  manual: "ops",
  guia: "pos",
  video: "serv",
  formato: "case",
  otro: "nuevo"
};

async function cargarBibliotecaServidor() {
  try {
    BIBLIOTECA_CACHE = (await api("/api/biblioteca")) || [];
  } catch (e) {
    BIBLIOTECA_CACHE = [];
  }
  return BIBLIOTECA_CACHE;
}

function cargarBiblioteca() {
  return BIBLIOTECA_CACHE;
}

async function eliminarRecursoBiblioteca(id) {
  await api("/api/biblioteca/" + encodeURIComponent(id), { method: "DELETE" });
  await cargarBibliotecaServidor();
  renderBiblioteca();
  document.dispatchEvent(new Event("biblioteca:actualizada"));
}

function formatearTamano(bytes) {
  const n = Number(bytes) || 0;
  if (!n) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

function iconoRecursoBib(item) {
  const ext = (item.ext || "").toLowerCase();
  if (item.categoria === "video" || ext === ".mp4" || ext === ".webm") {
    return `<svg class="icon" viewBox="0 0 24 24"><path d="M23 7l-7 5 7 5V7z M14 5H3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z"/></svg>`;
  }
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"].includes(ext)) {
    return `<svg class="icon" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>`;
  }
  if (item.urlExterna && !item.archivo) {
    return `<svg class="icon" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;
  }
  return `<svg class="icon" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6"/></svg>`;
}

function subirBinarioConProgreso(url, file, onProgreso) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const destino = typeof resolverUrlServidor === "function" ? resolverUrlServidor(url) : url;
    xhr.open("PUT", destino, true);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgreso) onProgreso(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch (e) {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error((data && data.error) || "Error al subir el archivo (" + xhr.status + ")."));
    };
    xhr.onerror = () => reject(new Error("Se interrumpió la conexión al subir el archivo."));
    xhr.send(file);
  });
}

function abrirPanelSubidaBiblioteca() {
  if (!esAdmin(sesionActual)) return;
  mostrarSeccion("biblioteca");
  const panel = document.getElementById("bibUploadPanel");
  const btnToggle = document.getElementById("btnToggleSubirBib");
  if (panel) {
    panel.style.display = "";
    if (btnToggle) btnToggle.style.display = "none";
    document.getElementById("bibTitulo")?.focus();
  }
}

function inicializarBiblioteca() {
  const admin = esAdmin(sesionActual);
  const btnToggle = document.getElementById("btnToggleSubirBib");
  const btnCerrar = document.getElementById("btnCerrarSubirBib");
  const panel = document.getElementById("bibUploadPanel");
  const badgeSoloLectura = document.getElementById("bibSoloLecturaBadge");
  const buscarInput = document.getElementById("bibBuscar");
  const filtroSelect = document.getElementById("bibFiltroCategoria");

  if (admin) {
    if (btnToggle) btnToggle.style.display = "";
    if (badgeSoloLectura) badgeSoloLectura.style.display = "none";
  } else {
    if (btnToggle) btnToggle.style.display = "none";
    if (panel) panel.remove(); // El Asesor/Aprendiz no tiene el formulario en el DOM
    if (badgeSoloLectura) badgeSoloLectura.style.display = "";
  }

  if (buscarInput) buscarInput.addEventListener("input", renderBiblioteca);
  if (filtroSelect) filtroSelect.addEventListener("change", renderBiblioteca);

  inicializarModalBiblioteca();

  if (!admin || !panel) return;

  const form = document.getElementById("formBiblioteca");
  const fileInput = document.getElementById("bibArchivo");
  const dropzone = document.getElementById("bibDropzone");
  const nombreLabel = document.getElementById("bibArchivoNombre");
  const catSelect = document.getElementById("bibCategoria");
  const errorEl = document.getElementById("bibError");
  const progresoWrap = document.getElementById("bibUploadProgreso");
  const progresoTexto = document.getElementById("bibUploadTexto");
  const progresoBarra = document.getElementById("bibUploadBarra");
  const btnGuardar = document.getElementById("btnGuardarBib");

  let archivoSeleccionado = null;

  function seleccionarArchivo(file) {
    archivoSeleccionado = file || null;
    errorEl.textContent = "";
    if (archivoSeleccionado) {
      nombreLabel.textContent = `Archivo seleccionado: ${archivoSeleccionado.name} (${formatearTamano(archivoSeleccionado.size)})`;
      if (/\.(mp4|webm)$/i.test(archivoSeleccionado.name)) catSelect.value = "video";
    } else {
      nombreLabel.textContent = "Arrastra un archivo aquí o haz clic para seleccionarlo";
    }
  }

  btnToggle.addEventListener("click", () => {
    panel.style.display = "";
    btnToggle.style.display = "none";
  });

  btnCerrar.addEventListener("click", () => {
    panel.style.display = "none";
    btnToggle.style.display = "";
    form.reset();
    seleccionarArchivo(null);
  });

  fileInput.addEventListener("change", () => {
    seleccionarArchivo(fileInput.files[0] || null);
  });

  ["dragenter", "dragover"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.add("is-dragover");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.remove("is-dragover");
    })
  );
  dropzone.addEventListener("drop", (e) => {
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      seleccionarArchivo(e.dataTransfer.files[0]);
    }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.textContent = "";

    const titulo = document.getElementById("bibTitulo").value.trim();
    const descripcion = document.getElementById("bibDescripcion").value.trim();
    const categoria = catSelect.value;
    const urlExterna = document.getElementById("bibUrlExterna").value.trim();

    if (!archivoSeleccionado && !urlExterna) {
      errorEl.textContent = "Selecciona un archivo para subir o pega un enlace HTTPS.";
      return;
    }
    if (urlExterna && !/^https:\/\//i.test(urlExterna)) {
      errorEl.textContent = "El enlace externo debe comenzar con https://";
      return;
    }
    if (archivoSeleccionado && archivoSeleccionado.size > BIB_MAX_BYTES) {
      errorEl.textContent = "El archivo supera el límite máximo de 100 MB.";
      return;
    }

    btnGuardar.disabled = true;
    dropzone.classList.add("is-busy");

    let creado = null;
    try {
      creado = await api("/api/biblioteca", {
        method: "POST",
        body: {
          titulo,
          descripcion,
          categoria,
          nombreArchivo: archivoSeleccionado ? archivoSeleccionado.name : "",
          tamano: archivoSeleccionado ? archivoSeleccionado.size : 0,
          urlExterna: archivoSeleccionado ? "" : urlExterna
        }
      });

      if (archivoSeleccionado) {
        progresoWrap.style.display = "";
        progresoBarra.style.width = "0%";
        progresoTexto.textContent = `Subiendo ${archivoSeleccionado.name}… 0%`;

        await subirBinarioConProgreso(
          `/api/biblioteca/${encodeURIComponent(creado.id)}/archivo`,
          archivoSeleccionado,
          (fraccion) => {
            const pct = Math.round(fraccion * 100);
            progresoBarra.style.width = pct + "%";
            progresoTexto.textContent = `Subiendo ${archivoSeleccionado.name}… ${pct}%`;
          }
        );
      }

      await cargarBibliotecaServidor();
      renderBiblioteca();
      document.dispatchEvent(new Event("biblioteca:actualizada"));

      form.reset();
      seleccionarArchivo(null);
      panel.style.display = "none";
      btnToggle.style.display = "";
      alert("Documento publicado correctamente en la Biblioteca de Recursos.");
    } catch (err) {
      if (creado && archivoSeleccionado) {
        api("/api/biblioteca/" + encodeURIComponent(creado.id), { method: "DELETE" }).catch(() => {});
      }
      errorEl.textContent = err.message || "No se pudo subir el documento.";
    } finally {
      btnGuardar.disabled = false;
      dropzone.classList.remove("is-busy");
      progresoWrap.style.display = "none";
      progresoBarra.style.width = "0%";
    }
  });
}

function renderBiblioteca() {
  const grid = document.getElementById("bibliotecaGrid");
  if (!grid) return;

  const admin = esAdmin(sesionActual);
  const textoBusqueda = normalizar((document.getElementById("bibBuscar")?.value || "").trim());
  const filtroCat = document.getElementById("bibFiltroCategoria")?.value || "todas";

  const filtrados = cargarBiblioteca().filter((item) => {
    if (filtroCat !== "todas" && item.categoria !== filtroCat) return false;
    if (!textoBusqueda) return true;
    const combinado = normalizar(`${item.titulo} ${item.descripcion || ""} ${item.nombreArchivo || ""}`);
    return combinado.includes(textoBusqueda);
  });

  if (!filtrados.length) {
    const total = cargarBiblioteca().length;
    const mensajeVacio = total
      ? "No se encontraron documentos con ese filtro."
      : admin
        ? "Aún no hay documentos en la Biblioteca. Haz clic en «+ Añadir documento» arriba para publicar el primero."
        : "Aún no hay documentos publicados en la Biblioteca de Recursos.";
    grid.innerHTML = `<div class="bib-empty">${escapeHtml(mensajeVacio)}</div>`;
    return;
  }

  grid.innerHTML = filtrados
    .map((item) => {
      const extTexto = item.ext ? item.ext.replace(".", "").toUpperCase() : item.urlExterna ? "ENLACE" : "DOC";
      const tamTexto = item.tamano ? " · " + formatearTamano(item.tamano) : "";
      const catNombre = BIB_ETIQUETAS_CAT[item.categoria] || "Recurso";
      const badgeClase = BIB_BADGE_CAT[item.categoria] || "nuevo";
      const descHtml = item.descripcion ? `<p class="resource-card__desc">${escapeHtml(item.descripcion)}</p>` : "";
      const btnEliminar = admin
        ? `<button type="button" class="table-delete-btn resource-card__delete" data-bib-del="${escapeHtml(item.id)}" title="Eliminar de la Biblioteca">✕</button>`
        : "";

      return `
        <article class="resource-card" data-bib-open="${escapeHtml(item.id)}">
          <div class="resource-card__top">
            <span class="card__badge card__badge--${badgeClase}">${escapeHtml(catNombre)}</span>
            <div class="resource-card__top-right">
              <span class="resource-card__meta">${escapeHtml(extTexto + tamTexto)}</span>
              ${btnEliminar}
            </div>
          </div>
          <div class="resource-card__main">
            <div class="resource-card__icon">${iconoRecursoBib(item)}</div>
            <div class="resource-card__info">
              <strong>${escapeHtml(item.titulo)}</strong>
              ${descHtml}
            </div>
          </div>
          <button type="button" class="card__btn card__btn--outline resource-card__btn" data-bib-ver="${escapeHtml(item.id)}">
            Visualizar documento
          </button>
        </article>
      `;
    })
    .join("");

  grid.querySelectorAll("[data-bib-ver]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const item = cargarBiblioteca().find((x) => x.id === btn.dataset.bibVer);
      if (item) abrirVisorBiblioteca(item);
    });
  });

  grid.querySelectorAll("[data-bib-open]").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-bib-del]")) return;
      const item = cargarBiblioteca().find((x) => x.id === card.dataset.bibOpen);
      if (item) abrirVisorBiblioteca(item);
    });
  });

  if (admin) {
    grid.querySelectorAll("[data-bib-del]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm("¿Eliminar este documento de la Biblioteca de Recursos?")) return;
        btn.disabled = true;
        try {
          await eliminarRecursoBiblioteca(btn.dataset.bibDel);
        } catch (err) {
          alert(err.message);
          btn.disabled = false;
        }
      });
    });
  }
}

function convertirUrlEmbed(url) {
  try {
    const u = new URL(url);
    if (/canva\.com$/i.test(u.hostname) && !u.searchParams.has("embed")) {
      u.searchParams.set("embed", "");
      return u.toString();
    }
    if (/(youtube\.com|youtu\.be)$/i.test(u.hostname)) {
      const id = u.hostname.includes("youtu.be") ? u.pathname.slice(1) : u.searchParams.get("v");
      if (id) return `https://www.youtube.com/embed/${encodeURIComponent(id)}`;
    }
  } catch (e) {}
  return url;
}

function inicializarModalBiblioteca() {
  const modal = document.getElementById("bibModal");
  const btnCerrar = document.getElementById("bibModalCerrar");
  const backdrop = document.getElementById("bibModalBackdrop");
  const body = document.getElementById("bibModalBody");
  if (!modal) return;

  function cerrar() {
    modal.hidden = true;
    modal.style.display = "none";
    body.innerHTML = "";
    document.body.style.overflow = "";
  }

  btnCerrar.addEventListener("click", cerrar);
  backdrop.addEventListener("click", cerrar);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) cerrar();
  });

  if (!esAdmin(sesionActual)) {
    body.addEventListener("contextmenu", (e) => e.preventDefault());
  }
}

async function abrirVisorBiblioteca(item) {
  const modal = document.getElementById("bibModal");
  const body = document.getElementById("bibModalBody");
  const tituloEl = document.getElementById("bibModalTitulo");
  const metaEl = document.getElementById("bibModalMeta");
  const catEl = document.getElementById("bibModalCategoria");
  const linkNueva = document.getElementById("bibModalAbrirNueva");
  if (!modal || !body) return;

  const admin = esAdmin(sesionActual);
  const ext = (item.ext || "").toLowerCase();
  const urlArchivo = item.archivo
    ? typeof resolverUrlServidor === "function"
      ? resolverUrlServidor(item.archivo)
      : item.archivo
    : item.urlExterna;

  tituloEl.textContent = item.titulo;
  const partesMeta = [];
  if (item.ext) partesMeta.push(item.ext.replace(".", "").toUpperCase());
  if (item.tamano) partesMeta.push(formatearTamano(item.tamano));
  if (item.fecha) {
    partesMeta.push(new Date(item.fecha).toLocaleDateString("es", { day: "2-digit", month: "short", year: "numeric" }));
  }
  metaEl.textContent = partesMeta.join(" · ");

  catEl.textContent = BIB_ETIQUETAS_CAT[item.categoria] || "Recurso";
  catEl.className = "card__badge card__badge--" + (BIB_BADGE_CAT[item.categoria] || "nuevo");

  if (admin && urlArchivo) {
    linkNueva.href = urlArchivo;
    linkNueva.style.display = "";
  } else {
    linkNueva.style.display = "none";
  }

  modal.hidden = false;
  modal.style.display = "flex";
  document.body.style.overflow = "hidden";
  body.innerHTML = `<div class="bib-viewer-msg">Cargando vista previa…</div>`;

  if (!item.archivo && item.urlExterna) {
    const embedUrl = convertirUrlEmbed(item.urlExterna);
    body.innerHTML = `<iframe class="bib-viewer-iframe" src="${escapeHtml(embedUrl)}" allowfullscreen loading="lazy"></iframe>`;
    return;
  }

  if (ext === ".pdf") {
    const sufijoPdf = admin ? "" : "#toolbar=0&navpanes=0&scrollbar=1";
    body.innerHTML = `<iframe class="bib-viewer-iframe" src="${escapeHtml(urlArchivo + sufijoPdf)}"></iframe>`;
    return;
  }

  if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"].includes(ext)) {
    body.innerHTML = `<div class="bib-viewer-img-wrap"><img src="${escapeHtml(urlArchivo)}" alt="${escapeHtml(item.titulo)}"></div>`;
    return;
  }

  if ([".mp4", ".webm"].includes(ext)) {
    const attrsExtra = admin ? "" : 'controlsList="nodownload" disablePictureInPicture';
    body.innerHTML = `<div class="bib-viewer-video-wrap"><video class="bib-viewer-video" src="${escapeHtml(urlArchivo)}" controls autoplay ${attrsExtra}></video></div>`;
    return;
  }

  if (ext === ".mp3") {
    const attrsExtra = admin ? "" : 'controlsList="nodownload"';
    body.innerHTML = `<div class="bib-viewer-msg"><audio src="${escapeHtml(urlArchivo)}" controls autoplay ${attrsExtra}></audio></div>`;
    return;
  }

  if ([".txt", ".md", ".csv"].includes(ext)) {
    try {
      const res = await fetch(urlArchivo, { credentials: "include" });
      const textoPlano = await res.text();
      body.innerHTML = `<pre class="bib-viewer-text">${escapeHtml(textoPlano)}</pre>`;
    } catch (e) {
      body.innerHTML = `<div class="bib-viewer-msg">No se pudo cargar el contenido del archivo.</div>`;
    }
    return;
  }

  if (ext === ".docx" && typeof kbCargarScript === "function" && typeof KB_LIBS !== "undefined") {
    try {
      await kbCargarScript(KB_LIBS.mammoth);
      const res = await fetch(urlArchivo, { credentials: "include" });
      const buffer = await res.arrayBuffer();
      const resultado = await mammoth.convertToHtml({ arrayBuffer: buffer });
      body.innerHTML = `<div class="bib-viewer-docx">${resultado.value || "<p>Documento sin contenido visible.</p>"}</div>`;
    } catch (e) {
      body.innerHTML = `<div class="bib-viewer-msg">No se pudo previsualizar este documento Word en el navegador.</div>`;
    }
    return;
  }

  body.innerHTML = `
    <div class="bib-viewer-msg">
      <p>Este formato (<strong>${escapeHtml(ext || "archivo")}</strong>) no tiene vista previa integrada directa en el navegador.</p>
      ${
        admin
          ? `<p><a class="card__btn" href="${escapeHtml(urlArchivo)}" target="_blank" rel="noopener">Abrir archivo</a></p>`
          : `<p class="admin-panel__hint">Para visualización integrada de Asesores se recomienda subir los documentos en formato <strong>PDF</strong>, <strong>Word (.docx)</strong>, <strong>Imagen</strong> o <strong>Video MP4</strong>.</p>`
      }
    </div>
  `;
}
