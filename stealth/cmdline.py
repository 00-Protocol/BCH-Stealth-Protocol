#!/usr/bin/env python3
"""
Stealth Addresses Plugin — Command Line Interface
"""

from .plugin import StealthPlugin


class Plugin(StealthPlugin):
    """CLI wrapper — stealth logic lives in StealthPlugin base class."""
    pass
