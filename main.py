from pathlib import Path
import sqlite3
from datetime import datetime
from typing import List

from fastapi import FastAPI, HTTPException, Request, Form
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, EmailStr, condecimal, conint


BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "erp.db"


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    cur = conn.cursor()

    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            sku TEXT UNIQUE NOT NULL,
            price REAL NOT NULL,
            stock INTEGER NOT NULL DEFAULT 0
        )
        """
    )

    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS customers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL
        )
        """
    )

    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_id INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (customer_id) REFERENCES customers(id)
        )
        """
    )

    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS order_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER NOT NULL,
            product_id INTEGER NOT NULL,
            quantity INTEGER NOT NULL,
            unit_price REAL NOT NULL,
            FOREIGN KEY (order_id) REFERENCES orders(id),
            FOREIGN KEY (product_id) REFERENCES products(id)
        )
        """
    )

    conn.commit()
    conn.close()


class ProductCreate(BaseModel):
    name: str
    sku: str
    price: condecimal(gt=0)
    stock: conint(ge=0) = 0


class Product(ProductCreate):
    id: int


class CustomerCreate(BaseModel):
    name: str
    email: EmailStr


class Customer(CustomerCreate):
    id: int


class OrderItemCreate(BaseModel):
    product_id: int
    quantity: conint(gt=0)


class OrderCreate(BaseModel):
    customer_id: int
    items: List[OrderItemCreate]


class OrderItem(BaseModel):
    id: int
    product_id: int
    quantity: int
    unit_price: float


class Order(BaseModel):
    id: int
    customer_id: int
    created_at: str
    items: List[OrderItem]


app = FastAPI(title="Mini ERP")

templates_dir = BASE_DIR / "templates"
static_dir = BASE_DIR / "static"

templates = Jinja2Templates(directory=str(templates_dir))
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


@app.on_event("startup")
def on_startup():
    templates_dir.mkdir(exist_ok=True)
    static_dir.mkdir(exist_ok=True)
    init_db()


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT * FROM products ORDER BY id DESC")
    products = cur.fetchall()
    cur.execute("SELECT * FROM customers ORDER BY id DESC")
    customers = cur.fetchall()
    cur.execute(
        """
        SELECT o.id, o.created_at, c.name AS customer_name,
               SUM(oi.quantity * oi.unit_price) AS total
        FROM orders o
        JOIN customers c ON c.id = o.customer_id
        LEFT JOIN order_items oi ON oi.order_id = o.id
        GROUP BY o.id, o.created_at, c.name
        ORDER BY o.id DESC
        """
    )
    orders = cur.fetchall()
    conn.close()
    return templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "products": products,
            "customers": customers,
            "orders": orders,
        },
    )


@app.post("/products", response_model=Product)
def create_product(product: ProductCreate):
    conn = get_db()
    cur = conn.cursor()
    try:
        cur.execute(
            "INSERT INTO products (name, sku, price, stock) VALUES (?, ?, ?, ?)",
            (product.name, product.sku, float(product.price), int(product.stock)),
        )
        conn.commit()
        product_id = cur.lastrowid
    except sqlite3.IntegrityError as e:
        conn.close()
        raise HTTPException(status_code=400, detail=str(e))
    cur.execute("SELECT * FROM products WHERE id = ?", (product_id,))
    row = cur.fetchone()
    conn.close()
    return Product(**row)


@app.get("/products", response_model=List[Product])
def list_products():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT * FROM products ORDER BY id DESC")
    rows = cur.fetchall()
    conn.close()
    return [Product(**row) for row in rows]


@app.post("/customers", response_model=Customer)
def create_customer(customer: CustomerCreate):
    conn = get_db()
    cur = conn.cursor()
    try:
        cur.execute(
            "INSERT INTO customers (name, email) VALUES (?, ?)",
            (customer.name, customer.email),
        )
        conn.commit()
        customer_id = cur.lastrowid
    except sqlite3.IntegrityError as e:
        conn.close()
        raise HTTPException(status_code=400, detail=str(e))
    cur.execute("SELECT * FROM customers WHERE id = ?", (customer_id,))
    row = cur.fetchone()
    conn.close()
    return Customer(**row)


