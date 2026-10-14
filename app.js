// N Cafe State Management
const CanteenState = {
  foodItems: [],
  bookings: [],
  ingredients: [],
  transactions: [],
  cart: [],
  activeBooking: null,
  paymentTimer: null,
  lockedStock: [],
  currentLockId: null,
  adminPassword: null,
  scannerPin: null,
  
  // Bank Account details
  accountDetails: {
    name: 'N Cafe Hills Kitchen Services',
    bank: 'State Bank of India',
    accNo: '39485710293',
    ifsc: 'SBIN0008472',
    upiId: 'ncafe.canteen@okaxis'
  },

  init() {
    this.loadState();
    if (this.foodItems.length === 0) {
      this.seedData();
      this.saveState();
    }
  },

  loadState() {
    try {
      this.foodItems = JSON.parse(localStorage.getItem('nc_food_items')) || [];
      this.bookings = JSON.parse(localStorage.getItem('nc_bookings')) || [];
      this.ingredients = JSON.parse(localStorage.getItem('nc_ingredients')) || [];
      this.transactions = JSON.parse(localStorage.getItem('nc_transactions')) || [];
      this.lockedStock = JSON.parse(localStorage.getItem('nc_locked_stock')) || [];
      
      const savedAcc = JSON.parse(localStorage.getItem('nc_account_details'));
      if (savedAcc) {
        this.accountDetails = savedAcc;
      }
      this.releaseExpiredLocks();
    } catch (e) {
      console.error('Failed to load local storage state:', e);
    }
  },

  saveState() {
    localStorage.setItem('nc_food_items', JSON.stringify(this.foodItems));
    localStorage.setItem('nc_bookings', JSON.stringify(this.bookings));
    localStorage.setItem('nc_ingredients', JSON.stringify(this.ingredients));
    localStorage.setItem('nc_transactions', JSON.stringify(this.transactions));
    localStorage.setItem('nc_account_details', JSON.stringify(this.accountDetails));
    localStorage.setItem('nc_locked_stock', JSON.stringify(this.lockedStock));

    // Auto-sync to Google Drive in the background if connected and active
    if (typeof GDriveSync !== 'undefined' && GDriveSync.accessToken && new Date() < GDriveSync.tokenExpiry && GDriveSync.fileId) {
      const autoSyncCheck = document.getElementById('gdrive-auto-sync');
      if (autoSyncCheck && autoSyncCheck.checked) {
        GDriveSync.pushToDrive();
      }
    }
  },

  exportStateJSON() {
    return JSON.stringify({
      foodItems: this.foodItems,
      bookings: this.bookings,
      ingredients: this.ingredients,
      transactions: this.transactions,
      accountDetails: this.accountDetails,
      lockedStock: this.lockedStock,
    });
  },

  importStateJSON(jsonStr) {
    try {
      const data = JSON.parse(jsonStr);
      if (data.foodItems) this.foodItems = data.foodItems;
      if (data.bookings) this.bookings = data.bookings;
      if (data.ingredients) this.ingredients = data.ingredients;
      if (data.transactions) this.transactions = data.transactions;
      if (data.accountDetails) this.accountDetails = data.accountDetails;
      if (data.lockedStock) this.lockedStock = data.lockedStock;
      this.saveState();
      return true;
    } catch (e) {
      console.error(e);
      alert('Invalid database JSON file format.');
      return false;
    }
  },

  mergeStateJSON(jsonStr) {
    try {
      const data = JSON.parse(jsonStr);
      let changed = false;

      if (data.bookings) {
        data.bookings.forEach(pulled => {
          const local = this.bookings.find(b => b.id.toLowerCase() === pulled.id.toLowerCase());
          if (!local) {
            this.bookings.push(pulled);
            changed = true;
          } else {
            if (local.status !== pulled.status) {
              if (pulled.status === 'redeemed' || local.status === 'redeemed') {
                local.status = 'redeemed';
                local.redeemedTime = local.redeemedTime || pulled.redeemedTime;
              } else {
                local.status = pulled.status;
              }
              changed = true;
            }
          }
        });
      }

      if (data.transactions) {
        data.transactions.forEach(pulled => {
          const exists = this.transactions.some(t => t.id.toLowerCase() === pulled.id.toLowerCase());
          if (!exists) {
            this.transactions.push(pulled);
            changed = true;
          }
        });
      }

      if (data.foodItems) {
        this.foodItems = data.foodItems;
        changed = true;
      }
      if (data.ingredients) {
        this.ingredients = data.ingredients;
        changed = true;
      }
      if (data.accountDetails) {
        this.accountDetails = data.accountDetails;
        changed = true;
      }
      if (data.lockedStock) {
        this.lockedStock = data.lockedStock;
        changed = true;
      }

      if (changed) {
        localStorage.setItem('nc_food_items', JSON.stringify(this.foodItems));
        localStorage.setItem('nc_bookings', JSON.stringify(this.bookings));
        localStorage.setItem('nc_ingredients', JSON.stringify(this.ingredients));
        localStorage.setItem('nc_transactions', JSON.stringify(this.transactions));
        localStorage.setItem('nc_account_details', JSON.stringify(this.accountDetails));
        localStorage.setItem('nc_locked_stock', JSON.stringify(this.lockedStock));
        
        this.refreshActiveViews();
      }
      return true;
    } catch (e) {
      console.error("Failed to merge background state:", e);
      return false;
    }
  },

  refreshActiveViews() {
    try {
      if (typeof AppRouter !== 'undefined') {
        if (AppRouter.currentRole === 'customer') {
          if (AppRouter.currentTab === 'home') {
            const activeCat = document.querySelector('.cat-btn.active');
            const searchVal = document.getElementById('search-food').value;
            renderFoodMenu(activeCat ? activeCat.dataset.category : 'all', searchVal);
          }
        } else if (AppRouter.currentRole === 'admin') {
          if (AppRouter.adminSubTab === '1') {
            renderAdminTab1();
          } else if (AppRouter.adminSubTab === '2') {
            renderAdminTab2();
          } else if (AppRouter.adminSubTab === '3') {
            renderAdminTab3();
          } else if (AppRouter.adminSubTab === '4') {
            renderAdminTab4();
          }
        }
      }
    } catch (e) {
      console.error("Failed to refresh active views:", e);
    }
  },

  getAvailableStock(foodItemId) {
    const food = this.foodItems.find(f => f.id === foodItemId);
    if (!food) return 0;
    const now = Date.now();
    const activeLocks = (this.lockedStock || []).filter(l => l.expiryTime > now);
    const lockedQty = activeLocks
      .filter(l => l.foodItemId === foodItemId)
      .reduce((sum, l) => sum + l.quantity, 0);
    return Math.max(0, food.stock - lockedQty);
  },

  lockStock(cartItems) {
    this.releaseExpiredLocks();
    const lockId = 'LCK-' + Math.floor(100000 + Math.random() * 900000).toString();
    this.currentLockId = lockId;
    const expiry = Date.now() + 5 * 60 * 1000; // 5 minutes hold
    
    cartItems.forEach(item => {
      this.lockedStock.push({
        lockId: lockId,
        foodItemId: item.id,
        quantity: item.quantity,
        expiryTime: expiry
      });
    });
    this.saveState();
    return lockId;
  },

  releaseExpiredLocks() {
    const now = Date.now();
    const initialCount = (this.lockedStock || []).length;
    this.lockedStock = (this.lockedStock || []).filter(l => l.expiryTime > now);
    if (this.lockedStock.length !== initialCount) {
      this.saveState();
    }
  },

  releaseLockById(lockId) {
    if (!lockId) return;
    const initialCount = (this.lockedStock || []).length;
    this.lockedStock = (this.lockedStock || []).filter(l => l.lockId !== lockId);
    if (this.lockedStock.length !== initialCount) {
      this.saveState();
    }
  },

  backupToFile() {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(this.exportStateJSON());
    const link = document.createElement('a');
    link.setAttribute("href", dataStr);
    link.setAttribute("download", "n_cafe_db.json");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  },

  restoreFromFile(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const success = this.importStateJSON(e.target.result);
      if (success) {
        alert('Database successfully restored from JSON file!');
        window.location.reload();
      }
    };
    reader.readAsText(file);
  },

  seedData() {
    // Default food items
    this.foodItems = [
      {
        id: 'dosa',
        name: 'Masala Dosa Special',
        price: 80,
        stock: 25,
        category: 'Breakfast',
        isVeg: true,
        desc: 'Crisp rice and lentil crepe filled with aromatic spiced potato masala, served with organic coconut and tomato chutneys.',
        image: 'assets/masala_dosa.png'
      },
      {
        id: 'coffee',
        name: 'Special Filter Coffee',
        price: 30,
        stock: 40,
        category: 'Beverages',
        isVeg: true,
        desc: 'Traditional South Indian filter coffee brewed with fresh dark roast coffee beans, served frothy and piping hot.',
        image: 'assets/filter_coffee.png'
      },
      {
        id: 'tea_vada',
        name: 'Tea & Vada Combo',
        price: 50,
        stock: 15,
        category: 'Snacks',
        isVeg: true,
        desc: 'A cup of cardamon-infused hot tea served with two crispy, savory Medu Vadas and fresh coconut chutney.',
        image: 'assets/vada_combo.png'
      },
      {
        id: 'idli',
        name: 'Steaming Idli Sambar',
        price: 60,
        stock: 20,
        category: 'Breakfast',
        isVeg: true,
        desc: 'Three soft, fluffy steamed rice cakes partially submerged in our signature aromatic lentil and vegetable sambar.',
        image: 'assets/idli_sambar.png'
      }
    ];

    // Default ingredients
    this.ingredients = [
      { id: 'rice', name: 'Premium Raw Rice', unit: 'kg', stock: 50, lastPurchaseDate: new Date(Date.now() - 24 * 3600 * 1000).toISOString() },
      { id: 'urad_dal', name: 'Split Black Gram (Urad Dal)', unit: 'kg', stock: 25, lastPurchaseDate: new Date(Date.now() - 24 * 3600 * 1000).toISOString() },
      { id: 'coffee_powder', name: 'Fresh Coffee Blend', unit: 'kg', stock: 8, lastPurchaseDate: new Date(Date.now() - 24 * 3600 * 1000).toISOString() },
      { id: 'tea_leaves', name: 'CTC Tea Leaves', unit: 'kg', stock: 5, lastPurchaseDate: new Date(Date.now() - 24 * 3600 * 1000).toISOString() },
      { id: 'milk', name: 'Fresh Farm Milk', unit: 'liters', stock: 35, lastPurchaseDate: new Date(Date.now() - 12 * 3600 * 1000).toISOString() },
      { id: 'sugar', name: 'Organic Cane Sugar', unit: 'kg', stock: 15, lastPurchaseDate: new Date(Date.now() - 24 * 3600 * 1000).toISOString() },
      { id: 'potatoes', name: 'Local Potatoes', unit: 'kg', stock: 20, lastPurchaseDate: new Date(Date.now() - 24 * 3600 * 1000).toISOString() }
    ];

    // Default historical bookings
    this.bookings = [
      {
        id: 'NC-29471638',
        customerName: 'Aditya Verma',
        customerPhone: '9876543210',
        passkey: '1234',
        items: [
          { foodItemId: 'dosa', name: 'Masala Dosa Special', quantity: 2, price: 80 },
          { foodItemId: 'coffee', name: 'Special Filter Coffee', quantity: 1, price: 30 }
        ],
        totalAmount: 190,
        paymentMethod: 'UPI/QR',
        paymentStatus: 'Paid',
        bookingTime: new Date(Date.now() - 4 * 3600 * 1000).toISOString(),
        expiryTime: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
        status: 'redeemed',
        redeemedTime: new Date(Date.now() - 3.5 * 3600 * 1000).toISOString()
      },
      {
        id: 'NC-82746193',
        customerName: 'Meera Nair',
        customerPhone: '9447123456',
        passkey: '4321',
        items: [
          { foodItemId: 'idli', name: 'Steaming Idli Sambar', quantity: 1, price: 60 },
          { foodItemId: 'tea_vada', name: 'Tea & Vada Combo', quantity: 1, price: 50 }
        ],
        totalAmount: 110,
        paymentMethod: 'UPI/QR',
        paymentStatus: 'Paid',
        bookingTime: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        expiryTime: new Date(Date.now() + 9.5 * 3600 * 1000).toISOString(),
        status: 'pending',
        redeemedTime: null
      },
      {
        id: 'NC-99999999',
        customerName: 'Expired User (Test)',
        customerPhone: '9000000000',
        passkey: '9999',
        items: [
          { foodItemId: 'coffee', name: 'Special Filter Coffee', quantity: 1, price: 30 }
        ],
        totalAmount: 30,
        paymentMethod: 'UPI/QR',
        paymentStatus: 'Paid',
        bookingTime: new Date(Date.now() - 11 * 3600 * 1000).toISOString(),
        expiryTime: new Date(Date.now() - 1 * 3600 * 1000).toISOString(),
        status: 'pending',
        redeemedTime: null
      }
    ];

    // Default historical transactions
    this.transactions = [
      {
        id: 'TX-10001',
        type: 'purchase',
        title: 'Initial Raw Ingredients Stockup',
        amount: 2500,
        timestamp: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
        details: 'Initial load of Rice, Lentils, Coffee, Tea, Milk, and Sugar.'
      },
      {
        id: 'TX-10002',
        type: 'sale',
        title: 'Order Redeemed - Aditya Verma',
        amount: 190,
        timestamp: new Date(Date.now() - 3.5 * 3600 * 1000).toISOString(),
        details: 'Masala Dosa x2, Filter Coffee x1'
      },
      {
        id: 'TX-10003',
        type: 'purchase',
        title: 'Dairy Restock - Milk Purchase',
        amount: 550,
        timestamp: new Date(Date.now() - 12 * 3600 * 1000).toISOString(),
        details: 'Purchased 10 Liters of fresh milk.'
      }
    ];
  }
};

