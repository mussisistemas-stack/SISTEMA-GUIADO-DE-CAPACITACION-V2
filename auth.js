/* ==========================================================================
   auth.js
   Gestión de usuarios, sesión y permisos.

   IMPORTANTE: esta app es 100% estática (sin backend/base de datos real).
   Los usuarios y contraseñas se guardan en el localStorage del navegador
   de este equipo. Sirve como control de acceso interno básico, NO como
   autenticación segura de nivel productivo (las contraseñas no están
   cifradas). No reutilizar contraseñas sensibles aquí.
   ========================================================================== */

const AUTH_USERS_KEY = "mussi_users";
const AUTH_SESSION_KEY = "mussi_session";

/* ---------- Semilla del usuario Administrador ---------- */

function seedDefaultUsers() {
  if (localStorage.getItem(AUTH_USERS_KEY)) return;

  const admin = {
    id: "u-admin",
    nombre: "Administrador",
    usuario: "admin",
    password: "Mussi26#",
    rol: "admin",
    permisos: { contenido: true, ia: true, progreso: true }
  };

  localStorage.setItem(AUTH_USERS_KEY, JSON.stringify([admin]));
}

/* ---------- CRUD de usuarios ---------- */

function getUsuarios() {
  seedDefaultUsers();
  return JSON.parse(localStorage.getItem(AUTH_USERS_KEY) || "[]");
}

function guardarUsuarios(usuarios) {
  localStorage.setItem(AUTH_USERS_KEY, JSON.stringify(usuarios));
}

function crearUsuario({ nombre, usuario, password, rol, permisos }) {
  const usuarios = getUsuarios();

  if (usuarios.some((u) => u.usuario.toLowerCase() === usuario.trim().toLowerCase())) {
    throw new Error("Ya existe un usuario con ese nombre de usuario.");
  }

  const nuevo = {
    id: "u-" + Date.now(),
    nombre: nombre.trim(),
    usuario: usuario.trim(),
    password,
    rol,
    permisos:
      rol === "admin"
        ? { contenido: true, ia: true, progreso: true }
        : {
            contenido: !!permisos.contenido,
            ia: !!permisos.ia,
            progreso: !!permisos.progreso
          }
  };

  usuarios.push(nuevo);
  guardarUsuarios(usuarios);
  return nuevo;
}

function eliminarUsuario(id) {
  const usuarios = getUsuarios();
  const objetivo = usuarios.find((u) => u.id === id);

  if (objetivo && objetivo.rol === "admin") {
    const admins = usuarios.filter((u) => u.rol === "admin");
    if (admins.length <= 1) {
      throw new Error("Debe existir al menos un administrador. No se puede eliminar el último.");
    }
  }

  guardarUsuarios(usuarios.filter((u) => u.id !== id));
}

/* ---------- Sesión ---------- */

function login(usuario, password) {
  const usuarios = getUsuarios();
  const encontrado = usuarios.find(
    (u) => u.usuario.toLowerCase() === usuario.trim().toLowerCase() && u.password === password
  );
  if (!encontrado) return null;

  const sesion = {
    id: encontrado.id,
    nombre: encontrado.nombre,
    usuario: encontrado.usuario,
    rol: encontrado.rol,
    permisos: encontrado.permisos
  };

  sessionStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(sesion));
  return sesion;
}

function getSesion() {
  const raw = sessionStorage.getItem(AUTH_SESSION_KEY);
  return raw ? JSON.parse(raw) : null;
}

function logout() {
  sessionStorage.removeItem(AUTH_SESSION_KEY);
  window.location.href = "login.html";
}

function requerirSesion() {
  const sesion = getSesion();
  if (!sesion) {
    window.location.href = "login.html";
    return null;
  }
  return sesion;
}

/* ---------- Helpers de rol / permisos ---------- */

function esAdmin(sesion) {
  return !!sesion && sesion.rol === "admin";
}

function tienePermiso(sesion, permiso) {
  return !!sesion && (sesion.rol === "admin" || (sesion.permisos && sesion.permisos[permiso]));
}

const NOMBRES_ROL = {
  admin: "Administrador",
  asesor: "Asesor",
  aprendiz: "Aprendiz"
};
