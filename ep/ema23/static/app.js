const API_BASE = ["5000", "5001"].includes(window.location.port)
  ? "/api"
  : ["localhost", "127.0.0.1"].includes(window.location.hostname)
    ? "http://127.0.0.1:5000/api"
    : "/api";
const LOCAL_CART_KEY = "nexus-hardware-cart-v1";
const currency = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});
const categoryViews = {
  catalog: "Catálogo",
  requests: "Mis pedidos",
  approvals: "Gestión de pedidos",
  about: "Visión y misión",
};

let products = [];
let requests = [];
let cart = loadStoredValue(LOCAL_CART_KEY, []);
let activeCategory = "Todos";
let approvalFilter = "all";
let apiOnline = false;
let paymentsEnabled = false;
let adminToken = "";
let recommendationBusy = false;
let recommendationRefreshPending = false;
const categoryInterest = {};

const ui = {
  productGrid: document.querySelector("#productGrid"),
  productTemplate: document.querySelector("#productTemplate"),
  emptyCatalog: document.querySelector("#emptyCatalog"),
  resultsLabel: document.querySelector("#resultsLabel"),
  searchInput: document.querySelector("#searchInput"),
  sortSelect: document.querySelector("#sortSelect"),
  cartOverlay: document.querySelector("#cartOverlay"),
  requestOverlay: document.querySelector("#requestOverlay"),
  toastRegion: document.querySelector("#toastRegion"),
};

function loadStoredValue(key, fallback) {
  try {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : fallback;
  } catch (error) {
    console.error(`No se pudo leer ${key} del almacenamiento local.`, error);
    return fallback;
  }
}

function saveStoredValue(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.error(`No se pudo guardar ${key} en el almacenamiento local.`, error);
    toast("El navegador no pudo guardar los datos locales.", true);
  }
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
    signal: AbortSignal.timeout(20000),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || `El servidor respondió con ${response.status}.`);
  }
  return body;
}

async function initialize() {
  try {
    [products, { payments_enabled: paymentsEnabled }] = await Promise.all([
      requestJson("/products"),
      requestJson("/health"),
    ]);
    apiOnline = true;
  } catch (error) {
    console.error("No se pudo conectar con el servidor de AJSE.", error);
    try {
      const response = await fetch("/static/products.json", { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`No se pudo leer el catálogo (${response.status}).`);
      products = await response.json();
    } catch (catalogError) {
      console.error("No se pudo cargar el catálogo local.", catalogError);
      toast("No se pudo conectar con AJSE. Inicia el servidor con iniciar.bat.", true);
      return;
    }
    requests = [];
    apiOnline = false;
    paymentsEnabled = false;
  }

  document.querySelector("#heroProductCount").textContent = products.length;
  renderCategoryTabs();
  updateConnectionPill();
  updateCart();
  renderCatalog();
  renderAllRequests();
  refreshRecommendation();
  await loadCustomerOrderStatus();
}

function updateConnectionPill() {
  const pill = document.querySelector("#connectionPill");
  pill.classList.toggle("offline", !apiOnline);
  pill.innerHTML = `<i></i>${apiOnline ? (paymentsEnabled ? "AJSE · pagos activos" : "AJSE · pagos sin configurar") : "Servidor desconectado"}`;
  pill.title = apiOnline
    ? (paymentsEnabled
      ? "Servidor y cobros de Mercado Pago disponibles."
      : "Configura PostgreSQL y Mercado Pago para activar los pedidos.")
    : "Conecta el servidor de AJSE para registrar y gestionar pedidos.";
  document.querySelector("#checkoutButton").disabled = !apiOnline || !paymentsEnabled;
  document.querySelector("#submitRequest").disabled = !apiOnline || !paymentsEnabled;
  document.querySelector("#checkoutButton").textContent = paymentsEnabled
    ? "Continuar al pago"
    : "Pagos por habilitar";
  document.querySelector("#storeNotice").textContent = paymentsEnabled
    ? "Pedidos y pagos disponibles. AJSE consulta el inventario del servidor y confirma cada pago mediante Mercado Pago."
    : apiOnline
      ? "Catálogo y carrito disponibles. El registro de pedidos y los pagos se habilitarán al conectar PostgreSQL, configurar Mercado Pago y publicar AJSE con HTTPS. No se guardan pedidos ficticios."
      : "Puedes explorar el catálogo y preparar un carrito. Para cargar los datos actuales de AJSE, inicia el servidor; los pedidos y pagos no están habilitados.";
  document.querySelector("#cartSetupMessage").textContent = paymentsEnabled
    ? "AJSE reservará las unidades disponibles durante 30 minutos. El pago se procesa de forma segura con Mercado Pago."
    : "Puedes preparar tu carrito. El pedido no se registra ni se cobra hasta configurar PostgreSQL, Mercado Pago y HTTPS.";
}

function renderCategoryTabs() {
  const counts = new Map();
  for (const product of products) {
    counts.set(product.category, (counts.get(product.category) || 0) + 1);
  }
  const tabs = [["Todos", products.length], ...[...counts.entries()].sort(([a], [b]) => a.localeCompare(b, "es"))];
  const container = document.querySelector("#categoryTabs");
  container.replaceChildren(...tabs.map(([category, count]) => {
    const button = document.createElement("button");
    button.className = `category-tab${category === activeCategory ? " selected" : ""}`;
    button.dataset.category = category;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(category === activeCategory));
    button.append(category, " ");
    const badge = document.createElement("span");
    badge.textContent = count;
    button.append(badge);
    return button;
  }));
  document.querySelector("#heroCategoryCount").textContent = counts.size;
}