// UI Controllers & Router
const AppRouter = {
  currentRole: 'customer', // customer, scanner, admin
  currentTab: 'home', // home, checkout, ticket
  adminSubTab: '1', // 1, 2, 3
  
  // Passcode gate state
  passcodeState: {
    currentPIN: '',
    pinDots: [],
    correctPINs: {
      admin: '1234',
      scanner: ''
    }
  },

  toggleCredentialsPanel() {
    const form = document.getElementById('tab4-credentials-form');
    const chevron = document.getElementById('credentials-chevron');
    if (!form) return;
    if (form.style.display === 'none' || form.style.display === '') {
      form.style.display = 'block';
      if (chevron) chevron.style.transform = 'rotate(180deg)';
    } else {
      form.style.display = 'none';
      if (chevron) chevron.style.transform = 'rotate(0deg)';
    }
  },

  init() {
    // Navigation buttons
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const targetView = e.currentTarget.dataset.view;
        if (!targetView) return;
        if (targetView === 'cart') {
          toggleCartDrawer(true);
        } else {
          this.navigateTo(targetView);
        }
      });
    });

    // Admin Tabs Navigation (3 parts)
    document.querySelectorAll('.admin-tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tab = e.target.dataset.tab;
        this.switchAdminTab(tab);
      });
    });

    // Smart PIN Entry trigger from footer
    const footerLink = document.getElementById('staff-portal-link');
    if (footerLink) {
      footerLink.addEventListener('click', (e) => {
        e.preventDefault();
        this.openPasscodeGate();
      });
    }

    // Wire passcode keypad buttons
    document.querySelectorAll('.pin-keypad .pin-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const key = e.target.dataset.key;
        if (key === 'clear') {
          this.clearPIN();
        } else if (key === 'back') {
          this.backspacePIN();
        } else {
          this.enterPIN(key);
        }
      });
    });

    // Run Initial View
    this.switchRole('customer');
  },

  openPasscodeGate() {
    this.passcodeState.currentPIN = '';
    document.getElementById('passcode-gate').classList.add('active');
    this.switchPasscodeTab('operator');
    this.updatePINDots();
  },

  closePasscodeGate() {
    document.getElementById('passcode-gate').classList.remove('active');
    this.passcodeState.currentPIN = '';
    document.getElementById('admin-text-password').value = '';
  },

  switchPasscodeTab(tab) {
    document.querySelectorAll('.passcode-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.id === `passcode-tab-${tab}`);
    });
    document.querySelectorAll('.passcode-panel-content').forEach(panel => {
      panel.style.display = panel.id === `passcode-panel-${tab}` ? 'block' : 'none';
    });
    if (tab === 'admin') {
      document.getElementById('admin-text-password').value = '';
      document.getElementById('admin-text-password').focus();
    } else {
      this.clearPIN();
    }
  },

  submitAdminPassword(e) {
    if (e) e.preventDefault();
    const pwdInput = document.getElementById('admin-text-password');
    const pwd = pwdInput.value.trim();
    if (pwd === CanteenState.adminPassword) {
      this.closePasscodeGate();
      pwdInput.value = '';
      this.switchRole('admin');
    } else {
      const card = document.getElementById('passcode-modal-card');
      card.classList.add('shake');
      pwdInput.value = '';
      setTimeout(() => {
        card.classList.remove('shake');
      }, 400);
    }
  },

  enterPIN(num) {
    if (this.passcodeState.currentPIN.length < 4) {
      this.passcodeState.currentPIN += num;
      this.updatePINDots();
      
      if (this.passcodeState.currentPIN.length === 4) {
        setTimeout(() => this.submitPIN(), 150);
      }
    }
  },

  clearPIN() {
    this.passcodeState.currentPIN = '';
    this.updatePINDots();
  },

  backspacePIN() {
    this.passcodeState.currentPIN = this.passcodeState.currentPIN.slice(0, -1);
    this.updatePINDots();
  },

  updatePINDots() {
    const dots = document.querySelectorAll('.pin-display-dots .pin-dot');
    dots.forEach((dot, index) => {
      dot.classList.toggle('filled', index < this.passcodeState.currentPIN.length);
    });
  },

  submitPIN() {
    const pin = this.passcodeState.currentPIN;
    
    if (pin === this.passcodeState.correctPINs.scanner) {
      this.closePasscodeGate();
      this.switchRole('scanner');
    } else {
      const card = document.getElementById('passcode-modal-card');
      card.classList.add('shake');
      this.clearPIN();
      setTimeout(() => {
        card.classList.remove('shake');
      }, 400);
    }
  },

  // Ticket retrieval modal handlers (NEW)
  openTicketRetrievalGate() {
    document.getElementById('retrieve-cust-name').value = '';
    document.getElementById('retrieve-cust-passkey').value = '';
    document.getElementById('retrieval-results-panel').style.display = 'none';
    document.getElementById('retrieval-results-list').innerHTML = '';
    document.getElementById('ticket-retrieval-gate').classList.add('active');
  },

  closeTicketRetrievalGate() {
    document.getElementById('ticket-retrieval-gate').classList.remove('active');
  },

  submitTicketRetrieval(e) {
    if (e) e.preventDefault();
    const name = document.getElementById('retrieve-cust-name').value.trim().toLowerCase();
    const passkey = document.getElementById('retrieve-cust-passkey').value.trim();

    CanteenState.loadState();
    const matched = CanteenState.bookings.filter(b => 
      b.customerName.toLowerCase() === name && 
      b.passkey === passkey && 
      b.status === 'pending'
    );

    const resultsPanel = document.getElementById('retrieval-results-panel');
    const list = document.getElementById('retrieval-results-list');
    list.innerHTML = '';

    if (matched.length === 0) {
      alert('No pending tickets found matching this Name and Pass Key.');
      resultsPanel.style.display = 'none';
      return;
    }

    resultsPanel.style.display = 'block';
    matched.forEach(booking => {
      const btn = document.createElement('div');
      btn.className = 'retrieval-item-card';
      btn.innerHTML = `
        <div style="flex-grow: 1; margin-right: 1rem;">
          <strong>Order Token ID</strong><br>
          <span style="font-size: 0.7rem; color: var(--text-muted); word-break: break-all;">${booking.id.substring(0, 30)}...</span><br>
          <span style="font-size: 0.75rem; color: var(--text-muted);">Total: ₹${booking.totalAmount} | Placed: ${new Date(booking.bookingTime).toLocaleTimeString()}</span>
        </div>
        <button class="btn-sm btn-sm-accent"><i class="fas fa-eye"></i> View</button>
      `;
      btn.onclick = () => {
        CanteenState.activeBooking = booking;
        this.closeTicketRetrievalGate();
        this.navigateTo('ticket');
      };
    });
  },

  // Column Selector Modal Handlers (NEW)
  openColumnModal() {
    document.getElementById('ledger-column-modal').classList.add('active');
  },

  closeColumnModal() {
    document.getElementById('ledger-column-modal').classList.remove('active');
  },

  submitColumnExport(e) {
    if (e) e.preventDefault();
    
    const cols = [];
    const headers = [];
    
    if (document.getElementById('col-export-id').checked) { cols.push('id'); headers.push('Transaction ID'); }
    if (document.getElementById('col-export-date').checked) { cols.push('date'); headers.push('Date/Time'); }
    if (document.getElementById('col-export-title').checked) { cols.push('title'); headers.push('Title'); }
    if (document.getElementById('col-export-type').checked) { cols.push('type'); headers.push('Type'); }
    if (document.getElementById('col-export-value').checked) { cols.push('value'); headers.push('Value (INR)'); }
    if (document.getElementById('col-export-details').checked) { cols.push('details'); headers.push('Details'); }

    if (cols.length === 0) {
      alert('Please check at least one heading to export.');
      return;
    }

    const targets = CanteenState.pendingExportTransactions || [];
    if (targets.length === 0) {
      alert('No transactions selected for export.');
      this.closeColumnModal();
      return;
    }

    let csvContent = "data:text/csv;charset=utf-8,";
    csvContent += headers.join(",") + "\n";

    targets.forEach(t => {
      const rowData = [];
      if (cols.includes('id')) rowData.push(t.id);
      if (cols.includes('date')) rowData.push(new Date(t.timestamp).toLocaleString().replace(/,/g, ''));
      if (cols.includes('title')) rowData.push(t.title.replace(/,/g, ';'));
      if (cols.includes('type')) rowData.push(t.type);
      if (cols.includes('value')) rowData.push(t.amount);
      if (cols.includes('details')) rowData.push((t.details || '').replace(/,/g, ';'));
      
      csvContent += rowData.join(",") + "\n";
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "n_cafe_ledger_invoices.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    this.closeColumnModal();
    CanteenState.pendingExportTransactions = null;
  },

  switchRole(role) {
    this.currentRole = role;

    document.querySelectorAll('.role-section').forEach(sec => {
      sec.style.display = 'none';
    });

    if (checkoutTimerInterval) {
      clearInterval(checkoutTimerInterval);
      checkoutTimerInterval = null;
    }

    if (CanteenState.currentLockId) {
      CanteenState.releaseLockById(CanteenState.currentLockId);
      CanteenState.currentLockId = null;
    }

    if (CanteenState.paymentTimer) {
      clearInterval(CanteenState.paymentTimer);
      CanteenState.paymentTimer = null;
    }

    if (CanteenState.ticketTimerInterval) {
      clearInterval(CanteenState.ticketTimerInterval);
      CanteenState.ticketTimerInterval = null;
    }

    // Stop scanner webcam feed if exiting scanner portal (NEW)
    if (role !== 'scanner') {
      stopScannerCamera();
    }

    if (role === 'customer') {
      document.getElementById('customer-nav').style.display = 'flex';
      document.getElementById('admin-nav-header').style.display = 'none';
      document.getElementById('customer-section').style.display = 'block';
      this.navigateTo('home');
    } else if (role === 'scanner') {
      document.getElementById('customer-nav').style.display = 'none';
      
      const headerNav = document.getElementById('admin-nav-header');
      headerNav.innerHTML = `
        <button class="nav-btn logout-btn" onclick="AppRouter.switchRole('customer')">
          <i class="fas fa-sign-out-alt"></i> Exit Scanner
        </button>
      `;
      headerNav.style.display = 'flex';
      document.getElementById('scanner-section').style.display = 'block';
      initScannerView();
    } else if (role === 'admin') {
      document.getElementById('customer-nav').style.display = 'none';
      
      const headerNav = document.getElementById('admin-nav-header');
      headerNav.innerHTML = `
        <button class="nav-btn logout-btn" onclick="AppRouter.switchRole('customer')">
          <i class="fas fa-lock"></i> Exit Dashboard
        </button>
      `;
      headerNav.style.display = 'flex';
      document.getElementById('admin-section').style.display = 'block';
      this.switchAdminTab('1');
    }
  },

  navigateTo(view) {
    this.currentTab = view;
    
    if (CanteenState.ticketTimerInterval) {
      clearInterval(CanteenState.ticketTimerInterval);
      CanteenState.ticketTimerInterval = null;
    }

    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === view);
    });

    document.querySelectorAll('.customer-view').forEach(v => {
      v.classList.remove('active');
    });

    const target = document.getElementById(`view-${view}`);
    if (target) {
      target.classList.add('active');
    }

    if (view === 'home') {
      renderFoodMenu();
    } else if (view === 'checkout') {
      initCheckoutPage();
    } else if (view === 'ticket') {
      renderTicketPage();
    }
  },

  switchAdminTab(tab) {
    this.adminSubTab = tab;
    document.querySelectorAll('.admin-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });

    document.querySelectorAll('.admin-tab-content').forEach(c => {
      c.classList.remove('active');
    });

    const target = document.getElementById(`admin-tab-${tab}`);
    if (target) {
      target.classList.add('active');
    }

    if (tab === '1') {
      renderAdminTab1();
    } else if (tab === '2') {
      renderAdminTab2();
    } else if (tab === '3') {
      renderAdminTab3();
    } else if (tab === '4') {
      renderAdminTab4();
    }
  }
};

