# Golden tests

These compare the browser code with the output of the old Python program (git tag `python-version`): template analysis (`set.json`),
the Excel reader (`io.json`), the PDF of every sheet and the DWG files. They need the reference files, which are not in this
repository (they hold customer drawings): a folder with
`golden/set/` (data/sets/<id> built by the Python program), `golden/io.json`, `golden/all.pdf`, `golden/dwg/*.dwg` and the source
`.dwg` / `.xlsx` files (the paths are at the top of every script).

    npm run test:golden          # the *.test.mjs files
    node tests/golden/_e2e.mjs   # whole chain: templates -> Excel -> PDF + DWG
