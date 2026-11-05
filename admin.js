/* ==========================================================================
   admin.js
   Panel de Administración: gestión de usuarios, gestión de contenido
   (pegar el embed de Canva desde la app) y entrenamiento del asistente IA.
   Todo se guarda en el servidor (server.js) vía las funciones de auth.js /
   script.js / kb-docs.js.
   ========================================================================== */

// script.js dispara "app:lista" cuando la sesión y los datos del servidor están cargados
document.addEventListener("app:lista", () => {
  const sesion = getSesion();
  if (!sesion || !esAdmin(sesion)) return; // el panel completo es exclusivo del Administrador

  inicializarTabsAdmin();
  inicializarFormUsuario();
  inicializarFormContenido();
  inicializarFormIA();
  inicializarDocumentosIA();

  renderTablaUsuarios();
  renderTablaModulosAdmin();
  renderTablaIA();
  renderTablaKb();

  migrarDatosLocales();
});

/* ==========================================================
   MIGRACIÓN: datos que quedaron en el navegador (versión anterior)
   ========================================================== */

const CLAVES_LOCALES = {
  usuarios: "mussi_users",
  modulos: "mussi_modules",
  chatKb: "mussi_chat_kb",
  progreso: "mussi_progress"
};

function leerLocal(clave) {
  try {
    const raw = localStorage.getItem(clave);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

async function migrarDatosLocales() {
  const avisos = [];

  // 1) Usuarios, módulos, respuestas manuales y progreso
  try {
    const datos = {};
    Object.entries(CLAVES_LOCALES).forEach(([k, clave]) => {
      const v = leerLocal(clave);
      if (v) datos[k] = v;
    });

    if (Object.keys(datos).length) {
      const r = await api("/api/migrar", { method: "POST", body: datos });
      Object.values(CLAVES_LOCALES).forEach((clave) => {
        try {
          localStorage.removeItem(clave);
        } catch (e) {}
      });

      const partes = [];
      if (r.usuarios) partes.push(`${r.usuarios} usuario(s)`);
      if (r.modulos) partes.push(`${r.modulos} módulo(s)`);
      if (r.respuestas) partes.push(`${r.respuestas} respuesta(s) del asistente`);
      if (r.progreso) partes.push(`${r.progreso} registro(s) de progreso`);
      if (partes.length) {
        avisos.push(partes.join(", "));
        await Promise.all([cargarUsuariosServidor(), cargarModulosServidor(), cargarChatKbServidor(), cargarProgresoServidor()]);
        refrescarTodo();
      }
    }
  } catch (e) {
    console.warn("No se pudieron migrar los datos locales:", e);
  }

  // 2) Documentos guardados en IndexedDB
  try {
    const n = typeof KBDocs !== "undefined" ? await KBDocs.migrarLocales() : 0;
    if (n) {
      avisos.push(`${n} documento(s)`);
      renderTablaKb();
    }
  } catch (e) {}

  if (avisos.length) {
    alert("Se pasaron al servidor compartido datos que estaban guardados solo en este equipo: " + avisos.join(" y ") + ".");
  }
}

function refrescarTodo() {
  renderModulos();
  renderProgreso();
  actualizarStatsBienvenida();
  renderTablaUsuarios();
  renderTablaModulosAdmin();
  renderTablaIA();
  poblarSelectModulosIA();
}

/* ==========================================================
   TABS DEL PANEL
   ========================================================== */

function inicializarTabsAdmin() {
  const tabs = document.querySelectorAll(".admin-tab");
  const paneles = document.querySelectorAll(".admin-panel");

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("is-active"));
      tab.classList.add("is-active");

      paneles.forEach((panel) => {
        panel.style.display = panel.dataset.panel === tab.dataset.tab ? "" : "none";
      });
    });
  });
}

/* Deshabilita un botón mientras corre una acción asíncrona */
async function conBoton(boton, accion) {
  if (boton) boton.disabled = true;
  try {
    return await accion();
  } finally {
    if (boton) boton.disabled = false;
  }
}

/* ==========================================================
   GESTIÓN DE USUARIOS
   ========================================================== */