// --- CUSTOMER VIEWS LOGIC ---

function renderFoodMenu(filterCategory = 'All', searchQuery = '') {
  const menuGrid = document.getElementById('food-menu-grid');
  menuGrid.innerHTML = '';

  let filtered = CanteenState.foodItems;
  
  if (filterCategory !== 'All') {
    filtered = filtered.filter(item => item.category === filterCategory);
  }

  if (searchQuery) {
    const q = searchQuery.toLowerCase().trim();
    filtered = filtered.filter(item => 
      item.name.toLowerCase().includes(q) || 
      item.desc.toLowerCase().includes(q)
    );
  }

  if (filtered.length === 0) {
    menuGrid.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 3rem; color: var(--text-muted);">
        <i class="fas fa-search" style="font-size: 2.5rem; margin-bottom: 1rem; opacity: 0.3;"></i>
        <p>No food items found matching your filter.</p>
      </div>
    `;
    return;
  }

  filtered.forEach(item => {
    const availableStock = CanteenState.getAvailableStock(item.id);
    const isOutOfStock = availableStock <= 0;
    const isLowStock = availableStock > 0 && availableStock <= 5;
    
    let stockClass = 'stock-good';
    let stockLabel = `${availableStock} available`;
    if (isOutOfStock) {
      stockClass = 'stock-out';
      stockLabel = 'Out of Stock';
    } else if (isLowStock) {
      stockClass = 'stock-low';
      stockLabel = `Only ${availableStock} left!`;
    }

    const card = document.createElement('div');
    card.className = 'food-card';
    card.innerHTML = `
      <div class="food-card-img-wrapper">
        <img src="${item.image}" alt="${item.name}" onerror="this.src='https://images.unsplash.com/photo-1589301760014-d929f3979dbc?w=400';">
        <span class="food-card-tag ${item.isVeg ? 'tag-veg' : 'tag-non-veg'}">
          <i class="fas fa-circle" style="font-size: 0.65rem;"></i> ${item.isVeg ? 'Veg' : 'Non-Veg'}
        </span>
      </div>
      <div class="food-card-info">
        <div class="food-card-title-row">
          <h3>${item.name}</h3>
          <span class="food-card-price">₹${item.price}</span>
        </div>
        <p class="food-card-desc">${item.desc}</p>
        <div class="food-card-footer">
          <span class="food-stock-status ${stockClass}">${stockLabel}</span>
          <button class="btn-add-cart" onclick="addToCart('${item.id}')" ${isOutOfStock ? 'disabled' : ''}>
            <i class="fas fa-shopping-basket"></i> Add to Cart
          </button>
        </div>
      </div>
    `;
    menuGrid.appendChild(card);
  });
}

document.querySelectorAll('.cat-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    const category = e.target.dataset.category;
    const searchVal = document.getElementById('search-food').value;
    renderFoodMenu(category, searchVal);
  });
});

document.getElementById('search-food').addEventListener('input', (e) => {
  const activeCat = document.querySelector('.cat-btn.active').dataset.category;
  renderFoodMenu(activeCat, e.target.value);
});

// Cart drawer actions
function toggleCartDrawer(open) {
  const drawer = document.getElementById('cart-drawer');
  const backdrop = document.getElementById('cart-backdrop');
  if (open) {
    drawer.classList.add('open');
    backdrop.classList.add('active');
    renderCart();
  } else {
    drawer.classList.remove('open');
    backdrop.classList.remove('active');
  }
}

document.getElementById('cart-close').addEventListener('click', () => toggleCartDrawer(false));
document.getElementById('cart-backdrop').addEventListener('click', () => toggleCartDrawer(false));

function addToCart(itemId) {
  const foodItem = CanteenState.foodItems.find(item => item.id === itemId);
  const availableStock = CanteenState.getAvailableStock(itemId);
  if (!foodItem || availableStock <= 0) return;

  const cartItem = CanteenState.cart.find(c => c.id === itemId);
  
  if (cartItem) {
    if (cartItem.quantity < availableStock) {
      cartItem.quantity++;
    } else {
      alert(`Sorry, only ${availableStock} items of ${foodItem.name} are currently available.`);
      return;
    }
  } else {
    CanteenState.cart.push({ id: itemId, quantity: 1 });
  }

  updateCartBadges();
  renderCart();
  
  const badgeBtn = document.getElementById('cart-toggle-btn');
  badgeBtn.style.transform = 'scale(1.25)';
  setTimeout(() => badgeBtn.style.transform = '', 200);
}

function updateCartQty(itemId, change) {
  const cartItem = CanteenState.cart.find(c => c.id === itemId);
  const foodItem = CanteenState.foodItems.find(item => item.id === itemId);
  if (!cartItem || !foodItem) return;

  const newQty = cartItem.quantity + change;
  if (newQty <= 0) {
    removeFromCart(itemId);
  } else {
    const availableStock = CanteenState.getAvailableStock(itemId);
    if (newQty > availableStock) {
      alert(`Only ${availableStock} items of ${foodItem.name} are available.`);
    } else {
      cartItem.quantity = newQty;
      updateCartBadges();
      renderCart();
    }
  }
}

function removeFromCart(itemId) {
  CanteenState.cart = CanteenState.cart.filter(c => c.id !== itemId);
  updateCartBadges();
  renderCart();
}

function updateCartBadges() {
  const totalItems = CanteenState.cart.reduce((sum, item) => sum + item.quantity, 0);
  document.querySelectorAll('.cart-badge').forEach(badge => {
    badge.innerText = totalItems;
    badge.style.display = totalItems > 0 ? 'flex' : 'none';
  });
}

function renderCart() {
  const cartList = document.getElementById('cart-items-list');
  const cartSubtotal = document.getElementById('cart-subtotal');
  const cartTax = document.getElementById('cart-tax');
  const cartTotal = document.getElementById('cart-total');
  const checkoutBtn = document.getElementById('cart-checkout-btn');

  cartList.innerHTML = '';
  
  if (CanteenState.cart.length === 0) {
    cartList.innerHTML = `
      <div class="cart-empty-msg">
        <i class="fas fa-shopping-cart"></i>
        <p>Your cart is empty.</p>
        <p style="font-size: 0.8rem; margin-top: 0.25rem;">Browse menu to add items.</p>
      </div>
    `;
    cartSubtotal.innerText = '₹0';
    cartTax.innerText = '₹0';
    cartTotal.innerText = '₹0';
    checkoutBtn.disabled = true;
    return;
  }

  let subtotal = 0;
  CanteenState.cart.forEach(cItem => {
    const foodItem = CanteenState.foodItems.find(item => item.id === cItem.id);
    if (!foodItem) return;

    const itemTotal = foodItem.price * cItem.quantity;
    subtotal += itemTotal;

    const itemDiv = document.createElement('div');
    itemDiv.className = 'cart-item';
    itemDiv.innerHTML = `
      <img src="${foodItem.image}" alt="${foodItem.name}" class="cart-item-img" onerror="this.src='https://images.unsplash.com/photo-1589301760014-d929f3979dbc?w=100';">
      <div class="cart-item-detail">
        <div class="cart-item-name">${foodItem.name}</div>
        <div class="cart-item-price">₹${foodItem.price}</div>
        <div class="cart-item-qty-control">
          <button class="qty-btn" onclick="updateCartQty('${cItem.id}', -1)">-</button>
          <span>${cItem.quantity}</span>
          <button class="qty-btn" onclick="updateCartQty('${cItem.id}', 1)">+</button>
        </div>
      </div>
      <button class="cart-item-remove" onclick="removeFromCart('${cItem.id}')"><i class="fas fa-trash-alt"></i></button>
    `;
    cartList.appendChild(itemDiv);
  });

  const tax = 0;
  const total = subtotal;

  cartSubtotal.innerText = `₹${subtotal}`;
  cartTax.innerText = `₹${tax}`;
  cartTotal.innerText = `₹${total}`;
  checkoutBtn.disabled = false;
}

document.getElementById('cart-checkout-btn').addEventListener('click', () => {
  toggleCartDrawer(false);
  AppRouter.navigateTo('checkout');
});

// --- Checkout & Payment Gateway Simulation ---
function initCheckoutPage() {
  if (CanteenState.cart.length === 0) {
    AppRouter.navigateTo('home');
    return;
  }

  const summaryList = document.getElementById('checkout-items-summary');
  summaryList.innerHTML = '';
  let subtotal = 0;

  CanteenState.cart.forEach(cItem => {
    const foodItem = CanteenState.foodItems.find(item => item.id === cItem.id);
    if (!foodItem) return;
    const totalItem = foodItem.price * cItem.quantity;
    subtotal += totalItem;

    const row = document.createElement('div');
    row.className = 'flex justify-between mb-3';
    row.style.fontSize = '0.9rem';
    row.innerHTML = `
      <span>${foodItem.name} <span style="color: var(--text-muted);">x${cItem.quantity}</span></span>
      <span>₹${totalItem}</span>
    `;
    summaryList.appendChild(row);
  });

  const tax = 0;
  const total = subtotal;

  document.getElementById('checkout-subtotal').innerText = `₹${subtotal}`;
  document.getElementById('checkout-tax').innerText = `₹${tax}`;
  document.getElementById('checkout-total').innerText = `₹${total}`;

  document.getElementById('cust-name').value = '';
  document.getElementById('cust-phone').value = '';
  document.getElementById('checkout-form-details').style.display = 'block';
  document.getElementById('btn-place-order').style.display = 'block';
  document.getElementById('payment-simulation-container').style.display = 'none';
}

document.getElementById('checkout-form').addEventListener('submit', (e) => {
  e.preventDefault();
  
  const name = document.getElementById('cust-name').value.trim();
  const phone = document.getElementById('cust-phone').value.trim();
  
  if (!name || !phone) {
    alert('Please enter your details.');
    return;
  }

  // 1. Double check stock availability before opening payment gateway
  CanteenState.loadState();
  let stockIssues = [];
  CanteenState.cart.forEach(cItem => {
    const food = CanteenState.foodItems.find(f => f.id === cItem.id);
    const available = CanteenState.getAvailableStock(cItem.id);
    if (cItem.quantity > available) {
      stockIssues.push(`${food.name} (Only ${available} left)`);
    }
  });

  if (stockIssues.length > 0) {
    alert(`Some items in your cart are no longer available. Please update your selection:\n\n${stockIssues.join('\n')}`);
    AppRouter.navigateTo('home');
    return;
  }

  // 2. Lock the stock for 5 minutes
  const lockId = CanteenState.lockStock(CanteenState.cart);

  document.getElementById('checkout-form-details').style.display = 'none';
  document.getElementById('btn-place-order').style.display = 'none';
  
  const simContainer = document.getElementById('payment-simulation-container');
  simContainer.style.display = 'block';

  const totalText = document.getElementById('checkout-total').innerText;
  simContainer.querySelector('.npay-amount-tag').innerText = `Amount: ${totalText}`;

  initPaymentGatewaySandbox();
  startCheckoutReservationTimer(lockId);
});

// Checkout Reservation Timer Logic (NEW)
let checkoutTimerInterval = null;

function startCheckoutReservationTimer(lockId) {
  if (checkoutTimerInterval) {
    clearInterval(checkoutTimerInterval);
  }

  let timeLeft = 300; // 5 minutes in seconds
  const timerSpan = document.getElementById('checkout-reserve-timer');

  const updateTimerDisplay = () => {
    const minutes = Math.floor(timeLeft / 60);
    const seconds = timeLeft % 60;
    if (timerSpan) {
      timerSpan.innerText = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
  };

  updateTimerDisplay();

  checkoutTimerInterval = setInterval(() => {
    timeLeft--;
    if (timeLeft <= 0) {
      clearInterval(checkoutTimerInterval);
      checkoutTimerInterval = null;
      
      // Release stock holds
      CanteenState.releaseLockById(lockId);
      CanteenState.currentLockId = null;
      
      alert("Checkout session expired (5-minute limit reached). Your reserved stock has been released.");
      closePaymentGateway();
    } else {
      updateTimerDisplay();
    }
  }, 1000);
}

function closePaymentGateway() {
  if (checkoutTimerInterval) {
    clearInterval(checkoutTimerInterval);
    checkoutTimerInterval = null;
  }
  
  document.getElementById('payment-simulation-container').style.display = 'none';
  document.getElementById('checkout-form-details').style.display = 'block';
  document.getElementById('btn-place-order').style.display = 'block';
  
  // Release lock
  if (CanteenState.currentLockId) {
    CanteenState.releaseLockById(CanteenState.currentLockId);
    CanteenState.currentLockId = null;
  }
  
  AppRouter.navigateTo('home');
  toggleCartDrawer(true);
}

function cancelPaymentGateway() {
  if (confirm('Cancel payment and return to cart? This will release your reserved items.')) {
    closePaymentGateway();
  }
}

// N Pay Payment Gateway Sandbox logic
let selectedGatewayTab = 'qr';
let generatedOTP = '';

function initPaymentGatewaySandbox() {
  switchGatewayTab('qr');
  
  const acc = CanteenState.accountDetails;
  document.getElementById('npay-upi-merchant').innerText = acc.name;
  document.getElementById('npay-upi-vpa').innerText = acc.upiId;

  const totalAmountStr = document.getElementById('checkout-total').innerText.replace('₹', '').trim();
  const upiLink = `upi://pay?pa=${acc.upiId}&pn=${encodeURIComponent(acc.name)}&am=${totalAmountStr}&cu=INR&tn=NCafe-Order`;

  const mobileUpiBtn = document.getElementById('npay-mobile-upi-btn');
  if (mobileUpiBtn) {
    mobileUpiBtn.href = upiLink;
  }

  const qrCanvas = document.getElementById('npay-qr-canvas');
  if (qrCanvas) {
    try {
      new QRious({
        element: qrCanvas,
        value: upiLink,
        size: 180,
        background: '#ffffff',
        foreground: '#000000'
      });
    } catch (e) {
      console.error("Failed to render sandbox QR:", e);
    }
  }
}

function switchGatewayTab(tab) {
  selectedGatewayTab = tab;
  
  document.querySelectorAll('.npay-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  document.querySelectorAll('.npay-tab-content-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `npay-panel-${tab}`);
  });
}