function toast(message, isError = false) {
  const element = document.createElement("div");
  element.className = `toast${isError ? " error" : ""}`;
  element.textContent = message;
  ui.toastRegion.append(element);
  window.setTimeout(() => element.remove(), 3900);
}

function renderCatalog() {
  const query = ui.searchInput.value.trim().toLocaleLowerCase("es");
  const sort = ui.sortSelect.value;
  let visible = products.filter((product) => {
    const matchesCategory = activeCategory === "Todos" || product.category === activeCategory;
    const searchable = `${product.name} ${product.subtitle} ${product.category} ${product.description}`.toLocaleLowerCase("es");
    return matchesCategory && searchable.includes(query);
  });

  if (sort === "price-low") visible.sort((a, b) => a.price - b.price);
  if (sort === "price-high") visible.sort((a, b) => b.price - a.price);
  if (sort === "rating") visible.sort((a, b) => b.rating - a.rating);
  if (sort === "featured") {
    visible.sort((a, b) => Number(Boolean(b.badge)) - Number(Boolean(a.badge)) || b.rating - a.rating);
  }

  ui.productGrid.replaceChildren();
  for (const product of visible) {
    const card = ui.productTemplate.content.firstElementChild.cloneNode(true);
    card.dataset.productId = product.id;
    const image = card.querySelector(".product-image");
    image.alt = product.image_alt || `${product.name}, imagen ilustrativa`;
    card.querySelector(".product-image-fallback small").textContent = product.category;
    image.addEventListener("error", () => {
      card.querySelector(".product-image-wrap").classList.add("image-unavailable");
    }, { once: true });
    image.src = product.image;
    card.querySelector(".product-badge").textContent = product.badge;
    card.querySelector(".product-category").textContent = product.category;
    card.querySelector(".product-name").textContent = product.name;
    card.querySelector(".product-subtitle").textContent = product.subtitle;
    card.querySelector(".product-rating b").textContent = product.rating.toFixed(1);
    card.querySelector(".stock-label").textContent = paymentsEnabled
      ? `${product.stock} en inventario AJSE`
      : product.stock > 0
        ? `${product.stock} unidades informadas · venta no habilitada`
        : "Inventario pendiente de configurar";
    card.querySelector(".product-price").textContent = currency.format(product.price);
    const source = card.querySelector(".source-link");
    source.href = product.source;
    source.setAttribute("aria-label", `Consultar referencias de ${product.name} en el vendedor`);
    card.querySelector(".quick-add").addEventListener("click", () => addToCart(product.id));
    card.querySelector(".card-add").addEventListener("click", () => addToCart(product.id));
    card.addEventListener("click", (event) => {
      if (!event.target.closest("button") && event.target.closest(".product-info")) {
        recordInterest(product.category);
      }
    });
    ui.productGrid.append(card);
  }
  ui.emptyCatalog.classList.toggle("hidden", visible.length > 0);
  ui.resultsLabel.textContent = `Mostrando ${visible.length} de ${products.length} productos`;
}