function inicializarFormUsuario() {
  const form = document.getElementById("formUsuario");
  const rolSelect = document.getElementById("nuevoRol");
  const permContenido = document.getElementById("permContenido");
  const permIA = document.getElementById("permIA");
  const permProgreso = document.getElementById("permProgreso");
  const permisosWrap = document.getElementById("permisosWrap");
  const errorEl = document.getElementById("usuarioError");

  function actualizarPermisosSegunRol() {
    const esRolAdmin = rolSelect.value === "admin";
    [permContenido, permIA, permProgreso].forEach((chk) => {
      chk.disabled = esRolAdmin;
      if (esRolAdmin) chk.checked = true;
    });
    permisosWrap.classList.toggle("is-disabled", esRolAdmin);
  }

  rolSelect.addEventListener("change", actualizarPermisosSegunRol);
  actualizarPermisosSegunRol();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.textContent = "";

    const nombre = document.getElementById("nuevoNombre").value.trim();
    const usuario = document.getElementById("nuevoUsuario").value.trim();
    const password = document.getElementById("nuevoPassword").value;
    const rol = rolSelect.value;

    if (!nombre || !usuario || !password) {
      errorEl.textContent = "Completa nombre, usuario y contraseña.";
      return;
    }

    try {
      await conBoton(form.querySelector("button[type=submit]"), () =>
        crearUsuario({
          nombre,
          usuario,
          password,
          rol,
          permisos: {
            contenido: permContenido.checked,
            ia: permIA.checked,
            progreso: permProgreso.checked
          }
        })
      );
    } catch (err) {
      errorEl.textContent = err.message;
      return;
    }

    form.reset();
    actualizarPermisosSegunRol();
    renderTablaUsuarios();
    renderProgreso();
  });
}

function renderTablaUsuarios() {
  const tbody = document.getElementById("tablaUsuariosBody");
  const usuarios = getUsuarios();

  tbody.innerHTML = usuarios
    .map((u) => {
      const permisos = u.rol === "admin" ? ["Todos"] : Object.entries(u.permisos || {})
        .filter(([, activo]) => activo)
        .map(([clave]) => ({ contenido: "Contenido", ia: "IA", progreso: "Progreso" }[clave]));

      const permisosTexto = permisos.length ? permisos.join(", ") : "—";

      return `
        <tr>
          <td>${escapeHtml(u.nombre)}</td>
          <td>${escapeHtml(u.usuario)}</td>
          <td>${NOMBRES_ROL[u.rol] || escapeHtml(u.rol)}</td>
          <td>${escapeHtml(permisosTexto)}</td>
          <td><button class="table-delete-btn" data-user-id="${escapeHtml(u.id)}" title="Eliminar usuario">✕</button></td>
        </tr>
      `;
    })
    .join("");

  tbody.querySelectorAll("[data-user-id]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("¿Eliminar este usuario?")) return;
      try {
        await conBoton(btn, () => eliminarUsuario(btn.dataset.userId));
        renderTablaUsuarios();
        renderProgreso();
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

/* ==========================================================
   GESTIÓN DE CONTENIDO (pegar embed de Canva)
   ========================================================== */

function extraerDatosEmbed(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  const iframe = doc.querySelector("iframe");
  const src = iframe ? iframe.getAttribute("src") : null;

  const link = doc.querySelector("a");
  const tituloLink = link ? link.textContent.trim() : "";
  const fuente = link ? link.getAttribute("href") : "";

  return { src, tituloLink, fuente };
}

function inicializarFormContenido() {
  const form = document.getElementById("formContenido");
  const errorEl = document.getElementById("contenidoError");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.textContent = "";

    const html = document.getElementById("contenidoEmbed").value.trim();
    const { src, tituloLink, fuente } = extraerDatosEmbed(html);

    if (!src || !esUrlCanvaValida(src)) {
      errorEl.textContent = "No se encontró un iframe válido de Canva (canva.com) en el código pegado.";
      return;
    }

    const tituloInput = document.getElementById("contenidoTitulo").value.trim();
    const descripcionInput = document.getElementById("contenidoDescripcion").value.trim();

    try {
      await conBoton(form.querySelector("button[type=submit]"), () =>
        crearModulo({
          titulo: tituloInput || tituloLink || "Nuevo módulo",
          descripcion: descripcionInput,
          categoria: document.getElementById("contenidoCategoria").value,
          embedSrc: src,
          fuente: fuente && /^https:\/\//i.test(fuente) ? fuente : ""
        })
      );
    } catch (err) {
      errorEl.textContent = err.message;
      return;
    }

    form.reset();
    renderModulos();
    renderTablaModulosAdmin();
    renderProgreso();
    actualizarStatsBienvenida();
    poblarSelectModulosIA();
    alert("Módulo agregado correctamente. Ya está disponible en 'Inicio / Módulos' para todos los usuarios.");
  });
}

function renderTablaModulosAdmin() {
  const tbody = document.getElementById("tablaModulosBody");
  const modulos = cargarModulos();

  tbody.innerHTML = modulos
    .map(
      (m, idx) => `
        <tr>
          <td>Módulo ${idx + 1} · ${escapeHtml(m.titulo)}</td>
          <td><button class="table-delete-btn" data-modulo-admin-id="${escapeHtml(m.id)}" title="Eliminar módulo">✕</button></td>
        </tr>
      `
    )
    .join("");

  tbody.querySelectorAll("[data-modulo-admin-id]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("¿Eliminar este módulo? Se quitará de la vista de todos los usuarios.")) return;
      try {
        await conBoton(btn, () => eliminarModulo(btn.dataset.moduloAdminId));
      } catch (err) {
        alert(err.message);
        return;
      }
      refrescarTodo();
    });
  });
}

