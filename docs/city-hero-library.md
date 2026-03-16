# Career City Hero Library

This app now supports a Supabase-backed city hero image library for career/job cards.

How it works:

1. Each job resolves its suburb and state.
2. The server geocodes that suburb once and caches the coordinates in `public.career_suburb_geo_cache`.
3. The server finds the closest seeded row in `public.career_hero_cities`.
4. It picks one of that city's active images from `public.career_hero_city_images`.
5. The chosen image URL is saved into the role metadata and reused by the job page.

The storage bucket is:

- `career-hero-images`

The main tables are:

- `public.career_hero_cities`
- `public.career_hero_city_images`
- `public.career_suburb_geo_cache`

## Populate With Your Images

### 1. Run the migration

Apply the new Supabase migration so the bucket and tables exist.

Migration file:

- `supabase/migrations/20260316043000_career_city_hero_library.sql`

### 2. Upload images into Supabase Storage

In Supabase Dashboard:

1. Open `Storage`
2. Open the `career-hero-images` bucket
3. Create a folder for the city slug you want to use, for example:
   - `sydney`
   - `melbourne`
   - `brisbane`
4. Upload up to 10 landscape images into that folder

Recommended file pattern:

- `sydney/01.jpg`
- `sydney/02.jpg`
- `sydney/03.jpg`
- ...
- `sydney/10.jpg`

Recommended image format:

- Landscape only
- `jpg` or `webp`
- around `2400x1350` or larger
- compressed for web

### 3. Find the city row

Run:

```sql
select id, slug, city_name, state_code
from public.career_hero_cities
order by city_name;
```

### 4. Register the uploaded images

Example for Sydney:

```sql
insert into public.career_hero_city_images (
  city_id,
  slot_no,
  bucket_id,
  object_path,
  alt_text,
  credit
)
values
  ((select id from public.career_hero_cities where slug = 'sydney'), 1, 'career-hero-images', 'sydney/01.jpg', 'Sydney harbour landscape', 'Your chosen credit'),
  ((select id from public.career_hero_cities where slug = 'sydney'), 2, 'career-hero-images', 'sydney/02.jpg', 'Sydney skyline landscape', 'Your chosen credit'),
  ((select id from public.career_hero_cities where slug = 'sydney'), 3, 'career-hero-images', 'sydney/03.jpg', 'Sydney coastal landscape', 'Your chosen credit'),
  ((select id from public.career_hero_cities where slug = 'sydney'), 4, 'career-hero-images', 'sydney/04.jpg', 'Sydney suburb landscape', 'Your chosen credit'),
  ((select id from public.career_hero_cities where slug = 'sydney'), 5, 'career-hero-images', 'sydney/05.jpg', 'Sydney city landscape', 'Your chosen credit'),
  ((select id from public.career_hero_cities where slug = 'sydney'), 6, 'career-hero-images', 'sydney/06.jpg', 'Sydney harbour landscape', 'Your chosen credit'),
  ((select id from public.career_hero_cities where slug = 'sydney'), 7, 'career-hero-images', 'sydney/07.jpg', 'Sydney coastal skyline', 'Your chosen credit'),
  ((select id from public.career_hero_cities where slug = 'sydney'), 8, 'career-hero-images', 'sydney/08.jpg', 'Sydney wide landscape', 'Your chosen credit'),
  ((select id from public.career_hero_cities where slug = 'sydney'), 9, 'career-hero-images', 'sydney/09.jpg', 'Sydney panoramic landscape', 'Your chosen credit'),
  ((select id from public.career_hero_cities where slug = 'sydney'), 10, 'career-hero-images', 'sydney/10.jpg', 'Sydney suburb skyline', 'Your chosen credit');
```

Notes:

- `slot_no` must be from `1` to `10`
- one image per slot per city
- `object_path` must exactly match the uploaded storage path
- `credit` can be the photographer/source text you want displayed in metadata

## Update Or Replace Images Later

To replace one image:

1. Upload a new file to the same storage path, or
2. Update the `object_path` for that row

Example:

```sql
update public.career_hero_city_images
set object_path = 'sydney/03-new.jpg',
    alt_text = 'Sydney harbour panorama',
    credit = 'Updated credit'
where city_id = (select id from public.career_hero_cities where slug = 'sydney')
  and slot_no = 3;
```

## Add More Cities

Example:

```sql
insert into public.career_hero_cities (
  slug,
  city_name,
  state_code,
  country,
  latitude,
  longitude
)
values (
  'broome',
  'Broome',
  'WA',
  'Australia',
  -17.9614,
  122.2359
);
```

Then upload 10 images into:

- `broome/01.jpg`
- `broome/02.jpg`
- ...

And insert the matching rows into `public.career_hero_city_images`.
