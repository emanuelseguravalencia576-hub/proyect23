# AJSE Hardware — Proyecto Final

**Estudiante:** emanuel segura valencia
**Institución:** Politécnico Superior de Occidente  
**Área:** Desarrollo web · Semestre 2  
**Presentado a:** Profesor Dioni Rodallega Murillo

AJSE Hardware es una tienda de una sola página con inventario propio, reserva de unidades y pago con Mercado Pago Checkout Pro. Los cobros solo se habilitan después de configurar PostgreSQL, credenciales del vendedor, una URL pública HTTPS y el inventario real.

Antes de conectar la base puedes usar el catálogo, los filtros y el carrito. El botón de pago permanece deshabilitado y no se crean pedidos falsos en el navegador; el panel de seguimiento y administración se habilita al configurar el backend.

## Abrir el proyecto

### Opción recomendada: frontend y backend Python

1. Instala Python 3.10 o posterior y verifica que `python` esté disponible en la terminal.
2. Abre esta carpeta en Visual Studio Code.
3. Haz doble clic en `iniciar.bat`. El archivo instala Flask desde `requirements.txt` e inicia el servidor.
4. Abre **http://127.0.0.1:5000** en el navegador.
5. Para detener el servidor, vuelve a la ventana negra y presiona `Ctrl+C`.

También puedes iniciar el servidor manualmente desde la terminal integrada:

```powershell
python -m pip install -r requirements.txt
python app.py
```

### Conectar la base de datos de Neon