/* ==========================================================
   ENTRENAR ASISTENTE IA (respuestas manuales)
   ========================================================== */

const IA_IMAGEN_MAX_BYTES = 1.5 * 1024 * 1024;

function poblarSelectModulosIA() {
  const modulos = cargarModulos();
  ["iaModulo", "kbModulo"].forEach((id) => {
    const select = document.getElementById(id);
    if (!select) return;
    const valorActual = select.value;

    select.innerHTML =
      `<option value="">Ninguno</option>` +
      modulos
        .map((m, idx) => `<option value="${escapeHtml(m.id)}">Módulo ${idx + 1} · ${escapeHtml(m.titulo)}</option>`)
        .join("");

    if (modulos.some((m) => m.id === valorActual)) select.value = valorActual;
  });
}

function leerComoDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("No se pudo leer la imagen. Intenta con otro archivo."));
    reader.readAsDataURL(file);
  });
}

function inicializarFormIA() {
  const form = document.getElementById("formIA");
  const errorEl = document.getElementById("iaError");
  const imagenInput = document.getElementById("iaImagen");
  const imagenPreview = document.getElementById("iaImagenPreview");

  poblarSelectModulosIA();

  imagenInput.addEventListener("change", async () => {
    const file = imagenInput.files[0];
    if (!file) {
      imagenPreview.style.display = "none";
      return;
    }
    imagenPreview.src = await leerComoDataUrl(file);
    imagenPreview.style.display = "block";
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.textContent = "";

    const keywordsRaw = document.getElementById("iaKeywords").value.trim();
    const respuesta = document.getElementById("iaRespuesta").value.trim();
    const moduloId = document.getElementById("iaModulo").value;
    const file = imagenInput.files[0];

    const keywords = keywordsRaw
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);

    if (!keywords.length || !respuesta) {
      errorEl.textContent = "Agrega al menos una palabra clave y la respuesta.";
      return;
    }

    if (file && file.size > IA_IMAGEN_MAX_BYTES) {
      errorEl.textContent = "La imagen es muy grande (máx. 1.5 MB). Usa una imagen más liviana.";
      return;
    }

    try {
      await conBoton(form.querySelector("button[type=submit]"), async () =>
        crearEntradaChatKb({
          keywords,
          respuesta,
          imagen: file ? await leerComoDataUrl(file) : "",
          moduloId: moduloId || ""
        })
      );
    } catch (err) {
      errorEl.textContent = err.message;
      return;
    }

    form.reset();
    imagenPreview.style.display = "none";
    renderTablaIA();
    alert("Respuesta agregada. El asistente virtual ya puede usarla en el chat.");
  });
}

function renderTablaIA() {
  const tbody = document.getElementById("tablaIABody");
  const kb = cargarChatKb();
  const modulos = cargarModulos();

  tbody.innerHTML = kb
    .map((item) => {
      const imagenCelda = item.imagen
        ? `<img src="${escapeHtml(item.imagen)}" class="admin-img-thumb" alt="Imagen de la respuesta">`
        : "—";

      const moduloVinculado = item.moduloId ? modulos.find((m) => m.id === item.moduloId) : null;
      const moduloCelda = moduloVinculado ? escapeHtml(moduloVinculado.titulo) : "—";

      return `
        <tr>
          <td>${escapeHtml(item.keywords.join(", "))}</td>
          <td>${escapeHtml(item.respuesta)}</td>
          <td>${imagenCelda}</td>
          <td>${moduloCelda}</td>
          <td><button class="table-delete-btn" data-ia-id="${escapeHtml(item.id)}" title="Eliminar respuesta">✕</button></td>
        </tr>
      `;
    })
    .join("");

  tbody.querySelectorAll("[data-ia-id]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("¿Eliminar esta respuesta del asistente?")) return;
      try {
        await conBoton(btn, () => eliminarEntradaChatKb(btn.dataset.iaId));
      } catch (err) {
        alert(err.message);
        return;
      }
      renderTablaIA();
    });
  });
}

/* ==========================================================
   DOCUMENTOS DE ENTRENAMIENTO (PDF, Word, imágenes, TXT)
   ========================================================== */

const KB_ARCHIVO_MAX_BYTES = 30 * 1024 * 1024;
const KB_NOMBRES_TIPO = { pdf: "PDF", docx: "Word", imagen: "Imagen", txt: "Texto" };

