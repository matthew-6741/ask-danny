# Store checklists

Aisle numbers belong to one store, not a chain, so each file here is for one
specific store near USC. When a file is filled in, an import script (not written
yet) will add its aisles to the app, labelled with that store's name and
location.

| File | Store |
|---|---|
| `checklists/home-depot-wilshire-union-1048.csv` | Home Depot, Wilshire/Union (#1048), Los Angeles 90017 |
| `checklists/lowes-mid-city-la-2714.csv` | Lowe's, Mid-City Los Angeles (#2714), 90019 |
| `checklists/autozone-2907-s-vermont.csv` | AutoZone, 2907 S Vermont Ave, Los Angeles 90007 |

## Filling one in

1. Open the store's website and **set that store as your store**. Aisle and bay
   numbers only show for a selected store.
2. Start with the rows marked `priority` (40 per home store, 15 at AutoZone).
   `jobs_that_need_it` counts how many of the 58 test jobs need that part.
3. Click `lookup_link`, open the product that matches the part and spec, and
   copy its aisle, bay and price into the row.
4. If a part isn't sold there, put `n` in `in_stock` and leave aisle blank.

AutoZone keeps most parts behind the counter. Write `counter` in the aisle
column for those rather than guessing a number.

Look these up yourself, by hand. The retailers' terms forbid collecting this
automatically, so don't script it.

Walking the store works just as well, and it's the only way to be sure. Upload
the CSV to Google Sheets and fill it in on your phone.