1. Crea tu cuenta y un proyecto PostgreSQL en [Neon](https://neon.com/).
2. En el panel de Neon, pulsa **Connect**, selecciona la base de datos y el usuario, deja activada la conexión **Pooled** y copia la cadena de conexión.
3. Abre PowerShell en la carpeta del proyecto y ejecuta:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\iniciar_con_neon.ps1
   ```

4. Pega la cadena cuando la solicite la terminal. La entrada no se mostrará. El script instala las dependencias, configura `DATABASE_URL` solo durante la ejecución y arranca AJSE. Mantén la ventana abierta.
5. Abre `http://127.0.0.1:5000/api/products`. La primera conexión crea las tablas y carga los productos e inventario inicial en la base nueva. Al detener el servidor con `Ctrl+C`, la variable de conexión se elimina del proceso.

No guardes ni compartas la cadena de conexión: contiene la contraseña de la base. Si `product_inventory` ya existía, AJSE preserva las cantidades que ya están en PostgreSQL y no las reemplaza con el JSON.

### Configurar inventario y pagos reales

Los pagos requieren PostgreSQL. Antes de habilitarlos:

1. En `static/products.json`, verifica cada precio y reemplaza `stock: 0` con las cantidades que AJSE realmente posee y puede despachar. El inventario inicial está en cero para evitar ofrecer unidades no confirmadas; el checkout no se debe activar con precios de referencia.
2. Crea una base PostgreSQL para AJSE y configura `DATABASE_URL`.
3. Crea una aplicación de vendedor en Mercado Pago y configura sus credenciales **en el servidor**, nunca en el navegador ni en `static/app.js`. Comienza con credenciales de prueba.
4. Despliega Flask detrás de HTTPS en un dominio accesible públicamente. `PUBLIC_BASE_URL` debe ser ese origen, sin `/` final. Configura en Mercado Pago el webhook `https://TU-DOMINIO/api/payments/webhook`, selecciona notificaciones de pagos y copia la clave secreta del webhook.
5. Configura un token administrativo aleatorio de al menos 32 caracteres. No lo compartas: permite consultar datos personales de compradores desde “Gestión de pedidos”.
6. Solo cuando hayas verificado precios, existencias, webhooks y pagos de prueba, activa `AJSE_CHECKOUT_ENABLED=true`. Para cobrar dinero real, configura el Access Token productivo de Mercado Pago.

Ejemplo en PowerShell para establecer la configuración en la sesión actual:

```powershell
$env:DATABASE_URL = "postgresql://USUARIO:CONTRASENA@TU-SERVIDOR:5432/ajse_hardware"
$env:MERCADOPAGO_ACCESS_TOKEN = "TOKEN_DE_PRUEBA_O_PRODUCCION"
$env:MERCADOPAGO_WEBHOOK_SECRET = "CLAVE_SECRETA_DEL_WEBHOOK"
$env:AJSE_ADMIN_TOKEN = "GENERA_UN_TOKEN_LARGO_Y_ALEATORIO"
$env:PUBLIC_BASE_URL = "https://TU-DOMINIO"
$env:AJSE_CHECKOUT_ENABLED = "true"
```

No guardes esos valores en archivos públicos ni los envíes por chat. Si PostgreSQL ya fue inicializado, editar `stock` en el JSON no sobreescribe cantidades existentes: actualízalas directamente en la tabla `product_inventory`. El servidor inicializa el inventario desde `stock` solo para productos nuevos.

Cada pedido reserva inventario durante 30 minutos. Mercado Pago notifica el resultado al webhook; AJSE verifica la firma, consulta el pago directamente con Mercado Pago y solo entonces marca el pedido pagado. Si una reserva vencida se paga tarde, AJSE intenta reembolsarla automáticamente. La página no confirma un pago basándose únicamente en el retorno del navegador.

La integración no puede activarse con este repositorio solamente: necesitas una cuenta de vendedor de Mercado Pago, sus credenciales, inventario real y un servidor público HTTPS. Sin esos requisitos, la página deja deshabilitado el cobro en lugar de fingir que un pedido fue pagado.

### Persistencia SQL con PostgreSQL

PostgreSQL guarda pedidos, pagos e inventario con transacciones para no vender más unidades de las disponibles.

1. Instala PostgreSQL y crea una base de datos para el proyecto, por ejemplo `ajse_hardware`.
2. Instala las dependencias del proyecto con `python -m pip install -r requirements.txt`.
3. En PowerShell, define la cadena de conexión antes de iniciar Flask:

   ```powershell
   $env:DATABASE_URL = "postgresql://USUARIO:CONTRASENA@localhost:5432/ajse_hardware"
   python app.py
   ```

   Sustituye `USUARIO` y `CONTRASENA` por las credenciales locales de PostgreSQL. No publiques ni compartas esa cadena.
4. Al usar la API, el backend crea las tablas declaradas en `data/schema.sql` si aún no existen.

El catálogo de referencia está en `static/products.json`; el inventario activo se mantiene en la tabla `product_inventory`. Abre el sitio con Flask en `http://127.0.0.1:5000` durante desarrollo. Live Server y el almacenamiento JSON no habilitan cobros reales.

## Qué incluye

- Catálogo con 35 productos en 9 categorías: portátiles, celulares, tabletas, impresión, monitores, componentes, periféricos, videojuegos y repuestos.
- Búsqueda, categorías, filtros de orden, tarjetas adaptables a móvil y enlace para consultar cada referencia en Mercado Libre Colombia.
- Carrito y Checkout Pro de Mercado Pago; las unidades se reservan en PostgreSQL.
- Webhook firmado para verificar pagos, actualizar pedidos y liberar inventario fallido o vencido.
- Panel de pedidos protegido con `AJSE_ADMIN_TOKEN`.
- Vista de Visión y misión con el propósito y lema de AJSE.
- Backend REST en Flask, validación de pedidos, precios e inventario desde el servidor y persistencia transaccional en PostgreSQL.
- El carrito puede persistir en el navegador; los pedidos y pagos nunca se marcan exitosos por almacenamiento local.
- Recomendación local según las categorías que explora el visitante, la calificación y el precio de referencia; no depende de un servicio externo.

## Archivos principales

| Archivo | Función |
| --- | --- |
| `index.html` | Estructura de las pantallas y formularios. |
| `static/styles.css` | Diseño oscuro, componentes visuales y adaptación móvil. |
| `static/app.js` | Catálogo, carrito, navegación, recomendaciones y consumo de la API. |
| `static/products.json` | Catálogo de productos y precios de referencia. |
| `app.py` | API Flask, inventario, pedidos y pagos de Mercado Pago. |
| `data/schema.sql` | Tablas de pedidos, renglones e inventario de PostgreSQL. |
| `requirements.txt` | Flask y driver psycopg; la API de Mercado Pago se consume por HTTPS. |
| `iniciar.bat` | Instalación y arranque rápido en Windows. |
| `iniciar_con_neon.ps1` | Arranque que solicita la cadena de conexión de Neon sin mostrarla. |

## API del backend

| Método y ruta | Acción |
| --- | --- |
| `GET /api/products` | Devuelve el catálogo. |
| `GET /api/requests/<id>/status` | Devuelve el estado no sensible de un pedido. |
| `POST /api/requests` | Valida inventario, crea reserva y devuelve el enlace de pago. |
| `POST /api/payments/webhook` | Verifica el pago con Mercado Pago y actualiza el pedido. |
| `GET /api/admin/orders` | Devuelve pedidos privados; requiere `X-AJSE-Admin-Token`. |
| `GET /health` | Comprueba que el backend esté funcionando. |

Ejemplo del cuerpo de `POST /api/requests` (solo disponible con pagos configurados):

```json
{
  "client": "Ana Pérez",
  "email": "ana@ejemplo.com",
  "note": "Equipo para estudiar desarrollo web",
  "items": [
    { "product_id": "lap-lenovo-slim3", "quantity": 1 }
  ]
}
```

## Precios e imágenes

AJSE debe reemplazar los precios de referencia por sus precios de venta reales y configurar el inventario que realmente posee antes de activar Checkout Pro. Los productos parten con `stock: 0`; esto evita importar cantidades inventadas en una base nueva. Las imágenes pueden ser ilustrativas.

## Guion sugerido para sustentar

**1. Presentación (30 segundos)**  
“Mi proyecto se llama AJSE Hardware. Es una tienda de una sola página con catálogo e inventario propios. Cuando el servidor está configurado, el cliente paga con Mercado Pago y AJSE confirma el pedido mediante una notificación verificada.”

**2. Necesidad y objetivo (40 segundos)**  
“La idea es centralizar equipos y repuestos de diferentes categorías, facilitar su búsqueda y gestionar pedidos, existencias y pagos desde AJSE.”

**3. Recorrido por el frontend (1 minuto)**  
“En esta página se ven las categorías y productos. El cliente puede agregar artículos al carrito y, cuando los pagos estén habilitados, continuar a Mercado Pago. Si faltan credenciales o inventario real, el cobro permanece deshabilitado.”

**4. Recorrido del proceso (1 minuto)**  
“Al iniciar el pago, el servidor AJSE reserva el inventario y crea el pedido en PostgreSQL. Mercado Pago informa el resultado al webhook; AJSE verifica el pago antes de marcarlo como aprobado. El cliente consulta el estado en Mis pedidos y el administrador ve los datos en Gestión de pedidos.”

**5. Explicación técnica (1–2 minutos)**  
“HTML organiza la página, CSS implementa el diseño adaptable y JavaScript maneja filtros y carrito. Flask valida cada producto, calcula el total desde el catálogo del servidor y reserva existencias en PostgreSQL. Los pagos se confirman solo con la verificación del servidor, nunca por el retorno del navegador.”

**6. Demostración y cierre (30 segundos)**  
“Si ya están configurados el dominio HTTPS, PostgreSQL, el inventario real y las credenciales de prueba, voy a completar un pago de prueba y comprobar la actualización del pedido. De lo contrario, mostraré que el cobro permanece deshabilitado hasta completar esa configuración.”

## Alcance y mejoras futuras

No publiques el servidor hasta configurar HTTPS, credenciales de producción, el secreto de webhook, el token administrativo, inventario real y precios vigentes. La aplicación reserva inventario y verifica pagos, pero AJSE debe cumplir sus obligaciones de despacho, reembolsos y atención al cliente.