function inicializarDocumentosIA() {
  const dropzone = document.getElementById("kbDropzone");
  const input = document.getElementById("kbArchivos");
  if (!dropzone || !input) return;

  input.addEventListener("change", () => {
    procesarArchivosKb(Array.from(input.files));
    input.value = "";
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
  dropzone.addEventListener("drop", (e) => procesarArchivosKb(Array.from(e.dataTransfer.files)));
}

let kbProcesando = false;

async function procesarArchivosKb(archivos) {
  if (!archivos.length) return;
  if (kbProcesando) {
    alert("Espera a que termine de procesarse el archivo actual.");
    return;
  }

  const errorEl = document.getElementById("kbError");
  const progresoWrap = document.getElementById("kbProgreso");
  const progresoTexto = document.getElementById("kbProgresoTexto");
  const progresoBarra = document.getElementById("kbProgresoBarra");
  const dropzone = document.getElementById("kbDropzone");
  const descripcion = document.getElementById("kbDescripcion").value.trim();
  const moduloId = document.getElementById("kbModulo").value;

  kbProcesando = true;
  dropzone.classList.add("is-busy");
  errorEl.textContent = "";
  progresoWrap.style.display = "";

  const errores = [];
  let exitosos = 0;

  for (let i = 0; i < archivos.length; i++) {
    const file = archivos[i];
    const prefijo = archivos.length > 1 ? `(${i + 1}/${archivos.length}) ` : "";

    if (file.size > KB_ARCHIVO_MAX_BYTES) {
      errores.push(`${file.name}: supera 30 MB.`);
      continue;
    }

    try {
      await kbProcesarArchivo(file, { descripcion, moduloId }, (mensaje, fraccion) => {
        progresoTexto.textContent = `${prefijo}${file.name} — ${mensaje}`;
        progresoBarra.style.width = Math.round((fraccion || 0) * 100) + "%";
      });
      exitosos++;
      renderTablaKb();
    } catch (err) {
      console.error(err);
      errores.push(`${file.name}: ${err.message || "error al procesar."}`);
    }
  }

  kbProcesando = false;
  dropzone.classList.remove("is-busy");
  progresoWrap.style.display = "none";
  progresoBarra.style.width = "0%";
  errorEl.textContent = errores.join(" · ");

  if (exitosos) {
    document.getElementById("kbDescripcion").value = "";
    document.getElementById("kbModulo").value = "";
    alert(
      exitosos === 1
        ? "Documento agregado. El asistente ya puede responder con su contenido."
        : `${exitosos} documentos agregados. El asistente ya puede responder con su contenido.`
    );
  }
}

async function renderTablaKb() {
  const tbody = document.getElementById("tablaKbBody");
  if (!tbody) return;

  let docs = [];
  try {
    docs = await KBDocs.listar();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6" class="admin-table__empty">${escapeHtml(e.message)}</td></tr>`;
    return;
  }

  if (!docs.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="admin-table__empty">Aún no hay documentos. Sube el primero arriba.</td></tr>`;
    return;
  }

  docs.sort((a, b) => (a.fecha < b.fecha ? 1 : -1));
  tbody.innerHTML = docs
    .map((d) => {
      const fecha = new Date(d.fecha).toLocaleDateString("es", { day: "2-digit", month: "short", year: "numeric" });
      const thumb = d.miniatura ? `<img src="${d.miniatura}" class="admin-img-thumb" alt="">` : "";
      const desc = d.descripcion ? `<span class="kb-doc__desc">${escapeHtml(d.descripcion)}</span>` : "";
      const nombre = d.archivo
        ? `<a href="${escapeHtml(d.archivo)}" target="_blank" rel="noopener" title="Abrir archivo original">${escapeHtml(d.nombre)} ↗</a>`
        : escapeHtml(d.nombre);
      return `
        <tr>
          <td><div class="kb-doc">${thumb}<div><strong>${nombre}</strong>${desc}</div></div></td>
          <td>${KB_NOMBRES_TIPO[d.tipo] || escapeHtml(d.tipo)}</td>
          <td>${d.chunks.length}</td>
          <td>${escapeHtml(d.subidoPor || "—")}</td>
          <td>${fecha}</td>
          <td><button class="table-delete-btn" data-kb-id="${d.id}" title="Eliminar documento">✕</button></td>
        </tr>
      `;
    })
    .join("");

  tbody.querySelectorAll("[data-kb-id]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("¿Eliminar este documento? El asistente dejará de usar su contenido.")) return;
      await KBDocs.eliminar(btn.dataset.kbId);
      renderTablaKb();
    });
  });
}