document.querySelectorAll('.npay-tab-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    switchGatewayTab(e.currentTarget.dataset.tab);
  });
});

function runPaymentGatewayLoader(onComplete) {
  const loader = document.getElementById('npay-loader-screen');
  const loaderLabel = document.getElementById('npay-loader-label');
  
  loader.classList.add('active');
  loaderLabel.innerText = 'Securing transaction connection...';

  setTimeout(() => {
    loaderLabel.innerText = 'Redirecting to secure gateway...';
  }, 800);

  setTimeout(() => {
    loader.classList.remove('active');
    onComplete();
  }, 1800);
}

document.getElementById('btn-npay-vpa-request').addEventListener('click', () => {
  const vpa = document.getElementById('gateway-vpa-input').value.trim();
  if (!vpa || !vpa.includes('@')) {
    alert('Please enter a valid UPI address.');
    return;
  }

  const pushLoader = document.getElementById('npay-loader-screen');
  const pushLabel = document.getElementById('npay-loader-label');
  
  pushLoader.classList.add('active');
  pushLabel.innerText = `Sending push payment request to mobile app...`;

  setTimeout(() => {
    pushLabel.innerText = `Waiting for authorization on your UPI app...`;
  }, 1000);

  setTimeout(() => {
    pushLoader.classList.remove('active');
    finalizeCanteenOrder('UPI Push (' + vpa + ')');
  }, 3000);
});

function openOTPChallengeModal() {
  const overlay = document.getElementById('otp-modal-overlay');
  overlay.classList.add('active');
  
  document.querySelectorAll('.otp-field').forEach(f => f.value = '');

  generatedOTP = Math.floor(100000 + Math.random() * 900000).toString();
  document.getElementById('simulated-otp-code').innerText = generatedOTP;

  const fields = document.querySelectorAll('.otp-field');
  fields[0].focus();

  fields.forEach((field, index) => {
    field.oninput = (e) => {
      if (e.target.value.length === 1 && index < fields.length - 1) {
        fields[index + 1].focus();
      }
    };
    field.onkeydown = (e) => {
      if (e.key === 'Backspace' && e.target.value.length === 0 && index > 0) {
        fields[index - 1].focus();
      }
    };
  });
}

document.getElementById('btn-otp-cancel').addEventListener('click', () => {
  document.getElementById('otp-modal-overlay').classList.remove('active');
});

document.getElementById('btn-otp-submit').addEventListener('click', () => {
  const fields = document.querySelectorAll('.otp-field');
  let entered = '';
  fields.forEach(f => entered += f.value);

  if (entered === generatedOTP) {
    document.getElementById('otp-modal-overlay').classList.remove('active');
    finalizeCanteenOrder('Card/NetBanking (' + selectedGatewayTab.toUpperCase() + ')');
  } else {
    alert('Incorrect OTP. Please enter the generated SMS code.');
  }
});

function finalizeCanteenOrder(paymentMethodText) {
  // Clear the reservation timer
  if (checkoutTimerInterval) {
    clearInterval(checkoutTimerInterval);
    checkoutTimerInterval = null;
  }

  // Release the temporary lock (since it is now permanently booked)
  if (CanteenState.currentLockId) {
    CanteenState.releaseLockById(CanteenState.currentLockId);
    CanteenState.currentLockId = null;
  }

  const name = document.getElementById('cust-name').value.trim();
  const phone = document.getElementById('cust-phone').value.trim();
  const passkey = document.getElementById('cust-passkey').value.trim();
  
  let subtotal = 0;
  const itemsBreakdown = [];
  CanteenState.cart.forEach(cItem => {
    const food = CanteenState.foodItems.find(f => f.id === cItem.id);
    subtotal += food.price * cItem.quantity;
    food.stock -= cItem.quantity;

    itemsBreakdown.push({
      foodItemId: food.id,
      name: food.name,
      quantity: cItem.quantity,
      price: food.price
    });
  });

  const tax = 0;
  const total = subtotal;
  const bookingId = generateTicketToken();

  const newBooking = {
    id: bookingId,
    customerName: name,
    customerPhone: phone,
    passkey: passkey,
    items: itemsBreakdown,
    totalAmount: total,
    paymentMethod: paymentMethodText,
    paymentStatus: 'Paid',
    bookingTime: new Date().toISOString(),
    expiryTime: new Date(Date.now() + 5 * 3600 * 1000).toISOString(),
    status: 'pending',
    redeemedTime: null
  };

  const newTx = {
    id: 'TX-' + Math.floor(20000 + Math.random() * 80000).toString(),
    type: 'sale',
    title: `Order Placed - ${name}`,
    amount: total,
    timestamp: new Date().toISOString(),
    details: itemsBreakdown.map(i => `${i.name} x${i.quantity}`).join(', ')
  };

  CanteenState.bookings.push(newBooking);
  CanteenState.transactions.push(newTx);
  CanteenState.activeBooking = newBooking;

  CanteenState.cart = [];
  updateCartBadges();
  CanteenState.saveState();

  AppRouter.navigateTo('ticket');
}

// 4. Ticket Page Render
function renderTicketPage() {
  const b = CanteenState.activeBooking;
  if (!b) {
    AppRouter.navigateTo('home');
    return;
  }

  document.getElementById('ticket-id').innerText = b.id;
  document.getElementById('ticket-cust-name').innerText = b.customerName;
  document.getElementById('ticket-cust-phone').innerText = b.customerPhone;
  document.getElementById('ticket-time').innerText = new Date(b.bookingTime).toLocaleString();

  const itemsContainer = document.getElementById('ticket-items-list');
  itemsContainer.innerHTML = '';
  
  b.items.forEach(i => {
    const row = document.createElement('div');
    row.className = 'ticket-item-row';
    row.innerHTML = `
      <span>${i.name} <span class="qty">x${i.quantity}</span></span>
      <span>₹${i.price * i.quantity}</span>
    `;
    itemsContainer.appendChild(row);
  });

  const tax = 0;
  const sub = b.totalAmount;
  document.getElementById('ticket-subtotal').innerText = `₹${sub}`;
  document.getElementById('ticket-tax').innerText = `₹${tax}`;
  document.getElementById('ticket-total').innerText = `₹${b.totalAmount}`;

  renderTicketBarcode(b);
  document.getElementById('barcode-num-text').innerText = b.id;

  // Bind new Download Ticket button click event
  const downloadBtn = document.getElementById('btn-download-ticket');
  if (downloadBtn) {
    downloadBtn.onclick = () => {
      downloadReceipt(b);
    };
  }

  // Clear any existing countdown timer
  if (CanteenState.ticketTimerInterval) {
    clearInterval(CanteenState.ticketTimerInterval);
  }

  const tick = () => {
    CanteenState.loadState(); // Sync database state in real-time
    const currentBooking = CanteenState.bookings.find(x => x.id === b.id);
    if (!currentBooking) return;

    const overlayExpired = document.getElementById('ticket-overlay-expired');
    const overlayRedeemed = document.getElementById('ticket-overlay-redeemed');
    const timerDisplay = document.getElementById('ticket-timer-display');

    if (currentBooking.status === 'redeemed') {
      overlayRedeemed.style.display = 'flex';
      overlayExpired.style.display = 'none';
      timerDisplay.style.display = 'none';
      clearInterval(CanteenState.ticketTimerInterval);
      CanteenState.ticketTimerInterval = null;
      return;
    }

    const expiry = new Date(currentBooking.expiryTime || (new Date(currentBooking.bookingTime).getTime() + 5 * 3600 * 1000));
    const now = new Date();
    const remainingMs = expiry - now;

    if (remainingMs <= 0) {
      overlayExpired.style.display = 'flex';
      overlayRedeemed.style.display = 'none';
      timerDisplay.style.display = 'none';
      clearInterval(CanteenState.ticketTimerInterval);
      CanteenState.ticketTimerInterval = null;
      return;
    }

    // Update real-time countdown timer display
    timerDisplay.style.display = 'flex';
    overlayExpired.style.display = 'none';
    overlayRedeemed.style.display = 'none';

    const hours = Math.floor(remainingMs / 3600000);
    const minutes = Math.floor((remainingMs % 3600000) / 60000);
    const seconds = Math.floor((remainingMs % 60000) / 1000);
    document.getElementById('ticket-timer-counter').innerText = 
      [hours, minutes, seconds].map(v => v.toString().padStart(2, '0')).join(':');
  };

  tick(); // execute instantly
  CanteenState.ticketTimerInterval = setInterval(tick, 1000);
}

