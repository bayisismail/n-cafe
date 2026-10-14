# N Cafe - Modern Canteen Management System

A web application for canteen orders, POS transactions, barcode ticket validation,
inventory tracking, and UPI payments.

---

## How to Host on Render

N Cafe includes an Express server for authentication, bookings, payments, and database
access. Deploy it as a **Web Service**, not a Static Site.

### Step 1: Create a Web Service

1. Log in to [Render](https://render.com).
2. Click **New > Web Service**.
3. Connect GitHub and select the `n-cafe` repository.
4. Configure:
   - **Branch**: `main`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
5. Add these variables under **Environment** before deploying:
   - `JWT_SECRET`: at least 32 random characters.
   - `ADMIN_PASSWORD`: a strong administrator password.
   - `OPERATOR_PIN`: exactly four digits.
   - `ALLOWED_ORIGIN`: your Render HTTPS URL, such as `https://n-cafe.onrender.com`.
   - `DATABASE_URL`: your PostgreSQL connection string if using PostgreSQL.
6. Click **Create Web Service**.

Render does not load `.env.example` automatically. Enter these values in the service's
**Environment** settings, or create the service from the included `render.yaml`
Blueprint. Never commit real secret values to GitHub.

If deployment stops with `Missing required environment variable(s)`, add the named
variables under **Environment**, click **Save Changes**, and choose **Manual Deploy >
Deploy latest commit**.

## Understanding the Database

The server stores menus, orders, ledger transactions, and inventory in SQLite by default.
Set `DATABASE_URL` to use PostgreSQL in a hosted deployment. The local `.env` file is
ignored by Git.

## Local Development

```powershell
Copy-Item .env.example .env
# Replace the placeholder values in .env, then:
npm install
npm start
```

## Key Features

1. **Staff portal** for the operator scanner and admin panel.
2. **UPI payments** using standard `upi://pay` links and payment-app QR codes.
3. **CODE128 barcode scanner** containing a compact 20-character ticket ID.
4. **Automatic receipt printing** after a successful barcode redemption.
5. **Excel/CSV export** for ledger transactions and inventory logs.
