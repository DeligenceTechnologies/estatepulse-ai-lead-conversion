// Builds src/common/data/phone-timezones.json and src/common/data/nanp-regions.json from
// Google libphonenumber's metadata (Apache-2.0, see src/common/data/README.md).
//
//   node scripts/build-phone-tz-data.mjs
//
// Re-run when libphonenumber publishes new area codes. Every zone is checked against Intl, so a
// name this Node cannot format fails the build instead of reaching a contact gate.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://raw.githubusercontent.com/google/libphonenumber/master/resources';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'common', 'data');
const ALIASES = JSON.parse(readFileSync(join(OUT, 'tz-aliases.json'), 'utf8'));

// Google's geocoding names a US state, a Canadian province or "City, ST"; the rules table is keyed by code.
const NAME_TO_CODE = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO', Connecticut: 'CT',
  Delaware: 'DE', 'District of Columbia': 'DC', Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL',
  Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD',
  Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE',
  Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC',
  'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI',
  'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT', Virginia: 'VA',
  Washington: 'WA', 'Washington State': 'WA', 'Washington D.C.': 'DC', 'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY',
  'Puerto Rico': 'PR', Guam: 'GU', 'American Samoa': 'AS', 'Northern Mariana Islands': 'MP',
  'U.S. Virgin Islands': 'VI', 'United States Virgin Islands': 'VI', 'US Virgin Islands': 'VI',
  // "British Colombia" is Google's spelling for area code 236/672.
  Alberta: 'AB', 'British Columbia': 'BC', 'British Colombia': 'BC', Manitoba: 'MB', 'New Brunswick': 'NB', 'Newfoundland and Labrador': 'NL',
  'Nova Scotia': 'NS', Ontario: 'ON', 'Prince Edward Island': 'PE', Quebec: 'QC', Saskatchewan: 'SK',
  'Northwest Territories': 'NT', Nunavut: 'NU', Yukon: 'YT',
};

const canonical = (zone) => ALIASES[zone] ?? zone;
const formats = (zone) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

async function lines(path) {
  const res = await fetch(`${BASE}/${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.text()).split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
}

const zones = {};
for (const line of await lines('timezones/map_data.txt')) {
  const [prefix, list] = line.split('|');
  const names = list.split('&').map(canonical);
  const bad = names.filter((z) => !formats(z));
  if (bad.length) throw new Error(`prefix ${prefix}: Intl does not know ${bad.join(', ')}`);
  zones[prefix] = names;
}

const regions = {};
const unmapped = new Set();
for (const line of await lines('geocoding/en/1.txt')) {
  const [prefix, place] = line.split('|');
  if (!/^1\d{3}$/.test(prefix)) continue;
  const name = place.includes(', ') ? place.slice(place.lastIndexOf(', ') + 2) : place;
  const code = NAME_TO_CODE[name] ?? (/^[A-Z]{2}$/.test(name) ? name : null);
  if (code) regions[prefix.slice(1)] = code;
  else unmapped.add(place);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'phone-timezones.json'), JSON.stringify(zones, null, 0).replace(/\],"/g, '],\n"') + '\n');
writeFileSync(join(OUT, 'nanp-regions.json'), JSON.stringify(regions, null, 0).replace(/","/g, '",\n"') + '\n');

const multi = Object.values(zones).filter((z) => z.length > 1).length;
console.log(`phone-timezones.json: ${Object.keys(zones).length} prefixes (${multi} with more than one zone)`);
console.log(`nanp-regions.json: ${Object.keys(regions).length} area codes with a state or province`);
if (unmapped.size) console.log(`no region code for: ${[...unmapped].join('; ')}`);
