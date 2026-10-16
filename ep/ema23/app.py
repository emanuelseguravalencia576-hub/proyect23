from __future__ import annotations

import json
import hashlib
import hmac
import os
import re
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from secrets import compare_digest
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from uuid import uuid4

from flask import Flask, jsonify, request, send_from_directory


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
PRODUCTS_FILE = STATIC_DIR / "products.json"
SCHEMA_FILE = BASE_DIR / "data" / "schema.sql"
DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
PAYMENT_RESERVATION_DURATION = timedelta(minutes=30)

app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="/static")


@app.after_request
def allow_local_frontend(response):
    origin = request.headers.get("Origin", "")
    if origin:
        try:
            parsed_origin = urlparse(origin)
            origin_port = parsed_origin.port
        except ValueError:
            parsed_origin = None
            origin_port = None
        if (
            parsed_origin is not None
            and parsed_origin.scheme in {"http", "https"}
            and parsed_origin.hostname in {"127.0.0.1", "localhost"}
            and origin_port is not None
        ):
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Vary"] = "Origin"
            response.headers["Access-Control-Allow-Headers"] = "Content-Type, X-AJSE-Admin-Token"
            response.headers["Access-Control-Allow-Methods"] = "GET, POST, PATCH, OPTIONS"

    if request.method == "OPTIONS":
        response.status_code = 200

    return response


@app.errorhandler(RuntimeError)
def handle_service_error(error):
    app.logger.error("Error de servicio de AJSE: %s", error)
    return jsonify(error="El servicio no está disponible temporalmente."), 503


def read_json(path: Path, fallback):
    try:
        with path.open(encoding="utf-8") as file:
            return json.load(file)
    except FileNotFoundError:
        return fallback


@contextmanager
def postgres_connection():
    try:
        import psycopg
        from psycopg.rows import dict_row
    except ImportError as error:
        raise RuntimeError(
            "PostgreSQL está configurado, pero falta instalar psycopg. "
            "Ejecuta: python -m pip install -r requirements.txt"
        ) from error

    try:
        with psycopg.connect(DATABASE_URL, row_factory=dict_row) as connection:
            yield connection
    except psycopg.Error as error:
        raise RuntimeError("No se pudo completar la operación en PostgreSQL.") from error


def initialize_postgres(connection):
    with SCHEMA_FILE.open(encoding="utf-8") as schema:
        connection.execute(schema.read())
    catalog = read_json(PRODUCTS_FILE, [])
    connection.executemany(
        """
        INSERT INTO product_inventory (product_id, stock)
        VALUES (%s, %s)
        ON CONFLICT (product_id) DO NOTHING
        """,
        [(item["id"], item["stock"]) for item in catalog],
    )


def checkout_is_enabled():
    configured = all((
        DATABASE_URL,
        os.environ.get("MERCADOPAGO_ACCESS_TOKEN", "").strip(),
        os.environ.get("MERCADOPAGO_WEBHOOK_SECRET", "").strip(),
        len(os.environ.get("AJSE_ADMIN_TOKEN", "").strip()) >= 32,
        os.environ.get("AJSE_CHECKOUT_ENABLED", "").strip().lower() == "true",
        os.environ.get("PUBLIC_BASE_URL", "").strip(),
    ))
    if not configured:
        return False
    try:
        public_base_url()
    except RuntimeError:
        return False
    return True


def public_base_url():
    base_url = os.environ.get("PUBLIC_BASE_URL", "").strip().rstrip("/")
    try:
        parsed = urlparse(base_url)
        public_port = parsed.port
    except ValueError as error:
        raise RuntimeError("PUBLIC_BASE_URL debe tener un puerto HTTPS válido.") from error
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or public_port == 0
        or parsed.username
        or parsed.password
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError("PUBLIC_BASE_URL debe ser la URL pública HTTPS de AJSE.")
    return base_url


