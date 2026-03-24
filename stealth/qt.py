#!/usr/bin/env python3
"""
Stealth Addresses Plugin — Qt GUI
Adds a Stealth tab to Electron Cash with paycode display, scanner, and stealth UTXO list.
"""

from PyQt5.QtWidgets import (QWidget, QVBoxLayout, QHBoxLayout, QLabel,
                             QPushButton, QTextEdit, QLineEdit, QProgressBar,
                             QGroupBox, QTableWidget, QTableWidgetItem,
                             QHeaderView, QSpinBox, QMessageBox)
from PyQt5.QtCore import Qt, QObject, pyqtSignal
from PyQt5.QtGui import QFont

from electroncash.plugins import hook
from electroncash.util import bh2u
from electroncash.i18n import _

from .plugin import StealthPlugin


class Plugin(StealthPlugin, QObject):
    """Qt GUI wrapper for the Stealth plugin."""

    scan_progress = pyqtSignal(float, int, int)  # pct, from_block, to_block
    scan_complete = pyqtSignal(int)  # num_found

    def __init__(self, parent, config, name):
        StealthPlugin.__init__(self, parent, config, name)
        QObject.__init__(self)
        self.windows = {}  # window -> stealth_tab widget

    @hook
    def init_qt(self, gui):
        """Called when plugin is enabled — add tab to all existing windows."""
        for window in gui.windows:
            self._add_stealth_tab(window)

    @hook
    def on_new_window(self, window):
        """Add Stealth tab when a new wallet window opens."""
        self._add_stealth_tab(window)

    @hook
    def on_close_window(self, window):
        """Clean up when window closes."""
        self.windows.pop(window, None)

    def _add_stealth_tab(self, window):
        """Add the stealth tab to a window if not already added."""
        if window in self.windows:
            return
        # Derive stealth keys for this wallet
        if hasattr(window, 'wallet') and window.wallet:
            self.load_wallet(window.wallet, window)
        tab = self._create_stealth_tab(window)
        window.tabs.addTab(tab, 'Stealth')
        self.windows[window] = tab

    def _create_stealth_tab(self, window) -> QWidget:
        """Build the Stealth tab UI."""
        widget = QWidget()
        layout = QVBoxLayout(widget)
        layout.setSpacing(16)

        wallet = window.wallet if hasattr(window, 'wallet') else None
        wallet_id = id(wallet) if wallet else None
        data = self.stealth_data.get(wallet_id) if wallet_id else None
        keys = data.get('keys') if data else None

        # ── Header ──
        header = QLabel(_('Stealth Addresses'))
        header.setFont(QFont('', 16, QFont.Bold))
        layout.addWidget(header)

        if not keys:
            no_keys = QLabel(_('Stealth requires a BIP39 seed phrase wallet.\n'
                              'This wallet does not support stealth addresses.'))
            no_keys.setStyleSheet('color: #ff6b6b; font-size: 14px;')
            layout.addWidget(no_keys)
            layout.addStretch()
            return widget

        # ── Paycode ──
        paycode_group = QGroupBox(_('Your Stealth Paycode'))
        paycode_layout = QVBoxLayout(paycode_group)

        paycode_label = QLabel(_('Share this paycode to receive stealth payments:'))
        paycode_layout.addWidget(paycode_label)

        paycode_text = QLineEdit(keys['paycode'])
        paycode_text.setReadOnly(True)
        paycode_text.setFont(QFont('Courier', 10))
        paycode_text.setStyleSheet('padding: 8px; background: #1c2128; color: #1DD9A5; border-radius: 4px;')
        paycode_layout.addWidget(paycode_text)

        copy_btn = QPushButton(_('Copy Paycode'))
        copy_btn.clicked.connect(lambda: window.app.clipboard().setText(keys['paycode']))
        paycode_layout.addWidget(copy_btn)

        layout.addWidget(paycode_group)

        # ── Balance ──
        balance_group = QGroupBox(_('Stealth Balance'))
        balance_layout = QHBoxLayout(balance_group)

        balance = self.get_stealth_balance(wallet)
        balance_label = QLabel(f'{balance / 1e8:.8f} BCH')
        balance_label.setFont(QFont('', 20, QFont.Bold))
        balance_layout.addWidget(balance_label)

        utxo_count = len(self.stealth_data.get(wallet_id, {}).get('utxos', []))
        count_label = QLabel(f'({utxo_count} UTXOs)')
        count_label.setStyleSheet('color: #8b949e;')
        balance_layout.addWidget(count_label)
        balance_layout.addStretch()

        layout.addWidget(balance_group)

        # ── Scanner ──
        scan_group = QGroupBox(_('Advanced Scan'))
        scan_layout = QVBoxLayout(scan_group)

        scan_desc = QLabel(_('Scan blocks for stealth payments via the P2PKH Pubkey Indexer.\n'
                            'The server has zero knowledge of which keys you are looking for.'))
        scan_desc.setWordWrap(True)
        scan_layout.addWidget(scan_desc)

        range_layout = QHBoxLayout()
        range_layout.addWidget(QLabel(_('From block:')))
        from_spin = QSpinBox()
        from_spin.setRange(1, 99999999)
        from_spin.setValue(943000)
        range_layout.addWidget(from_spin)
        range_layout.addWidget(QLabel(_('To block:')))
        to_spin = QSpinBox()
        to_spin.setRange(1, 99999999)
        to_spin.setValue(943400)
        range_layout.addWidget(to_spin)
        scan_layout.addLayout(range_layout)

        progress = QProgressBar()
        progress.setVisible(False)
        scan_layout.addWidget(progress)

        status_label = QLabel('')
        status_label.setStyleSheet('color: #8b949e; font-size: 11px;')
        scan_layout.addWidget(status_label)

        scan_btn = QPushButton(_('Start Scan'))

        def do_scan():
            scan_btn.setEnabled(False)
            scan_btn.setText(_('Scanning...'))
            progress.setVisible(True)
            progress.setValue(0)

            def on_progress(pct, fb, tb):
                progress.setValue(int(pct * 100))
                status_label.setText(f'Block {fb}-{tb}...')

            from_val = from_spin.value()
            to_val = to_spin.value()

            import threading
            def scan_thread():
                try:
                    found = self.scan_blocks(wallet, from_val, to_val)
                    from PyQt5.QtCore import QTimer
                    QTimer.singleShot(0, lambda: self._scan_done(window, found, scan_btn, progress, status_label, balance_label, count_label, table))
                except Exception as e:
                    err_msg = str(e)
                    from PyQt5.QtCore import QTimer
                    QTimer.singleShot(0, lambda: self._scan_error(err_msg, scan_btn, progress, status_label))

            t = threading.Thread(target=scan_thread, daemon=True)
            t.start()

        scan_btn.clicked.connect(do_scan)
        scan_layout.addWidget(scan_btn)

        layout.addWidget(scan_group)

        # ── UTXO List ──
        utxo_group = QGroupBox(_('Stealth UTXOs'))
        utxo_layout = QVBoxLayout(utxo_group)

        table = QTableWidget()
        table.setColumnCount(4)
        table.setHorizontalHeaderLabels([_('TXID'), _('Address'), _('Amount'), _('Height')])
        table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        table.setAlternatingRowColors(True)

        utxos = self.stealth_data.get(wallet_id, {}).get('utxos', [])
        table.setRowCount(len(utxos))
        for i, u in enumerate(utxos):
            txid = u.get('txid', '')
            table.setItem(i, 0, QTableWidgetItem(txid[:12] + '...' + txid[-6:] if len(txid) > 18 else txid))
            table.setItem(i, 1, QTableWidgetItem(str(u.get('addr', ''))[:20] + '...'))
            table.setItem(i, 2, QTableWidgetItem(f'{u.get("value", 0) / 1e8:.8f}'))
            table.setItem(i, 3, QTableWidgetItem(str(u.get('height', 0))))

        utxo_layout.addWidget(table)
        layout.addWidget(utxo_group)

        layout.addStretch()
        return widget

    def _scan_done(self, window, found, btn, progress, status, bal_label, count_label, table=None):
        btn.setEnabled(True)
        btn.setText(_('Start Scan'))
        progress.setValue(100)
        if found > 0:
            status.setText(f'Found {found} stealth UTXOs!')
            status.setStyleSheet('color: #1DD9A5; font-size: 11px;')
            # Update balance display
            wallet = window.wallet
            balance = self.get_stealth_balance(wallet)
            bal_label.setText(f'{balance / 1e8:.8f} BCH')
            utxos = self.stealth_data.get(id(wallet), {}).get('utxos', [])
            count_label.setText(f'({len(utxos)} UTXOs)')
            # Update UTXO table
            if table:
                table.setRowCount(len(utxos))
                for i, u in enumerate(utxos):
                    txid = u.get('txid', '')
                    from PyQt5.QtWidgets import QTableWidgetItem
                    table.setItem(i, 0, QTableWidgetItem(txid[:12] + '...' + txid[-6:] if len(txid) > 18 else txid))
                    table.setItem(i, 1, QTableWidgetItem(str(u.get('addr', ''))[:30] + '...'))
                    table.setItem(i, 2, QTableWidgetItem(f'{u.get("value", 0) / 1e8:.8f}'))
                    table.setItem(i, 3, QTableWidgetItem(str(u.get('height', 0))))
        else:
            status.setText(_('Scan complete — no new stealth UTXOs found'))
            status.setStyleSheet('color: #8b949e; font-size: 11px;')

    def _scan_error(self, error, btn, progress, status):
        btn.setEnabled(True)
        btn.setText(_('Start Scan'))
        progress.setVisible(False)
        status.setText(f'Error: {error}')
        status.setStyleSheet('color: #ff6b6b; font-size: 11px;')