function recordInterest(category) {
  categoryInterest[category] = (categoryInterest[category] || 0) + 1;
  refreshRecommendation();
}

function addToCart(productId) {
  const product = products.find((item) => item.id === productId);
  if (!product) {
    toast("No se encontró el producto seleccionado.", true);
    return;
  }
  const current = cart.find((item) => item.product_id === productId);
  if (current) {
    const limit = paymentsEnabled ? Math.min(20, product.stock) : 20;
    if (current.quantity >= limit) {
      toast(paymentsEnabled ? "No hay más unidades disponibles en el inventario AJSE." : "El límite de este producto es 20 unidades.", true);
      return;
    }
    current.quantity += 1;
  } else {
    if (paymentsEnabled && product.stock < 1) {
      toast("Este producto está agotado en el inventario AJSE.", true);
      return;
    }
    cart.push({ product_id: productId, quantity: 1 });
  }
  recordInterest(product.category);
  saveStoredValue(LOCAL_CART_KEY, cart);
  updateCart();
  toast(`${product.name} agregado al carrito.`);
}

function updateCart() {
  const count = cart.reduce((sum, item) => sum + item.quantity, 0);
  document.querySelector("#cartCount").textContent = count;
  document.querySelector("#drawerCartCount").textContent = count;
  document.querySelector("#requestNavCount").textContent = requests.length;
  document.querySelector("#approvalNavCount").textContent =
    requests.filter((item) => item.status === "pending").length;

  const container = document.querySelector("#cartItems");
  container.replaceChildren();
  let total = 0;
  for (const item of cart) {
    const product = products.find((entry) => entry.id === item.product_id);
    if (!product) continue;
    total += product.price * item.quantity;
    const row = document.createElement("article");
    row.className = "cart-item";
    const image = document.createElement("img");
    image.src = product.image;
    image.alt = "";
    const details = document.createElement("div");
    const name = document.createElement("h3");
    name.textContent = product.name;
    const unitPrice = document.createElement("small");
    unitPrice.textContent = `${currency.format(product.price)} c/u`;
    const controls = document.createElement("div");
    controls.className = "quantity-control";
    const decrement = document.createElement("button");
    decrement.textContent = "−";
    decrement.setAttribute("aria-label", `Quitar una unidad de ${product.name}`);
    decrement.addEventListener("click", () => changeQuantity(product.id, -1));
    const quantity = document.createElement("span");
    quantity.textContent = item.quantity;
    const increment = document.createElement("button");
    increment.textContent = "+";
    increment.setAttribute("aria-label", `Agregar una unidad de ${product.name}`);
    increment.addEventListener("click", () => changeQuantity(product.id, 1));
    const remove = document.createElement("button");
    remove.className = "remove-item";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Eliminar ${product.name} del carrito`);
    remove.addEventListener("click", () => removeFromCart(product.id));
    controls.append(decrement, quantity, increment, remove);
    details.append(name, unitPrice, controls);
    const lineTotal = document.createElement("strong");
    lineTotal.className = "cart-item-price";
    lineTotal.textContent = currency.format(product.price * item.quantity);
    row.append(image, details, lineTotal);
    container.append(row);
  }

  document.querySelector("#emptyCart").classList.toggle("hidden", cart.length > 0);
  document.querySelector("#cartSummary").classList.toggle("hidden", cart.length === 0);
  document.querySelector("#cartSubtotal").textContent = currency.format(total);
  document.querySelector("#formTotal").textContent = currency.format(total);
}

function changeQuantity(productId, amount) {
  const item = cart.find((entry) => entry.product_id === productId);
  if (!item) return;
  const product = products.find((entry) => entry.id === productId);
  const limit = paymentsEnabled && product ? Math.min(20, product.stock) : 20;
  item.quantity = Math.max(0, Math.min(limit, item.quantity + amount));
  cart = cart.filter((entry) => entry.quantity > 0);
  saveStoredValue(LOCAL_CART_KEY, cart);
  updateCart();
}

function removeFromCart(productId) {
  cart = cart.filter((item) => item.product_id !== productId);
  saveStoredValue(LOCAL_CART_KEY, cart);
  updateCart();
}

function setView(viewName) {
  for (const [name, label] of Object.entries(categoryViews)) {
    document.querySelector(`#${name}View`).classList.toggle("hidden", name !== viewName);
  }
  document.querySelectorAll(".nav-link").forEach((link) => {
    link.classList.toggle("active", link.dataset.view === viewName);
  });
  document.querySelector("#breadcrumbCurrent").textContent = categoryViews[viewName];
  if (viewName === "requests") renderRequests();
  if (viewName === "approvals") {
    document.querySelector("#adminLoginPanel").classList.toggle("hidden", Boolean(adminToken));
    document.querySelector("#adminOrdersPanel").classList.toggle("hidden", !adminToken);
    if (adminToken) renderApprovals();
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function loadCustomerOrderStatus() {
  let orderId = new URLSearchParams(window.location.search).get("order_id");
  try {
    orderId ||= sessionStorage.getItem("ajseLastOrderId");
  } catch (error) {
    console.error("No se pudo recuperar el identificador del pedido.", error);
  }
  if (!apiOnline || !orderId) return;

  const result = new URLSearchParams(window.location.search).get("payment_result");
  const refreshStatus = async () => {
    try {
      const order = await requestJson(`/requests/${encodeURIComponent(orderId)}/status`);
      requests = [order];
      renderRequests();
      return order.payment_status;
    } catch (error) {
      console.error("No se pudo consultar el estado del pedido.", error);
      return null;
    }
  };

  if (result === "success") toast("Pago recibido por Mercado Pago; verificando confirmación.");
  else if (result === "pending") toast("Mercado Pago dejó el pago pendiente de confirmación.");
  else if (result === "failure") toast("El pago no se completó. El pedido puede volver a intentarse.");

  let status = await refreshStatus();
  for (let attempt = 0; result === "success" && status === "pending" && attempt < 8; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 2500));
    status = await refreshStatus();
  }
  if (status === "approved") toast("Pago confirmado. El pedido quedó registrado.");
  else if (status === "refunded") toast("El pago fue reembolsado porque la reserva venció.", true);

  if (result) {
    window.history.replaceState({}, "", window.location.pathname);
  }
}

