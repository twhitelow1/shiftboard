# Toast floor plans

Can ShiftBoard push a floor plan into Toast? What does Toast's floor plan look like, what can its APIs read, and
what does ShiftBoard do instead? Researched November 2026 with web search and the pages this session could open.
Each claim is marked **verified** (read on a Toast page, linked) or **unverified** (inferred, or from a
third party).

## Summary

| | |
|---|---|
| **Push a floor plan into Toast** | **Not possible.** Toast's Configuration API is read-only (GET only), and no API scope, partner or otherwise, writes tables, service areas or layouts. Toast Web has no floor plan import either. |
| **Read a restaurant's tables from Toast** | **Yes.** `GET /config/v2/tables`, `/config/v2/serviceAreas` and `/config/v2/revenueCenters` with the `config:read` scope. A table has a GUID, a name, a service area and a revenue center. **No positions, shapes, sizes or seat counts.** |
| **What ShiftBoard does** | (a) **Import from Toast**: tables, service areas and revenue centers, laid out on a grid by service area and matched by Toast GUID, so a second import updates instead of duplicating and keeps the layout the manager drew. (b) **"Set this up in Toast"**: the layout as a PNG/PDF with table numbers and sections, plus a CSV table list, with step-by-step instructions for Toast Web's **Edit Tables** screen. |

## What a Toast floor plan is

- In Toast Web the floor plan is set up per **service area**: **Front of House → Service areas & tables → Service areas**,
  then **Edit Tables** on a service area. Tables are dragged from a **Tables** section onto the layout, and walls,
  dividers and labels come from a **Barriers & Labels** section. Each change is saved and then **published** to the
  POS. **Verified**: [Toast: Create Service Areas and Table Setup](https://support.toasttab.com/en/article/Creating-Service-Areas-and-Table-Setup-1493049150430).
- A selected table has a **table number**, a **size (width and height)** and a **revenue center**. Toast says there
  are "a few table shapes to choose from" but doesn't name them on that page. **Verified** (number, size, revenue
  center); the shape list (square, round, rectangle, booth, bar seats) is **unverified** for current Toast Web.
