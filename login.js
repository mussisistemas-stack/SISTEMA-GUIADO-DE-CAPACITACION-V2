document.addEventListener("DOMContentLoaded", () => {
  seedDefaultUsers();

  // Si ya hay una sesión activa, entra directo al sistema
  if (getSesion()) {
    window.location.href = "index.html";
    return;
  }

  const form = document.getElementById("loginForm");
  const userInput = document.getElementById("loginUser");
  const passInput = document.getElementById("loginPass");
  const errorEl = document.getElementById("loginError");
  const toggleBtn = document.getElementById("togglePass");

  toggleBtn.addEventListener("click", () => {
    const mostrando = passInput.type === "text";
    passInput.type = mostrando ? "password" : "text";
    toggleBtn.classList.toggle("is-active", !mostrando);
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    errorEl.textContent = "";

    const sesion = login(userInput.value, passInput.value);
    if (!sesion) {
      errorEl.textContent = "Usuario o contraseña incorrectos.";
      passInput.value = "";
      passInput.focus();
      return;
    }

    window.location.href = "index.html";
  });
});