@app.get("/customers", response_model=List[Customer])
def list_customers():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT * FROM customers ORDER BY id DESC")
    rows = cur.fetchall()
    conn.close()
    return [Customer(**row) for row in rows]


@app.post("/orders", response_model=Order)
def create_order(order: OrderCreate):
    conn = get_db()
    cur = conn.cursor()

    cur.execute("SELECT id FROM customers WHERE id = ?", (order.customer_id,))
    if not cur.fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="Customer not found")

    for item in order.items:
        cur.execute("SELECT id, price, stock FROM products WHERE id = ?", (item.product_id,))
        row = cur.fetchone()
        if not row:
            conn.close()
            raise HTTPException(status_code=404, detail=f"Product {item.product_id} not found")
        if row["stock"] < item.quantity:
            conn.close()
            raise HTTPException(
                status_code=400,
                detail=f"Not enough stock for product {item.product_id}",
            )

    now = datetime.utcnow().isoformat()
    cur.execute(
        "INSERT INTO orders (customer_id, created_at) VALUES (?, ?)",
        (order.customer_id, now),
    )
    order_id = cur.lastrowid

    for item in order.items:
        cur.execute("SELECT price, stock FROM products WHERE id = ?", (item.product_id,))
        row = cur.fetchone()
        unit_price = row["price"]
        new_stock = row["stock"] - item.quantity
        cur.execute(
            """
            INSERT INTO order_items (order_id, product_id, quantity, unit_price)
            VALUES (?, ?, ?, ?)
            """,
            (order_id, item.product_id, item.quantity, unit_price),
        )
        cur.execute(
            "UPDATE products SET stock = ? WHERE id = ?",
            (new_stock, item.product_id),
        )

    conn.commit()

    cur.execute("SELECT * FROM orders WHERE id = ?", (order_id,))
    order_row = cur.fetchone()
    cur.execute("SELECT * FROM order_items WHERE order_id = ?", (order_id,))
    item_rows = cur.fetchall()
    conn.close()

    items = [
        OrderItem(
            id=ir["id"],
            product_id=ir["product_id"],
            quantity=ir["quantity"],
            unit_price=ir["unit_price"],
        )
        for ir in item_rows
    ]
    return Order(
        id=order_row["id"],
        customer_id=order_row["customer_id"],
        created_at=order_row["created_at"],
        items=items,
    )


@app.get("/orders", response_model=List[Order])
def list_orders():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT * FROM orders ORDER BY id DESC")
    orders_rows = cur.fetchall()

    orders: List[Order] = []
    for o in orders_rows:
        cur.execute("SELECT * FROM order_items WHERE order_id = ?", (o["id"],))
        item_rows = cur.fetchall()
        items = [
            OrderItem(
                id=ir["id"],
                product_id=ir["product_id"],
                quantity=ir["quantity"],
                unit_price=ir["unit_price"],
            )
            for ir in item_rows
        ]
        orders.append(
            Order(
                id=o["id"],
                customer_id=o["customer_id"],
                created_at=o["created_at"],
                items=items,
            )
        )

    conn.close()
    return orders


@app.post("/quick-add/product", response_class=HTMLResponse)
def quick_add_product(
    request: Request,
    name: str = Form(...),
    sku: str = Form(...),
    price: float = Form(...),
    stock: int = Form(0),
):
    create_product(ProductCreate(name=name, sku=sku, price=price, stock=stock))
    return index(request)


@app.post("/quick-add/customer", response_class=HTMLResponse)
def quick_add_customer(
    request: Request,
    name: str = Form(...),
    email: str = Form(...),
):
    create_customer(CustomerCreate(name=name, email=email))
    return index(request)


@app.post("/quick-add/order", response_class=HTMLResponse)
def quick_add_order(
    request: Request,
    customer_id: int = Form(...),
    product_id: int = Form(...),
    quantity: int = Form(...),
):
    create_order(
        OrderCreate(
            customer_id=customer_id,
            items=[OrderItemCreate(product_id=product_id, quantity=quantity)],
        )
    )
    return index(request)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
