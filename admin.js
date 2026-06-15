// N Cafe Admin Dashboard Controller

const AdminState = {
  token: null,
  foodItems: [],
  ingredients: [],
  transactions: [],
  bookings: [],
  posCart: [],
  posBillingData: null,
  accountDetails: {
    name: 'N Cafe Hills Kitchen Services',
    bank: 'State Bank of India',
    accNo: '39485710293',
    ifsc: 'SBIN0008472',
    upiId: 'ncafe.canteen@okaxis'
  },

  async init() {
    this.token = localStorage.getItem('admin_token');
    if (!this.token) {
      this.showLoginGate();
      return;
    }

    const verified = await this.verifySession();
    if (!verified) {
      this.logout();
      return;
    }

    this.hideLoginGate();
    this.setupEventListeners();
    await this.loadAllData();
    this.startAutoPoller();
  },

  showLoginGate() {
    document.getElementById('admin-login-gate').classList.add('active');
    document.getElementById('admin-dashboard-container').style.display = 'none';
  },

  hideLoginGate() {
    document.getElementById('admin-login-gate').classList.remove('active');
    document.getElementById('admin-dashboard-container').style.display = 'block';
  },

  async verifySession() {
    try {
      const res = await fetch('/api/bookings', {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      return res.ok;
    } catch (e) {
      console.error("Session verification failed", e);
      return false;
    }
  },

  logout() {
    localStorage.removeItem('admin_token');
    this.token = null;
    this.showLoginGate();
    if (this.pollerInterval) {
      clearInterval(this.pollerInterval);
    }
  },

  async fetchWithAuth(url, options = {}) {
    options.headers = options.headers || {};
    options.headers['Authorization'] = `Bearer ${this.token}`;
    if (options.body && !(options.body instanceof FormData)) {
      options.headers['Content-Type'] = 'application/json';
    }
    
    const res = await fetch(url, options);
    if (res.status === 401 || res.status === 403) {
      alert("Session expired. Please log in again.");
      this.logout();
      throw new Error("Unauthorized");
    }
    return res;
  },

  async loadAllData() {
    try {
      await Promise.all([
        this.fetchFoodItems(),
        this.fetchIngredients(),
        this.fetchTransactions(),
        this.fetchBookings(),
        this.fetchAccountDetails()
      ]);
      
      this.renderTab(1);
    } catch (e) {
      console.error("Failed to load initial data", e);
    }
  },

  async fetchFoodItems() {
    const res = await fetch('/api/food-items');
    if (res.ok) {
      this.foodItems = await res.json();
    }
  },

  async fetchIngredients() {
    const res = await this.fetchWithAuth('/api/ingredients');
    if (res.ok) {
      this.ingredients = await res.json();
    }
  },

  async fetchTransactions() {
    const res = await this.fetchWithAuth('/api/ledger');
    if (res.ok) {
      this.transactions = await res.json();
    }
  },

  async fetchBookings() {
    const res = await this.fetchWithAuth('/api/bookings');
    if (res.ok) {
      this.bookings = await res.json();
    }
  },

  async fetchAccountDetails() {
    const res = await fetch('/api/settings');
    if (res.ok) {
      this.accountDetails = await res.json();
    }
  },

  startAutoPoller() {
    // Poll every 1 second to satisfy real-time mobile order detection requirement
    this.pollerInterval = setInterval(async () => {
      if (!this.token) return;
      try {
        await this.fetchBookings();
        await this.fetchTransactions();
        
        // Quietly update reports / dashboard without clearing active UI states
        this.updateDashboardMetricsOnly();
        this.updateSalesReportTable();
      } catch (e) {
        console.warn("Auto-poller failed:", e);
      }
    }, 1000);
  },

  updateDashboardMetricsOnly() {
    const redeemed = this.bookings.filter(b => b.status === 'redeemed');
    const sales = redeemed.reduce((sum, b) => sum + b.totalAmount, 0);
    const expenses = this.transactions.filter(t => t.type === 'purchase' || t.type === 'expense').reduce((sum, t) => sum + t.amount, 0);
    const profit = sales - expenses;

    const salesVal = document.getElementById('tab1-sales-val');
    const expensesVal = document.getElementById('tab1-expenses-val');
    const profitVal = document.getElementById('tab1-profit-val');

    if (salesVal) salesVal.innerText = `₹${sales}`;
    if (expensesVal) expensesVal.innerText = `₹${expenses}`;
    if (profitVal) {
      profitVal.innerText = `₹${profit}`;
      profitVal.className = 'admin-card-val ' + (profit >= 0 ? 'income' : 'expense');
    }

    // Update count metrics
    const totalBilledCount = this.bookings.length;
    const scannedCount = this.bookings.filter(b => b.status === 'redeemed').length;
    const pendingCount = this.bookings.filter(b => b.status === 'pending').length;

    const totalBilledEl = document.getElementById('tab1-total-billed-count');
    const scannedEl = document.getElementById('tab1-scanned-count');
    const pendingEl = document.getElementById('tab1-pending-count');

    if (totalBilledEl) totalBilledEl.innerText = totalBilledCount;
    if (scannedEl) scannedEl.innerText = scannedCount;
    if (pendingEl) pendingEl.innerText = pendingCount;

    // Update stock alerts
    const warningsList = document.getElementById('dashboard-stock-alerts-new');
    if (warningsList) {
      warningsList.innerHTML = '';
      let hasWarnings = false;
      this.foodItems.forEach(f => {
        if (f.stock <= 5) {
          hasWarnings = true;
          const box = document.createElement('div');
          box.className = 'alert-box';
          box.innerHTML = `
            <i class="fas fa-exclamation-triangle"></i>
            <div>
              <strong>Stock Low: ${f.name}</strong><br>
              <span style="font-size:0.75rem;">Only ${f.stock} portions left in canteen kitchen.</span>
            </div>
          `;
          warningsList.appendChild(box);
        }
      });
      if (!hasWarnings) {
        warningsList.innerHTML = `<div style="text-align:center; color: var(--text-muted); font-size:0.8rem; padding:1rem;">All food items are well stocked today.</div>`;
      }
    }
  },

  updateSalesReportTable() {
    const tbody = document.getElementById('tab2-foodbusiness-tbody');
    if (!tbody) return;

    const filterItem = document.getElementById('report-filter-item').value;
    const filterDate = document.getElementById('report-filter-date').value;
    const filterAmt = parseFloat(document.getElementById('report-filter-amount').value) || 0;

    let filtered = [...this.bookings];

    if (filterItem !== 'All') {
      filtered = filtered.filter(b => b.items.some(i => i.foodItemId === filterItem));
    }
    if (filterDate) {
      filtered = filtered.filter(b => b.bookingTime.startsWith(filterDate));
    }
    if (filterAmt > 0) {
      filtered = filtered.filter(b => b.totalAmount >= filterAmt);
    }

    tbody.innerHTML = '';
    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">No sales record matches filters.</td></tr>`;
      return;
    }

    filtered.forEach(b => {
      const tr = document.createElement('tr');
      const timeStr = new Date(b.bookingTime).toLocaleString();
      const itemsList = b.items.map(i => `${i.name} (${i.quantity})`).join(', ');
      const statusBadge = b.status === 'redeemed' 
        ? `<span class="badge badge-success">Redeemed</span>` 
        : (b.status === 'expired' ? `<span class="badge badge-danger">Expired</span>` : `<span class="badge badge-warning">Pending</span>`);

      tr.innerHTML = `
        <td>
          <strong>${b.customerName}</strong><br>
          <span style="font-size:0.75rem; color:var(--text-muted);">${b.customerPhone}</span>
        </td>
        <td style="font-size:0.8rem;">${timeStr}</td>
        <td style="font-size:0.8rem; max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${itemsList}">${itemsList}</td>
        <td><strong>₹${b.totalAmount}</strong></td>
        <td>${statusBadge}</td>
      `;
      tbody.appendChild(tr);
    });
  },

  setupEventListeners() {
    // Logout button
    document.getElementById('btn-admin-logout').addEventListener('click', () => {
      this.logout();
      window.location.href = '/';
    });

    // Admin Tab Navigation Buttons
    const tabs = [1, 2, 3, 4, 5];
    tabs.forEach(tNum => {
      const btn = document.getElementById(`btn-admin-tab-${tNum}`);
      if (btn) {
        btn.addEventListener('click', () => this.renderTab(tNum));
      }
    });

    // POS Clear Cart button
    const posClearBtn = document.getElementById('btn-pos-clear-cart');
    if (posClearBtn) {
      posClearBtn.addEventListener('click', () => {
        this.posCart = [];
        this.renderPOSCart();
        const form = document.getElementById('pos-billing-form');
        if (form) form.reset();
      });
    }

    // POS Billing Form Submit - Intercept to show Payment selector modal
    document.getElementById('pos-billing-form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (this.posCart.length === 0) return;

      const name = document.getElementById('pos-cust-name').value.trim() || 'Walk-in Guest';
      const phone = document.getElementById('pos-cust-phone').value.trim() || 'N/A';

      const bookingId = 'NC-' + Math.floor(100000 + Math.random() * 900000).toString();
      const grandTotal = this.posCart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
      const tax = Math.round(grandTotal * 0.05);
      const totalAmount = grandTotal + tax;

      const items = this.posCart.map(item => ({
        foodItemId: item.id,
        name: item.name,
        quantity: item.quantity,
        price: item.price
      }));

      // Store billing data for modal selection callback
      this.posBillingData = {
        id: bookingId,
        customerName: name,
        customerPhone: phone,
        passkey: '0000',
        items,
        totalAmount,
        lockId: null
      };

      // Populate modal particulars and show it
      document.getElementById('pos-modal-amount').innerText = `₹${totalAmount}`;
      document.getElementById('pos-payment-selector').style.display = 'block';
      document.getElementById('pos-payment-upi-screen').style.display = 'none';

      const modal = document.getElementById('pos-payment-modal');
      modal.style.display = 'flex';
      modal.classList.add('active');
    });

    // Modal Button - Cash Payment
    document.getElementById('btn-pos-pay-cash').addEventListener('click', () => {
      this.finalizePOSBooking('Cash (Counter)');
    });

    // Modal Button - UPI QR Selector
    document.getElementById('btn-pos-pay-upi').addEventListener('click', () => {
      if (!this.posBillingData) return;
      
      const payeeName = this.accountDetails.name || 'N Cafe';
      const upiId = this.accountDetails.upiId || 'ncafe.canteen@okaxis';
      const totalAmount = this.posBillingData.totalAmount;

      document.getElementById('pos-modal-payee').innerText = payeeName;
      document.getElementById('pos-modal-vpa').innerText = upiId;

      // Build standard UPI deep-link URI
      const upiLink = `upi://pay?pa=${upiId}&pn=${encodeURIComponent(payeeName)}&am=${totalAmount}&cu=INR&tn=${encodeURIComponent('N-Cafe-POS-Bill')}`;

      // Render UPI QR canvas
      const canvas = document.getElementById('pos-upi-qr-canvas');
      if (canvas) {
        new QRious({
          element: canvas,
          value: upiLink,
          size: 200,
          background: '#ffffff',
          foreground: '#1b4d3e'
        });
      }

      // Transition screens
      document.getElementById('pos-payment-selector').style.display = 'none';
      document.getElementById('pos-payment-upi-screen').style.display = 'block';
    });

    // Modal Button - UPI Back Button
    document.getElementById('btn-pos-upi-back').addEventListener('click', () => {
      document.getElementById('pos-payment-upi-screen').style.display = 'none';
      document.getElementById('pos-payment-selector').style.display = 'block';
    });

    // Modal Button - Confirm UPI Payment Received
    document.getElementById('btn-pos-upi-confirm').addEventListener('click', () => {
      this.finalizePOSBooking('UPI QR (Counter)');
    });

    // Modal Button - Cancel Modal
    document.getElementById('btn-pos-payment-cancel').addEventListener('click', () => {
      const modal = document.getElementById('pos-payment-modal');
      modal.style.display = 'none';
      modal.classList.remove('active');
      this.posBillingData = null;
    });

    // Part 2 Form: Add Food Item
    document.getElementById('tab2-add-food-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('tab2-add-name').value.trim();
      const price = parseFloat(document.getElementById('tab2-add-price').value);
      const stock = parseInt(document.getElementById('tab2-add-stock').value, 10);
      const category = document.getElementById('tab2-add-category').value;
      const isveg = document.getElementById('tab2-add-isveg').value;
      const imagePath = document.getElementById('tab2-add-image').value;
      const desc = document.getElementById('tab2-add-desc').value.trim();

      let maxNum = 100;
      this.foodItems.forEach(f => {
        const num = parseInt(f.id.replace('FD-', ''), 10);
        if (!isNaN(num) && num > maxNum) {
          maxNum = num;
        }
      });
      const newId = 'FD-' + (maxNum + 1).toString();
      const payload = {
        id: newId,
        name,
        price,
        stock,
        category,
        isveg,
        image: imagePath,
        details: desc
      };

      try {
        const res = await this.fetchWithAuth('/api/food-items', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        if (res.ok) {
          e.target.reset();
          await this.fetchFoodItems();
          this.renderTab(2);
          alert("New food item added successfully!");
        } else {
          const errData = await res.json();
          alert(`Error: ${errData.error}`);
        }
      } catch (err) {
        console.error(err);
      }
    });

    // Report filters change
    document.getElementById('report-filter-item').addEventListener('change', () => this.updateSalesReportTable());
    document.getElementById('report-filter-date').addEventListener('change', () => this.updateSalesReportTable());
    document.getElementById('report-filter-amount').addEventListener('input', () => this.updateSalesReportTable());

    // Part 3 Form: Log Purchase
    document.getElementById('tab1-purchase-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const ingId = document.getElementById('tab1-pur-ing-id').value;
      const qty = parseFloat(document.getElementById('tab1-pur-qty').value);
      const cost = parseFloat(document.getElementById('tab1-pur-cost').value);

      if (!ingId) return alert("Select an ingredient first.");

      const ing = this.ingredients.find(i => i.id === ingId);
      if (!ing) return;

      const newStock = ing.stock + qty;

      try {
        // Update ingredient stock
        const resIng = await this.fetchWithAuth(`/api/ingredients/${ingId}`, {
          method: 'PUT',
          body: JSON.stringify({ name: ing.name, stock: newStock, unit: ing.unit })
        });

        if (resIng.ok) {
          // Add ledger transaction
          await this.fetchWithAuth('/api/ledger', {
            method: 'POST',
            body: JSON.stringify({
              type: 'purchase',
              title: `Restocked - ${ing.name}`,
              amount: cost,
              details: `Added ${qty} ${ing.unit}`
            })
          });

          e.target.reset();
          await this.fetchIngredients();
          await this.fetchTransactions();
          this.renderTab(3);
          alert("Purchase log saved successfully!");
        } else {
          alert("Failed to update ingredient stock.");
        }
      } catch (err) {
        console.error(err);
      }
    });

    // Part 3 Form: Log Usage
    document.getElementById('tab1-usage-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const ingId = document.getElementById('tab1-use-ing-id').value;
      const qty = parseFloat(document.getElementById('tab1-use-qty').value);

      if (!ingId) return alert("Select an ingredient first.");

      const ing = this.ingredients.find(i => i.id === ingId);
      if (!ing) return;

      if (ing.stock < qty) {
        return alert(`Deficit! Only ${ing.stock} ${ing.unit} available in storage.`);
      }

      const newStock = ing.stock - qty;

      try {
        // Update ingredient stock
        const resIng = await this.fetchWithAuth(`/api/ingredients/${ingId}`, {
          method: 'PUT',
          body: JSON.stringify({ name: ing.name, stock: newStock, unit: ing.unit })
        });

        if (resIng.ok) {
          // Add ledger transaction with 0 cost
          await this.fetchWithAuth('/api/ledger', {
            method: 'POST',
            body: JSON.stringify({
              type: 'expense',
              title: `Used in Kitchen - ${ing.name}`,
              amount: 0,
              details: `Used ${qty} ${ing.unit}`
            })
          });

          e.target.reset();
          await this.fetchIngredients();
          await this.fetchTransactions();
          this.renderTab(3);
          alert("Kitchen usage logged successfully!");
        } else {
          alert("Failed to update ingredient stock.");
        }
      } catch (err) {
        console.error(err);
      }
    });

    // Part 3 Form: Register New Material
    const addIngForm = document.getElementById('tab1-add-ing-form');
    if (addIngForm) {
      addIngForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = document.getElementById('tab1-add-ing-name').value.trim();
        const unit = document.getElementById('tab1-add-ing-unit').value;
        const stock = parseFloat(document.getElementById('tab1-add-ing-stock').value) || 0;

        // Auto-generate ingredient ID
        let maxNum = 100;
        this.ingredients.forEach(i => {
          const num = parseInt(i.id.replace('ING-', ''), 10);
          if (!isNaN(num) && num > maxNum) {
            maxNum = num;
          }
        });
        const newId = 'ING-' + (maxNum + 1).toString().padStart(3, '0');

        const payload = {
          id: newId,
          name,
          stock,
          unit
        };

        try {
          const res = await this.fetchWithAuth('/api/ingredients', {
            method: 'POST',
            body: JSON.stringify(payload)
          });
          if (res.ok) {
            e.target.reset();
            await this.fetchIngredients();
            this.renderTab(3);
            alert("New material registered successfully!");
          } else {
            const errData = await res.json();
            alert(`Error: ${errData.error}`);
          }
        } catch (err) {
          console.error(err);
        }
      });
    }

    // Download CSV buttons
    document.getElementById('btn-export-inventory').addEventListener('click', () => this.exportInventoryCSV());
    document.getElementById('btn-export-ledger').addEventListener('click', () => this.exportLedgerCSV());

    // Account settings Form
    document.getElementById('tab3-account-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('acc-name-input').value.trim();
      const upiId = document.getElementById('acc-upi-input').value.trim();
      const bank = document.getElementById('acc-bank-input').value.trim();
      const accNo = document.getElementById('acc-no-input').value.trim();
      const ifsc = document.getElementById('acc-ifsc-input').value.trim();

      const payload = { name, upiId, bank, accNo, ifsc };

      try {
        const res = await this.fetchWithAuth('/api/settings', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        if (res.ok) {
          await this.fetchAccountDetails();
          alert("Account profile saved successfully!");
        } else {
          alert("Failed to save settings.");
        }
      } catch (err) {
        console.error(err);
      }
    });

    // Credentials toggle and Form
    document.getElementById('btn-toggle-credentials').addEventListener('click', () => {
      const form = document.getElementById('tab4-credentials-form');
      const chevron = document.getElementById('credentials-chevron');
      if (form.style.display === 'none') {
        form.style.display = 'block';
        chevron.style.transform = 'rotate(180deg)';
      } else {
        form.style.display = 'none';
        chevron.style.transform = 'rotate(0deg)';
      }
    });

    document.getElementById('tab4-credentials-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const currentPassword = document.getElementById('cred-current-pwd').value;
      const password = document.getElementById('cred-admin-pwd').value.trim();
      const pin = document.getElementById('cred-scanner-pin').value.trim();

      try {
        const res = await this.fetchWithAuth('/api/auth/change-credentials', {
          method: 'POST',
          body: JSON.stringify({ currentPassword, password, pin })
        });
        if (res.ok) {
          e.target.reset();
          document.getElementById('tab4-credentials-form').style.display = 'none';
          document.getElementById('credentials-chevron').style.transform = 'rotate(0deg)';
          alert("Admin credentials and scanner PIN successfully updated!");
        } else {
          const errData = await res.json();
          alert(`Failed to update credentials: ${errData.error}`);
        }
      } catch (err) {
        console.error(err);
      }
    });

    // Razorpay toggle and Form Submit
    const toggleRzpBtn = document.getElementById('btn-toggle-razorpay');
    if (toggleRzpBtn) {
      toggleRzpBtn.addEventListener('click', () => {
        const form = document.getElementById('tab4-razorpay-form');
        const chevron = document.getElementById('razorpay-chevron');
        if (form.style.display === 'none') {
          form.style.display = 'block';
          chevron.style.transform = 'rotate(180deg)';
        } else {
          form.style.display = 'none';
          chevron.style.transform = 'rotate(0deg)';
        }
      });
    }

    const rzpForm = document.getElementById('tab4-razorpay-form');
    if (rzpForm) {
      rzpForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const keyId = document.getElementById('rzp-key-id').value.trim();
        const keySecret = document.getElementById('rzp-key-secret').value.trim();

        try {
          const res = await this.fetchWithAuth('/api/settings/razorpay', {
            method: 'POST',
            body: JSON.stringify({ keyId, keySecret })
          });
          if (res.ok) {
            document.getElementById('rzp-key-secret').value = '';
            document.getElementById('tab4-razorpay-form').style.display = 'none';
            document.getElementById('razorpay-chevron').style.transform = 'rotate(0deg)';
            alert("Razorpay API credentials successfully updated!");
            
            // Reload Tab 4 to prefill values
            this.renderTab(4);
          } else {
            const errData = await res.json();
            alert(`Failed to save credentials: ${errData.error}`);
          }
        } catch (err) {
          console.error(err);
        }
      });
    }

    // Manual backup JSON
    document.getElementById('btn-backup-db').addEventListener('click', async () => {
      try {
        const res = await this.fetchWithAuth('/api/backup/export');
        if (res.ok) {
          const backupData = await res.json();
          const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = `n_cafe_backup_${new Date().toISOString().slice(0,10)}.json`;
          link.click();
        }
      } catch (err) {
        console.error(err);
      }
    });

    // Manual restore JSON
    document.getElementById('restore-db-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async (event) => {
        try {
          const backupObj = JSON.parse(event.target.result);
          const confirmRestore = confirm("Are you sure you want to restore? This will overwrite your current SQLite tables.");
          if (!confirmRestore) return;

          const res = await this.fetchWithAuth('/api/backup/restore', {
            method: 'POST',
            body: JSON.stringify(backupObj)
          });

          if (res.ok) {
            alert("Database snapshot restored successfully!");
            window.location.reload();
          } else {
            const errData = await res.json();
            alert(`Restore failed: ${errData.error}`);
          }
        } catch (err) {
          alert("Invalid JSON file format.");
        }
      };
      reader.readAsText(file);
    });

    // Ledger select all checkbox
    const selectAllCb = document.getElementById('ledger-select-all');
    if (selectAllCb) {
      selectAllCb.addEventListener('change', (e) => {
        const checked = e.target.checked;
        document.querySelectorAll('.ledger-row-cb').forEach(cb => {
          cb.checked = checked;
        });
      });
    }
  },

  async finalizePOSBooking(paymentMethod) {
    if (!this.posBillingData) return;
    
    const payload = {
      ...this.posBillingData,
      paymentMethod
    };

    // Close Modal
    const modal = document.getElementById('pos-payment-modal');
    modal.style.display = 'none';
    modal.classList.remove('active');

    try {
      // Post the booking
      const res = await fetch('/api/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        // Immediately redeem it since it's a walk-in billing
        await this.fetchWithAuth('/api/bookings/redeem', {
          method: 'POST',
          body: JSON.stringify({ id: payload.id })
        });

        // Fetch the full redeemed booking info to download the receipt
        const bookingsRes = await this.fetchWithAuth('/api/bookings');
        if (bookingsRes.ok) {
          const allBookings = await bookingsRes.json();
          const matching = allBookings.find(b => b.id === payload.id);
          if (matching) {
            downloadReceipt(matching);
          }
        }

        // Reset cart & form
        this.posCart = [];
        this.renderPOSCart();
        document.getElementById('pos-billing-form').reset();
        
        // Reload
        await this.fetchFoodItems();
        await this.fetchBookings();
        await this.fetchTransactions();
        this.renderTab(5); // Render POS Canteen Counter tab
        
        alert(`POS counter invoice created via ${paymentMethod}! Token: ${payload.id}. Receipt automatically downloaded.`);
      } else {
        const errData = await res.json();
        alert(`Checkout failed: ${errData.error || 'Server error'}`);
      }
    } catch (err) {
      console.error("POS transaction failed:", err);
      alert("Communication error finalizing POS booking.");
    } finally {
      this.posBillingData = null;
    }
  },

  renderTab(tNum) {
    // Toggle active tab buttons
    document.querySelectorAll('.admin-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.id === `btn-admin-tab-${tNum}`);
    });

    // Toggle active tab panes
    document.querySelectorAll('.admin-tab-content').forEach(pane => {
      pane.style.display = pane.id === `admin-tab-${tNum}` ? 'block' : 'none';
      pane.classList.toggle('active', pane.id === `admin-tab-${tNum}`);
    });

    if (tNum === 1) {
      this.renderTab1();
    } else if (tNum === 2) {
      this.renderTab2();
    } else if (tNum === 3) {
      this.renderTab3();
    } else if (tNum === 4) {
      this.renderTab4();
    } else if (tNum === 5) {
      this.renderTab5();
    }
  },

  renderTab1() {
    this.updateDashboardMetricsOnly();
  },

  renderTab5() {
    // Render POS Counter menu catalog
    const catalogDiv = document.getElementById('pos-food-catalog');
    if (catalogDiv) {
      catalogDiv.innerHTML = '';
      if (this.foodItems.length === 0) {
        catalogDiv.innerHTML = `<div style="color:var(--text-muted); text-align:center; padding:1rem;">No items listed.</div>`;
      }
      this.foodItems.forEach(f => {
        const card = document.createElement('div');
        card.className = `pos-item-card ${f.stock === 0 ? 'disabled' : ''}`;
        card.innerHTML = `
          <div class="pos-item-title">${f.name}</div>
          <div class="flex justify-between align-center" style="margin-top: 0.5rem; font-size: 0.75rem;">
            <span style="font-weight:700; color:var(--accent);">₹${f.price}</span>
            <span style="color:var(--text-muted);">${f.stock > 0 ? f.stock + ' left' : 'OUT'}</span>
          </div>
        `;
        if (f.stock > 0) {
          card.addEventListener('click', () => this.addToPOSCart(f));
        }
        catalogDiv.appendChild(card);
      });
    }

    this.renderPOSCart();
  },

  addToPOSCart(food) {
    const existing = this.posCart.find(i => i.id === food.id);
    if (existing) {
      if (existing.quantity >= food.stock) {
        alert(`Cannot add more. Portions left in canteen: ${food.stock}`);
        return;
      }
      existing.quantity++;
    } else {
      this.posCart.push({
        id: food.id,
        name: food.name,
        price: food.price,
        quantity: 1
      });
    }
    this.renderPOSCart();
  },

  updatePOSQty(id, delta) {
    const existing = this.posCart.find(i => i.id === id);
    if (!existing) return;

    const food = this.foodItems.find(f => f.id === id);
    if (!food) return;

    existing.quantity += delta;
    if (existing.quantity <= 0) {
      this.posCart = this.posCart.filter(i => i.id !== id);
    } else if (existing.quantity > food.stock) {
      alert(`Only ${food.stock} portions available.`);
      existing.quantity = food.stock;
    }
    this.renderPOSCart();
  },

  renderPOSCart() {
    const list = document.getElementById('pos-cart-list');
    const subTotalSpan = document.getElementById('pos-subtotal');
    const taxSpan = document.getElementById('pos-tax');
    const totalSpan = document.getElementById('pos-total');
    const submitBtn = document.getElementById('btn-pos-submit');

    if (!list) return;

    list.innerHTML = '';
    if (this.posCart.length === 0) {
      list.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 1rem; font-size:0.8rem;">Draft billing receipt is empty.</div>`;
      subTotalSpan.innerText = '₹0';
      taxSpan.innerText = '₹0';
      totalSpan.innerText = '₹0';
      submitBtn.disabled = true;
      return;
    }

    let subtotal = 0;
    this.posCart.forEach(item => {
      const itemTotal = item.price * item.quantity;
      subtotal += itemTotal;

      const row = document.createElement('div');
      row.className = 'pos-cart-item';
      row.innerHTML = `
        <div style="flex-grow: 1;">
          <strong>${item.name}</strong><br>
          <span style="color: var(--text-muted); font-size:0.75rem;">₹${item.price} each</span>
        </div>
        <div class="flex align-center gap-1" style="margin-right: 1rem;">
          <button type="button" class="qty-btn btn-minus" data-id="${item.id}">-</button>
          <span style="font-size:0.85rem; font-weight:bold;">${item.quantity}</span>
          <button type="button" class="qty-btn btn-plus" data-id="${item.id}">+</button>
        </div>
        <div style="font-weight: 600; font-size:0.85rem;">₹${itemTotal}</div>
      `;

      row.querySelector('.btn-minus').addEventListener('click', () => this.updatePOSQty(item.id, -1));
      row.querySelector('.btn-plus').addEventListener('click', () => this.updatePOSQty(item.id, 1));

      list.appendChild(row);
    });

    const tax = Math.round(subtotal * 0.05);
    const total = subtotal + tax;

    subTotalSpan.innerText = `₹${subtotal}`;
    taxSpan.innerText = `₹${tax}`;
    totalSpan.innerText = `₹${total}`;
    submitBtn.disabled = false;
  },

  renderTab2() {
    // Render Menu quantities table
    const tbody = document.getElementById('tab2-menu-tbody');
    if (tbody) {
      tbody.innerHTML = '';
      if (this.foodItems.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">No menu items found.</td></tr>`;
      }
      this.foodItems.forEach(f => {
        const tr = document.createElement('tr');
        const imgName = f.image.split('/').pop(); // Extract basename
        tr.innerHTML = `
          <td><img src="assets/${imgName}" style="width:36px; height:36px; border-radius:6px; object-fit:cover;" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2236%22 height=%2236%22><rect width=%2236%22 height=%2236%22 fill=%22%23222%22/></svg>'"></td>
          <td><strong>${f.name}</strong><br><span style="font-size:0.7rem; color:var(--text-muted);">${f.category} | ${f.isveg}</span></td>
          <td>₹${f.price}</td>
          <td>
            <div style="display:flex; align-items:center; gap:0.4rem;">
              <input type="number" class="stock-inline-edit" data-id="${f.id}" value="${f.stock}" style="width:55px; padding:0.25rem; font-size:0.8rem; background:var(--bg-dark); border:1px solid var(--border-dark); color:#fff; border-radius:4px; text-align:center;">
              <button class="btn-sm btn-save-stock" data-id="${f.id}" style="padding:0.25rem 0.4rem; font-size:0.75rem;"><i class="fas fa-save"></i></button>
            </div>
          </td>
          <td>
            <button class="btn-sm btn-delete-food" data-id="${f.id}" style="padding:0.3rem 0.5rem; background:rgba(234,67,53,0.1); color:#ea4335; border:1px solid rgba(234,67,53,0.2);"><i class="fas fa-trash"></i></button>
          </td>
        `;

        tr.querySelector('.btn-save-stock').addEventListener('click', async () => {
          const inp = tr.querySelector('.stock-inline-edit');
          const newStock = parseInt(inp.value, 10);
          if (isNaN(newStock) || newStock < 0) return alert("Invalid stock quantity");
          
          try {
            const res = await this.fetchWithAuth(`/api/food-items/${f.id}`, {
              method: 'PUT',
              body: JSON.stringify({
                name: f.name,
                price: f.price,
                stock: newStock,
                category: f.category,
                isveg: f.isveg,
                image: f.image,
                details: f.details
              })
            });
            if (res.ok) {
              await this.fetchFoodItems();
              this.renderTab(2);
              alert("Stock updated successfully!");
            }
          } catch (err) {
            console.error(err);
          }
        });

        tr.querySelector('.btn-delete-food').addEventListener('click', async () => {
          if (!confirm(`Delete ${f.name} from menu?`)) return;
          try {
            const res = await this.fetchWithAuth(`/api/food-items/${f.id}`, {
              method: 'DELETE'
            });
            if (res.ok) {
              await this.foodItems;
              await this.fetchFoodItems();
              this.renderTab(2);
              alert("Item deleted.");
            }
          } catch (err) {
            console.error(err);
          }
        });

        tbody.appendChild(tr);
      });
    }

    // Populate Report filter food item list
    const filterItemSelect = document.getElementById('report-filter-item');
    if (filterItemSelect) {
      const currentVal = filterItemSelect.value;
      filterItemSelect.innerHTML = '<option value="All">All Items</option>';
      this.foodItems.forEach(f => {
        filterItemSelect.innerHTML += `<option value="${f.id}">${f.name}</option>`;
      });
      filterItemSelect.value = currentVal;
    }

    this.updateSalesReportTable();
  },

  renderTab3() {
    // Render ingredients inventory table
    const ingTableBody = document.getElementById('tab3-ingredients-tbody');
    if (ingTableBody) {
      ingTableBody.innerHTML = '';
      if (this.ingredients.length === 0) {
        ingTableBody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">No materials cataloged.</td></tr>`;
      }
      this.ingredients.forEach(i => {
        const tr = document.createElement('tr');
        const formattedDate = i.lastPurchaseDate ? new Date(i.lastPurchaseDate).toLocaleString() : 'N/A';
        tr.innerHTML = `
          <td><strong>${i.name}</strong></td>
          <td>${i.id}</td>
          <td>
            <div style="display:flex; align-items:center; gap:0.4rem;">
              <input type="number" step="0.1" class="ing-stock-inline-edit" data-id="${i.id}" value="${i.stock}" style="width:70px; padding:0.25rem; font-size:0.8rem; background:var(--bg-dark); border:1px solid var(--border-dark); color:#fff; border-radius:4px; text-align:center;">
              <span style="font-size:0.8rem; color:var(--text-muted);">${i.unit}</span>
              <button class="btn-sm btn-save-ing-stock" data-id="${i.id}" style="padding:0.25rem 0.4rem; font-size:0.75rem;"><i class="fas fa-save"></i></button>
            </div>
          </td>
          <td style="font-size: 0.85rem; color: var(--text-muted);">${formattedDate}</td>
          <td>
            <button class="btn-sm btn-delete-ing" data-id="${i.id}" style="padding:0.3rem 0.5rem; background:rgba(234,67,53,0.1); color:#ea4335; border:1px solid rgba(234,67,53,0.2);"><i class="fas fa-trash"></i></button>
          </td>
        `;
        
        tr.querySelector('.btn-save-ing-stock').addEventListener('click', async () => {
          const inp = tr.querySelector('.ing-stock-inline-edit');
          const newStock = parseFloat(inp.value);
          if (isNaN(newStock) || newStock < 0) return alert("Invalid stock quantity");
          
          try {
            const res = await this.fetchWithAuth(`/api/ingredients/${i.id}`, {
              method: 'PUT',
              body: JSON.stringify({
                name: i.name,
                stock: newStock,
                unit: i.unit
              })
            });
            if (res.ok) {
              await this.fetchIngredients();
              this.renderTab(3);
              alert("Material stock updated successfully!");
            }
          } catch (err) {
            console.error(err);
          }
        });

        tr.querySelector('.btn-delete-ing').addEventListener('click', async () => {
          if (!confirm(`Delete ${i.name} from inventory?`)) return;
          try {
            const res = await this.fetchWithAuth(`/api/ingredients/${i.id}`, {
              method: 'DELETE'
            });
            if (res.ok) {
              await this.fetchIngredients();
              this.renderTab(3);
              alert("Material deleted from inventory.");
            } else {
              const errData = await res.json();
              alert(`Error: ${errData.error}`);
            }
          } catch (err) {
            console.error(err);
          }
        });

        ingTableBody.appendChild(tr);
      });
    }

    // Populate log forms selectors
    const purSelect = document.getElementById('tab1-pur-ing-id');
    const useSelect = document.getElementById('tab1-use-ing-id');
    
    if (purSelect && useSelect) {
      const currentPur = purSelect.value;
      const currentUse = useSelect.value;

      purSelect.innerHTML = '<option value="">-- Choose Material --</option>';
      useSelect.innerHTML = '<option value="">-- Choose Material --</option>';

      this.ingredients.forEach(i => {
        const opt = `<option value="${i.id}">${i.name} (${i.unit})</option>`;
        purSelect.innerHTML += opt;
        useSelect.innerHTML += opt;
      });

      purSelect.value = currentPur;
      useSelect.value = currentUse;
    }
  },

  renderTab4() {
    const ledgerBody = document.getElementById('tab3-transactions-tbody');
    if (!ledgerBody) return;

    ledgerBody.innerHTML = '';
    
    const masterCB = document.getElementById('ledger-select-all');
    if (masterCB) masterCB.checked = false;

    if (this.transactions.length === 0) {
      ledgerBody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">Ledger logs are empty.</td></tr>`;
      return;
    }

    this.transactions.forEach(t => {
      const tr = document.createElement('tr');
      const isSale = t.type === 'sale';
      const amountVal = isSale ? `+₹${t.amount}` : (t.type === 'purchase' ? `-₹${t.amount}` : `₹${t.amount}`);
      const badgeClass = isSale ? 'badge-success' : (t.type === 'purchase' ? 'badge-danger' : 'badge-warning');
      const timeStr = new Date(t.timestamp).toLocaleString();

      tr.innerHTML = `
        <td style="text-align: center;"><input type="checkbox" class="ledger-row-cb" data-id="${t.id}"></td>
        <td style="font-size: 0.8rem; color: var(--text-muted);">${timeStr}</td>
        <td><strong>${t.title}</strong><br><span style="font-size: 0.75rem; color:var(--text-muted);">${t.details || ''}</span></td>
        <td><span class="badge ${badgeClass}">${t.type.toUpperCase()}</span></td>
        <td><strong class="${isSale ? 'income' : 'expense'}">${amountVal}</strong></td>
        <td style="text-align: center;">
          <button class="btn-sm btn-delete-tx" data-id="${t.id}" style="padding: 0.25rem 0.4rem; background:rgba(234,67,53,0.1); color:#ea4335; border:1px solid rgba(234,67,53,0.2);"><i class="fas fa-trash-alt"></i></button>
        </td>
      `;

      tr.querySelector('.btn-delete-tx').addEventListener('click', async () => {
        if (!confirm("Are you sure you want to delete this ledger transaction?")) return;
        try {
          const res = await this.fetchWithAuth(`/api/ledger/${t.id}`, {
            method: 'DELETE'
          });
          if (res.ok) {
            await this.fetchTransactions();
            this.renderTab(4);
            alert("Ledger transaction deleted.");
          }
        } catch (err) {
          console.error(err);
        }
      });

      ledgerBody.appendChild(tr);
    });

    // Prefill account profiles details
    document.getElementById('acc-name-input').value = this.accountDetails.name || '';
    document.getElementById('acc-upi-input').value = this.accountDetails.upiId || '';
    document.getElementById('acc-bank-input').value = this.accountDetails.bank || '';
    document.getElementById('acc-no-input').value = this.accountDetails.accNo || '';
    document.getElementById('acc-ifsc-input').value = this.accountDetails.ifsc || '';

    // Prefill Razorpay config details
    fetch('/api/payments/config')
      .then(res => res.json())
      .then(config => {
        const keyIdInput = document.getElementById('rzp-key-id');
        if (keyIdInput && config.keyId) {
          keyIdInput.value = config.keyId;
        }
      })
      .catch(e => console.warn("Failed to fetch Razorpay config:", e));
  },

  exportInventoryCSV() {
    if (this.ingredients.length === 0) return alert("Nothing to export.");
    let csv = "Ingredient ID,Material Name,Stock,Unit,Last Restocked Date\n";
    this.ingredients.forEach(i => {
      csv += `"${i.id}","${i.name}",${i.stock},"${i.unit}","${i.lastPurchaseDate || ''}"\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `n_cafe_inventory_status_${new Date().toISOString().slice(0,10)}.csv`;
    link.click();
  },

  exportLedgerCSV() {
    let list = [];
    const checkboxes = document.querySelectorAll('.ledger-row-cb:checked');
    if (checkboxes.length > 0) {
      const selectedIds = Array.from(checkboxes).map(cb => cb.dataset.id);
      list = this.transactions.filter(t => selectedIds.includes(t.id));
    } else {
      list = this.transactions;
    }

    if (list.length === 0) return alert("No transactions available for export.");

    let csv = "Transaction ID,Date/Time,Transaction,Type,Value,Particulars\n";
    list.forEach(t => {
      const time = new Date(t.timestamp).toLocaleString().replace(/"/g, '""');
      csv += `"${t.id}","${time}","${t.title.replace(/"/g, '""')}","${t.type}",${t.amount},"${(t.details || '').replace(/"/g, '""')}"\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `n_cafe_ledger_audit_${new Date().toISOString().slice(0,10)}.csv`;
    link.click();
  }
};

// --- WALK-IN RECEIPT / BILL COMPILER (.TXT DOWNLOAD) ---
function downloadReceipt(booking) {
  if (!booking) return;
  
  const itemsText = booking.items.map(i => `${i.name.padEnd(25)} x${i.quantity.toString().padEnd(3)} - ₹${i.price * i.quantity}`).join('\n');
  const tax = Math.round(booking.totalAmount - (booking.totalAmount / 1.05));
  const sub = booking.totalAmount - tax;
  
  const textReceiptContent = `
==================================================
                 N   C A F E
==================================================
Invoice Token:  ${booking.id}
Customer Name:  ${booking.customerName}
Phone Number:   ${booking.customerPhone}
Placed Date:    ${new Date(booking.bookingTime).toLocaleString()}
Payment Style:  ${booking.paymentMethod}
Order Status:   ${booking.status.toUpperCase()}
--------------------------------------------------
Delights Particulars:
${itemsText}
--------------------------------------------------
Subtotal:       ₹${sub}
GST (5%):       ₹${tax}
Total Paid:     ₹${booking.totalAmount}
==================================================
        Thank you for ordering at N Cafe!
==================================================
`;

  const blob = new Blob([textReceiptContent], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `n_cafe_receipt_${booking.id}.txt`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// Wire up login form on page load
document.addEventListener('DOMContentLoaded', () => {
  const loginForm = document.getElementById('admin-login-form');
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = document.getElementById('admin-login-password').value;
      try {
        const res = await fetch('/api/auth/login-admin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password })
        });
        if (res.ok) {
          const data = await res.json();
          localStorage.setItem('admin_token', data.token);
          document.getElementById('admin-login-password').value = '';
          AdminState.init();
        } else {
          const errData = await res.json();
          alert(errData.error || "Login failed");
        }
      } catch (err) {
        console.error(err);
        alert("Server communication error.");
      }
    });
  }

  // Initialize
  AdminState.init();
});
