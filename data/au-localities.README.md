# au-localities.json

The list of Australian suburbs and towns the app uses when an Australian doctor
types where they are based, and when a practice has no usable map coordinates.
It is read by `lib/au-localities.js`.

## Where it came from

- **Dataset:** "Australian Postcodes" by Matthew Proctor
- **File:** `australian_postcodes.csv`
- **URL:** https://raw.githubusercontent.com/matthewproctor/australianpostcodes/master/australian_postcodes.csv
- **Project page:** https://github.com/matthewproctor/australianpostcodes
- **Downloaded:** 25 November 2026 (18,559 rows in the source file)

## Licence: read this

The project's README (read on 25 November 2026) contains **no formal licence
statement**. It does not say "public domain", "CC0", "MIT" or name any other
licence. The only wording in it that touches on reuse is:

> "Some years ago, Australia Post used to publish a full list of Australian
> Postal Codes including state and location data, in a raw data format,
> completely free.
>
> They have since stopped doing this, instead preferring to charge for data
> that is arguably public domain, or at least available publicly in many
> different forms from many different providers."

> "I've needed this data for a number of projects over the years, and have
> collated as much publicly-available postal data as I could find."

> "From time to time, friendly people help submit changes that they see from
> the official Australia Post database. I dont have the funds to buy this
> database myself, and technically it's not meant to be republished, but I'm
> confident this repository has the most up to date publically sourced set of
> postal data available."

So the author describes the data as "arguably public domain" and "publically
sourced", and also says part of it comes from a database that is "technically
... not meant to be republished". Only the README was checked; the repository
may carry a separate licence file that was not read. **Someone should confirm
the licence position before this file is relied on in production.**

## What was kept

One row per distinct suburb name + state + postcode, as
`[name, state, postcode, latitude, longitude]`:

- name in Title Case ("PARRAMATTA" becomes "Parramatta", "MCMAHONS POINT"
  becomes "McMahons Point", "O'CONNOR" becomes "O'Connor")
- state is one of NSW, VIC, QLD, WA, SA, TAS, NT, ACT
- postcode is always four characters, leading zeros kept ("0800")
- latitude and longitude rounded to 4 decimal places (about 11 metres). They
  come from the dataset's `Lat_precise` / `Long_precise` columns. Three rows
  whose precise pair was missing or outside Australia use the rougher `lat` /
  `long` columns instead.

Rows are sorted by state, then name, then postcode.

**Row count: 17,731. File size: 815,974 bytes.**

## What was stripped

- every column except the five above
- rows whose `type` is "Post Office Boxes" or "LVR" (large volume receivers):
  450 rows
- rows that are not places people live or work in: 333 rows. That is the
  postcode ranges kept for PO boxes and bulk mail (0200-0299, 0900-0999,
  1000-1999, 5800-5999, 6800-6999, 7800-7999, 8000-8999, 9000-9999), mail
  centre names (ending MC, DC, BC, MSC, GPO, Westfield, Plaza, Street,
  Roadside Delivery), defence mail names, and names containing digits
- 14 rows with an unusable name
- 4 rows with missing coordinates, coordinates of 0,0, or coordinates outside
  the box latitude -44.5 to -9, longitude 112 to 154.5 (this also removes
  island territories)
- 27 repeats of the same name + state + postcode (the first one is kept)

Some postcodes in the source are PO-box postcodes that the source leaves
untyped (for example Darwin 0801, Hobart 7001, Canberra 2601). They are still
in the file because nothing in the data marks them out.

## How to regenerate

1. Download the CSV from the URL above into a new, empty folder.
2. Run the build script with Python 3, passing the two paths:

   `python3 -I scripts/build-au-localities.py <path to australian_postcodes.csv> data/au-localities.json`

3. Run `npx vitest run tests/au-wp29-localities.test.js` to check the result.
4. Update the row count, file size and download date in this file.

The coordinates are approximate centres of each suburb. They are good enough
for "about 12 km from Parramatta". They are not street addresses.
