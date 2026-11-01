# Mockup source

The source of `../cubilot-prototype.html` and of the claude.ai canvas "Cubilot Browser UI" (2026-10-28).

- `boards/`: one file for each canvas board (`*.dc.html`, desktop and phone, dark; `*Light.dc.html`, light) and `canvas.json` (board positions). They are design files with inline styles. They render in the claude.ai Design canvas; in a browser, use the prototype.
- `scripts/`: the Python scripts that make the boards and the prototype. `lib.py` and `hdr.py` hold the shared shell (top bar, tabs, status bar, phone bar). `g_*.py` make the screens, `light.py` makes the light boards and the canvas layout, `g_proto.py` makes the prototype.

The scripts have absolute paths of the session that made them. To use them again, change `P` and the paths at the top of `lib.py`, `light.py` and `g_proto.py`. Some screens (Decisions, Request, Ticket, Session, Room, and the first phone boards) were written by hand and then changed by the scripts; their board file is the source.
