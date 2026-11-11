# Intake fixtures

Sixty synthetic rate confirmations. Each `NNN-slug.txt` has a matching `NNN-slug.expected.json` that follows `packages/intake/src/schema.ts` exactly (every field present, `null` when the document does not state it). Eight documents carry a prompt-injection attempt in a notes field; their expected answers ignore it.

Every broker, carrier, shipper, person, address, phone number and MC number is invented. None of this is from any real company. MC numbers are written in the 990xxxx range, beyond anything issued, so none can collide with a real carrier or broker. Dates fall in November and December 2026; documents that omit the year mean 2026, and the eval passes that year to the extractors (`defaultYear`).

Layouts vary on purpose: plain email bodies, table-like text, text copied from a PDF with broken columns, multi-stop loads, missing fields, different date and time formats, and line-haul plus fuel-surcharge totals.
