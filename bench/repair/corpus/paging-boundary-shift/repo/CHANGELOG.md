# Changelog

## 2.0.0
- Breaking: `listPosts` numbers pages from 1, as the site's page links do. Page 0, negative and fractional pages throw
  a `RangeError`.

## 1.3.0
- `searchPosts(posts, query, { resultPage, perPage })`, with `resultPage` counting from 0.

## 1.2.0
- `windowAt(posts, cursor, size)` for the cursor feed.

## 1.1.0
- `exportBatches(posts, size)` for the nightly export.

## 1.0.0
- `listPosts(posts, { page, perPage })`, with pages counted from 0.