def mercado_pago_api(path, payload=None, idempotency_key=None):
    access_token = os.environ.get("MERCADOPAGO_ACCESS_TOKEN", "").strip()
    if not access_token:
        raise RuntimeError("Falta configurar MERCADOPAGO_ACCESS_TOKEN en el servidor.")

    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if idempotency_key:
        headers["X-Idempotency-Key"] = idempotency_key
    api_request = Request(
        f"https://api.mercadopago.com{path}",
        data=data,
        headers=headers,
        method="POST" if data is not None else "GET",
    )
    try:
        with urlopen(api_request, timeout=15) as response:
            result = json.loads(response.read().decode("utf-8"))
            if not isinstance(result, dict):
                raise RuntimeError("Mercado Pago devolvió una respuesta inválida.")
            return result
    except HTTPError as error:
        try:
            details = json.loads(error.read().decode("utf-8"))
            message = (
                details.get("message", "Error de Mercado Pago.")
                if isinstance(details, dict)
                else "Error de Mercado Pago."
            )
        except (json.JSONDecodeError, UnicodeDecodeError):
            message = "Error de Mercado Pago."
        raise RuntimeError(f"Mercado Pago respondió {error.code}: {message}") from error
    except (URLError, TimeoutError, json.JSONDecodeError, UnicodeDecodeError) as error:
        raise RuntimeError("No se pudo conectar con Mercado Pago.") from error


def create_payment_preference(order, expires_at):
    base_url = public_base_url()
    payload = {
        "items": [
            {
                "id": item["product_id"],
                "title": item["name"][:256],
                "quantity": item["quantity"],
                "currency_id": "COP",
                "unit_price": item["unit_price"],
            }
            for item in order["items"]
        ],
        "payer": {"name": order["client"], "email": order["email"]},
        "external_reference": order["id"],
        "statement_descriptor": "AJSE HARDWARE",
        "back_urls": {
            "success": f"{base_url}/?payment_result=success&order_id={order['id']}",
            "pending": f"{base_url}/?payment_result=pending&order_id={order['id']}",
            "failure": f"{base_url}/?payment_result=failure&order_id={order['id']}",
        },
        "auto_return": "approved",
        "notification_url": f"{base_url}/api/payments/webhook",
        "expires": True,
        "expiration_date_from": datetime.now(timezone.utc).isoformat(),
        "expiration_date_to": expires_at.isoformat(),
    }
    preference = mercado_pago_api(
        "/checkout/preferences",
        payload,
        idempotency_key=order["id"],
    )
    checkout_url = preference.get("init_point")
    if not preference.get("id") or not checkout_url:
        raise RuntimeError("Mercado Pago no devolvió un enlace de pago válido.")
    checkout_host = urlparse(checkout_url).hostname or ""
    trusted_checkout_host = (
        checkout_host == "mercadopago.com"
        or checkout_host.endswith(".mercadopago.com")
        or checkout_host == "mercadopago.com.co"
        or checkout_host.endswith(".mercadopago.com.co")
    )
    if urlparse(checkout_url).scheme != "https" or not trusted_checkout_host:
        raise RuntimeError("Mercado Pago devolvió un enlace de pago no seguro.")
    return preference["id"], checkout_url, expires_at


def reserve_and_save_order(order, expires_at):
    with postgres_connection() as connection:
        initialize_postgres(connection)
        for item in order["items"]:
            reserved = connection.execute(
                """
                UPDATE product_inventory
                SET stock = stock - %s
                WHERE product_id = %s AND stock >= %s
                RETURNING stock
                """,
                (item["quantity"], item["product_id"], item["quantity"]),
            ).fetchone()
            if reserved is None:
                raise ValueError(f"No hay suficientes unidades de {item['name']}.")

        connection.execute(
            """
            INSERT INTO purchase_requests
                (id, client, email, note, total, status, created_at,
                 payment_status, expires_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, 'pending', %s)
            """,
            (
                order["id"],
                order["client"],
                order["email"],
                order["note"],
                order["total"],
                "pending",
                datetime.fromisoformat(order["created_at"]),
                expires_at,
            ),
        )
        connection.executemany(
            """
            INSERT INTO purchase_request_items
                (request_id, product_id, name, quantity, unit_price)
            VALUES (%s, %s, %s, %s, %s)
            """,
            [
                (
                    order["id"],
                    item["product_id"],
                    item["name"],
                    item["quantity"],
                    item["unit_price"],
                )
                for item in order["items"]
            ],
        )


