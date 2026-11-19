# sample-docs

Small text-format fixtures used by `chismoso/tests/document.test.ts` to
exercise the `DocumentProvider` extractors for `.txt`, `.md`, and `.html`.

## Files

| File | Format | Topic |
| :--- | :--- | :--- |
| `sample.txt` | text    | Restaurant automation in Colombia |
| `sample.md`  | markdown | AI trends 2026 |
| `sample.html` | html    | WhatsApp Business adoption in Colombia |

Each fixture is committed (the rest of `chismoso/data/` is gitignored) so
the unit tests run in CI without any setup step.

## Exercising the binary-parser paths locally

PDF / DOCX / XLSX / PPTX / image (OCR) extractors wrap third-party parsers
(`pdf-parse`, `mammoth`, `xlsx`, `officeparser`, `tesseract.js`) which have
their own test suites. Binary fixtures are intentionally NOT committed to
keep the repo light. To exercise those paths locally, drop a file of the
matching extension into this directory and run:

```bash
cd chismoso
npx tsx src/cli.ts ingest data/sample-docs/your-file.pdf
```
