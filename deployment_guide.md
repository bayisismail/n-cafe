# N Cafe - Deployment & Implementation Guide

This guide provides instructions to run the **N Cafe** application locally (on your PC or Raspberry Pi) using SQLite, or in the cloud (such as on Render) using PostgreSQL.

---

## 💻 Part 1: Local Deployment (PC, Mac, or Raspberry Pi)

Follow these steps to run the N Cafe application on your local computer or on a local server like a Raspberry Pi.

### Step 1: Install Node.js
If you don't have Node.js installed, download it from [nodejs.org](https://nodejs.org) or install it via your system terminal:
* **Ubuntu/Raspberry Pi OS**:
  ```bash
  sudo apt update
  sudo apt install nodejs npm -y
  ```

### Step 2: Unzip Project Files
Extract the contents of `n-cafe-project.zip` into a directory (e.g., `C:\nilgiri-canteen` or `/home/pi/nilgiri-canteen`).

### Step 3: Install Dependencies
Open your command prompt or terminal in the project directory and run:
```bash
npm install
```
This will automatically install the necessary packages (`express`, `cors`, `helmet`, `jsonwebtoken`, `bcryptjs`, `sqlite3`, `pg`, `razorpay`).

### Step 4: Launch the Server
Start the production server:
```bash
node server.js
```
The server will start up and output:
```text
Connected to SQLite database at: .../n_cafe.db
========================================================
🚀 N Cafe Production Server launched at: http://localhost:8000
🔒 Secure SSL/HTTPS and API endpoints fully operational.
========================================================
```
* **Local Access**: Open `http://localhost:8000` in your web browser.
* **Network Access**: Access the site from any device on your local Wi-Fi network using the hosting computer's IP address (e.g., `http://192.168.1.100:8000`).

---

## ☁️ Part 2: Cloud Deployment (Render & PostgreSQL)

To host N Cafe online for real customer ordering and payment gateways, you can deploy it to **Render** using a free cloud PostgreSQL database (such as Neon.tech or Supabase).

### Step 1: Create a PostgreSQL Database
1. Set up a free PostgreSQL database on [Neon.tech](https://neon.tech) or [Supabase](https://supabase.com).
2. Copy the database connection string. It will look like:
   `postgresql://username:password@hostname/databasename?sslmode=require`

### Step 3: Create a Web Service on Render
1. Push your project files to a private/public **GitHub repository**.
2. Log in to [Render](https://render.com) and click **New > Web Service**.
3. Link your GitHub repository.
4. Set the following configuration details:
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
5. Click **Advanced** and add the following **Environment Variables**:
   - `MONGODB_URI`: Paste your MongoDB Atlas connection string
     (`mongodb+srv://...`).
   - `MONGODB_DATABASE`: `n_cafe` (or your chosen database name).
   - `JWT_SECRET`: At least 32 random characters used to sign secure tokens.
   - `ADMIN_PASSWORD`: A strong administrator password.
   - `OPERATOR_PIN`: A 4-digit operator PIN.
   - `ALLOWED_ORIGIN`: Your deployed HTTPS URL, for example `https://n-cafe.onrender.com`.

   Do not leave these variables unset. Render does not load `.env.example`; either add
   them manually in the service's **Environment** tab, or create the service from the
   included `render.yaml` Blueprint. Generate `JWT_SECRET` with a password manager or
   Render's generated-value option, and never commit the values to Git.
6. Click **Deploy Web Service**. Render will build and start your application.

*When `MONGODB_URI` is set, the server automatically switches from SQLite to MongoDB,
initializes the required collections and indexes, and seeds default foods on startup.*

---

## 💳 Part 3: Razorpay Payment Gateway Integration

To process credit cards, cards, net banking, or UPI:
1. Log in to your [Razorpay Dashboard](https://dashboard.razorpay.com).
2. Navigate to **Account & Settings > API Keys** and generate new **Key ID** and **Key Secret** (you can start in Test Mode).
3. Access the **N Cafe Owner Admin Panel** (at `http://your-site.com/admin` or `/admin`).
4. Log in using the administrator password configured in the deployment environment.
5. Open **Part 4: Cash Ledger & Bank Settings** (Tab 4).
6. Scroll to **Razorpay Payment Gateway**, enter your **Key ID** and **Key Secret**, and click **Save**.

*If keys are saved, the customer ordering portal will automatically load the real Razorpay Checkout modal for order verification.*

---

## 💾 Part 4: Manual Backup & Database Restore

Under **Part 4: Cash Ledger & Bank Settings** (Tab 4) in the Admin Dashboard, you can find manual database snapshot utility buttons:
* **Backup JSON**: Downloads a complete, clean `.json` snapshot file containing your food items, raw materials, transaction logs, and bookings.
* **Restore JSON**: Uploads a backup snapshot file to replace current database tables. This makes it extremely easy to copy database states from your local PC to Render or back up data.
