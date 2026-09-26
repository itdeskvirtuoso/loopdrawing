LOOP DRAWING GENERATOR
======================

Start:  double-click start.bat (or the desktop shortcut). The browser opens http://127.0.0.1:8765
Stop:   close the black "server" window.

How to use
1. Templates (menu "Templates")
   - Import your loop template DWG files together with the project FRAME.dwg: press "Choose DWG files" (or drop the
     files on the page). Any layout works - a DWG with CH1, CH2 ... texts is a template, any other DWG is the frame.
   - Each template is read on its own; the page lists what was found: IO type (AI / AO / RTD / DI / DO ...), wiring
     (2 / 4 wire), channels, header texts (IOP, IOTA, IO TYPE, LINK, MODULE NAME, IOM Number, TB / RTP name, system TB
     group, JB No.), FIELD TAG / DESCRIPTION of every channel, the terminal numbers next to every channel (system TB,
     marshalling TB, RTP, JB) and the sheet number / total of the frame.
   - A template may also be ONE channel per sheet (a DWG with a single CH1 and its own frame, e.g. "LOOP DRAWING FOR ANALOG
     INPUT"): the LABEL: / value texts (MODULE NO.: C1L1AI01, FIELD TAG: TAG ...), the IO type (from the title), the wiring
     (from the terminals) and the terminal columns are read the same way, and the workbook gives one sheet for every used
     channel row of a module (spare channels too, drawn as SPARE). It replaces range templates (CH1-16) of the same IO type and wiring.
   - The IO type of a template is decided by every text that names it (MODULE NO. C1L2DI01, TB name C1DITB01, IOM / IOTA
     part numbers, the title, the type label above the field device): the majority wins. When the title or the label
     disagrees (a DI drawing titled "DIGITAL OUTPUT"), it is corrected on every sheet and listed under "Template notes".
   - Only an AI one-channel template in the set? Then AO, DI and DO sheets are made from it (same drawing: AO = other title
     / type label, DI and DO = the instrument replaced by a field contact, no relay module) so that every channel of
     the workbook gets its sheet. They are listed as "(AO derived)" etc.; import your own AO / DI / DO template and it
     replaces the derived one.
   - Templates are kept in "template sets" (one per project). "Add to ..." puts more templates in the set in use
     (a file with the same name replaces the old one), "Create a new template set" starts another one.
     The set in use is chosen at the top right of the Templates page.
2. Excel
   - Press "Import Excel" (or drop the .xlsx on the page) and pick the IO ASSIGNMENT workbook.
   - The columns are found by their names, not by position (MODULE NAME, CHANNEL, CHANNEL NAME / FIELD TAG,
     DESCRIPTION, SIGNAL TYPE, MODULE PART NO / IOM MODEL NO, IOTA PART NO, LINK NO, IOM NO / MODULE NO,
     SYSTEM TB GROUP, TB1 / TB2, TB NAME + its TERMINAL NO columns, RTP NAME / RTB NAME + terminals (a DO relay box: name 'DORTB05A' and DOTERMINALNO1-4 = '13+' '13-' 'P13' 'O13', drawn as written; the relay number 'R13' comes from 'P13'), JB NAME + terminals ...).
   - Rows are grouped into modules: at every yellow row, or - when there are no yellow rows - by MODULE NAME.
   - Every module is drawn on the templates of the set that match its IO type and wiring (2-wire / 4-wire channels of
     one AI module get one sheet each), one sheet per channel range of the template (CH1-16, CH17-32 ...).
   - A value the workbook has no column for stays as the template draws it. If a template of the set is missing for
     something in the workbook, "Workbook coverage" on the Templates page and Data Checks say which one to import.
3. Drawings
   - Use the AI / AO / RTD / DI / DO tabs and the search box to find a module. Click any filled text on the sheet to
     change it (the change is kept until that Excel value changes).
   - Live: in Chrome / Edge the imported file is watched - save it in Excel and the sheets update; the changed cells
     are listed (old -> new) and flash green. After a reload click "Reconnect live" once.
   - Dashboard (first page): KPIs, IO distribution, module table, data checks, live changes and downloads.
   - "Clear data" (top right, next to Import Excel): deletes EVERYTHING: the imported workbook, the edited texts, the
     live changes, the link to the Excel file, what the browser remembered and all template sets (DWG files + frame).
   - "Download": PDF (one file, one A1 page per sheet), DWG or DXF (one drawing per sheet with the frame bound in;
     several sheets come as one ZIP). The "DWG" button above the sheet downloads just that sheet.
     DWG files are AutoCAD 2000 format, written with LibreDWG.
   - There is no limit on the number of sheets (100 000 and more work). Up to 1000 sheets are one PDF; a bigger set comes
     as ONE ZIP of PDF files of 1000 sheets each (sheet numbers stay SHT. n / total of the whole set). DWG / DXF are one
     file per sheet in one ZIP. Big sets are made in parts by all CPU cores and streamed from disk, so memory stays flat:
     keep the page open until the download starts (progress and time left are shown; Cancel stops it).
     Measured here (12 cores): 92 160 sheets -> PDF in about 4 minutes; DWG about 13 sheets per second (100 000 DWG files
     take about 2 hours). A workbook of that size takes about a minute to read. Above 3000 sheets the browser does not
     keep the workbook (import the Excel file again after a reload), and lists / tables show the first 400-500 entries -
     use the search box or the IO type tabs to find the rest.

Logos: pictures inside the frame DWG (OLE objects: bitmap or EMF, e.g. the company logo) are read, drawn at their place
on the screen and in the PDF, and written back as the same OLE objects into the DWG / DXF (needs Windows for EMF pictures).

Files
- index.html            the web page
- server.py             web server, makes the PDF
- tplset.py             reads template DWGs (any layout), builds a template set
- io_excel.py           reads the IO ASSIGNMENT workbook, decides the sheets and their texts
- dwg_export.py         makes the DWG / DXF sheets
- build_template.py     rebuilds template sets from the command line (normally not needed)
- source/sets/<id>/     the DWG files of every template set   (mega-epc = the original MEGA EPC templates)
- data/sets/<id>/       built from them (blank sheet PDF / SVG / DXF + what was detected)
- tools/libredwg/       LibreDWG (GPL), used to read and write DWG files

Needs Python 3 with: pip install -r requirements.txt
