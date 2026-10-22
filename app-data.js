/* ==========================================================================
   app-data.js
   Datos semilla (por defecto) para módulos y base de conocimiento del
   asistente IA. Se cargan en localStorage la primera vez que se abre la app;
   después de eso, lo que se ve en pantalla sale de localStorage (incluido
   todo lo que agregue un Administrador desde el panel).
   ========================================================================== */

const DEFAULT_MODULES = [
  {
    id: "mod-1",
    titulo: "Inducción POS",
    descripcion: "Aprende a manejar el sistema de punto de venta: apertura de caja, ingreso de productos y cobro al cliente.",
    categoria: "pos",
    embedSrc: "",
    fuente: ""
  },
  {
    id: "mod-2",
    titulo: "Operaciones Diarias y Caja",
    descripcion: "Procedimientos de apertura y cierre de caja, arqueos, y manejo correcto de efectivo y medios de pago.",
    categoria: "ops",
    embedSrc: "",
    fuente: ""
  },
  {
    id: "mod-3",
    titulo: "Casos Especiales y Devoluciones",
    descripcion: "Gestión de cambios, devoluciones, garantías y situaciones especiales de atención al cliente.",
    categoria: "case",
    embedSrc: "",
    fuente: ""
  },
  {
    id: "mod-4",
    titulo: "Atención y Servicio al Cliente",
    descripcion: "Estándares de bienvenida, comunicación efectiva y resolución de quejas en tienda.",
    categoria: "serv",
    embedSrc: "",
    fuente: ""
  },
  {
    id: "mod-5",
    titulo: "Creación de Cliente y Factura Electrónica",
    descripcion: "Consulta de factura, creación de cliente, generación de anticipo/vale y facturación de cambios y garantías.",
    categoria: "fact",
    embedSrc: "https://www.canva.com/design/DAG0ljsHzkM/0q58M_G_H9pvkIUKv2efJw/watch?embed",
    fuente: "https://www.canva.com/design/DAG0ljsHzkM/0q58M_G_H9pvkIUKv2efJw/watch?utm_content=DAG0ljsHzkM&utm_campaign=designshare&utm_medium=embeds&utm_source=link"
  },
  {
    id: "mod-6",
    titulo: "Conteo de Efectivo y Cierre Z",
    descripcion: "Proceso de conteo de efectivo y ejecución del cierre Z al finalizar el turno de caja.",
    categoria: "ops",
    embedSrc: "https://www.canva.com/design/DAG1NWv98_Q/O1m6dshF9li8rCL8xPCk-w/watch?embed",
    fuente: "https://www.canva.com/design/DAG1NWv98_Q/O1m6dshF9li8rCL8xPCk-w/watch?utm_content=DAG1NWv98_Q&utm_campaign=designshare&utm_medium=embeds&utm_source=link"
  },
  {
    id: "mod-7",
    titulo: "Hacer y Recibir un Traspaso",
    descripcion: "Procedimiento correcto para enviar y recibir traspasos de mercancía entre tiendas o bodega.",
    categoria: "case",
    embedSrc: "https://www.canva.com/design/DAG1EJoxBE0/7YurmI4FFOvpcSk-rovFRA/watch?embed",
    fuente: "https://www.canva.com/design/DAG1EJoxBE0/7YurmI4FFOvpcSk-rovFRA/watch?utm_content=DAG1EJoxBE0&utm_campaign=designshare&utm_medium=embeds&utm_source=link"
  }
];

const DEFAULT_CHAT_KB = [
  {
    keywords: ["devolucion", "devolución", "devoluciones"],
    respuesta: "Para procesar una devolución: ingresa al módulo POS, selecciona 'Devoluciones', escanea el ticket original y sigue el flujo de validación de producto. Consulta el módulo de Casos Especiales para el detalle completo."
  },
  {
    keywords: ["cambio", "cambios"],
    respuesta: "Para un cambio de producto: verifica el ticket de compra, confirma que la prenda esté en buen estado y regístralo en el sistema como 'Cambio' en lugar de 'Devolución'."
  },
  {
    keywords: ["caja", "apertura"],
    respuesta: "La apertura de caja se realiza al inicio de turno: ingresa tu usuario, cuenta el fondo inicial y regístralo en el sistema antes de la primera venta."
  },
  {
    keywords: ["cierre", "cierre z"],
    respuesta: "El cierre de caja requiere el conteo del efectivo, la ejecución del Cierre Z y la validación con tu supervisor. Revisa el módulo de Conteo de Efectivo y Cierre Z."
  },
  {
    keywords: ["pos", "falla", "error", "no funciona"],
    respuesta: "Si el sistema POS falla: reinicia la terminal, verifica tu conexión de red y si el problema persiste contacta a Soporte Técnico (ext. 1234 o soporte.ti@frontretail.com)."
  },
  {
    keywords: ["garantia", "garantía"],
    respuesta: "Para gestionar una garantía, solicita el ticket de compra y la falla reportada por el cliente, y regístrala en el módulo de Casos Especiales para su seguimiento."
  },
  {
    keywords: ["traspaso"],
    respuesta: "Para hacer o recibir un traspaso, revisa el módulo 'Hacer y Recibir un Traspaso', donde se explica el proceso completo de envío y recepción de mercancía."
  },
  {
    keywords: ["factura", "facturacion", "facturación"],
    respuesta: "Para consultar o generar una factura electrónica, revisa el módulo 'Creación de Cliente y Factura Electrónica'."
  },
  {
    keywords: ["hola", "buenas", "buenos dias", "buenos días"],
    respuesta: "¡Hola! ¿En qué puedo ayudarte con tu capacitación de Front Retail hoy?"
  },
  {
    keywords: ["gracias"],
    respuesta: "¡Con gusto! Estoy aquí para ayudarte durante tu proceso de capacitación."
  }
];
