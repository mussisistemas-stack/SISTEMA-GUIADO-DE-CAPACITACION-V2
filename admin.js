/* ==========================================================================
   admin.js
   Panel de Administración: gestión de usuarios, gestión de contenido
   (pegar el embed de Canva desde la app) y entrenamiento del asistente IA.
   Todo se guarda en localStorage vía las funciones de auth.js / script.js.
   ========================================================================== */

document.addEventListener("DOMContentLoaded", () => {
  const sesion = getSesion();
  if (!sesion || !esAdmin(sesion)) return; // el panel completo es exclusivo del Administrador

  inicializarTabsAdmin();
  inicializarFormUsuario();
  inicializarFormContenido();
  inicializarFormIA();

  renderTablaUsuarios();
  renderTablaModulosAdmin();
  renderTablaIA();
});

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

  form.addEventListener("submit", (e) => {
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
      });
    } catch (err) {
      errorEl.textContent = err.message;
      return;
    }

    form.reset();
    actualizarPermisosSegunRol();
    renderTablaUsuarios();
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
          <td>${NOMBRES_ROL[u.rol] || u.rol}</td>
          <td>${escapeHtml(permisosTexto)}</td>
          <td><button class="table-delete-btn" data-user-id="${u.id}" title="Eliminar usuario">✕</button></td>
        </tr>
      `;
    })
    .join("");

  tbody.querySelectorAll("[data-user-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!confirm("¿Eliminar este usuario?")) return;
      try {
        eliminarUsuario(btn.dataset.userId);
        renderTablaUsuarios();
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

  form.addEventListener("submit", (e) => {
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

    const nuevoModulo = {
      id: "mod-" + Date.now(),
      titulo: tituloInput || tituloLink || "Nuevo módulo",
      descripcion: descripcionInput || "Contenido agregado desde el panel de administración.",
      categoria: document.getElementById("contenidoCategoria").value,
      embedSrc: src,
      fuente: fuente && /^https:\/\//i.test(fuente) ? fuente : ""
    };

    const modulos = cargarModulos();
    modulos.push(nuevoModulo);
    guardarModulos(modulos);

    form.reset();
    renderModulos();
    renderTablaModulosAdmin();
    actualizarStatsBienvenida();
    poblarSelectModulosIA();
    alert("Módulo agregado correctamente. Ya está disponible en 'Inicio / Módulos'.");
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
          <td><button class="table-delete-btn" data-modulo-admin-id="${m.id}" title="Eliminar módulo">✕</button></td>
        </tr>
      `
    )
    .join("");

  tbody.querySelectorAll("[data-modulo-admin-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!confirm("¿Eliminar este módulo? Se quitará de la vista de todos los usuarios.")) return;
      eliminarModulo(btn.dataset.moduloAdminId);
      renderTablaModulosAdmin();
      renderModulos();
      renderProgreso();
      actualizarStatsBienvenida();
      poblarSelectModulosIA();
    });
  });
}

/* ==========================================================
   ENTRENAR ASISTENTE IA
   ========================================================== */

const IA_IMAGEN_MAX_BYTES = 1.5 * 1024 * 1024;

function poblarSelectModulosIA() {
  const select = document.getElementById("iaModulo");
  if (!select) return;
  const valorActual = select.value;
  const modulos = cargarModulos();

  select.innerHTML =
    `<option value="">Ninguno</option>` +
    modulos
      .map((m, idx) => `<option value="${m.id}">Módulo ${idx + 1} · ${escapeHtml(m.titulo)}</option>`)
      .join("");

  if (modulos.some((m) => m.id === valorActual)) select.value = valorActual;
}

function inicializarFormIA() {
  const form = document.getElementById("formIA");
  const errorEl = document.getElementById("iaError");
  const imagenInput = document.getElementById("iaImagen");
  const imagenPreview = document.getElementById("iaImagenPreview");

  poblarSelectModulosIA();

  imagenInput.addEventListener("change", () => {
    const file = imagenInput.files[0];
    if (!file) {
      imagenPreview.style.display = "none";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      imagenPreview.src = reader.result;
      imagenPreview.style.display = "block";
    };
    reader.readAsDataURL(file);
  });

  form.addEventListener("submit", (e) => {
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

    function guardarEntrada(imagenDataUrl) {
      const kb = cargarChatKb();
      kb.push({
        keywords,
        respuesta,
        imagen: imagenDataUrl || "",
        moduloId: moduloId || ""
      });
      guardarChatKb(kb);

      form.reset();
      imagenPreview.style.display = "none";
      renderTablaIA();
      alert("Respuesta agregada. El asistente virtual ya puede usarla en el chat.");
    }

    if (file) {
      const reader = new FileReader();
      reader.onload = () => guardarEntrada(reader.result);
      reader.onerror = () => {
        errorEl.textContent = "No se pudo leer la imagen. Intenta con otro archivo.";
      };
      reader.readAsDataURL(file);
    } else {
      guardarEntrada("");
    }
  });
}

function renderTablaIA() {
  const tbody = document.getElementById("tablaIABody");
  const kb = cargarChatKb();
  const modulos = cargarModulos();

  tbody.innerHTML = kb
    .map((item, idx) => {
      const imagenCelda = item.imagen
        ? `<img src="${item.imagen}" class="admin-img-thumb" alt="Imagen de la respuesta">`
        : "—";

      const moduloVinculado = item.moduloId ? modulos.find((m) => m.id === item.moduloId) : null;
      const moduloCelda = moduloVinculado ? escapeHtml(moduloVinculado.titulo) : "—";

      return `
        <tr>
          <td>${escapeHtml(item.keywords.join(", "))}</td>
          <td>${escapeHtml(item.respuesta)}</td>
          <td>${imagenCelda}</td>
          <td>${moduloCelda}</td>
          <td><button class="table-delete-btn" data-ia-idx="${idx}" title="Eliminar respuesta">✕</button></td>
        </tr>
      `;
    })
    .join("");

  tbody.querySelectorAll("[data-ia-idx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!confirm("¿Eliminar esta respuesta del asistente?")) return;
      const idx = Number(btn.dataset.iaIdx);
      const kbActual = cargarChatKb();
      kbActual.splice(idx, 1);
      guardarChatKb(kbActual);
      renderTablaIA();
    });
  });
}
