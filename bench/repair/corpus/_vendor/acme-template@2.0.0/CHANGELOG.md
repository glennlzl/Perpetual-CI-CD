# Changelog

## 2.0.0
- Breaking: the default export `render(template, data)` is removed. Compile a template once with
  `compile(template, options)` and call the function it returns with the data: `compile(template)(data)`.
- Breaking: placeholders are written `{{name}}` instead of `{name}`.
- Breaking: a missing value throws `Missing value for "<name>"`. Pass `{ strict: false }` to render missing values as
  empty text, as 1.x did.

## 1.3.0
- `render` accepts nested names such as `{user.name}`.

## 1.0.0
- First release: `render(template, data)` with `{name}` placeholders; a missing value renders as empty text.