// Generate a compact 20-character alphanumeric ticket ID.
function generateTicketToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = 'NC-';
  for (let i = 0; i < 17; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

// Encode booking object into a self-contained string for barcode scanning
function encodeBookingToBarcodeText(b) {
  const data = {
    id: b.id,
    cName: b.customerName,
    cPhone: b.customerPhone,
    pk: b.passkey,
    items: b.items.map(i => ({
      fid: i.foodItemId,
      name: i.name,
      qty: i.quantity,
      price: i.price
    })),
    total: b.totalAmount,
    pMethod: b.paymentMethod,
    pStatus: b.paymentStatus,
    bTime: b.bookingTime,
    eTime: b.expiryTime,
    status: b.status
  };
  // Base64 encoding supporting Unicode characters safely
  return "NC-DATA:" + btoa(unescape(encodeURIComponent(JSON.stringify(data))));
}

// Decode booking object from barcode text
function decodeBookingFromBarcodeText(barcodeText) {
  if (!barcodeText || !barcodeText.startsWith("NC-DATA:")) return null;
  try {
    const base64 = barcodeText.substring(8);
    const jsonStr = decodeURIComponent(escape(atob(base64)));
    const data = JSON.parse(jsonStr);
    return {
      id: data.id,
      customerName: data.cName,
      customerPhone: data.cPhone,
      passkey: data.pk,
      items: data.items.map(i => ({
        foodItemId: i.fid,
        name: i.name,
        quantity: i.qty,
        price: i.price
      })),
      totalAmount: data.total,
      paymentMethod: data.pMethod,
      paymentStatus: data.pStatus,
      bookingTime: data.bTime,
      expiryTime: data.eTime,
      status: data.status,
      redeemedTime: null
    };
  } catch (e) {
    console.error("Failed to decode booking barcode text:", e);
    return null;
  }
}

// Generate CODE128 barcode canvas using JsBarcode.
function renderTicketBarcode(booking) {
  const canvas = document.getElementById('ticket-barcode-canvas');
  if (!canvas) return;
  try {
    JsBarcode(canvas, booking.id, {
      format: 'CODE128',
      lineColor: '#1b4d3e',
      background: '#ffffff',
      width: 1,
      height: 96,
      displayValue: false,
      margin: 8
    });
  } catch (e) {
    console.error("Failed to render ticket barcode:", e);
  }
}

// --- SCANNER VIEW LOGIC ---

let html5QrCode = null;

function initScannerView() {
  document.getElementById('barcode-scan-input').value = '';
  
  // Start webcam scanner
  stopScannerCamera().then(() => {
    startScannerCamera();
  });
}

function startScannerCamera() {
  return new Promise((resolve) => {
    const barcodeReader = document.getElementById('barcode-reader');
    if (!barcodeReader) {
      resolve();
      return;
    }

    try {
      html5QrCode = new Html5Qrcode("barcode-reader");
      const config = {
        fps: 15,
        qrbox: { width: 320, height: 140 },
        formatsToSupport: [Html5QrcodeSupportedFormats.CODE_128]
      };

      Html5Qrcode.getCameras().then(devices => {
        if (devices && devices.length > 0) {
          // Detect if back camera is available (for mobile), otherwise use default first camera (for PC)
          let cameraId = devices[0].id;
          const backCam = devices.find(d => {
            const lbl = d.label.toLowerCase();
            return lbl.includes('back') || lbl.includes('environment') || lbl.includes('rear');
          });
          if (backCam) {
            cameraId = backCam.id;
          }

          html5QrCode.start(
            cameraId,
            config,
            (decodedText, decodedResult) => {
              console.log("Barcode scanned successfully:", decodedText);
              document.getElementById('barcode-scan-input').value = decodedText;
              triggerScan(decodedText);
            },
            (errorMessage) => {
              // Frame scanner warnings (safe to ignore)
            }
          ).then(() => {
            resolve();
          }).catch(err => {
            console.warn("Html5Qrcode start failed with device ID:", err);
            startScannerWithFacingMode(config, barcodeReader, resolve);
          });
        } else {
          startScannerWithFacingMode(config, barcodeReader, resolve);
        }
      }).catch(err => {
        console.warn("Failed to get cameras:", err);
        startScannerWithFacingMode(config, barcodeReader, resolve);
      });
    } catch (e) {
      console.error("HTML5-QRCode scanner startup crash:", e);
      resolve();
    }
  });
}

function startScannerWithFacingMode(config, barcodeReader, resolve) {
  html5QrCode.start(
    { facingMode: "user" },
    config,
    (decodedText, decodedResult) => {
      console.log("Barcode scanned successfully:", decodedText);
      document.getElementById('barcode-scan-input').value = decodedText;
      triggerScan(decodedText);
    },
    (errorMessage) => {}
  ).then(() => {
    resolve();
  }).catch(err => {
    console.warn("Camera scan permissions denied/unsupported:", err);
    barcodeReader.innerHTML = `
      <div style="padding: 2rem; font-size: 0.85rem; color: var(--text-muted); text-align: center;">
        <i class="fas fa-camera-slash" style="font-size: 1.8rem; margin-bottom: 0.5rem; color: var(--danger);"></i>
        <p>Live barcode webcam reader unavailable.</p>
        <p style="font-size: 0.75rem; margin-top: 0.25rem;">Use manual entry fallback input.</p>
      </div>
    `;
    resolve();
  });
}

function stopScannerCamera() {
  return new Promise((resolve) => {
    if (html5QrCode && html5QrCode.isScanning) {
      html5QrCode.stop().then(() => {
        html5QrCode.clear();
        html5QrCode = null;
        resolve();
      }).catch(err => {
        console.error("Camera stop failed:", err);
        html5QrCode = null;
        resolve();
      });
    } else {
      html5QrCode = null;
      resolve();
    }
  });
}



document.getElementById('scanner-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = document.getElementById('barcode-scan-input').value.trim();
  if (code) {
    triggerScan(code);
  } else {
    alert('Please enter a barcode.');
  }
});

function triggerScan(code) {
  const scannerPrompt = document.getElementById('scanner-prompt-text');
  scannerPrompt.innerText = 'Verifying ticket barcode...';

  // Stop scanner to avoid multiple scans
  stopScannerCamera();

  setTimeout(() => {
    CanteenState.loadState();
    
    let booking = CanteenState.bookings.find(b => b.id.toLowerCase() === code.toLowerCase().trim());
    
    // Auto-decode self-contained booking data if not found in local DB
    if (!booking && code.startsWith("NC-DATA:")) {
      const decodedBooking = decodeBookingFromBarcodeText(code);
      if (decodedBooking) {
        const exists = CanteenState.bookings.find(b => b.id.toLowerCase() === decodedBooking.id.toLowerCase());
        if (!exists) {
          CanteenState.bookings.push(decodedBooking);
          
          const newTx = {
            id: 'TX-' + Math.floor(20000 + Math.random() * 80000).toString(),
            type: 'sale',
            title: `Order Placed - ${decodedBooking.customerName}`,
            amount: decodedBooking.totalAmount,
            timestamp: decodedBooking.bookingTime,
            details: decodedBooking.items.map(i => `${i.name} x${i.quantity}`).join(', ')
          };
          CanteenState.transactions.push(newTx);
          CanteenState.saveState();
        }
        booking = exists || decodedBooking;
      }
    }
    
    const feedbackSuccess = document.getElementById('scan-feedback-success');
    const feedbackError = document.getElementById('scan-feedback-error');
    const feedbackWarning = document.getElementById('scan-feedback-warning');

    feedbackSuccess.style.display = 'none';
    feedbackError.style.display = 'none';
    feedbackWarning.style.display = 'none';

    if (!booking) {
      const isUpiLink = code.startsWith("upi://pay") || code.includes("upi://pay");
      if (isUpiLink) {
        document.querySelector('#scan-feedback-error .scan-feedback-title').innerText = 'PAYMENT QR DETECTED';
        document.querySelector('#scan-feedback-error .scan-feedback-desc').innerText = 'This is a payment gateway QR, not an order ticket. Please simulate UPI payment success first to generate the ticket barcode, then scan that ticket here.';
      } else {
        document.querySelector('#scan-feedback-error .scan-feedback-title').innerText = 'INVALID BARCODE';
        document.querySelector('#scan-feedback-error .scan-feedback-desc').innerText = 'Ticket ID not found in database.';
      }
      feedbackError.style.display = 'flex';
      setTimeout(() => {
        feedbackError.style.display = 'none';
        scannerPrompt.innerText = 'Align barcode inside screen viewport';
        startScannerCamera();
      }, isUpiLink ? 6000 : 2000);
      return;
    }

    // Check expiration block (5 hours)
    const expiry = new Date(booking.expiryTime || (new Date(booking.bookingTime).getTime() + 5 * 3600 * 1000));
    if (Date.now() > expiry && booking.status !== 'redeemed') {
      document.querySelector('#scan-feedback-error .scan-feedback-title').innerText = 'TICKET EXPIRED';
      document.querySelector('#scan-feedback-error .scan-feedback-desc').innerText = 'Rejection: ticket expired past the 5-hour limit.';
      feedbackError.style.display = 'flex';
      setTimeout(() => {
        feedbackError.style.display = 'none';
        scannerPrompt.innerText = 'Align barcode inside screen viewport';
        startScannerCamera();
      }, 3500);
      return;
    }

    if (booking.status === 'redeemed') {
      document.getElementById('warning-redeemed-time').innerText = new Date(booking.redeemedTime).toLocaleString();
      feedbackWarning.style.display = 'flex';
      setTimeout(() => {
        feedbackWarning.style.display = 'none';
        scannerPrompt.innerText = 'Align barcode inside screen viewport';
        startScannerCamera();
      }, 3000);
      return;
    }

    // Automatic Redemption and Print Receipt trigger
    redeemBookingOrder(booking);
    openReceiptPopup(booking);
    printBill(booking);

    feedbackSuccess.style.display = 'flex';
    setTimeout(() => {
      feedbackSuccess.style.display = 'none';
      scannerPrompt.innerText = 'Align barcode inside screen viewport';
      startScannerCamera();
    }, 3000);
  }, 1000);
}

function openReceiptPopup(booking) {
  const container = document.getElementById('receipt-popup-container');
  container.classList.add('active');

  document.getElementById('receipt-id').innerText = booking.id;
  document.getElementById('receipt-cust-name').innerText = booking.customerName;
  document.getElementById('receipt-cust-phone').innerText = booking.customerPhone;
  document.getElementById('receipt-time').innerText = new Date(booking.bookingTime).toLocaleString();

  const list = document.getElementById('receipt-items-list');
  list.innerHTML = '';
  booking.items.forEach(i => {
    const div = document.createElement('div');
    div.className = 'receipt-popup-item';
    div.innerHTML = `
      <span>${i.name} <span style="color: #6b7280; font-weight: normal;">x${i.quantity}</span></span>
      <span>₹${i.price * i.quantity}</span>
    `;
    list.appendChild(div);
  });

  const tax = 0;
  const sub = booking.totalAmount;
  document.getElementById('receipt-subtotal').innerText = `₹${sub}`;
  document.getElementById('receipt-tax').innerText = `₹${tax}`;
  document.getElementById('receipt-total').innerText = `₹${booking.totalAmount}`;

  // Bind Confirm Redemption button action
  const confirmBtn = document.getElementById('btn-receipt-confirm');
  confirmBtn.onclick = () => {
    downloadReceipt(booking);
    redeemBookingOrder(booking);
    closeReceiptPopup();
  };

  // Bind scanner pop-up receipt download action
  const dlBtn = document.getElementById('btn-receipt-download');
  if (dlBtn) {
    dlBtn.onclick = () => {
      downloadReceipt(booking);
    };
  }

}

function closeReceiptPopup() {
  document.getElementById('receipt-popup-container').classList.remove('active');
  initScannerView();
}

document.getElementById('btn-receipt-cancel').addEventListener('click', closeReceiptPopup);

function printBill(booking) {
  document.body.classList.add('printing-receipt');
  stopScannerCamera();
  window.setTimeout(() => window.print(), 50);
  window.onafterprint = () => {
    document.body.classList.remove('printing-receipt');
    document.getElementById('receipt-popup-container').classList.remove('active');
    document.getElementById('scan-feedback-success').style.display = 'none';
    document.getElementById('scanner-prompt-text').innerText = 'Align barcode inside screen viewport';
    initScannerView();
  };
}

