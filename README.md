# ☕ N Cafe - Modern Canteen Management System

A beautiful, premium, client-side web application for managing canteen orders, POS transactions, real-time ticket validation with barcodes, inventory tracking, and UPI payments.

---

## 🚀 How to Host on Render (Free Static Site)

Render is a cloud platform that allows hosting static web apps for free. Follow these steps to host **N Cafe** on Render:

### Step 1: Upload Files to GitHub
Render deploys apps directly from GitHub.
1. Create a free account on [GitHub](https://github.com).
2. Create a new repository (e.g., named `n-cafe`).
3. Upload the following files from your project folder to your repository:
   - `index.html`
   - `app.js`
   - `style.css`
   - `assets/` (folder containing image assets)
   - `README.md`

### Step 2: Create a Static Site on Render
1. Log in to [Render](https://render.com).
2. Click the **New** button in the dashboard and select **Static Site**.
3. Connect your GitHub account and select your `n-cafe` repository.
4. Configure the build settings:
   - **Name**: `n-cafe` (or any name you prefer)
   - **Branch**: `main` (or the branch where you uploaded your files)
   - **Build Command**: (Leave this field **completely blank**)
   - **Publish Directory**: `.` (enter a single dot representing the root folder)
5. Click **Create Static Site**.

Render will fetch the code and deploy it in seconds. You will receive a unique URL (e.g., `https://n-cafe.onrender.com`) to access your app from any browser on any phone, tablet, or PC!

---

## 💾 Understanding the Database (LocalStorage)

This application is built using a **serverless client-side architecture**:
- **Where is the data stored?** Data (menus, orders, ledger transactions, and raw materials inventory) is stored in the browser's `LocalStorage`.
- **Cross-Device Syncing**: Because it is stored in `LocalStorage`, the data is saved in the browser of the device you are using.
  - If you run the Customer Menu, POS Counter, and Scanner on the **same computer** (e.g., in different browser tabs), they will share the exact same database state.
  - If you load the site on different devices (e.g., a phone and a PC), each device will maintain its own local database.
- **Pi Deployment Sync**: If you want to run a shared server where you sync files and back up local databases to Google Drive, check the `/brain/deployment_guide.md` file in the project folder.

---

## 🔐 Credentials & Access

Credentials are never stored in this repository. Configure `JWT_SECRET`, `ADMIN_PASSWORD`,
and `OPERATOR_PIN` as deployment environment variables before the first server start.

---

## 🛠️ Key Application Features

1. **Staff Portal Gate**: Located in the footer, allowing access to the Operator Scanner and Admin Panel via passwords.
2. **UPI-Only Payments**: Custom payment flow generating standard `upi://pay` deep links.
3. **Mobile Intent Payment**: Clicking the payment button on mobile devices automatically redirects to UPI apps (GPay, PhonePe, Paytm).
4. **Live Barcode Scanner**: Captures customer ticket CODE128 barcodes containing a compact 20-character ticket ID, validating status and auto-compiling receipts. UPI payment screens continue to use standard QR codes for app compatibility.
5. **Excel/CSV Export**: Custom column selector modal allows you to choose columns before exporting ledger transactions and raw material inventory logs.