async function loadAdminOrders(token) {
  const message = document.querySelector("#adminLoginMessage");
  message.textContent = "Verificando acceso...";
  try {
    const orders = await requestJson("/admin/orders", {
      headers: { "X-AJSE-Admin-Token": token },
    });
    adminToken = token;
    requests = orders;
    document.querySelector("#adminLoginPanel").classList.add("hidden");
    document.querySelector("#adminOrdersPanel").classList.remove("hidden");
    message.textContent = "";
    renderApprovals();
  } catch (error) {
    adminToken = "";
    message.textContent = error.message;
  }
}

function openOverlay(overlay) {
  overlay.classList.remove("hidden");
  overlay.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function closeOverlay(overlay) {
  overlay.classList.add("hidden");
  overlay.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

async function submitRequest(event) {
  event.preventDefault();
  if (!apiOnline) {
    toast("No hay conexión con AJSE. El pedido no se registró; conecta el servidor e inténtalo de nuevo.", true);
    return;
  }
  if (!cart.length) {
    toast("Agrega al menos un producto antes de enviar.", true);
    return;
  }
  const form = event.currentTarget;
  const formData = new FormData(form);
  const body = {
    client: String(formData.get("client")).trim(),
    email: String(formData.get("email")).trim(),
    note: String(formData.get("note")).trim(),
    items: cart.map((item) => ({ product_id: item.product_id, quantity: item.quantity })),
  };
  const button = document.querySelector("#submitRequest");
  button.disabled = true;
  button.textContent = "Registrando pedido...";
  try {
    const created = await requestJson("/requests", { method: "POST", body: JSON.stringify(body) });
    if (!created.checkout_url) throw new Error("El servidor no devolvió un enlace de pago.");
    try {
      sessionStorage.setItem("ajseLastOrderId", created.id);
    } catch (storageError) {
      console.error("No se pudo guardar el seguimiento del pedido en esta pestaña.", storageError);
    }
    requests.unshift(created);
    cart = [];
    saveStoredValue(LOCAL_CART_KEY, cart);
    updateCart();
    renderAllRequests();
    closeOverlay(ui.requestOverlay);
    closeOverlay(ui.cartOverlay);
    form.reset();
    window.location.assign(created.checkout_url);
  } catch (error) {
    if (error instanceof TypeError || error.name === "TimeoutError") {
      apiOnline = false;
      updateConnectionPill();
    }
    console.error("No se pudo registrar el pedido.", error);
    toast(`No se pudo registrar el pedido: ${error.message}`, true);
  } finally {
    button.disabled = !apiOnline;
    button.innerHTML = "Registrar pedido <span>→</span>";
  }
}

function localizeStatus(status) {
  return {
    pending: "Pago pendiente",
    approved: "Pagado",
    rejected: "Pago rechazado",
    cancelled: "Pago cancelado",
    expired: "Reserva vencida",
    refunded: "Reembolsado",
  }[status] || "Estado desconocido";
}

function makeRequestCard(item) {
  const card = document.createElement("article");
  card.className = "request-card";
  const head = document.createElement("div");
  head.className = "request-card-head";
  const titleBlock = document.createElement("div");
  const id = document.createElement("span");
  id.className = "request-id";
  id.textContent = `PEDIDO · ${item.id.slice(0, 8).toUpperCase()}`;
  const title = document.createElement("h3");
  title.textContent = item.client || "Tu pedido en AJSE";
  const meta = document.createElement("div");
  meta.className = "request-meta";
  const date = document.createElement("span");
  date.textContent = new Date(item.created_at).toLocaleString("es-CO", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  titleBlock.append(id, title);
  if (item.email) {
    const email = document.createElement("span");
    email.textContent = item.email;
    meta.append(email);
  }
  meta.append(date);
  titleBlock.append(meta);
  const status = document.createElement("span");
  const paymentStatus = item.payment_status || item.status;
  status.className = `status-badge status-${paymentStatus === "pending" ? "pending" : paymentStatus === "approved" ? "approved" : "rejected"}`;
  status.textContent = localizeStatus(paymentStatus);
  head.append(titleBlock, status);

  const lines = document.createElement("div");
  lines.className = "request-lines";
  for (const product of item.items || []) {
    const line = document.createElement("div");
    line.className = "request-line";
    const name = document.createElement("span");
    name.textContent = `${product.quantity} × ${product.name}`;
    const total = document.createElement("span");
    total.textContent = currency.format(product.unit_price * product.quantity);
    line.append(name, total);
    lines.append(line);
  }
  if (item.note) {
    const note = document.createElement("div");
    note.className = "request-line";
    const noteText = document.createElement("span");
    noteText.textContent = `Nota: ${item.note}`;
    note.append(noteText);
    lines.append(note);
  }

  const bottom = document.createElement("div");
  bottom.className = "request-bottom";
  const amount = document.createElement("div");
  amount.className = "request-total";
  amount.append("Total del pedido");
  const strongTotal = document.createElement("strong");
  strongTotal.textContent = currency.format(item.total);
  amount.append(strongTotal);
  bottom.append(amount);
  card.append(head, lines, bottom);
  return card;
}

function renderRequests() {
  const pending = requests.filter((item) => (item.payment_status || item.status) === "pending").length;
  const approved = requests.filter((item) => (item.payment_status || item.status) === "approved").length;
  const rejected = requests.filter((item) => !["pending", "approved"].includes(item.payment_status || item.status)).length;
  document.querySelector("#requestMetrics").innerHTML = [
    ["Pedidos", requests.length, "Registrados en AJSE"],
    ["Pagos pendientes", pending, "Esperan respuesta de Mercado Pago"],
    ["Pagados / fallidos", `${approved} / ${rejected}`, "Estado verificado por AJSE"],
  ].map(([label, value, caption]) =>
    `<article class="metric-card"><span>${label}</span><strong>${value}</strong><small>${caption}</small></article>`,
  ).join("");

  const list = document.querySelector("#requestsList");
  list.replaceChildren(...requests.map((item) => makeRequestCard(item)));
  document.querySelector("#emptyRequests").classList.toggle("hidden", requests.length > 0);
}

function renderApprovals() {
  const counts = {
    pending: requests.filter((item) => item.status === "pending").length,
    approved: requests.filter((item) => item.status === "approved").length,
    rejected: requests.filter((item) => item.status === "rejected").length,
  };
  document.querySelector("#approvalSummary").innerHTML = [
    ["Pago pendiente", counts.pending, "Esperan confirmación de Mercado Pago"],
    ["Pagados", counts.approved, "Pago confirmado por Mercado Pago"],
    ["Fallidos", counts.rejected, "Cancelados, rechazados o vencidos"],
  ].map(([label, value, caption]) =>
    `<article class="metric-card"><span>${label}</span><strong>${value}</strong><small>${caption}</small></article>`,
  ).join("");
  const visible = approvalFilter === "all"
    ? requests
    : requests.filter((item) => item.status === approvalFilter);
  const list = document.querySelector("#approvalsList");
  list.replaceChildren(...visible.map((item) => makeRequestCard(item)));
  document.querySelector("#emptyApprovals").classList.toggle("hidden", visible.length > 0);
}

function renderAllRequests() {
  updateCart();
  renderRequests();
  renderApprovals();
}

async function refreshRecommendation() {
  if (!products.length) return;
  if (recommendationBusy) {
    recommendationRefreshPending = true;
    return;
  }
  recommendationBusy = true;
  try {
    const budget = 4000000;
    const maxInterest = Math.max(1, ...Object.values(categoryInterest));
    const features = products.map((product) => [
      0.08 + ((categoryInterest[product.category] || 0) / maxInterest) * 0.92,
      product.rating / 5,
      Math.max(0, 1 - product.price / budget),
    ]);
    const scores = features.map(([interest, rating, priceFit]) =>
      interest * 0.6 + rating * 0.25 + priceFit * 0.15);
    const ranked = products.map((product, index) => ({ product, score: scores[index] }))
      .sort((a, b) => b.score - a.score);
    const recommended = ranked.find(({ product }) => !cart.some((item) => item.product_id === product.id))?.product
      || ranked[0]?.product;
    if (!recommended) return;

    const preferredCategory = Object.entries(categoryInterest).sort((a, b) => b[1] - a[1])[0]?.[0] || recommended.category;

    document.querySelector("#recommendationName").textContent = recommended.name;
    document.querySelector("#recommendationPrice").textContent = currency.format(recommended.price);
    document.querySelector("#recommendationAdd").dataset.productId = recommended.id;
    document.querySelector("#aiSummaryTitle").textContent = `Te recomendamos ${recommended.name}`;
    document.querySelector("#recommendationSubtitle").textContent =
      "Según la categoría que exploras, la calificación y el precio de referencia.";
    document.querySelector("#aiSummaryText").textContent =
      `Exploras ${preferredCategory.toLowerCase()}; esta opción combina calificación y precio de referencia.`;
    document.querySelector("#recommendationRating").textContent = `${recommended.rating.toFixed(1)} / 5`;
    document.querySelector("#aiBudget").textContent = `≤ ${currency.format(budget)}`;
    const signals = [
      `Categoría de interés: ${preferredCategory}`,
      `Calificación publicada: ${recommended.rating.toFixed(1)} / 5`,
      `Precio de referencia: ${currency.format(recommended.price)}`,
      "Disponibilidad: confirmar con el equipo AJSE",
    ];
    document.querySelector("#aiSignals").replaceChildren(
      ...signals.map((entry) => {
        const signal = document.createElement("li");
        signal.textContent = entry;
        return signal;
      }),
    );
  } catch (error) {
    console.error("No se pudo calcular la recomendación.", error);
    toast("No se pudo actualizar la recomendación.", true);
  } finally {
    recommendationBusy = false;
    if (recommendationRefreshPending) {
      recommendationRefreshPending = false;
      refreshRecommendation();
    }
  }
}
document.querySelectorAll(".nav-link").forEach((link) => {
  link.addEventListener("click", () => setView(link.dataset.view));
});
document.querySelectorAll("[data-go-catalog]").forEach((button) => {
  button.addEventListener("click", () => setView("catalog"));
});
document.querySelector("#categoryTabs").addEventListener("click", (event) => {
  const button = event.target.closest(".category-tab");
  if (!button) return;
  activeCategory = button.dataset.category;
  document.querySelectorAll(".category-tab").forEach((tab) => {
    const selected = tab === button;
    tab.classList.toggle("selected", selected);
    tab.setAttribute("aria-selected", String(selected));
  });
  if (activeCategory !== "Todos") recordInterest(activeCategory);
  renderCatalog();
});
document.querySelector("#searchInput").addEventListener("input", renderCatalog);
document.querySelector("#sortSelect").addEventListener("change", renderCatalog);
document.querySelector("#exploreButton").addEventListener("click", () =>
  document.querySelector("#catalog").scrollIntoView({ behavior: "smooth" }));
document.querySelector("#showAllButton").addEventListener("click", () => {
  activeCategory = "Todos";
  document.querySelector("#searchInput").value = "";
  document.querySelectorAll(".category-tab").forEach((tab) => {
    const selected = tab.dataset.category === "Todos";
    tab.classList.toggle("selected", selected);
    tab.setAttribute("aria-selected", String(selected));
  });
  renderCatalog();
});
document.querySelector("#cartButton").addEventListener("click", () => openOverlay(ui.cartOverlay));
document.querySelectorAll("[data-close-cart]").forEach((button) =>
  button.addEventListener("click", () => closeOverlay(ui.cartOverlay)));
ui.cartOverlay.addEventListener("click", (event) => {
  if (event.target === ui.cartOverlay) closeOverlay(ui.cartOverlay);
});
document.querySelector("#checkoutButton").addEventListener("click", () => {
  if (!apiOnline) {
    toast("Conecta el servidor AJSE para registrar un pedido.", true);
    return;
  }
  closeOverlay(ui.cartOverlay);
  openOverlay(ui.requestOverlay);
  document.querySelector("#clientName").focus();
});
document.querySelectorAll("[data-close-request]").forEach((button) =>
  button.addEventListener("click", () => closeOverlay(ui.requestOverlay)));
ui.requestOverlay.addEventListener("click", (event) => {
  if (event.target === ui.requestOverlay) closeOverlay(ui.requestOverlay);
});
document.querySelector("#requestForm").addEventListener("submit", submitRequest);
document.querySelector("#adminLoginPanel").addEventListener("submit", (event) => {
  event.preventDefault();
  const token = document.querySelector("#adminTokenInput").value.trim();
  if (token) loadAdminOrders(token);
});
document.querySelectorAll(".filter-chip").forEach((button) => {
  button.addEventListener("click", () => {
    approvalFilter = button.dataset.status;
    document.querySelectorAll(".filter-chip").forEach((chip) =>
      chip.classList.toggle("active", chip === button));
    renderApprovals();
  });
});
document.querySelector("#recommendationAdd").addEventListener("click", (event) =>
  addToCart(event.currentTarget.dataset.productId));
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "k") {
    event.preventDefault();
    ui.searchInput.focus();
  }
  if (event.key === "Escape") {
    closeOverlay(ui.cartOverlay);
    closeOverlay(ui.requestOverlay);
  }
});

initialize();