function escapePrintText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function redeemBookingOrder(booking) {
  const targetBooking = CanteenState.bookings.find(b => b.id === booking.id);
  if (!targetBooking || targetBooking.status === 'redeemed') return;

  targetBooking.status = 'redeemed';
  targetBooking.redeemedTime = new Date().toISOString();

  const tx = CanteenState.transactions.find(t => t.title.includes(booking.customerName) && t.type === 'sale');
  if (tx) {
    tx.title = `Order Redeemed - ${booking.customerName}`;
    tx.timestamp = new Date().toISOString();
  }

  CanteenState.saveState();

  const successDiv = document.getElementById('scan-feedback-success');
  successDiv.style.display = 'flex';
  setTimeout(() => {
    successDiv.style.display = 'none';
  }, 2000);
}

// --- RECEIPT & BILL DOWNLOAD SYSTEM (.TXT GENERATOR) ---
function downloadReceipt(booking) {
  if (!booking) return;
  
  const itemsText = booking.items.map(i => `${i.name.padEnd(25)} x${i.quantity.toString().padEnd(3)} - ₹${i.price * i.quantity}`).join('\n');
  const tax = 0;
  const sub = booking.totalAmount;
  
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
Total Paid:     ₹${booking.totalAmount}
==================================================
        Thank you for ordering at N Cafe!
==================================================
`;

  // Create text blob download trigger
  const blob = new Blob([textReceiptContent], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `n_cafe_receipt_${booking.id}.txt`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}


// --- SIMPLIFIED ADMIN LOGIC (3 Parts) ---

// --- Part 1: Dashboard & Stock Entry ---
function renderAdminTab1() {
  const redeemed = CanteenState.bookings.filter(b => b.status === 'redeemed');
  const sales = redeemed.reduce((sum, b) => sum + b.totalAmount, 0);
  const expenses = CanteenState.transactions.filter(t => t.type === 'purchase').reduce((sum, t) => sum + t.amount, 0);
  const profit = sales - expenses;

  document.getElementById('tab1-sales-val').innerText = `₹${sales}`;
  document.getElementById('tab1-expenses-val').innerText = `₹${expenses}`;
  
  const profitSpan = document.getElementById('tab1-profit-val');
  profitSpan.innerText = `₹${profit}`;
  profitSpan.className = 'admin-card-val ' + (profit >= 0 ? 'income' : 'expense');

  const warningsList = document.getElementById('dashboard-stock-alerts-new');
  warningsList.innerHTML = '';
  let hasWarnings = false;

  CanteenState.foodItems.forEach(f => {
    if (f.stock <= 5) {
      hasWarnings = true;
      const box = document.createElement('div');
      box.className = 'alert-box';
      box.innerHTML = `
        <i class="fas fa-exclamation-triangle"></i>
        <div>
          <strong>Food Item Low:</strong> ${f.name} has only ${f.stock} portions remaining.
        </div>
      `;
      warningsList.appendChild(box);
    }
  });

  CanteenState.ingredients.forEach(i => {
    if (i.stock <= 10) {
      hasWarnings = true;
      const box = document.createElement('div');
      box.className = 'alert-box';
      box.style.borderColor = 'var(--text-amber)';
      box.innerHTML = `
        <i class="fas fa-boxes" style="color: var(--text-amber);"></i>
        <div>
          <strong>Ingredient Deficit:</strong> ${i.name} stock level at ${i.stock} ${i.unit}. Refill needed.
        </div>
      `;
      warningsList.appendChild(box);
    }
  });

  if (!hasWarnings) {
    warningsList.innerHTML = `
      <div style="text-align: center; color: var(--text-muted); padding: 1.5rem; border: 1px dashed var(--border-dark); border-radius: 12px;">
        <i class="fas fa-check-circle" style="color: var(--success); margin-right: 0.5rem;"></i> All raw materials are in healthy stock bounds.
      </div>
    `;
  }

  renderPOSCatalog();
  renderPOSCart();
}

document.getElementById('tab1-purchase-form').addEventListener('submit', (e) => {
  e.preventDefault();

  const id = document.getElementById('tab1-pur-ing-id').value;
  const qty = parseFloat(document.getElementById('tab1-pur-qty').value);
  const cost = parseFloat(document.getElementById('tab1-pur-cost').value);

  if (!id || isNaN(qty) || isNaN(cost) || qty <= 0 || cost <= 0) {
    alert('Please enter valid purchase details.');
    return;
  }

  const ing = CanteenState.ingredients.find(i => i.id === id);
  if (ing) {
    ing.stock = parseFloat((ing.stock + qty).toFixed(2));
    ing.lastPurchaseDate = new Date().toISOString();

    const newTx = {
      id: 'TX-' + Math.floor(30000 + Math.random() * 70000).toString(),
      type: 'purchase',
      title: `Raw Purchase - ${ing.name}`,
      amount: cost,
      timestamp: new Date().toISOString(),
      details: `Purchased ${qty} ${ing.unit} of ${ing.name}`
    };

    CanteenState.transactions.push(newTx);
    CanteenState.saveState();
    
    e.target.reset();
    renderAdminTab3();
    alert(`Logged purchase of ${qty} ${ing.unit} of ${ing.name} (₹${cost})`);
  }
});

document.getElementById('tab1-usage-form').addEventListener('submit', (e) => {
  e.preventDefault();

  const id = document.getElementById('tab1-use-ing-id').value;
  const qty = parseFloat(document.getElementById('tab1-use-qty').value);

  if (!id || isNaN(qty) || qty <= 0) {
    alert('Please enter valid usage details.');
    return;
  }

  const ing = CanteenState.ingredients.find(i => i.id === id);
  if (ing) {
    if (ing.stock < qty) {
      alert(`Insufficient stock. Only ${ing.stock} ${ing.unit} available.`);
      return;
    }

    ing.stock = parseFloat((ing.stock - qty).toFixed(2));

    const newTx = {
      id: 'TX-' + Math.floor(40000 + Math.random() * 60000).toString(),
      type: 'use',
      title: `Kitchen Usage - ${ing.name}`,
      amount: 0,
      timestamp: new Date().toISOString(),
      details: `Used ${qty} ${ing.unit} for cooking`
    };

    CanteenState.transactions.push(newTx);
    CanteenState.saveState();
    
    e.target.reset();
    renderAdminTab3();
    alert(`Logged kitchen usage of ${qty} ${ing.unit} of ${ing.name}.`);
  }
});


// --- Part 2: Daily Food & Billing ---

let posCartItems = [];

function renderAdminTab2() {
  const foodTbody = document.getElementById('tab2-menu-tbody');
  if (foodTbody) {
    foodTbody.innerHTML = '';
    CanteenState.foodItems.forEach(item => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><img src="${item.image}" alt="${item.name}" style="width: 35px; height: 35px; border-radius: 6px; object-fit: cover;" onerror="this.src='https://images.unsplash.com/photo-1589301760014-d929f3979dbc?w=100';"></td>
        <td><strong>${item.name}</strong></td>
        <td>₹${item.price}</td>
        <td>
          <div class="flex align-center gap-1">
            <input type="number" class="qty-adjust-input" id="tab2-stock-input-${item.id}" value="${item.stock}" min="0">
            <button class="btn-sm btn-sm-primary" onclick="updateItemStockTab2('${item.id}')">Set</button>
          </div>
        </td>
        <td>
          <button class="btn-sm btn-sm-danger" onclick="deleteFoodItemTab2('${item.id}')">
            <i class="fas fa-trash-alt"></i>
          </button>
        </td>
      `;
      foodTbody.appendChild(tr);
    });
  }

  // Populate report filter item dropdown
  const itemFilterSelect = document.getElementById('report-filter-item');
  if (itemFilterSelect) {
    const selectedVal = itemFilterSelect.value;
    itemFilterSelect.innerHTML = '<option value="All">All Items</option>';
    CanteenState.foodItems.forEach(item => {
      const opt = document.createElement('option');
      opt.value = item.id;
      opt.textContent = item.name;
      itemFilterSelect.appendChild(opt);
    });
    itemFilterSelect.value = selectedVal || 'All';
  }

  // Render Total Food Business Sales
  const businessTbody = document.getElementById('tab2-foodbusiness-tbody');
  if (businessTbody) {
    businessTbody.innerHTML = '';
    const sortedBookings = [...CanteenState.bookings].sort((a, b) => new Date(b.bookingTime) - new Date(a.bookingTime));
    
    // Apply filters
    let filteredBookings = sortedBookings;

    // 1. Food Item Filter
    const itemFilter = itemFilterSelect ? itemFilterSelect.value : 'All';
    if (itemFilter && itemFilter !== 'All') {
      filteredBookings = filteredBookings.filter(b => b.items.some(i => i.foodItemId === itemFilter));
    }

    // 2. Date Filter
    const dateFilter = document.getElementById('report-filter-date') ? document.getElementById('report-filter-date').value : '';
    if (dateFilter) {
      filteredBookings = filteredBookings.filter(b => {
        const d = new Date(b.bookingTime);
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        const localDateStr = `${year}-${month}-${day}`;
        return localDateStr === dateFilter;
      });
    }

    // 3. Min Amount Filter
    const amountFilterVal = document.getElementById('report-filter-amount') ? parseFloat(document.getElementById('report-filter-amount').value) : NaN;
    if (!isNaN(amountFilterVal) && amountFilterVal >= 0) {
      filteredBookings = filteredBookings.filter(b => b.totalAmount >= amountFilterVal);
    }

    if (filteredBookings.length === 0) {
      businessTbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 2rem;">
            No sales match the selected filters.
          </td>
        </tr>
      `;
    } else {
      filteredBookings.forEach(b => {
        let statusLabel = b.status || 'pending';
        let badgeClass = 'badge-success';
        if (b.status === 'pending') {
          const expiry = new Date(b.expiryTime || (new Date(b.bookingTime).getTime() + 5 * 3600 * 1000));
          if (Date.now() > expiry) {
            statusLabel = 'expired';
            badgeClass = 'badge-danger';
          } else {
            statusLabel = 'pending';
            badgeClass = 'badge-warning';
          }
        } else if (b.status === 'redeemed') {
          statusLabel = 'redeemed';
          badgeClass = 'badge-success';
        }

        const itemsPurchased = b.items.map(i => `${i.name} x${i.quantity}`).join('<br>');

        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>
            <div style="font-weight: 600;">${b.customerName}</div>
            <div style="font-size: 0.75rem; color: var(--text-muted);">${b.customerPhone}</div>
          </td>
          <td>${new Date(b.bookingTime).toLocaleDateString()} ${new Date(b.bookingTime).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</td>
          <td style="font-size: 0.85rem; line-height: 1.4;">${itemsPurchased}</td>
          <td style="font-weight: 700; color: var(--accent);">₹${b.totalAmount}</td>
          <td><span class="badge ${badgeClass}">${statusLabel.toUpperCase()}</span></td>
        `;
        businessTbody.appendChild(tr);
      });
    }
  }
}

function updateItemStockTab2(itemId) {
  const val = parseInt(document.getElementById(`tab2-stock-input-${itemId}`).value);
  if (isNaN(val) || val < 0) {
    alert('Please enter a valid stock value.');
    return;
  }
  const food = CanteenState.foodItems.find(f => f.id === itemId);
  if (food) {
    food.stock = val;
    CanteenState.saveState();
    renderAdminTab2();
    alert(`Stock for ${food.name} set to ${val}`);
  }
}

function deleteFoodItemTab2(itemId) {
  if (confirm('Delete this food item?')) {
    CanteenState.foodItems = CanteenState.foodItems.filter(f => f.id !== itemId);
    CanteenState.saveState();
    renderAdminTab2();
  }
}

