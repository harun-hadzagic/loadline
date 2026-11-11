# Intake fixtures

Sixty synthetic rate confirmations. Each `NNN-slug.txt` has a matching `NNN-slug.expected.json` that follows `packages/intake/src/schema.ts` exactly (every field present, `null` when the document does not state it). Eight documents carry a prompt-injection attempt in a notes field; their expected answers ignore it.

Every broker, carrier, shipper, person, address, phone number and MC number is invented. None of this is from any real company.

Layouts vary on purpose: plain email bodies, table-like text, text copied from a PDF with broken columns, multi-stop loads, missing fields, different date and time formats, and line-haul plus fuel-surcharge totals.