def save_payment_preference(order_id, preference_id):
    with postgres_connection() as connection:
        initialize_postgres(connection)
        updated = connection.execute(
            """
            UPDATE purchase_requests
            SET payment_preference_id = %s
            WHERE id = %s AND payment_status = 'pending'
            RETURNING id
            """,
            (preference_id, order_id),
        ).fetchone()
        if updated is None:
            raise RuntimeError("El pedido dejó de estar pendiente antes de guardar el pago.")


def cancel_unpaid_order(order_id):
    with postgres_connection() as connection:
        initialize_postgres(connection)
        order = connection.execute(
            """
            SELECT payment_status
            FROM purchase_requests
            WHERE id = %s
            FOR UPDATE
            """,
            (order_id,),
        ).fetchone()
        if order is None or order["payment_status"] != "pending":
            return
        release_inventory(connection, order_id)
        connection.execute(
            """
            UPDATE purchase_requests
            SET status = 'rejected', payment_status = 'rejected',
                decided_at = %s
            WHERE id = %s AND payment_status = 'pending'
            """,
            (datetime.now(timezone.utc), order_id),
        )


def release_inventory(connection, order_id):
    items = connection.execute(
        """
        SELECT product_id, quantity
        FROM purchase_request_items
        WHERE request_id = %s
        """,
        (order_id,),
    ).fetchall()
    for item in items:
        connection.execute(
            """
            UPDATE product_inventory
            SET stock = stock + %s
            WHERE product_id = %s
            """,
            (item["quantity"], item["product_id"]),
        )


def expire_pending_orders():
    if not DATABASE_URL:
        return
    with postgres_connection() as connection:
        initialize_postgres(connection)
        expired = connection.execute(
            """
            SELECT id
            FROM purchase_requests
            WHERE payment_status = 'pending'
              AND expires_at <= %s
            FOR UPDATE
            """,
            (datetime.now(timezone.utc),),
        ).fetchall()
        for order in expired:
            release_inventory(connection, order["id"])
            connection.execute(
                """
                UPDATE purchase_requests
                SET status = 'rejected', payment_status = 'expired',
                    decided_at = %s
                WHERE id = %s AND payment_status = 'pending'
                """,
                (datetime.now(timezone.utc), order["id"]),
            )


def update_payment_from_provider(payment):
    order_id = payment.get("external_reference")
    if not isinstance(order_id, str) or not order_id:
        order_id = None
    provider_status = payment.get("status")
    payment_id = str(payment["id"])

    if order_id is None:
        return ("refund_required" if provider_status == "approved" else "ignored"), None, payment_id

    try:
        paid_amount = Decimal(str(payment.get("transaction_amount")))
    except (InvalidOperation, TypeError):
        paid_amount = None
    if paid_amount is not None and not paid_amount.is_finite():
        paid_amount = None

    with postgres_connection() as connection:
        initialize_postgres(connection)
        order = connection.execute(
            """
            SELECT id, total, status, payment_status, payment_id
            FROM purchase_requests
            WHERE id = %s
            FOR UPDATE
            """,
            (order_id,),
        ).fetchone()
        if order is None:
            return ("refund_required" if provider_status == "approved" else "ignored"), order_id, payment_id

        if provider_status == "approved":
            if payment.get("currency_id") != "COP" or paid_amount != Decimal(order["total"]):
                return "refund_required", order_id, payment_id
            if order["payment_status"] in {"approved", "refunded"}:
                if order["payment_id"] == payment_id:
                    return order["payment_status"], order_id, payment_id
                return "refund_required", order_id, payment_id
            if order["payment_status"] != "pending":
                return "refund_required", order_id, payment_id
            connection.execute(
                """
                UPDATE purchase_requests
                SET status = 'approved', payment_status = 'approved',
                    payment_id = %s, decided_at = %s
                WHERE id = %s AND payment_status = 'pending'
                """,
                (payment_id, datetime.now(timezone.utc), order_id),
            )
            return "approved", order_id, payment_id

        if provider_status in {"rejected", "cancelled"} and order["payment_status"] == "pending":
            release_inventory(connection, order_id)
            connection.execute(
                """
                UPDATE purchase_requests
                SET status = 'rejected', payment_status = %s,
                    payment_id = %s, decided_at = %s
                WHERE id = %s AND payment_status = 'pending'
                """,
                (provider_status, payment_id, datetime.now(timezone.utc), order_id),
            )
            return provider_status, order_id, payment_id
        return order["payment_status"], order_id, payment_id