document.getElementById('tab2-add-food-form').addEventListener('submit', (e) => {
  e.preventDefault();

  const name = document.getElementById('tab2-add-name').value.trim();
  const price = parseFloat(document.getElementById('tab2-add-price').value);
  const stock = parseInt(document.getElementById('tab2-add-stock').value);
  const category = document.getElementById('tab2-add-category').value;
  const isVeg = document.getElementById('tab2-add-isveg').value === 'true';
  const desc = document.getElementById('tab2-add-desc').value.trim();
  const image = document.getElementById('tab2-add-image').value;

  if (!name || isNaN(price) || isNaN(stock)) {
    alert('Please complete all form fields.');
    return;
  }

  const id = name.toLowerCase().replace(/[^a-z0-9]/g, '_');
  if (CanteenState.foodItems.find(f => f.id === id)) {
    alert('Food item already exists.');
    return;
  }

  const newItem = { id, name, price, stock, category, isVeg, desc, image };
  CanteenState.foodItems.push(newItem);
  CanteenState.saveState();

  e.target.reset();
  renderAdminTab2();
  alert(`${name} registered in N Cafe menu!`);
});

function renderPOSCatalog() {
  const container = document.getElementById('pos-food-catalog');
  container.innerHTML = '';

  CanteenState.foodItems.forEach(item => {
    const availableStock = CanteenState.getAvailableStock(item.id);
    const isOutOfStock = availableStock <= 0;
    const itemDiv = document.createElement('div');
    itemDiv.className = 'pos-catalog-item';
    itemDiv.innerHTML = `
      <div class="pos-catalog-info">
        <h5>${item.name}</h5>
        <p>Price: ₹${item.price} | Stock: ${availableStock} left</p>
      </div>
      <button class="btn-sm btn-sm-primary" onclick="addToPOSCart('${item.id}')" ${isOutOfStock ? 'disabled' : ''}>
        Add +
      </button>
    `;
    container.appendChild(itemDiv);
  });
}

function addToPOSCart(itemId) {
  const food = CanteenState.foodItems.find(f => f.id === itemId);
  const availableStock = CanteenState.getAvailableStock(itemId);
  if (!food || availableStock <= 0) return;

  const cartItem = posCartItems.find(i => i.id === itemId);
  if (cartItem) {
    if (cartItem.quantity < availableStock) {
      cartItem.quantity++;
    } else {
      alert('Cannot add more than available food stock.');
    }
  } else {
    posCartItems.push({ id: itemId, name: food.name, price: food.price, quantity: 1 });
  }

  renderPOSCart();
}

function updatePOSQty(itemId, change) {
  const cartItem = posCartItems.find(i => i.id === itemId);
  const food = CanteenState.foodItems.find(f => f.id === itemId);
  if (!cartItem || !food) return;

  const newQty = cartItem.quantity + change;
  const availableStock = CanteenState.getAvailableStock(itemId);
  if (newQty <= 0) {
    posCartItems = posCartItems.filter(i => i.id !== itemId);
  } else if (newQty > availableStock) {
    alert(`Only ${availableStock} portions are available.`);
  } else {
    cartItem.quantity = newQty;
  }

  renderPOSCart();
}

function renderPOSCart() {
  const list = document.getElementById('pos-cart-list');
  const subTotalSpan = document.getElementById('pos-subtotal');
  const taxSpan = document.getElementById('pos-tax');
  const totalSpan = document.getElementById('pos-total');
  const submitBtn = document.getElementById('btn-pos-submit');

  list.innerHTML = '';

  if (posCartItems.length === 0) {
    list.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 1rem;">Draft billing receipt is empty.</div>`;
    subTotalSpan.innerText = '₹0';
    taxSpan.innerText = '₹0';
    totalSpan.innerText = '₹0';
    submitBtn.disabled = true;
    return;
  }

  let subtotal = 0;
  posCartItems.forEach(item => {
    const itemTotal = item.price * item.quantity;
    subtotal += itemTotal;

    const row = document.createElement('div');
    row.className = 'pos-cart-item';
    row.innerHTML = `
      <div style="flex-grow: 1;">
        <strong>${item.name}</strong><br>
        <span style="color: var(--text-muted);">₹${item.price} each</span>
      </div>
      <div class="flex align-center gap-1" style="margin-right: 1.5rem;">
        <button type="button" class="qty-btn" onclick="updatePOSQty('${item.id}', -1)">-</button>
        <span>${item.quantity}</span>
        <button type="button" class="qty-btn" onclick="updatePOSQty('${item.id}', 1)">+</button>
      </div>
      <div style="font-weight: 600;">₹${itemTotal}</div>
    `;
    list.appendChild(row);
  });

  const tax = 0;
  const total = subtotal;

  subTotalSpan.innerText = `₹${subtotal}`;
  taxSpan.innerText = `₹${tax}`;
  totalSpan.innerText = `₹${total}`;
  submitBtn.disabled = false;
}

// POS counter bill checkout (with auto-download bill trigger)
document.getElementById('pos-billing-form').addEventListener('submit', (e) => {
  e.preventDefault();

  if (posCartItems.length === 0) return;

  const name = document.getElementById('pos-cust-name').value.trim() || 'Walk-in Guest';
  const phone = document.getElementById('pos-cust-phone').value.trim() || '0000000000';

  let subtotal = 0;
  const items = [];
  
  posCartItems.forEach(cItem => {
    const food = CanteenState.foodItems.find(f => f.id === cItem.id);
    subtotal += food.price * cItem.quantity;
    food.stock -= cItem.quantity;

    items.push({
      foodItemId: food.id,
      name: food.name,
      quantity: cItem.quantity,
      price: food.price
    });
  });

  const tax = 0;
  const total = subtotal;
  const bookingId = generateTicketToken();

  const newBooking = {
    id: bookingId,
    customerName: name,
    customerPhone: phone,
    passkey: '0000',
    items,
    totalAmount: total,
    paymentMethod: 'Cash (Counter)',
    paymentStatus: 'Paid',
    bookingTime: new Date().toISOString(),
    expiryTime: new Date(Date.now() + 5 * 3600 * 1000).toISOString(),
    status: 'redeemed',
    redeemedTime: new Date().toISOString()
  };

  const newTx = {
    id: 'TX-' + Math.floor(20000 + Math.random() * 80000).toString(),
    type: 'sale',
    title: `POS Counter Bill - ${name}`,
    amount: total,
    timestamp: new Date().toISOString(),
    details: items.map(i => `${i.name} x${i.quantity}`).join(', ')
  };

  CanteenState.bookings.push(newBooking);
  CanteenState.transactions.push(newTx);
  CanteenState.saveState();

  // Trigger auto-download bill receipt for staff
  downloadReceipt(newBooking);

  posCartItems = [];
  e.target.reset();
  
  renderAdminTab1();
  alert(`POS Invoice Created! Token: ${bookingId}.\nReceipt file has been automatically compiled and downloaded.`);
});


// --- Part 3: Full Inventory, Invoices, & Bank Details ---

function renderAdminTab3() {
  const ingTableBody = document.getElementById('tab3-ingredients-tbody');
  if (ingTableBody) {
    ingTableBody.innerHTML = '';
    CanteenState.ingredients.forEach(i => {
      const tr = document.createElement('tr');
      const formattedDate = i.lastPurchaseDate ? new Date(i.lastPurchaseDate).toLocaleString() : 'N/A';
      tr.innerHTML = `
        <td><strong>${i.name}</strong></td>
        <td>${i.id}</td>
        <td style="font-size: 1.05rem; font-weight: 700;">${i.stock} ${i.unit}</td>
        <td style="font-size: 0.85rem; color: var(--text-muted);">${formattedDate}</td>
        <td><span class="badge ${i.stock <= 10 ? 'badge-warning' : 'badge-success'}">${i.stock <= 10 ? 'Low Stock' : 'Good'}</span></td>
      `;
      ingTableBody.appendChild(tr);
    });
  }

  const purSelect = document.getElementById('tab1-pur-ing-id');
  const useSelect = document.getElementById('tab1-use-ing-id');
  
  if (purSelect && useSelect) {
    purSelect.innerHTML = '<option value="">-- Choose Material --</option>';
    useSelect.innerHTML = '<option value="">-- Choose Material --</option>';

    CanteenState.ingredients.forEach(i => {
      const opt = `<option value="${i.id}">${i.name} (${i.unit})</option>`;
      purSelect.innerHTML += opt;
      useSelect.innerHTML += opt;
    });
  }
}

