CargoRun UI Prototype v3.5

Open index.html in Chrome or Edge.

Updates in v3.5:
- Live Flight Board moved to its own dedicated screen.
- New Priority Cargo screen for outstanding critical/priority SHCs.
- Export flights no longer require supervisor signatures.
- Each ULD moved to At Aircraft is stamped with the current operator and timestamp.
- Prototype operator switch simulates Microsoft Entra identity from Azure.
- Finalising an export creates a digital completion record showing delivery operator + timestamp for every ULD.

Prototype data is stored in localStorage. Use Reset Demo to restore sample data.


v3.10 changes:
- Priority Cargo screen is inbound/import cargo only.
- Export ULDs are timestamped when they depart Warehouse (Warehouse -> Transit).
- Final export completion records show Warehouse Departure, Delivered By, and At Aircraft timestamps for each ULD.
