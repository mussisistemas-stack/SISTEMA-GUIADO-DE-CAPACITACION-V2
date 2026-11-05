document.addEventListener("DOMContentLoaded", async () => {
  const form = document.getElementById("loginForm");
  const userInput = document.getElementById("loginUser");
  const passInput = document.getElementById("loginPass");
  const errorEl = document.getElementById("loginError");
  const toggleBtn = document.getElementById("togglePass");
  const submitBtn = form.querySelector("button[type=submit]");

  toggleBtn.addEventListener("click", () => {
    const mostrando = passInput.type === "text";
    passInput.type = mostrando ? "password" : "text";
    toggleBtn.classList.toggle("is-active", !mostrando);
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.textContent = "";
    submitBtn.disabled = true;

    try {
      await login(userInput.value, passInput.value);
      window.location.href = "index.html";
    } catch (err) {
      errorEl.textContent = err.message;
      passInput.value = "";
      passInput.focus();
      submitBtn.disabled = false;
    }
  });

  // Si ya hay una sesión activa, entra directo al sistema
  if (await cargarSesion()) window.location.href = "index.html";
});