function renderAdminTab4() {
  const ledgerBody = document.getElementById('tab3-transactions-tbody');
  if (!ledgerBody) return;
  ledgerBody.innerHTML = '';
  
  const masterCB = document.getElementById('ledger-select-all');
  if (masterCB) masterCB.checked = false;

  const sorted = [...CanteenState.transactions].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  sorted.forEach(t => {
    const isSale = t.type === 'sale';
    const amountVal = isSale ? `+₹${t.amount}` : (t.type === 'purchase' ? `-₹${t.amount}` : '₹0');
    const badgeClass = isSale ? 'badge-success' : (t.type === 'purchase' ? 'badge-danger' : 'badge-warning');

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="text-align: center;">
        <input type="checkbox" class="ledger-row-select" data-txid="${t.id}" onclick="updateMasterLedgerCheckbox()">
      </td>
      <td>${new Date(t.timestamp).toLocaleDateString()} ${new Date(t.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</td>
      <td>
        <div style="font-weight: 600;">${t.title}</div>
        <div style="font-size: 0.75rem; color: var(--text-muted);">${t.details || ''}</div>
      </td>
      <td><span class="badge ${badgeClass}">${t.type}</span></td>
      <td style="font-weight: 700;" class="${isSale ? 'text-green' : (t.type === 'purchase' ? 'text-danger' : 'text-muted')}">${amountVal}</td>
      <td style="text-align: center;">
        <button class="btn-ledger-action edit-btn" onclick="editLedgerTransaction('${t.id}')" title="Edit Entry">
          <i class="fas fa-edit"></i>
        </button>
        <button class="btn-ledger-action delete-btn" onclick="deleteLedgerTransaction('${t.id}')" title="Delete Entry">
          <i class="fas fa-trash-alt"></i>
        </button>
      </td>
    `;
    ledgerBody.appendChild(tr);
  });

  renderAccountSettings();
}

function renderAccountSettings() {
  const acc = CanteenState.accountDetails;
  document.getElementById('acc-name-input').value = acc.name;
  document.getElementById('acc-bank-input').value = acc.bank;
  document.getElementById('acc-no-input').value = acc.accNo;
  document.getElementById('acc-ifsc-input').value = acc.ifsc;
  document.getElementById('acc-upi-input').value = acc.upiId;

  // Prefill security credentials inputs
  document.getElementById('cred-admin-pwd').value = CanteenState.adminPassword;
  document.getElementById('cred-scanner-pin').value = CanteenState.scannerPin;
}

function editLedgerTransaction(txId) {
  const tx = CanteenState.transactions.find(t => t.id === txId);
  if (!tx) return;

  const newAmount = prompt(`Edit cash value for transaction:\n"${tx.title}"`, tx.amount);
  if (newAmount === null) return;

  const parsed = parseFloat(newAmount);
  if (isNaN(parsed) || parsed < 0) {
    alert('Please enter a valid cash value.');
    return;
  }

  const newDetails = prompt(`Edit transaction descriptions:`, tx.details || '');
  if (newDetails === null) return;

  tx.amount = parsed;
  tx.details = newDetails.trim();
  
  CanteenState.saveState();
  renderAdminTab4();
  alert('Transaction entry updated successfully.');
}

function deleteLedgerTransaction(txId) {
  const tx = CanteenState.transactions.find(t => t.id === txId);
  if (!tx) return;

  if (confirm(`Are you sure you want to permanently delete this transaction entry?\n"${tx.title}" (₹${tx.amount})`)) {
    CanteenState.transactions = CanteenState.transactions.filter(t => t.id !== txId);
    CanteenState.saveState();
    renderAdminTab4();
    alert('Transaction record removed.');
  }
}

function exportLedgerToCSV() {
  if (CanteenState.transactions.length === 0) {
    alert('No transactions in database to export.');
    return;
  }

  // Find checked transaction rows
  const checkedBoxes = document.querySelectorAll('.ledger-row-select:checked');
  let targets = [];

  if (checkedBoxes.length === 0) {
    if (!confirm('No rows selected. Export all transactions?')) {
      return;
    }
    // Export all sorted transactions
    targets = [...CanteenState.transactions].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  } else {
    // Export checked transactions
    const checkedIds = Array.from(checkedBoxes).map(cb => cb.dataset.txid);
    targets = CanteenState.transactions.filter(t => checkedIds.includes(t.id));
  }

  // Save selected transactions for column export and show column selector modal
  CanteenState.pendingExportTransactions = targets;
  AppRouter.openColumnModal();
}

function exportInventoryToCSV() {
  if (CanteenState.ingredients.length === 0) {
    alert('No ingredients in database to export.');
    return;
  }

  let csvContent = "data:text/csv;charset=utf-8,";
  csvContent += "Material ID,Material Name,Stock Level,Unit,Last Purchased,Status\n";

  CanteenState.ingredients.forEach(i => {
    const status = i.stock <= 10 ? 'Low Stock' : 'Good';
    const purchaseDate = i.lastPurchaseDate ? new Date(i.lastPurchaseDate).toLocaleString().replace(/,/g, '') : 'N/A';
    const row = [
      i.id,
      i.name.replace(/,/g, ';'),
      i.stock,
      i.unit,
      purchaseDate,
      status
    ];
    csvContent += row.join(",") + "\n";
  });

  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", "n_cafe_inventory_report.csv");
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

document.getElementById('tab3-account-form').addEventListener('submit', (e) => {
  e.preventDefault();

  CanteenState.accountDetails = {
    name: document.getElementById('acc-name-input').value.trim(),
    bank: document.getElementById('acc-bank-input').value.trim(),
    accNo: document.getElementById('acc-no-input').value.trim(),
    ifsc: document.getElementById('acc-ifsc-input').value.trim(),
    upiId: document.getElementById('acc-upi-input').value.trim()
  };

  CanteenState.saveState();
  alert('Account Settings Saved!');
});

const credForm = document.getElementById('tab4-credentials-form');
if (credForm) {
  credForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const pwd = document.getElementById('cred-admin-pwd').value.trim();
    const pin = document.getElementById('cred-scanner-pin').value.trim();
    
    if (pwd.length < 6) {
      alert('Admin password must be at least 6 characters.');
      return;
    }
    if (!/^\d{4}$/.test(pin)) {
      alert('Scanner PIN must be exactly 4 digits.');
      return;
    }
    
    CanteenState.adminPassword = pwd;
    CanteenState.scannerPin = pin;
    AppRouter.passcodeState.correctPINs.scanner = pin;
    CanteenState.saveState();
    alert('Security Credentials Updated Successfully!');
    AppRouter.toggleCredentialsPanel();
  });
}

// Initial Kick-off
document.addEventListener('DOMContentLoaded', () => {
  CanteenState.init();
  AppRouter.init();
  GDriveSync.init();

  // Periodically clean up expired stock locks in background (similar to BookMyShow backend release)
  setInterval(() => {
    const initialCount = (CanteenState.lockedStock || []).length;
    CanteenState.releaseExpiredLocks();
    const finalCount = (CanteenState.lockedStock || []).length;
    
    // If locks were released, refresh active views to restore catalog stock figures
    if (finalCount !== initialCount) {
      if (AppRouter.currentTab === 'home') {
        const activeCat = document.querySelector('.cat-btn.active');
        const searchVal = document.getElementById('search-food').value;
        renderFoodMenu(activeCat ? activeCat.dataset.category : 'all', searchVal);
      }
      if (AppRouter.currentRole === 'scanner') {
        renderPOSCatalog();
      }
    }
  }, 10000); // Check every 10 seconds
});

// Checkbox selection global helpers (NEW)
function toggleSelectAllLedger(master) {
  const checkboxes = document.querySelectorAll('.ledger-row-select');
  checkboxes.forEach(cb => {
    cb.checked = master.checked;
  });
}

function updateMasterLedgerCheckbox() {
  const checkboxes = document.querySelectorAll('.ledger-row-select');
  const master = document.getElementById('ledger-select-all');
  if (checkboxes.length === 0) {
    if (master) master.checked = false;
    return;
  }
  const allChecked = Array.from(checkboxes).every(cb => cb.checked);
  if (master) master.checked = allChecked;
}

// --- GOOGLE DRIVE DATABASE SYNC SYSTEM ---
const GDriveSync = {
  accessToken: null,
  tokenExpiry: null,
  fileId: null,

  pollInterval: null,

  init() {
    const savedClientId = localStorage.getItem('nc_gdrive_client_id') || '';
    const savedAutoSync = localStorage.getItem('nc_gdrive_auto_sync') === 'true';

    const clientInput = document.getElementById('gdrive-client-id');
    const autoSyncInput = document.getElementById('gdrive-auto-sync');

    if (clientInput) clientInput.value = savedClientId;
    if (autoSyncInput) autoSyncInput.checked = savedAutoSync;

    this.updateUIStatus();
    this.startBackgroundPoll();
  },

  startBackgroundPoll() {
    if (this.pollInterval) clearInterval(this.pollInterval);
    
    this.pollInterval = setInterval(async () => {
      if (this.accessToken && new Date() < this.tokenExpiry && this.fileId) {
        const autoSyncCheck = document.getElementById('gdrive-auto-sync');
        if (autoSyncCheck && autoSyncCheck.checked) {
          try {
            const res = await fetch(`https://www.googleapis.com/drive/v3/files/${this.fileId}?alt=media`, {
              headers: { 'Authorization': `Bearer ${this.accessToken}` }
            });
            if (res.ok) {
              const text = await res.text();
              CanteenState.mergeStateJSON(text);
            }
          } catch (err) {
            console.error('Error during background Google Drive sync poll:', err);
          }
        }
      }
    }, 1000); // Poll every 1 second for real-time background sync
  },

  updateUIStatus() {
    const statusText = document.getElementById('gdrive-sync-status');
    const connectBtn = document.getElementById('btn-gdrive-connect');
    const syncBtn = document.getElementById('btn-gdrive-sync');

    if (!statusText) return;

    if (this.accessToken && new Date() < this.tokenExpiry) {
      statusText.textContent = "Connected";
      statusText.style.color = "#34A853";
      if (connectBtn) {
        connectBtn.innerHTML = '<i class="fas fa-sign-out-alt"></i> Disconnect';
        connectBtn.style.background = '#ea4335';
        connectBtn.style.color = '#fff';
        connectBtn.onclick = () => this.disconnect();
      }
      if (syncBtn) syncBtn.removeAttribute('disabled');
    } else {
      statusText.textContent = "Disconnected";
      statusText.style.color = "var(--text-muted)";
      if (connectBtn) {
        connectBtn.innerHTML = '<i class="fab fa-google"></i> Connect Drive';
        connectBtn.style.background = '#4285F4';
        connectBtn.style.color = '#fff';
        connectBtn.onclick = () => this.connect();
      }
      if (syncBtn) syncBtn.setAttribute('disabled', 'true');
    }
  },

  disconnect() {
    this.accessToken = null;
    this.tokenExpiry = null;
    this.fileId = null;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.updateUIStatus();
    alert('Disconnected from Google Drive.');
  },

  connect() {
    const clientId = document.getElementById('gdrive-client-id').value.trim();
    if (!clientId) {
      alert('Please enter your Google OAuth Client ID first. See instructions in settings page.');
      return;
    }

    localStorage.setItem('nc_gdrive_client_id', clientId);

    try {
      const tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: 'https://www.googleapis.com/auth/drive.file',
        callback: async (tokenResponse) => {
          if (tokenResponse && tokenResponse.access_token) {
            this.accessToken = tokenResponse.access_token;
            // Token valid for ~1 hour
            this.tokenExpiry = new Date(Date.now() + 3500 * 1000); 
            this.updateUIStatus();
            alert('Successfully authenticated! Querying Google Drive for database file...');
            await this.findOrCreateDatabaseFile();
          } else {
            alert('Google Drive connection was cancelled.');
          }
        }
      });

      tokenClient.requestAccessToken({ prompt: 'consent' });
    } catch (err) {
      console.error(err);
      alert('Failed to launch Google Login Client. Verify that your Google OAuth Client ID is correct.');
    }
  },

  async findOrCreateDatabaseFile() {
    const statusText = document.getElementById('gdrive-sync-status');
    if (statusText) statusText.textContent = "Locating database file...";

    try {
      const res = await fetch('https://www.googleapis.com/drive/v3/files?q=name%3D%27n_cafe_db.json%27+and+trashed%3Dfalse', {
        headers: { 'Authorization': `Bearer ${this.accessToken}` }
      });
      const data = await res.json();
      payload.id = data.bookingId;
      
      if (data.files && data.files.length > 0) {
        this.fileId = data.files[0].id;
        if (confirm('A database file named "n_cafe_db.json" was found on your Google Drive!\n\nClick OK to RESTORE and import data from Google Drive.\nClick CANCEL to overwrite Google Drive with your local dashboard data.')) {
          await this.pullFromDrive();
        } else {
          await this.pushToDrive();
          alert('Successfully uploaded local database to Google Drive!');
        }
      } else {
        if (confirm('No "n_cafe_db.json" database file was found on your Google Drive. Create a new one with your local data?')) {
          await this.createDatabaseFile();
        }
      }
      this.updateUIStatus();
    } catch (err) {
      console.error(err);
      alert('Error searching for database file on Google Drive.');
    }
  },

  async createDatabaseFile() {
    const statusText = document.getElementById('gdrive-sync-status');
    if (statusText) statusText.textContent = "Creating database file...";

    const metadata = {
      name: 'n_cafe_db.json',
      mimeType: 'application/json'
    };

    const localData = CanteenState.exportStateJSON();
    const boundary = 'foo_bar_boundary';
    const multipartBody = 
      `\r\n--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: application/json\r\n\r\n` +
      `${localData}\r\n` +
      `--${boundary}--`;

    try {
      const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': `multipart/related; boundary=${boundary}`
        },
        body: multipartBody
      });
      const data = await res.json();
      if (data.id) {
        this.fileId = data.id;
        alert('Database file successfully created in Google Drive root folder!');
      }
    } catch (err) {
      console.error(err);
      alert('Failed to create database file in Google Drive.');
    }
  },

  async pushToDrive() {
    if (!this.fileId) return;
    const statusText = document.getElementById('gdrive-sync-status');
    if (statusText) statusText.textContent = "Syncing upload...";

    const localData = CanteenState.exportStateJSON();

    try {
      const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${this.fileId}?uploadType=media`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: localData
      });
      if (res.ok) {
        const now = new Date().toLocaleTimeString();
        if (statusText) {
          statusText.textContent = `Synced: Uploaded at ${now}`;
          statusText.style.color = "#34A853";
        }
      } else {
        console.error('Upload sync failed');
      }
    } catch (err) {
      console.error('Error uploading sync:', err);
    }
  },

  async pullFromDrive() {
    if (!this.fileId) return;
    const statusText = document.getElementById('gdrive-sync-status');
    if (statusText) statusText.textContent = "Syncing download...";

    try {
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${this.fileId}?alt=media`, {
        headers: { 'Authorization': `Bearer ${this.accessToken}` }
      });
      
      if (res.ok) {
        const text = await res.text();
        const success = CanteenState.importStateJSON(text);
        if (success) {
          const now = new Date().toLocaleTimeString();
          if (statusText) {
            statusText.textContent = `Synced: Downloaded at ${now}`;
            statusText.style.color = "#34A853";
          }
          alert('Database successfully synchronized and restored from Google Drive!');
          window.location.reload();
        }
      } else {
        alert('Failed to download database file.');
      }
    } catch (err) {
      console.error(err);
      alert('Error downloading sync from Google Drive.');
    }
  },

  async manualSync() {
    if (!this.accessToken || new Date() > this.tokenExpiry) {
      alert('Google connection has expired. Please reconnect.');
      this.disconnect();
      return;
    }
    if (!this.fileId) {
      await this.findOrCreateDatabaseFile();
    } else {
      if (confirm('Upload local database modifications and overwrite Google Drive?')) {
        await this.pushToDrive();
        alert('Database upload sync complete!');
      }
    }
  },

  handleAutoSync() {
    const autoSyncCheck = document.getElementById('gdrive-auto-sync');
    const autoSync = autoSyncCheck && autoSyncCheck.checked;
    localStorage.setItem('nc_gdrive_auto_sync', autoSync ? 'true' : 'false');

    if (autoSync && this.accessToken && new Date() < this.tokenExpiry && this.fileId) {
      this.pushToDrive();
    }
  }
};
