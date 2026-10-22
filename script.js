/* ==========================================================================
   script.js
   Núcleo de la app: sesión, navbar/sidebar por rol, render de módulos,
   progreso y chat del asistente virtual (con base de conocimiento editable
   desde el panel de Administración).
   ========================================================================== */

const MODULES_KEY = "mussi_modules";
const CHAT_KB_KEY = "mussi_chat_kb";
const PROGRESS_KEY = "mussi_progress";

let sesionActual = null;

document.addEventListener("DOMContentLoaded", () => {
  sesionActual = requerirSesion();
  if (!sesionActual) return; // ya redirigido a login.html

  seedModulosSiNecesario();
  seedChatKbSiNecesario();

  inicializarNavbarYSidebar();
  inicializarSidebarMovil();
  inicializarLogout();
  renderModulos();
  renderProgreso();
  actualizarStatsBienvenida();
  inicializarChat();
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
   NAVBAR + SIDEBAR SEGÚN ROL
   ========================================================== */

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

  const adminSection = document.getElementById("administracion");
  adminSection.style.display = esAdmin(sesionActual) ? "" : "none";

  // Etiqueta de "Mi Progreso" cambia si el usuario ve progreso de equipo
  const progresoNavLabel = document.getElementById("progresoNavLabel");
  if (sesionActual.rol !== "aprendiz" && tienePermiso(sesionActual, "progreso")) {
    progresoNavLabel.textContent = "Progreso de Aprendices";
  } else {
    progresoNavLabel.textContent = "Mi Progreso";
  }

  // Marca el link activo al hacer clic
  document.querySelectorAll(".sidebar__link").forEach((link) => {
    link.addEventListener("click", () => {
      document.querySelectorAll(".sidebar__link").forEach((l) => l.classList.remove("is-active"));
      link.classList.add("is-active");
    });
  });
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
   MÓDULOS (datos en localStorage)
   ========================================================== */

function seedModulosSiNecesario() {
  if (!localStorage.getItem(MODULES_KEY)) {
    localStorage.setItem(MODULES_KEY, JSON.stringify(DEFAULT_MODULES));
  }
}

function cargarModulos() {
  seedModulosSiNecesario();
  return JSON.parse(localStorage.getItem(MODULES_KEY) || "[]");
}

function guardarModulos(modulos) {
  localStorage.setItem(MODULES_KEY, JSON.stringify(modulos));
}

function eliminarModulo(id) {
  guardarModulos(cargarModulos().filter((m) => m.id !== id));
}

/* ==========================================================
   PROGRESO (por usuario, en localStorage)
   ========================================================== */

function cargarProgresoGlobal() {
  return JSON.parse(localStorage.getItem(PROGRESS_KEY) || "{}");
}

function progresoDeUsuario(usuario) {
  return cargarProgresoGlobal()[usuario] || {};
}

function marcarModulo(moduloId, completado) {
  const todos = cargarProgresoGlobal();
  if (!todos[sesionActual.usuario]) todos[sesionActual.usuario] = {};
  todos[sesionActual.usuario][moduloId] = completado;
  localStorage.setItem(PROGRESS_KEY, JSON.stringify(todos));
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
  const el = document.getElementById("modulo-" + moduloId);
  if (!el) return;

  document.querySelectorAll(".sidebar__link").forEach((l) => l.classList.remove("is-active"));
  document.querySelector('.sidebar__link[data-section="modulos"]').classList.add("is-active");

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

function seedChatKbSiNecesario() {
  if (!localStorage.getItem(CHAT_KB_KEY)) {
    localStorage.setItem(CHAT_KB_KEY, JSON.stringify(DEFAULT_CHAT_KB));
  }
}

function cargarChatKb() {
  seedChatKbSiNecesario();
  return JSON.parse(localStorage.getItem(CHAT_KB_KEY) || "[]");
}

function guardarChatKb(kb) {
  localStorage.setItem(CHAT_KB_KEY, JSON.stringify(kb));
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

  for (const item of kb) {
    const coincide = item.keywords.some((kw) => preguntaNormalizada.includes(normalizar(kw)));
    if (coincide) {
      return {
        respuesta: item.respuesta,
        imagen: item.imagen || "",
        moduloId: item.moduloId || ""
      };
    }
  }

  return { respuesta: RESPUESTA_DEFAULT_BOT, imagen: "", moduloId: "" };
}

function inicializarChat() {
  const chatFab = document.getElementById("chatFab");
  const chatWindow = document.getElementById("chatWindow");
  const chatCloseBtn = document.getElementById("chatCloseBtn");
  const chatForm = document.getElementById("chatForm");
  const chatInput = document.getElementById("chatInput");
  const chatMessages = document.getElementById("chatMessages");
  const quickBtns = document.querySelectorAll(".quick-btn");

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

  function addMessage(texto, sender, extra) {
    extra = extra || {};
    const msg = document.createElement("div");
    msg.classList.add("chat-msg", sender === "user" ? "chat-msg--user" : "chat-msg--bot");

    const p = document.createElement("p");
    p.textContent = texto;
    msg.appendChild(p);

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

    chatMessages.appendChild(msg);
    scrollChatToBottom();
  }

  function enviarPregunta(texto) {
    const textoLimpio = texto.trim();
    if (!textoLimpio) return;

    addMessage(textoLimpio, "user");
    chatInput.value = "";

    setTimeout(() => {
      const { respuesta, imagen, moduloId } = generarRespuesta(textoLimpio);
      addMessage(respuesta, "bot", { imagen, moduloId });
    }, 500);
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
