# Actual Umrah hotel-rate source fixture

- Source supplied by Hamza: `/home/hamza/Downloads/actual-so-called - Sheet1.csv`
- Fixture: `actual-umrah-hotel-rates.csv`
- SHA-256: `446525946a9f98ece33c6c0fab3bef97aa0cb397a3856887827def95a616622e`
- Byte length: `2191`
- Header spelling, case, column order, row order, blank `QUAD` cells, and source date strings are preserved exactly.

`actual-umrah.ts` is a local, source-preserving adapter only. It creates shadow date values and parses occupancy numbers for validation; it does not infer currency, per-night/per-room basis, canonical city names, room/rate entities, or publish canonical pricing rows.
