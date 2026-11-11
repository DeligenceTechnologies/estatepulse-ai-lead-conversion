# Phone-number metadata

`phone-timezones.json` and `nanp-regions.json` are generated from Google's
[libphonenumber](https://github.com/google/libphonenumber) resources
(`resources/timezones/map_data.txt` and `resources/geocoding/en/1.txt`), which are
licensed under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0).
Copyright (C) The Libphonenumber Authors.

Regenerate with `node scripts/build-phone-tz-data.mjs` when libphonenumber adds area codes.
`tz-aliases.json` maps the old tzdata names Google still uses to the current ones; it is also
read at runtime by `canonicalZone()` in `src/common/utils/lead-timezone.ts`.