def mark_payment_refunded(order_id, payment_id):
    if order_id is None:
        return
    with postgres_connection() as connection:
        initialize_postgres(connection)
        order = connection.execute(
            """
            SELECT payment_status
            FROM purchase_requests
            WHERE id = %s
            FOR UPDATE
            """,
            (order_id,),
        ).fetchone()
        if order is None or order["payment_status"] == "approved":
            return
        if order["payment_status"] == "pending":
            release_inventory(connection, order_id)
        connection.execute(
            """
            UPDATE purchase_requests
            SET status = CASE WHEN status = 'pending' THEN 'rejected' ELSE status END,
                payment_status = 'refunded', payment_id = %s
            WHERE id = %s AND payment_status != 'approved'
            """,
            (payment_id, order_id),
        )


def verify_mercado_pago_signature(data_id):
    secret = os.environ.get("MERCADOPAGO_WEBHOOK_SECRET", "").strip()
    signature_header = request.headers.get("x-signature", "")
    request_id = request.headers.get("x-request-id", "")
    parts = dict(
        part.strip().split("=", 1)
        for part in signature_header.split(",")
        if "=" in part
    )
    timestamp = parts.get("ts")
    signature = parts.get("v1")
    if not secret or not timestamp or not signature or not request_id:
        return False
    manifest = f"id:{data_id};request-id:{request_id};ts:{timestamp};"
    expected = hmac.new(secret.encode("utf-8"), manifest.encode("utf-8"), hashlib.sha256).hexdigest()
    return compare_digest(expected, signature)


def require_admin():
    configured_token = os.environ.get("AJSE_ADMIN_TOKEN", "").strip()
    if len(configured_token) < 32:
        return jsonify(error="El panel requiere un AJSE_ADMIN_TOKEN de al menos 32 caracteres."), 503
    supplied_token = request.headers.get("X-AJSE-Admin-Token", "")
    if not compare_digest(configured_token, supplied_token):
        return jsonify(error="Autorización de administración inválida."), 401
    return None


@app.get("/")
def index():
    return send_from_directory(BASE_DIR, "index.html")


@app.get("/api/products")
def products():
    catalog = read_json(PRODUCTS_FILE, [])
    if DATABASE_URL:
        expire_pending_orders()
        with postgres_connection() as connection:
            initialize_postgres(connection)
            inventory = {
                row["product_id"]: row["stock"]
                for row in connection.execute(
                    "SELECT product_id, stock FROM product_inventory"
                ).fetchall()
            }
        for product in catalog:
            product["stock"] = inventory.get(product["id"], 0)
    return jsonify(catalog)