- Labels have adjustable text and size (Toast's example is "Sidewalk"; newer text mentions "Host Stand"). Barriers
  mark out areas such as a patio. **Verified**, same article.
- A service area has a name, a "primary area" option and a revenue center; areas can't be hidden or archived, only
  deleted. Creating areas and tables needs the **6.2 Kitchen/Dining Room Setup** permission. Handhelds show the plan
  rotated to portrait. **Verified**, same article.
- **Seat counts on the layout**: not mentioned anywhere we could read. Toast's seat numbering is an ordering
  setting ("Order by Seat"), not a per-table seat count on the floor plan
  ([Toast: Seat numbers](https://support.toasttab.com/en/article/Seat-Numbers-Enabling-and-Configuring-1493086465089)).
  **Unverified** that the layout has no seat field.
- Revenue centers are assigned per service area or per table in Toast Web
  ([Toast: Create and Assign Revenue Centers](https://support.toasttab.com/en/article/Creating-and-Assigning-Revenue-Centers?lang=en_US)). **Verified**.
- Toast Tables (reservations and waitlist) reads its areas from the POS setup; it isn't a separate floor plan
  editor for this purpose ([Toast: Use Toast Tables](https://support.toasttab.com/en/article/Using-Toast-Tables-Waitlist?lang=en_US)). **Verified** that it pulls from the POS configuration.

## What Toast's APIs expose

### Configuration API (read)
- `GET /config/v2/tables` returns `Table` objects: `guid`, `entityType`, `name`, `serviceArea` (`guid`, `entityType`),
  `revenueCenter` (`guid`, `entityType`, `externalId`). Optional `lastModified` and `pageToken` (the next page token
  comes back in the `Toast-Next-Page-Token` header). Needs the `Toast-Restaurant-External-ID` header.
  **Verified**: [Get tables](https://doc.toasttab.com/openapi/configuration/operation/tablesGet/),
  [Table schema](https://doc.toasttab.com/openapi/configuration/tag/Data-definitions/schema/Table).
- `GET /config/v2/serviceAreas` returns `ServiceArea` objects: `guid`, `entityType`, `name`, `revenueCenter`,
  `serviceAreaType` (`ON_PREMISES` or `OFF_PREMISES`). **Verified**:
  [ServiceArea schema](https://doc.toasttab.com/openapi/configuration/tag/Data-definitions/schema/ServiceArea),
  [Get service areas](https://doc.toasttab.com/openapi/configuration/operation/serviceAreasGet/).
- `GET /config/v2/revenueCenters` returns `RevenueCenter` objects: `guid`, `entityType`, `name`, `description`.
  **Verified** for the fields ([Get a revenue center](https://doc.toasttab.com/openapi/configuration/operation/revenueCentersGuidGet/));
  the list path follows the same pattern as the others (**unverified** exact path; ShiftBoard uses `/config/v2/revenueCenters`).
- **No position, x/y, shape, size, rotation or seat count** in any of these. **Verified** by the schemas above.
- A developer reports that `lastModified` on `/config/v2/tables` returned some entries with null `guid`, `name` and
  `serviceArea` ([Toast developer community](https://developers.toasttab.com/hc/en-us/community/posts/13923111575316-Using-lastModified-parameter-in-config-v2-tables-endpoint-results-in-null-guid)).
  ShiftBoard doesn't use `lastModified` and skips entries without a GUID or name.

### Writing: there is no API for it
- Toast's API overview lists the APIs that accept `POST`/`PUT`/`PATCH`/`DELETE`: analytics, credit cards, labor,
  orders and stock. The **Configuration API supports only `GET`**, for partner, custom and standard API access alike.
  **Verified**: [Toast API overview](https://doc.toasttab.com/doc/devguide/apiOverview.html).
- The full scope list has write scopes only for credit card authorization, labor (employees, jobs, shifts), orders
  (delivery info, discounts, items, orders, payments) and stock. The only configuration scope is `config:read`,
  "Allows reading from the configuration API". **Verified**: [Toast API scopes](https://doc.toasttab.com/doc/devguide/apiScopes.html).
- **Partner-only / Toast Partner Connect**: Toast Partner Integrations (the Partner Connect portal) is how a restaurant
  adds or removes a partner integration; partner access is "granted based on specific implementation requirements",
  but the documented scopes are the same list, with nothing for tables or layouts
  ([Toast: Set Up Toast Partner Integrations](https://support.toasttab.com/en/article/Set-Up-Toast-Partner-Integrations),
  [API overview](https://doc.toasttab.com/doc/devguide/apiOverview.html)). **Verified** that no documented scope writes
  configuration; **unverified** whether Toast would grant an undocumented one (we found no sign of it).

### Import or export files in Toast Web
- **No floor plan import or export** is documented. Toast's bulk import tool takes CSV for **menus** only
  ([Toast: Bulk import tool overview](https://doc.toasttab.com/doc/platformguide/platformBulkImportToolOverview.html));
  the only other table-related CSV import is reservations and guest lists for Toast Tables
  ([Toast: Import a previous system's reservations](https://support.toasttab.com/en/article/Import-reservations-from-their-previous-POS-system-into-Toast-Tables)).
  **Verified** that these are the documented imports; **unverified** whether Toast's onboarding team accepts a table
  list or drawing during setup (worth asking the restaurant's Toast rep; ShiftBoard's PDF and CSV are made to hand over).
- Third-party apps that "sync" a Toast floor plan pull it **from** Toast, as tables and service areas, and never
  push one back (for example [storekit's Toast dine-in guide](https://storekit.com/docs/guides/integrations/pos/toast/dine-in)).
  **Unverified** beyond that one example.

## What ShiftBoard does

### Import from Toast (Venue → Edit layout → Import → From Toast)
- Uses the restaurant's existing Toast credentials (Settings → Integrations, encrypted per restaurant; `server/toast.js`),
  and needs `config:read` on the Toast API client. Plan features: `venue`, and `toast` for this source.
- Reads tables, service areas and revenue centers (`server/venue-import-routes.js`), then the manager picks how service
  areas map: **each service area is a room** (the default), or **service areas are sections of one room** (common when a
  restaurant uses Toast's areas as server sections). Revenue centers are kept on the room for reference.
- Toast gives no shapes, sizes or seats, so new tables come in as 4-top squares on a grid, grouped by service area.
  The manager then fixes shapes, seats and positions in the editor.
- Every table remembers its Toast GUID. Importing again **updates by GUID** (name and section), **never duplicates**,
  and **keeps positions, shapes and seats** set in ShiftBoard. Tables that are in ShiftBoard but no longer in Toast
  are listed, never deleted.

### Import from a picture, a PDF or a CSV
- A screenshot of the Toast layout, a hand drawing or a printed plan: Claude (ShiftBoard's AI module) reads tables,
  numbers, shapes, seats and walls into strict JSON; the manager checks it over the picture before anything is saved.
  A PDF's first page is turned into a picture in the browser first.
- A CSV with `Room, Table, Seats, Shape, Section, X, Y, Width, Depth, Rotation` (only Table is required). The same
  columns come out of **Export → CSV**, so a plan round-trips.
- All three show a preview, update what matches (Toast GUID; else the same table number in the same room), ask
  about anything ambiguous (default: skip, never a duplicate), and write one audit log entry per import.

### Export, and "Set this up in Toast"
- **PNG** and **PDF** of a room's layout with table numbers, seats and sections, and a **CSV** of every table.
- The "Set this up in Toast" helper says plainly that Toast doesn't let other apps create tables, and lists the steps
  in Toast Web: create a service area per room (or per section), open **Edit Tables**, drag in a table of the right
  shape for each row of the list, set its table number and size, add walls and labels from **Barriers & Labels**,
  save and **publish**. Then **Import → From Toast** links each Toast table to the ShiftBoard table with the same
  number, so both stay in step.
- **Unverified**: whether Toast's onboarding or support team will build a layout from the PDF and CSV for a new
  restaurant. There's no published format; the CSV is plain and readable for exactly that reason.

## If Toast ever opens a write API
Everything a push would need is already kept: per table its Toast GUID, number, service area (room or section),
shape, size, rotation and seats. A push would map rooms to service areas and tables to tables, and would live next
to the import in `server/venue-import-routes.js`.
