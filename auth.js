/* ==========================================================================
   auth.js
   Comunicación con el servidor (server.js): sesión, usuarios y permisos.

   El login se valida en el servidor. La sesión viaja en una cookie segura
   (HttpOnly) que el navegador envía sola en cada petición; las contraseñas
   se guardan cifradas en el servidor, nunca en el navegador.
   ========================================================================== */

const NOMBRES_ROL = {
  admin: "Administrador",
  asesor: "Asesor",
  aprendiz: "Aprendiz"
};

/* ---------- Configuración de Red Local y Externa (estilo MUSSI) ---------- */

const MUSSI_NET_CONFIG = {
  PORT: "3006",
  EXTERNAL_IP: "186.81.6.227",
  get BASE_URL() {
    if (typeof window === "undefined") return "http://localhost:3006";
    const hostname = window.location.hostname;
    const protocol = window.location.protocol === "https:" ? "https:" : "http:";
    const port = window.location.port || (window.location.protocol === "https:" ? "" : this.PORT);
    if (!hostname || window.location.protocol === "file:") {
      return `http://localhost:${this.PORT}`;
    }
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      return `${protocol}//${hostname}${port ? ":" + port : ""}`;
    }
    if (hostname === this.EXTERNAL_IP) {
      return `${protocol}//${this.EXTERNAL_IP}${port ? ":" + port : ""}`;
    }
    return `${protocol}//${hostname}${port ? ":" + port : ""}`;
  }
};

if (typeof window !== "undefined") {
  window.API_BASE_URL = MUSSI_NET_CONFIG.BASE_URL + "/api";

  // Asegurar que todas las peticiones fetch envíen la cookie de sesión HttpOnly
  if (typeof window.fetch === "function" && !window.__mussiFetchPatched) {
    const originalFetch = window.fetch.bind(window);
    window.fetch = function (input, init = {}) {
      const opts = Object.assign({}, init);
      if (!opts.credentials) {
        opts.credentials = "include";
      }
      return originalFetch(input, opts);
    };
    window.__mussiFetchPatched = true;
  }
}

function resolverUrlServidor(url) {
  if (!url || /^https?:\/\//i.test(url)) return url;
  return MUSSI_NET_CONFIG.BASE_URL + (url.startsWith("/") ? url : "/" + url);
}

let SESION = null;
let USUARIOS_CACHE = [];

/* ---------- Helper de API ---------- */

/**
 * Llama a la API del servidor y devuelve el JSON de respuesta.
 * Si la sesión expiró, redirige al login (salvo que se indique lo contrario).
 */
async function api(url, opciones) {
  opciones = opciones || {};
  const init = {
    method: opciones.method || "GET",
    headers: {},
    cache: "no-store",
    credentials: "include"
  };
  if (opciones.body !== undefined) {
    if (opciones.body instanceof Blob) {
      init.body = opciones.body;
      init.headers["Content-Type"] = opciones.body.type || "application/octet-stream";
    } else {
      init.body = JSON.stringify(opciones.body);
      init.headers["Content-Type"] = "application/json";
    }
  }

  let res;
  try {
    res = await fetch(resolverUrlServidor(url), init);
  } catch (e) {
    throw new Error("No hay conexión con el servidor. Verifica que esté encendido (iniciar-servidor.bat).");
  }

  let data = null;
  try {
    data = await res.json();
  } catch (e) {}

  if (res.status === 401 && !opciones.sinRedireccion) {
    window.location.href = "login.html";
    throw new Error((data && data.error) || "Sesión expirada.");
  }
  if (!res.ok) {
    if ((res.status === 404 || res.status === 405) && !data) {
      throw new Error(
        "La app se abrió con un servidor antiguo. Cierra la ventana negra del servidor y vuelve a abrir iniciar-servidor.bat."
      );
    }
    throw new Error((data && data.error) || "Error del servidor (" + res.status + ").");
  }
  return data;
}

/* ---------- Sesión ---------- */

async function login(usuario, password) {
  SESION = await api("/api/login", { method: "POST", body: { usuario, password }, sinRedireccion: true });
  return SESION;
}

/** Consulta la sesión activa en el servidor. Devuelve null si no hay. */
async function cargarSesion() {
  try {
    SESION = await api("/api/sesion", { sinRedireccion: true });
  } catch (e) {
    SESION = null;
  }
  return SESION;
}

function getSesion() {
  return SESION;
}

async function logout() {
  try {
    await api("/api/logout", { method: "POST", sinRedireccion: true });
  } catch (e) {}
  window.location.href = "login.html";
}

/* ---------- Usuarios ---------- */

async function cargarUsuariosServidor() {
  USUARIOS_CACHE = (await api("/api/usuarios")) || [];
  return USUARIOS_CACHE;
}

function getUsuarios() {
  return USUARIOS_CACHE;
}

async function crearUsuario(datos) {
  const nuevo = await api("/api/usuarios", { method: "POST", body: datos });
  await cargarUsuariosServidor();
  return nuevo;
}

async function eliminarUsuario(id) {
  await api("/api/usuarios/" + encodeURIComponent(id), { method: "DELETE" });
  await cargarUsuariosServidor();
}

/* ---------- Helpers de rol / permisos ---------- */

function esAdmin(sesion) {
  return !!sesion && sesion.rol === "admin";
}

function tienePermiso(sesion, permiso) {
  return !!sesion && (sesion.rol === "admin" || (sesion.permisos && sesion.permisos[permiso]));
}
