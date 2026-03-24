#!/usr/bin/env python3
#
# Electron Cash - Stealth Addresses Plugin
# ECDH beaconless stealth addresses for Bitcoin Cash
#
# Uses BIP352 key derivation with 00 Protocol compatible ECDH
# Scanning via P2PKH pubkey indexer (zero-knowledge server)
#
# Copyright (C) 2026 0penw0rld / 00 Protocol
# MIT License

from electroncash.i18n import _

fullname = _('Stealth Addresses')
description = [
    _('Send and receive private payments using ECDH stealth addresses.'),
    "\n\n",
    _('Each payment creates a unique one-time address that cannot be linked to the receiver. '
      'Uses BIP352 key derivation and Nostr DM notifications for instant detection. '
      'Outputs look like regular P2PKH — no on-chain marker.'),
    "\n\n",
    _('Scanning powered by the P2PKH Pubkey Indexer — the server serves all pubkeys for a block range. '
      'It has zero knowledge of which keys you are looking for.'),
]
description_delimiter = ''
available_for = ['qt', 'cmdline']
default_on = False
