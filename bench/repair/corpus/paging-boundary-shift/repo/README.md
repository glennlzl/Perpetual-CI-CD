# feed

Paging for the post feed: the public site, the nightly export, the cursor feed and search. Every function takes the
posts newest first, as the store returns them.

- `listPosts(posts, { page, perPage })`: the public post list. Pages are numbered from 1, as the site's page links
  show them. Page 0, negative or fractional pages, and a `perPage` outside 1 to 100, throw a `RangeError`. Returns
  `{ page, perPage, items, hasNext }`.
- `exportBatches(posts, size)`: the nightly export's batches, numbered from 0 like its files (`posts-0.json`, …).
- `windowAt(posts, cursor, size)`: the cursor feed. Cursors count from 0, and `next` is null after the last window.
- `searchPosts(posts, query, { resultPage, perPage })`: posts whose title contains the query. `resultPage` counts from
  0, as the search box's "more results" button asks for them.