@app.get("/api/requests/<request_id>/status")
def request_status(request_id):
    if not DATABASE_URL:
        return jsonify(error="El seguimiento de pedidos requiere PostgreSQL."), 503
    expire_pending_orders()
    with postgres_connection() as connection:
        initialize_postgres(connection)
        order = connection.execute(
            """
            SELECT id, total, status, payment_status, created_at
            FROM purchase_requests
            WHERE id = %s
            """,
            (request_id,),
        ).fetchone()
    if order is None:
        return jsonify(error="No se encontró el pedido."), 404
    return jsonify({
        "id": order["id"],
        "total": order["total"],
        "status": order["status"],
        "payment_status": order["payment_status"],
        "created_at": order["created_at"].isoformat(),
    })


@app.post("/api/requests")
def create_request():
    if not checkout_is_enabled():
        return jsonify(
            error=(
                "Los pedidos y cobros aún no están habilitados. Configura PostgreSQL, "
                "Mercado Pago, AJSE_ADMIN_TOKEN, PUBLIC_BASE_URL y "
                "AJSE_CHECKOUT_ENABLED=true en el servidor."
            )
        ), 503
    expire_pending_orders()

    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify(error="El cuerpo debe ser un objeto JSON."), 400

    client = body.get("client")
    email = body.get("email")
    note = body.get("note", "")
    if not isinstance(client, str) or not isinstance(email, str) or not isinstance(note, str):
        return jsonify(error="El nombre, correo y nota deben ser texto."), 400
    client = client.strip()
    email = email.strip()
    note = note.strip()[:500]
    submitted_items = body.get("items")
    if not client or len(client) > 100:
        return jsonify(error="Escribe un nombre de cliente válido (máximo 100 caracteres)."), 400
    if not EMAIL_PATTERN.fullmatch(email) or len(email) > 150:
        return jsonify(error="Escribe un correo electrónico válido."), 400
    if not isinstance(submitted_items, list) or not submitted_items:
        return jsonify(error="Agrega al menos un producto a la solicitud."), 400

    catalog = read_json(PRODUCTS_FILE, [])
    products_by_id = {item["id"]: item for item in catalog}
    if len(submitted_items) > len(products_by_id):
        return jsonify(error="El pedido contiene demasiadas líneas de productos."), 400
    quantities = {}
    total = 0
    for submitted in submitted_items:
        if not isinstance(submitted, dict):
            return jsonify(error="Hay un producto inválido en la solicitud."), 400
        product_id = submitted.get("product_id")
        product = products_by_id.get(product_id) if isinstance(product_id, str) else None
        quantity = submitted.get("quantity")
        if product is None or not isinstance(quantity, int) or isinstance(quantity, bool) or not 1 <= quantity <= 20:
            return jsonify(error="Producto o cantidad inválidos. Cada cantidad debe estar entre 1 y 20."), 400
        combined_quantity = quantities.get(product["id"], 0) + quantity
        if combined_quantity > 20:
            return jsonify(error="Cada producto permite un máximo de 20 unidades por pedido."), 400
        quantities[product["id"]] = combined_quantity

    items = [
        {
            "product_id": products_by_id[product_id]["id"],
            "name": products_by_id[product_id]["name"],
            "quantity": quantity,
            "unit_price": products_by_id[product_id]["price"],
        }
        for product_id, quantity in quantities.items()
    ]
    total = sum(item["unit_price"] * item["quantity"] for item in items)

    created = {
        "id": str(uuid4()),
        "client": client,
        "email": email,
        "note": note,
        "items": items,
        "total": total,
        "status": "pending",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    expires_at = datetime.now(timezone.utc) + PAYMENT_RESERVATION_DURATION
    try:
        reserve_and_save_order(created, expires_at)
        preference_id, checkout_url, _ = create_payment_preference(created, expires_at)
        save_payment_preference(created["id"], preference_id)
    except ValueError as error:
        try:
            cancel_unpaid_order(created["id"])
        except (RuntimeError, OSError):
            app.logger.exception("No se pudo liberar la reserva del pedido %s.", created["id"])
        return jsonify(error=str(error)), 409
    except (RuntimeError, OSError) as error:
        app.logger.exception("No se pudo crear el pago de Mercado Pago.")
        try:
            cancel_unpaid_order(created["id"])
        except (RuntimeError, OSError):
            app.logger.exception("No se pudo liberar la reserva del pedido %s.", created["id"])
        return jsonify(error=f"No se pudo preparar el pago: {error}"), 502

    return jsonify({
        **created,
        "payment_status": "pending",
        "checkout_url": checkout_url,
        "expires_at": expires_at.isoformat(),
    }), 201


@app.post("/api/payments/webhook")
def mercado_pago_webhook():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify(error="La notificación debe ser un objeto JSON."), 400
    data = body.get("data") if isinstance(body.get("data"), dict) else {}
    payment_id = str(data.get("id") or request.args.get("data.id") or "")
    event_type = body.get("type") or request.args.get("type")
    if event_type != "payment" or not payment_id:
        return jsonify(status="ignored")
    if not payment_id.isdigit():
        return jsonify(error="Identificador de pago inválido."), 400
    if not verify_mercado_pago_signature(payment_id):
        return jsonify(error="Firma de notificación inválida."), 401
    if not DATABASE_URL:
        return jsonify(error="El seguimiento de pagos requiere PostgreSQL."), 503

    try:
        expire_pending_orders()
        payment = mercado_pago_api(f"/v1/payments/{payment_id}")
        if not isinstance(payment, dict):
            raise ValueError("Mercado Pago devolvió una respuesta de pago inválida.")
        payment["id"] = payment_id
        payment_status, order_id, verified_payment_id = update_payment_from_provider(payment)
        if payment_status == "refund_required":
            mercado_pago_api(
                f"/v1/payments/{verified_payment_id}/refunds",
                payload={},
                idempotency_key=f"ajse-refund-{verified_payment_id}",
            )
            mark_payment_refunded(order_id, verified_payment_id)
            if order_id:
                app.logger.warning("Se reembolsó el pago aprobado no conciliado del pedido %s.", order_id)
            else:
                app.logger.warning("Se reembolsó un pago aprobado sin referencia de pedido AJSE.")
            return jsonify(status="refunded")
    except (RuntimeError, ValueError, OSError):
        app.logger.exception("No se pudo verificar la notificación de Mercado Pago.")
        return jsonify(error="No se pudo verificar el pago; se reintentará la notificación."), 502
    return jsonify(status=payment_status)


@app.get("/api/admin/orders")
def admin_orders():
    authorization_error = require_admin()
    if authorization_error:
        return authorization_error
    if not DATABASE_URL:
        return jsonify(error="El panel de pedidos requiere PostgreSQL."), 503
    expire_pending_orders()
    with postgres_connection() as connection:
        initialize_postgres(connection)
        rows = connection.execute(
            """
            SELECT
                r.id, r.client, r.email, r.note, r.total, r.status,
                r.payment_status, r.created_at, r.decided_at,
                COALESCE(
                    jsonb_agg(jsonb_build_object(
                        'product_id', i.product_id,
                        'name', i.name,
                        'quantity', i.quantity,
                        'unit_price', i.unit_price
                    ) ORDER BY i.id) FILTER (WHERE i.id IS NOT NULL),
                    '[]'::jsonb
                ) AS items
            FROM purchase_requests AS r
            LEFT JOIN purchase_request_items AS i ON i.request_id = r.id
            GROUP BY r.id
            ORDER BY r.created_at DESC
            """
        ).fetchall()
    return jsonify([
        {
            **row,
            "created_at": row["created_at"].isoformat(),
            **(
                {"decided_at": row["decided_at"].isoformat()}
                if row["decided_at"] is not None
                else {}
            ),
        }
        for row in rows
    ])


@app.get("/health")
@app.get("/api/health")
def health():
    return jsonify(
        status="ok",
        service="AJSE Hardware",
        payments_enabled=checkout_is_enabled(),
    )


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "5000")), debug=False)
